// Keeps the 3D scene in step with the document, and answers "what's under the cursor?".

import * as THREE from 'three';
import { BOARD_HEIGHT as H, boardSpec, type Hole } from '../engine/breadboard';
import {
  occupancy,
  type BoardDoc,
  type HoleRef,
  type Id,
  type Occupant,
  type SupplyDoc,
  type MeterDoc,
  type ScopeDoc,
} from '../engine/circuit';
import { Connectivity } from '../engine/netlist';
import { PARTS, type PartDef } from '../engine/parts';
import { isTerminal, SUPPLY_HOLES, SUPPLY_SIZE, SUPPLY_TERMINALS } from '../engine/supply';
import {
  isMeterTerminal,
  type MeterButton,
  METER_BODY,
  METER_FACE_Y,
  METER_HOLES,
  METER_SCALE,
  METER_TILT,
  meterTerminalPos,
  meterToDesk,
} from '../engine/meter';
import { isScopeTerminal, SCOPE_HOLES, SCOPE_SIZE, scopeTerminalPos } from '../engine/scope';
import { InstanceBatcher, piecesBounds, type Piece } from '../view/batcher';
import { boardPiece } from '../view/board';
import { partObstacles, partPieces } from '../view/components';
import type { View } from '../view/view';
import { SupplyLayer, supplyObstacles, type SupplyKnob } from '../view/supply';
import { MeterLayer, meterObstacles } from '../view/meter';
import { ScopeLayer, type ScopeControl } from '../view/scope';
import { WireLayer, type Obstacle } from '../view/wires';
import { boxObstacle, obstaclesMeet } from '../view/routing';
import { coveredHoles } from '../view/covered';
import type { Store } from './store';

export interface HoleHit {
  ref: HoleRef;
  hole: Hole;
  /** The board it's on; for a bench supply's terminal, a stand-in at the supply's place. */
  board: BoardDoc;
  world: THREE.Vector3;
  /** A bench supply's terminal rather than a hole in a board. */
  terminal?: boolean;
}

export interface ItemRef {
  kind: 'wire' | 'part' | 'supply' | 'meter' | 'scope' | 'board';
  id: Id;
  /** Where the ray hit it. */
  point?: THREE.Vector3;
  /** A bench supply's knob, if that's what's under the ray. */
  knob?: SupplyKnob;
  /** A multimeter's rotary dial. */
  dial?: boolean;
  /** One of a multimeter's push buttons. */
  button?: MeterButton;
  /** An oscilloscope's knob or button, if that's what's under the ray. */
  control?: ScopeControl;
  /** On an oscilloscope's knob: which half of it (-1 left, 1 right). */
  side?: -1 | 1;
}

/** Power modules sit at the left end of a board when plugged into the first rail holes. */
export const powerFacing = (pins: readonly HoleRef[]): number => (pins[0]?.hole === 'T+1' ? -1 : 1);

interface PartEntry {
  signature: string;
  pieces: Piece[];
  bounds: THREE.Box3;
  /** Its body without the legs, for the box drawn round it when it's pointed at or selected. */
  outline: THREE.Box3;
  /** Its solid pieces, which wires go round and other parts keep out of. */
  solid: Obstacle[];
}

/**
 * A part's bounds without its legs: an LED's box hugs the lens, a resistor's its body. A chip keeps
 * its legs, which stick out of its sides; a part that's all legs keeps them all.
 */
function outlineBounds(pieces: readonly Piece[]): THREE.Box3 {
  const body = pieces.filter((p) => !/-(legs|leads)-/.test(`${p.key}-`) || p.key.startsWith('chip-legs'));
  return piecesBounds(body.length ? body : pieces);
}

export class SceneSync {
  readonly wires = new WireLayer();
  readonly supplies = new SupplyLayer();
  readonly meters = new MeterLayer();
  readonly scopes = new ScopeLayer();
  connectivity: Connectivity;
  occupancy: Map<string, Occupant>;
  obstacles: Obstacle[] = [];
  /** Holes under a part's body (by hole key), and the part over each: nothing can be plugged in there. */
  covered = new Map<string, Id>();
  /** Each part's solid pieces, to keep parts from being put inside each other. */
  private solids = new Map<Id, Obstacle[]>();
  /** Goes up whenever anything on the desk is drawn somewhere new. */
  layoutVersion = 0;

