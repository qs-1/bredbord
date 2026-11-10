import { describe, expect, it } from 'vitest';
import { formatBus } from '../src/engine/busview';
import type { BusRecord } from '../src/engine/sim/chips';
import { buildRom } from '../src/engine/roms6502';

const row = (t: number, addr: number, data: number, read = true, sync = false): BusRecord => ({
  t,
  addr,
  data,
  read,
  sync,
});
// LDA #$01; STA $6000 (the write cycle is at $6000); BNE back; then an LDA whose operand isn't read yet.
const LOG = [
  row(0.001, 0x8000, 0xa9, true, true),
  row(0.002, 0x8001, 0x01),
  row(0.003, 0x8002, 0x8d, true, true),
  row(0.004, 0x8003, 0x00),
  row(0.005, 0x8004, 0x60),
  row(0.006, 0x6000, 0x01, false),
  row(0.007, 0x8005, 0xd0, true, true),
  row(0.008, 0x8006, 0xfa),
  row(0.009, 0x8007, 0xad, true, true),
];

describe('bus trace formatting', () => {
  it('lists instructions, disassembled, with a pending one shown unfinished', () => {
    expect(formatBus(LOG, 'instructions')).toEqual([
      '8000  A9 01     LDA #$01',
      '8002  8D 00 60  STA $6000',
      '8005  D0 FA     BNE $8001',
      '8007  AD        …',
    ]);
  });
  it('lists every cycle with R/W and marks opcode fetches', () => {
    const lines = formatBus(LOG, 'cycles');
    expect(lines).toHaveLength(9);
    expect(lines[0]).toBe('   1.000 ms  8000  R  A9  ▸ LDA #$01');
    expect(lines[5]).toBe('   6.000 ms  6000  W  01    ');
  });
  it('hides rows up to a cleared time and caps the line count', () => {
    expect(formatBus(LOG, 'instructions', 0.004)).toHaveLength(2);
    expect(formatBus(LOG, 'cycles', -1, 3)).toHaveLength(3);
  });
});

describe('buildRom', () => {
  it('sizes the image to the ROM and points vectors at the code', () => {
    const { rom, start } = buildRom(['NOP'], 0x2000);
    expect(rom.length).toBe(0x2000);
    expect(start).toBe(0xe000);
    expect([rom[0x1ffc], rom[0x1ffd]]).toEqual([0x00, 0xe0]);
  });
  it('rejects code below the ROM', () => {
    expect(() => buildRom(['.org $4000', 'NOP'], 0x2000)).toThrow(/\$E000/);
  });
});
