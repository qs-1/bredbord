import { describe, expect, it } from 'vitest';
import { Network } from '../src/engine/sim/electrical';

describe('Electrical network', () => {
  const network = (count: number, fixed: [number, number][], build: (n: Network) => void): Network => {
    const n = new Network(count, new Map(fixed));
    build(n);
    n.compile(0);
    return n;
  };

  it('splits a voltage across a divider', () => {
    const n = network(
      3,
      [
        [0, 5],
        [2, 0],
      ],
      (n) => {
        n.addBranch(0, 1, 1 / 1000);
        n.addBranch(1, 2, 1 / 1000);
      },
    );
    expect(n.volts[1]).toBeCloseTo(2.5, 6);
  });

  it('drops the forward voltage across a conducting LED', () => {
    const n = network(
      3,
      [
        [0, 5],
        [2, 0],
      ],
      (n) => {
        n.addBranch(1, 2, 1 / 470);
        n.addDiode(0, 1, 2, 1 / 10);
      },
    );
    expect(n.diodeCurrent(0)).toBeCloseTo(3 / 480, 5);
  });

  it('keeps a reverse-biased LED dark', () => {
    const n = network(
      3,
      [
        [0, 0],
        [2, 5],
      ],
      (n) => {
        n.addBranch(1, 2, 1 / 470);
        n.addDiode(0, 1, 2, 1 / 10);
      },
    );
    expect(n.diodeCurrent(0)).toBe(0);
  });

  it('reports nets with nothing driving them as floating', () => {
    const n = network(2, [[0, 5]], () => {});
    expect(Number.isNaN(n.volts[1])).toBe(true);
  });

  it('charges a capacitor along the exact RC curve', () => {
    // 1 kΩ into 1 µF: one time constant is 1 ms.
    const n = network(
      3,
      [
        [0, 5],
        [2, 0],
      ],
      (n) => {
        n.addBranch(0, 1, 1 / 1000);
        n.addCapacitor(1, 2, 1e-6, 0);
      },
    );
    expect(n.volts[1]).toBeCloseTo(0, 3);
    n.advanceTo(1e-3);
    expect(n.volts[1]).toBeCloseTo(5 * (1 - Math.exp(-1)), 3);
    n.advanceTo(10e-3);
    expect(n.volts[1]).toBeCloseTo(5, 3);
    expect(n.capacitorVolts(0)).toBeCloseTo(5, 3);
  });

  it('predicts exactly when a capacitor reaches a threshold', () => {
    const n = network(
      3,
      [
        [0, 5],
        [2, 0],
      ],
      (n) => {
        n.addBranch(0, 1, 1 / 1000);
        n.addCapacitor(1, 2, 1e-6, 0);
      },
    );
    n.predict(0, (net, out) => {
      if (net === 1) out.push(2.5);
    });
    // Off by a hundred-thousandth: the capacitor's 10 mΩ series resistance.
    expect(n.nextEvent() / (Math.log(2) * 1e-3)).toBeCloseTo(1, 4);
  });

  it('handles two capacitors coupled through resistors', () => {
    // Two RC stages in a row: the second lags the first but both end at the supply.
    const n = network(
      4,
      [
        [0, 5],
        [3, 0],
      ],
      (n) => {
        n.addBranch(0, 1, 1 / 1000);
        n.addCapacitor(1, 3, 1e-6, 0);
        n.addBranch(1, 2, 1 / 1000);
        n.addCapacitor(2, 3, 1e-6, 0);
      },
    );
    n.advanceTo(0.5e-3);
    expect(n.volts[1]).toBeGreaterThan(n.volts[2]);
    n.advanceTo(30e-3);
    expect(n.volts[1]).toBeCloseTo(5, 3);
    expect(n.volts[2]).toBeCloseTo(5, 3);
  });
});
