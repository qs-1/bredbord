import { describe, expect, it } from 'vitest';
import { h, rail, pinHole, sameStrip, railNear, Bench } from './helpers/bench';

describe('Transistors', () => {
  /** Legs are emitter, base, collector, in columns 30–32 of row a. */
  const withTransistor = (def = '2N3904'): Bench => new Bench().part('q', def, ['a30', 'a31', 'a32']);

  it('saturates as a switch: a hard-driven base pulls the collector almost to the emitter', () => {
    const b = withTransistor();
    b.wire('b30', rail('T-', 30));
    b.part('rb', 'resistor', ['b31', railNear('T+', 31)], { value: 10000 });
    b.part('rc', 'resistor', ['b32', railNear('T+', 33)], { value: 1000 });
    const r = b.run();
    expect(b.v('c32')).toBeLessThan(0.15);
    expect(b.v('c32')).toBeGreaterThan(0.03);
    const q = r.transistors.get('q')!;
    expect(q.collector * 1000).toBeCloseTo(4.9, 1);
    expect(q.base * 1000).toBeCloseTo((5 - 0.7) / 10, 1);
    expect(q.overCurrent).toBe(false);
  });

  it('cuts off with the base held at the emitter', () => {
    const b = withTransistor();
    b.wire('b30', rail('T-', 30));
    b.part('rb', 'resistor', ['b31', railNear('T-', 31)], { value: 10000 });
    b.part('rc', 'resistor', ['b32', railNear('T+', 33)], { value: 1000 });
    const r = b.run();
    expect(b.v('c32')).toBeGreaterThan(4.99);
    expect(r.transistors.get('q')!.collector).toBeLessThan(1e-6);
  });

  it('amplifies in its active region: collector current is the gain times the base current', () => {
    // 1 MΩ into the base is only 4.3 µA, so it cannot saturate.
    const b = withTransistor();
    b.wire('b30', rail('T-', 30));
    b.part('rb', 'resistor', ['b31', railNear('T+', 31)], { value: 1e6 });
    b.part('rc', 'resistor', ['b32', railNear('T+', 33)], { value: 1000 });
    const r = b.run();
    const q = r.transistors.get('q')!;
    expect(q.collector / q.base).toBeCloseTo(150, 0);
    expect(b.v('c32')).toBeCloseTo(5 - q.collector * 1000, 2);
    expect(b.v('c32')).toBeGreaterThan(3.5);
    expect(b.v('c32')).toBeLessThan(4.7);
  });

  it('follows its base an emitter drop lower as an emitter follower', () => {
    // Base from a 10k/10k divider, emitter through 1 kΩ to ground, collector on +.
    const b = withTransistor();
    b.wire('b32', rail('T+', 32));
    b.part('r1', 'resistor', ['b31', railNear('T+', 31)], { value: 10000 });
    b.part('r2', 'resistor', ['c31', railNear('T-', 31)], { value: 10000 });
    b.part('re', 'resistor', ['b30', railNear('T-', 30)], { value: 1000 });
    b.run();
    const expected = (151 * 1000 * (2.5 - 0.65)) / (5000 + 151 * 1000);
    expect(b.v('c30')).toBeGreaterThan(expected - 0.1);
    expect(b.v('c30')).toBeLessThan(expected + 0.1);
    expect(b.v('c31') - b.v('c30')).toBeGreaterThan(0.6);
    expect(b.v('c31') - b.v('c30')).toBeLessThan(0.75);
  });

  it('switches the high side with a PNP', () => {
    // Emitter to +, base pulled to ground through 10 kΩ, collector to a 1 kΩ load to ground.
    const b = withTransistor('2N3906');
    b.wire('b30', rail('T+', 30));
    b.part('rb', 'resistor', ['b31', railNear('T-', 31)], { value: 10000 });
    b.part('rl', 'resistor', ['b32', railNear('T-', 33)], { value: 1000 });
    const r = b.run();
    expect(b.v('c32')).toBeGreaterThan(4.85);
    expect(r.transistors.get('q')!.collector * 1000).toBeCloseTo(4.9, 1);
    // Base tied up to the emitter: off, and the load sits at ground.
    b.doc.parts.find((p) => p.id === 'rb')!.pins = [h('b31'), h(railNear('T+', 31))];
    b.run();
    expect(b.v('c32')).toBeLessThan(0.01);
  });

  it('lights an LED through a transistor driven from a logic output', () => {
    // A 74LS04 output (about 3.6 V high) drives the base; the LED and its resistor sit in the collector.
    const b = new Bench().chip('inv', '74LS04', 20).part('q', '2N3904', ['a45', 'a46', 'a47']);
    b.wire(sameStrip(pinHole('74LS04', 20, 2)), 'c46').wire('b45', rail('T-', 45));
    b.part('led', 'led-red', ['b50', 'b47']);
    b.part('r', 'resistor', ['c50', railNear('T+', 50)], { value: 330 });
    // Input floats high, so the output is low: the LED is dark. Ground the input and it lights.
    expect(b.run().leds.get('led')!.current).toBeLessThan(1e-4);
    b.toRail(sameStrip(pinHole('74LS04', 20, 1)), 'B-', 22);
    const r = b.run();
    expect(r.leds.get('led')!.current * 1000).toBeGreaterThan(8);
    expect(r.leds.get('led')!.overCurrent).toBe(false);
  });

  it('warns when a transistor carries more than it is rated for', () => {
    const b = withTransistor();
    b.wire('b30', rail('T-', 30));
    b.part('rb', 'resistor', ['b31', railNear('T+', 31)], { value: 1000 });
    b.part('rc', 'resistor', ['b32', railNear('T+', 33)], { value: 10 });
    const r = b.run();
    expect(r.transistors.get('q')!.overCurrent).toBe(true);
    expect(r.problems.some((p) => p.partId === 'q' && /Too much/.test(p.message))).toBe(true);
    // The 2N2222 takes that.
    b.doc.parts.find((p) => p.id === 'q')!.def = '2N2222';
    expect(b.run().transistors.get('q')!.overCurrent).toBe(false);
  });

  it('runs an astable multivibrator at the period its resistors and capacitors set', () => {
    // Each collector coupled to the other's base through a capacitor, 47 kΩ bias resistors. Both halves are
    // identical, so it must pick a side to start on rather than sit half on in both transistors.
    const b = new Bench().part('q1', '2N3904', ['a20', 'a21', 'a22']).part('q2', '2N3904', ['a30', 'a31', 'a32']);
    b.wire('b20', rail('T-', 20)).wire('b30', rail('T-', 30));
    b.part('rc1', 'resistor', ['b22', railNear('T+', 22)], { value: 1000 });
    b.part('rc2', 'resistor', ['b32', railNear('T+', 32)], { value: 1000 });
    b.part('rb1', 'resistor', ['b21', railNear('T+', 25)], { value: 47000 });
    b.part('rb2', 'resistor', ['b31', railNear('T+', 35)], { value: 47000 });
    // C1: collector 1 to base 2. C2: collector 2 to base 1. + towards the collector.
    b.part('c1', 'cap-electrolytic', ['c22', 'c31'], { value: 1e-6 });
    b.part('c2', 'cap-electrolytic', ['c32', 'c21'], { value: 1e-6 });
    b.run();
    const edges: number[] = [];
    let was = b.v('d22') > 2;
    for (let t = 0; t < 1; t += 0.0005) {
      b.sim.advance(0.0005);
      const now = b.v('d22') > 2;
      if (now && !was) edges.push(b.sim.time);
      was = now;
    }
    expect(edges.length).toBeGreaterThan(4);
    const measured = (edges[edges.length - 1] - edges[1]) / (edges.length - 2);
    // Each base charges from about −4.3 V up to 0.65 V: t = R·C·ln(9.3 / 4.35) per half-cycle.
    const half = (c: number): number => 47000 * c * Math.log((5 + 4.28) / (5 - 0.65));
    const expected = half(1e-6) + half(1e-6);
    expect(measured).toBeGreaterThan(expected * 0.9);
    expect(measured).toBeLessThan(expected * 1.1);
  });
});