  private readonly batcher = new InstanceBatcher();
  private boards = new Map<Id, BoardDoc>();
  private supplyDocs = new Map<Id, SupplyDoc>();
  private meterDocs = new Map<Id, MeterDoc>();
  private scopeDocs = new Map<Id, ScopeDoc>();
  private parts = new Map<Id, PartEntry>();
  private layoutSignature = '';
  /** What `covered` was last worked out from: the boards and every part where it is. */
  private coveredSignature = '';
  private pressed: ReadonlySet<Id> = new Set();
  private held: ReadonlySet<Id> = new Set();
  /** Picked up and being dragged: drawn as a preview instead. */
  private hidden: Id | null = null;
  /** Called when a part is hidden for dragging or shown again. */
  onHiddenChange: (() => void) | null = null;
  private readonly surface = new THREE.Plane(new THREE.Vector3(0, 1, 0), -H);

  constructor(
    private readonly view: View,
    private readonly store: Store,
  ) {
    view.world.add(this.batcher.group, this.wires.group, this.supplies.group, this.meters, this.scopes);
    this.connectivity = new Connectivity(store.doc);
    this.occupancy = occupancy(store.doc);
    store.subscribe(() => this.sync());
    this.sync();
  }

  sync(): void {
    const doc = this.store.doc;
    this.boards = new Map(doc.boards.map((b) => [b.id, b]));
    this.supplyDocs = new Map((doc.supplies ?? []).map((s) => [s.id, s]));
    this.meterDocs = new Map((doc.meters ?? []).map((m) => [m.id, m]));
    this.scopeDocs = new Map((doc.scopes ?? []).map((s) => [s.id, s]));
    this.supplies.update(doc.supplies ?? []);
    this.meters.update(doc.meters ?? []);
    this.scopes.update(doc.scopes ?? []);

    const parts = new Map<Id, PartEntry>();
    const obstacles: Obstacle[] = [];
    const solids = new Map<Id, Obstacle[]>();
    // Where each part is and what it is, but not whether a button's pressed: what decides the holes it covers.
    const covering = doc.boards.map((b) => `${b.type}@${b.x},${b.z}`);
    for (const p of doc.parts) {
      const def = PARTS[p.def];
      const pins = p.pins.map((r) => this.holeWorld(r));
      if (!def || pins.some((v) => !v)) continue;
      const world = pins as THREE.Vector3[];
      const options = {
        value: p.value,
        state: p.state,
        pressed: this.pressed.has(p.id),
        held: this.held.has(p.id),
        facing: powerFacing(p.pins),
      };
      const place = `${p.def}|${p.value ?? ''}|${p.state ?? ''}|${world.map((v) => `${v.x.toFixed(2)},${v.z.toFixed(2)}`).join(';')}`;
      covering.push(place);
      const signature = `${place}|${options.pressed}|${options.held}`;
      const old = this.parts.get(p.id);
      const entry =
        old?.signature === signature
          ? old
          : (() => {
              const pieces = partPieces(def, world, options);
              return {
                signature,
                pieces,
                bounds: piecesBounds(pieces),
                outline: outlineBounds(pieces),
                solid: partObstacles(def, world, options),
              };
            })();
      parts.set(p.id, entry);
      solids.set(p.id, entry.solid);
      obstacles.push(...entry.solid);
    }
    this.parts = parts;
    this.solids = solids;

    // Desk instruments are solid too. This makes a jumper or a hanging lead rise above their
    // cases instead of visually passing through them.
    for (const supply of doc.supplies ?? []) obstacles.push(...supplyObstacles(supply));
    for (const meter of doc.meters ?? []) {
      const box = this.meterBounds(meter.id);
      if (box) obstacles.push(...meterObstacles(box, meter.z));
    }
    for (const scope of doc.scopes ?? []) {
      obstacles.push(
        boxObstacle(
          scope.x - SCOPE_SIZE.x / 2,
          scope.x + SCOPE_SIZE.x / 2,
          scope.z - SCOPE_SIZE.z / 2,
          scope.z + SCOPE_SIZE.z / 2,
          SCOPE_SIZE.y + 8,
          0,
        ),
      );
    }

    // Rebuild the instanced meshes only when a board or part actually changed.
    const shown = [...parts].filter(([id]) => id !== this.hidden).map(([, e]) => e);
    const layout = [
      ...doc.boards.map((b) => `${b.type}@${b.x},${b.z}`),
      ...(doc.supplies ?? []).map((s) => `supply@${s.x},${s.z}`),
      ...(doc.meters ?? []).map((m) => `meter@${m.x},${m.z}`),
      ...(doc.scopes ?? []).map((s) => `scope@${s.x},${s.z}`),
      ...shown.map((e) => e.signature),
    ].join('/');
    if (layout !== this.layoutSignature) {
      this.layoutSignature = layout;
      this.layoutVersion++;
      const boardPieces = doc.boards.map((b) => boardPiece(boardSpec(b.type), b.x, b.z));
      this.batcher.rebuild([...boardPieces, ...shown.flatMap((e) => e.pieces)]);
    }

    this.obstacles = obstacles;
    this.wires.update(
      doc.wires.filter((w) => w.id !== this.hidden),
      (r) => this.holeWorld(r),
      obstacles,
    );
    this.connectivity = new Connectivity(doc);
    this.occupancy = occupancy(doc);
    const coveredSignature = covering.join('/');
    if (coveredSignature !== this.coveredSignature) {
      this.coveredSignature = coveredSignature;
      this.covered = coveredHoles(doc, solids);
    }
    this.view.setShadowBounds(this.boardsBox());
    this.view.invalidateShadows();
  }

