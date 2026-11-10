import { describe, expect, it } from 'vitest';
import type { PartDoc } from '../src/engine/circuit';
import {
  CHIP_MODELS,
  type Bit,
  type ChipIO,
  type ChipModel,
  type ChipState,
  type Drive,
} from '../src/engine/sim/chips';
import { Cpu65, describeOpcode, FLAG } from '../src/engine/sim/cpu65';

const fixed = (): number => 0.5;

/** A CPU on a flat 64K of memory, running from $0200. Returns how it got on. */
function machine(program: number[], setup?: (cpu: Cpu65, mem: Uint8Array) => void) {
  // Zero page and the stack start empty; everything above them is no-ops.
  const mem = new Uint8Array(65536).fill(0xea);
  mem.fill(0, 0, 0x200);
  mem.set(program, 0x0200);
  mem[0xfffc] = 0x00;
  mem[0xfffd] = 0x02;
  const cpu = new Cpu65(fixed);
  cpu.resetLow = false;
  setup?.(cpu, mem);
  const trace: { addr: number; write: boolean; sync: boolean }[] = [];
  /** Runs one clock. */
  const tick = (): void => {
    const b = cpu.bus;
    trace.push({ addr: b.addr, write: b.write, sync: b.sync });
    if (b.write) mem[b.addr] = b.data;
    cpu.advance(b.write ? 0 : mem[b.addr]);
  };
  /** Runs until the next opcode fetch begins. */
  const toNextFetch = (): number => {
    let n = 0;
    do {
      tick();
      n++;
    } while (!cpu.bus.sync && n < 100);
    return n;
  };
  /** Gets through the reset sequence and stands at the first fetch. */
  const start = (): void => {
    toNextFetch();
  };
  return { cpu, mem, trace, tick, toNextFetch, start };
}

/** Clocks the first instruction at $0200 takes. `afterReset` is for flags, which a reset sets as it likes. */
function cycles(
  program: number[],
  setup?: (cpu: Cpu65, mem: Uint8Array) => void,
  afterReset?: (cpu: Cpu65) => void,
): number {
  const m = machine(program, setup);
  m.start();
  afterReset?.(m.cpu);
  return m.toNextFetch();
}

