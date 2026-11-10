import { describe, expect, it } from 'vitest';
import { type PartDoc } from '../src/engine/circuit';
import { dipPinHoles, PARTS, type DipDef } from '../src/engine/parts';
import {
  CHIP_MODELS,
  FAMILIES,
  type Bit,
  type ChipIO,
  type ChipModel,
  type ChipState,
  type Drive,
} from '../src/engine/sim/chips';
import { pinHole, sameStrip, railNear, Bench } from './helpers/bench';

describe('Logic chips', () => {
  /** A chip model on its own: set pins, and see what it drives. Inputs start high, like floating TTL ones. */
  class Pins implements ChipIO {
    readonly vcc = 5;
    readonly now = 0;
    readonly part = { id: 'u', def: '', pins: [] } as PartDoc;
    readonly model: ChipModel;
    readonly state: ChipState;
    private readonly levels = new Uint8Array(32).fill(1);
    /** What the circuit holds each pin at, apart from the chip's own pulling. */
    private readonly external = new Uint8Array(32).fill(1);
    private prev = new Uint8Array(32).fill(1);
    private readonly drives = new Map<number, Drive>();

    constructor(id: string) {
      this.model = CHIP_MODELS[id];
      this.state = { q: 0, latch: 0, addr: 0, ...this.model.init?.() };
      this.model.eval(this, this.state);
    }

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
    set(pin: number, value: Drive): void {
      this.drives.set(pin, value);
    }
    wrote(): void {}

    /** Change input pins, then let the chip react twice: once to see the edge, once to see its own pins settle. */
    apply(pins: Record<number, number>): this {
      this.prev = this.levels.slice();
      for (const [pin, v] of Object.entries(pins)) this.levels[Number(pin)] = this.external[Number(pin)] = v;
      this.model.eval(this, this.state);
      // A pin the chip both reads and drives (47's BI/RBO) follows the chip while it drives, the circuit otherwise.
      for (const pin of this.model.inputs) {
        if (!this.model.outputs.includes(pin)) continue;
        const d = this.drives.get(pin);
        this.levels[pin] = d === 0 || d === 1 ? d : this.external[pin];
      }
      this.prev = this.levels.slice();
      this.model.eval(this, this.state);
      return this;
    }
    out(pin: number): Drive {
      return this.drives.get(pin) ?? null;
    }
    outs(pins: readonly number[]): Drive[] {
      return pins.map((p) => this.out(p));
    }
  }

  const THREE_INPUT: [string, (ins: number[]) => number][] = [
    ['74LS10', (ins) => (ins.every(Boolean) ? 0 : 1)],
    ['74LS11', (ins) => (ins.every(Boolean) ? 1 : 0)],
    ['74LS27', (ins) => (ins.some(Boolean) ? 0 : 1)],
  ];
  it.each(THREE_INPUT)('%s works every gate through its whole truth table', (id, op) => {
    const chip = new Pins(id);
    for (const [a, b, c, y] of [
      [1, 2, 13, 12],
      [3, 4, 5, 6],
      [9, 10, 11, 8],
    ]) {
      for (let n = 0; n < 8; n++) {
        const ins = [n & 1, (n >> 1) & 1, (n >> 2) & 1];
        chip.apply({ [a]: ins[0], [b]: ins[1], [c]: ins[2] });
        expect(chip.out(y), `${id} output ${y} with inputs ${ins}`).toBe(op(ins));
      }
    }
  });

  it('inverts with a 74LS14, and floating inputs read high', () => {
    const chip = new Pins('74LS14');
    expect(chip.out(2)).toBe(0);
    expect(chip.apply({ 1: 0 }).out(2)).toBe(1);
    expect(CHIP_MODELS['74LS14'].schmitt).toEqual({ rise: 1.6, fall: 0.8 });
  });

  it('switches a 74LS14 up near 1.6 V and down near 0.8 V, holding in between', () => {
    // A 10 kΩ pot sweeps the input up and then back down; the output is read at every step.
    const pins = dipPinHoles(PARTS['74LS14'] as DipDef, 20, false).map((p) => `${p.row}${p.col + 1}`);
    const b = new Bench()
      .chip('u', '74LS14', 20)
      .part('pot', 'pot', ['c30', 'c31', 'c32'], { value: 10000, state: 1000 });
    b.toRail('a30', 'T+', 30).toRail('a32', 'T-', 32);
    b.wire('b31', sameStrip(pins[0]));
    const input = sameStrip(pins[0]);
    const out = sameStrip(pins[1]);
    const sweep = (from: number, to: number): { v: number; high: boolean }[] => {
      const seen: { v: number; high: boolean }[] = [];
      const step = from < to ? 5 : -5;
      for (let s = from; s !== to + step; s += step) {
        b.doc.parts.find((p) => p.id === 'pot')!.state = s;
        b.run();
        seen.push({ v: b.v(input), high: b.v(out) > 2 });
      }
      return seen;
    };
    // State 1000 puts the wiper at the − end, so raising the voltage means lowering the state.
    const up = sweep(1000, 0);
    expect(up[0].high).toBe(true);
    expect(up[up.length - 1].high).toBe(false);
    const rise = up.find((x) => !x.high)!.v;
    expect(rise).toBeGreaterThan(1.55);
    expect(rise).toBeLessThan(1.7);
    const down = sweep(0, 1000);
    const fall = down.find((x) => x.high)!.v;
    expect(fall).toBeGreaterThan(0.7);
    expect(fall).toBeLessThan(0.85);
    // Between the two, the output depends on which way the input got there.
    expect(up.find((x) => Math.abs(x.v - 1.2) < 0.1)!.high).toBe(true);
    expect(down.find((x) => Math.abs(x.v - 1.2) < 0.1)!.high).toBe(false);
  });

  it('runs a 74LS14 RC oscillator at the period its thresholds predict', () => {
    // Output through R to the input, C from the input to ground.
    const pins = dipPinHoles(PARTS['74LS14'] as DipDef, 20, false).map((p) => `${p.row}${p.col + 1}`);
    const R = 470;
    const C = 1e-6;
    const b = new Bench().chip('u', '74LS14', 20);
    b.part('r', 'resistor', [`h${pins[0].slice(1)}`, `h${pins[1].slice(1)}`], { value: R });
    b.part('c', 'cap-ceramic', [`i${pins[0].slice(1)}`, railNear('B-', 50)], { value: C });
    const out = sameStrip(pins[1]);
    b.run();
    const edges: number[] = [];
    let was = b.v(out) > 2;
    for (let t = 0; t < 0.02; t += 1e-5) {
      b.sim.advance(1e-5);
      const now = b.v(out) > 2;
      if (now && !was) edges.push(b.sim.time);
      was = now;
    }
    expect(edges.length).toBeGreaterThan(10);
    const measured = (edges[edges.length - 1] - edges[1]) / (edges.length - 2);

    // What the capacitor sees: the output through R, in parallel with the input's pull to 1.6 V.
    const ls = FAMILIES.LS;
    const source = (vout: number, rout: number): { v: number; r: number } => {
      const g1 = 1 / (R + rout);
      const g2 = ls.input!.g;
      return { v: (vout * g1 + ls.input!.volts * g2) / (g1 + g2), r: 1 / (g1 + g2) };
    };
    const high = source(ls.voh(5), ls.roh);
    const low = source(ls.vol, ls.rol);
    const charge = high.r * C * Math.log((high.v - 0.8) / (high.v - 1.6));
    const discharge = low.r * C * Math.log((1.6 - low.v) / (0.8 - low.v));
    expect(measured).toBeGreaterThan((charge + discharge) * 0.95);
    expect(measured).toBeLessThan((charge + discharge) * 1.05);
  });

  it('lets a 74LS125 drive its output only while its enable is low', () => {
    const chip = new Pins('74LS125');
    // The enables float high, so every output lets go.
    expect(chip.outs([3, 6, 8, 11])).toEqual([null, null, null, null]);
    chip.apply({ 1: 0, 2: 1 });
    expect(chip.out(3)).toBe(1);
    chip.apply({ 2: 0 });
    expect(chip.out(3)).toBe(0);
    chip.apply({ 1: 1 });
    expect(chip.out(3)).toBeNull();
    // The other buffers are independent: 3G is pin 10, 3A pin 9, 3Y pin 8.
    chip.apply({ 10: 0, 9: 0 });
    expect(chip.outs([3, 8])).toEqual([null, 0]);
    chip.apply({ 4: 0, 5: 1, 13: 0, 12: 0 });
    expect(chip.outs([6, 11])).toEqual([1, 0]);
  });

  it('shares one line between two 74LS125s, and only the enabled one drives it', () => {
    const b = new Bench().chip('u1', '74LS125', 20).chip('u2', '74LS125', 40);
    const strip = (start: number, pin: number): string => sameStrip(pinHole('74LS125', start, pin));
    b.wire(strip(20, 3), strip(40, 3));
    b.toRail(strip(20, 2), 'T+', 20).toRail(strip(40, 2), 'T-', 40);
    // u1 enabled, u2's enable left floating high: the line follows u1's high input.
    b.toRail(strip(20, 1), 'T-', 24);
    const r = b.run();
    expect(b.v(strip(20, 3))).toBeGreaterThan(3);
    expect(r.problems).toEqual([]);
    // Hand the line to u2, which holds it low.
    b.doc.wires.splice(
      b.doc.wires.findIndex((w) => w.a.hole === strip(20, 1)),
      1,
    );
    b.toRail(strip(20, 1), 'T+', 26).toRail(strip(40, 1), 'T-', 44);
    expect(b.run().problems).toEqual([]);
    expect(b.v(strip(20, 3))).toBeLessThan(0.5);
  });

  describe('74LS47', () => {
    const A = 7,
      B = 1,
      C = 2,
      D = 6,
      LT = 3,
      BI = 4,
      RBI = 5;
    const SEG = [13, 12, 11, 10, 9, 15, 14];
    const digit = (n: number) => ({ [A]: n & 1, [B]: (n >> 1) & 1, [C]: (n >> 2) & 1, [D]: (n >> 3) & 1 });
    /** The segments lit, as letters. An unlit output is open: a 74LS47 never drives one high. */
    const lit = (chip: Pins): string =>
      SEG.map((pin, i) => {
        const v = chip.out(pin);
        expect(v === 0 || v === null).toBe(true);
        return v === 0 ? 'abcdefg'[i] : '';
      }).join('');

    it('draws the decimal digits, a lit segment sinking current', () => {
      const chip = new Pins('74LS47');
      const expected = ['abcdef', 'bc', 'abdeg', 'abcdg', 'bcfg', 'acdfg', 'acdefg', 'abc', 'abcdefg', 'abcdfg'];
      expected.forEach((segments, n) => expect(lit(chip.apply(digit(n))), `digit ${n}`).toBe(segments));
    });

    it('shows its odd shapes for 10–15 and blanks 15', () => {
      const chip = new Pins('74LS47');
      expect([10, 11, 12, 13, 14, 15].map((n) => lit(chip.apply(digit(n))))).toEqual([
        'deg',
        'cdg',
        'bfg',
        'adfg',
        'defg',
        '',
      ]);
    });

    it('lights every segment on lamp test, and BI blanks over it', () => {
      const chip = new Pins('74LS47');
      expect(lit(chip.apply({ ...digit(3), [LT]: 0 }))).toBe('abcdefg');
      expect(lit(chip.apply({ [BI]: 0 }))).toBe('');
      expect(lit(chip.apply({ [BI]: 1, [LT]: 1 }))).toBe('abcdg');
    });

    it('blanks a leading zero on RBI and passes the blanking on through RBO', () => {
      const chip = new Pins('74LS47');
      expect(chip.apply(digit(0)).out(BI)).toBeNull();
      expect(lit(chip)).toBe('abcdef');
      expect(lit(chip.apply({ [RBI]: 0 }))).toBe('');
      expect(chip.out(BI)).toBe(0);
      // A non-zero digit still shows, and RBO lets go again rather than blanking the chip for good.
      expect(lit(chip.apply(digit(5)))).toBe('acdfg');
      expect(chip.out(BI)).toBeNull();
      expect(lit(chip.apply(digit(0)))).toBe('');
      // Lamp test beats ripple blanking.
      expect(lit(chip.apply({ [LT]: 0 }))).toBe('abcdefg');
      expect(chip.out(BI)).toBeNull();
    });

    it('sinks the lit segments on a real board and leaves the others open', () => {
      // Digit 1: B, C, D grounded, A left floating high. Segments b and c sink, a is open.
      const b = new Bench().chip('u', '74LS47', 20);
      const strip = (pin: number): string => sameStrip(pinHole('74LS47', 20, pin));
      [B, C, D].forEach((pin, i) => b.toRail(strip(pin), 'B-', 22 + i * 2));
      b.part('rb', 'resistor', [strip(12), railNear('T+', 36)], { value: 330 });
      b.part('ra', 'resistor', [strip(13), railNear('T+', 40)], { value: 330 });
      b.run();
      expect(b.v(strip(12))).toBeLessThan(0.7);
      // Segment a is open collector: the resistor pulls it all the way up, a TTL output could only reach 3.6 V.
      expect(b.v(strip(13))).toBeGreaterThan(4.9);
    });

    it('holds BI/RBO low on a real board when it blanks a leading zero', () => {
      const b = new Bench().chip('u', '74LS47', 20);
      const strip = (pin: number): string => sameStrip(pinHole('74LS47', 20, pin));
      [A, B, C, D, RBI].forEach((pin, i) => b.toRail(strip(pin), 'B-', 22 + i * 2));
      b.part('ra', 'resistor', [strip(13), railNear('T+', 40)], { value: 330 });
      b.run();
      expect(b.v(strip(BI))).toBeLessThan(0.5);
      expect(b.v(strip(13))).toBeGreaterThan(4.9);
      // Digit 1 instead: RBI no longer matters and RBO is released.
      b.doc.wires.splice(
        b.doc.wires.findIndex((w) => w.a.hole === strip(A)),
        1,
      );
      b.run();
      expect(b.v(strip(BI))).toBeGreaterThan(1.5);
      expect(b.v(strip(13))).toBeGreaterThan(4.9);
    });
  });

  describe('74LS193', () => {
    const A = 15,
      B = 1,
      C = 10,
      D = 9,
      UP = 5,
      DOWN = 4,
      LOAD = 11,
      CLR = 14,
      CO = 12,
      BO = 13;
    const Q = [3, 2, 6, 7];
    const count = (chip: Pins): number => Q.reduce((acc, pin, i) => acc | ((chip.out(pin) as number) << i), 0);
    /** One clock pulse on a count input: low, then back high. */
    const pulse = (chip: Pins, pin: number): void => {
      chip.apply({ [pin]: 0 });
      chip.apply({ [pin]: 1 });
    };
    const fresh = (): Pins => new Pins('74LS193').apply({ [CLR]: 1 }).apply({ [CLR]: 0 });

    it('clears, then counts up and wraps', () => {
      const chip = fresh();
      expect(count(chip)).toBe(0);
      for (let n = 1; n <= 17; n++) {
        pulse(chip, UP);
        expect(count(chip)).toBe(n & 15);
      }
    });

    it('counts down and wraps below zero', () => {
      const chip = fresh();
      pulse(chip, DOWN);
      expect(count(chip)).toBe(15);
      pulse(chip, DOWN);
      expect(count(chip)).toBe(14);
    });

    it('ignores a count input while the other is held low', () => {
      const chip = fresh();
      chip.apply({ [DOWN]: 0 });
      pulse(chip, UP);
      expect(count(chip)).toBe(0);
      chip.apply({ [UP]: 0 });
      chip.apply({ [DOWN]: 1 });
      pulse(chip, DOWN);
      expect(count(chip)).toBe(0);
    });

    it('loads while LOAD is low, whatever the clock does, and CLR beats it', () => {
      const chip = fresh();
      chip.apply({ [A]: 1, [B]: 0, [C]: 1, [D]: 0, [LOAD]: 0 });
      expect(count(chip)).toBe(5);
      pulse(chip, UP);
      expect(count(chip)).toBe(5);
      chip.apply({ [LOAD]: 1 });
      pulse(chip, UP);
      expect(count(chip)).toBe(6);
      chip.apply({ [LOAD]: 0, [CLR]: 1 });
      expect(count(chip)).toBe(0);
    });

    it('drops CO at 15 and BO at 0 while that clock input is low', () => {
      const chip = fresh();
      expect(chip.outs([CO, BO])).toEqual([1, 1]);
      chip.apply({ [DOWN]: 0 });
      expect(chip.out(BO)).toBe(0);
      chip.apply({ [DOWN]: 1 });
      expect(chip.out(BO)).toBe(1);
      chip.apply({ [A]: 1, [B]: 1, [C]: 1, [D]: 1, [LOAD]: 0 }).apply({ [LOAD]: 1 });
      expect(count(chip)).toBe(15);
      expect(chip.out(CO)).toBe(1);
      chip.apply({ [UP]: 0 });
      expect(chip.out(CO)).toBe(0);
      // The rise that wraps it to 0 also ends the carry: that is what clocks the next stage.
      chip.apply({ [UP]: 1 });
      expect(count(chip)).toBe(0);
      expect(chip.out(CO)).toBe(1);
    });
  });
});
