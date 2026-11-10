// The bench power supply's shape and terminals: shared by the netlist (its terminals are holes),
// the simulator and the 3D model.

import type { Hole } from './breadboard';

export const SUPPLY_MAX_VOLTS = 30;
export const SUPPLY_MAX_AMPS = 5;
export const SUPPLY_MIN_AMPS = 0.1;

/** Case size, mm: x across the front, y up, z front to back. The front faces +z. */
export const SUPPLY_SIZE = { x: 86, y: 52, z: 104 } as const;

/** Binding posts on the front panel, relative to the supply's centre on the desk. */
export const SUPPLY_TERMINALS = {
  '+': { x: -29, y: 18, z: SUPPLY_SIZE.z / 2 + 8 },
  '-': { x: -17, y: 18, z: SUPPLY_SIZE.z / 2 + 8 },
} as const;
export type TerminalName = keyof typeof SUPPLY_TERMINALS;

const terminal = (name: TerminalName, index: number): Hole => ({
  index,
  name,
  kind: 'rail',
  col: -1,
  row: -1,
  x: SUPPLY_TERMINALS[name].x,
  z: SUPPLY_TERMINALS[name].z,
  group: index,
});

/** What the netlist needs of anything with holes. */
export interface HoleSet {
  readonly holes: readonly Hole[];
  readonly groups: readonly (readonly number[])[];
  hole(name: string): Hole | undefined;
}

const TERMINAL_HOLES = [terminal('+', 0), terminal('-', 1)];

export const SUPPLY_HOLES: HoleSet = {
  holes: TERMINAL_HOLES,
  groups: [[0], [1]],
  hole: (name) => TERMINAL_HOLES.find((h) => h.name === name),
};

export const isTerminal = (hole: string): hole is TerminalName => hole === '+' || hole === '-';
