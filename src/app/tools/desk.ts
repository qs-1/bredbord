// Where a desk object (a board, a bench supply, a meter, a scope) lands when it's dragged about:
// lined up with what's near it and pushed clear of what it would overlap, the way drawing apps do it.

import { boardSpec, type BoardType } from '../../engine/breadboard';
import type { CircuitDoc, Id } from '../../engine/circuit';
import { METER_SIZE } from '../../engine/meter';
import { clippedTo } from '../../engine/rails';
import { SCOPE_SIZE } from '../../engine/scope';
import { SUPPLY_SIZE, SUPPLY_TERMINALS } from '../../engine/supply';

/** How close (mm) an edge or middle has to come to another's to snap level with it. */
const DESK_SNAP = 8;
/** How far apart (mm, edge to edge) two objects can be for one to snap in line with the other. */
const NEAR = 40;

export interface DeskThing {
  x: number;
  z: number;
  size: { x: number; z: number };
  /** Clear space to keep from it (0 lets the dragged object touch it). */
  gap: number;
}

/**
 * Where an object of `own` size dragged to (x, z) lands among `others`. Each axis snaps on its own
 * (flush against a neighbour's side, or edges or middles level with it); then, if it overlaps
 * something, it's pushed out the shortest way, so it slides along that thing's edge and keeps
 * following the pointer. Not valid only if it can't be got clear.
 */
export function deskSpot(
  own: { x: number; z: number },
  others: readonly DeskThing[],
  x: number,
  z: number,
  snapping = true,
): { x: number; z: number; valid: boolean } {
  // Line up, one axis at a time, with things close by on the other axis.
  const snap = (v: number, other: number, axis: 'x' | 'z'): number => {
    if (!snapping) return v;
    const cross = axis === 'x' ? 'z' : 'x';
    let best = v;
    let bestD = DESK_SNAP;
    for (const o of others) {
      if (Math.abs(other - o[cross]) > (own[cross] + o.size[cross]) / 2 + NEAR) continue;
      const half = own[axis] / 2;
      const oh = o.size[axis] / 2;
      const c = o[axis];
      for (const t of [c, c - oh + half, c + oh - half, c - oh - o.gap - half, c + oh + o.gap + half]) {
        if (Math.abs(v - t) < bestD) {
          bestD = Math.abs(v - t);
          best = t;
        }
      }
    }
    return best;
  };
  let px = snap(x, z, 'x');
  let pz = snap(z, px, 'z');

  // Out of anything it overlaps, the shortest way; a few times over, for a gap between two things.
  for (let k = 0; k < 8; k++) {
    let pushed = false;
    for (const o of others) {
      const ox = (own.x + o.size.x) / 2 + o.gap - Math.abs(px - o.x);
      const oz = (own.z + o.size.z) / 2 + o.gap - Math.abs(pz - o.z);
      if (ox <= 0.01 || oz <= 0.01) continue;
      if (ox < oz) px += (px >= o.x ? 1 : -1) * ox;
      else pz += (pz >= o.z ? 1 : -1) * oz;
      pushed = true;
    }
    if (!pushed) return { x: px, z: pz, valid: true };
  }

  // Wedged in a space too small: the nearest spot flush against something that is clear.
  const clear = (cx: number, cz: number): boolean =>
    others.every(
      (o) =>
        (own.x + o.size.x) / 2 + o.gap - Math.abs(cx - o.x) <= 0.01 ||
        (own.z + o.size.z) / 2 + o.gap - Math.abs(cz - o.z) <= 0.01,
    );
  let best: { x: number; z: number; d: number } | null = null;
  for (const o of others) {
    const dx = (own.x + o.size.x) / 2 + o.gap;
    const dz = (own.z + o.size.z) / 2 + o.gap;
    for (const [cx, cz] of [
      [o.x - dx, z],
      [o.x + dx, z],
      [x, o.z - dz],
      [x, o.z + dz],
    ]) {
      const d = Math.hypot(cx - x, cz - z);
      if ((!best || d < best.d) && clear(cx, cz)) best = { x: cx, z: cz, d };
    }
  }
  return best ? { x: best.x, z: best.z, valid: true } : { x: px, z: pz, valid: false };
}

/** Things that sit on the desk by themselves, rather than in a board's holes. */
export type DeskKind = 'board' | 'supply' | 'meter' | 'scope';

/** Clear gap between desk objects, so cases never visually intersect. */
export const DESK_GAP = 5;

/** A desk object's outline, mm. */
export function footprint(kind: DeskKind, type: BoardType = 'bb830'): { x: number; z: number } {
  if (kind === 'board') {
    const spec = boardSpec(type);
    return { x: spec.length, z: spec.width };
  }
  // Include front binding posts, not only the plastic case, so instruments cannot clip through
  // one another while being placed or dragged.
  if (kind === 'supply') return { x: SUPPLY_SIZE.x, z: SUPPLY_SIZE.z + 16 };
  if (kind === 'meter') return { x: METER_SIZE.x, z: METER_SIZE.z };
  return { x: SCOPE_SIZE.x, z: SCOPE_SIZE.z + 16 };
}

