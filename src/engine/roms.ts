// Ready-made EEPROM contents, and reading EEPROM image files.

/** Segment patterns for 0–9 the way Ben wires his display: IO6–IO0 to segments a–g, IO7 to dp. */
const DIGITS = [0x7e, 0x30, 0x6d, 0x79, 0x33, 0x5b, 0x5f, 0x70, 0x7f, 0x7b];
const HEX = [...DIGITS, 0x77, 0x1f, 0x4e, 0x3d, 0x4f, 0x47];

/**
 * Ben Eater's output display decoder for a 28C16: A0–A7 take the number, A8–A9 pick the digit
 * (ones, tens, hundreds, sign) and A10 switches to two's complement.
 */
export function benDisplayRom(): Uint8Array {
  const rom = new Uint8Array(2048);
  for (let value = 0; value < 256; value++) {
    rom[value] = DIGITS[value % 10];
    rom[value + 256] = DIGITS[Math.floor(value / 10) % 10];
    rom[value + 512] = DIGITS[Math.floor(value / 100) % 10];
  }
  for (let value = -128; value < 128; value++) {
    const a = value & 0xff;
    const size = Math.abs(value);
    rom[a + 1024] = DIGITS[size % 10];
    rom[a + 1280] = DIGITS[Math.floor(size / 10) % 10];
    rom[a + 1536] = DIGITS[Math.floor(size / 100) % 10];
    rom[a + 1792] = value < 0 ? 0x01 : 0;
  }
  return rom;
}

/** A0–A3 shown as one hex digit, same segment wiring. */
export function hexDigitRom(): Uint8Array {
  return Uint8Array.from({ length: 2048 }, (_, a) => HEX[a & 15]);
}

// Ben's control signals, one bit each across the two microcode EEPROMs (left chip: high byte).
const HLT = 1 << 15; // halt the clock
const MI = 1 << 14; // memory address register in
const RI = 1 << 13; // RAM in
const RO = 1 << 12; // RAM out
const IO = 1 << 11; // instruction register out
const II = 1 << 10; // instruction register in
const AI = 1 << 9; // A register in
const AO = 1 << 8; // A register out
const EO = 1 << 7; // ALU (sum) out
const SU = 1 << 6; // subtract
const BI = 1 << 5; // B register in
const OI = 1 << 4; // output register in
const CE = 1 << 3; // program counter enable
const CO = 1 << 2; // program counter out
const J = 1 << 1; // jump (program counter in)
const FI = 1 << 0; // flags register in

const FETCH = [MI | CO, RO | II | CE];
/** Steps 2–4 of each instruction, after the fetch. */
const STEPS: Record<number, number[]> = {
  0b0001: [IO | MI, RO | AI], // LDA
  0b0010: [IO | MI, RO | BI, EO | AI | FI], // ADD
  0b0011: [IO | MI, RO | BI, EO | AI | SU | FI], // SUB
  0b0100: [IO | MI, AO | RI], // STA
  0b0101: [IO | AI], // LDI
  0b0110: [IO | J], // JMP
  0b1110: [AO | OI], // OUT
  0b1111: [HLT], // HLT
};
const JC = 0b0111;
const JZ = 0b1000;

/** The 16 control lines for one step of one instruction, given the carry and zero flags. */
export function controlWord(instruction: number, step: number, carry: boolean, zero: boolean): number {
  if (step < 2) return FETCH[step];
  if ((instruction === JC && carry) || (instruction === JZ && zero)) return step === 2 ? IO | J : 0;
  return STEPS[instruction]?.[step - 2] ?? 0;
}

/**
 * Ben Eater's microcode (the version with flags), the same image for both control EEPROMs:
 * A0–A2 step, A3–A6 instruction, A7 picks the byte (tied low on the left chip for HLT…AO, high on
 * the right one for EO…FI), A8 carry, A9 zero. A10 is unused.
 */
export function benMicrocodeRom(): Uint8Array {
  const rom = new Uint8Array(2048);
  for (let a = 0; a < 2048; a++) {
    const word = controlWord((a >> 3) & 15, a & 7, ((a >> 8) & 1) === 1, ((a >> 9) & 1) === 1);
    rom[a] = (a >> 7) & 1 ? word & 0xff : word >> 8;
  }
  return rom;
}

/** A raw .bin image, or Intel HEX text, as `size` bytes (unwritten bytes erased to 0xFF). */
export function parseRomImage(file: Uint8Array, size: number): Uint8Array {
  const rom = new Uint8Array(size).fill(0xff);
  const text = new TextDecoder().decode(file.subarray(0, Math.min(file.length, 64)));
  if (!/^\s*:[0-9a-fA-F]{10}/.test(text)) {
    rom.set(file.subarray(0, size));
    return rom;
  }
  let base = 0;
  for (const line of new TextDecoder().decode(file).split(/\r?\n/)) {
    const m = /^\s*:([0-9a-fA-F]{2})([0-9a-fA-F]{4})([0-9a-fA-F]{2})([0-9a-fA-F]*)/.exec(line);
    if (!m) continue;
    const count = parseInt(m[1], 16);
    const address = parseInt(m[2], 16);
    const type = parseInt(m[3], 16);
    const bytes = m[4].match(/../g)?.map((b) => parseInt(b, 16)) ?? [];
    if (type === 0) {
      for (let i = 0; i < count && i < bytes.length; i++) {
        const at = base + address + i;
        if (at < size) rom[at] = bytes[i];
      }
    } else if (type === 1) break;
    else if (type === 2) base = ((bytes[0] << 8) | bytes[1]) * 16;
    else if (type === 4) base = ((bytes[0] << 8) | bytes[1]) << 16;
  }
  return rom;
}

export function encodeBytes(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

/** Bytes from base64, padded with 0xFF (an erased EEPROM) to `size`. */
export function decodeBytes(data: string | undefined, size: number): Uint8Array {
  const out = new Uint8Array(size).fill(0xff);
  if (!data) return out;
  try {
    const s = atob(data);
    for (let i = 0; i < Math.min(size, s.length); i++) out[i] = s.charCodeAt(i);
  } catch {
    // Not base64: leave it erased.
  }
  return out;
}

/** A 32K EEPROM image for a 6502 whose ROM sits at $8000: `program` at the bottom, no-ops after it, reset vector `start`. */
export function rom6502(program: readonly number[], start = 0x8000): Uint8Array {
  const rom = new Uint8Array(32768).fill(0xea);
  rom.set(program);
  rom[0x7ffc] = start & 0xff;
  rom[0x7ffd] = start >> 8;
  return rom;
}

/** Nothing but no-ops, even where the reset vector is: it starts at $EAEA and the address bus counts up. */
export function nopRom(): Uint8Array {
  return new Uint8Array(32768).fill(0xea);
}

/** Counts up in zero page forever: LDA #0; loop: STA $00; INC A; JMP loop. */
export function countRom(): Uint8Array {
  return rom6502([0xa9, 0x00, 0x85, 0x00, 0x1a, 0x4c, 0x02, 0x80]);
}
