// A 16 × 2 character LCD module with an HD44780 controller, the screen in Ben Eater's 6502 computer
// and most Arduino kits. Pins 1–16: VSS, VDD, V0 (contrast), RS, R/W, E, D0–D7, then A and K, the
// backlight's anode and cathode (it has its own resistor on the module).
//
// The controller is modelled the way the datasheet describes it, so code that works on the real
// thing works here and code that doesn't, doesn't:
// - a write is taken in when E falls; a read puts data on the bus while E is high;
// - 8-bit or 4-bit transfers (high nibble first, on D4–D7), switched by a function set;
// - every instruction keeps it busy for its execution time (37 µs, 1.52 ms to clear or go home),
//   and one sent while it's busy is lost, which is why programs wait on the busy flag;
// - at power-up it resets itself to 8 bits and one line with the display off, which on a real
//   module shows as a row of solid blocks until the program sets it up;
// - RS, R/W and D0–D7 have weak pull-ups, so a 4-bit hookup's unused D0–D3 read high;
// - V0 sits on the module's bias divider, about 10 kΩ up to VDD: left unconnected it rides at VDD
//   and the screen is blank; a resistor of a couple of kΩ to ground, or a pot, sets the contrast.

import type { ChipIO, ChipModel, ChipState } from './chips';

export const LCD_COLS = 16;
export const LCD_ROWS = 2;

const RS = 4;
const RW = 5;
const E = 6;
const DATA = [7, 8, 9, 10, 11, 12, 13, 14] as const;
/** The backlight, pins 15 (A) and 16 (K), is an LED behind a resistor on the module. */
export const LCD_BACKLIGHT = { anode: 15, cathode: 16, vf: 2.1, ohms: 100 } as const;
/** The contrast pin: the screen is set by how far V0 sits below VDD. */
export const LCD_V0 = 3;

/** Execution times, seconds (HD44780U at 270 kHz). */
const T_INSTRUCTION = 37e-6;
const T_SLOW = 1.52e-3;
/** The power-up reset keeps it busy this long before it takes anything. */
const T_POWER_UP = 10e-3;

export interface LcdState {
  /** Display data RAM, by address (0x00–0x27 and 0x40–0x67 in two-line mode). */
  ddram: Uint8Array;
  /** Character generator RAM: 8 user characters of 8 rows, 5 dots each (bit 4 is the left dot). */
  cgram: Uint8Array;
  /** Address counter, and whether it points into CGRAM rather than DDRAM. */
  ac: number;
  cg: boolean;
  /** Entry mode: count up (I/D) and shift the display on each write (S). */
  increment: boolean;
  shiftOnWrite: boolean;
  /** Display control: display on (D), underline cursor (C), blinking block (B). */
  display: boolean;
  cursor: boolean;
  blink: boolean;
  /** Function set: 8-bit bus (DL), two lines (N). */
  eightBit: boolean;
  twoLines: boolean;
  /** Left shifts of the display, so column c shows address c + shift along its line. */
  shift: number;
  /** A program has sent a function set since power-up (until then the top row shows as blocks). */
  configured: boolean;
  /** 4-bit mode: the high nibble waiting for its low half, and which half a read is on. */
  nibble: number | null;
  readLow: boolean;
  /** Circuit time the current instruction finishes. */
  busyUntil: number;
}

function powerUp(now: number): LcdState {
  return {
    ddram: new Uint8Array(128).fill(0x20),
    cgram: new Uint8Array(64),
    ac: 0,
    cg: false,
    increment: true,
    shiftOnWrite: false,
    display: false,
    cursor: false,
    blink: false,
    eightBit: true,
    twoLines: false,
    shift: 0,
    configured: false,
    nibble: null,
    readLow: false,
    busyUntil: now + T_POWER_UP,
  };
}

