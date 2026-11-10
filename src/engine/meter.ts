import type { HoleSet } from './supply';

type Hole = HoleSet['holes'][number];

/**
 * Bench multimeter: a handheld-style DMM in a rubber holster, lying flat on the desk. Four jacks take ordinary wires, as on most real meters:
 * 10A and mA for current (the meter goes in the circuit's path), COM, and V for everything else.
 *
 * Everything the view draws and everything a wire attaches to is derived from the numbers in
 * this file, so the terminals always sit exactly on the jacks.
 */

/**
 * Dial positions: off, DC volts, AC volts, frequency, resistance, diode test, continuity,
 * milliamps and amps.
 */
export type MeterMode = 'off' | 'dcv' | 'acv' | 'hz' | 'ohm' | 'diode' | 'cont' | 'ma' | 'a';
/** Dial positions, clockwise, in the order a click on the dial steps through them. */
export const METER_MODES: readonly MeterMode[] = ['off', 'dcv', 'acv', 'hz', 'ohm', 'diode', 'cont', 'ma', 'a'];
/** Degrees between neighbouring dial positions. */
const DIAL_STEP = 30;
/** Pointer angle for each dial position, radians clockwise from "up the meter". */
export const DIAL_ANGLE = Object.fromEntries(
  METER_MODES.map((m, i) => [m, ((i - (METER_MODES.length - 1) / 2) * DIAL_STEP * Math.PI) / 180]),
) as Record<MeterMode, number>;
/** The dial turned `by` positions clockwise (negative: back), going round past the ends. */
export const nextMode = (m: MeterMode, by = 1): MeterMode => {
  const n = METER_MODES.length;
  return METER_MODES[(((METER_MODES.indexOf(m) + by) % n) + n) % n] ?? 'off';
};
export const isMeterMode = (m: unknown): m is MeterMode => METER_MODES.includes(m as MeterMode);

/** What each dial position is called, for menus and tooltips. */
export const MODE_NAMES: Record<MeterMode, string> = {
  off: 'Off',
  dcv: 'DC volts',
  acv: 'AC volts',
  hz: 'Frequency',
  ohm: 'Resistance',
  diode: 'Diode test',
  cont: 'Continuity',
  ma: 'Milliamps',
  a: 'Amps',
};

/** Modes where the meter itself pushes a small current out of the V jack to measure with. */
export const isOhmsMode = (m: MeterMode): m is 'ohm' | 'diode' | 'cont' => m === 'ohm' || m === 'diode' || m === 'cont';

/*
 * The meter's insides, as the simulation sees them. The current jacks are always joined to COM
 * through a shunt (a tiny resistor the meter reads the current across), whatever the dial says,
 * as in a real meter: that's why a lead left in a current jack shorts whatever it's put across.
 */
/** Shunt between the mA jack and COM, ohms. */
export const SHUNT_MA = 1;
/** Shunt between the 10A jack and COM, ohms. */
export const SHUNT_A = 0.01;
/** Most each current jack reads before it shows OL, amps. */
export const MAX_MA = 0.4;
export const MAX_A = 10;
/**
 * Resistance and continuity: the V jack is driven from TEST_VOLTS through TEST_OHMS (COM is 0 V),
 * and the reading worked back from the voltage that gives across the leads. Low enough that a
 * silicon diode doesn't conduct, as on real meters.
 */
export const TEST_VOLTS = 0.45;
export const TEST_OHMS = 10_000;
/** Diode test: about a milliamp, from up to 3 V, as real meters do it. */
export const DIODE_VOLTS = 3;
export const DIODE_OHMS = 2_200;
/** Continuity shows below this many ohms. */
export const CONTINUITY_OHMS = 50;
/** AC volts and frequency are measured over this much circuit time, seconds. */
export const AC_WINDOW = 1;

/** The test source a mode drives the V jack with: volts and series ohms. */
export const testSource = (mode: 'ohm' | 'diode' | 'cont'): { volts: number; ohms: number } =>
  mode === 'diode' ? { volts: DIODE_VOLTS, ohms: DIODE_OHMS } : { volts: TEST_VOLTS, ohms: TEST_OHMS };

/* ------------------------------------------------------------------------------------------
 * Geometry. "Body space" is the meter lying flat, centred on the origin: x across,
 * y up from the underside, z along the length with the display at -z and the jacks at +z.
 * ---------------------------------------------------------------------------------------- */

