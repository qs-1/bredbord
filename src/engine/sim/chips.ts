// What each chip does, pin by pin (pin numbers are the datasheet's, starting at 1), and how its
// inputs and outputs behave electrically for its logic family.

import type { PartDoc } from '../circuit';
import { Cpu65, FLAG } from './cpu65';
import type { LcdState } from './lcd';

export type Bit = 0 | 1;
/** What an output pin is doing: driving low, driving high, or letting go (high impedance). */
export type Drive = Bit | null;
export type Family = 'LS' | 'HC' | 'CMOS' | 'NE555' | 'AVR' | 'C02';

export interface FamilyTraits {
  /** High output level for a given supply voltage, and its source resistance. */
  voh: (vcc: number) => number;
  roh: number;
  vol: number;
  rol: number;
  /** Bipolar TTL inputs float up to about 1.6 V and source ~0.4 mA when pulled low. */
  input: { volts: number; g: number } | null;
  /** Input switching point, volts above the chip's ground. */
  threshold: number;
}

export const FAMILIES: Readonly<Record<Family, FamilyTraits>> = {
  LS: { voh: (vcc) => vcc - 1.4, roh: 110, vol: 0.12, rol: 25, input: { volts: 1.6, g: 1 / 4000 }, threshold: 1.3 },
  HC: { voh: (vcc) => vcc, roh: 45, vol: 0, rol: 30, input: null, threshold: 2.5 },
  CMOS: { voh: (vcc) => vcc, roh: 100, vol: 0, rol: 50, input: null, threshold: 1.4 },
  NE555: { voh: (vcc) => vcc - 1.7, roh: 12, vol: 0.1, rol: 8, input: null, threshold: 2.5 },
  AVR: { voh: (vcc) => vcc, roh: 25, vol: 0, rol: 25, input: null, threshold: 2.5 },
  // The W65C02S: rail to rail, with outputs a little weaker than an HC gate's.
  C02: { voh: (vcc) => vcc, roh: 60, vol: 0, rol: 40, input: null, threshold: 2.5 },
};

export interface ChipIO {
  readonly vcc: number;
  /** Circuit time, seconds. */
  readonly now: number;
  /** The part being run, for chips with settings (a microcontroller's sketch). */
  readonly part: PartDoc;
  get(pin: number): Bit;
  rose(pin: number): boolean;
  fell(pin: number): boolean;
  /** Pin voltage above the chip's ground; NaN if nothing connects to it. */
  volts(pin: number): number;
  /** Where the pin's voltage is heading, ignoring capacitors that are still charging. */
  steady(pin: number): number;
  set(pin: number, value: Drive): void;
  pull?(pin: number, enabled: boolean): void;
  /** Memory that keeps its contents without power (an EEPROM) was written. */
  wrote(): void;
}

export interface ChipState {
  q: number;
  latch: number;
  addr: number;
  mem?: Uint8Array;
  /** Circuit time a microcontroller next does something by itself. */
  wake?: number;
  /** A microcontroller's running sketch. */
  run?: SketchRun;
  avr?: AvrRun;
  /** A 6502 mid-program. */
  cpu?: Cpu65;
  /** A CPU's bus log, one row per clock cycle (see `ChipModel.bus`). */
  bus?: BusRecord[];
  /** Clock cycles logged since the power came on. */
  cycles?: number;
  /** A character LCD's controller. */
  lcd?: LcdState;
}

/** Which pins make up a CPU's bus, so the simulator can log it for the bus trace panel. */
export interface BusTap {
  clock: number;
  addr: readonly number[];
  data: readonly number[];
  rw: number;
  sync?: number;
}

/** One clock cycle on a CPU's bus. */
export interface BusRecord {
  t: number;
  /** Which clock cycle since the power came on, counting from 1. */
  n?: number;
  addr: number;
  data: number;
  read: boolean;
  sync: boolean;
}