/** The address counter moved one step, wrapping the way the controller does. */
function stepAddress(L: LcdState, dir: 1 | -1): void {
  if (L.cg) {
    L.ac = (L.ac + dir) & 0x3f;
    return;
  }
  let a = L.ac + dir;
  if (L.twoLines) {
    if (a === 0x28) a = 0x40;
    else if (a === 0x68) a = 0x00;
    else if (a === 0x3f) a = 0x27;
    else if (a === -1) a = 0x67;
  } else if (a === 0x50) a = 0;
  else if (a === -1) a = 0x4f;
  L.ac = a & 0x7f;
}

/** How many characters a line holds: 40 per line with two, 80 with one. */
const lineLength = (L: LcdState): number => (L.twoLines ? 40 : 80);

function shiftDisplay(L: LcdState, left: boolean): void {
  const n = lineLength(L);
  L.shift = (L.shift + (left ? 1 : -1) + n) % n;
}

function instruction(L: LcdState, d: number, now: number): void {
  let time = T_INSTRUCTION;
  if (d & 0x80) {
    L.cg = false;
    L.ac = d & 0x7f;
  } else if (d & 0x40) {
    L.cg = true;
    L.ac = d & 0x3f;
  } else if (d & 0x20) {
    L.eightBit = !!(d & 0x10);
    L.twoLines = !!(d & 0x08);
    L.configured = true;
    L.nibble = null;
    L.readLow = false;
  } else if (d & 0x10) {
    if (d & 0x08) shiftDisplay(L, !(d & 0x04));
    else stepAddress(L, d & 0x04 ? 1 : -1);
  } else if (d & 0x08) {
    L.display = !!(d & 0x04);
    L.cursor = !!(d & 0x02);
    L.blink = !!(d & 0x01);
  } else if (d & 0x04) {
    L.increment = !!(d & 0x02);
    L.shiftOnWrite = !!(d & 0x01);
  } else if (d & 0x02) {
    L.cg = false;
    L.ac = 0;
    L.shift = 0;
    time = T_SLOW;
  } else if (d & 0x01) {
    L.ddram.fill(0x20);
    L.cg = false;
    L.ac = 0;
    L.shift = 0;
    L.increment = true;
    time = T_SLOW;
  }
  L.busyUntil = now + time;
}

function writeData(L: LcdState, d: number, now: number): void {
  if (L.cg) L.cgram[L.ac & 0x3f] = d & 0x1f;
  else L.ddram[L.ac] = d;
  stepAddress(L, L.increment ? 1 : -1);
  if (L.shiftOnWrite && !L.cg) shiftDisplay(L, L.increment);
  L.busyUntil = now + T_INSTRUCTION;
}

/** What a read puts on the bus: the busy flag and address counter, or the data at the address. */
function readValue(L: LcdState, rs: number, now: number): number {
  if (!rs) return (now < L.busyUntil ? 0x80 : 0) | (L.ac & 0x7f);
  return L.cg ? L.cgram[L.ac & 0x3f] : L.ddram[L.ac];
}

/** A whole byte has arrived: run it, unless the controller is still busy, in which case it's lost. */
function take(L: LcdState, rs: number, d: number, now: number): void {
  if (now < L.busyUntil) return;
  if (rs) writeData(L, d, now);
  else instruction(L, d, now);
}

