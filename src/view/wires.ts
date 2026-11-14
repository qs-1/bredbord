// Jumper wires: cut to length, bent down into their holes and lying flat on the board, hopping
// over wires and parts in their way (see routing.ts). A wire can bend through points on its way,
// with rounded corners there. Wires are merged into one mesh per colour to keep draw calls low.
// The wire being drawn shows as a ghost, with the wires around it already making way for it.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { BOARD_HEIGHT as H } from '../engine/breadboard';
import type { HoleRef, Id, WireColor, WireDoc } from '../engine/circuit';
import { owned, ribbon, roundCorners, tube } from './geometry';
import { ghostify, palette, ribbonDepthMaterial, themed, tinMaterial, wireMaterial, WIRE_HEX } from './materials';
import { BASE_HEIGHT, heightAt, Router, WIRE_RADIUS, type Obstacle, type Route } from './routing';

export { WIRE_RADIUS, type Obstacle } from './routing';

type V = THREE.Vector3;

const BARE_RADIUS = 0.31;
/**
 * How far above a jumper a bench lead runs, clear of the board. A lead keeps its route's hops on
 * top of that, so two leads crossing go one over the other instead of through each other.
 */
const LEAD_LIFT = H + 7 - BASE_HEIGHT;
/** Insulation is stripped just above the board surface. */
const STRIP_AT = H + 0.3;
const HOLE_DEPTH = 3.2;
/** The shortest run (mm) that gets a handle in its middle: about three holes, so it sits clear of the handles at its ends. */
const MID_HANDLE_MIN_RUN = 7;
/** Sides of a wire drawn as a round tube. */
const SIDES = 8;

/**
 * How wires are drawn. Smooth: round tubes following the route closely. Fast: flat strips shaded
 * to look round (see ribbon in geometry.ts) on a coarser path, a fraction of the triangles for a
 * big circuit on a laptop's graphics.
 */
export type WireQuality = 'smooth' | 'fast';
const QUALITY: Record<WireQuality, { tolerance: number; steps: number; ribbon: boolean }> = {
  // tolerance: how far (mm) the drawn path may stray from where the wire runs, so straight-ish
  // stretches need few points; steps: points on each bend out of a hole.
  smooth: { tolerance: 0.015, steps: 7, ribbon: false },
  fast: { tolerance: 0.06, steps: 4, ribbon: true },
};
let quality = QUALITY.smooth;

// ---- wire shape ----

interface WireShape {
  insulation: V[];
  bareA: V[];
  bareB: V[];
}

/** Splits a polyline where it first rises above `y`: [the part below, the rest from the crossing on]. */
function cutAbove(points: V[], y: number): [V[], V[]] {
  for (let i = 1; i < points.length; i++) {
    if (points[i].y > y) {
      const p = points[i - 1];
      const q = points[i];
      const c = p.clone().lerp(q, Math.max(0, Math.min(1, (y - p.y) / (q.y - p.y))));
      return [
        [...points.slice(0, i), c],
        [c, ...points.slice(i)],
      ];
    }
  }
  return [points, []];
}

/** An end on a bench instrument's binding post rather than in a board: posts stand well above the board. */
const onPost = (p: V): boolean => p.y > H + 2;
/** Whether a wire runs to a bench instrument, so it's drawn as a flexible lead. */
export const isLead = (a: V, b: V): boolean => onPost(a) || onPost(b);
/** Where a lead leaves its post: straight out of the front of the socket. */
const exitOf = (post: V): V => post.clone().add(new THREE.Vector3(0, 0, 8));
/**
 * The path a wire is routed along. A lead is routed from where it leaves its post, not from the
 * post itself: a route starting at the socket heads sideways at once, so the cable came straight
 * out and then doubled back to meet it, kinking into a hook right at the post.
 */
export const routePath = (a: V, bends: readonly V[], b: V): V[] => [
  onPost(a) ? exitOf(a) : a,
  ...bends,
  onPost(b) ? exitOf(b) : b,
];

/** A lead's run along its route, lifted clear of the board: from over its first end (or out of its post) to over its last. */
function leadRun(route: Route | null, path: readonly V[]): V[] {
  if (!route) return path.map((p) => new THREE.Vector3(p.x, BASE_HEIGHT + LEAD_LIFT, p.z));
  const { plan, heights } = route;
  const run: V[] = [];
  for (let i = 0; i < heights.length; i++) run.push(new THREE.Vector3(plan.x[i], heights[i] + LEAD_LIFT, plan.z[i]));
  return simplify(run, quality.tolerance);
}