export const METER_BODY = { x: 80, y: 28, z: 150 } as const;
/** Display and desk footprint scale relative to the model's body-space dimensions. */
export const METER_SCALE = 0.65;
/** Lies flat on its back on the desk; kept as a parameter so everything derived from it still works. */
export const METER_TILT = 0;
const COS = Math.cos(METER_TILT);
const SIN = Math.sin(METER_TILT);
/** Raises the tilted body so its lowest edge rests on the desk. */
export const METER_LIFT = (METER_BODY.z / 2) * SIN;

/** Height of the printed face plate above the underside, body space. */
export const METER_FACE_Y = METER_BODY.y + 0.4;
export const METER_JACK_H = 4;
/** Highest point above the underside: the top of the rotary switch's grip. */
export const METER_TOP = METER_FACE_Y + 11;

export const METER_LAYOUT = {
  bezel: { z: -49, w: 64, h: 32 },
  lcd: { z: -49, w: 58, h: 26 },
  /** Push buttons under the display, in METER_BUTTONS order. */
  buttons: { z: -28, x: [-22.5, -7.5, 7.5, 22.5] },
  dial: { z: 9 },
  /** Left to right as on most handhelds: 10A, mA, COM, V. */
  jack: { z: 55, x: { A: -26.5, mA: -9, COM: 9, V: 26.5 } },
} as const;

/** Body space -> offsets from the meter's desk position (tilt applied, resting on the desk). */
export const meterToDesk = (x: number, y: number, z: number) => ({
  x,
  y: y * COS - z * SIN + METER_LIFT,
  z: y * SIN + z * COS,
});

/** Bounding box (mm) of the tilted meter, for shadow bounds and camera framing. */
export const METER_SIZE = (() => {
  const hz = METER_BODY.z / 2;
  const top = METER_TOP * COS + hz * SIN + METER_LIFT;
  const zFar = METER_TOP * SIN + hz * COS;
  return {
    x: METER_BODY.x * METER_SCALE,
    y: Math.ceil(top * METER_SCALE),
    z: Math.ceil(zFar * 2 * METER_SCALE),
  } as const;
})();

export type MeterTerminalName = keyof typeof METER_LAYOUT.jack.x;

const jackTop = METER_FACE_Y + METER_JACK_H;
const scaledTerminal = (name: MeterTerminalName) => {
  const p = meterToDesk(METER_LAYOUT.jack.x[name], jackTop, METER_LAYOUT.jack.z);
  return { x: p.x * METER_SCALE, y: p.y * METER_SCALE, z: p.z * METER_SCALE };
};
export const METER_TERMINALS = {
  A: scaledTerminal('A'),
  mA: scaledTerminal('mA'),
  COM: scaledTerminal('COM'),
  V: scaledTerminal('V'),
} as const;

export const isMeterTerminal = (hole: string): hole is MeterTerminalName => Object.hasOwn(METER_TERMINALS, hole);

/** The jack a mode reads besides COM. */
export const MODE_JACK: Record<MeterMode, MeterTerminalName> = {
  off: 'V',
  dcv: 'V',
  acv: 'V',
  hz: 'V',
  ohm: 'V',
  diode: 'V',
  cont: 'V',
  ma: 'mA',
  a: 'A',
};

/** World position of one of a meter's terminals. */
export const meterTerminalPos = (m: { x: number; z: number }, name: MeterTerminalName) => {
  const t = METER_TERMINALS[name];
  return { x: m.x + t.x, y: t.y, z: m.z + t.z };
};

const terminal = (name: MeterTerminalName, index: number): Hole => ({
  index,
  name,
  kind: 'rail',
  col: -1,
  row: -1,
  x: METER_TERMINALS[name].x,
  z: METER_TERMINALS[name].z,
  group: index,
});

/** COM and V first, numbered as older saves had them. */
const TERMINAL_HOLES = [terminal('COM', 0), terminal('V', 1), terminal('mA', 2), terminal('A', 3)];

/**
 * Four separate jacks. Between V and COM the meter is an ideal voltmeter, so it never loads the
 * circuit; the simulation adds the shunts from the current jacks to COM.
 */
