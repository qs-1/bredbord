// A 555 clock, live on the landing page's board: it blinks an LED, and the knob sets how fast. The
// real simulator runs it. Powered from the rails with nothing drawn feeding them.

import * as THREE from 'three';
import { BOARD_HEIGHT as H, boardSpec, RAIL_GRID_ROW, type RailName } from '../engine/breadboard';
import { holeKey, type CircuitDoc, type HoleRef, type PartDoc, type WireColor } from '../engine/circuit';
import { LaneRouter } from '../engine/autoroute';
import { Connectivity } from '../engine/netlist';
import { PARTS } from '../engine/parts';
import { Simulator } from '../engine/sim/simulator';
import { InstanceBatcher, piecesBounds } from '../view/batcher';
import { ledDome, partObstacles, partPieces } from '../view/components';
import { coveredHoles } from '../view/covered';
import { Glow, type GlowItem } from '../view/glow';
import { LED_HEX } from '../view/materials';
import { WireLayer, type Obstacle } from '../view/wires';

const spec = boardSpec('bb400');
const B = 'b1';
const ref = (hole: string): HoleRef => ({ board: B, hole });
const top = (col: number): HoleRef[] => ['a', 'b', 'c', 'd', 'e'].map((r) => ref(r + col));
const bottom = (col: number): HoleRef[] => ['f', 'g', 'h', 'i', 'j'].map((r) => ref(r + col));
const rail = (name: RailName): HoleRef[] => spec.holes.filter((h) => h.rail === name).map((h) => ref(h.name));

/** A DIP with pin 1 in column `col`, notch left: pins 1..n/2 along row f, the rest back along row e. */
function dip(pins: number, col: number): string[] {
  const n = pins / 2;
  return [
    ...Array.from({ length: n }, (_, i) => `f${col + i}`),
    ...Array.from({ length: n }, (_, i) => `e${col + n - 1 - i}`),
  ];
}

interface Need {
  from: HoleRef[];
  to: HoleRef[];
  color: WireColor;
}