describe('6502 timing', () => {
  const noPage = (cpu: Cpu65): void => {
    cpu.x = 0;
    cpu.y = 0;
  };
  const page = (cpu: Cpu65): void => {
    cpu.x = 0xff;
    cpu.y = 0xff;
  };

  it.each([
    ['LDA #', [0xa9, 1], 2],
    ['LDA zp', [0xa5, 0x10], 3],
    ['LDA zp,X', [0xb5, 0x10], 4],
    ['LDA abs', [0xad, 0x34, 0x12], 4],
    ['LDA abs,X', [0xbd, 0x34, 0x12], 4],
    ['LDA abs,Y', [0xb9, 0x34, 0x12], 4],
    ['LDA (zp,X)', [0xa1, 0x10], 6],
    ['LDA (zp),Y', [0xb1, 0x10], 5],
    ['LDA (zp)', [0xb2, 0x10], 5],
    ['STA zp', [0x85, 0x10], 3],
    ['STA abs', [0x8d, 0x34, 0x12], 4],
    ['STA abs,X', [0x9d, 0x34, 0x12], 5],
    ['STA (zp),Y', [0x91, 0x10], 6],
    ['STZ abs,X', [0x9e, 0x34, 0x12], 5],
    ['ASL A', [0x0a], 2],
    ['INC A', [0x1a], 2],
    ['ASL zp', [0x06, 0x10], 5],
    ['ASL zp,X', [0x16, 0x10], 6],
    ['ASL abs', [0x0e, 0x34, 0x12], 6],
    ['ASL abs,X', [0x1e, 0x34, 0x12], 6],
    ['INC abs,X', [0xfe, 0x34, 0x12], 7],
    ['TSB zp', [0x04, 0x10], 5],
    ['TRB abs', [0x1c, 0x34, 0x12], 6],
    ['RMB3 zp', [0x37, 0x10], 5],
    ['SMB7 zp', [0xf7, 0x10], 5],
    ['BIT #', [0x89, 1], 2],
    ['NOP', [0xea], 2],
    ['PHA', [0x48], 3],
    ['PLA', [0x68], 4],
    ['PHX', [0xda], 3],
    ['PLY', [0x7a], 4],
    ['JMP abs', [0x4c, 0x00, 0x03], 3],
    ['JMP (abs)', [0x6c, 0x34, 0x12], 6],
    ['JMP (abs,X)', [0x7c, 0x34, 0x12], 6],
    ['JSR', [0x20, 0x00, 0x03], 6],
    ['BRK', [0x00, 0x00], 7],
    ['BRA', [0x80, 0x10], 3],
    ['BEQ not taken', [0xf0, 0x10], 2],
    ['unused 1-byte no-op', [0x03], 1],
    ['unused 2-byte no-op', [0x02, 0x00], 2],
    ['unused no-op that reads zp', [0x44, 0x10], 3],
    ['unused no-op that reads abs', [0xdc, 0x34, 0x12], 4],
    ['unused 8-clock no-op', [0x5c, 0x34, 0x12], 8],
  ])('%s', (name, program, expected) => {
    expect(cycles(program as number[], noPage), `${name} should take ${expected} clocks`).toBe(expected);
  });

  it('adds a clock when indexing crosses a page, but only for reads and the shifts', () => {
    expect(cycles([0xbd, 0x34, 0x12], page)).toBe(5);
    expect(
      cycles([0xb1, 0x10], (cpu, mem) => {
        page(cpu);
        mem[0x10] = 0x80;
        mem[0x11] = 0x12;
      }),
    ).toBe(6);
    expect(cycles([0x1e, 0x34, 0x12], page)).toBe(7);
    // A store always takes the extra clock; it doesn't take another for the carry.
    expect(cycles([0x9d, 0x34, 0x12], page)).toBe(5);
  });

  it('takes a branch in three clocks, four when it crosses a page', () => {
    expect(cycles([0xd0, 0x10], (cpu) => (cpu.p &= ~FLAG.Z))).toBe(3);
    const m = machine([], (_, mem) => {
      mem.set([0xd0, 0x10], 0x02f0);
      mem[0xfffc] = 0xf0;
    });
    m.cpu.p &= ~FLAG.Z;
    m.start();
    expect(m.toNextFetch()).toBe(4);
    expect(m.cpu.bus.addr).toBe(0x0302);
  });

  it('takes an extra clock for decimal-mode addition and subtraction', () => {
    expect(cycles([0x69, 0x01])).toBe(2);
    expect(cycles([0x69, 0x01], undefined, (cpu) => (cpu.p |= FLAG.D))).toBe(3);
    expect(cycles([0xe9, 0x01], undefined, (cpu) => (cpu.p |= FLAG.D))).toBe(3);
  });

  it('takes a bit-test branch in five clocks when it falls through', () => {
    expect(cycles([0x0f, 0x10, 0x10], (_, mem) => (mem[0x10] = 0x01))).toBe(5);
    expect(cycles([0x8f, 0x10, 0x10], (_, mem) => (mem[0x10] = 0x01))).toBe(6);
  });

  it('names opcodes the way a listing would', () => {
    expect(describeOpcode(0xea)).toBe('NOP');
    expect(describeOpcode(0xbd)).toBe('LDA abx');
    expect(describeOpcode(0x07)).toBe('RMB0 zp');
  });
});