export const LCD_MODEL: ChipModel = {
  family: 'HC',
  vcc: 2,
  gnd: 1,
  inputs: [RS, RW, E, ...DATA],
  outputs: [...DATA],
  bias: [{ pin: LCD_V0, volts: (vcc) => vcc, g: 1 / 10000 }],
  init: () => ({}),
  eval(io: ChipIO, s: ChipState) {
    const L = (s.lcd ??= powerUp(io.now));
    for (const pin of [RS, RW, ...DATA]) io.pull?.(pin, true);
    const rs = io.get(RS);
    const rw = io.get(RW);
    const e = io.get(E);
    const bus = (from: number): number => DATA.slice(from).reduce((acc, p, i) => acc | (io.get(p) << i), 0);

    if (io.fell(E)) {
      if (!rw) {
        if (L.eightBit) take(L, rs, bus(0), io.now);
        else if (L.nibble === null) L.nibble = bus(4);
        else {
          const d = (L.nibble << 4) | bus(4);
          L.nibble = null;
          take(L, rs, d, io.now);
        }
      } else {
        // A data read moves the address on once the whole byte has gone out.
        const done = L.eightBit || L.readLow;
        if (!L.eightBit) L.readLow = !L.readLow;
        if (done && rs && io.now >= L.busyUntil) stepAddress(L, L.increment ? 1 : -1);
      }
    }

    // While E is high with R/W high, it drives the bus: all eight lines, or in 4-bit mode a nibble on D4–D7.
    if (e && rw) {
      const v = readValue(L, rs, io.now);
      if (L.eightBit) DATA.forEach((p, i) => io.set(p, ((v >> i) & 1) as 0 | 1));
      else {
        const nib = L.readLow ? v & 0x0f : v >> 4;
        DATA.forEach((p, i) => io.set(p, i < 4 ? null : (((nib >> (i - 4)) & 1) as 0 | 1)));
      }
    } else DATA.forEach((p) => io.set(p, null));
  },
};

// ---- what's on the screen ----

/**
 * The character ROM's printable ASCII (A00, the common one), 0x20–0x7F, five columns per
 * character with bit 0 the top dot. 0x5C is ¥, 0x7E → and 0x7F ←, as on the real ROM.
 */