  holeWorld(ref: HoleRef): THREE.Vector3 | null {
    const supply = this.supplyDocs.get(ref.board);
    if (supply) {
      if (!isTerminal(ref.hole)) return null;
      const t = SUPPLY_TERMINALS[ref.hole];
      return new THREE.Vector3(supply.x + t.x, t.y, supply.z + t.z);
    }
    const meter = this.meterDocs.get(ref.board);
    if (meter) {
      if (!isMeterTerminal(ref.hole)) return null;
      const p = meterTerminalPos(meter, ref.hole);
      return new THREE.Vector3(p.x, p.y, p.z);
    }
    const scope = this.scopeDocs.get(ref.board);
    if (scope) {
      if (!isScopeTerminal(ref.hole)) return null;
      const p = scopeTerminalPos(scope, ref.hole);
      return new THREE.Vector3(p.x, p.y, p.z);
    }
    const board = this.boards.get(ref.board);
    const hole = board && boardSpec(board.type).hole(ref.hole);
    return board && hole ? new THREE.Vector3(board.x + hole.x, H, board.z + hole.z) : null;
  }

  /** Redraws push buttons that are pressed, and marks the ones held down. */
  setPressed(pressed: ReadonlySet<Id>, held: ReadonlySet<Id> = new Set()): void {
    this.pressed = new Set(pressed);
    this.held = new Set(held);
    this.sync();
  }

  /** Whether a spot on the desk is over a breadboard. */
  overBoard(x: number, z: number): boolean {
    return this.store.doc.boards.some((b) => {
      const s = boardSpec(b.type);
      return Math.abs(x - b.x) <= s.length / 2 && Math.abs(z - b.z) <= s.width / 2;
    });
  }

  /** Leaves a part or wire out of the scene while it's being dragged somewhere else. */
  setHidden(id: Id | null): void {
    if (id === this.hidden) return;
    this.hidden = id;
    this.sync();
    this.onHiddenChange?.();
  }

  /** Whether a part or wire is left out of the scene (see setHidden). */
  isHidden(id: Id): boolean {
    return id === this.hidden;
  }

  /** The hole nearest to a point on the desk, within `reach` mm, on whichever board it's over. */
  holeNear(x: number, z: number, reach = 0.5): HoleRef | null {
    for (const board of this.store.doc.boards) {
      const hole = boardSpec(board.type).nearestHole(x - board.x, z - board.z, reach);
      if (hole) return { board: board.id, hole: hole.name };
    }
    return null;
  }

  /** The point on the board surface a ray meets. */
  surfacePoint(ray: THREE.Ray): THREE.Vector3 | null {
    return ray.intersectPlane(this.surface, new THREE.Vector3());
  }

  hole(ref: HoleRef): Hole | undefined {
    if (this.supplyDocs.has(ref.board)) return SUPPLY_HOLES.hole(ref.hole);
    if (this.meterDocs.has(ref.board)) return METER_HOLES.hole(ref.hole);
    const board = this.boards.get(ref.board);
    return board && boardSpec(board.type).hole(ref.hole);
  }

  /** A part's placement in the world (its pieces share it). */
  partMatrix(id: Id): THREE.Matrix4 | undefined {
    return this.parts.get(id)?.pieces[0]?.matrix;
  }

  supply(id: Id): SupplyDoc | undefined {
    return this.supplyDocs.get(id);
  }