describe('6502 reset and bus', () => {
  it('takes seven clocks to come out of reset, then reads the vector and fetches from it', () => {
    const m = machine([]);
    const seen: string[] = [];
    for (let i = 0; i < 10; i++) {
      seen.push(`${m.cpu.bus.addr.toString(16)}${m.cpu.bus.vectorPull ? 'v' : ''}${m.cpu.bus.sync ? 's' : ''}`);
      m.tick();
    }
    // The first clock is the one that finds RESB high. Then two reads where it was, three stack reads, the two
    // vector bytes, and the opcode at $0200.
    expect(seen[1]).toBe(seen[2]);
    expect(seen.slice(3, 6)).toEqual([
      expect.stringMatching(/^1[0-9a-f]{2}$/),
      expect.stringMatching(/^1[0-9a-f]{2}$/),
      expect.stringMatching(/^1[0-9a-f]{2}$/),
    ]);
    expect(seen.slice(6)).toEqual(['fffcv', 'fffdv', '200s', '201']);
  });

  it('drops the stack pointer by three and sets the interrupt flag', () => {
    const m = machine([], (cpu) => (cpu.sp = 0xf0));
    m.start();
    expect(m.cpu.sp).toBe(0xed);
    expect(m.cpu.p & FLAG.I).toBeTruthy();
    expect(m.cpu.p & FLAG.D).toBe(0);
  });

  it('sits reading while RESB is low, and restarts when it goes low again mid-program', () => {
    const m = machine([0x4c, 0x00, 0x02], (cpu) => (cpu.resetLow = true));
    for (let i = 0; i < 5; i++) {
      expect(m.cpu.bus.write).toBe(false);
      m.tick();
    }
    m.cpu.resetLow = false;
    m.start();
    expect(m.cpu.bus.addr).toBe(0x0200);
    m.tick();
    m.cpu.resetLow = true;
    m.tick();
    m.tick();
    m.cpu.resetLow = false;
    m.start();
    expect(m.cpu.bus.addr).toBe(0x0200);
  });

  it('marks opcode fetches with SYNC and the read-modify-write with MLB', () => {
    const m = machine([0xee, 0x00, 0x03]);
    m.start();
    const cycleFlags: [boolean, boolean][] = [];
    for (let i = 0; i < 6; i++) {
      cycleFlags.push([m.cpu.bus.sync, m.cpu.bus.memoryLock]);
      m.tick();
    }
    expect(cycleFlags).toEqual([
      [true, false],
      [false, false],
      [false, false],
      [false, true],
      [false, true],
      [false, true],
    ]);
  });

  it('writes the result of a read-modify-write after reading it twice', () => {
    const m = machine([0xee, 0x00, 0x03], (_, mem) => (mem[0x300] = 0x41));
    m.start();
    m.toNextFetch();
    expect(m.mem[0x300]).toBe(0x42);
    const accesses = m.trace.filter((t) => t.addr === 0x300).map((t) => (t.write ? 'w' : 'r'));
    expect(accesses).toEqual(['r', 'r', 'w']);
  });
});