/** A sketch part way through: what it was started from, where it's up to, and what it printed. */
export interface SketchRun {
  key: string;
  steps: Iterator<number, void>;
  /** The pins it works through, pointed at the chip as it is now (it's rebuilt with every edit). */
  board: { io: ChipIO };
  serial: string;
  /** How far through its job it is, 0–1, if it has one. */
  progress?: number;
  /** Circuit time its TX light stays on until. */
  txUntil: number;
}

/** A compiled AVR program attached to a clocked chip. */
export interface AvrRun {
  key: string;
  serial: string;
  txUntil: number;
  progress?: number;
  step(io: ChipIO): number;
}

export interface ChipModel {
  family: Family;
  vcc: number;
  gnd: number;
  /** Pins that read the circuit (bidirectional pins appear in both lists). */
  inputs: readonly number[];
  /** Pins that can drive, including tri-state and open-collector ones. */
  outputs: readonly number[];
  /** Fixed internal pulls while powered, like the 555's divider on its control pin. */
  bias?: readonly { pin: number; volts: (vcc: number) => number; g: number }[];
  /**
   * For inputs read as voltages: where (volts above the chip's ground) the pin starts doing
   * something different. Other inputs switch at the family's threshold.
   */
  thresholds?(pin: number, io: ChipIO): readonly number[];
  /**
   * Schmitt-trigger inputs: an input reads high once it climbs above `rise` and low once it falls
   * below `fall` (volts above the chip's ground), and holds its last reading in between. A floating
   * input reads high.
   */
  schmitt?: { rise: number; fall: number };
  eval(io: ChipIO, s: ChipState): void;
  /** Fresh state at power-up. */
  init?(): Partial<ChipState>;
  /** Bytes of memory that keep their contents with the power off (EEPROMs). */
  nonvolatile?: number;
  /** Does things by itself as time passes (a microcontroller): `state.wake` says when next. */
  clocked?: boolean;
  /** A CPU: which pins to log in the bus trace panel. */
  bus?: BusTap;
}

const bits = (io: ChipIO, pins: readonly number[]): number => pins.reduce((acc, p, i) => acc | (io.get(p) << i), 0);
const put = (io: ChipIO, pins: readonly number[], value: number | null): void =>
  pins.forEach((p, i) => io.set(p, value === null ? null : (((value >> i) & 1) as Bit)));
const not = (b: Bit): Bit => (b ? 0 : 1);

/** RAM wakes up holding whatever it likes. */
function randomMemory(words: number, mask: number): Uint8Array {
  return Uint8Array.from({ length: words }, () => Math.floor(Math.random() * 256) & mask);
}

/** One flip-flop of a 74LS74/76/107: [clock, preset, clear, D or J, K, Q, Q̄]. Preset 0 = none; K 0 = a D flip-flop. */
type FlipFlopPins = readonly [number, number, number, number, number, number, number];

function flipFlops(io: ChipIO, s: ChipState, ffs: readonly FlipFlopPins[], edge: 'rise' | 'fall'): void {
  ffs.forEach(([clk, pre, clr, j, k, q, nq], i) => {
    const bit = 1 << i;
    const clear = !io.get(clr);
    const preset = pre > 0 && !io.get(pre);
    if (clear && preset) {
      // Both forced at once: Q and Q̄ both go high until one lets go.
      io.set(q, 1);
      io.set(nq, 1);
      return;
    }
    if (clear) s.q &= ~bit;
    else if (preset) s.q |= bit;
    else if (edge === 'rise' ? io.rose(clk) : io.fell(clk)) {
      if (!k) s.q = io.get(j) ? s.q | bit : s.q & ~bit;
      else if (io.get(j) && io.get(k)) s.q ^= bit;
      else if (io.get(j)) s.q |= bit;
      else if (io.get(k)) s.q &= ~bit;
    }
    const v: Bit = s.q & bit ? 1 : 0;
    io.set(q, v);
    io.set(nq, not(v));
  });
}

/** The 555's comparators switch at its control voltage (normally two thirds of VCC) and at half of it. */
function control555(io: ChipIO): number {
  const v = io.steady(5);
  return Number.isFinite(v) ? v : (2 * io.vcc) / 3;
}

