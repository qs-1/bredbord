// Where a jumper wire runs. It lies flat on the board and hops only where it has to: over a wire
// it crosses, over another wire's end coming up out of a hole underneath it, and over parts in its
// way. A part held up on its legs, like an LED's lens, lets wires pass underneath.

import * as THREE from 'three';
import { BOARD_HEIGHT as H } from '../engine/breadboard';

type V = THREE.Vector3;

/** Radius of a wire's insulation, mm. */
export const WIRE_RADIUS = 0.5;
/** The radius wires keep their distance by, side to side: a little more than they are, so neighbours don't crowd. */
const ROUTING_RADIUS = 0.66;
/** Height of a wire's centre where it lies on the board. */
export const BASE_HEIGHT = H + WIRE_RADIUS + 0.16;
/** How much higher a wire's centre goes to clear another wire. */
export const STACK = WIRE_RADIUS * 2 + 0.1;
/** How round a wire turns at one of its bends. */
export const BEND_RADIUS = 3.2;
/** Spacing of the points along a wire that its height is worked out at, mm. */
const STEP = 0.35;
/** Steepest a wire climbs: rise per mm along it. */
const SLOPE = 1.15;
/** How far a hop's shoulders are rounded off, mm. Its top is widened by as much first, so the rounding never dips into what it clears. */
const SOFTEN = 1.2;
/** Wires closer than this, centre to centre, would touch. */
const TOUCH = 2 * ROUTING_RADIUS + 0.12;
/** Room a wire leaves around a part. */
const GAP = 0.15;
/** A wire coming up out of its hole right beside a part brushes past it rather than climbing over it: parts only count from this far along. */
const END_CLEAR = 1.2;
/** Points per chunk of a plan, for finding the stretches of two wires that come near each other. */
const CHUNK = 16;

interface Bounds {
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
}

const overlaps = (a: Bounds, b: Bounds, margin: number): boolean =>
  a.minX - margin <= b.maxX && b.minX - margin <= a.maxX && a.minZ - margin <= b.maxZ && b.minZ - margin <= a.maxZ;

let nearestT = 0;
/** Distance from (x, z) to the segment a–b. Leaves how far along it the nearest point is (0..1) in `nearestT`. */
function nearest(x: number, z: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax;
  const dz = bz - az;
  const len2 = dx * dx + dz * dz;
  nearestT = len2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / len2)) : 0;
  const ex = x - ax - nearestT * dx;
  const ez = z - az - nearestT * dz;
  return Math.sqrt(ex * ex + ez * ez);
}

// ---- obstacles ----

/**
 * A solid piece of something on the board that wires keep out of: its outline seen from above and
 * the heights it fills. A wire passes under one whose bottom is clear of it, and hops over the rest.
 */
export interface Obstacle extends Bounds {
  readonly bottom: number;
  readonly top: number;
  /** Its shape and place, so a layout that hasn't changed isn't routed again. */
  readonly key: string;
  /** How far (x, z) is outside its outline; 0 inside. */
  distance(x: number, z: number): number;
}

const f2 = (n: number): string => n.toFixed(2);

export function boxObstacle(minX: number, maxX: number, minZ: number, maxZ: number, top: number, bottom = H): Obstacle {
  return {
    minX,
    maxX,
    minZ,
    maxZ,
    top,
    bottom,
    key: `b${[minX, maxX, minZ, maxZ, top, bottom].map(f2).join(',')}`,
    distance: (x, z) => Math.hypot(Math.max(minX - x, 0, x - maxX), Math.max(minZ - z, 0, z - maxZ)),
  };
}

/** A rounded bar from p to q: a lying resistor's body, a bent leg; with p = q, something round. */
export function capsuleObstacle(p: V, q: V, radius: number, top: number, bottom = H): Obstacle {
  return {
    minX: Math.min(p.x, q.x) - radius,
    maxX: Math.max(p.x, q.x) + radius,
    minZ: Math.min(p.z, q.z) - radius,
    maxZ: Math.max(p.z, q.z) + radius,
    top,
    bottom,
    key: `c${[p.x, p.z, q.x, q.z, radius, top, bottom].map(f2).join(',')}`,
    distance: (x, z) => Math.max(0, nearest(x, z, p.x, p.z, q.x, q.z) - radius),
  };
}