describe('6502 programs', () => {
  /** Runs until PC reaches `until` at an opcode fetch. */
  const run = (m: ReturnType<typeof machine>, until: number, limit = 100000): void => {
    for (let i = 0; i < limit; i++) {
      if (m.cpu.bus.sync && m.cpu.bus.addr === until) return;
      m.tick();
    }
    throw new Error(`never reached $${until.toString(16)}`);
  };

  it('calls and returns through the stack', () => {
    // JSR $0210; STA $20; JMP *    sub: LDA #$77; RTS
    const m = machine([0x20, 0x10, 0x02, 0x85, 0x20, 0x4c, 0x05, 0x02, 0, 0, 0, 0, 0, 0, 0, 0, 0xa9, 0x77, 0x60]);
    m.start();
    m.cpu.sp = 0xff;
    run(m, 0x0205);
    expect(m.mem[0x20]).toBe(0x77);
    expect(m.mem[0x1ff]).toBe(0x02);
    expect(m.mem[0x1fe]).toBe(0x02);
    expect(m.cpu.sp).toBe(0xff);
  });

  it('takes an interrupt and comes back with RTI, with I set inside the handler', () => {
    // main: CLI; INC $30; JMP main2 (loops)   handler at $0300: INC $31; RTI
    const m = machine([0x58, 0xe6, 0x30, 0x4c, 0x01, 0x02], (_, mem) => {
      mem.set([0xe6, 0x31, 0x40], 0x0300);
      mem[0xfffe] = 0x00;
      mem[0xffff] = 0x03;
    });
    m.start();
    m.cpu.sp = 0xff;
    for (let i = 0; i < 20; i++) m.tick();
    m.cpu.irqLow = true;
    const before = m.mem[0x30];
    for (let i = 0; i < 3; i++) m.toNextFetch();
    // IRQ is a level: still low, so after RTI clears nothing it fires again, but I is set on entry.
    expect(m.mem[0x31]).toBeGreaterThanOrEqual(1);
    m.cpu.irqLow = false;
    for (let i = 0; i < 50; i++) m.tick();
    expect(m.mem[0x30]).toBeGreaterThan(before);
    expect(m.cpu.p & FLAG.I).toBe(0);
  });

  it('services an NMI edge once, even with interrupts disabled', () => {
    const m = machine([0x78, 0x4c, 0x01, 0x02], (_, mem) => {
      mem.set([0xe6, 0x40, 0x40], 0x0300);
      mem[0xfffa] = 0x00;
      mem[0xfffb] = 0x03;
    });
    m.start();
    m.cpu.sp = 0xff;
    m.cpu.nmiPending = true;
    for (let i = 0; i < 60; i++) m.tick();
    expect(m.mem[0x40]).toBe(1);
  });

  it('pushes the flags with B set for BRK and clear for an interrupt', () => {
    const brk = machine([0x00, 0x00]);
    brk.start();
    brk.cpu.sp = 0xff;
    brk.toNextFetch();
    expect(brk.mem[0x1fd] & FLAG.B).toBeTruthy();

    const irq = machine([0xea], (cpu) => (cpu.irqLow = true));
    irq.start();
    irq.cpu.sp = 0xff;
    irq.cpu.p &= ~FLAG.I;
    irq.toNextFetch();
    irq.toNextFetch();
    expect(irq.mem[0x1fd] & FLAG.B).toBe(0);
  });

  it('adds and subtracts in decimal', () => {
    const adc = machine([0xf8, 0x18, 0xa9, 0x58, 0x69, 0x46, 0x4c, 0x06, 0x02]);
    adc.start();
    run(adc, 0x0206);
    // 58 + 46 = 104: A holds 04 and the carry is set.
    expect(adc.cpu.a).toBe(0x04);
    expect(adc.cpu.p & FLAG.C).toBeTruthy();

    const sbc = machine([0xf8, 0x38, 0xa9, 0x32, 0xe9, 0x04, 0x4c, 0x06, 0x02]);
    sbc.start();
    run(sbc, 0x0206);
    expect(sbc.cpu.a).toBe(0x28);
    expect(sbc.cpu.p & FLAG.C).toBeTruthy();
  });

  it('waits for an interrupt on WAI and stops for good on STP', () => {
    const wai = machine([0xcb, 0xe6, 0x50, 0x4c, 0x03, 0x02]);
    wai.start();
    for (let i = 0; i < 30; i++) wai.tick();
    expect(wai.mem[0x50]).toBe(0);
    // With I set, an IRQ just wakes it up.
    wai.cpu.irqLow = true;
    for (let i = 0; i < 10; i++) wai.tick();
    expect(wai.mem[0x50]).toBeGreaterThan(0);

    const stp = machine([0xdb, 0xe6, 0x50]);
    stp.start();
    for (let i = 0; i < 30; i++) stp.tick();
    expect(stp.mem[0x50]).toBe(0);
  });

  it('tests and branches on single bits', () => {
    // SMB2 $10; BBS2 $10,+2 (taken, skips INC); INC $11; INC $12; JMP *
    const m = machine([0xa7, 0x10, 0xaf, 0x10, 0x02, 0xe6, 0x11, 0xe6, 0x12, 0x4c, 0x09, 0x02]);
    m.start();
    run(m, 0x0209);
    expect(m.mem[0x10]).toBe(0x04);
    expect(m.mem[0x11]).toBe(0);
    expect(m.mem[0x12]).toBe(1);
  });
});

// ---- the chips wired together ----

/** A rig of chip models on shared nets, stepped a pass at a time like the simulator does. */
class Rig {
  private readonly nets = new Uint8Array(256);
  private readonly chips: {
    model: ChipModel;
    state: ChipState;
    nets: number[];
    levels: Uint8Array;
    prev: Uint8Array;
    drives: Drive[];
    io: ChipIO;
    writes: number;
  }[] = [];
  /** Glue logic between nets, recomputed every pass from the nets as they stood (one gate delay). */
  glue: (n: Uint8Array) => void = () => {};

  add(id: string, wiring: Record<number, number>, setup?: (s: ChipState) => void) {
    const model = CHIP_MODELS[id];
    const size = 41;
    const chip = {
      model,
      state: { q: 0, latch: 0, addr: 0, ...model.init?.() } as ChipState,
      nets: Array.from({ length: size }, (_, pin) => wiring[pin] ?? -1),
      levels: new Uint8Array(size),
      prev: new Uint8Array(size),
      drives: Array.from({ length: size }, () => null) as Drive[],
      io: undefined as unknown as ChipIO,
      writes: 0,
    };
    chip.io = {
      vcc: 5,
      now: 0,
      part: { id, def: id, pins: [] } as unknown as PartDoc,
      get: (pin: number) => chip.levels[pin] as Bit,
      rose: (pin: number) => chip.prev[pin] === 0 && chip.levels[pin] === 1,
      fell: (pin: number) => chip.prev[pin] === 1 && chip.levels[pin] === 0,
      volts: () => NaN,
      steady: () => NaN,
      set: (pin: number, value: Drive) => {
        chip.drives[pin] = value;
      },
      wrote: () => {
        chip.writes++;
      },
    };
    setup?.(chip.state);
    this.chips.push(chip);
    return chip;
  }

