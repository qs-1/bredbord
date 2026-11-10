import { describe, expect, it } from 'vitest';
import type { PartDoc } from '../src/engine/circuit';
import type { Bit, ChipIO, ChipState, Drive } from '../src/engine/sim/chips';
import { glyph, LCD_MODEL, lcdReading, lcdText } from '../src/engine/sim/lcd';
import { LCD_PIN_NAMES, PARTS, pinCount } from '../src/engine/parts';

const RS = 4;
const RW = 5;
const E = 6;
const D = [7, 8, 9, 10, 11, 12, 13, 14];

/** The LCD's pins as a program sees them: what's driven from outside, plus the controller's pull-ups. */
class Bench implements ChipIO {
  vcc = 5;
  now = 0;
  part = { id: 'lcd', def: 'lcd-1602', pins: [] } as unknown as PartDoc;
  state: ChipState = { q: 0, latch: 0, addr: 0 };
  private outside = new Map<number, Bit>();
  private before = new Map<number, Bit>();
  private pulled = new Set<number>();
  readonly driven = new Map<number, Drive>();

  get(pin: number): Bit {
    const v = this.outside.get(pin);
    if (v !== undefined) return v;
    const d = this.driven.get(pin);
    if (d === 0 || d === 1) return d;
    return this.pulled.has(pin) ? 1 : 0;
  }
  rose(pin: number): boolean {
    return (this.before.get(pin) ?? 0) === 0 && this.get(pin) === 1;
  }
  fell(pin: number): boolean {
    return (this.before.get(pin) ?? 0) === 1 && this.get(pin) === 0;
  }
  volts(pin: number): number {
    return this.get(pin) * this.vcc;
  }
  steady(pin: number): number {
    return this.volts(pin);
  }
  set(pin: number, value: Drive): void {
    this.driven.set(pin, value);
  }
  pull(pin: number, enabled: boolean): void {
    if (enabled) this.pulled.add(pin);
    else this.pulled.delete(pin);
  }
  wrote(): void {}

  /** Changes some pins, lets `dt` seconds pass, and runs the controller. */
  drive(pins: Record<number, Bit | undefined>, dt = 1e-6): void {
    this.now += dt;
    for (const [p, v] of Object.entries(pins)) {
      if (v === undefined) this.outside.delete(+p);
      else this.outside.set(+p, v);
    }
    LCD_MODEL.eval(this, this.state);
    for (const p of [RS, RW, E, ...D]) this.before.set(p, this.get(p));
  }

  /** One byte over all eight data lines, then a gap long enough for most instructions. */
  write8(rs: Bit, byte: number, gap = 50e-6): void {
    const pins: Record<number, Bit> = { [RS]: rs, [RW]: 0 };
    D.forEach((p, i) => (pins[p] = ((byte >> i) & 1) as Bit));
    this.drive(pins);
    this.drive({ [E]: 1 });
    this.drive({ [E]: 0 });
    this.drive({}, gap);
  }

  /** A nibble on D4–D7 with D0–D3 left unconnected, as in a 4-bit hookup. */
  nibble(rs: Bit, n: number, gap = 50e-6): void {
    const pins: Record<number, Bit | undefined> = { [RS]: rs, [RW]: 0 };
    D.forEach((p, i) => (pins[p] = i < 4 ? undefined : (((n >> (i - 4)) & 1) as Bit)));
    this.drive(pins);
    this.drive({ [E]: 1 });
    this.drive({ [E]: 0 });
    this.drive({}, gap);
  }

  write4(rs: Bit, byte: number, gap = 50e-6): void {
    this.nibble(rs, byte >> 4, 1e-6);
    this.nibble(rs, byte & 0x0f, gap);
  }

  /** Reads the busy flag and address counter in 8-bit mode. */
  status(): number {
    const pins: Record<number, Bit | undefined> = { [RS]: 0, [RW]: 1 };
    for (const p of D) pins[p] = undefined;
    this.drive(pins);
    this.drive({ [E]: 1 });
    const v = D.reduce((acc, p, i) => acc | (this.get(p) << i), 0);
    this.drive({ [E]: 0 });
    return v;
  }

  text(): string[] {
    return lcdText(lcdReading(this.state.lcd!, 4.2, this.now));
  }
}

