import type { HoleSet } from './supply';

type Hole = HoleSet['holes'][number];

/**
 * A compact two-channel bench oscilloscope. Its three front-panel sockets are ordinary wire
 * endpoints, so a scope observes a circuit without adding a hidden connection to it.
 */
export const SCOPE_SIZE = { x: 180, y: 100, z: 100 } as const;

/**
 * The inputs, small BNC sockets at the bottom of the control column on the right of the front
 * panel in one row: each channel under its volts-per-division knob, ground between them. Where a wire ends
 * on one is the tip of its socket.
 */
export const SCOPE_TERMINALS = {
  GND: { x: 57.5, y: 17.5, z: SCOPE_SIZE.z / 2 + 4 },
  CH1: { x: 45.5, y: 17.5, z: SCOPE_SIZE.z / 2 + 4 },
  CH2: { x: 69.5, y: 17.5, z: SCOPE_SIZE.z / 2 + 4 },
} as const;
export type ScopeTerminalName = keyof typeof SCOPE_TERMINALS;

export const isScopeTerminal = (hole: string): hole is ScopeTerminalName =>
  hole === 'GND' || hole === 'CH1' || hole === 'CH2';

const terminal = (name: ScopeTerminalName, index: number): Hole => ({
  index,
  name,
  kind: 'rail',
  col: -1,
  row: -1,
  x: SCOPE_TERMINALS[name].x,
  z: SCOPE_TERMINALS[name].z,
  group: index,
});

const TERMINALS = [terminal('GND', 0), terminal('CH1', 1), terminal('CH2', 2)];

/** High-impedance inputs: none of the terminals are electrically joined by the scope itself. */
export const SCOPE_HOLES: HoleSet = {
  holes: TERMINALS,
  groups: [[0], [1], [2]],
  hole: (name) => TERMINALS.find((h) => h.name === name),
};

/* ------------------------------------------------------------------------- settings --- */

/** The screen is ten divisions across and eight up, as on nearly every scope. */
export const SCOPE_DIV_X = 10;
export const SCOPE_DIV_Y = 8;

/**
 * Seconds across the whole screen, in the usual 1-2-5 steps: 1 µs a division up to 1 s a
 * division. (The setting is the time across the screen; the knob reads it per division.)
 */
export const SCOPE_TIMEBASES: readonly number[] = steps125(1e-5, 10);

/** Volts per division, 1-2-5 steps from 50 mV to 10 V. */
export const SCOPE_VOLTS_PER_DIV: readonly number[] = steps125(0.05, 10);

function steps125(from: number, to: number): number[] {
  const out: number[] = [];
  for (let decade = 10 ** Math.floor(Math.log10(from) + 1e-9); decade <= to * 1.0001; decade *= 10) {
    for (const k of [1, 2, 5]) {
      const v = +(decade * k).toPrecision(3);
      if (v >= from * 0.9999 && v <= to * 1.0001) out.push(v);
    }
  }
  return out;
}

/** The setting in `list` nearest to `value` (by ratio), so saved values always land on a step. */
export function nearestStep(list: readonly number[], value: number): number {
  let best = list[0];
  for (const v of list) if (Math.abs(Math.log(v / value)) < Math.abs(Math.log(best / value))) best = v;
  return best;
}

/** One step along `list` from `value`: `by` +1 is the next coarser setting, -1 the next finer. It stops at the ends. */
export function stepSetting(list: readonly number[], value: number, by: number): number {
  const i = list.indexOf(nearestStep(list, value));
  return list[Math.max(0, Math.min(list.length - 1, i + by))];
}

export const isScopeTimebase = (value: unknown): value is number =>
  typeof value === 'number' && value > 0 && Number.isFinite(value);
export const isScopeVoltsPerDiv = isScopeTimebase;

export type ScopeChannel = 'CH1' | 'CH2';
export type TriggerEdge = 'rise' | 'fall';
/**
 * Auto: shows the newest trigger, or the signal as it comes if there's none. Normal: holds the last
 * trigger until another comes. Single: stops on the first trigger after it's armed.
 */
