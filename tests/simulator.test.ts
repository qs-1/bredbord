import { describe, expect, it } from 'vitest';
import { blinkerDoc, counterDoc, exampleDoc, registerDoc } from '../src/app/example';
import { createDoc } from '../src/engine/circuit';
import { Connectivity } from '../src/engine/netlist';
import {
  dipFootprint,
  dipPinHoles,
  LED_VF,
  PARTS,
  powerSideVolts,
  powerText,
  withPowerJumper,
} from '../src/engine/parts';
import { decodeBytes, encodeBytes, Simulator } from '../src/engine/sim/simulator';
import {
  addSample,
  autoLevel,
  extremes,
  findTrigger,
  measure,
  readingsBetween,
  valueAt,
  type Samples,
} from '../src/engine/scope';
import { h, rail, pinHole, sameStrip, railNear, Bench } from './helpers/bench';

describe('Simulator', () => {
  /** LED from + through a 470 Ω resistor to −, built the way you would on a board. */
  const ledBench = (power: boolean) =>
    new Bench(power)
      .wire(rail('T+', 9), 'b10')
      .part('led', 'led-red', ['a10', 'a11'])
      .part('r', 'resistor', ['b11', 'b14'], { value: 470 })
      .wire('a14', rail('T-', 14));

  it('lights an LED with a resistor across the rails', () => {
    const r = ledBench(true).run();
    const led = r.leds.get('led')!;
    expect(r.live).toBe(true);
    expect(led.current * 1000).toBeCloseTo(((5 - LED_VF.red) / 482) * 1000, 1);
    expect(led.brightness).toBeGreaterThan(0.5);
    expect(r.volts(h('c10'))).toBeCloseTo(5);
  });

  it('puts a red LED where ngspice does', () => {
    // ngspice, common red LED model, 220 Ω from 5 V: 14.5 mA at 1.82 V.
    const r = new Bench()
      .wire(rail('T+', 9), 'b10')
      .part('led', 'led-red', ['a10', 'a11'])
      .part('r', 'resistor', ['b11', 'b14'], { value: 220 })
      .wire('a14', rail('T-', 14))
      .run();
    const ma = r.leds.get('led')!.current * 1000;
    expect(Math.abs(ma - 14.5) / 14.5).toBeLessThan(0.02);
    expect(r.volts(h('c10'))! - r.volts(h('c11'))!).toBeCloseTo(1.82, 1);
  });

  it('leaves everything dark with the power off', () => {
    const r = ledBench(false).run();
    expect(r.live).toBe(false);
    expect(r.leds.get('led')?.current ?? 0).toBe(0);
  });

  it('warns about an LED with no resistor', () => {
    const r = new Bench()
      .wire(rail('T+', 9), 'b10')
      .part('led', 'led-red', ['a10', 'a11'])
      .wire('b11', rail('T-', 10))
      .run();
    expect(r.leds.get('led')!.overCurrent).toBe(true);
    expect(r.problems.some((p) => p.partId === 'led' && /Too much/.test(p.message))).toBe(true);
  });

  describe('power module jumpers', () => {
    /** The module on, with the top and bottom jumpers at these positions (0 5 V, 1 off, 2 3.3 V). */
    const jumpers = (b: Bench, top: number, bottom: number): Bench => {
      b.doc.parts[0].state = withPowerJumper(withPowerJumper(1, 0, top), 1, bottom);
      return b;
    };

    it('starts at 5 V on both sides', () => {
      expect([powerSideVolts(1, 0), powerSideVolts(1, 1)]).toEqual([5, 5]);
      expect(powerText(1)).toBe('5 V');
    });

    it('feeds each side what its jumper picks', () => {
      const r = jumpers(new Bench(), 2, 0).run();
      expect(r.volts(h(rail('T+', 30)))).toBeCloseTo(3.3);
      expect(r.volts(h(rail('B+', 30)))).toBeCloseTo(5);
      expect(r.volts(h(rail('T-', 30)))).toBeCloseTo(0);
    });

    it("leaves a side's + rail unpowered when its jumper is off, ground still connected", () => {
      const b = jumpers(ledBench(true), 1, 0);
      const r = b.run();
      expect(r.leds.get('led')?.current ?? 0).toBe(0);
      // The same LED from the bottom side still lights, its − on the top ground rail.
      const lit = jumpers(new Bench(), 1, 0)
        .wire(rail('B+', 9), 'b10')
        .part('led', 'led-red', ['a10', 'a11'])
        .part('r', 'resistor', ['b11', 'b14'], { value: 470 })
        .wire('a14', rail('T-', 14))
        .run();
      expect(lit.leds.get('led')!.brightness).toBeGreaterThan(0.3);
    });

    it('cuts the power when the 5 V side is joined to the 3.3 V side', () => {
      const r = jumpers(new Bench(), 0, 2).wire(rail('T+', 20), rail('B+', 20)).run();
      expect(r.live).toBe(false);
      expect(r.problems[0].message).toMatch(/3\.3 V side/);
    });

    it('lets two sides at the same voltage be joined', () => {
      const r = jumpers(new Bench(), 2, 2).wire(rail('T+', 20), rail('B+', 20)).run();
      expect(r.live).toBe(true);
    });

    it('describes mixed settings', () => {
      expect(powerText(withPowerJumper(1, 1, 2))).toBe('Top 5 V, bottom 3.3 V');
      expect(powerText(withPowerJumper(withPowerJumper(1, 0, 1), 1, 1))).toBe('Both sides off');
    });
  });

  it('cuts the power on a short circuit', () => {
    const r = new Bench().wire(rail('T+', 20), rail('T-', 20)).run();
    expect(r.live).toBe(false);
    expect(r.problems[0].message).toMatch(/Short circuit/);
  });

  it('runs a NAND gate, with floating TTL inputs reading high', () => {
    const b = new Bench().chip('nand', '74LS00', 20);
    const out = sameStrip(pinHole('74LS00', 20, 3));
    b.run();
    expect(b.v(out)).toBeLessThan(0.5);
    // Ground input 1A: the output goes high.
    b.wire(sameStrip(pinHole('74LS00', 20, 1)), rail('B-', 30));
    b.run();
    expect(b.v(out)).toBeGreaterThan(3);
    expect(b.v(out)).toBeLessThan(4);
  });

  it('complains about a chip with no power while the circuit is live', () => {
    const r = new Bench().chip('nand', '74LS00', 20, false).run();
    expect(r.chips.get('nand')!.powered).toBe(false);
    expect(r.chips.get('nand')!.problems[0]).toMatch(/No power/);
  });

  it('counts button presses on a 74LS161', () => {
    // CLK floats high; the button pulls it to ground while pressed, so releasing it is a rising edge.
    const clk = pinHole('74LS161', 20, 2);
    const b = new Bench()
      .chip('ctr', '74LS161', 20)
      .part('btn', 'button', [`i${clk.slice(1)}`, `j${clk.slice(1)}`, 'i40', 'j40'])
      .wire('h40', rail('B-', 39));
    const count = (): number =>
      [14, 13, 12, 11].reduce(
        (acc, pin, i) => acc | ((b.v(sameStrip(pinHole('74LS161', 20, pin))) > 2 ? 1 : 0) << i),
        0,
      );

    b.run();
    expect(count()).toBe(0);
    for (let n = 1; n <= 5; n++) {
      b.run(['btn']);
      b.run();
      expect(count()).toBe(n);
    }
  });

  it('adds numbers set on a DIP switch with a 74LS283', () => {
    // Switch on = input pulled low. A = 5 (0101), B = 3 (0011), so switches set the zero bits.
    const A = [5, 3, 14, 12];
    const B = [6, 2, 15, 11];
    const ones = [1, 0, 1, 0, 1, 1, 0, 0];
    const sw = [...A, ...B].map((pin) => sameStrip(pinHole('74LS283', 20, pin)));
    const ground = sw.map((_, i) => `B-${i + 1}`);
    const state = ones.reduce((acc, bit, k) => acc | ((bit ? 0 : 1) << k), 0);
    const b = new Bench()
      .chip('add', '74LS283', 20)
      .part('sw', 'dip-switch-8', [...sw, ...ground.reverse()], { state });
    // C0 (pin 7) must be low for a plain add.
    b.wire(sameStrip(pinHole('74LS283', 20, 7)), rail('B-', 14));
    b.run();
    const S = [4, 1, 13, 10, 9].map((pin) => (b.v(sameStrip(pinHole('74LS283', 20, pin))) > 2 ? 1 : 0));
    expect(S.reduce<number>((acc, bit, i) => acc | (bit << i), 0)).toBe(8);
  });

  it('notices two outputs fighting', () => {
    // Gate 1 output (high: inputs grounded) wired to gate 2 output (low: inputs floating).
    const b = new Bench().chip('nand', '74LS00', 20);
    b.wire(sameStrip(pinHole('74LS00', 20, 1)), rail('B-', 30));
    b.wire(sameStrip(pinHole('74LS00', 20, 3)), 'j40').wire('i40', sameStrip(pinHole('74LS00', 20, 6)));
    const r = b.run();
    expect(r.problems.some((p) => /fighting/.test(p.message))).toBe(true);
  });

  it('runs the built-in example: press either button and the LED lights', () => {
    const doc = exampleDoc();
    const sim = new Simulator();
    const conn = new Connectivity(doc);
    const led = doc.parts.find((p) => p.def === 'led-red')!.id;
    const [a, b] = doc.parts.filter((p) => p.def === 'button').map((p) => p.id);

    expect(sim.run(doc, conn).leds.get(led)?.current ?? 0).toBe(0);
    doc.parts.find((p) => p.def === 'power')!.state = 1;
    const idle = sim.run(doc, conn);
    expect(idle.problems).toEqual([]);
    expect(idle.leds.get(led)!.current).toBe(0);
    for (const button of [a, b]) {
      const lit = sim.run(doc, conn, new Set([button])).leds.get(led)!;
      expect(lit.current * 1000).toBeGreaterThan(4);
      expect(lit.overCurrent).toBe(false);
    }
  });

  it('forgets chip state when the power goes off', () => {
    const clk = pinHole('74LS161', 20, 2);
    const b = new Bench()
      .chip('ctr', '74LS161', 20)
      .part('btn', 'button', [`i${clk.slice(1)}`, `j${clk.slice(1)}`, 'i40', 'j40'])
      .wire('h40', rail('B-', 39));
    b.run();
    b.run(['btn']);
    b.run();
    const qa = sameStrip(pinHole('74LS161', 20, 14));
    expect(b.v(qa)).toBeGreaterThan(2);
    b.doc.parts[0].state = 0;
    b.run();
    b.doc.parts[0].state = 1;
    b.run();
    expect(b.v(qa)).toBeLessThan(1);
  });
});