/**
 * Whether two solids overlap by more than a hair (a millimetre or so each way), so parts that only
 * touch or brush (chips end to end, resistors leaning side by side) don't count. Checked by sampling
 * where their outlines' boxes meet.
 */
export function obstaclesMeet(a: Obstacle, b: Obstacle): boolean {
  const slack = 0.5;
  if (a.bottom >= b.top - slack || b.bottom >= a.top - slack) return false;
  const x0 = Math.max(a.minX, b.minX) + slack;
  const x1 = Math.min(a.maxX, b.maxX) - slack;
  const z0 = Math.max(a.minZ, b.minZ) + slack;
  const z1 = Math.min(a.maxZ, b.maxZ) - slack;
  if (x0 > x1 || z0 > z1) return false;
  const nx = Math.ceil((x1 - x0) / 0.2) + 1;
  const nz = Math.ceil((z1 - z0) / 0.2) + 1;
  const both = (x: number, z: number): boolean => a.distance(x, z) === 0 && b.distance(x, z) === 0;
  for (let i = 0; i < nx; i++) {
    const x = nx > 1 ? x0 + ((x1 - x0) * i) / (nx - 1) : x0;
    for (let j = 0; j < nz; j++) {
      const z = nz > 1 ? z0 + ((z1 - z0) * j) / (nz - 1) : z0;
      if (both(x, z) && both(x - slack, z) && both(x + slack, z) && both(x, z - slack) && both(x, z + slack))
        return true;
    }
  }
  return false;
}

export const discObstacle = (c: V, radius: number, top: number, bottom = H): Obstacle =>
  capsuleObstacle(c, c, radius, top, bottom);

// ---- plans ----

/** A wire seen from above: evenly spaced points along it, rounded off at its bends. */
export interface Plan extends Bounds {
  readonly x: Float64Array;
  readonly z: Float64Array;
  /** Distance between neighbouring points, measured along the path through its bends. */
  readonly step: number;
  readonly length: number;
  /** How far along it each corner of its path is: its ends and its bends. */
  readonly corners: readonly number[];
  readonly chunks: readonly (Bounds & { from: number; to: number })[];
}

export function planOf(path: readonly V[]): Plan {
  const n = path.length;
  const corners = [0];
  for (let i = 1; i < n; i++)
    corners.push(corners[i - 1] + Math.hypot(path[i].x - path[i - 1].x, path[i].z - path[i - 1].z));
  const length = corners[n - 1];
  const count = Math.max(2, Math.ceil(length / STEP) + 1);
  const step = length / (count - 1);
  // Each bend is rounded off this far either side of it, the way roundCorners does it.
  const radius = path.map((_, k) =>
    k === 0 || k === n - 1
      ? 0
      : Math.min(BEND_RADIUS, (corners[k] - corners[k - 1]) / 2, (corners[k + 1] - corners[k]) / 2),
  );
  const x = new Float64Array(count);
  const z = new Float64Array(count);
  let seg = 0;
  for (let i = 0; i < count; i++) {
    const s = Math.min(length, i * step);
    while (seg < n - 2 && s > corners[seg + 1]) seg++;
    const k = s - corners[seg] < corners[seg + 1] - s ? seg : seg + 1;
    const r = radius[k];
    if (r > 1e-4 && Math.abs(s - corners[k]) < r) {
      const c = path[k];
      const l1 = corners[k] - corners[k - 1];
      const l2 = corners[k + 1] - corners[k];
      const sx = c.x - (r * (c.x - path[k - 1].x)) / l1;
      const sz = c.z - (r * (c.z - path[k - 1].z)) / l1;
      const ex = c.x + (r * (path[k + 1].x - c.x)) / l2;
      const ez = c.z + (r * (path[k + 1].z - c.z)) / l2;
      const t = (s - corners[k] + r) / (2 * r);
      const u = 1 - t;
      x[i] = u * u * sx + 2 * u * t * c.x + t * t * ex;
      z[i] = u * u * sz + 2 * u * t * c.z + t * t * ez;
    } else {
      const l = corners[seg + 1] - corners[seg];
      const f = l > 0 ? (s - corners[seg]) / l : 0;
      x[i] = path[seg].x + f * (path[seg + 1].x - path[seg].x);
      z[i] = path[seg].z + f * (path[seg + 1].z - path[seg].z);
    }
  }
  const chunks: (Bounds & { from: number; to: number })[] = [];
  for (let from = 0; from < count - 1; from += CHUNK) {
    const to = Math.min(count - 1, from + CHUNK);
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (let i = from; i <= to; i++) {
      minX = Math.min(minX, x[i]);
      maxX = Math.max(maxX, x[i]);
      minZ = Math.min(minZ, z[i]);
      maxZ = Math.max(maxZ, z[i]);
    }
    chunks.push({ from, to, minX, maxX, minZ, maxZ });
  }
  return {
    x,
    z,
    step,
    length,
    corners,
    chunks,
    minX: Math.min(...chunks.map((c) => c.minX)),
    maxX: Math.max(...chunks.map((c) => c.maxX)),
    minZ: Math.min(...chunks.map((c) => c.minZ)),
    maxZ: Math.max(...chunks.map((c) => c.maxZ)),
  };
}