export const METER_HOLES: HoleSet = {
  holes: TERMINAL_HOLES,
  groups: [[0], [1], [2], [3]],
  hole: (name) => TERMINAL_HOLES.find((h) => h.name === name),
};

/* ------------------------------------------------------------------------------------------
 * Display. 3½ digits (up to 1999 counts), auto-ranging, as on a cheap handheld meter.
 * ---------------------------------------------------------------------------------------- */

export type MeterUnit = 'V' | 'mV' | 'Ω' | 'kΩ' | 'MΩ' | 'Hz' | 'kHz' | 'MHz' | 'mA' | 'A';

/** The little marks around the digits. */
export interface MeterFlags {
  dc?: boolean;
  ac?: boolean;
  diode?: boolean;
  /** In continuity mode. */
  cont?: boolean;
  /** Continuity found: a real meter beeps. */
  beep?: boolean;
  /** Picking its own range (off: RANGE has fixed it). */
  auto?: boolean;
  hold?: boolean;
  max?: boolean;
  min?: boolean;
}

export interface MeterDisplay {
  text: string;
  unit: MeterUnit;
  flags?: MeterFlags;
}

type Ranges = readonly (readonly [MeterUnit, number, readonly number[]])[];

/**
 * Shows `x` in the first unit (with the most decimals listed for it) where it fits in 1999 counts;
 * OL in the last unit if it fits nowhere.
 */
function autorange(x: number, units: Ranges, signed: boolean): MeterDisplay {
  const last = units[units.length - 1]![0];
  if (!Number.isFinite(x)) return { text: 'OL', unit: last };
  const a = Math.abs(x);
  for (const [unit, scale, decimals] of units) {
    for (const dec of decimals) {
      const counts = Math.round((a / scale) * 10 ** dec);
      if (counts > 1999) continue;
      const sign = signed && x < 0 && counts > 0 ? '-' : '';
      return { text: sign + (counts / 10 ** dec).toFixed(dec), unit };
    }
  }
  return { text: 'OL', unit: last };
}

const VOLT_RANGES: Ranges = [
  ['mV', 1e-3, [1]],
  ['V', 1, [3, 2, 1]],
];
const OHM_RANGES: Ranges = [
  ['Ω', 1, [1]],
  ['kΩ', 1e3, [3, 2, 1]],
  ['MΩ', 1e6, [3, 2]],
];
const HERTZ_RANGES: Ranges = [
  ['Hz', 1, [3, 2, 1]],
  ['kHz', 1e3, [3, 2, 1]],
  ['MHz', 1e6, [3]],
];

export function formatVolts(volts: number): MeterDisplay {
  if (!Number.isFinite(volts)) return { text: 'OL', unit: 'V' };
  const a = Math.abs(volts);
  if (a < 5e-5) return { text: '0.000', unit: 'V' };
  // The top range goes to 600 V in whole volts.
  if (Math.round(a * 10) > 1999)
    return a < 600.5
      ? { text: (volts < 0 ? '-' : '') + Math.round(a).toFixed(0), unit: 'V' }
      : { text: 'OL', unit: 'V' };
  return autorange(volts, VOLT_RANGES, true);
}

export const formatOhms = (ohms: number): MeterDisplay => autorange(ohms, OHM_RANGES, false);

export function formatHertz(hz: number): MeterDisplay {
  if (!(hz > 0)) return { text: '0.000', unit: 'Hz' };
  return autorange(hz, HERTZ_RANGES, false);
}

export function formatAmps(amps: number, jack: 'mA' | 'A'): MeterDisplay {
  const a = Math.abs(amps);
  if (jack === 'mA') {
    if (!(a <= MAX_MA)) return { text: 'OL', unit: 'mA' };
    // The top range goes to 400 mA in whole milliamps.
    if (Math.round(a * 1e4) > 1999)
      return { text: (amps < 0 ? '-' : '') + Math.round(a * 1000).toFixed(0), unit: 'mA' };
    return autorange(amps, [['mA', 1e-3, [3, 2, 1]]], true);
  }
  if (!(a <= MAX_A)) return { text: 'OL', unit: 'A' };
  return autorange(amps, [['A', 1, [3, 2]]], true);
}

