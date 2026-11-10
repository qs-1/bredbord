// Lays jumper wires out the way a careful builder does: straight runs and square bends only, each
// wire in its own lane beside the others rather than piled on them, around chips rather than over
// them, and crossing other wires square on where it has to.
//
// The desk becomes a grid of lanes: one along every row and every column of holes on any board,
// plus filler lanes a hole pitch apart where there are no holes. A wire is a shortest path through
// that grid (A*, with a charge for each bend), from a free hole in one strip to a free hole in
// another. Once laid, a wire owns its lane: no other wire may run along it or close beside it, only
// cross it. Each wire is laid in turn, so later ones find their way round the earlier ones.

import { boardSpec, PITCH } from './breadboard';
import { holeKey, type CircuitDoc, type DeskPoint, type HoleRef } from './circuit';
import { dipFootprint, PARTS } from './parts';

/** Lanes closer than this would put two wires' insulation into each other. */
const LANE_GAP = 2.0;
/** Hole positions this close are the same lane. */
const SAME_LANE = 0.3;
/** What a bend costs, in mm of extra wire: enough to keep wires straight, not to send them the long way round. */
const BEND = 20;
/** What crossing another wire costs: it has to hop over. */
const CROSS = 3;
/** Extra cost per mm of running over a chip or a switch: a builder goes round them. */
const OVER_BODY = 12;
/** Extra cost per mm over a small part's body, between its legs. */
const OVER_LEADS = 3;
/** How much the search trusts its distance estimate: a little over 1 finds near-best paths much faster. */
const GREED = 1.25;
/** What hopping over a lead standing in a hole costs: allowed, as a wire can arch over it, but avoided. */
const OVER_LEAD = 40;
/** What a spot crowded in an earlier round of untangling costs extra, per round it stayed crowded. */
const HISTORY = 150;
/** What squeezing into a lane another wire already owns costs: only when there's no other way at all. */
const SQUEEZE = 2000;

export interface LaidWire {
  a: HoleRef;
  b: HoleRef;
  /** The bends between its ends. */
  points: DeskPoint[];
  /** What it cost: its length in mm plus the charges for bends, hops and the rest. */
  cost: number;
}

/**
 * Lane positions: the hole rows (or columns) shared by the most holes first, then any others not
 * too close to those, then fillers a pitch apart in the gaps. A few odd holes, like the bus
 * board's, sit between lanes: they use the nearest one, and wires to them bend onto them at the end.
 */
function lanes(values: number[], from: number, to: number): Float64Array {
  values.sort((p, q) => p - q);
  const runs: { at: number; holes: number }[] = [];
  for (let k = 0; k < values.length;) {
    let end = k;
    let sum = 0;
    while (end < values.length && values[end] - values[k] < SAME_LANE) sum += values[end++];
    runs.push({ at: sum / (end - k), holes: end - k });
    k = end;
  }
  const kept: number[] = [];
  const clear = (v: number, gap: number): boolean => kept.every((m) => Math.abs(m - v) >= gap);
  for (const run of runs.sort((p, q) => q.holes - p.holes)) if (clear(run.at, LANE_GAP)) kept.push(run.at);
  for (let v = from; v <= to; v += PITCH) if (clear(v, PITCH - 0.15)) kept.push(v);
  return Float64Array.from(kept.sort((p, q) => p - q));
}

/** The lanes within `gap` of each lane, itself included. */
function neighbours(line: Float64Array, gap: number): number[][] {
  return Array.from(line, (v, i) => {
    const near: number[] = [];
    for (let k = i; k >= 0 && v - line[k] < gap; k--) near.push(k);
    for (let k = i + 1; k < line.length && line[k] - v < gap; k++) near.push(k);
    return near;
  });
}

/** Index of the lane nearest `v`. */
function laneOf(line: Float64Array, v: number): number {
  let lo = 0;
  let hi = line.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (line[mid] < v) lo = mid + 1;
    else hi = mid;
  }
  return lo > 0 && v - line[lo - 1] < line[lo] - v ? lo - 1 : lo;
}