describe('Time', () => {
  /**
   * A 555 astable on columns 20–23: R1 from VCC to DIS, R2 from DIS to THR, TRIG tied to THR, the
   * timing capacitor from THR to ground, RESET to +.
   */
  const astable = (r1: number, r2: number, c: number): Bench => {
    const b = new Bench().chip('t', 'NE555', 20);
    const strip = (pin: number): string => pinHole('NE555', 20, pin);
    b.toRail(sameStrip(strip(4)), 'B+', 20); // RESET
    b.part('r1', 'resistor', [`b${strip(8).slice(1)}`, `b${strip(7).slice(1)}`], { value: r1 });
    b.part('r2', 'resistor', [`c${strip(7).slice(1)}`, `c${strip(6).slice(1)}`], { value: r2 });
    b.wire(`h${strip(2).slice(1)}`, `d${strip(6).slice(1)}`); // TRIG to THR
    b.part('c', 'cap-electrolytic', [`a${strip(6).slice(1)}`, railNear('T-', 23)], { value: c });
    return b;
  };
  const out555 = `j${pinHole('NE555', 20, 3).slice(1)}`;

  /** Times of the output's rising edges over `seconds`, sampled every `dt`. */
  const risingEdges = (b: Bench, seconds: number, dt: number): number[] => {
    const edges: number[] = [];
    let was = b.v(out555) > 2;
    for (let t = 0; t < seconds; t += dt) {
      b.sim.advance(dt);
      const now = b.v(out555) > 2;
      if (now && !was) edges.push(b.sim.time);
      was = now;
    }
    return edges;
  };

  it('runs a 555 astable at the textbook frequency', () => {
    // R1 1 kΩ, R2 10 kΩ, 10 µF: high for 0.693·(R1 + R2)·C, low for about 0.7·R2·C.
    const b = astable(1000, 10000, 10e-6);
    b.run();
    expect(b.v(out555)).toBeGreaterThan(3);
    const edges = risingEdges(b, 1.2, 0.0005);
    const period = (edges[5] - edges[1]) / 4;
    const high = Math.log(2) * 11000 * 10e-6;
    const low = Math.log((10 / 3 - 0.1) / (5 / 3 - 0.1)) * 10000 * 10e-6;
    expect(period).toBeGreaterThan((high + low) * 0.97);
    expect(period).toBeLessThan((high + low) * 1.03);
  });

  it('stops right on the edge a breakpoint watches, and steps from one change to the next', () => {
    const b = astable(1000, 10000, 10e-6);
    b.run();
    const net = b.sim.netOf(h(out555));
    // Run until the output goes high, as the probes panel's breakpoints do.
    let was = b.sim.netVolts(net) > 2;
    let rose = false;
    b.sim.watcher = () => {
      const now = b.sim.netVolts(net) > 2;
      if (now && !was) rose = true;
      was = now;
    };
    let covered = b.sim.advance(1, { stop: () => rose });
    if (!rose) {
      rose = false;
      covered = b.sim.advance(1, { stop: () => rose });
    }
    expect(rose).toBe(true);
    expect(covered).toBeLessThan(1);
    expect(b.sim.netVolts(net)).toBeGreaterThan(2);
    // A step lands on the next thing due, which is later; with the cap charging there always is one.
    const t = b.sim.time;
    const next = b.sim.nextEventTime;
    b.sim.watcher = null;
    b.sim.stepToNext(0.001);
    expect(b.sim.time).toBeGreaterThan(t);
    expect(b.sim.time).toBeLessThanOrEqual(next + 1e-9);
  });

  it("records a 555's timing capacitor for the scope as the curve it really is", () => {
    // The scope reads its inputs at every event and, with `between`, along the way in between;
    // a reference run read every 20 µs (the engine is exact at any moment) must match it.
    const thr = `d${pinHole('NE555', 20, 6).slice(1)}`;
    const b = astable(1000, 10000, 1e-6);
    b.run();
    const net = b.sim.netOf(h(thr));
    const trace: Samples = { t: [], v: [] };
    b.sim.watcher = () => addSample(trace, b.sim.time, b.sim.netVolts(net));
    b.sim.between = (from, to) => {
      for (const t of [...readingsBetween(from, to, b.sim.netRate(net)), to])
        addSample(trace, t, b.sim.netVoltsAt(net, t));
    };
    b.sim.advance(0.1);

    const ref = astable(1000, 10000, 1e-6);
    ref.run();
    const refNet = ref.sim.netOf(h(thr));
    let worst = 0;
    for (let t = 0; t < 0.1; t += 20e-6) {
      ref.sim.advance(20e-6);
      if (ref.sim.time < 0.05) continue;
      worst = Math.max(worst, Math.abs(valueAt(trace, ref.sim.time) - ref.sim.netVolts(refNet)));
    }
    expect(worst).toBeLessThan(0.03);
    // It swings between a third and two thirds of the supply, as a 555's timing capacitor does.
    const { min, max } = extremes(trace, 0.05, 0.1);
    expect(min).toBeCloseTo(5 / 3, 1);
    expect(max).toBeCloseTo(10 / 3, 1);
    // A few hundred points a cycle at most, not thousands.
    expect(trace.t.length).toBeLessThan(150 * 70);
  });

  it('measures a 555 on the scope at its textbook frequency and locks the picture onto it', () => {
    const b = astable(1000, 10000, 1e-6);
    b.run();
    const net = b.sim.netOf(h(out555));
    const trace: Samples = { t: [], v: [] };
    b.sim.watcher = () => addSample(trace, b.sim.time, b.sim.netVolts(net));
    b.sim.between = (_from, to) => addSample(trace, to, b.sim.netVoltsAt(net, to));
    b.sim.advance(0.2);
    const high = Math.log(2) * 11000 * 1e-6;
    const low = Math.log((10 / 3 - 0.1) / (5 / 3 - 0.1)) * 10000 * 1e-6;
    const m = measure(trace, 0.1, 0.2)!;
    expect(m.period).toBeGreaterThan((high + low) * 0.97);
    expect(m.period).toBeLessThan((high + low) * 1.03);
    expect(m.duty).toBeCloseTo(high / (high + low), 1);
    expect(m.max).toBeGreaterThan(3);
    // Triggered at the middle of its swing, the picture starts each cycle in the same place.
    const level = autoLevel(trace, 0.2, 0.05);
    const ends = [0.17, 0.18, 0.19, 0.2].map((now) => findTrigger(trace, now, 0.05, 'rise', level)!);
    const phase = ends.map((end) => valueAt(trace, end - 0.025 + 0.0005));
    for (const p of phase) expect(p).toBeGreaterThan(3);
  });

  it('keeps the capacitor charged through an edit while it runs', () => {
    const b = astable(1000, 10000, 10e-6);
    b.run();
    b.sim.advance(0.04);
    const before = b.sim.snapshot().capacitors.get('c')!;
    expect(before).toBeGreaterThan(1);
    b.wire('a50', 'a55');
    b.run();
    expect(b.sim.snapshot().capacitors.get('c')!).toBeCloseTo(before, 6);
  });

  it('blinks an LED fast enough that it looks dimmer on average', () => {
    // About 1 kHz: far too fast to see, so each frame shows it part-lit.
    const b = astable(1000, 1000, 0.47e-6);
    b.part('led', 'led-red', [`i${pinHole('NE555', 20, 3).slice(1)}`, 'i30']).part('r', 'resistor', ['h30', 'h34'], {
      value: 220,
    });
    b.toRail('j34', 'B-', 34);
    b.run();
    const peak = b.sim.snapshot().leds.get('led')!.current;
    expect(peak).toBeGreaterThan(0.005);
    for (let i = 0; i < 6; i++) {
      b.sim.advance(1 / 60);
      b.sim.frame();
    }
    const avg = b.sim.snapshot().leds.get('led')!.current;
    // High two thirds of the time (R1 + R2 against R2).
    expect(avg / peak).toBeGreaterThan(0.55);
    expect(avg / peak).toBeLessThan(0.8);
  });

  it('times a monostable pulse from a button press', () => {
    // Ben's debounce: TRIG pulled up, a button to ground, THR and DIS together, 100 kΩ and 1 µF.
    const b = new Bench().chip('t', 'NE555', 20);
    const col = (pin: number): string => pinHole('NE555', 20, pin).slice(1);
    b.toRail(`j${col(4)}`, 'B+', 20);
    b.part('pull', 'resistor', [`i${col(2)}`, railNear('B+', 22)], { value: 10000 });
    b.part('btn', 'button', [`h${col(2)}`, `g${col(2)}`, 'h40', 'g40']).toRail('j40', 'B-', 40);
    b.wire(`d${col(7)}`, `d${col(6)}`);
    b.part('r', 'resistor', [`b${col(8)}`, `b${col(6)}`], { value: 100000 });
    b.part('c', 'cap-electrolytic', [`a${col(6)}`, railNear('T-', 23)], { value: 1e-6 });
    const out = `j${col(3)}`;
    b.run();
    b.sim.advance(0.05);
    expect(b.v(out)).toBeLessThan(1);
    b.run(['btn']);
    b.run();
    const start = b.sim.time;
    expect(b.v(out)).toBeGreaterThan(3);
    let end = 0;
    for (let i = 0; i < 400 && !end; i++) {
      b.sim.advance(0.0005);
      if (b.v(out) < 1) end = b.sim.time;
    }
    expect(end - start).toBeGreaterThan(0.1 * Math.log(3) * 0.98);
    expect(end - start).toBeLessThan(0.1 * Math.log(3) * 1.02 + 0.001);
  });

  it('keeps up with a fast clock without doing much work', () => {
    const b = astable(1000, 1000, 0.47e-6);
    b.run();
    const start = performance.now();
    b.sim.advance(1);
    expect(performance.now() - start).toBeLessThan(400);
  });

  it('runs the 555 clock example at about 1.4 Hz, faster with the knob turned down', () => {
    const doc = blinkerDoc();
    doc.parts.find((p) => p.def === 'power')!.state = 1;
    const sim = new Simulator();
    const out = (): boolean => (sim.snapshot().volts(h('j22')) ?? 0) > 2;
    const period = (): number => {
      sim.update(doc, new Connectivity(doc));
      const edges: number[] = [];
      let was = out();
      for (let i = 0; i < 8000 && edges.length < 3; i++) {
        sim.advance(0.001);
        const now = out();
        if (now && !was) edges.push(sim.time);
        was = now;
      }
      return edges[2] - edges[1];
    };
    expect(sim.run(doc, new Connectivity(doc)).problems).toEqual([]);
    expect(1 / period()).toBeCloseTo(1.4, 1);
    doc.parts.find((p) => p.def === 'pot')!.state = 100;
    expect(1 / period()).toBeGreaterThan(5);
  });

  it('counts on the 4-bit counter example', () => {
    const doc = counterDoc();
    doc.parts.find((p) => p.def === 'power')!.state = 1;
    const sim = new Simulator();
    expect(sim.run(doc, new Connectivity(doc)).problems).toEqual([]);
    const count = (): number =>
      [33, 34, 35, 36].reduce((acc, col, k) => acc | (((sim.snapshot().volts(h(`a${col}`)) ?? 0) > 1 ? 1 : 0) << k), 0);
    const seen: number[] = [];
    for (let i = 0; i < 12; i++) {
      sim.advance(0.33);
      seen.push(count());
    }
    // About 1.5 Hz: it should have counted to about 6 by now, one step at a time.
    expect(seen[seen.length - 1]).toBeGreaterThanOrEqual(5);
    expect(seen.every((n, i) => i === 0 || n - seen[i - 1] <= 1)).toBe(true);
    const lit = sim.snapshot().leds;
    expect([...lit.values()].every((r) => !r.overCurrent)).toBe(true);
  });

  it('latches the switches into the register example on a button press', () => {
    const doc = registerDoc();
    const sim = new Simulator();
    const conn = new Connectivity(doc);
    const button = doc.parts.find((p) => p.def === 'button')!.id;
    const dip = doc.parts.find((p) => p.def === 'dip-switch-4')!;
    const shown = (): number =>
      [24, 25, 26, 27].reduce((acc, col, k) => acc | (((sim.snapshot().volts(h(`f${col}`)) ?? 0) > 1 ? 1 : 0) << k), 0);
    const first = sim.run(doc, conn, new Set(), true);
    expect(first.problems).toEqual([]);
    sim.update(doc, conn, new Set([button]), true);
    expect(shown()).toBe(0b0101);
    sim.update(doc, conn, new Set(), true);
    dip.state = 0b1010;
    sim.update(doc, conn, new Set(), true);
    expect(shown()).toBe(0b0101);
    sim.update(doc, conn, new Set([button]), true);
    expect(shown()).toBe(0b1010);
    expect([...sim.snapshot().leds.values()].filter((r) => r.brightness > 0.2)).toHaveLength(2);
  });

  it('powers a circuit from a bench supply and measures what it draws', () => {
    const doc = createDoc();
    doc.supplies = [{ id: 's1', x: -150, z: 0, volts: 9, limit: 1 }];
    doc.wires.push({ id: 'w1', a: { board: 's1', hole: '+' }, b: h('T+3'), color: 'red' });
    doc.wires.push({ id: 'w2', a: { board: 's1', hole: '-' }, b: h('T-3'), color: 'black' });
    doc.parts.push({ id: 'r1', def: 'resistor', pins: [h('T+10'), h('T-14')], value: 1000 });
    const sim = new Simulator();
    const conn = new Connectivity(doc);
    const r = sim.run(doc, conn, new Set(), true);
    expect(r.live).toBe(true);
    expect(r.volts(h('T+20'))).toBeCloseTo(9, 6);
    expect(r.supplies.get('s1')!.amps * 1000).toBeCloseTo(9, 3);
    // Stopped, or with a terminal left unwired, it does nothing.
    expect(sim.run(doc, conn, new Set(), false).live).toBe(false);
    doc.wires.pop();
    expect(sim.run(doc, new Connectivity(doc), new Set(), true).live).toBe(false);
  });

  describe('bench supply current limit', () => {
    const supplied = (volts: number, limit: number) => {
      const doc = createDoc();
      doc.supplies = [{ id: 's1', x: -150, z: 0, volts, limit }];
      doc.wires.push({ id: 'w1', a: { board: 's1', hole: '+' }, b: h('T+3'), color: 'red' });
      doc.wires.push({ id: 'w2', a: { board: 's1', hole: '-' }, b: h('T-3'), color: 'black' });
      return doc;
    };

    it('gives what the circuit draws while that is under the limit', () => {
      const doc = supplied(5, 1);
      doc.parts.push({ id: 'r1', def: 'resistor', pins: [h('T+10'), h('T-14')], value: 1000 });
      const s = new Simulator().run(doc, new Connectivity(doc), new Set(), true).supplies.get('s1')!;
      expect(s.cc).toBe(false);
      expect(s.volts).toBe(5);
      expect(s.amps * 1000).toBeCloseTo(5, 3);
    });

    it('lowers the voltage to hold the current at the limit', () => {
      const doc = supplied(5, 0.02);
      doc.parts.push({ id: 'r1', def: 'resistor', pins: [h('T+10'), h('T-14')], value: 100 });
      const r = new Simulator().run(doc, new Connectivity(doc), new Set(), true);
      const s = r.supplies.get('s1')!;
      expect(s.cc).toBe(true);
      expect(s.amps).toBeCloseTo(0.02, 4);
      expect(s.volts).toBeCloseTo(2, 2);
      expect(r.volts(h('T+20'))).toBeCloseTo(2, 2);
    });

    it('lights an LED across it with no resistor, at the limit', () => {
      const doc = supplied(5, 0.02);
      doc.parts.push({ id: 'd1', def: 'led-red', pins: [h('T+10'), h('T-10')], value: 5 });
      const r = new Simulator().run(doc, new Connectivity(doc), new Set(), true);
      const s = r.supplies.get('s1')!;
      expect(s.cc).toBe(true);
      expect(s.amps).toBeCloseTo(0.02, 4);
      expect(s.volts).toBeGreaterThan(1.5);
      expect(s.volts).toBeLessThan(2.5);
      expect(r.leds.get('d1')!.brightness).toBeGreaterThan(0.2);
    });

    it('sits at its limit with nothing across it when its leads are joined', () => {
      const doc = supplied(5, 0.5);
      doc.wires.push({ id: 'w3', a: h('T+20'), b: h('T-20'), color: 'yellow' });
      const r = new Simulator().run(doc, new Connectivity(doc), new Set(), true);
      const s = r.supplies.get('s1')!;
      expect(r.problems).toEqual([]);
      expect(s).toEqual({ volts: 0, amps: 0.5, cc: true });
    });

    it('goes back to the set voltage once a big capacitor has charged', () => {
      const doc = supplied(5, 0.1);
      doc.parts.push({ id: 'r1', def: 'resistor', pins: [h('T+10'), h('a10')], value: 10 });
      doc.parts.push({ id: 'c1', def: 'cap-electrolytic', pins: [h('b10'), h('T-12')], value: 1000e-6 });
      const sim = new Simulator();
      const first = sim.run(doc, new Connectivity(doc), new Set(), true).supplies.get('s1')!;
      expect(first.cc).toBe(true);
      expect(first.amps).toBeCloseTo(0.1, 3);
      sim.advance(1);
      const later = sim.snapshot().supplies.get('s1')!;
      expect(later.cc).toBe(false);
      expect(later.volts).toBe(5);
      expect(later.amps).toBeLessThan(0.01);
    });
  });

  it('warns when a bench supply is set too high for the chips on it', () => {
    const b = new Bench(false).chip('u1', '74LS04', 20);
    b.doc.parts = b.doc.parts.filter((p) => p.def !== 'power');
    b.doc.supplies = [{ id: 's1', x: -150, z: 0, volts: 9, limit: 1 }];
    b.doc.wires.push({ id: 'ws1', a: { board: 's1', hole: '+' }, b: h('T+3'), color: 'red' });
    b.doc.wires.push({ id: 'ws2', a: { board: 's1', hole: '-' }, b: h('B-3'), color: 'black' });
    b.wire(railNear('T-', 50), railNear('B-', 50));
    const r = b.sim.run(b.doc, new Connectivity(b.doc), new Set(), true);
    expect(r.problems.some((p) => p.partId === 'u1' && /9\.0 V/.test(p.message))).toBe(true);
    // The supply also feeds the idle chip.
    expect(r.supplies.get('s1')!.amps).toBeGreaterThan(0.005);
  });

  it('warns about an electrolytic capacitor in backwards', () => {
    const r = new Bench().part('c', 'cap-electrolytic', [rail('T-', 20), rail('T+', 20)], { value: 10e-6 }).run();
    expect(r.problems.some((p) => p.partId === 'c' && /Reversed/.test(p.message))).toBe(true);
  });
});