/** Waits out the power-up reset. */
function poweredUp(): Bench {
  const b = new Bench();
  b.drive({ [E]: 0, [RW]: 0, [RS]: 0 }, 0);
  b.drive({}, 20e-3);
  return b;
}

describe('LCD part', () => {
  it('has 16 pins, VSS first and the backlight last', () => {
    const def = PARTS['lcd-1602'];
    expect(pinCount(def)).toBe(16);
    expect(LCD_PIN_NAMES[0]).toBe('VSS');
    expect(LCD_PIN_NAMES.slice(14)).toEqual(['A', 'K']);
  });

  it('draws characters from the ROM, and user characters from CGRAM', () => {
    // 'A': a peak, a bar across the middle, open below, nothing on the cursor row.
    expect(glyph(0x41, new Uint8Array(64))).toEqual([0x0e, 0x11, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x00]);
    expect(glyph(0x20, new Uint8Array(64))).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    const cgram = new Uint8Array(64);
    cgram.set([1, 2, 3, 4, 5, 6, 7, 8], 8);
    expect(glyph(0x01, cgram)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(glyph(0x09, cgram)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });
});

describe('HD44780 controller', () => {
  it('shows a row of blocks until a program sets it up', () => {
    const b = poweredUp();
    const reading = lcdReading(b.state.lcd!, 4.2, b.now);
    expect(Array.from(reading.dots.subarray(0, 8 * 16)).every((row) => row === 0x1f)).toBe(true);
    expect(Array.from(reading.dots.subarray(8 * 16)).every((row) => row === 0)).toBe(true);
  });

  it('prints text in 8-bit mode', () => {
    const b = poweredUp();
    b.write8(0, 0x38); // 8 bits, two lines
    b.write8(0, 0x0c); // display on
    b.write8(0, 0x06); // count up
    b.write8(0, 0x01, 2e-3); // clear
    for (const ch of 'Hello') b.write8(1, ch.charCodeAt(0));
    b.write8(0, 0xc0); // second line
    for (const ch of 'world!') b.write8(1, ch.charCodeAt(0));
    expect(b.text()).toEqual(['Hello           ', 'world!          ']);
  });

  it('starts up in 4-bit mode the way the Arduino library does it', () => {
    const b = poweredUp();
    b.nibble(0, 0x3, 5e-3);
    b.nibble(0, 0x3, 5e-3);
    b.nibble(0, 0x3, 200e-6);
    b.nibble(0, 0x2);
    b.write4(0, 0x28);
    b.write4(0, 0x0c);
    b.write4(0, 0x06);
    b.write4(0, 0x01, 2e-3);
    for (const ch of 'Bredbord') b.write4(1, ch.charCodeAt(0));
    expect(b.text()[0]).toBe('Bredbord        ');
  });

  it('loses what it is sent while busy', () => {
    const b = poweredUp();
    b.write8(0, 0x38);
    b.write8(0, 0x0c);
    b.write8(0, 0x01, 2e-3);
    b.write8(1, 0x41, 1e-6); // 'A', then 'B' only a microsecond later
    b.write8(1, 0x42);
    expect(b.text()[0]).toBe('A               ');
  });

  it('reports busy and the address counter', () => {
    const b = poweredUp();
    b.write8(0, 0x38);
    b.write8(0, 0x0c);
    b.write8(0, 0x01, 10e-6);
    expect(b.status() & 0x80).toBe(0x80);
    b.drive({}, 2e-3);
    expect(b.status()).toBe(0x00);
    b.write8(1, 0x41);
    expect(b.status()).toBe(0x01);
  });

  it('wraps from the end of the first line to the start of the second', () => {
    const b = poweredUp();
    b.write8(0, 0x38);
    b.write8(0, 0x0c);
    b.write8(0, 0x80 + 0x27);
    b.write8(1, 0x58);
    b.write8(1, 0x59);
    expect(b.status() & 0x7f).toBe(0x41);
  });

  it('shows nothing at low contrast and dims every dot when it is too high', () => {
    const b = poweredUp();
    b.write8(0, 0x38);
    b.write8(0, 0x0c);
    expect(lcdReading(b.state.lcd!, 2.0, b.now).contrast).toBe(0);
    expect(lcdReading(b.state.lcd!, 4.2, b.now).ghost).toBe(0);
    expect(lcdReading(b.state.lcd!, 5.0, b.now).ghost).toBeGreaterThan(0.2);
  });
});
