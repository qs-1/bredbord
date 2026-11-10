import { describe, expect, it } from 'vitest';
import {
  addSample,
  autoset,
  findTrigger,
  formatFrequency,
  formatTime,
  isScopeTerminal,
  measure,
  nearestStep,
  readingsBetween,
  SCOPE_HOLES,
  SCOPE_TERMINALS,
  SCOPE_TIMEBASES,
  SCOPE_VOLTS_PER_DIV,
  scopeTerminalPos,
  stepSetting,
  valueAt,
  type Samples,
} from '../src/engine/scope';
import { readDoc } from '../src/engine/document';

describe('oscilloscope terminals', () => {
  it('keeps ground and both channels as independent high-impedance nets', () => {
    expect(SCOPE_HOLES.holes.map((h) => h.name)).toEqual(['GND', 'CH1', 'CH2']);
    expect(SCOPE_HOLES.groups).toEqual([[0], [1], [2]]);
    expect(isScopeTerminal('CH2')).toBe(true);
    expect(isScopeTerminal('V')).toBe(false);
  });

  it('places its coloured jacks relative to its desk position', () => {
    const p = scopeTerminalPos({ x: 120, z: -45 }, 'CH1');
    expect(p.x).toBe(120 + SCOPE_TERMINALS.CH1.x);
    expect(p.y).toBe(SCOPE_TERMINALS.CH1.y);
    expect(p.z).toBe(-45 + SCOPE_TERMINALS.CH1.z);
  });
});

describe('oscilloscope settings', () => {
  it('steps the time base 1-2-5 from 1 µs to 1 s a division, stopping at the ends', () => {
    expect(SCOPE_TIMEBASES[0]).toBe(1e-5);
    expect(SCOPE_TIMEBASES.at(-1)).toBe(10);
    expect(SCOPE_TIMEBASES.map((t) => formatTime(t / 10, ''))).toContain('2ms');
    expect(stepSetting(SCOPE_TIMEBASES, 0.02, 1)).toBe(0.05);
    expect(stepSetting(SCOPE_TIMEBASES, 0.02, -1)).toBe(0.01);
    expect(stepSetting(SCOPE_TIMEBASES, 10, 1)).toBe(10);
    expect(stepSetting(SCOPE_TIMEBASES, 1e-5, -1)).toBe(1e-5);
  });

  it('steps volts per division 1-2-5 from 50 mV to 10 V', () => {
    expect(SCOPE_VOLTS_PER_DIV).toEqual([0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10]);
    expect(nearestStep(SCOPE_VOLTS_PER_DIV, 1.9)).toBe(2);
  });

  it('keeps older saves, putting their settings on the new steps', () => {
    const read = readDoc({
      version: 1,
      boards: [],
      parts: [],
      wires: [],
      scopes: [{ id: 'o1', x: 0, z: 0, timebase: 0.5, voltsPerDiv: 5 }],
    });
    expect('doc' in read && read.doc.scopes).toEqual([{ id: 'o1', x: 0, z: 0, timebase: 0.5, voltsPerDiv: 5 }]);
    const odd = readDoc({
      version: 1,
      boards: [],
      parts: [],
      wires: [],
      scopes: [
        {
          id: 'o1',
          x: 0,
          z: 0,
          timebase: 0.03,
          voltsPerDiv: 3,
          trigger: { source: 'CH2', edge: 'fall', mode: 'nope', level: 1.5 },
          offset1: 9,
        },
      ],
    });
    expect('doc' in odd && odd.doc.scopes?.[0]).toEqual({
      id: 'o1',
      x: 0,
      z: 0,
      timebase: 0.02,
      voltsPerDiv: 2,
      offset1: 4,
      trigger: { source: 'CH2', edge: 'fall', mode: 'auto', level: 1.5 },
    });
  });
});

/** A square wave sampled every millisecond: high for `half` ms, low for `half` ms, starting high. */
function square(seconds: number, half: number): Samples {
  const trace: Samples = { t: [], v: [] };
  for (let i = 0; i <= seconds * 1000; i++) addSample(trace, i / 1000, Math.floor(i / half) % 2 ? 0 : 5);
  return trace;
}