export function clockDoc(): CircuitDoc {
  const doc: CircuitDoc = {
    version: 1,
    name: 'Clock module',
    boards: [{ id: B, type: 'bb400', x: 0, z: 0 }],
    wires: [],
    parts: [],
    nextId: 1,
  };
  const id = (p: string): string => `${p}${doc.nextId++}`;
  const used = new Set<string>();
  const part = (def: string, holes: string[], extra: { value?: number; state?: number } = {}): string => {
    const p = { id: id('p'), def, pins: holes.map(ref), ...extra };
    holes.forEach((h) => used.add(h));
    doc.parts.push(p);
    return p.id;
  };
  /** The free hole of a rail nearest above or below terminal column `col`. */
  const railAt = (name: RailName, col: number): string => {
    for (let d = 0; d < 8; d++)
      for (const c of [col - 1 + d, col - 1 - d]) {
        const h = spec.holeAt(c, RAIL_GRID_ROW[name]);
        if (h && !used.has(h.name)) return h.name;
      }
    throw new Error(`no free ${name} hole near ${col}`);
  };
  const toRail = (def: string, hole: string, name: RailName, col: number, value?: number): void => {
    part(def, [hole, railAt(name, col)], value === undefined ? {} : { value });
  };

  // Fed from the rails' first holes, but never drawn: the page powers the board itself.
  part('power', ['T+1', 'T-1', 'B+1', 'B-1'], { state: 1 });

  // A 555 running free in the middle of the board, blinking an LED; the knob sets how fast. Kept small,
  // so the page loads and turns quickly on a phone.
  part('NE555', dip(8, 13));
  const knob = part('pot', ['b10', 'b9', 'b8'], { value: 1_000_000, state: 550 });
  toRail('resistor', 'a14', 'T+', 14, 1000); // R1
  part('resistor', ['d9', 'd14'], { value: 1000 }); // R2, wiper to DIS
  toRail('cap-ceramic', 'a16', 'T-', 16, 10e-9); // CTRL
  part('cap-electrolytic', ['i14', 'i13'], { value: 1e-6 }); // timing
  part('led-yellow', ['g15', 'g17'], { value: 5 });
  toRail('resistor', 'j17', 'B-', 17, 220);
  // Decoupling across the top rails.
  part('cap-ceramic', [railAt('T+', 21), railAt('T-', 21)], { value: 100e-9 });

  // Everything else is a jumper, laid by the same router as the SAP-1 build. Holes under a part's
  // body can't take a wire.
  const solids = new Map(doc.parts.map((p) => [p.id, obstaclesOf(p)]));
  const under = coveredHoles(doc, solids);
  const free = (refs: HoleRef[]): HoleRef[] => refs.filter((r) => !under.has(holeKey(r)) && !used.has(r.hole));
  const needs: Need[] = [];
  const need = (from: HoleRef[], to: HoleRef[], color: WireColor): void => {
    needs.push({ from: free(from), to: free(to), color });
  };
  need(top(13), rail('T+'), 'red'); // VCC
  need(bottom(13), rail('B-'), 'black'); // GND
  need(bottom(16), rail('B+'), 'red'); // RESET high
  // Timing: the knob, THR and TRIG.
  need(top(10), top(15), 'white');
  need(top(15), bottom(14), 'white');

  // The router keeps clear of round bodies wider than their legs (an LED's lens, a can), which it
  // otherwise only sees as two leads: they get a box over the rows either side.
  const shift = (hole: string, d: number): string => String.fromCharCode(hole.charCodeAt(0) + d) + hole.slice(1);
  const router = new LaneRouter({
    ...doc,
    parts: doc.parts.map((p) =>
      PARTS[p.def].kind === 'led' || p.def === 'cap-electrolytic'
        ? { ...p, def: 'pot', pins: [...p.pins, ref(shift(p.pins[0].hole, -1)), ref(shift(p.pins[1].hole, 1))] }
        : p,
    ),
  });
  const length = (n: Need): number => {
    const at = (r: HoleRef) => spec.hole(r.hole)!;
    let best = Infinity;
    for (const a of n.from)
      for (const b of n.to) best = Math.min(best, Math.abs(at(a).x - at(b).x) + Math.abs(at(a).z - at(b).z));
    return best;
  };
  needs.sort((a, b) => length(b) - length(a));
  for (const n of needs) if (!router.lay(n.from, n.to)) throw new Error(`no hole for ${holeKey(n.from[0])}`);
  router.relieve(20);
  router.wires.forEach((laid, k) =>
    doc.wires.push({
      id: id('w'),
      a: laid.a,
      b: laid.b,
      color: needs[k].color,
      ...(laid.points.length ? { points: laid.points } : {}),
    }),
  );
  Object.assign(doc, { controls: { knob } });
  return doc;
}

const world = (r: HoleRef): THREE.Vector3 => {
  const h = spec.hole(r.hole)!;
  return new THREE.Vector3(h.x, H, h.z);
};
const obstaclesOf = (p: PartDoc): Obstacle[] =>
  partObstacles(PARTS[p.def], p.pins.map(world), { value: p.value, state: p.state });

/** The circuit drawn, running, and answering the mouse. Add `group` to the board's own group. */
export class Clock {
  readonly group = new THREE.Group();
  private readonly doc = clockDoc();
  private readonly controls = (
    this.doc as unknown as { controls: Partial<Record<'knob' | 'button' | 'slide', string>> }
  ).controls;
  private readonly batcher = new InstanceBatcher();
  private readonly wires = new WireLayer();
  private readonly glow = new Glow();
  private readonly sim = new Simulator();
  private readonly conn = new Connectivity(this.doc);
  private readonly pressed = new Set<string>();
  private glowKey = '';