// ---- crossings ----

interface Touching {
  /** For each point that would touch the other wire, how far along the other wire its nearest point is. */
  along: Float64Array;
  /** And how far away that is; Infinity where it doesn't touch. */
  gap: Float64Array;
}

function touching(p: Plan, q: Plan): Touching | null {
  if (!overlaps(p, q, TOUCH)) return null;
  // Only the stretches of each that come anywhere near the other: two long wires' chunks paired
  // up every way is millions of checks across a big circuit, nearly all of them misses.
  const nearQ = p.chunks.filter((c) => overlaps(c, q, TOUCH));
  if (!nearQ.length) return null;
  const nearP = q.chunks.filter((c) => overlaps(c, p, TOUCH));
  let found: Touching | null = null;
  for (const cp of nearQ) {
    for (const cq of nearP) {
      if (!overlaps(cp, cq, TOUCH)) continue;
      for (let i = cp.from; i <= cp.to; i++) {
        const x = p.x[i];
        const z = p.z[i];
        if (x < cq.minX - TOUCH || x > cq.maxX + TOUCH || z < cq.minZ - TOUCH || z > cq.maxZ + TOUCH) continue;
        for (let j = cq.from; j < cq.to; j++) {
          // Most of a chunk's segments are plainly too far off to touch: skip those cheaply.
          const ax = q.x[j];
          const az = q.z[j];
          const bx = q.x[j + 1];
          const bz = q.z[j + 1];
          if (
            (x < ax - TOUCH && x < bx - TOUCH) ||
            (x > ax + TOUCH && x > bx + TOUCH) ||
            (z < az - TOUCH && z < bz - TOUCH) ||
            (z > az + TOUCH && z > bz + TOUCH)
          )
            continue;
          const d = nearest(x, z, ax, az, bx, bz);
          if (d >= TOUCH) continue;
          found ??= { along: new Float64Array(p.x.length).fill(NaN), gap: new Float64Array(p.x.length).fill(Infinity) };
          if (d < found.gap[i]) {
            found.gap[i] = d;
            found.along[i] = (j + nearestT) * q.step;
          }
        }
      }
    }
  }
  return found;
}

/** A stretch of one wire touching another, and its point closest to it. */
interface Crossing {
  from: number;
  to: number;
  at: number;
}

function crossings(t: Touching | null): Crossing[] {
  const out: Crossing[] = [];
  if (!t) return out;
  let from = -1;
  for (let i = 0; i <= t.gap.length; i++) {
    const on = i < t.gap.length && t.gap[i] < TOUCH;
    if (on && from < 0) from = i;
    if (on || from < 0) continue;
    let at = from;
    for (let k = from + 1; k < i; k++) if (t.gap[k] < t.gap[at]) at = k;
    out.push({ from, to: i - 1, at });
    from = -1;
  }
  return out;
}

/** How far a point `s` mm along a wire is from the nearer of its ends that come up out of a hole. */
const fromEnd = (s: number, plan: Plan, open: boolean): number => Math.min(s, open ? Infinity : plan.length - s);