describe('More parts', () => {
  it('divides the supply with a potentiometer', () => {
    const b = new Bench().part('pot', 'pot', ['c30', 'c31', 'c32'], { value: 10000, state: 250 });
    b.toRail('a30', 'T+', 30).toRail('a32', 'T-', 32);
    b.run();
    expect(b.v('a31')).toBeCloseTo(3.75, 2);
  });

  it('switches with a slide switch', () => {
    const b = new Bench().part('sw', 'slide-switch', ['c30', 'c31', 'c32'], { state: 0 });
    b.toRail('a30', 'T+', 30).toRail('a32', 'T-', 32);
    b.run();
    expect(b.v('a31')).toBeCloseTo(5, 2);
    b.doc.parts[1].state = 1;
    b.run();
    expect(b.v('a31')).toBeCloseTo(0, 2);
  });

  it('lights the segments of a common-cathode display', () => {
    // Common to ground, segment a through 470 Ω to +.
    const b = new Bench().part(
      'd',
      '7seg-cc',
      dipPinHoles({ pins: 10, wide: true }, 30, false).map((p) => `${p.row}${p.col + 1}`),
    );
    const holes = dipPinHoles({ pins: 10, wide: true }, 30, false).map((p) => `${p.row}${p.col + 1}`);
    b.toRail(sameStrip(holes[2]), 'B-', 30);
    b.part('r', 'resistor', [sameStrip(holes[6]), railNear('T+', 33)], { value: 470 });
    const r = b.run();
    const seg = r.segments.get('d')!;
    expect(seg[0].current).toBeGreaterThan(0.004);
    expect(seg.slice(1).every((s) => s.current === 0)).toBe(true);
  });

  it('toggles a 74LS107 on each falling clock edge', () => {
    const clk = pinHole('74LS107', 20, 12);
    const b = new Bench().chip('jk', '74LS107', 20);
    b.part('btn', 'button', [sameStrip(clk), `b${clk.slice(1)}`, 'a40', 'b40']).toRail('c40', 'T-', 40);
    const q = sameStrip(pinHole('74LS107', 20, 3));
    b.run();
    expect(b.v(q)).toBeLessThan(1);
    b.run(['btn']);
    expect(b.v(q)).toBeGreaterThan(2);
    b.run();
    b.run(['btn']);
    expect(b.v(q)).toBeLessThan(1);
  });

  it('decodes with a 74LS139', () => {
    // 1G grounded, 1A and 1B float high: output 1Y3 goes low.
    const b = new Bench().chip('dec', '74LS139', 20);
    b.toRail(sameStrip(pinHole('74LS139', 20, 1)), 'B-', 20);
    b.run();
    const y = [4, 5, 6, 7].map((pin) => b.v(sameStrip(pinHole('74LS139', 20, pin))));
    expect(y[3]).toBeLessThan(0.5);
    expect(y.slice(0, 3).every((v) => v > 3)).toBe(true);
  });

  it('writes and reads a 74LS189 RAM', () => {
    // Address floats to 15. ME low; WE low writes 1111, then reading gives the inverse: all low.
    const b = new Bench().chip('ram', '74LS189', 20);
    const strip = (pin: number): string => sameStrip(pinHole('74LS189', 20, pin));
    b.toRail(strip(2), 'B-', 20);
    b.toRail(strip(3), 'T-', 22);
    b.run();
    b.doc.wires.pop();
    b.toRail(strip(3), 'T+', 24);
    b.run();
    expect([5, 7, 9, 11].every((pin) => b.v(strip(pin)) < 0.5)).toBe(true);
    // Write 1110 (D1 grounded), read 0001 back.
    b.doc.wires.pop();
    b.toRail(strip(4), 'B-', 26).toRail(strip(3), 'T-', 28);
    b.run();
    b.doc.wires.pop();
    b.toRail(strip(3), 'T+', 30);
    b.run();
    expect(b.v(strip(5))).toBeGreaterThan(3);
    expect([7, 9, 11].every((pin) => b.v(strip(pin)) < 0.5)).toBe(true);
  });

  it('reads an EEPROM, writes it, and keeps what it wrote with the power off', () => {
    // Address pins float (CMOS: read as 0), CE and OE low, WE high: the outputs show byte 0.
    const bytes = new Uint8Array(2048).fill(0xff);
    bytes[0] = 0xa5;
    const b = new Bench().chip('rom', '28C16', 20).part('x', 'resistor', ['a62', 'a63']);
    b.doc.parts.find((p) => p.id === 'rom')!.data = encodeBytes(bytes);
    const strip = (pin: number): string => sameStrip(pinHole('28C16', 20, pin));
    const data = [9, 10, 11, 13, 14, 15, 16, 17];
    const byte = (): number => data.reduce((acc, pin, i) => acc | ((b.v(strip(pin)) > 2 ? 1 : 0) << i), 0);
    b.toRail(strip(18), 'T-', 20).toRail(strip(20), 'T-', 22).toRail(strip(21), 'T+', 24);
    b.run();
    expect(byte()).toBe(0xa5);

    // OE high, drive the data pins with 0x81, pulse WE low then high.
    const oe = b.doc.wires.findIndex((w) => w.a.hole === strip(20));
    b.doc.wires.splice(oe, 1);
    b.toRail(strip(20), 'T+', 26);
    data.forEach((pin, i) =>
      b.toRail(
        strip(pin),
        (0x81 >> i) & 1 ? (strip(pin)[0] <= 'e' ? 'T+' : 'B+') : strip(pin)[0] <= 'e' ? 'T-' : 'B-',
        30,
      ),
    );
    const we = (): number => b.doc.wires.findIndex((w) => w.a.hole === strip(21));
    b.doc.wires.splice(we(), 1);
    b.toRail(strip(21), 'T-', 40);
    b.run();
    b.doc.wires.splice(we(), 1);
    b.toRail(strip(21), 'T+', 42);
    b.run();
    const saved = b.sim.takeWrites().get('rom')!;
    expect(decodeBytes(saved, 2048)[0]).toBe(0x81);

    // Power cycle: the EEPROM still holds it.
    b.doc.parts.find((p) => p.id === 'rom')!.data = saved;
    b.doc.parts[0].state = 0;
    b.run();
    b.doc.parts[0].state = 1;
    b.run();
    expect(b.sim.memoryOf(b.doc.parts.find((p) => p.id === 'rom')!)![0]).toBe(0x81);
  });
});

