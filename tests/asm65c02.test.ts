import { describe, expect, it } from 'vitest';
import { assemble, assembleToMemory, disassemble } from '../src/engine/asm65c02';
import { OPS } from '../src/engine/opcodes65c02';
import { counterRom, romFromSource, romImage32k } from '../src/engine/roms6502';

describe('assembler', () => {
  it('encodes modes and labels', () => {
    const code = assemble(['loop: LDA #$01', 'STA $6000', 'STA $10', 'BNE loop', 'JMP loop'], 0x8000);
    expect([...code]).toEqual([0xa9, 0x01, 0x8d, 0x00, 0x60, 0x85, 0x10, 0xd0, 0xf7, 0x4c, 0x00, 0x80]);
  });
  it('handles 65C02 additions, equates, directives and byte selectors', () => {
    const { memory } = assembleToMemory(
      [
        'LED = $6000',
        'STZ LED',
        'LDA (LED)',
        'BBR3 $10,here',
        'here: PHX',
        '.org $9000',
        '.byte <LED, >LED',
        '.word LED',
        '.ascii "Hi"',
      ],
      0x8000,
    );
    expect([...memory.slice(0x8000, 0x8000 + 11)]).toEqual([
      0x9c, 0x00, 0x60, 0xb2, 0x00, 0x3f, 0x10, 0x00, 0xda, 0xea, 0xea,
    ]);
    expect([...memory.slice(0x9000, 0x9006)]).toEqual([0x00, 0x60, 0x00, 0x60, 0x48, 0x69]);
  });
  it('rejects bad source with a line number', () => {
    expect(() => assemble(['NOP', 'XYZ'])).toThrow(/Line 2/);
    expect(() => assemble(['a: NOP', ...Array(200).fill('NOP'), 'BNE a'])).toThrow(/too far/);
    expect(() => assemble(['LDA nowhere,Y,Z'])).toThrow();
    expect(() => assemble(['STX #1'])).toThrow(/addressing mode/);
  });
  it('disassembles back to what was assembled, for every documented opcode', () => {
    for (const op of OPS.filter((o) => o.documented)) {
      const mem = new Uint8Array(0x10000);
      mem.set([op.code, 0x34, 0x12], 0x8000);
      const d = disassemble((a) => mem[a & 0xffff], 0x8000);
      expect([...assemble([d.text], 0x8000)], d.text).toEqual([...mem.slice(0x8000, 0x8000 + d.length)]);
    }
  });
});

describe('ROM images', () => {
  it('counterRom is 32 KB with vectors at $8000', () => {
    const rom = counterRom();
    expect(rom.length).toBe(0x8000);
    expect([rom[0x7ffa], rom[0x7ffb], rom[0x7ffc], rom[0x7ffd], rom[0x7ffe], rom[0x7fff]]).toEqual([
      0, 0x80, 0, 0x80, 0, 0x80,
    ]);
    expect([...rom.slice(0, 10)]).toEqual([0xa9, 0x00, 0x85, 0x00, 0xa5, 0x00, 0x8d, 0x00, 0x60, 0xe6]);
  });
  it('keeps vectors the source writes itself', () => {
    const rom = romFromSource(['.org $8100', 'main: NOP', '.org $FFFA', '.word main, main, main']);
    expect([rom[0x7ffc], rom[0x7ffd]]).toEqual([0x00, 0x81]);
  });
  it('refuses code outside the ROM, or running into the vectors', () => {
    expect(() => romFromSource(['.org $4000', 'NOP'])).toThrow();
    expect(() => romImage32k(new Uint8Array(0x7ffb))).toThrow();
  });
});