const FONT: readonly number[] = [
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x5f, 0x00, 0x00, 0x00, 0x07, 0x00, 0x07, 0x00, 0x14, 0x7f, 0x14, 0x7f,
  0x14, 0x24, 0x2a, 0x7f, 0x2a, 0x12, 0x23, 0x13, 0x08, 0x64, 0x62, 0x36, 0x49, 0x55, 0x22, 0x50, 0x00, 0x05, 0x03,
  0x00, 0x00, 0x00, 0x1c, 0x22, 0x41, 0x00, 0x00, 0x41, 0x22, 0x1c, 0x00, 0x14, 0x08, 0x3e, 0x08, 0x14, 0x08, 0x08,
  0x3e, 0x08, 0x08, 0x00, 0x50, 0x30, 0x00, 0x00, 0x08, 0x08, 0x08, 0x08, 0x08, 0x00, 0x60, 0x60, 0x00, 0x00, 0x20,
  0x10, 0x08, 0x04, 0x02, 0x3e, 0x51, 0x49, 0x45, 0x3e, 0x00, 0x42, 0x7f, 0x40, 0x00, 0x42, 0x61, 0x51, 0x49, 0x46,
  0x21, 0x41, 0x45, 0x4b, 0x31, 0x18, 0x14, 0x12, 0x7f, 0x10, 0x27, 0x45, 0x45, 0x45, 0x39, 0x3c, 0x4a, 0x49, 0x49,
  0x30, 0x01, 0x71, 0x09, 0x05, 0x03, 0x36, 0x49, 0x49, 0x49, 0x36, 0x06, 0x49, 0x49, 0x29, 0x1e, 0x00, 0x36, 0x36,
  0x00, 0x00, 0x00, 0x56, 0x36, 0x00, 0x00, 0x08, 0x14, 0x22, 0x41, 0x00, 0x14, 0x14, 0x14, 0x14, 0x14, 0x00, 0x41,
  0x22, 0x14, 0x08, 0x02, 0x01, 0x51, 0x09, 0x06, 0x32, 0x49, 0x79, 0x41, 0x3e, 0x7e, 0x11, 0x11, 0x11, 0x7e, 0x7f,
  0x49, 0x49, 0x49, 0x36, 0x3e, 0x41, 0x41, 0x41, 0x22, 0x7f, 0x41, 0x41, 0x22, 0x1c, 0x7f, 0x49, 0x49, 0x49, 0x41,
  0x7f, 0x09, 0x09, 0x09, 0x01, 0x3e, 0x41, 0x49, 0x49, 0x7a, 0x7f, 0x08, 0x08, 0x08, 0x7f, 0x00, 0x41, 0x7f, 0x41,
  0x00, 0x20, 0x40, 0x41, 0x3f, 0x01, 0x7f, 0x08, 0x14, 0x22, 0x41, 0x7f, 0x40, 0x40, 0x40, 0x40, 0x7f, 0x02, 0x0c,
  0x02, 0x7f, 0x7f, 0x04, 0x08, 0x10, 0x7f, 0x3e, 0x41, 0x41, 0x41, 0x3e, 0x7f, 0x09, 0x09, 0x09, 0x06, 0x3e, 0x41,
  0x51, 0x21, 0x5e, 0x7f, 0x09, 0x19, 0x29, 0x46, 0x46, 0x49, 0x49, 0x49, 0x31, 0x01, 0x01, 0x7f, 0x01, 0x01, 0x3f,
  0x40, 0x40, 0x40, 0x3f, 0x1f, 0x20, 0x40, 0x20, 0x1f, 0x3f, 0x40, 0x38, 0x40, 0x3f, 0x63, 0x14, 0x08, 0x14, 0x63,
  0x07, 0x08, 0x70, 0x08, 0x07, 0x61, 0x51, 0x49, 0x45, 0x43, 0x00, 0x7f, 0x41, 0x41, 0x00, 0x15, 0x16, 0x7c, 0x16,
  0x15, 0x00, 0x41, 0x41, 0x7f, 0x00, 0x04, 0x02, 0x01, 0x02, 0x04, 0x40, 0x40, 0x40, 0x40, 0x40, 0x00, 0x01, 0x02,
  0x04, 0x00, 0x20, 0x54, 0x54, 0x54, 0x78, 0x7f, 0x48, 0x44, 0x44, 0x38, 0x38, 0x44, 0x44, 0x44, 0x20, 0x38, 0x44,
  0x44, 0x48, 0x7f, 0x38, 0x54, 0x54, 0x54, 0x18, 0x08, 0x7e, 0x09, 0x01, 0x02, 0x0c, 0x52, 0x52, 0x52, 0x3e, 0x7f,
  0x08, 0x04, 0x04, 0x78, 0x00, 0x44, 0x7d, 0x40, 0x00, 0x20, 0x40, 0x44, 0x3d, 0x00, 0x7f, 0x10, 0x28, 0x44, 0x00,
  0x00, 0x41, 0x7f, 0x40, 0x00, 0x7c, 0x04, 0x18, 0x04, 0x78, 0x7c, 0x08, 0x04, 0x04, 0x78, 0x38, 0x44, 0x44, 0x44,
  0x38, 0x7c, 0x14, 0x14, 0x14, 0x08, 0x08, 0x14, 0x14, 0x18, 0x7c, 0x7c, 0x08, 0x04, 0x04, 0x08, 0x48, 0x54, 0x54,
  0x54, 0x20, 0x04, 0x3f, 0x44, 0x40, 0x20, 0x3c, 0x40, 0x40, 0x20, 0x7c, 0x1c, 0x20, 0x40, 0x20, 0x1c, 0x3c, 0x40,
  0x30, 0x40, 0x3c, 0x44, 0x28, 0x10, 0x28, 0x44, 0x0c, 0x50, 0x50, 0x50, 0x3c, 0x44, 0x64, 0x54, 0x4c, 0x44, 0x00,
  0x08, 0x36, 0x41, 0x00, 0x00, 0x00, 0x7f, 0x00, 0x00, 0x00, 0x41, 0x36, 0x08, 0x00, 0x08, 0x08, 0x2a, 0x1c, 0x08,
  0x08, 0x1c, 0x2a, 0x08, 0x08,
];

/**
 * A character's eight rows of five dots (bit 4 the left dot). 0x00–0x0F are the user characters in
 * CGRAM, 0x20–0x7F the ROM's ASCII, 0xFF a solid block. The ROM's Japanese and symbol characters
 * (0xA0–0xFE) aren't included and show blank.
 */