export interface ClearSpotOptions {
  /** The object being moved, which doesn't get in its own way. */
  self?: Id;
  type?: BoardType;
  snapping: boolean;
  /** Others that don't get in the way either (rails moving with their board). */
  ignore?: ReadonlySet<Id>;
  /** An outline other than the object's own (a board with its rails). */
  size?: { x: number; z: number };
}

export type DeskSpot = { x: number; z: number; valid: boolean };

const round1 = (v: number): number => Math.round(v * 10) / 10;

/**
 * Where a desk object dragged to (x, z) lands among everything else on the desk (see deskSpot).
 * Boards may touch each other; everything else keeps a small gap.
 */
export function clearDeskSpot(doc: CircuitDoc, kind: DeskKind, x: number, z: number, opts: ClearSpotOptions): DeskSpot {
  const own = opts.size ?? footprint(kind, opts.type);
  const others: DeskThing[] = [
    ...doc.boards
      .filter((b) => b.id !== opts.self && !opts.ignore?.has(b.id))
      .map((b) => ({ kind: 'board' as const, x: b.x, z: b.z, type: b.type })),
    ...(doc.supplies ?? []).map((s) => ({ kind: 'supply' as const, id: s.id, x: s.x, z: s.z })),
    ...(doc.meters ?? []).map((m) => ({ kind: 'meter' as const, id: m.id, x: m.x, z: m.z })),
    ...(doc.scopes ?? []).map((s) => ({ kind: 'scope' as const, id: s.id, x: s.x, z: s.z })),
  ]
    .filter((o) => !('id' in o) || o.id !== opts.self)
    .map((o) => ({
      x: o.x,
      z: o.z,
      size: footprint(o.kind, 'type' in o ? o.type : undefined),
      gap: kind === 'board' && o.kind === 'board' ? 0 : DESK_GAP,
    }));
  const at = deskSpot(own, others, x, z, opts.snapping);
  return { x: round1(at.x), z: round1(at.z), valid: at.valid };
}

/** The box round a board and the rails clipped to it, its middle measured from the board's. */
export interface RailSpan {
  cx: number;
  cz: number;
  x: number;
  z: number;
}

/** The box round a board and the rails clipped to it; none if it has none. */
export function railSpan(doc: CircuitDoc, id: Id): RailSpan | undefined {
  const b = doc.boards.find((x) => x.id === id);
  const rails = clippedTo(doc, id);
  if (!b || !rails.length) return undefined;
  let [x0, x1, z0, z1] = [Infinity, -Infinity, Infinity, -Infinity];
  for (const o of [b, ...rails]) {
    const s = boardSpec(o.type);
    x0 = Math.min(x0, o.x - s.length / 2);
    x1 = Math.max(x1, o.x + s.length / 2);
    z0 = Math.min(z0, o.z - s.width / 2);
    z1 = Math.max(z1, o.z + s.width / 2);
  }
  return { cx: (x0 + x1) / 2 - b.x, cz: (z0 + z1) / 2 - b.z, x: x1 - x0, z: z1 - z0 };
}

/** Where a board (with its rails, if any are clipped to it) lands with its middle dragged to (x, z). */
export function boardSpot(
  doc: CircuitDoc,
  id: Id,
  type: BoardType,
  x: number,
  z: number,
  span: RailSpan | undefined,
  snapping: boolean,
): DeskSpot {
  if (!span) return clearDeskSpot(doc, 'board', x, z, { self: id, type, snapping });
  // It and its rails land as one: clear of everything else, snapped by their outline.
  const ignore = new Set([id, ...clippedTo(doc, id).map((b) => b.id)]);
  const at = clearDeskSpot(doc, 'board', x + span.cx, z + span.cz, {
    self: id,
    type,
    snapping,
    ignore,
    size: { x: span.x, z: span.z },
  });
  return { x: round1(at.x - span.cx), z: round1(at.z - span.cz), valid: at.valid };
}

/**
 * Where a bench supply put down by its leads goes: on the desk just off the side of the board nearest
 * the red lead's hole (left, right or behind; never in front, where it would hide the board), its
 * posts level with that hole, slid clear of anything already there.
 */
export function supplySpotBeside(
  doc: CircuitDoc,
  boardId: Id,
  hole: { x: number; z: number },
  snapping: boolean,
): DeskSpot | null {
  const board = doc.boards.find((b) => b.id === boardId);
  if (!board) return null;
  const spec = boardSpec(board.type);
  const post = SUPPLY_TERMINALS['+'];
  const own = footprint('supply');
  const left = board.x - spec.length / 2;
  const right = board.x + spec.length / 2;
  const back = board.z - spec.width / 2;
  const toLeft = hole.x - left;
  const toRight = right - hole.x;
  const toBack = hole.z - back;
  const nearest = Math.min(toLeft, toRight, toBack);
  let x: number;
  let z: number;
  if (nearest === toBack) {
    x = hole.x - post.x;
    z = back - DESK_GAP - own.z / 2;
  } else {
    x = nearest === toLeft ? left - DESK_GAP - own.x / 2 : right + DESK_GAP + own.x / 2;
    z = hole.z - post.z;
  }
  return clearDeskSpot(doc, 'supply', x, z, { snapping });
}