  supplyBounds(id: Id): THREE.Box3 | undefined {
    const supply = this.supplyDocs.get(id);
    if (!supply) return undefined;
    const box = new THREE.Box3();
    this.supplies.expand(box, supply);
    return box;
  }

  meter(id: Id): MeterDoc | undefined {
    return this.meterDocs.get(id);
  }

  scope(id: Id): ScopeDoc | undefined {
    return this.scopeDocs.get(id);
  }

  meterBounds(id: Id): THREE.Box3 | undefined {
    const meter = this.meterDocs.get(id);
    if (!meter) return undefined;
    const box = new THREE.Box3();
    this.meters.expand(box, id);
    return box;
  }

  scopeBounds(id: Id): THREE.Box3 | undefined {
    const scope = this.scopeDocs.get(id);
    if (!scope) return undefined;
    const box = new THREE.Box3();
    this.scopes.expand(box, id);
    return box;
  }

  /**
   * The front of a bench instrument, for looking straight at it: where its face is, which way it
   * looks, and how big it is. The supply and the scope are seen from a little above their fronts;
   * the meter, propped up on the desk, from square on to its tilted face.
   */
  instrumentFace(id: Id): { center: THREE.Vector3; normal: THREE.Vector3; width: number; height: number } | undefined {
    const box = this.supplyDocs.get(id) ?? this.scopeDocs.get(id);
    if (box) {
      const size = this.supplyDocs.has(id) ? SUPPLY_SIZE : SCOPE_SIZE;
      const up = THREE.MathUtils.degToRad(12);
      return {
        center: new THREE.Vector3(box.x, size.y / 2, box.z + size.z / 2),
        normal: new THREE.Vector3(0, Math.sin(up), Math.cos(up)),
        width: size.x,
        height: size.y,
      };
    }
    const meter = this.meterDocs.get(id);
    if (!meter) return undefined;
    const face = meterToDesk(0, METER_FACE_Y, 0);
    return {
      center: new THREE.Vector3(meter.x + face.x * METER_SCALE, face.y * METER_SCALE, meter.z + face.z * METER_SCALE),
      normal: new THREE.Vector3(0, Math.cos(METER_TILT), Math.sin(METER_TILT)),
      width: METER_BODY.x * METER_SCALE,
      height: METER_BODY.z * METER_SCALE,
    };
  }

  /** A bench supply's terminal near the ray, if any. */
  pickTerminal(ray: THREE.Ray): HoleHit | null {
    // Put the mutable candidate behind an object. TypeScript's control-flow analysis
    // does not follow assignments made from the nested `consider` callback.
    const candidate: { value: { hit: HoleHit; distance: number } | null } = { value: null };
    const consider = (id: Id, x: number, z: number, holes: readonly Hole[]) => {
      for (const hole of holes) {
        const ref = { board: id, hole: hole.name };
        const world = this.holeWorld(ref)!;
        if (ray.distanceSqToPoint(world) > 5.5 ** 2) continue;
        const distance = ray.origin.distanceTo(world);
        if (candidate.value && distance >= candidate.value.distance) continue;
        candidate.value = { hit: { ref, hole, board: { id, type: 'bb830', x, z }, world, terminal: true }, distance };
      }
    };
    for (const supply of this.supplyDocs.values()) consider(supply.id, supply.x, supply.z, SUPPLY_HOLES.holes);
    for (const meter of this.meterDocs.values()) consider(meter.id, meter.x, meter.z, METER_HOLES.holes);
    for (const scope of this.scopeDocs.values()) consider(scope.id, scope.x, scope.z, SCOPE_HOLES.holes);
    return candidate.value?.hit ?? null;
  }

  boardNumber(id: Id): number {
    return this.store.doc.boards.findIndex((b) => b.id === id) + 1;
  }

  /** The part (other than those in `ignore`) that a part `def` with its legs at `world` would sit inside of, if any. */
  bodyClash(
    def: PartDef,
    world: readonly THREE.Vector3[],
    options: { value?: number; facing?: number },
    ignore: ReadonlySet<Id>,
  ): Id | null {
    const mine = partObstacles(def, world as THREE.Vector3[], options);
    for (const [id, solid] of this.solids) {
      if (ignore.has(id)) continue;
      if (mine.some((a) => solid.some((b) => obstaclesMeet(a, b)))) return id;
    }
    return null;
  }

  partBounds(id: Id): THREE.Box3 | undefined {
    return this.parts.get(id)?.bounds.clone();
  }