/**
 * A flexible lead to a bench instrument: out of the front of its post (or up out of its hole with
 * a bare tip), along its route, and into the post or hole at the other end. One still being drawn
 * stops in the air at its last point. Only the ends are rounded off: rounding the hops would sink
 * them into the wires they clear.
 */
function leadShape(a: V, b: V, bends: readonly V[], route: Route | null, open: boolean): WireShape {
  const tip = (p: V): V => new THREE.Vector3(p.x, STRIP_AT + 0.6, p.z);
  const pin = (p: V): V[] => [tip(p), new THREE.Vector3(p.x, H - HOLE_DEPTH, p.z)];
  const run = leadRun(route, routePath(a, bends, b));
  const points = [onPost(a) ? a : tip(a), ...run, ...(open ? [] : [onPost(b) ? b : tip(b)])];
  const last = open ? -1 : points.length - 2;
  return {
    insulation: roundCorners(points, (i) => (i === 1 || i === last ? 3.2 : 0), 5),
    bareA: onPost(a) ? [] : pin(a),
    bareB: open || onPost(b) ? [] : pin(b),
  };
}

/** A quadratic curve from p to q, turning at c: how a wire rounds the corner out of its hole. */
function turn(out: V[], p: V, c: V, q: V, steps = quality.steps): void {
  for (let k = 0; k <= steps; k++) {
    const t = k / steps;
    const u = 1 - t;
    out.push(
      new THREE.Vector3()
        .addScaledVector(p, u * u)
        .addScaledVector(c, 2 * u * t)
        .addScaledVector(q, t * t),
    );
  }
}

/** Leaves out points lying (within `tolerance`) on the line between their neighbours: a flat run needs only its ends. */
function simplify(points: V[], tolerance: number): V[] {
  if (points.length < 3) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const line = new THREE.Line3();
  const on = new THREE.Vector3();
  const todo: [number, number][] = [[0, points.length - 1]];
  while (todo.length) {
    const [i, j] = todo.pop()!;
    line.set(points[i], points[j]);
    let worst = -1;
    let far = tolerance;
    for (let k = i + 1; k < j; k++) {
      const d = line.closestPointToPoint(points[k], true, on).distanceTo(points[k]);
      if (d > far) {
        far = d;
        worst = k;
      }
    }
    if (worst < 0) continue;
    keep[worst] = 1;
    todo.push([i, worst], [worst, j]);
  }
  return points.filter((_, k) => keep[k]);
}

/** A jumper along its route: up out of hole a, along, and down into hole b, unless it's still being drawn and stops in the air. */
function jumperShape(a: V, b: V, route: Route, open: boolean): WireShape {
  const { plan, heights } = route;
  const n = heights.length;
  const length = plan.length;
  const at = (s: number): V => {
    const f = plan.step > 0 ? Math.max(0, Math.min(n - 1, s / plan.step)) : 0;
    const i = Math.min(n - 2, Math.floor(f));
    const t = f - i;
    return new THREE.Vector3(
      plan.x[i] + (plan.x[i + 1] - plan.x[i]) * t,
      heightAt(route, s),
      plan.z[i] + (plan.z[i + 1] - plan.z[i]) * t,
    );
  };
  // Tight bends where it comes out of its holes, a little wider the higher it has to climb.
  const drop = (h: number): number => Math.min(1.1 + (h - BASE_HEIGHT) * 0.25, 2.4, open ? length : length / 2);
  const first = heights[0];
  const last = heights[n - 1];
  const dropA = drop(first);
  const dropB = open ? 0 : drop(last);
  const line = [new THREE.Vector3(a.x, H - HOLE_DEPTH, a.z)];
  turn(line, new THREE.Vector3(a.x, first - dropA, a.z), new THREE.Vector3(a.x, first, a.z), at(dropA));
  for (let i = 1; i < n - 1; i++) {
    const s = i * plan.step;
    if (s > dropA && s < length - dropB) line.push(new THREE.Vector3(plan.x[i], heights[i], plan.z[i]));
  }
  if (open) line.push(at(length));
  else {
    turn(line, at(length - dropB), new THREE.Vector3(b.x, last, b.z), new THREE.Vector3(b.x, last - dropB, b.z));
    line.push(new THREE.Vector3(b.x, H - HOLE_DEPTH, b.z));
  }
  const path = simplify(line, quality.tolerance);
  const [bareA, rest] = cutAbove(path, STRIP_AT);
  if (open) return { insulation: rest, bareA, bareB: [] };
  const [bareB, insulation] = cutAbove(rest.slice().reverse(), STRIP_AT);
  return { insulation: insulation.reverse(), bareA, bareB };
}