describe('scope recording', () => {
  it('keeps a flat stretch as its two ends and a step as two points at one moment', () => {
    const trace: Samples = { t: [], v: [] };
    for (const [t, v] of [
      [0, 0],
      [1, 0],
      [2, 0],
      [2, 5],
      [3, 5],
    ])
      addSample(trace, t, v);
    addSample(trace, 4, 0);
    expect(trace.t).toEqual([0, 2, 2, 3, 4]);
    expect(trace.v).toEqual([0, 0, 5, 5, 0]);
    expect(valueAt(trace, 1)).toBe(0);
    expect(valueAt(trace, 2.5)).toBe(5);
    expect(valueAt(trace, 3.5)).toBe(2.5);
  });

  it('reads a moving voltage about a dozen times a time constant, and not at all when steady', () => {
    expect(readingsBetween(0, 1e-3, 1000).length).toBe(11);
    expect(readingsBetween(0, 1, 1000).length).toBe(63);
    expect(readingsBetween(0, 1, 0)).toEqual([]);
  });
});

describe('scope trigger', () => {
  const span = 0.5;

  it('puts a rising edge in the middle of the screen, with a whole screen of recording', () => {
    const trace = square(5, 50);
    for (const now of [4.93, 4.97, 5]) {
      const end = findTrigger(trace, now, span, 'rise', 2.5)!;
      expect(end).toBeLessThanOrEqual(now + 1e-9);
      const edge = end - span / 2;
      // That's a rising edge of the 10 Hz wave.
      expect(Math.round(edge * 1000) % 100).toBe(0);
      expect(valueAt(trace, edge + 0.002)).toBe(5);
      expect(valueAt(trace, edge - 0.002)).toBe(0);
    }
  });

  it('finds falling edges and other levels', () => {
    const trace = square(5, 50);
    const end = findTrigger(trace, 5, span, 'fall', 1)!;
    expect(valueAt(trace, end - span / 2 + 0.002)).toBe(0);
    expect(valueAt(trace, end - span / 2 - 0.002)).toBe(5);
    // A level the signal never reaches: no trigger.
    expect(findTrigger(trace, 5, span, 'rise', 7)).toBeNull();
  });

  it('holds still while time advances within one period', () => {
    const trace = square(5, 50);
    const ends = [4.9, 4.93, 4.96, 5].map((now) => findTrigger(trace, now, span, 'rise', 2.5));
    expect(new Set(ends).size).toBeLessThanOrEqual(2);
  });

  it('has nothing to show without a whole screen round an edge', () => {
    expect(findTrigger({ t: [0, 1, 2, 3], v: [2, 2, 2, 2] }, 3, span, 'rise', 1)).toBeNull();
    expect(findTrigger(square(0.3, 50), 0.3, span, 'rise', 2.5)).toBeNull();
    expect(findTrigger(undefined, 1.5, span, 'rise', 0)).toBeNull();
  });
});

describe('scope measurements', () => {
  it('measures a square wave', () => {
    const m = measure(square(1, 50), 0.2, 0.8)!;
    expect(m.max).toBe(5);
    expect(m.min).toBe(0);
    expect(m.pp).toBe(5);
    expect(m.period).toBeCloseTo(0.1, 3);
    expect(m.frequency).toBeCloseTo(10, 1);
    expect(m.duty).toBeCloseTo(0.5, 2);
    expect(m.mean).toBeCloseTo(2.5, 1);
    expect(m.rms).toBeCloseTo(Math.sqrt(12.5), 1);
    expect(formatFrequency(m.frequency)).toBe('10 Hz');
  });

  it("has no period for a signal that doesn't repeat", () => {
    const m = measure({ t: [0, 1], v: [3, 3] }, 0, 1)!;
    expect(m.mean).toBe(3);
    expect(m.period).toBeNaN();
  });

  it('picks settings that show about three cycles and fit the swing', () => {
    const a = autoset(square(3, 5), 3)!;
    expect(a.voltsPerDiv).toBe(2);
    expect(a.timebase).toBe(0.02);
    expect(a.level).toBe(2.5);
  });
});