/** Quad 2-input gates: [a, b, y] for each gate. */
function quad(op: (a: Bit, b: Bit) => Bit, gates: readonly (readonly [number, number, number])[]): ChipModel {
  return {
    family: 'LS',
    vcc: 14,
    gnd: 7,
    inputs: gates.flatMap(([a, b]) => [a, b]),
    outputs: gates.map(([, , y]) => y),
    eval(io) {
      for (const [a, b, y] of gates) io.set(y, op(io.get(a), io.get(b)));
    },
  };
}

/** Triple 3-input gates: [a, b, c, y] for each gate. */
function triple(
  op: (a: Bit, b: Bit, c: Bit) => Bit,
  gates: readonly (readonly [number, number, number, number])[],
): ChipModel {
  return {
    family: 'LS',
    vcc: 14,
    gnd: 7,
    inputs: gates.flatMap(([a, b, c]) => [a, b, c]),
    outputs: gates.map(([, , , y]) => y),
    eval(io) {
      for (const [a, b, c, y] of gates) io.set(y, op(io.get(a), io.get(b), io.get(c)));
    },
  };
}

/** 7447 segment patterns for BCD 0–15 as the segments that light (a–g). 10–15 are the chip's odd shapes. */
const SEGMENTS_47 = [
  'abcdef',
  'bc',
  'abdeg',
  'abcdg',
  'bcfg',
  'acdfg',
  'acdefg',
  'abc',
  'abcdefg',
  'abcdfg',
  'deg',
  'cdg',
  'bfg',
  'adfg',
  'defg',
  '',
].map((lit) => [...lit].reduce((mask, seg) => mask | (1 << (seg.charCodeAt(0) - 97)), 0));
/** 74LS47 output pins for segments a–g. */
const SEGMENT_PINS_47 = [13, 12, 11, 10, 9, 15, 14] as const;

const STANDARD_GATES = [
  [1, 2, 3],
  [4, 5, 6],
  [9, 10, 8],
  [12, 13, 11],
] as const;
const NOR_GATES = [
  [2, 3, 1],
  [5, 6, 4],
  [8, 9, 10],
  [11, 12, 13],
] as const;
const INVERTERS = [
  [1, 2],
  [3, 4],
  [5, 6],
  [9, 8],
  [11, 10],
  [13, 12],
] as const;
/** The 74LS10, 11 and 27 share a pinout. */
const TRIPLE_GATES = [
  [1, 2, 13, 12],
  [3, 4, 5, 6],
  [9, 10, 11, 8],
] as const;
/** Quad tri-state buffers: [enable (active low), a, y]. */
const BUFFERS = [
  [1, 2, 3],
  [4, 5, 6],
  [10, 9, 8],
  [13, 12, 11],
] as const;

/** What a gate chip's gates are, for drawing them: each gate's input pins, its output pin, and an enable pin (active low). */
export interface GateLayout {
  gate: 'and' | 'nand' | 'or' | 'nor' | 'xor' | 'not' | 'buffer';
  /** Inputs with hysteresis (the 74LS14). */
  schmitt?: boolean;
  gates: readonly { inputs: readonly number[]; output: number; enable?: number }[];
}

const two = (gates: readonly (readonly [number, number, number])[]): GateLayout['gates'] =>
  gates.map(([a, b, y]) => ({ inputs: [a, b], output: y }));
const three = TRIPLE_GATES.map(([a, b, c, y]) => ({ inputs: [a, b, c], output: y }));
const inverters = INVERTERS.map(([a, y]) => ({ inputs: [a], output: y }));