class Heap {
  private keys: number[] = [];
  private items: number[] = [];
  get size(): number {
    return this.items.length;
  }
  push(item: number, key: number): void {
    const { keys, items } = this;
    let i = items.length;
    keys.push(key);
    items.push(item);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (keys[p] <= key) break;
      keys[i] = keys[p];
      items[i] = items[p];
      i = p;
    }
    keys[i] = key;
    items[i] = item;
  }
  pop(): number {
    const { keys, items } = this;
    const top = items[0];
    const key = keys.pop()!;
    const item = items.pop()!;
    const n = items.length;
    if (n) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && keys[c + 1] < keys[c]) c++;
        if (keys[c] >= key) break;
        keys[i] = keys[c];
        items[i] = items[c];
        i = c;
      }
      keys[i] = key;
      items[i] = item;
    }
    return top;
  }
}

// Directions: 0 +x, 1 −x, 2 +z, 3 −z. Bits in `use`: a wire runs along x, along z, or stops or turns here.
const ALONG_X = 1;
const ALONG_Z = 2;
const TURN = 4;

export class LaneRouter {
  private readonly xs: Float64Array;
  private readonly zs: Float64Array;
  private readonly nearX: number[][];
  private readonly nearZ: number[][];
  private readonly nx: number;
  /** The node for every hole, by hole key, and the hole's exact position. */
  private readonly where = new Map<string, number>();
  private readonly exact = new Map<string, DeskPoint>();
  /** Extra cost per mm of passing over each node: chips, switches, small parts' bodies. */
  private readonly body: Float32Array;
  /** Nodes a wire would rather not pass over: a lead stands in the hole there, or right beside it. */
  private readonly blocked: Uint8Array;
  /** How wires use each node (ALONG_X, ALONG_Z, TURN), and which wire (index + 1). */
  private readonly use: Uint8Array;
  private readonly owner: Int32Array;
  private holeTaken = new Set<number>();
  /** Spots crowded in earlier rounds of `relieve`, made dearer each round. */
  private readonly history: Float32Array;
  /** Every wire laid, in order; its index + 1 is its owner id on the grid. */
  private readonly laid: Laid[] = [];
  /** The grid before any wire was laid, to start again from. */
  private base: { blocked: Uint8Array; taken: Set<number> } | null = null;

  constructor(doc: CircuitDoc) {
    const xs: number[] = [];
    const zs: number[] = [];
    const holes: [HoleRef, number, number][] = [];
    for (const board of doc.boards) {
      for (const h of boardSpec(board.type).holes) {
        const x = board.x + h.x;
        const z = board.z + h.z;
        xs.push(x);
        zs.push(z);
        holes.push([{ board: board.id, hole: h.name }, x, z]);
      }
    }
    const margin = 10 * PITCH;
    this.xs = lanes(xs, Math.min(...xs) - margin, Math.max(...xs) + margin);
    this.zs = lanes(zs, Math.min(...zs) - margin, Math.max(...zs) + margin);
    this.nearX = neighbours(this.xs, LANE_GAP);
    this.nearZ = neighbours(this.zs, LANE_GAP);
    this.nx = this.xs.length;
    const size = this.nx * this.zs.length;
    this.body = new Float32Array(size);
    this.blocked = new Uint8Array(size);
    this.use = new Uint8Array(size);
    this.owner = new Int32Array(size);
    this.history = new Float32Array(size);
    for (const [ref, x, z] of holes) {
      const n = this.node(x, z);
      this.where.set(holeKey(ref), n);
      this.exact.set(holeKey(ref), { x, z });
    }

    for (const part of doc.parts) {
      const def = PARTS[part.def];
      const at = part.pins.map((p) => this.where.get(holeKey(p))).filter((n): n is number => n !== undefined);
      for (const n of at) this.occupyNode(n);
      if (!def || at.length < 2) continue;
      if (at.length === 2 && !dipFootprint(def)) {
        this.overSegment(at[0], at[1], OVER_LEADS);
        continue;
      }
      // A chip or switch: everything over its body, with a little room round it.
      const px = at.map((n) => this.xs[n % this.nx]);
      const pz = at.map((n) => this.zs[Math.floor(n / this.nx)]);
      this.overBox(
        Math.min(...px) - 1.2,
        Math.max(...px) + 1.2,
        Math.min(...pz) - 0.6,
        Math.max(...pz) + 0.6,
        OVER_BODY,
      );
    }
    for (const w of doc.wires)
      for (const end of [w.a, w.b]) {
        const n = this.where.get(holeKey(end));
        if (n !== undefined) this.occupyNode(n);
      }
  }

  private occupyNode(n: number): void {
    this.holeTaken.add(n);
    this.stand(n);
  }

