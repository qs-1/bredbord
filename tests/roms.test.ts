import { describe, expect, it } from 'vitest';
import { benMicrocodeRom, controlWord, countRom, nopRom, rom6502 } from '../src/engine/roms';

const rom = benMicrocodeRom();
const at = (instruction: number, step: number, { high = true, carry = false, zero = false } = {}): number =>
  rom[(zero ? 512 : 0) | (carry ? 256 : 0) | (high ? 0 : 128) | (instruction << 3) | step];

describe("Ben's microcode", () => {
  it('fetches every instruction the same way', () => {
    for (let i = 0; i < 16; i++) {
      expect(at(i, 0)).toBe(0b01000000); // MI
      expect(at(i, 0, { high: false })).toBe(0b00000100); // CO
      expect(at(i, 1)).toBe(0b00010100); // RO II
      expect(at(i, 1, { high: false })).toBe(0b00001000); // CE
    }
  });

  it('adds through the ALU and latches the flags', () => {
    expect(at(0b0010, 4)).toBe(0b00000010); // AI
    expect(at(0b0010, 4, { high: false })).toBe(0b10000001); // EO FI
    expect(at(0b0011, 4, { high: false })).toBe(0b11000001); // EO SU FI
  });

  it('jumps on carry or zero only when the flag is set', () => {
    expect(controlWord(0b0111, 2, false, false)).toBe(0);
    expect(at(0b0111, 2, { carry: true })).toBe(0b00001000); // IO
    expect(at(0b0111, 2, { carry: true, high: false })).toBe(0b00000010); // J
    expect(at(0b1000, 2, { carry: true, high: false })).toBe(0);
    expect(at(0b1000, 2, { zero: true, high: false })).toBe(0b00000010);
  });

  it('halts', () => {
    expect(at(0b1111, 2)).toBe(0b10000000);
  });
});

describe('6502 ROM images', () => {
  it('points the reset vector at the start of the program, at the top of the 32K', () => {
    const rom = rom6502([0xa9, 0x01], 0x8123);
    expect(rom).toHaveLength(32768);
    expect([rom[0], rom[1]]).toEqual([0xa9, 0x01]);
    expect([rom[0x7ffc], rom[0x7ffd]]).toEqual([0x23, 0x81]);
    expect(rom[2]).toBe(0xea);
  });

  it('starts a no-op image at $EAEA, the way a data bus hard-wired to $EA does', () => {
    const rom = nopRom();
    expect(rom.every((b) => b === 0xea)).toBe(true);
  });

  it('counts: loads zero, then stores, increments and jumps back to the store', () => {
    const rom = countRom();
    expect([...rom.slice(0, 8)]).toEqual([0xa9, 0x00, 0x85, 0x00, 0x1a, 0x4c, 0x02, 0x80]);
    expect([rom[0x7ffc], rom[0x7ffd]]).toEqual([0x00, 0x80]);
  });
});
