// Power rails that come off a breadboard and clip back on, like real boards with dovetails. A railed
// board (BB830, split BB830, BB400) is three pieces that sit exactly where its own parts are: pulled
// apart, it's the body alone ('core-…') with its two rails ('strip-…-top' / '-bottom') clipped along
// its sides, every hole where it was and named as it was. A rail pushed flush against a board's edge
// is clipped to it and moves with it; with both of a board's own rails back in place, it's whole again.

import {
  boardSpec,
  detachableType,
  isRailStrip,
  pieceOf,
  pieceOffset,
  pieceType,
  SEAM_Z,
  type BoardType,
  type Railed,
} from './breadboard';
import { allocId, type BoardDoc, type CircuitDoc, type HoleRef, type Id } from './circuit';
import { PARTS } from './parts';

/** Across a railed board, past this (board-local z) a press is on a power rail rather than the body. */
export { SEAM_Z as RAIL_SEAM_Z };

/** Boards whose rails can be pulled off. */
export const detachable = (type: BoardType): boolean => detachableType(type);

/** Rail strips clipped to a board. */
export const clippedTo = (doc: CircuitDoc, id: Id): BoardDoc[] => doc.boards.filter((b) => b.on === id);

/** The board a click on this one stands for: a rail clipped to a board is part of that board. */
export function unitOf(doc: CircuitDoc, id: Id): Id {
  const b = doc.boards.find((x) => x.id === id);
  return b?.on && doc.boards.some((x) => x.id === b.on) ? b.on : id;
}

/** Why a board's rails can't be pulled off, if they can't. */
export function whyRailsStay(doc: CircuitDoc, id: Id): string | undefined {
  const board = doc.boards.find((b) => b.id === id);
  if (!board || !detachable(board.type)) return 'This board’s rails don’t come off';
  // A power module has pins in the top rails and the bottom rails at the board's end.
  if (doc.parts.some((p) => PARTS[p.def]?.kind === 'power' && p.pins.some((r) => r.board === id))) {
    return 'The power module plugs into both rails: take it off first';
  }
  return undefined;
}

/**
 * Pulls a railed board apart: its body and its two rails become three boards, the rails clipped to the
 * body, all exactly where they were. What was in the rails moves to the rail boards' holes of the same
 * names. Call inside a store update. Returns the two rails' ids, or why it can't be done.
 */
export function detachRails(doc: CircuitDoc, id: Id): { top: Id; bottom: Id } | { reason: string } {
  const reason = whyRailsStay(doc, id);
  if (reason) return { reason };
  const board = doc.boards.find((b) => b.id === id)!;
  const parent = board.type as Railed;
  const top = allocId(doc, 'b');
  const bottom = allocId(doc, 'b');
  board.type = pieceType(parent, 'core');
  doc.boards.push(
    { id: top, type: pieceType(parent, 'top'), x: board.x, z: round2(board.z + pieceOffset(parent, 'top')), on: id },
    {
      id: bottom,
      type: pieceType(parent, 'bottom'),
      x: board.x,
      z: round2(board.z + pieceOffset(parent, 'bottom')),
      on: id,
    },
  );
  retarget(doc, (r) =>
    r.board !== id
      ? null
      : r.hole[0] === 'T' && /^T[+-]\d+$/.test(r.hole)
        ? top
        : r.hole[0] === 'B' && /^B[+-]\d+$/.test(r.hole)
          ? bottom
          : null,
  );
  return { top, bottom };
}

/**
 * Puts a board back together if both its own rails are clipped to it exactly where they came from:
 * the three pieces become one board again, everything in their holes staying put. Returns whether it did.
 */
export function rejoinRails(doc: CircuitDoc, id: Id): boolean {
  const core = doc.boards.find((b) => b.id === id);
  const piece = core && pieceOf(core.type);
  if (!core || piece?.piece !== 'core') return false;
  const at = (name: 'top' | 'bottom'): BoardDoc | undefined =>
    doc.boards.find(
      (b) =>
        b.on === id &&
        b.type === pieceType(piece.parent, name) &&
        Math.abs(b.x - core.x) < 0.05 &&
        Math.abs(b.z - (core.z + pieceOffset(piece.parent, name))) < 0.05,
    );
  const top = at('top');
  const bottom = at('bottom');
  if (!top || !bottom) return false;
  const gone = new Set([top.id, bottom.id]);
  doc.boards = doc.boards.filter((b) => !gone.has(b.id));
  core.type = piece.parent;
  retarget(doc, (r) => (gone.has(r.board) ? id : null));
  // Anything clipped to the rails is clipped to the whole board now.
  for (const b of doc.boards) if (b.on && gone.has(b.on)) b.on = id;
  return true;
}

/** Moves hole references to another board (same hole names) where `to` says so. */
function retarget(doc: CircuitDoc, to: (r: HoleRef) => Id | null): void {
  const move = (r: HoleRef): HoleRef => {
    const board = to(r);
    return board ? { board, hole: r.hole } : r;
  };
  for (const p of doc.parts) p.pins = p.pins.map(move);
  for (const w of doc.wires) {
    w.a = move(w.a);
    w.b = move(w.b);
  }
  for (const p of doc.probes ?? []) p.at = move(p.at);
}

/**
 * The board a rail strip sits flush against, along most of the board's edge it lies beside: a long
 * edge for a strip running across the desk, a short end for one running up and down it.
 */
export function clipTarget(boards: readonly BoardDoc[], strip: BoardDoc): Id | undefined {
  if (!isRailStrip(strip.type)) return undefined;
  const ss = boardSpec(strip.type);
  for (const b of boards) {
    if (b.id === strip.id || isRailStrip(b.type) || b.type === 'data-bus' || b.type === 'power-rail') continue;
    const bs = boardSpec(b.type);
    // Across: the two touch; along: they overlap by at least half the shorter one.
    const [across, along] = ss.vertical ? (['x', 'z'] as const) : (['z', 'x'] as const);
    const size = (spec: typeof bs, axis: 'x' | 'z'): number => (axis === 'x' ? spec.length : spec.width);
    const flush = Math.abs(Math.abs(strip[across] - b[across]) - (size(ss, across) + size(bs, across)) / 2) < 0.3;
    const overlap =
      Math.min(strip[along] + size(ss, along) / 2, b[along] + size(bs, along) / 2) -
      Math.max(strip[along] - size(ss, along) / 2, b[along] - size(bs, along) / 2);
    if (flush && overlap >= Math.min(size(ss, along), size(bs, along)) / 2) return b.id;
  }
  return undefined;
}

const round2 = (v: number): number => Math.round(v * 100) / 100;