export const GATE_LAYOUTS: Readonly<Record<string, GateLayout>> = {
  '74LS00': { gate: 'nand', gates: two(STANDARD_GATES) },
  '74LS02': { gate: 'nor', gates: two(NOR_GATES) },
  '74LS08': { gate: 'and', gates: two(STANDARD_GATES) },
  '74LS32': { gate: 'or', gates: two(STANDARD_GATES) },
  '74LS86': { gate: 'xor', gates: two(STANDARD_GATES) },
  '74LS10': { gate: 'nand', gates: three },
  '74LS11': { gate: 'and', gates: three },
  '74LS27': { gate: 'nor', gates: three },
  '74LS04': { gate: 'not', gates: inverters },
  '74LS14': { gate: 'not', schmitt: true, gates: inverters },
  '74LS125': { gate: 'buffer', gates: BUFFERS.map(([g, a, y]) => ({ inputs: [a], output: y, enable: g })) },
};

const hexInverter: ChipModel = {
  family: 'LS',
  vcc: 14,
  gnd: 7,
  inputs: INVERTERS.map(([a]) => a),
  outputs: INVERTERS.map(([, y]) => y),
  eval(io) {
    for (const [a, y] of INVERTERS) io.set(y, not(io.get(a)));
  },
};

/** The W65C02S: A0–A11 are pins 9–20 and A12–A15 pins 22–25; D0–D7 run down from pin 33. */
const CPU_ADDRESS = [9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 22, 23, 24, 25] as const;
const CPU_DATA = [33, 32, 31, 30, 29, 28, 27, 26] as const;

/** The 28-pin 32K × 8 chips (AT28C256 EEPROM and 62256 RAM) share a pinout: A0–A14, IO0–IO7, then CE, OE, WE. */
const MEMORY_ADDRESS = [10, 9, 8, 7, 6, 5, 4, 3, 25, 24, 21, 23, 2, 26, 1] as const;
const MEMORY_DATA = [11, 12, 13, 15, 16, 17, 18, 19] as const;
const MEMORY_CE = 20;
const MEMORY_OE = 22;
const MEMORY_WE = 27;
const MEMORY_BYTES = 32768;

/**
 * A 32K × 8 memory. It reads while CE and OE are low and WE is high. A write is on while CE and WE are both low
 * and ends when either goes high, and the byte that lands is whatever the address and data pins held just before
 * that, so a CPU is free to change the address or let go of the bus in the same instant.
 */
function memory32k(nonvolatile: boolean): ChipModel {
  const commit = (io: ChipIO, s: ChipState): void => {
    if (s.mem![s.addr] === s.latch) return;
    s.mem![s.addr] = s.latch;
    if (nonvolatile) io.wrote();
  };
  return {
    family: 'CMOS',
    vcc: 28,
    gnd: 14,
    inputs: [...MEMORY_ADDRESS, ...MEMORY_DATA, MEMORY_CE, MEMORY_OE, MEMORY_WE],
    outputs: MEMORY_DATA,
    ...(nonvolatile ? { nonvolatile: MEMORY_BYTES } : { init: () => ({ mem: randomMemory(MEMORY_BYTES, 0xff) }) }),
    eval(io, s) {
      const address = bits(io, MEMORY_ADDRESS);
      const selected = !io.get(MEMORY_CE);
      const writing = selected && !io.get(MEMORY_WE);
      if (writing) {
        // Moving to another address in the middle of a write finishes the one before it.
        if (s.q && s.addr !== address) commit(io, s);
        s.addr = address;
        s.latch = bits(io, MEMORY_DATA);
        s.q = 1;
      } else if (s.q) {
        commit(io, s);
        s.q = 0;
      }
      put(io, MEMORY_DATA, selected && !io.get(MEMORY_OE) && !writing && io.get(MEMORY_WE) ? s.mem![address] : null);
    },
  };
}

