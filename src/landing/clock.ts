// Ben Eater's clock module, live on the landing page's board: three 555s (astable, monostable,
// bistable) picking between a free-running clock and a single step, through a 74LS04, 74LS08 and
// 74LS32. The real simulator runs it. The knob sets the speed, the slide switch picks auto or manual,
// and the button steps the clock in manual. Powered from the rails with nothing drawn feeding them.

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

const spec = boardSpec('bb830');
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
    boards: [{ id: B, type: 'bb830', x: 0, z: 0 }],
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

  // The chips, left to right as Ben has them.
  for (const [def, col] of [
    ['NE555', 7],
    ['NE555', 21],
    ['NE555', 33],
    ['74LS04', 39],
    ['74LS08', 47],
    ['74LS32', 55],
  ] as const)
    part(def, dip(def === 'NE555' ? 8 : 14, col));

  // Astable (U1, 7–10). The knob and R2 set its speed; C6 is its timing capacitor.
  const knob = part('pot', ['b4', 'b3', 'b2'], { value: 1_000_000, state: 550 });
  toRail('resistor', 'a8', 'T+', 8, 1000); // R1
  part('resistor', ['d3', 'd8'], { value: 1000 }); // R2, wiper to DIS
  toRail('cap-ceramic', 'a10', 'T-', 10, 10e-9); // C5
  part('cap-electrolytic', ['i8', 'i7'], { value: 1e-6 }); // C6
  part('led-yellow', ['g9', 'g11'], { value: 5 });
  toRail('resistor', 'j11', 'B-', 11, 220);

  // Monostable (U2, 21–24): the button fires one clean pulse.
  const button = part('button', ['e16', 'e18', 'f16', 'f18']);
  toRail('resistor', 'j18', 'B+', 18, 1000); // R3, TRIG pull-up
  toRail('resistor', 'a22', 'T+', 22, 1_000_000); // R4
  toRail('cap-ceramic', 'a23', 'T-', 23, 100e-9); // C3
  toRail('cap-ceramic', 'a24', 'T-', 24, 10e-9); // C2
  part('led-yellow', ['g23', 'g25'], { value: 5 });
  toRail('resistor', 'j25', 'B-', 25, 220);

  // Bistable (U3, 33–36): the slide switch sets or resets it, without bounce.
  const slide = part('slide-switch', ['c27', 'c28', 'c29'], { state: 0 });
  toRail('resistor', 'a27', 'T+', 27, 1000); // R5
  toRail('resistor', 'a29', 'T+', 29, 1000); // R6
  toRail('cap-ceramic', 'a36', 'T-', 36, 10e-9); // C4
  part('led-yellow', ['g35', 'g37'], { value: 5 });
  toRail('resistor', 'j37', 'B-', 37, 220);

  // The clock out, in blue, at the top right.
  part('led-blue', ['b53', 'b54'], { value: 5 });
  toRail('resistor', 'a54', 'T-', 54, 220);
  // Decoupling across the top rails.
  for (const col of [14, 30, 46]) part('cap-ceramic', [railAt('T+', col), railAt('T-', col)], { value: 100e-9 });

  // Everything else is a jumper, laid by the same router as the SAP-1 build. Holes under a part's
  // body can't take a wire.
  const solids = new Map(doc.parts.map((p) => [p.id, obstaclesOf(p)]));
  const under = coveredHoles(doc, solids);
  const free = (refs: HoleRef[]): HoleRef[] => refs.filter((r) => !under.has(holeKey(r)) && !used.has(r.hole));
  const needs: Need[] = [];
  const need = (from: HoleRef[], to: HoleRef[], color: WireColor): void => {
    needs.push({ from: free(from), to: free(to), color });
  };
  for (const col of [7, 21, 33, 39, 47, 55]) need(top(col), rail('T+'), 'red');
  for (const col of [7, 21, 33]) need(bottom(col), rail('B-'), 'black');
  for (const col of [45, 53, 61]) need(bottom(col), rail('B-'), 'black');
  for (const col of [10, 24]) need(bottom(col), rail('B+'), 'red'); // 555 RESET high
  need(top(35), rail('T-'), 'black'); // U3 THR
  need(top(44), rail('T-'), 'black'); // HLT low: run
  need(top(16), rail('T-'), 'black'); // button to ground
  need(top(28), rail('T-'), 'black'); // slide common
  // U1 timing: knob, THR and TRIG.
  need(top(4), top(9), 'white');
  need(top(9), bottom(8), 'white');
  // U2: DIS to THR, button to TRIG.
  need(top(22), top(23), 'white');
  need(bottom(18), bottom(22), 'white');
  // U3: switch to TRIG and RESET.
  need(top(27), bottom(34), 'blue');
  need(top(29), bottom(36), 'blue');
  // The logic.
  need(bottom(9), bottom(47), 'yellow'); // astable → AND 1A
  need(bottom(35), bottom(39), 'blue'); // select → NOT 1A
  need(bottom(39), bottom(48), 'blue'); // select → AND 1B
  need(bottom(40), bottom(50), 'blue'); // not select → AND 2A
  need(bottom(23), bottom(51), 'green'); // monostable → AND 2B
  need(bottom(49), bottom(55), 'orange'); // → OR
  need(bottom(52), bottom(56), 'orange');
  need(bottom(57), top(52), 'orange'); // OR → AND 3A
  need(top(45), top(51), 'orange'); // not HLT → AND 3B

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
  Object.assign(doc, { controls: { knob, button, slide } });
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
  private readonly controls = (this.doc as unknown as { controls: { knob: string; button: string; slide: string } })
    .controls;
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
    this.sim.advance(Math.min(0.1, seconds), { deadline: performance.now() + 6 });
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
      const p = this.part(this.controls[name]);
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
    if (down === this.pressed.has(id)) return;
    if (down) this.pressed.add(id);
    else this.pressed.delete(id);
    this.drawParts();
    this.changed(true);
    this.rebuild();
  }

  toggle(): void {
    const p = this.part(this.controls.slide);
    p.state = (p.state ?? 0) ^ 1;
    this.drawParts();
    this.changed(true);
    this.rebuild();
  }

  get knob(): number {
    return this.part(this.controls.knob).state ?? 500;
  }

  set knob(position: number) {
    const p = this.part(this.controls.knob);
    const next = Math.round(Math.max(0, Math.min(1000, position)));
    if (next === p.state) return;
    p.state = next;
    this.drawParts();
    this.changed(true);
    this.rebuild();
  }
}