export type TriggerMode = 'auto' | 'normal' | 'single';

export interface ScopeTrigger {
  source: ScopeChannel;
  edge: TriggerEdge;
  /** Volts; unset means the middle of the signal, as a scope's "50 %" button sets it. */
  level?: number;
  mode: TriggerMode;
}

export const DEFAULT_TRIGGER: ScopeTrigger = { source: 'CH1', edge: 'rise', mode: 'auto' };

/* -------------------------------------------------------------------------- samples --- */

/**
 * A channel's recording: voltage `v[i]` at time `t[i]`, straight lines in between. A sudden step
 * is two points at the same moment, the value before and the value after.
 */
export interface Samples {
  t: number[];
  v: number[];
  /** The latest reading left out because it hadn't moved from the one before it. */
  held?: { t: number; v: number } | null;
}

/** Voltages closer than this count as the same reading, so steady stretches cost two points. */
const SAME_VOLTS = 0.005;

/**
 * Adds a reading. Readings that haven't moved are held back and only written when the voltage
 * moves again, so a flat stretch is just its two ends, and a step comes out square.
 */
export function addSample(trace: Samples, t: number, v: number): void {
  const n = trace.v.length;
  const last = n ? trace.v[n - 1] : undefined;
  if (last !== undefined && (Number.isNaN(v) ? Number.isNaN(last) : Math.abs(v - last) < SAME_VOLTS)) {
    trace.held = { t, v: last };
    return;
  }
  const held = trace.held;
  trace.held = null;
  if (held && n && held.t > trace.t[n - 1]) {
    trace.t.push(held.t);
    trace.v.push(held.v);
  }
  const m = trace.v.length;
  // A third reading at one moment (a circuit settling) replaces the second: one step per moment.
  if (m >= 2 && trace.t[m - 1] === t && trace.t[m - 2] === t) trace.v[m - 1] = v;
  else {
    trace.t.push(t);
    trace.v.push(v);
  }
}

/**
 * Moments between `from` and `to` (both left out) to read a voltage that moves smoothly at `rate`
 * (1 / its time constant) so its curve draws true: about a dozen a time constant, at most 64.
 */
export function readingsBetween(from: number, to: number, rate: number): number[] {
  if (!(rate > 0) || !(to > from)) return [];
  const n = Math.min(64, Math.ceil((to - from) * rate * 12));
  const out: number[] = [];
  for (let k = 1; k < n; k++) out.push(from + ((to - from) * k) / n);
  return out;
}