export function glyph(code: number, cgram: Uint8Array): number[] {
  if (code < 0x10) return Array.from(cgram.subarray((code & 7) * 8, (code & 7) * 8 + 8));
  if (code === 0xff) return [0x1f, 0x1f, 0x1f, 0x1f, 0x1f, 0x1f, 0x1f, 0x1f];
  if (code < 0x20 || code > 0x7f) return [0, 0, 0, 0, 0, 0, 0, 0];
  const cols = FONT.slice((code - 0x20) * 5, (code - 0x20) * 5 + 5);
  return Array.from({ length: 8 }, (_, r) => cols.reduce((row, col, c) => row | (((col >> r) & 1) << (4 - c)), 0));
}

export interface LcdReading {
  /** Each row of the screen, as character codes (null where nothing shows). */
  codes: (number | null)[][];
  /** Every dot on the screen: row by row of characters, eight dot rows each, five dots per character. */
  dots: Uint8Array;
  /** How dark a lit dot is, 0–1 (set by the contrast voltage), and how much the unlit ones show. */
  contrast: number;
  ghost: number;
  /** Changes whenever anything on the screen does, for redrawing only when needed. */
  key: string;
}

/**
 * The screen as it looks now. `vlcd` is VDD − V0, the voltage driving the liquid crystal: about 4 V
 * gives crisp characters, much under 3 V shows nothing, and with V0 right at ground the unlit dots
 * start to show as faint boxes.
 */
export function lcdReading(L: LcdState, vlcd: number, now: number): LcdReading {
  const contrast = Number.isFinite(vlcd) ? Math.min(1, Math.max(0, (vlcd - 2.8) / 1.3)) : 0.12;
  const ghost = Number.isFinite(vlcd) ? Math.min(0.8, Math.max(0, ((vlcd - 4.8) / 0.6) * 0.8)) : 0;
  const blinkOn = Math.floor(now / 0.4096) % 2 === 0;
  const codes: (number | null)[][] = [];
  const dots = new Uint8Array(LCD_ROWS * 8 * LCD_COLS);
  const len = lineLength(L);
  for (let row = 0; row < LCD_ROWS; row++) {
    const line: (number | null)[] = [];
    for (let col = 0; col < LCD_COLS; col++) {
      let code: number | null = null;
      let pattern: number[] | null = null;
      if (!L.configured) {
        // Never set up: the top row shows as solid blocks, the bottom row as nothing.
        if (row === 0) pattern = glyph(0xff, L.cgram);
      } else if (L.display && (L.twoLines || row === 0)) {
        const offset = (col + L.shift) % len;
        const addr = L.twoLines ? row * 0x40 + offset : offset;
        code = L.ddram[addr];
        pattern = glyph(code, L.cgram).slice();
        if (!L.cg && L.ac === addr) {
          if (L.cursor) pattern[7] = 0x1f;
          if (L.blink && blinkOn) pattern = pattern.map(() => 0x1f);
        }
      }
      line.push(code);
      if (pattern) pattern.forEach((bitsRow, r) => (dots[(row * 8 + r) * LCD_COLS + col] = bitsRow));
    }
    codes.push(line);
  }
  const key = `${Math.round(contrast * 20)}.${Math.round(ghost * 20)}.${dots.join(',')}`;
  return { codes, dots, contrast, ghost, key };
}

/** The screen's characters as text, two lines (for labels and tests). ¥ and the arrows come out as themselves. */
export function lcdText(reading: LcdReading): string[] {
  const map: Record<number, string> = { 0x5c: '¥', 0x7e: '→', 0x7f: '←', 0xff: '█' };
  return reading.codes.map((line) =>
    line.map((c) => (c === null ? ' ' : (map[c] ?? (c >= 0x20 && c < 0x7f ? String.fromCharCode(c) : ' ')))).join(''),
  );
}
