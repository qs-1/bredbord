// A breadboard to build test circuits on: holes by name, chips wired to the rails, and a simulator to run them.

import { boardSpec, RAIL_GRID_ROW, type RailName } from '../../src/engine/breadboard';
import { createDoc, type CircuitDoc, type HoleRef } from '../../src/engine/circuit';
import { Connectivity } from '../../src/engine/netlist';
import { dipPinHoles, PARTS, type DipDef } from '../../src/engine/parts';
import { CHIP_MODELS } from '../../src/engine/sim/chips';
import { Simulator, type SimResult } from '../../src/engine/sim/simulator';

export const h = (hole: string): HoleRef => ({ board: 'b1', hole });
export const spec = boardSpec('bb830');
export const rail = (name: RailName, col: number): string => spec.holeAt(col, RAIL_GRID_ROW[name])!.name;

/** Hole of a chip pin, for a chip whose pin 1 sits in column `start` (0-based). */
export const pinHole = (def: string, start: number, pin: number): string => {
  const p = dipPinHoles(PARTS[def] as DipDef, start, false)[pin - 1];
  return `${p.row}${p.col + 1}`;
};
/** Another hole in the same five-hole strip as `hole`. */
export const sameStrip = (hole: string): string => (hole[0] <= 'e' ? `a${hole.slice(1)}` : `j${hole.slice(1)}`);
/** A free rail hole next to `col` (rail columns come in fives with gaps). */
export const railNear = (name: RailName, col: number): string => {
  for (let d = 0; d < 6; d++) {
    const hole = spec.holeAt(col + d, RAIL_GRID_ROW[name]);
    if (hole) return hole.name;
  }
  throw new Error('no rail hole');
};

export class Bench {
  readonly doc: CircuitDoc = createDoc();
  readonly sim = new Simulator();
  private n = 0;
  private railUsed = new Set<string>();

  constructor(power = true) {
    this.doc.parts.push({
      id: 'pwr',
      def: 'power',
      pins: [h('T+1'), h('T-1'), h('B+1'), h('B-1')],
      state: power ? 1 : 0,
    });
  }

  wire(a: string, b: string): this {
    this.doc.wires.push({ id: `w${this.n++}`, a: h(a), b: h(b), color: 'red' });
    return this;
  }

  /** A wire from `hole` to the nearest free hole of a rail. */
  toRail(hole: string, name: RailName, near = 30): this {
    for (let col = near; col < 63; col++) {
      const r = spec.holeAt(col, RAIL_GRID_ROW[name]);
      if (r && !this.railUsed.has(r.name)) {
        this.railUsed.add(r.name);
        return this.wire(hole, r.name);
      }
    }
    throw new Error('rail full');
  }

  part(id: string, def: string, holes: string[], extra: { value?: number; state?: number; data?: string } = {}): this {
    this.doc.parts.push({ id, def, pins: holes.map(h), ...extra });
    return this;
  }

  /** A DIP chip with pin 1 in column `start`, wired to + and − (unless told not to). */
  chip(id: string, def: string, start: number, powered = true): this {
    const d = PARTS[def] as DipDef;
    this.part(
      id,
      def,
      dipPinHoles(d, start, false).map((p) => `${p.row}${p.col + 1}`),
    );
    if (powered) {
      const model = CHIP_MODELS[def];
      this.toRail(
        sameStrip(pinHole(def, start, model.vcc)),
        pinHole(def, start, model.vcc)[0] <= 'e' ? 'T+' : 'B+',
        start,
      );
      this.toRail(
        sameStrip(pinHole(def, start, model.gnd)),
        pinHole(def, start, model.gnd)[0] <= 'e' ? 'T-' : 'B-',
        start,
      );
    }
    return this;
  }

  run(pressed: string[] = []): SimResult {
    return this.sim.run(this.doc, new Connectivity(this.doc), new Set(pressed));
  }

  /** Volts at a hole right now. */
  v(hole: string): number {
    return this.sim.snapshot().volts(h(hole)) ?? NaN;
  }
}