  private node(x: number, z: number): number {
    return laneOf(this.zs, z) * this.nx + laneOf(this.xs, x);
  }

  /** A lead stands in the hole at `n`: nothing may run over it or close beside it. */
  private stand(n: number): void {
    const i = n % this.nx;
    const j = Math.floor(n / this.nx);
    for (const jj of this.nearZ[j]) for (const ii of this.nearX[i]) this.blocked[jj * this.nx + ii] = 1;
  }

  private overBox(x0: number, x1: number, z0: number, z1: number, cost: number): void {
    for (let j = 0; j < this.zs.length; j++) {
      if (this.zs[j] < z0 || this.zs[j] > z1) continue;
      for (let i = 0; i < this.nx; i++)
        if (this.xs[i] >= x0 && this.xs[i] <= x1)
          this.body[j * this.nx + i] = Math.max(this.body[j * this.nx + i], cost);
    }
  }

  private overSegment(a: number, b: number, cost: number): void {
    const ax = this.xs[a % this.nx];
    const az = this.zs[Math.floor(a / this.nx)];
    const bx = this.xs[b % this.nx];
    const bz = this.zs[Math.floor(b / this.nx)];
    const len = Math.hypot(bx - ax, bz - az) || 1;
    for (let j = 0; j < this.zs.length; j++) {
      const z = this.zs[j];
      if (z < Math.min(az, bz) - 1 || z > Math.max(az, bz) + 1) continue;
      for (let i = 0; i < this.nx; i++) {
        const x = this.xs[i];
        if (x < Math.min(ax, bx) - 1 || x > Math.max(ax, bx) + 1) continue;
        const t = Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (z - az) * (bz - az)) / (len * len)));
        if (Math.hypot(ax + (bx - ax) * t - x, az + (bz - az) * t - z) < 1)
          this.body[j * this.nx + i] = Math.max(this.body[j * this.nx + i], cost);
      }
    }
  }

  /** Whether a lead already stands in this hole. */
  taken(ref: HoleRef): boolean {
    const n = this.where.get(holeKey(ref));
    return n === undefined || this.holeTaken.has(n);
  }

  /** Marks holes the caller has filled itself (parts placed after the router was made). */
  occupy(ref: HoleRef): void {
    const n = this.where.get(holeKey(ref));
    if (n !== undefined) this.occupyNode(n);
  }

  /** The other wire running alongside `n`, close enough to touch (on a neighbouring lane, the same way), or 0. */
  private crowdedBy(n: number): number {
    const i = n % this.nx;
    const j = (n - i) / this.nx;
    for (const ii of this.nearX[i]) {
      const m = j * this.nx + ii;
      if (ii !== i && this.owner[m] && this.use[m] & (ALONG_Z | TURN)) return this.owner[m];
    }
    for (const jj of this.nearZ[j]) {
      const m = jj * this.nx + i;
      if (jj !== j && this.owner[m] && this.use[m] & (ALONG_X | TURN)) return this.owner[m];
    }
    return 0;
  }

  /** The wire a wire going way `e` through `m` would lie on (or right beside), or 0 if it has the spot to itself. */
  private lyingOn(m: number, e: number): number {
    if (this.use[m] & ((e < 2 ? ALONG_X : ALONG_Z) | TURN)) return this.owner[m] || -1;
    return this.crowdedBy(m);
  }

  // Search state, kept between wires: cost and way in for each (node, direction), valid for one search.
  private cost = new Float64Array(0);
  private came = new Int32Array(0);
  private seen = new Int32Array(0);
  private search = 0;

  /**
   * Lays one wire from any free hole of `from` to any free hole of `to`, and claims its lanes.
   * Returns null when no free hole is left at one end.
   */
  lay(from: readonly HoleRef[], to: readonly HoleRef[]): LaidWire | null {
    this.base ??= { blocked: this.blocked.slice(), taken: new Set(this.holeTaken) };
    const wire: Laid = { from, to, length: 0, path: [], dirs: [], ends: [], squeezed: [], under: new Set(), cost: 0 };
    if (!this.find(wire)) return null;
    this.laid.push(wire);
    this.claim(wire, this.laid.length);
    return this.result(wire);
  }

  /**
   * Untangles the wires laid so far, a round at a time: every wire lying along another is taken
   * up together with the wires it lies on, the spots where they met are made dearer, and they're
   * laid again, longest first. Stops when no wire lies along another, or after `rounds`, keeping
   * whichever round left the fewest such spots.
   */
  relieve(rounds = 8): void {
    let best = this.snapshot();
    for (let r = 0; r < rounds && best.squeezes; r++) {
      const redo = new Set<number>();
      this.laid.forEach((w, k) => {
        if (!w.squeezed.length) return;
        redo.add(k);
        for (const n of w.squeezed) this.history[n] += HISTORY;
        for (const id of w.under) if (id > 0) redo.add(id - 1);
      });
      this.rebuild((k) => !redo.has(k));
      for (const k of [...redo].sort((a, b) => this.laid[b].length - this.laid[a].length)) {
        if (!this.find(this.laid[k])) throw new Error('A wire lost its free holes while being laid again');
        this.claim(this.laid[k], k + 1);
      }
      const now = this.snapshot();
      if (now.squeezes < best.squeezes) best = now;
    }
    // Put back the best round.
    best.wires.forEach((w, k) => Object.assign(this.laid[k], w));
    this.rebuild(() => true);
  }

  /** The wires as laid now, in the order they were asked for. */
  get wires(): LaidWire[] {
    return this.laid.map((w) => this.result(w));
  }

  /** Where a wire has to lie along (or turn on) another, for want of a free lane. */
  get squeezes(): DeskPoint[] {
    return this.laid.flatMap((w) =>
      w.squeezed.map((n) => ({ x: this.xs[n % this.nx], z: this.zs[Math.floor(n / this.nx)] })),
    );
  }

  private snapshot(): {
    squeezes: number;
    wires: Pick<Laid, 'path' | 'dirs' | 'ends' | 'squeezed' | 'under' | 'cost'>[];
  } {
    return {
      squeezes: this.laid.reduce((n, w) => n + w.squeezed.length, 0),
      wires: this.laid.map(({ path, dirs, ends, squeezed, under, cost }) => ({
        path,
        dirs,
        ends,
        squeezed,
        under,
        cost,
      })),
    };
  }

  /** Clears the grid back to the parts alone, then claims again the wires `keep` says to. */
  private rebuild(keep: (k: number) => boolean): void {
    this.blocked.set(this.base!.blocked);
    this.holeTaken = new Set(this.base!.taken);
    this.use.fill(0);
    this.owner.fill(0);
    this.laid.forEach((w, k) => {
      if (keep(k)) this.claim(w, k + 1);
    });
  }

  /** Finds the cheapest way for `wire` across the grid as it stands, and records it on the wire. */
  private find(wire: Laid): boolean {
    const holeAt = new Map<number, HoleRef>();
    const free = (refs: readonly HoleRef[]): number[] =>
      refs.flatMap((r) => {
        const n = this.where.get(holeKey(r));
        if (n === undefined || this.holeTaken.has(n) || holeAt.has(n)) return [];
        holeAt.set(n, r);
        return [n];
      });
    const starts = new Set(free(wire.from));
    const ends = new Set(free(wire.to));
    if (!starts.size || !ends.size) return false;
    const { nx, xs, zs, history } = this;
    const nz = zs.length;
    let gx0 = Infinity,
      gx1 = -Infinity,
      gz0 = Infinity,
      gz1 = -Infinity;
    for (const n of ends) {
      const x = xs[n % nx];
      const z = zs[Math.floor(n / nx)];
      gx0 = Math.min(gx0, x);
      gx1 = Math.max(gx1, x);
      gz0 = Math.min(gz0, z);
      gz1 = Math.max(gz1, z);
    }
    const h = (n: number): number => {
      const x = xs[n % nx];
      const z = zs[Math.floor(n / nx)];
      return Math.max(0, gx0 - x, x - gx1) + Math.max(0, gz0 - z, z - gz1);
    };

    const states = nx * nz * 4;
    if (this.cost.length !== states) {
      this.cost = new Float64Array(states);
      this.came = new Int32Array(states);
      this.seen = new Int32Array(states);
    }
    const { cost, came, seen } = this;
    const search = ++this.search;
    const visit = (state: number, g: number, from: number): boolean => {
      if (seen[state] === search && cost[state] <= g) return false;
      seen[state] = search;
      cost[state] = g;
      came[state] = from;
      return true;
    };
    const heap = new Heap();
    for (const s of starts) for (let d = 0; d < 4; d++) if (visit(s * 4 + d, 0, -1)) heap.push(s * 4 + d, h(s) * GREED);
    let goal = -1;
    while (heap.size) {
      const state = heap.pop();
      const n = state >> 2;
      const d = state & 3;
      const g = cost[state];
      if (ends.has(n)) {
        goal = state;
        break;
      }
      const i = n % nx;
      const j = (n - i) / nx;
      const start = starts.has(n);
      for (let e = 0; e < 4; e++) {
        if ((d ^ e) === 1 && !start) continue; // no doubling straight back
        const ii = e === 0 ? i + 1 : e === 1 ? i - 1 : i;
        const jj = e === 2 ? j + 1 : e === 3 ? j - 1 : j;
        if (ii < 0 || ii >= nx || jj < 0 || jj >= nz) continue;
        const m = jj * nx + ii;
        const len = e < 2 ? Math.abs(xs[ii] - xs[i]) : Math.abs(zs[jj] - zs[j]);
        let step = len * (1 + (this.body[n] + this.body[m]) / 2) + history[m];
        if (this.blocked[m] && !ends.has(m)) step += OVER_LEAD;
        // Running along another wire, through its bend, or right beside it means lying on it.
        if (this.lyingOn(m, e)) step += SQUEEZE;
        else if (this.use[m]) step += CROSS;
        if (e !== d && !start) step += this.use[n] ? SQUEEZE : BEND; // never turn on top of another wire
        if (visit(m * 4 + e, g + step, state)) heap.push(m * 4 + e, g + step + h(m) * GREED);
      }
    }
    if (goal < 0) return false;

    // Walk back. dirs[k] is the way the wire came into path[k]; it turns where that changes.
    const path: number[] = [];
    const dirs: number[] = [];
    for (let s = goal; s >= 0; s = came[s]) {
      path.push(s >> 2);
      dirs.push(s & 3);
    }
    path.reverse();
    dirs.reverse();
    wire.path = path;
    wire.dirs = dirs;
    wire.ends = [holeAt.get(path[0])!, holeAt.get(path[path.length - 1])!];
    wire.cost = cost[goal];
    wire.length ||= h(path[0]);
    wire.squeezed = [];
    wire.under = new Set();
    for (let k = 1; k < path.length; k++) {
      const other = this.lyingOn(path[k], dirs[k]);
      if (other) {
        wire.squeezed.push(path[k]);
        wire.under.add(other);
      }
    }
    return true;
  }

  /** Marks `wire`'s lanes and end holes as its own. */
  private claim(wire: Laid, id: number): void {
    const { path, dirs } = wire;
    // Its ends are holes with its leads in: other wires may hop those (see stand), not lie on them.
    for (let k = 1; k < path.length - 1; k++) {
      const n = path[k];
      this.use[n] |= dirs[k + 1] !== dirs[k] ? TURN : dirs[k] < 2 ? ALONG_X : ALONG_Z;
      this.owner[n] = id;
    }
    for (const n of [path[0], path[path.length - 1]]) {
      this.holeTaken.add(n);
      this.stand(n);
    }
  }

  private result(wire: Laid): LaidWire {
    const { path, dirs } = wire;
    const points: DeskPoint[] = [];
    for (let k = 1; k < path.length - 1; k++) {
      if (dirs[k + 1] !== dirs[k])
        points.push({ x: round(this.xs[path[k] % this.nx]), z: round(this.zs[Math.floor(path[k] / this.nx)]) });
    }
    const [a, b] = wire.ends;
    // A hole off its lane: square the first and last runs up to it by moving the bend next to it.
    if (points.length) {
      const fix = (hole: HoleRef, bend: DeskPoint, along: number): void => {
        const p = this.exact.get(holeKey(hole))!;
        if (along < 2) bend.z = round(p.z);
        else bend.x = round(p.x);
      };
      fix(a, points[0], dirs[1]);
      fix(b, points[points.length - 1], dirs[dirs.length - 1]);
    }
    return { a, b, points, cost: wire.cost };
  }
}

/** A wire as the router keeps it: what it was asked to join, and how it runs now. */
interface Laid {
  from: readonly HoleRef[];
  to: readonly HoleRef[];
  /** How far apart its ends were first found, to lay the longest first. */
  length: number;
  path: number[];
  dirs: number[];
  ends: HoleRef[];
  /** Where it lies along another wire, and which wires (ids) those are. */
  squeezed: number[];
  under: Set<number>;
  cost: number;
}

const round = (v: number): number => Math.round(v * 100) / 100;