export const CHIP_MODELS: Readonly<Record<string, ChipModel>> = {
  '74LS00': quad((a, b) => not((a & b) as Bit), STANDARD_GATES),
  '74LS02': quad((a, b) => not((a | b) as Bit), NOR_GATES),
  '74LS08': quad((a, b) => (a & b) as Bit, STANDARD_GATES),
  '74LS32': quad((a, b) => (a | b) as Bit, STANDARD_GATES),
  '74LS86': quad((a, b) => (a ^ b) as Bit, STANDARD_GATES),

  '74LS10': triple((a, b, c) => not((a & b & c) as Bit), TRIPLE_GATES),
  '74LS11': triple((a, b, c) => (a & b & c) as Bit, TRIPLE_GATES),
  '74LS27': triple((a, b, c) => not((a | b | c) as Bit), TRIPLE_GATES),

  '74LS04': hexInverter,

  // Hex inverter with Schmitt-trigger inputs: switches up at about 1.6 V and down at about 0.8 V.
  '74LS14': { ...hexInverter, schmitt: { rise: 1.6, fall: 0.8 } },

  // Quad buffer: Y follows A while its enable is low, and lets go of the line while it is high.
  '74LS125': {
    family: 'LS',
    vcc: 14,
    gnd: 7,
    inputs: BUFFERS.flatMap(([g, a]) => [g, a]),
    outputs: BUFFERS.map(([, , y]) => y),
    eval(io) {
      for (const [g, a, y] of BUFFERS) io.set(y, io.get(g) ? null : io.get(a));
    },
  },

  // Dual D flip-flop, rising edge, with preset and clear (active low).
  '74LS74': {
    family: 'LS',
    vcc: 14,
    gnd: 7,
    inputs: [1, 2, 3, 4, 10, 11, 12, 13],
    outputs: [5, 6, 9, 8],
    eval(io, s) {
      flipFlops(
        io,
        s,
        [
          [3, 4, 1, 2, 0, 5, 6],
          [11, 10, 13, 12, 0, 9, 8],
        ],
        'rise',
      );
    },
  },

  // Dual JK flip-flop, falling edge, with preset and clear. VCC is pin 5 and GND pin 13 on this one.
  '74LS76': {
    family: 'LS',
    vcc: 5,
    gnd: 13,
    inputs: [1, 2, 3, 4, 16, 6, 7, 8, 9, 12],
    outputs: [15, 14, 11, 10],
    eval(io, s) {
      flipFlops(
        io,
        s,
        [
          [1, 2, 3, 4, 16, 15, 14],
          [6, 7, 8, 9, 12, 11, 10],
        ],
        'fall',
      );
    },
  },

  // Dual JK flip-flop, falling edge, with clear.
  '74LS107': {
    family: 'LS',
    vcc: 14,
    gnd: 7,
    inputs: [1, 4, 12, 13, 8, 11, 9, 10],
    outputs: [3, 2, 5, 6],
    eval(io, s) {
      flipFlops(
        io,
        s,
        [
          [12, 0, 13, 1, 4, 3, 2],
          [9, 0, 10, 8, 11, 5, 6],
        ],
        'fall',
      );
    },
  },

  // Dual 2-to-4 decoder: the selected output of each half goes low while its G is low.
  '74LS139': {
    family: 'LS',
    vcc: 16,
    gnd: 8,
    inputs: [1, 2, 3, 15, 14, 13],
    outputs: [4, 5, 6, 7, 12, 11, 10, 9],
    eval(io) {
      const halves = [
        [1, 2, 3, [4, 5, 6, 7]],
        [15, 14, 13, [12, 11, 10, 9]],
      ] as const;
      for (const [g, a, b, ys] of halves) {
        const selected = io.get(a) | (io.get(b) << 1);
        ys.forEach((y, i) => io.set(y, !io.get(g) && i === selected ? 0 : 1));
      }
    },
  },

  // 16 × 4 RAM: with ME low, WE low writes D1–D4 and WE high reads the word back inverted. Outputs let go otherwise.
  '74LS189': {
    family: 'LS',
    vcc: 16,
    gnd: 8,
    inputs: [1, 15, 14, 13, 2, 3, 4, 6, 10, 12],
    outputs: [5, 7, 9, 11],
    init: () => ({ mem: randomMemory(16, 15) }),
    eval(io, s) {
      const address = bits(io, [1, 15, 14, 13]);
      const selected = !io.get(2);
      const writing = !io.get(3);
      if (selected && writing) s.mem![address] = bits(io, [4, 6, 10, 12]);
      put(io, [5, 7, 9, 11], selected && !writing ? ~s.mem![address] & 15 : null);
    },
  },

  // 3-to-8 decoder: the selected output goes low while G1 is high and G2A, G2B are low.
  '74LS138': {
    family: 'LS',
    vcc: 16,
    gnd: 8,
    inputs: [1, 2, 3, 4, 5, 6],
    outputs: [15, 14, 13, 12, 11, 10, 9, 7],
    eval(io) {
      const enabled = io.get(6) && !io.get(4) && !io.get(5);
      const selected = bits(io, [1, 2, 3]);
      [15, 14, 13, 12, 11, 10, 9, 7].forEach((p, i) => io.set(p, enabled && i === selected ? 0 : 1));
    },
  },

  // Quad 2-to-1 mux: Y = A when S is low, B when S is high; G (active low) forces all Y low.
  '74LS157': {
    family: 'LS',
    vcc: 16,
    gnd: 8,
    inputs: [1, 2, 3, 5, 6, 10, 11, 13, 14, 15],
    outputs: [4, 7, 9, 12],
    eval(io) {
      const mux = [
        [2, 3, 4],
        [5, 6, 7],
        [11, 10, 9],
        [14, 13, 12],
      ] as const;
      for (const [a, b, y] of mux) io.set(y, io.get(15) ? 0 : io.get(1) ? io.get(b) : io.get(a));
    },
  },

  // 4-bit synchronous counter: async clear, synchronous load, counts when ENP and ENT are high.
  '74LS161': {
    family: 'LS',
    vcc: 16,
    gnd: 8,
    inputs: [1, 2, 3, 4, 5, 6, 7, 9, 10],
    outputs: [14, 13, 12, 11, 15],
    eval(io, s) {
      if (!io.get(1)) s.q = 0;
      else if (io.rose(2)) {
        if (!io.get(9)) s.q = bits(io, [3, 4, 5, 6]);
        else if (io.get(7) && io.get(10)) s.q = (s.q + 1) & 15;
      }
      put(io, [14, 13, 12, 11], s.q);
      io.set(15, io.get(10) && s.q === 15 ? 1 : 0);
    },
  },

  // Up/down counter: CLR (active high) and LOAD (active low) act at once, the count goes up on a rising edge
  // of UP while DOWN is high, and down on a rising edge of DOWN while UP is high. CO and BO (active low)
  // pulse low with the clock input at the top and bottom of the count, so they chain into the next stage's UP and DOWN.
  '74LS193': {
    family: 'LS',
    vcc: 16,
    gnd: 8,
    inputs: [15, 1, 10, 9, 5, 4, 11, 14],
    outputs: [3, 2, 6, 7, 12, 13],
    eval(io, s) {
      if (io.get(14)) s.q = 0;
      else if (!io.get(11)) s.q = bits(io, [15, 1, 10, 9]);
      else if (io.rose(5) && io.get(4)) s.q = (s.q + 1) & 15;
      else if (io.rose(4) && io.get(5)) s.q = (s.q + 15) & 15;
      put(io, [3, 2, 6, 7], s.q);
      io.set(12, s.q === 15 && !io.get(5) ? 0 : 1);
      io.set(13, s.q === 0 && !io.get(4) ? 0 : 1);
    },
  },

  // BCD to 7-segment decoder with open-collector, active-low outputs: a lit segment sinks current, an unlit one lets go.
  // BI/RBO (pin 4) low blanks everything; otherwise LT low lights everything; otherwise RBI low blanks a zero and pulls
  // RBO low to blank the next digit along. s.q remembers that the chip itself is holding pin 4 low.
  '74LS47': {
    family: 'LS',
    vcc: 16,
    gnd: 8,
    inputs: [7, 1, 2, 6, 3, 4, 5],
    outputs: [...SEGMENT_PINS_47, 4],
    eval(io, s) {
      const blanked = !io.get(4) && !s.q;
      const lampTest = !io.get(3);
      const rippleBlank = !lampTest && !io.get(5) && bits(io, [7, 1, 2, 6]) === 0;
      const lit = blanked ? 0 : lampTest ? 127 : rippleBlank ? 0 : SEGMENTS_47[bits(io, [7, 1, 2, 6])];
      SEGMENT_PINS_47.forEach((pin, i) => io.set(pin, (lit >> i) & 1 ? 0 : null));
      s.q = rippleBlank && !blanked ? 1 : 0;
      io.set(4, s.q ? 0 : null);
    },
  },

  // 4-bit register: loads on the clock edge when G1 and G2 are low; outputs only while M and N are low.
  '74LS173': {
    family: 'LS',
    vcc: 16,
    gnd: 8,
    inputs: [1, 2, 7, 9, 10, 11, 12, 13, 14, 15],
    outputs: [3, 4, 5, 6],
    eval(io, s) {
      if (io.get(15)) s.q = 0;
      else if (io.rose(7) && !io.get(9) && !io.get(10)) s.q = bits(io, [14, 13, 12, 11]);
      put(io, [3, 4, 5, 6], !io.get(1) && !io.get(2) ? s.q : null);
    },
  },

  // Bus transceiver: with OE low, copies A to B (DIR high) or B to A (DIR low).
  '74LS245': {
    family: 'LS',
    vcc: 20,
    gnd: 10,
    inputs: [1, 19, 2, 3, 4, 5, 6, 7, 8, 9, 18, 17, 16, 15, 14, 13, 12, 11],
    outputs: [2, 3, 4, 5, 6, 7, 8, 9, 18, 17, 16, 15, 14, 13, 12, 11],
    eval(io) {
      const A = [2, 3, 4, 5, 6, 7, 8, 9];
      const B = [18, 17, 16, 15, 14, 13, 12, 11];
      if (io.get(19)) {
        put(io, A, null);
        put(io, B, null);
      } else if (io.get(1)) {
        put(io, A, null);
        put(io, B, bits(io, A));
      } else {
        put(io, B, null);
        put(io, A, bits(io, B));
      }
    },
  },

  // Octal D flip-flop with async clear (active low).
  '74LS273': {
    family: 'LS',
    vcc: 20,
    gnd: 10,
    inputs: [1, 11, 3, 4, 7, 8, 13, 14, 17, 18],
    outputs: [2, 5, 6, 9, 12, 15, 16, 19],
    eval(io, s) {
      if (!io.get(1)) s.q = 0;
      else if (io.rose(11)) s.q = bits(io, [3, 4, 7, 8, 13, 14, 17, 18]);
      put(io, [2, 5, 6, 9, 12, 15, 16, 19], s.q);
    },
  },

  // 4-bit full adder.
  '74LS283': {
    family: 'LS',
    vcc: 16,
    gnd: 8,
    inputs: [5, 3, 14, 12, 6, 2, 15, 11, 7],
    outputs: [4, 1, 13, 10, 9],
    eval(io) {
      const sum = bits(io, [5, 3, 14, 12]) + bits(io, [6, 2, 15, 11]) + io.get(7);
      put(io, [4, 1, 13, 10, 9], sum);
    },
  },

  // Shift register with output latch: SER shifts in on SRCLK, RCLK copies to the outputs.
  '74HC595': {
    family: 'HC',
    vcc: 16,
    gnd: 8,
    inputs: [10, 11, 12, 13, 14],
    outputs: [15, 1, 2, 3, 4, 5, 6, 7, 9],
    eval(io, s) {
      if (io.rose(12)) s.latch = s.q;
      if (!io.get(10)) s.q = 0;
      else if (io.rose(11)) s.q = ((s.q << 1) | io.get(14)) & 0xff;
      put(io, [15, 1, 2, 3, 4, 5, 6, 7], io.get(13) ? null : s.latch);
      io.set(9, ((s.q >> 7) & 1) as Bit);
    },
  },

  // 2K × 8 EEPROM: reads while CE and OE are low; a WE pulse (with CE low) writes the data pins.
  '28C16': {
    family: 'CMOS',
    vcc: 24,
    gnd: 12,
    inputs: [8, 7, 6, 5, 4, 3, 2, 1, 23, 22, 19, 18, 20, 21, 9, 10, 11, 13, 14, 15, 16, 17],
    outputs: [9, 10, 11, 13, 14, 15, 16, 17],
    nonvolatile: 2048,
    eval(io, s) {
      const DATA = [9, 10, 11, 13, 14, 15, 16, 17];
      const address = bits(io, [8, 7, 6, 5, 4, 3, 2, 1, 23, 22, 19]);
      const ce = !io.get(18);
      const writing = !io.get(21);
      if (ce && io.rose(21)) {
        s.mem![s.addr] = bits(io, DATA);
        io.wrote();
      }
      if (ce && writing) s.addr = address;
      put(io, DATA, ce && !io.get(20) && !writing ? s.mem![address] : null);
    },
  },

  // 555 timer, from real pin voltages: TRIG below a third of VCC sets it, THR above two thirds resets it,
  // RESET low forces it off. DIS is open collector, pulling low whenever the output is low.
  NE555: {
    family: 'NE555',
    vcc: 8,
    gnd: 1,
    inputs: [2, 4, 5, 6],
    outputs: [3, 7],
    bias: [{ pin: 5, volts: (vcc) => (2 * vcc) / 3, g: 1 / 3333 }],
    thresholds(pin, io) {
      const upper = control555(io);
      return pin === 2 ? [upper / 2] : pin === 6 ? [upper] : pin === 4 ? [0.7] : [];
    },
    eval(io, s) {
      const upper = control555(io);
      if (io.volts(4) < 0.7) s.q = 0;
      else if (io.volts(2) < upper / 2) s.q = 1;
      else if (io.volts(6) > upper) s.q = 0;
      io.set(3, s.q ? 1 : 0);
      io.set(7, s.q ? null : 0);
    },
  },

  // The WDC W65C02S. PHI2 is its clock: a read samples the data bus as PHI2 falls, and the address for the next
  // cycle appears right after. A write drives the data bus while PHI2 is high. RESB low holds it in reset; IRQB is
  // a level, NMIB a falling edge, a falling SOB sets overflow, RDY low stops it at the next read, BE low lets go of
  // the buses. None of these inputs has a pull-up, so wire the ones you aren't using high.
  W65C02S: {
    family: 'C02',
    vcc: 8,
    gnd: 21,
    inputs: [2, 4, 6, 36, 37, 38, 40, ...CPU_DATA],
    outputs: [1, 3, 5, 7, 34, 39, ...CPU_ADDRESS, ...CPU_DATA],
    bus: { clock: 37, addr: CPU_ADDRESS, data: CPU_DATA, rw: 34, sync: 7 },
    init: () => ({ cpu: new Cpu65() }),
    eval(io, s) {
      const cpu = s.cpu!;
      cpu.resetLow = !io.get(40);
      cpu.irqLow = !io.get(4);
      if (io.fell(6)) cpu.nmiPending = true;
      if (io.fell(38)) cpu.p |= FLAG.V;
      if (io.fell(37) && (cpu.bus.write || io.get(2))) cpu.advance(bits(io, CPU_DATA));
      const bus = cpu.bus;
      const phi2 = io.get(37);
      const driving = io.get(36) === 1;
      put(io, CPU_ADDRESS, driving ? bus.addr : null);
      put(io, CPU_DATA, driving && bus.write && phi2 ? bus.data : null);
      io.set(34, driving ? (bus.write ? 0 : 1) : null);
      io.set(7, bus.sync ? 1 : 0);
      io.set(1, bus.vectorPull ? 0 : 1);
      io.set(5, bus.memoryLock ? 0 : 1);
      io.set(3, not(phi2));
      io.set(39, phi2);
    },
  },

  // 32K × 8 EEPROM. Keeps its contents with the power off.
  AT28C256: memory32k(true),

  // 32K × 8 static RAM. Wakes up holding whatever it likes.
  '62256': memory32k(false),
};
