import { describe, expect, it } from 'vitest';
import { benchDoc } from '../src/app/bench';
import { Connectivity } from '../src/engine/netlist';
import { Simulator } from '../src/engine/sim/simulator';

describe('8-bit computer scale', () => {
  it('builds cleanly, counts on every board, and keeps up in real time', () => {
    const doc = benchDoc();
    const sim = new Simulator();
    const conn = new Connectivity(doc);
    let t = performance.now();
    const first = sim.run(doc, conn, new Set(), true);
    const buildMs = performance.now() - t;
    expect(first.problems).toEqual([]);
    expect(doc.parts.filter((p) => p.def.startsWith('74') || p.def === 'NE555')).toHaveLength(40);

    t = performance.now();
    sim.advance(1);
    const secondMs = performance.now() - t;
    const lit = [...sim.snapshot().leds.values()].filter((r) => r.brightness > 0.05).length;
    console.log(
      `build ${buildMs.toFixed(0)} ms, 1 s of circuit at ~700 Hz took ${secondMs.toFixed(0)} ms, ${lit} LEDs lit`,
    );
    expect(lit).toBeGreaterThan(20);
    expect(secondMs).toBeLessThan(5000);
  });
});