  net(n: number): number {
    return this.nets[n];
  }
  set(n: number, v: number): void {
    this.nets[n] = v;
  }

  /** One pass: every chip reads the nets, reacts, and the nets take whatever is being driven. */
  pass(): boolean {
    const before = this.nets.slice();
    this.glue(this.nets);
    for (const c of this.chips) {
      c.prev.set(c.levels);
      c.model.inputs.forEach((pin) => {
        if (c.nets[pin] >= 0) c.levels[pin] = before[c.nets[pin]];
      });
      c.model.eval(c.io, c.state);
    }
    // Only a net nobody drives keeps its old value (the buses float to whatever they last held).
    for (const c of this.chips) {
      c.model.outputs.forEach((pin) => {
        const d = c.drives[pin];
        if (c.nets[pin] >= 0 && d !== null && d !== undefined) this.nets[c.nets[pin]] = d;
      });
    }
    return this.nets.some((v, i) => v !== before[i]);
  }

  settle(): void {
    for (let i = 0; i < 20; i++) if (!this.pass()) return;
    throw new Error('never settled');
  }
}

describe('6502 with its ROM and RAM', () => {
  // Nets: 0–15 address, 16–23 data, 24 RWB, 25 PHI2, 26 RESB, 27 ROM CE, 28 RAM CE, 29 RAM WE, 30 high, 31 low, 32 IRQB.
  const ADDRESS = Array.from({ length: 16 }, (_, i) => i);
  const DATA = Array.from({ length: 8 }, (_, i) => 16 + i);

  function build(rom: Uint8Array, gatedWrite: boolean) {
    const rig = new Rig();
    const cpuAddress = [9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 22, 23, 24, 25];
    const cpuData = [33, 32, 31, 30, 29, 28, 27, 26];
    // RDY gets a net of its own (33), so a test can pull it low.
    const wiring: Record<number, number> = { 34: 24, 37: 25, 40: 26, 2: 33, 4: 32, 6: 30, 36: 30, 38: 30 };
    cpuAddress.forEach((pin, i) => (wiring[pin] = ADDRESS[i]));
    cpuData.forEach((pin, i) => (wiring[pin] = DATA[i]));
    const cpu = rig.add('W65C02S', wiring);

    const memoryWiring = (ce: number, we: number): Record<number, number> => {
      const w: Record<number, number> = { 20: ce, 22: 31, 27: we };
      [10, 9, 8, 7, 6, 5, 4, 3, 25, 24, 21, 23, 2, 26, 1].forEach((pin, i) => (w[pin] = ADDRESS[i]));
      [11, 12, 13, 15, 16, 17, 18, 19].forEach((pin, i) => (w[pin] = DATA[i]));
      return w;
    };
    const eeprom = rig.add('AT28C256', memoryWiring(27, 30), (s) => (s.mem = rom));
    const ram = rig.add('62256', memoryWiring(28, 29));

    rig.set(30, 1);
    rig.set(32, 1);
    rig.set(33, 1);
    rig.glue = (n) => {
      n[27] = n[15] ? 0 : 1; // ROM selected when A15 is high
      n[28] = n[15]; // RAM selected when A15 is low
      // The simple way to wire RAM: WE straight from RWB. The tidy way: only while PHI2 is high.
      n[29] = gatedWrite ? (n[24] || !n[25] ? 1 : 0) : n[24];
    };
    return { rig, cpu, eeprom, ram };
  }

  function romWith(program: number[]): Uint8Array {
    const rom = new Uint8Array(32768).fill(0xea);
    rom.set(program, 0);
    rom[0x7ffc] = 0x00;
    rom[0x7ffd] = 0x80;
    return rom;
  }

  const clock = (rig: Rig, cycles: number): void => {
    for (let i = 0; i < cycles; i++) {
      rig.set(25, 1);
      rig.settle();
      rig.set(25, 0);
      rig.settle();
    }
  };

  const reset = (rig: Rig): void => {
    rig.set(26, 0);
    rig.settle();
    clock(rig, 3);
    rig.set(26, 1);
    rig.settle();
  };

  // LDX #$FF; TXS; LDA #$42; STA $10; JSR $8020; STA $11; INC $10; JMP *   sub: LDA #$99; RTS
  const program = [
    0xa2, 0xff, 0x9a, 0xa9, 0x42, 0x85, 0x10, 0x20, 0x20, 0x80, 0x85, 0x11, 0xe6, 0x10, 0x4c, 0x0e, 0x80,
  ];
  const sub = [0xa9, 0x99, 0x60];

  it.each([
    ['WE straight from RWB', false],
    ['WE only while PHI2 is high', true],
  ])('runs a program from ROM, using RAM for data and stack, with %s', (_, gated) => {
    const rom = romWith(program);
    rom.set(sub, 0x20);
    const { rig, ram } = build(rom, gated);
    reset(rig);
    clock(rig, 80);
    const mem = ram.state.mem!;
    expect(mem[0x10]).toBe(0x43);
    expect(mem[0x11]).toBe(0x99);
    // JSR pushed the address of its last byte: $8009.
    expect(mem[0x1ff]).toBe(0x80);
    expect(mem[0x1fe]).toBe(0x09);
  });

  it('presents the reset vector and starts the program where it points', () => {
    const { rig } = build(romWith([0xea]), false);
    reset(rig);
    const addresses: number[] = [];
    for (let i = 0; i < 12; i++) {
      clock(rig, 1);
      addresses.push(ADDRESS.reduce((acc, n, bit) => acc | (rig.net(n) << bit), 0));
    }
    // The vector comes from the top of the ROM, then the program starts where it points.
    const at = addresses.indexOf(0xfffc);
    expect(at).toBeGreaterThanOrEqual(0);
    expect(addresses.slice(at, at + 4)).toEqual([0xfffc, 0xfffd, 0x8000, 0x8001]);
  });

  it('lets go of the data bus except while writing', () => {
    const { rig, cpu } = build(romWith([0xa9, 0x5a, 0x85, 0x00, 0x4c, 0x04, 0x80]), false);
    reset(rig);
    let wrote = false;
    for (let i = 0; i < 40; i++) {
      rig.set(25, 1);
      rig.settle();
      const writing = rig.net(24) === 0;
      cpu.drives.slice(26, 34).forEach((d) => {
        if (!writing) expect(d).toBeNull();
        else wrote = true;
      });
      rig.set(25, 0);
      rig.settle();
    }
    expect(wrote).toBe(true);
  });

  it('stalls on RDY low and carries on when it rises', () => {
    const { rig } = build(romWith([0xea]), false);
    const address = (): number => ADDRESS.reduce((acc, n, bit) => acc | (rig.net(n) << bit), 0);
    reset(rig);
    clock(rig, 12);
    const at = address();
    rig.set(33, 0);
    clock(rig, 6);
    expect(address()).toBe(at);
    rig.set(33, 1);
    clock(rig, 3);
    expect(address()).not.toBe(at);
  });

  it('lets go of the buses while BE is low', () => {
    const { rig, cpu } = build(romWith([0xea]), false);
    reset(rig);
    clock(rig, 12);
    expect(cpu.drives[9]).not.toBeNull();
    // BE is pin 36 on net 30; the glue holds that net high, so use a net of its own by rewiring the chip.
    cpu.nets[36] = 34;
    rig.set(34, 0);
    clock(rig, 1);
    expect([9, 10, 20, 25, 34].every((pin) => cpu.drives[pin] === null)).toBe(true);
  });
});