  /** `changed` is told when anything on the board looks different: `moved` when a part itself did. */
  constructor(private readonly changed: (moved: boolean) => void) {
    this.group.add(this.batcher.group, this.wires.group, this.glow.group);
    this.drawParts();
    const obstacles = this.doc.parts.flatMap(obstaclesOf);
    this.wires.update(this.doc.wires, world, obstacles);
    this.rebuild();
  }

  private part(id: string): PartDoc {
    return this.doc.parts.find((p) => p.id === id)!;
  }

  private drawParts(): void {
    this.batcher.rebuild(
      this.doc.parts
        .filter((p) => PARTS[p.def].kind !== 'power')
        .flatMap((p) =>
          partPieces(PARTS[p.def], p.pins.map(world), {
            value: p.value,
            state: p.state,
            pressed: this.pressed.has(p.id),
          }),
        ),
    );
  }

  /** The circuit changed (a button, the switch, the knob): it carries on from where it was. */
  private rebuild(): void {
    this.sim.update(this.doc, this.conn, this.pressed, true);
    this.sim.frame();
    this.light();
  }

  /** Runs the circuit on by a frame's worth of time. A long gap (a hidden tab) is cut short. */
  step(seconds: number): void {
    if (!this.sim.active) return;
    this.sim.advance(Math.min(0.1, seconds), { deadline: performance.now() + 3 });
    this.sim.frame();
    this.light();
  }

  private light(): void {
    const result = this.sim.snapshot();
    const items: GlowItem[] = [];
    let key = '';
    for (const p of this.doc.parts) {
      const def = PARTS[p.def];
      if (def.kind !== 'led') continue;
      const level = Math.round((result.leds.get(p.id)?.brightness ?? 0) * 32) / 32;
      key += `${level};`;
      if (level <= 0) continue;
      const [a, b] = p.pins.map(world);
      const matrix = new THREE.Matrix4()
        .makeRotationY(Math.atan2(-(b.z - a.z), b.x - a.x))
        .setPosition((a.x + b.x) / 2, H, (a.z + b.z) / 2);
      items.push({
        kind: 'led',
        size: p.value ?? 5,
        matrix,
        color: LED_HEX[def.color],
        level,
        center: ledDome(p.value ?? 5).applyMatrix4(matrix),
      });
    }
    if (key === this.glowKey) return;
    this.glowKey = key;
    this.glow.update(items);
    this.changed(false);
  }

  /** Which control a ray in the board's own space points at, if any, reaching `reach` mm round each. */
  hit(ray: THREE.Ray, reach = 0.8): 'knob' | 'button' | 'slide' | null {
    let best: { name: 'knob' | 'button' | 'slide'; d: number } | null = null;
    const v = new THREE.Vector3();
    for (const name of ['knob', 'button', 'slide'] as const) {
      const id = this.controls[name];
      if (!id) continue;
      const p = this.part(id);
      const box = piecesBounds(
        partPieces(PARTS[p.def], p.pins.map(world), { value: p.value, state: p.state }),
      ).expandByScalar(reach);
      if (ray.intersectBox(box, v)) {
        const d = v.distanceTo(ray.origin);
        if (!best || d < best.d) best = { name, d };
      }
    }
    return best?.name ?? null;
  }

  press(down: boolean): void {
    const id = this.controls.button;
    if (!id || down === this.pressed.has(id)) return;
    if (down) this.pressed.add(id);
    else this.pressed.delete(id);
    this.drawParts();
    this.changed(true);
    this.rebuild();
  }

  toggle(): void {
    if (!this.controls.slide) return;
    const p = this.part(this.controls.slide);
    p.state = (p.state ?? 0) ^ 1;
    this.drawParts();
    this.changed(true);
    this.rebuild();
  }

  get knob(): number {
    return this.controls.knob ? (this.part(this.controls.knob).state ?? 500) : 500;
  }

  set knob(position: number) {
    if (!this.controls.knob) return;
    const p = this.part(this.controls.knob);
    const next = Math.round(Math.max(0, Math.min(1000, position)));
    if (next === p.state) return;
    p.state = next;
    this.drawParts();
    this.changed(true);
    this.rebuild();
  }
}