/** Ohms across the leads from the voltage there while the meter drives them from `vt` through `rs`. */
export const ohmsFromVolts = (v: number, vt = TEST_VOLTS, rs = TEST_OHMS): number =>
  !Number.isFinite(v) || v >= vt * 0.99999 ? Infinity : Math.max(0, (rs * v) / (vt - v));

/** What the meter has to go on. */
export interface MeterInputs {
  /**
   * Volts across the leads: V minus COM now (DC volts), its RMS with the steady part taken off (AC
   * volts), or with the meter's own test current flowing (resistance, diode, continuity).
   */
  volts: number;
  /** Into the current jack the dial is on and out of COM, amps. */
  amps: number;
  /** Cycles a second of V minus COM over the last AC_WINDOW. */
  hertz: number;
}

/** A fixed range: unit, its size in base units, decimals shown, most counts it shows. */
type FixedRange = readonly [MeterUnit, number, number, number];
const fixed = (r: Ranges): FixedRange[] => r.flatMap(([u, scale, ds]) => ds.map((d) => [u, scale, d, 1999] as const));
const VOLT_FIXED: readonly FixedRange[] = [...fixed(VOLT_RANGES), ['V', 1, 0, 600]];

/** The ranges RANGE steps through, smallest first, for the dial positions that have them. */
export const METER_RANGES: Partial<Record<MeterMode, readonly FixedRange[]>> = {
  dcv: VOLT_FIXED,
  acv: VOLT_FIXED,
  ohm: fixed(OHM_RANGES),
  ma: [...fixed([['mA', 1e-3, [3, 2, 1]]]), ['mA', 1e-3, 0, 400]],
  a: fixed([['A', 1, [3, 2]]]),
};

/** `x` shown on one fixed range; OL if it doesn't fit. */
function onRange(x: number, [unit, scale, dec, max]: FixedRange, signed: boolean): MeterDisplay {
  if (!Number.isFinite(x)) return { text: 'OL', unit };
  const counts = Math.round((Math.abs(x) / scale) * 10 ** dec);
  if (counts > max) return { text: 'OL', unit };
  const sign = signed && x < 0 && counts > 0 ? '-' : '';
  return { text: sign + (counts / 10 ** dec).toFixed(dec), unit };
}

/** The range auto-ranging would pick for `x`: the first it fits on, else the last. */
function autoRangeIndex(mode: MeterMode, x: number): number | null {
  const ranges = METER_RANGES[mode];
  if (!ranges) return null;
  const i = ranges.findIndex(
    ([, scale, dec, max]) => Number.isFinite(x) && Math.round((Math.abs(x) / scale) * 10 ** dec) <= max,
  );
  return i < 0 ? ranges.length - 1 : i;
}

/** The quantity a dial position reads, in base units (volts, ohms, hertz, amps). */
export function meterValue(mode: MeterMode, r: MeterInputs): number {
  switch (mode) {
    case 'off':
      return 0;
    case 'dcv':
    case 'diode':
      return r.volts;
    case 'acv':
      return Math.abs(r.volts);
    case 'hz':
      return r.hertz;
    case 'ohm':
    case 'cont':
      return ohmsFromVolts(r.volts);
    case 'ma':
    case 'a':
      return r.amps;
  }
}

/** How a dial position shows a value, auto-ranging or (`range` set) on one fixed range. Null when it's off. */
export function displayValue(mode: MeterMode, v: number, range: number | null = null): MeterDisplay | null {
  const fixedRange = range === null ? undefined : METER_RANGES[mode]?.[range];
  const auto = !fixedRange;
  switch (mode) {
    case 'off':
      return null;
    case 'dcv':
      return { ...(fixedRange ? onRange(v, fixedRange, true) : formatVolts(v)), flags: { dc: true, auto } };
    case 'acv':
      return { ...(fixedRange ? onRange(v, fixedRange, false) : formatVolts(v)), flags: { ac: true, auto } };
    case 'hz':
      return { ...formatHertz(v), flags: { auto: true } };
    case 'ohm':
      return { ...(fixedRange ? onRange(v, fixedRange, false) : formatOhms(v)), flags: { auto } };
    case 'diode': {
      // Across an open lead, or a diode the wrong way round, the test voltage reads OL.
      const d: MeterDisplay =
        Number.isFinite(v) && v < 2 ? { text: Math.max(0, v).toFixed(3), unit: 'V' } : { text: 'OL', unit: 'V' };
      return { ...d, flags: { diode: true } };
    }
    case 'cont': {
      const d: MeterDisplay = Math.round(v * 10) <= 1999 ? formatOhms(v) : { text: 'OL', unit: 'Ω' };
      return { ...d, flags: { cont: true, beep: v < CONTINUITY_OHMS } };
    }
    case 'ma':
    case 'a': {
      const over = !(Math.abs(v) <= (mode === 'ma' ? MAX_MA : MAX_A));
      const d: MeterDisplay = fixedRange
        ? over
          ? { text: 'OL', unit: fixedRange[0] }
          : onRange(v, fixedRange, true)
        : formatAmps(v, mode === 'ma' ? 'mA' : 'A');
      return { ...d, flags: { dc: true, auto } };
    }
  }
}

