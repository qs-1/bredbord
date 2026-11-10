// Ready-made ROM images for a 6502 board with a 32 KB EEPROM mapped at $8000-$FFFF.
// Memory map used by the examples: RAM $0000-$3FFF, output latch (LEDs) $6000, ROM $8000-$FFFF.
import { assembleToMemory } from './asm65c02';

/** A 32 KB image for a 28C256 at $8000: `code` at $8000, unused space NOP, all vectors pointing at $8000. */
export function romImage32k(code: Uint8Array): Uint8Array {
  const rom = new Uint8Array(0x8000).fill(0xea);
  if (code.length > 0x7ffa) throw new Error('Program too big for the ROM');
  rom.set(code, 0);
  for (const v of [0x7ffa, 0x7ffc, 0x7ffe]) {
    rom[v] = 0x00;
    rom[v + 1] = 0x80;
  }
  return rom;
}

/**
 * Assembles source (see asm65c02.ts) into an image for a ROM `size` bytes long that sits at the top of
 * memory ($8000 for 32 KB, $E000 for 8 KB). Code starts at the bottom of the ROM unless it says `.org`.
 * If the source doesn't write the vectors at $FFFA-$FFFF, they all point at the start of the code.
 */
export function buildRom(lines: readonly string[], size = 0x8000): { rom: Uint8Array; start: number; end: number } {
  const base = 0x10000 - size;
  const { memory, start, end } = assembleToMemory(lines, base);
  if (end >= start && start < base)
    throw new Error(`The program must sit inside $${base.toString(16).toUpperCase()}-$FFFF`);
  const rom = memory.slice(base);
  if (end < 0xfffa) {
    for (const v of [size - 6, size - 4, size - 2]) {
      rom[v] = (end < start ? base : start) & 0xff;
      rom[v + 1] = ((end < start ? base : start) >> 8) & 0xff;
    }
  }
  return { rom, start, end };
}

export const romFromSource = (lines: readonly string[], size = 0x8000): Uint8Array => buildRom(lines, size).rom;

/**
 * Counts in RAM and shows the count on the LEDs at $6000. Needs the CPU, ROM, RAM and the output
 * latch all working together, so it is the first thing to try on a freshly built 6502 board.
 */
export const COUNTER_SOURCE: readonly string[] = [
  'start: LDA #$00',
  '       STA $00        ; counter lives in RAM (zero page)',
  'loop:  LDA $00        ; read it back from RAM',
  '       STA $6000      ; show it on the LEDs',
  '       INC $00',
  '       JMP loop',
];

export const counterRom = (): Uint8Array => romFromSource(COUNTER_SOURCE);