/** Whether an end of `q` that comes up out of a hole lies within touching distance of `p`'s points `from`..`to`. */
function endUnder(q: Plan, openQ: boolean, p: Plan, from: number, to: number): boolean {
  for (const e of openQ ? [0] : [0, q.x.length - 1]) {
    for (let i = from; i <= Math.max(from, to - 1); i++) {
      const j = Math.min(i + 1, p.x.length - 1);
      if (nearest(q.x[e], q.z[e], p.x[i], p.z[i], p.x[j], p.z[j]) < TOUCH) return true;
    }
  }
  return false;
}

/**
 * Whether the earlier wire goes on top at a crossing. A wire whose end comes up out of its hole
 * there goes underneath; otherwise the later one goes on top. When both ends are there (wires laid
 * along each other), the one whose end is nearer where they're closest goes underneath.
 */
function earlierOver(
  endE: boolean,
  endL: boolean,
  se: number,
  pe: Plan,
  openE: boolean,
  sl: number,
  pl: Plan,
  openL: boolean,
): boolean {
  if (endE !== endL) return endL;
  return endE && fromEnd(sl, pl, openL) < fromEnd(se, pe, openE);
}

/** A stretch of a wire that has to clear another: over these points, above the other wire `along` mm along it. */
interface Hop {
  from: number;
  to: number;
  along: Float64Array;
}

interface PairHops {
  /** Stretches of the earlier wire going over the later one where it comes up out of its hole. */
  earlier: Hop[];
  /** Stretches of the later wire going over the earlier one. */
  later: Hop[];
}

function pairHops(pe: Plan, openE: boolean, pl: Plan, openL: boolean): PairHops {
  const te = touching(pe, pl);
  const tl = touching(pl, pe);
  const ce = crossings(te);
  const cl = crossings(tl);
  const hop = (t: Touching, c: Crossing): Hop => ({ from: c.from, to: c.to, along: t.along.slice(c.from, c.to + 1) });
  // Who's on top is settled once per crossing, from the earlier wire's side, so both wires agree.
  const top = ce.map((c) => {
    const endE = c.from === 0 || (!openE && c.to === pe.x.length - 1);
    return earlierOver(
      endE,
      endUnder(pl, openL, pe, c.from, c.to),
      c.at * pe.step,
      pe,
      openE,
      te!.along[c.at],
      pl,
      openL,
    );
  });
  const result: PairHops = { earlier: ce.filter((_, k) => top[k]).map((c) => hop(te!, c)), later: [] };
  for (const c of cl) {
    const s = tl!.along[c.at];
    let match = -1;
    let best = 2 * TOUCH;
    ce.forEach((d, k) => {
      const off = Math.max(d.from * pe.step - s, s - d.to * pe.step, 0);
      if (off < best) {
        best = off;
        match = k;
      }
    });
    const endL = c.from === 0 || (!openL && c.to === pl.x.length - 1);
    const earlier =
      match >= 0
        ? top[match]
        : earlierOver(endUnder(pe, openE, pl, c.from, c.to), endL, s, pe, openE, c.at * pl.step, pl, openL);
    if (!earlier) result.later.push(hop(tl!, c));
  }
  return result;
}

// ---- heights ----

/** A wire's route: its plan, and the height of its centre at each point of it. */
export interface Route {
  readonly plan: Plan;
  readonly heights: Float64Array;
}

export function heightAt(route: Route, s: number): number {
  const { heights, plan } = route;
  const n = heights.length;
  if (!(plan.step > 0)) return heights[0];
  const f = Math.max(0, Math.min(n - 1, s / plan.step));
  const i = Math.min(n - 2, Math.floor(f));
  const t = f - i;
  return heights[i] * (1 - t) + heights[i + 1] * t;
}

/** The highest a wire gets within `reach` mm either way of `s` along it. */
function peakNear(route: Route, s: number, reach: number): number {
  const { heights, plan } = route;
  let m = Math.max(heightAt(route, s - reach), heightAt(route, s + reach));
  if (plan.step > 0) {
    const to = Math.min(heights.length - 1, Math.floor((s + reach) / plan.step));
    for (let i = Math.max(0, Math.ceil((s - reach) / plan.step)); i <= to; i++) m = Math.max(m, heights[i]);
  }
  return m;
}