/** A jumper along its route, or a lead to a bench instrument. */
export function wireShape(a: V, b: V, bends: readonly V[], route: Route | null, open = false): WireShape {
  if (isLead(a, b)) return leadShape(a, b, bends, route, open);
  return route ? jumperShape(a, b, route, open) : { insulation: [], bareA: [], bareB: [] };
}

/** The stripped ends; a lead has only the one at the board. */
function bareGeometry(shape: WireShape): THREE.BufferGeometry {
  const ends = [shape.bareA, shape.bareB].filter((p) => p.length > 1).map((p) => tube(p, BARE_RADIUS, 6, false));
  return (ends.length && mergeGeometries(ends)) || new THREE.BufferGeometry();
}

/** The bends of a wire as points on the board surface. */
export const bendPoints = (w: WireDoc): V[] => (w.points ?? []).map((p) => new THREE.Vector3(p.x, H, p.z));

const pathKey = (path: readonly V[]): string =>
  path.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)},${p.z.toFixed(2)}`).join(';');

/** A wire being drawn or dragged, shown as a ghost of what it'll look like put down. */
export interface PendingWire {
  /** Its ends with its bends between. */
  path: readonly V[];
  color: WireColor;
  /** It stops at its last point, where it'll bend next, rather than going into a hole there. */
  open?: boolean;
  /** Drawn red when it can't go there. */
  valid?: boolean;
  /** Its place among the wires, which settles who goes over whom where it crosses one; last if left out. */
  index?: number;
}

const ghostMaterials = new Map<WireColor, THREE.Material>();
function ghostInsulation(color: WireColor): THREE.Material {
  let m = ghostMaterials.get(color);
  if (!m) {
    m = new THREE.MeshStandardMaterial({
      color: WIRE_HEX[color],
      roughness: 0.5,
      transparent: true,
      opacity: 0.5,
      depthWrite: false,
    });
    ghostMaterials.set(color, m);
  }
  return m;
}
const ghostTin = new THREE.MeshStandardMaterial({
  color: 0xc4c8ce,
  metalness: 0.6,
  roughness: 0.4,
  transparent: true,
  opacity: 0.5,
  depthWrite: false,
});
/** How far (mm) a selected wire's halo stands out from it. */
const HALO = 0.3;

// Where a click puts the next bend: a dot like the bend handles on a selected wire.
const markGeometry = new THREE.SphereGeometry(0.95, 16, 10);
const markRing = themed(new THREE.MeshBasicMaterial({ depthTest: false }), 'mark');
const markFill = themed(new THREE.MeshBasicMaterial({ depthTest: false }), 'accent');

interface Placed {
  doc: WireDoc;
  a: V;
  b: V;
  bends: V[];
}

interface Entry extends Placed {
  /** Where it runs, for a jumper; a lead hangs in the air and has none. */
  route: Route | null;
  shape: WireShape;
  insulation: THREE.BufferGeometry;
  bare: THREE.BufferGeometry;
  /** Round its insulation with room to pick it: a ray that misses this misses the wire. */
  box: THREE.Box3;
}

/** How near (mm) a ray has to pass a wire's centre line to pick it. */
const PICK_REACH = WIRE_RADIUS + 0.35;

function buildEntry(w: Placed, route: Route | null): Entry {
  const shape = wireShape(w.a, w.b, w.bends, route);
  return {
    ...w,
    route,
    shape,
    insulation: quality.ribbon ? ribbon(shape.insulation) : tube(shape.insulation, WIRE_RADIUS, SIDES),
    bare: bareGeometry(shape),
    box: new THREE.Box3().setFromPoints(shape.insulation).expandByScalar(PICK_REACH),
  };
}

function disposeEntry(e: Entry): void {
  e.insulation.dispose();
  e.bare.dispose();
}

const sameRoute = (r: Route | null, s: Route | null): boolean =>
  r === s ||
  (!!r &&
    !!s &&
    r.plan === s.plan &&
    r.heights.length === s.heights.length &&
    r.heights.every((h, i) => Math.abs(h - s.heights[i]) < 1e-6));

/** What a wire carries while the circuit runs: high, low, or neither (floating or in between). */
export type WireLevel = 'H' | 'L' | 'Z';

// The usual logic-simulator colours: bright green high, dark green low, grey floating.
const LEVEL_COLORS: Record<WireLevel, THREE.Color> = {
  H: new THREE.Color(0x3fd45a),
  L: new THREE.Color(0x1d5a2b),
  Z: new THREE.Color(0x8d95a3),
};

/** A mesh of wires' insulation; ribbons turn to face the light when they cast their shadows. */
function insulationMesh(geometry: THREE.BufferGeometry, color: WireColor | 'levels'): THREE.Mesh {
  const mesh = new THREE.Mesh(geometry, wireMaterial(color, quality.ribbon));
  if (quality.ribbon) {
    mesh.customDepthMaterial = ribbonDepthMaterial;
    // Its bounds are worked out from the centre lines, a wire's radius short of its edges.
    mesh.frustumCulled = false;
  }
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

/** See-through stand-ins for wire materials while Fade wires is on, one per material. */
const faded = new Map<THREE.Material, THREE.Material>();
function fadedOf(m: THREE.Material): THREE.Material {
  let f = faded.get(m);
  if (!f) {
    f = m.clone();
    f.onBeforeCompile = m.onBeforeCompile;
    f.customProgramCacheKey = m.customProgramCacheKey;
    f.transparent = true;
    f.opacity = 0.14;
    f.depthWrite = false;
    faded.set(m, f);
  }
  return f;
}

export class WireLayer {
  readonly group = new THREE.Group();
  /** Fade wires: drawn see-through, so the parts under them show. */
  private faded = false;
  private entries = new Map<Id, Entry>();
  private readonly router = new Router();
  private placed: Placed[] = [];
  private obstacles: readonly Obstacle[] = [];
  private pending: PendingWire | null = null;
  private pendingKey = '';
  private ghost: THREE.Group | null = null;
  private merged = new Map<WireColor | 'bare', THREE.Mesh>();
  private hoverId: Id | null = null;
  private selected = new Set<Id>();
  private sleeves: THREE.Mesh[] = [];
  /**
   * Every wire in one mesh, coloured by the logic level it carries: shown in place of their own
   * colours while the circuit runs with levels on. Changing a wire's level rewrites its vertices'
   * colours; nothing is rebuilt.
   */
  private levels: { mesh: THREE.Mesh; ranges: Map<Id, [number, number]>; shown: Map<Id, WireLevel> } | null = null;
  private levelsOn = false;
  /** What the wires were last laid out from: their ends, bends and colours in order, and the parts in their way. */
  private signature = '';

  /** Redraws every wire in the given quality. */
  setQuality(q: WireQuality): void {
    if (quality === QUALITY[q]) return;
    quality = QUALITY[q];
    for (const e of this.entries.values()) disposeEntry(e);
    this.entries.clear();
    for (const key of [...this.merged.keys()]) this.rebuild(key);
    this.reroute();
  }

  /** Fade wires on or off. True if that changed anything. */
  setFaded(on: boolean): boolean {
    if (this.faded === on) return false;
    this.faded = on;
    for (const mesh of this.merged.values()) this.applyFade(mesh);
    if (this.levels) this.applyFade(this.levels.mesh);
    return true;
  }

  private applyFade(mesh: THREE.Mesh): void {
    const own = (mesh.userData.material ??= mesh.material) as THREE.Material;
    mesh.material = this.faded ? fadedOf(own) : own;
    mesh.castShadow = !this.faded;
  }

  /** Shows or hides jumper geometry without changing the electrical circuit. */
  setVisible(visible: boolean): boolean {
    if (this.group.visible === visible) return false;
    this.group.visible = visible;
    return true;
  }

  update(wires: readonly WireDoc[], resolve: (r: HoleRef) => V | null, obstacles: readonly Obstacle[]): void {
    this.placed = [];
    for (const doc of wires) {
      const a = resolve(doc.a);
      const b = resolve(doc.b);
      if (a && b) this.placed.push({ doc, a, b, bends: bendPoints(doc) });
    }
    this.obstacles = obstacles;
    // Most edits leave the wiring alone (a part's value, a switch flipped): then nothing needs routing again.
    const at = (p: V): string => `${p.x},${p.y},${p.z}`;
    const signature =
      this.placed
        .map((w) => `${w.doc.id}:${w.doc.color}:${at(w.a)}:${at(w.b)}:${w.bends.map(at).join(';')}`)
        .join('|') +
      '#' +
      obstacles.map((o) => o.key).join('|');
    if (signature === this.signature) {
      for (const w of this.placed) {
        const e = this.entries.get(w.doc.id);
        if (e) e.doc = w.doc;
      }
      return;
    }
    this.signature = signature;
    this.reroute();
  }

  /** Shows a wire being drawn or dragged as a ghost (null for none), with the wires it would make hop doing so already. */
  setPending(wire: PendingWire | null): void {
    const key =
      wire && wire.path.length >= 2
        ? `${pathKey(wire.path)}|${wire.color}|${!!wire.open}|${wire.valid !== false}|${wire.index ?? ''}`
        : '';
    if (key === this.pendingKey) return;
    this.pendingKey = key;
    this.pending = key ? wire : null;
    this.reroute();
  }

  private reroute(): void {
    const pending = this.pending;
    const list: (Placed | PendingWire)[] = [...this.placed];
    if (pending) list.splice(Math.max(0, Math.min(list.length, pending.index ?? list.length)), 0, pending);
    const ends = (w: Placed | PendingWire): [V, V, V[]] =>
      'doc' in w ? [w.a, w.b, w.bends] : [w.path[0], w.path[w.path.length - 1], w.path.slice(1, -1)];
    const routed = this.router.route(
      list.map((w) => {
        const [a, b, bends] = ends(w);
        return { path: routePath(a, bends, b), open: pending !== null && w === pending && !!pending.open };
      }),
      this.obstacles,
    );
    const routes = new Map<Placed | PendingWire, Route>(list.map((w, k) => [w, routed[k]]));

    const next = new Map<Id, Entry>();
    const dirty = new Set<WireColor | 'bare'>();
    for (const w of this.placed) {
      const route = routes.get(w) ?? null;
      const old = this.entries.get(w.doc.id);
      const same =
        old &&
        old.doc.color === w.doc.color &&
        old.a.equals(w.a) &&
        old.b.equals(w.b) &&
        old.bends.length === w.bends.length &&
        old.bends.every((p, i) => p.equals(w.bends[i])) &&
        sameRoute(old.route, route);
      if (old && same) {
        old.doc = w.doc;
        next.set(w.doc.id, old);
        continue;
      }
      if (old) {
        dirty.add(old.doc.color);
        disposeEntry(old);
      }
      dirty.add(w.doc.color).add('bare');
      next.set(w.doc.id, buildEntry(w, route));
    }
    for (const [id, e] of this.entries) {
      if (next.has(id)) continue;
      dirty.add(e.doc.color).add('bare');
      disposeEntry(e);
    }
    this.entries = next;
    for (const key of dirty) this.rebuild(key);
    // The levels mesh is remade, coloured, the next time levels are shown; till then, own colours.
    if (dirty.size && this.levels) {
      this.group.remove(this.levels.mesh);
      this.levels.mesh.geometry.dispose();
      this.levels = null;
      this.levelsOn = false;
      for (const mesh of this.merged.values()) mesh.visible = true;
    }
    this.showGhost(pending, pending ? (routes.get(pending) ?? null) : null);
    if (this.hoverId && !next.has(this.hoverId)) this.hoverId = null;
    for (const id of this.selected) if (!next.has(id)) this.selected.delete(id);
    this.refreshSleeves();
  }

  /** Nearest wire under the ray, if any. Faded wires can't be picked: clicks go through to what's under them. */
  pick(ray: THREE.Ray): { id: Id; distance: number } | null {
    if (!this.group.visible || this.faded) return null;
    let best: { id: Id; distance: number } | null = null;
    const onRay = new THREE.Vector3();
    const reach = PICK_REACH ** 2;
    for (const e of this.entries.values()) {
      if (!ray.intersectsBox(e.box)) continue;
      const pts = e.shape.insulation;
      for (let i = 0; i < pts.length - 1; i++) {
        if (ray.distanceSqToSegment(pts[i], pts[i + 1], onRay) > reach) continue;
        const distance = onRay.distanceTo(ray.origin);
        if (!best || distance < best.distance) best = { id: e.doc.id, distance };
      }
    }
    return best;
  }

  /** Where a wire's bends are drawn: on top of it, where handles for them go. */
  bendHandles(id: Id): V[] {
    const e = this.entries.get(id);
    if (!e) return [];
    const route = e.route;
    const lift = isLead(e.a, e.b) ? LEAD_LIFT : 0;
    return e.bends.map(
      (p, k) => new THREE.Vector3(p.x, (route ? heightAt(route, route.plan.corners[k + 1]) : BASE_HEIGHT) + lift, p.z),
    );
  }

  /**
   * The middle of each straight run of a wire, where a handle to pull a new bend out of it goes.
   * `run` counts from the first end: a bend pulled out of run k goes in as the wire's bend k.
   * Runs too short to take one between their handles get none.
   */
  midHandles(id: Id): { at: V; run: number; from: V; to: V }[] {
    const e = this.entries.get(id);
    if (!e) return [];
    const route = e.route;
    const lift = isLead(e.a, e.b) ? LEAD_LIFT : 0;
    const path = [e.a, ...e.bends, e.b];
    const out: { at: V; run: number; from: V; to: V }[] = [];
    for (let k = 0; k < path.length - 1; k++) {
      const p = path[k];
      const q = path[k + 1];
      if (Math.hypot(q.x - p.x, q.z - p.z) < MID_HANDLE_MIN_RUN) continue;
      const s = route ? (route.plan.corners[k] + route.plan.corners[k + 1]) / 2 : 0;
      const y = (route ? heightAt(route, s) : BASE_HEIGHT) + lift;
      out.push({ at: new THREE.Vector3((p.x + q.x) / 2, y, (p.z + q.z) / 2), run: k, from: p, to: q });
    }
    return out;
  }

  setHover(id: Id | null): void {
    if (id === this.hoverId) return;
    this.hoverId = id;
    this.refreshSleeves();
  }

  /**
   * Colours every wire by the level `level` reads for it, or (null) puts their own colours back.
   * Returns whether anything on screen changed.
   */
  showLevels(level: ((doc: WireDoc) => WireLevel) | null): boolean {
    const on = level !== null;
    let changed = on !== this.levelsOn;
    this.levelsOn = on;
    for (const [key, mesh] of this.merged) if (key !== 'bare') mesh.visible = !on;
    if (!level) {
      if (this.levels) this.levels.mesh.visible = false;
      return changed;
    }
    if (!this.levels) {
      this.levels = this.buildLevels();
      changed = true;
    }
    const levels = this.levels;
    if (!levels) return changed;
    levels.mesh.visible = true;
    const colors = levels.mesh.geometry.attributes.color as THREE.BufferAttribute;
    for (const e of this.entries.values()) {
      const range = levels.ranges.get(e.doc.id);
      const now = level(e.doc);
      if (!range || levels.shown.get(e.doc.id) === now) continue;
      levels.shown.set(e.doc.id, now);
      const c = LEVEL_COLORS[now];
      for (let i = range[0]; i < range[0] + range[1]; i++) colors.setXYZ(i, c.r, c.g, c.b);
      colors.needsUpdate = true;
      changed = true;
    }
    return changed;
  }

  private buildLevels(): WireLayer['levels'] {
    const geoms: THREE.BufferGeometry[] = [];
    const ranges = new Map<Id, [number, number]>();
    let at = 0;
    for (const e of this.entries.values()) {
      const g = e.insulation;
      if (!g?.attributes.position) continue;
      geoms.push(g);
      ranges.set(e.doc.id, [at, g.attributes.position.count]);
      at += g.attributes.position.count;
    }
    const geometry = geoms.length ? mergeGeometries(geoms) : null;
    if (!geometry) return null;
    geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(at * 3), 3));
    const mesh = insulationMesh(geometry, 'levels');
    this.group.add(mesh);
    return { mesh, ranges, shown: new Map() };
  }

  /** Redraws the highlight sleeves in the current theme colour. */
  restyle(): void {
    this.refreshSleeves();
  }

  setSelected(ids: readonly Id[]): void {
    if (ids.length === this.selected.size && ids.every((id) => this.selected.has(id))) return;
    this.selected = new Set(ids);
    this.refreshSleeves();
  }

  /** Remerges one colour's wires, or ('bare') everyone's stripped ends. */
  private rebuild(key: WireColor | 'bare'): void {
    const old = this.merged.get(key);
    if (old) {
      old.geometry.dispose();
      this.group.remove(old);
      this.merged.delete(key);
    }
    const geoms: THREE.BufferGeometry[] = [];
    for (const e of this.entries.values()) {
      const g = key === 'bare' ? e.bare : e.doc.color === key ? e.insulation : null;
      if (g?.attributes.position) geoms.push(g);
    }
    const geometry = geoms.length ? mergeGeometries(geoms) : null;
    if (!geometry) return;
    let mesh: THREE.Mesh;
    if (key === 'bare') {
      mesh = new THREE.Mesh(geometry, tinMaterial);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
    } else mesh = insulationMesh(geometry, key);
    if (this.faded) this.applyFade(mesh);
    this.group.add(mesh);
    this.merged.set(key, mesh);
  }

  private showGhost(wire: PendingWire | null, route: Route | null): void {
    if (this.ghost) {
      this.group.remove(this.ghost);
      this.ghost.traverse((o) => {
        if (o instanceof THREE.Mesh && o.geometry.userData.owned) o.geometry.dispose();
      });
      this.ghost = null;
    }
    if (!wire) return;
    const a = wire.path[0];
    const b = wire.path[wire.path.length - 1];
    const shape = wireShape(a, b, wire.path.slice(1, -1), route, !!wire.open);
    const group = new THREE.Group();
    group.add(new THREE.Mesh(owned(tube(shape.insulation, WIRE_RADIUS, SIDES)), ghostInsulation(wire.color)));
    const bare = owned(bareGeometry(shape));
    if (bare.attributes.position) group.add(new THREE.Mesh(bare, ghostTin));
    else bare.dispose();
    if (wire.valid === false) ghostify(group, false);
    else group.traverse((o) => void (o.renderOrder = 2));
    const end = shape.insulation[shape.insulation.length - 1];
    if (wire.open && end) {
      const ring = new THREE.Mesh(markGeometry, markRing);
      ring.scale.setScalar(1.25);
      const fill = new THREE.Mesh(markGeometry, markFill);
      ring.position.copy(end);
      fill.position.copy(end);
      ring.renderOrder = 8;
      fill.renderOrder = 9;
      group.add(ring, fill);
    }
    this.ghost = group;
    this.group.add(group);
  }

  /**
   * A halo round the selected wires, and a fainter one round the wire under the pointer: sleeves a
   * little wider than the wire, drawn from the inside only, so what shows is a ring along the wire's
   * edges, in the selection box's ink.
   */
  private refreshSleeves(): void {
    for (const s of this.sleeves) {
      this.group.remove(s);
      s.geometry.dispose();
      (s.material as THREE.Material).dispose();
    }
    this.sleeves = [];
    // However many are selected, their halos are one mesh.
    const add = (
      ids: Iterable<Id>,
      width: number,
      color: THREE.ColorRepresentation,
      opacity: number,
      order: number,
    ): void => {
      const tubes: THREE.BufferGeometry[] = [];
      for (const id of ids) {
        const e = this.entries.get(id);
        if (e) tubes.push(tube(e.shape.insulation, WIRE_RADIUS + width, 12));
      }
      const geometry = tubes.length > 1 ? mergeGeometries(tubes) : tubes[0];
      if (tubes.length > 1) for (const t of tubes) t.dispose();
      if (!geometry) return;
      const sleeve = new THREE.Mesh(
        geometry,
        new THREE.MeshBasicMaterial({ color, side: THREE.BackSide, transparent: true, opacity, depthWrite: false }),
      );
      sleeve.renderOrder = order;
      this.group.add(sleeve);
      this.sleeves.push(sleeve);
    };
    // Ink outside, a light ring inside it, so it shows on a black wire as well as a white one.
    add(this.selected, HALO * 2, palette.mark, 0.9, 3);
    add(this.selected, HALO, 0xffffff, 1, 4);
    if (this.hoverId && !this.selected.has(this.hoverId)) add([this.hoverId], HALO, palette.mark, 0.35, 3);
  }
}