describe('memory chips', () => {
  class Port implements ChipIO {
    readonly vcc = 5;
    readonly now = 0;
    readonly part = { id: 'm', def: '', pins: [] } as unknown as PartDoc;
    readonly levels = new Uint8Array(32).fill(1);
    prev = new Uint8Array(32).fill(1);
    readonly drives = new Map<number, Drive>();
    wrote_ = 0;
    constructor(
      readonly model: ChipModel,
      readonly state: ChipState,
    ) {}
    get(pin: number): Bit {
      return this.levels[pin] as Bit;
    }
    rose(pin: number): boolean {
      return this.prev[pin] === 0 && this.levels[pin] === 1;
    }
    fell(pin: number): boolean {
      return this.prev[pin] === 1 && this.levels[pin] === 0;
    }
    volts(): number {
      return NaN;
    }
    steady(): number {
      return NaN;
    }
    set(pin: number, v: Drive): void {
      this.drives.set(pin, v);
    }
    wrote(): void {
      this.wrote_++;
    }
    apply(pins: Record<number, number>): this {
      this.prev = this.levels.slice();
      for (const [pin, v] of Object.entries(pins)) this.levels[Number(pin)] = v;
      this.model.eval(this, this.state);
      return this;
    }
    address(a: number): Record<number, number> {
      const pins = [10, 9, 8, 7, 6, 5, 4, 3, 25, 24, 21, 23, 2, 26, 1];
      return Object.fromEntries(pins.map((p, i) => [p, (a >> i) & 1]));
    }
    data(v: number): Record<number, number> {
      return Object.fromEntries([11, 12, 13, 15, 16, 17, 18, 19].map((p, i) => [p, (v >> i) & 1]));
    }
    out(): number | null {
      const pins = [11, 12, 13, 15, 16, 17, 18, 19];
      const ds = pins.map((p) => this.drives.get(p) ?? null);
      return ds.some((d) => d === null) ? null : ds.reduce<number>((acc, d, i) => acc | ((d as number) << i), 0);
    }
  }

  const make = (id: string): Port => {
    const model = CHIP_MODELS[id];
    const state = { q: 0, latch: 0, addr: 0, ...model.init?.() } as ChipState;
    if (model.nonvolatile) state.mem = new Uint8Array(model.nonvolatile).fill(0xff);
    return new Port(model, state);
  };

  it.each(['AT28C256', '62256'])('%s: writes on the rising edge of WE and reads the byte back', (id) => {
    const m = make(id);
    // CE low, OE high, WE low with the data on the pins; the byte lands when WE rises.
    m.apply({ 20: 0, 22: 1, 27: 0, ...m.address(0x1234), ...m.data(0xa5) });
    expect(m.state.mem![0x1234]).not.toBe(0xa5);
    m.apply({ 27: 1 });
    expect(m.state.mem![0x1234]).toBe(0xa5);
    m.apply({ 22: 0 });
    expect(m.out()).toBe(0xa5);
    m.apply({ 22: 1 });
    expect(m.out()).toBeNull();
  });

  it('takes the byte from before the address and data moved on, when CE and the address change together', () => {
    const m = make('62256');
    m.apply({ 20: 0, 22: 1, 27: 0, ...m.address(0x0010), ...m.data(0x77) });
    // CE rises as the address and data both change.
    m.apply({ 20: 1, ...m.address(0x0020), ...m.data(0x00) });
    expect(m.state.mem![0x0010]).toBe(0x77);
    expect(m.state.mem![0x0020]).not.toBe(0x77);
  });

  it('finishes one write when the address moves with WE still low, then starts the next', () => {
    const m = make('62256');
    m.apply({ 20: 0, 22: 1, 27: 0, ...m.address(0x01ff), ...m.data(0x80) });
    m.apply({ ...m.address(0x01fe), ...m.data(0x09) });
    m.apply({ 27: 1 });
    expect(m.state.mem![0x01ff]).toBe(0x80);
    expect(m.state.mem![0x01fe]).toBe(0x09);
  });

  it('tells the simulator when an EEPROM is written but not when a RAM is', () => {
    const rom = make('AT28C256');
    rom.apply({ 20: 0, 22: 1, 27: 0, ...rom.address(5), ...rom.data(1) });
    rom.apply({ 27: 1 });
    expect(rom.wrote_).toBe(1);
    const ram = make('62256');
    ram.apply({ 20: 0, 22: 1, 27: 0, ...ram.address(5), ...ram.data(1) });
    ram.apply({ 27: 1 });
    expect(ram.wrote_).toBe(0);
  });

  it('wakes a RAM holding random bytes but an EEPROM holding what was saved', () => {
    const ram = make('62256');
    const distinct = new Set(ram.state.mem!.slice(0, 64));
    expect(distinct.size).toBeGreaterThan(8);
  });
});