function blur(v: Float64Array, half: number): Float64Array {
  const n = v.length;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let j = i - half; j <= i + half; j++) sum += v[Math.max(0, Math.min(n - 1, j))];
    out[i] = sum / (2 * half + 1);
  }
  return out;
}

/** A wire's heights from the least it needs at each point: no steeper than SLOPE, with its hops' shoulders rounded off. */
function settle(need: Float64Array, step: number): Float64Array {
  const n = need.length;
  if (need.every((h) => h <= BASE_HEIGHT + 1e-9)) return need.slice();
  const half = step > 0 ? Math.max(1, Math.round(SOFTEN / step / 2)) : 1;
  // Widen every hop by as far as the two blurs reach, so they can't take it below what it needs.
  const h = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let m = -Infinity;
    for (let j = Math.max(0, i - 2 * half); j <= Math.min(n - 1, i + 2 * half); j++) m = Math.max(m, need[j]);
    h[i] = m;
  }
  const fall = SLOPE * step;
  for (let i = 1; i < n; i++) h[i] = Math.max(h[i], h[i - 1] - fall);
  for (let i = n - 2; i >= 0; i--) h[i] = Math.max(h[i], h[i + 1] - fall);
  return blur(blur(h, half), half);
}

/** One wire to route: its ends with its bends between, on the board surface. */
export interface RouteInput {
  path: readonly V[];
  /** It stops in the air at its last point, where it bends next (a wire still being drawn). */
  open?: boolean;
}

const pathKey = (w: RouteInput): string => {
  let key = w.open ? '~' : '';
  for (const p of w.path) key += `${Math.round(p.x * 1000)},${Math.round(p.z * 1000)};`;
  return key;
};

/**
 * Routes jumpers given in the order they were put down. Where two cross, the later one goes over,
 * unless its end comes up out of its hole there: then the earlier one hops over that end.
 * Each wire is routed after the ones it goes over, so it clears them where they really are.
 * Plans and crossings are kept between calls, so routing again after a small change is cheap.
 */
type Near = readonly { o: Obstacle; points: number[] }[];
type Under = { hop: Hop; under: number };

export class Router {
  private plans = new Map<string, Plan>();
  /** Crossings between two plans, the earlier one first. Plans are kept while in use, so these go with them. */
  private pairs = new WeakMap<Plan, WeakMap<Plan, PairHops>>();
  private parts = '';
  private near = new Map<string, Near>();
  /** Each wire's last route, with what it was worked out from, to hand back while none of that changes. */
  private last = new Map<string, { route: Route; near: Near; hops: Under[]; unders: (Route | undefined)[] }>();