describe('bar graphs and resistor networks', () => {
  it('lights a bar graph one bar at a time, each from its anode straight across to its cathode', () => {
    const b = new Bench();
    // Pin 1 in column 11: anodes 1–10 along row f, cathodes 20–11 across in row e.
    const pins = dipPinHoles(dipFootprint(PARTS.bargraph)!, 10, false).map((p) => `${p.row}${p.col + 1}`);
    b.part('bar', 'bargraph', pins);
    expect(pins[0]).toBe('f11');
    expect(pins[19]).toBe('e11');
    b.part('r1', 'resistor', ['j11', railNear('B+', 11)], { value: 330 });
    b.toRail('a11', 'T-', 11);
    // Bar 3 has its anode fed but nothing on its cathode (pin 18).
    b.part('r3', 'resistor', ['j13', railNear('B+', 16)], { value: 330 });
    const bars = b.run().segments.get('bar')!;
    expect(bars[0].brightness).toBeGreaterThan(0.5);
    expect(bars[2]?.brightness ?? 0).toBe(0);
    expect(bars[1]?.brightness ?? 0).toBe(0);
  });

  it('joins pin 1 of a resistor network to each other pin through its own resistor', () => {
    const b = new Bench();
    b.part(
      'rn',
      'resistor-network',
      Array.from({ length: 9 }, (_, i) => `a${31 + i}`),
      { value: 1000 },
    );
    b.toRail('b31', 'T+', 31);
    // Pin 2 pulled down by an equal resistor: halfway. Pin 3 has nothing else on it: pulled right up.
    b.part('r', 'resistor', ['b32', railNear('B-', 40)], { value: 1000 });
    b.run();
    expect(b.v('a32')).toBeCloseTo(2.5, 1);
    expect(b.v('a33')).toBeCloseTo(5, 1);
  });
});

describe('Time going backwards', () => {
  it('ignores a negative step instead of blowing up the capacitors', () => {
    const doc = blinkerDoc();
    const sim = new Simulator();
    sim.run(doc, new Connectivity(doc), new Set(), true);
    sim.advance(0.2);
    const before = sim.time;
    expect(sim.advance(-0.01)).toBe(0);
    expect(sim.time).toBe(before);
    const r = sim.snapshot();
    expect(r.problems).toEqual([]);
    for (const chip of doc.parts) for (const pin of chip.pins) expect(Math.abs(r.volts(pin) ?? 0)).toBeLessThan(10);
  });
});