/** The index of the last sample at or before `t` (-1 if none). */
export function sampleBefore(trace: Samples, t: number): number {
  let lo = -1;
  let hi = trace.t.length;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (trace.t[mid] <= t) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** The voltage at `t`, on the straight line between the samples either side. */
export function valueAt(trace: Samples, t: number): number {
  const i = sampleBefore(trace, t);
  if (i < 0) return NaN;
  if (i + 1 >= trace.t.length) return trace.v[i];
  const t0 = trace.t[i];
  const t1 = trace.t[i + 1];
  if (t1 <= t0) return trace.v[i + 1];
  return trace.v[i] + ((trace.v[i + 1] - trace.v[i]) * (t - t0)) / (t1 - t0);
}

/* -------------------------------------------------------------------------- trigger --- */

/** Highest and lowest voltage between `start` and `end`. */
export function extremes(trace: Samples, start: number, end: number): { min: number; max: number } {
  let min = Infinity;
  let max = -Infinity;
  const take = (v: number): void => {
    if (!Number.isFinite(v)) return;
    if (v < min) min = v;
    if (v > max) max = v;
  };
  take(valueAt(trace, start));
  take(valueAt(trace, end));
  for (let i = Math.max(0, sampleBefore(trace, start) + 1); i < trace.t.length && trace.t[i] <= end; i++)
    take(trace.v[i]);
  return { min, max };
}

/** The level a trigger set to the middle of the signal uses: halfway between its extremes lately. */
export function autoLevel(trace: Samples, now: number, span: number): number {
  const { min, max } = extremes(trace, now - 2 * span, now);
  return Number.isFinite(min) ? (min + max) / 2 : 0;
}

/**
 * Where the screen ends, so that the newest crossing of the trigger level in the trigger's
 * direction sits in the middle of the screen with a whole screen of recording round it. Null when
 * there's no such crossing.
 */
export function findTrigger(
  trace: Samples | undefined,
  now: number,
  span: number,
  edge: TriggerEdge,
  level: number,
): number | null {
  if (!trace?.t.length) return null;
  const first = trace.t[0];
  const above = (v: number): boolean => (edge === 'rise' ? v > level : v < level);
  // The trigger point can be no later than half a screen before now.
  let i = sampleBefore(trace, now - span / 2) + 1;
  for (i = Math.min(i, trace.t.length - 1); i > 0; i--) {
    const a = trace.v[i - 1];
    const b = trace.v[i];
    if (!Number.isFinite(a) || !Number.isFinite(b) || above(a) || !above(b)) continue;
    const t0 = trace.t[i - 1];
    const t1 = trace.t[i];
    const at = t1 > t0 ? t0 + ((level - a) / (b - a)) * (t1 - t0) : t1;
    if (at - span / 2 < first) return null;
    if (at + span / 2 <= now + 1e-12) return at + span / 2;
  }
  return null;
}

/* ----------------------------------------------------------------------- measurements --- */

export interface Measurements {
  min: number;
  max: number;
  /** Peak to peak. */
  pp: number;
  /** Average over the screen. */
  mean: number;
  rms: number;
  /** Seconds per cycle, from whole cycles on screen; NaN with fewer than two. */
  period: number;
  frequency: number;
  /** Fraction of each cycle above the middle level. */
  duty: number;
}

/**
 * What a scope's measure button shows for the stretch on screen: extremes, average, RMS, and the
 * period, frequency and duty cycle from crossings of the middle level (with a little hysteresis, so
 * noise on a slow edge isn't counted as extra cycles).
 */
export function measure(trace: Samples | undefined, start: number, end: number): Measurements | null {
  if (!trace?.t.length || !(end > start)) return null;
  // The recording on screen as straight segments, starting and ending at the screen's edges.
  const ts: number[] = [start];
  const vs: number[] = [valueAt(trace, start)];
  for (let i = Math.max(0, sampleBefore(trace, start) + 1); i < trace.t.length && trace.t[i] < end; i++) {
    ts.push(trace.t[i]);
    vs.push(trace.v[i]);
  }
  ts.push(end);
  vs.push(valueAt(trace, end));
  if (vs.some((v) => !Number.isFinite(v))) return null;

  let min = Infinity;
  let max = -Infinity;
  let area = 0;
  let square = 0;
  for (let i = 0; i < vs.length; i++) {
    min = Math.min(min, vs[i]);
    max = Math.max(max, vs[i]);
    if (i === 0) continue;
    const dt = ts[i] - ts[i - 1];
    const a = vs[i - 1];
    const b = vs[i];
    area += ((a + b) / 2) * dt;
    square += ((a * a + a * b + b * b) / 3) * dt;
  }
  const span = end - start;
  const mean = area / span;
  const rms = Math.sqrt(Math.max(0, square / span));

  let period = NaN;
  let duty = NaN;
  const pp = max - min;
  if (pp > 0.05) {
    const mid = (min + max) / 2;
    const band = pp * 0.1;
    // Times the signal goes up through the middle, and down through it, with hysteresis.
    const rises: number[] = [];
    const falls: number[] = [];
    let state: 'low' | 'high' | null = vs[0] > mid + band ? 'high' : vs[0] < mid - band ? 'low' : null;
    let lastCross = NaN;
    for (let i = 1; i < vs.length; i++) {
      const a = vs[i - 1];
      const b = vs[i];
      const cross = (): number => (b === a ? ts[i] : ts[i - 1] + ((mid - a) / (b - a)) * (ts[i] - ts[i - 1]));
      if ((a - mid) * (b - mid) <= 0 && a !== b) lastCross = cross();
      if (state !== 'high' && b > mid + band) {
        if (state === 'low') rises.push(lastCross);
        state = 'high';
      } else if (state !== 'low' && b < mid - band) {
        if (state === 'high') falls.push(lastCross);
        state = 'low';
      }
    }
    if (rises.length >= 2) {
      period = (rises[rises.length - 1] - rises[0]) / (rises.length - 1);
      // Time high in each whole cycle: from a rise to the fall after it.
      let high = 0;
      let cycles = 0;
      for (let k = 0; k + 1 < rises.length; k++) {
        const fall = falls.find((f) => f > rises[k] && f < rises[k + 1]);
        if (fall === undefined) continue;
        high += fall - rises[k];
        cycles++;
      }
      if (cycles) duty = high / cycles / period;
    }
  }
  return { min, max, pp, mean, rms, period, frequency: 1 / period, duty };
}

/**
 * Settings that show a signal well, as a scope's Auto button picks them: the volts per division
 * that fit its swing on screen, and the time across that shows about three cycles (or, for a
 * signal that isn't repeating, the latest second).
 */
export function autoset(
  trace: Samples | undefined,
  now: number,
): { timebase: number; voltsPerDiv: number; level: number } | null {
  if (!trace?.t.length) return null;
  const look = Math.min(2, now - trace.t[0]);
  if (!(look > 0)) return null;
  const { min, max } = extremes(trace, now - look, now);
  if (!Number.isFinite(min)) return null;
  const reach = Math.max(Math.abs(min), Math.abs(max), 0.1);
  // 0 V in the middle: the swing needs to fit in the four divisions above (or below) it.
  const voltsPerDiv =
    SCOPE_VOLTS_PER_DIV.find((v) => v * (SCOPE_DIV_Y / 2) * 0.9 >= reach) ??
    SCOPE_VOLTS_PER_DIV[SCOPE_VOLTS_PER_DIV.length - 1];
  const m = measure(trace, now - look, now);
  const timebase =
    m && Number.isFinite(m.period) ? nearestStep(SCOPE_TIMEBASES, m.period * 3) : nearestStep(SCOPE_TIMEBASES, 1);
  return { timebase, voltsPerDiv, level: (min + max) / 2 };
}

/** Time per division, written the way a scope shows it: 5 µs, 20 ms, 1 s. */
export function formatTime(seconds: number, space = ' '): string {
  const a = Math.abs(seconds);
  const [scale, unit] = a >= 1 ? [1, 's'] : a >= 1e-3 ? [1e3, 'ms'] : a >= 1e-6 ? [1e6, 'µs'] : [1e9, 'ns'];
  return `${+(seconds * scale).toPrecision(3)}${space}${unit}`;
}

export function formatVolts(volts: number, space = ' '): string {
  if (!Number.isFinite(volts)) return '—';
  const a = Math.abs(volts);
  return a >= 1 || a === 0 ? `${+volts.toFixed(a >= 10 ? 1 : 2)}${space}V` : `${+(volts * 1000).toFixed(0)}${space}mV`;
}

export function formatFrequency(hz: number, space = ' '): string {
  if (!Number.isFinite(hz) || hz <= 0) return '—';
  const [scale, unit] = hz >= 1e6 ? [1e-6, 'MHz'] : hz >= 1e3 ? [1e-3, 'kHz'] : [1, 'Hz'];
  return `${+(hz * scale).toPrecision(4)}${space}${unit}`;
}

export const scopeTerminalPos = (scope: { x: number; z: number }, name: ScopeTerminalName) => {
  const terminal = SCOPE_TERMINALS[name];
  return { x: scope.x + terminal.x, y: terminal.y, z: scope.z + terminal.z };
};
