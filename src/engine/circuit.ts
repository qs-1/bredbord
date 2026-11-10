// The saved document: boards on the desk, wires and components plugged into holes.

import type { BoardType } from './breadboard';
import type { ScopeTrigger } from './scope';
import type { MeterMode } from './meter';

export type Id = string;

export interface HoleRef {
  readonly board: Id;
  readonly hole: string;
}

export interface BoardDoc {
  id: Id;
  type: BoardType;
  /** Board centre on the desk, mm. */
  x: number;
  z: number;
  /** A rail strip clipped to this board's edge: it moves with the board. */
  on?: Id;
}

export const WIRE_COLORS = ['red', 'black', 'blue', 'yellow', 'green', 'orange', 'white', 'purple'] as const;
export type WireColor = (typeof WIRE_COLORS)[number];

/** A spot on the desk, mm. */
export interface DeskPoint {
  x: number;
  z: number;
}

export interface WireDoc {
  id: Id;
  a: HoleRef;
  b: HoleRef;
  color: WireColor;
  /** Bends between the ends, in order from a to b. */
  points?: DeskPoint[];
}

/** A component plugged into holes. `pins[i]` is the hole for pin i + 1 (LEDs: anode, then cathode). */
export interface PartDoc {
  id: Id;
  def: string;
  pins: HoleRef[];
  /** Ohms for resistors and potentiometers, farads for capacitors, millimetres across for LEDs. */
  value?: number;
  /** Switch positions as bits (power module, DIP and slide switches), or a potentiometer's knob (0–1000). */
  state?: number;
  /** What an EEPROM holds, base64. */
  data?: string;
  /** Initial contents for volatile RAM chips, as base64; this does not make them non-volatile. */
  initialMemory?: string;
  /** Compiled ATmega328P program memory, base64. */
  firmware?: string;
  /** Original firmware filename, for the Nano inspector. */
  firmwareName?: string;
  /** Assembly source for a ROM, kept so it can be edited again. */
  source?: string;
}

/**
 * A bench power supply standing on the desk. Its terminals are holes like any other, named '+' and
 * '-' on a "board" with the supply's id, so leads to it are ordinary wires.
 */
export interface SupplyDoc {
  id: Id;
  /** Centre on the desk, mm. */
  x: number;
  z: number;
  /** Output voltage, 0–30 V. */
  volts: number;
  /** The most current it gives, amps (0.1–5): past this it lowers its voltage to hold the current there. */
  limit: number;
  /** Its output switched off: the terminals carry nothing until it's switched back on. */
  off?: boolean;
}

export interface MeterDoc {
  id: Id;
  /** Centre on the desk, mm. */
  x: number;
  z: number;
  mode: MeterMode;
}

/** A two-channel, high-impedance oscilloscope standing on the desk. */
export interface ScopeDoc {
  id: Id;
  /** Centre on the desk, mm. */
  x: number;
  z: number;
  /** Seconds across the screen (ten divisions), one of SCOPE_TIMEBASES. */
  timebase: number;
  /** CH1's volts per division, one of SCOPE_VOLTS_PER_DIV. */
  voltsPerDiv: number;
  /** CH2's volts per division; CH1's when unset (older saves had one knob for both). */
  voltsPerDiv2?: number;
  /** Where each channel's 0 V line sits, in divisions above the middle of the screen. */
  offset1?: number;
  offset2?: number;
  /** A channel switched off the screen. */
  off1?: boolean;
  off2?: boolean;
  /** AC coupling: the channel's average is taken off, so a small ripple on a steady voltage shows. */
  ac1?: boolean;
  ac2?: boolean;
  /** What the picture locks onto; the default is CH1 rising through the middle of its swing. */
  trigger?: ScopeTrigger;
}

/** Which way a probe's level has to go to pause the circuit. */
export type Edge = 'rise' | 'fall' | 'any';

/** A logic probe clipped onto a hole, shown as a channel in the probes panel. */
export interface ProbeDoc {
  id: Id;
  at: HoleRef;
  /** A breakpoint: the circuit pauses when the probe's level goes this way. */
  break?: Edge;
}

export interface CircuitDoc {
  version: 1;
  name?: string;
  boards: BoardDoc[];
  wires: WireDoc[];
  parts: PartDoc[];
  probes?: ProbeDoc[];
  supplies?: SupplyDoc[];
  meters?: MeterDoc[];
  scopes?: ScopeDoc[];
  nextId: number;
}

export const holeKey = (r: HoleRef): string => `${r.board}:${r.hole}`;
export const sameHole = (a: HoleRef, b: HoleRef): boolean => a.board === b.board && a.hole === b.hole;

/** A clear desk: what a new circuit starts from. */
export function emptyDoc(): CircuitDoc {
  return { version: 1, boards: [], wires: [], parts: [], nextId: 1 };
}

/** One breadboard and nothing on it (tests and benchmarks build on this). */
export function createDoc(): CircuitDoc {
  return { version: 1, boards: [{ id: 'b1', type: 'bb830', x: 0, z: 0 }], wires: [], parts: [], nextId: 2 };
}

/** Hands out a fresh id and advances the document's counter. */
export function allocId(doc: CircuitDoc, prefix: string): Id {
  return `${prefix}${doc.nextId++}`;
}

export interface Occupant {
  kind: 'wire' | 'part';
  id: Id;
  /** Wire end (0 = a, 1 = b) or part pin index. */
  pin: number;
}

/** Which lead sits in each hole. A real breadboard hole takes exactly one lead. */
export function occupancy(doc: CircuitDoc): Map<string, Occupant> {
  const map = new Map<string, Occupant>();
  for (const w of doc.wires) {
    map.set(holeKey(w.a), { kind: 'wire', id: w.id, pin: 0 });
    map.set(holeKey(w.b), { kind: 'wire', id: w.id, pin: 1 });
  }
  for (const p of doc.parts) p.pins.forEach((ref, pin) => map.set(holeKey(ref), { kind: 'part', id: p.id, pin }));
  return map;
}