  route(wires: readonly RouteInput[], obstacles: readonly Obstacle[]): Route[] {
    const keys = wires.map(pathKey);
    const plans = new Map<string, Plan>();
    const plan = wires.map((w, k) => {
      let p = plans.get(keys[k]) ?? this.plans.get(keys[k]);
      if (!p) p = planOf(w.path);
      plans.set(keys[k], p);
      return p;
    });
    const n = wires.length;
    const hops: Under[][] = wires.map(() => []);
    // Only wires whose bounds overlap can cross: sweep along x to find them.
    const byX = plan.map((_, k) => k).sort((a, b) => plan[a].minX - plan[b].minX || a - b);
    for (let a = 0; a < n; a++) {
      const i = byX[a];
      for (let b = a + 1; b < n && plan[byX[b]].minX - TOUCH <= plan[i].maxX; b++) {
        const j = byX[b];
        if (!overlaps(plan[i], plan[j], TOUCH)) continue;
        const e = Math.min(i, j);
        const l = Math.max(i, j);
        let row = this.pairs.get(plan[e]);
        if (!row) this.pairs.set(plan[e], (row = new WeakMap()));
        let pair = row.get(plan[l]);
        if (!pair) row.set(plan[l], (pair = pairHops(plan[e], !!wires[e].open, plan[l], !!wires[l].open)));
        for (const hop of pair.earlier) hops[e].push({ hop, under: l });
        for (const hop of pair.later) hops[l].push({ hop, under: e });
      }
    }
    this.plans = plans;

    const parts = obstacles.map((o) => o.key).join('|');
    const oldNear = parts === this.parts ? this.near : new Map<string, Near>();
    const nearMap = new Map<string, Near>();
    const near = plan.map((p, k) => {
      const found = nearMap.get(keys[k]) ?? oldNear.get(keys[k]) ?? blockers(p, obstacles, !!wires[k].open);
      nearMap.set(keys[k], found);
      return found;
    });
    this.parts = parts;
    this.near = nearMap;

    // Each wire waits for the ones it goes over. Wires that go over each other in a loop can't all
    // wait: the earliest of them goes first, taking the ones it hasn't seen yet as lying on the board.
    const waiting = hops.map((list) => new Set(list.map((h) => h.under)).size);
    const over: number[][] = wires.map(() => []);
    hops.forEach((list, k) => new Set(list.map((h) => h.under)).forEach((under) => over[under].push(k)));
    const routes: (Route | undefined)[] = new Array(n);
    const done = new Uint8Array(n);
    const last = new Map<string, { route: Route; near: Near; hops: Under[]; unders: (Route | undefined)[] }>();
    for (let count = 0; count < n; count++) {
      let k = 0;
      while (k < n && (done[k] || waiting[k] > 0)) k++;
      if (k === n) k = done.indexOf(0);
      done[k] = 1;
      const unders = hops[k].map((h) => routes[h.under]);
      const prev = last.get(keys[k]) ?? this.last.get(keys[k]);
      const same =
        prev &&
        prev.route.plan === plan[k] &&
        prev.near === near[k] &&
        prev.hops.length === hops[k].length &&
        prev.hops.every((h, i) => h.hop === hops[k][i].hop && prev.unders[i] === unders[i]);
      const route = same ? prev.route : heights(plan[k], hops[k], routes, near[k]);
      routes[k] = route;
      last.set(keys[k], { route, near: near[k], hops: hops[k], unders });
      for (const o of over[k]) waiting[o]--;
    }
    this.last = last;
    return routes as Route[];
  }
}

/** The parts near a wire, each with the points of it that come within a wire's thickness of it. */
function blockers(plan: Plan, obstacles: readonly Obstacle[], open: boolean): Near {
  const reach = ROUTING_RADIUS + GAP;
  const first = Math.ceil(END_CLEAR / (plan.step || 1));
  const last = plan.x.length - 1 - (open ? 0 : first);
  const near: { o: Obstacle; points: number[] }[] = [];
  for (const o of obstacles) {
    if (!overlaps(plan, o, reach)) continue;
    const points: number[] = [];
    for (const c of plan.chunks) {
      if (!overlaps(c, o, reach)) continue;
      for (let i = Math.max(c.from, first); i <= Math.min(c.to, last); i++) {
        if (points[points.length - 1] !== i && o.distance(plan.x[i], plan.z[i]) < reach) points.push(i);
      }
    }
    if (points.length) near.push({ o, points });
  }
  return near;
}

/** A wire's heights: over the wires it has to clear, where they really are, and over the parts in its way. */
function heights(plan: Plan, hops: readonly Under[], routes: readonly (Route | undefined)[], near: Near): Route {
  const n = plan.x.length;
  const need = new Float64Array(n).fill(BASE_HEIGHT);
  for (const { hop, under } of hops) {
    const route = routes[under];
    for (let i = hop.from; i <= hop.to; i++) {
      // The highest it gets anywhere close by, in case it's climbing there.
      const below = route ? peakNear(route, hop.along[i - hop.from], TOUCH) : BASE_HEIGHT;
      need[i] = Math.max(need[i], below + STACK);
    }
  }
  // Climbing over one thing can bring it up against another (over an LED's leg, into its lens),
  // so keep raising it until it's clear of everything.
  let h = settle(need, plan.step);
  for (let pass = 0; pass < 6 && near.length; pass++) {
    let raised = false;
    for (const { o, points } of near) {
      const clear = o.top + WIRE_RADIUS + GAP;
      for (const i of points) {
        if (h[i] + WIRE_RADIUS > o.bottom - GAP && h[i] < clear - 1e-6 && need[i] < clear - 1e-6) {
          need[i] = clear;
          raised = true;
        }
      }
    }
    if (!raised) break;
    h = settle(need, plan.step);
  }
  return { plan, heights: h };
}