  /** A part's body, legs left out (they show where it plugs in well enough), for the box drawn round it. */
  partOutline(id: Id): THREE.Box3 | undefined {
    return this.parts.get(id)?.outline.clone();
  }

  /** The hole nearest to where the ray meets the board surface. */
  pickHole(ray: THREE.Ray, reach = 1.4): HoleHit | null {
    const p = ray.intersectPlane(this.surface, new THREE.Vector3());
    if (!p) return null;
    for (const board of this.store.doc.boards) {
      const spec = boardSpec(board.type);
      const lx = p.x - board.x;
      const lz = p.z - board.z;
      if (Math.abs(lx) > spec.length / 2 || Math.abs(lz) > spec.width / 2) continue;
      const hole = spec.nearestHole(lx, lz, reach);
      if (!hole) return null;
      return {
        ref: { board: board.id, hole: hole.name },
        hole,
        board,
        world: new THREE.Vector3(board.x + hole.x, H, board.z + hole.z),
      };
    }
    return null;
  }

  /** The wire or part under the ray, nearest first. Parts are hit-tested by their bounding boxes. */
  pickItem(ray: THREE.Ray): ItemRef | null {
    let best: { item: ItemRef; distance: number } | null = null;
    const hit = new THREE.Vector3();
    for (const [id, e] of this.parts) {
      if (id === this.hidden) continue;
      const box = e.bounds.clone();
      box.min.y = Math.max(box.min.y, H);
      if (!ray.intersectBox(box, hit)) continue;
      const distance = hit.distanceTo(ray.origin);
      if (!best || distance < best.distance) best = { item: { kind: 'part', id, point: hit.clone() }, distance };
    }
    const supply = this.supplies.pick(ray);
    if (supply && (!best || supply.distance < best.distance)) {
      best = {
        item: {
          kind: 'supply',
          id: supply.id,
          point: supply.point,
          knob: supply.on === 'case' ? undefined : supply.on,
        },
        distance: supply.distance,
      };
    }
    const meter = this.meters.pick(ray);
    if (meter && (!best || meter.distance < best.distance)) {
      best = {
        item: {
          kind: 'meter',
          id: meter.id,
          point: meter.point,
          dial: meter.dial,
          ...(meter.button ? { button: meter.button } : {}),
        },
        distance: meter.distance,
      };
    }
    const scope = this.scopes.pick(ray);
    if (scope && (!best || scope.distance < best.distance)) {
      best = {
        item: {
          kind: 'scope',
          id: scope.id,
          point: scope.point,
          ...(scope.control ? { control: scope.control } : {}),
          ...(scope.side ? { side: scope.side } : {}),
        },
        distance: scope.distance,
      };
    }
    const wire = this.wires.pick(ray);
    if (wire && (!best || wire.distance < best.distance))
      return { kind: 'wire', id: wire.id, point: ray.at(wire.distance, new THREE.Vector3()) };
    if (best) return best.item;
    // Nothing on it: the board itself.
    for (const b of this.store.doc.boards) {
      const box = this.boardBounds(b.id);
      if (box && ray.intersectBox(box, hit)) return { kind: 'board', id: b.id, point: hit.clone() };
    }
    return null;
  }

  boardBounds(id: Id): THREE.Box3 | undefined {
    const b = this.store.doc.boards.find((x) => x.id === id);
    if (!b) return undefined;
    const s = boardSpec(b.type);
    return new THREE.Box3(
      new THREE.Vector3(b.x - s.length / 2, 0, b.z - s.width / 2),
      new THREE.Vector3(b.x + s.length / 2, s.height, b.z + s.width / 2),
    );
  }

  /** Everything on the desk: boards, plus parts that hang off them (like a power module). */
  boardsBox(): THREE.Box3 {
    const box = new THREE.Box3();
    for (const b of this.store.doc.boards) {
      const s = boardSpec(b.type);
      box.expandByPoint(new THREE.Vector3(b.x - s.length / 2, 0, b.z - s.width / 2));
      box.expandByPoint(new THREE.Vector3(b.x + s.length / 2, s.height, b.z + s.width / 2));
    }
    this.supplies.expand(box);
    this.meters.expand(box);
    this.scopes.expand(box);
    for (const e of this.parts.values()) {
      box.expandByPoint(new THREE.Vector3(e.bounds.min.x, 0, e.bounds.min.z));
      box.expandByPoint(new THREE.Vector3(e.bounds.max.x, H, e.bounds.max.z));
    }
    return box;
  }
}