/** The display for a dial position. Null when it's off. */
export function meterDisplay(mode: MeterMode, r: MeterInputs, range: number | null = null): MeterDisplay | null {
  return displayValue(mode, meterValue(mode, r), range);
}

/* ------------------------------------------------------------------------------------------
 * Buttons under the display. What they're set to isn't saved: a loaded circuit starts with
 * auto range, no hold and no max/min, and turning the dial clears all but the light.
 * ---------------------------------------------------------------------------------------- */

/** Left to right: backlight, RANGE (hold it down for auto), HOLD, MAX/MIN. */
export type MeterButton = 'light' | 'range' | 'hold' | 'maxmin';
export const METER_BUTTONS: readonly MeterButton[] = ['light', 'range', 'hold', 'maxmin'];
export const BUTTON_NAMES: Record<MeterButton, string> = {
  light: 'Backlight',
  range: 'Range',
  hold: 'Hold',
  maxmin: 'Max / min',
};
/** How long RANGE is held down to go back to auto, ms. */
export const RANGE_HOLD_MS = 1000;

export interface MeterPanel {
  /** Index into METER_RANGES for the dial position, or null for auto. */
  range: number | null;
  /** The frozen display while HOLD is on. */
  hold: MeterDisplay | null;
  record: 'off' | 'max' | 'min';
  max: number;
  min: number;
  light: boolean;
}

export const newPanel = (light = false): MeterPanel => ({
  range: null,
  hold: null,
  record: 'off',
  max: -Infinity,
  min: Infinity,
  light,
});

/** What the display shows, keeping the highest and lowest reading while MAX/MIN is on. */
export function readPanel(p: MeterPanel, mode: MeterMode, r: MeterInputs): MeterDisplay | null {
  const v = meterValue(mode, r);
  if (p.record !== 'off' && !Number.isNaN(v)) {
    p.max = Math.max(p.max, v);
    p.min = Math.min(p.min, v);
  }
  if (p.hold) return mode === 'off' ? null : { ...p.hold, flags: { ...p.hold.flags, hold: true } };
  const d = displayValue(mode, p.record === 'max' ? p.max : p.record === 'min' ? p.min : v, p.range);
  if (d && p.record !== 'off') d.flags = { ...d.flags, [p.record]: true };
  return d;
}

/** A short press of one of the buttons. */
export function pressButton(p: MeterPanel, b: MeterButton, mode: MeterMode, r: MeterInputs): void {
  if (b === 'light') {
    p.light = !p.light;
    return;
  }
  if (mode === 'off') return;
  switch (b) {
    case 'range': {
      const n = METER_RANGES[mode]?.length;
      if (!n) return;
      // The first press keeps the range auto had picked; each one after steps up, round to the smallest.
      p.range = p.range === null ? autoRangeIndex(mode, meterValue(mode, r)) : (p.range + 1) % n;
      return;
    }
    case 'hold':
      if (p.hold) p.hold = null;
      else {
        const d = readPanel(p, mode, r);
        p.hold = d && { ...d, flags: { ...d.flags } };
      }
      return;
    case 'maxmin': {
      p.record = p.record === 'off' ? 'max' : p.record === 'max' ? 'min' : 'off';
      if (p.record === 'max') {
        const v = meterValue(mode, r);
        p.max = p.min = Number.isNaN(v) ? 0 : v;
      }
      return;
    }
  }
}

/** RANGE held down: back to auto-ranging. */
export const autoRange = (p: MeterPanel): void => {
  p.range = null;
};
