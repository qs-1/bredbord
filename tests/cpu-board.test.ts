import { describe, expect, it } from 'vitest';
import { Connectivity } from '../src/engine/netlist';
import { encodeBytes, type SimResult } from '../src/engine/sim/simulator';
import { h, pinHole, sameStrip, railNear, Bench } from './helpers/bench';

describe('A 6502 computer on a breadboard', () => {
  // The CPU, an EEPROM at the top half of the address space and a RAM at the bottom, joined by wires, with a
  // push button for the clock and another for reset. A 74LS04 turns A15 round for the EEPROM's chip enable.
  const CPU = 0;
  const ROM = 22;
  const RAM = 38;
  const INV = 54;
  const CPU_ADDRESS = [9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 22, 23, 24, 25];
  const CPU_DATA = [33, 32, 31, 30, 29, 28, 27, 26];
  const MEMORY_ADDRESS = [10, 9, 8, 7, 6, 5, 4, 3, 25, 24, 21, 23, 2, 26, 1];
  const MEMORY_DATA = [11, 12, 13, 15, 16, 17, 18, 19];

  /** The nth free hole in the same strip as a chip's pin (the pin's own hole skipped). */
  const slot = (def: string, start: number, pin: number, n = 1): string => {
    const base = pinHole(def, start, pin);
    const letters = (base[0] <= 'e' ? ['a', 'b', 'c', 'd', 'e'] : ['j', 'i', 'h', 'g', 'f']).filter(
      (l) => l !== base[0],
    );
    return `${letters[n % letters.length]}${base.slice(1)}`;
  };

  function build(rom: Uint8Array): Bench {
    const b = new Bench()
      .chip('cpu', 'W65C02S', CPU)
      .chip('rom', 'AT28C256', ROM)
      .chip('ram', '62256', RAM)
      .chip('inv', '74LS04', INV);
    b.doc.parts.find((p) => p.id === 'rom')!.data = encodeBytes(rom);
    const link = (a: [string, number, number], c: [string, number, number], n = 1): void => {
      b.wire(slot(...a, n), slot(...c, n));
    };
    CPU_ADDRESS.slice(0, 15).forEach((pin, i) => {
      link(['W65C02S', CPU, pin], ['AT28C256', ROM, MEMORY_ADDRESS[i]], 1);
      link(['W65C02S', CPU, pin], ['62256', RAM, MEMORY_ADDRESS[i]], 2);
    });
    CPU_DATA.forEach((pin, i) => {
      link(['W65C02S', CPU, pin], ['AT28C256', ROM, MEMORY_DATA[i]], 1);
      link(['W65C02S', CPU, pin], ['62256', RAM, MEMORY_DATA[i]], 2);
    });
    // Address decoding: A15 high selects the EEPROM (through the inverter), A15 low the RAM.
    b.wire(slot('W65C02S', CPU, 25, 3), slot('62256', RAM, 20, 1));
    b.wire(slot('W65C02S', CPU, 25, 4), slot('74LS04', INV, 1, 1));
    b.wire(slot('74LS04', INV, 2, 1), slot('AT28C256', ROM, 20, 1));
    b.wire(slot('W65C02S', CPU, 34, 1), slot('62256', RAM, 27, 1)); // RWB to the RAM's WE
    b.toRail(slot('AT28C256', ROM, 27, 1), 'B+', 24); // EEPROM WE high
    b.toRail(slot('AT28C256', ROM, 22, 1), 'T-', 24); // OEs low
    b.toRail(slot('62256', RAM, 22, 1), 'T-', 40);
    // The CPU's inputs we aren't using, tied high.
    for (const pin of [2, 4, 6, 36, 38])
      b.toRail(slot('W65C02S', CPU, pin, 1), pin === 2 || pin === 36 ? 'B+' : pin === 38 ? 'T+' : 'T+', 4);

    // Clock: a button from + to PHI2, with a pull-down.
    const phi2 = (n: number): string => slot('W65C02S', CPU, 37, n);
    b.part('clk', 'button', [phi2(2), phi2(3), 'a58', 'b58']);
    b.toRail('c58', 'T+', 50);
    b.part('pd', 'resistor', [phi2(4), railNear('T-', 8)], { value: 10000 });
    // Reset: a pull-up, and a button to ground.
    const resb = (n: number): string => slot('W65C02S', CPU, 40, n);
    b.part('rst', 'button', [resb(2), resb(3), 'a60', 'b60']);
    b.toRail('c60', 'T-', 50);
    b.part('pu', 'resistor', [resb(4), railNear('T+', 12)], { value: 10000 });
    return b;
  }

  /** Clocks the machine `n` times, holding reset for the first `held`. */
  function clock(b: Bench, n: number, held = 0): SimResult {
    const conn = new Connectivity(b.doc);
    let r = b.sim.snapshot();
    for (let i = 0; i < n; i++) {
      const hold = i < held ? ['rst'] : [];
      b.sim.run(b.doc, conn, new Set([...hold, 'clk']));
      r = b.sim.run(b.doc, conn, new Set(hold));
    }
    return r;
  }

  const eeprom = (program: number[]): Uint8Array => {
    const rom = new Uint8Array(32768).fill(0xea);
    rom.set(program, 0);
    rom[0x7ffc] = 0x00;
    rom[0x7ffd] = 0x80;
    return rom;
  };

  it('runs a program that uses the stack and zero page', () => {
    // LDX #$FF; TXS; LDA #$42; STA $10; JSR $8020; STA $11; INC $10; JMP *     sub: LDA #$99; RTS
    const rom = eeprom([
      0xa2, 0xff, 0x9a, 0xa9, 0x42, 0x85, 0x10, 0x20, 0x20, 0x80, 0x85, 0x11, 0xe6, 0x10, 0x4c, 0x0e, 0x80,
    ]);
    rom.set([0xa9, 0x99, 0x60], 0x20);
    const b = build(rom);
    const r = clock(b, 70, 3);
    expect(r.live).toBe(true);
    expect(r.chips.get('cpu')!.powered).toBe(true);
    const ram = b.sim.memoryOf(b.doc.parts.find((p) => p.id === 'ram')!)!;
    expect(ram[0x10]).toBe(0x43);
    expect(ram[0x11]).toBe(0x99);
    expect(ram[0x1ff]).toBe(0x80);
    expect(ram[0x1fe]).toBe(0x09);
    expect(r.problems.filter((p) => /fighting|wired to/.test(p.message))).toEqual([]);
  });

  it('shows the program counter on the address bus, at real logic levels', () => {
    // NOPs forever: the address bus counts up through the ROM, one address per two clocks.
    const b = build(eeprom([]));
    const addressOf = (r: SimResult): number =>
      CPU_ADDRESS.reduce(
        (acc, pin, i) => acc | (((r.volts(h(sameStrip(pinHole('W65C02S', CPU, pin)))) ?? 0) > 2.5 ? 1 : 0) << i),
        0,
      );
    let r = clock(b, 12, 3);
    const first = addressOf(r);
    r = clock(b, 10);
    expect(addressOf(r)).toBe(first + 5);
    const high = r.volts(h(sameStrip(pinHole('W65C02S', CPU, 25))))!;
    expect(high).toBeGreaterThan(4.5);
  });

  it('keeps the CPU stuck in reset until RESB goes high', () => {
    const b = build(eeprom([0xe6, 0x10, 0x4c, 0x00, 0x80]));
    clock(b, 40, 40);
    expect(b.sim.memoryOf(b.doc.parts.find((p) => p.id === 'ram')!)![0x10]).not.toBe(0xff);
    // Never released, so it never ran the program: the RAM holds its random power-up contents, not a count.
    const held = b.sim.memoryOf(b.doc.parts.find((p) => p.id === 'ram')!)![0x10];
    clock(b, 40, 0);
    const ran = b.sim.memoryOf(b.doc.parts.find((p) => p.id === 'ram')!)![0x10];
    expect(ran).not.toBe(held);
  });

  it('logs each bus cycle with the address and data that were really on the bus', () => {
    // LDA #$42; STA $10; INC $10; JMP *
    const rom = eeprom([0xa9, 0x42, 0x85, 0x10, 0xe6, 0x10, 0x4c, 0x06, 0x80]);
    const b = build(rom);
    clock(b, 40, 3);
    const log = b.sim.busOf(b.doc.parts.find((p) => p.id === 'cpu')!)!;
    expect(log.length).toBeGreaterThan(20);
    // Every ROM read shows the byte that is in the ROM at that address.
    const reads = log.filter((r) => r.read && r.addr >= 0x8000 && r.addr < 0x8009);
    expect(reads.length).toBeGreaterThan(5);
    for (const r of reads) expect(r.data).toBe(rom[r.addr - 0x8000]);
    // The first opcode fetch is at $8000 and the write to $0010 carries the accumulator.
    const first = log.find((r) => r.sync)!;
    expect(first.addr).toBe(0x8000);
    expect(first.data).toBe(0xa9);
    const write = log.find((r) => !r.read && r.addr === 0x10)!;
    expect(write.data).toBe(0x42);
    // Rows never run backwards in time (this bench steps the clock by hand, so time itself may stand still).
    for (let i = 1; i < log.length; i++) expect(log[i].t).toBeGreaterThanOrEqual(log[i - 1].t);
  });

  it('warns about a CPU whose bus enable is left unconnected', () => {
    const b = new Bench().chip('cpu', 'W65C02S', 0);
    const r = b.run();
    const msg = r.chips.get('cpu')!.problems.join(' ');
    expect(msg).toMatch(/not connected/);
    expect(msg).toMatch(/36/);
  });
});
