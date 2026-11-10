// Changes the tools make to the circuit document, as plain functions of the document: adding,
// moving and deleting things, resizing rails, and the bench instruments' settings. The Tools class
// decides when; these decide what. Each is meant to run inside Store.update().

import {
  boardSpec,
  isRailStrip,
  pieceOf,
  pieceOffset,
  pieceType,
  railStrip,
  railType,
  type BoardType,
} from '../../engine/breadboard';
import { allocId, type CircuitDoc, type HoleRef, type Id, type ScopeDoc, type SupplyDoc } from '../../engine/circuit';
import { clippedTo, clipTarget, rejoinRails } from '../../engine/rails';
import { DEFAULT_TRIGGER, type ScopeTrigger } from '../../engine/scope';
import { SUPPLY_MAX_AMPS, SUPPLY_MAX_VOLTS, SUPPLY_MIN_AMPS } from '../../engine/supply';
import type { ItemRef } from '../scene-sync';
import type { DeskKind } from './desk';

const round1 = (v: number): number => Math.round(v * 10) / 10;
const round2 = (v: number): number => Math.round(v * 100) / 100;

/** Puts a new board or bench instrument on the desk with its middle at `at`. Returns the instrument, to select. */
export function addDeskItem(
  doc: CircuitDoc,
  kind: DeskKind,
  at: { x: number; z: number },
  type: BoardType = 'bb830',
): ItemRef | null {
  if (kind === 'board') {
    doc.boards.push({ id: allocId(doc, 'b'), type, x: at.x, z: at.z });
    return null;
  }
  if (kind === 'supply') {
    const id = allocId(doc, 's');
    (doc.supplies ??= []).push({ id, x: at.x, z: at.z, volts: 5, limit: 1 });
    return { kind, id };
  }
  if (kind === 'meter') {
    const id = allocId(doc, 'm');
    (doc.meters ??= []).push({ id, x: at.x, z: at.z, mode: 'dcv' });
    return { kind, id };
  }
  const id = allocId(doc, 'o');
  (doc.scopes ??= []).push({ id, x: at.x, z: at.z, timebase: 0.1, voltsPerDiv: 2 });
  return { kind, id };
}

/** A bench supply put down at `at` with its red lead into `red` and its black lead into `black`. Returns its id. */
export function addSupplyWithLeads(doc: CircuitDoc, at: { x: number; z: number }, red: HoleRef, black: HoleRef): Id {
  const id = allocId(doc, 's');
  (doc.supplies ??= []).push({ id, x: at.x, z: at.z, volts: 5, limit: 1 });
  doc.wires.push({ id: allocId(doc, 'w'), a: { board: id, hole: '+' }, b: red, color: 'red' });
  doc.wires.push({ id: allocId(doc, 'w'), a: { board: id, hole: '-' }, b: black, color: 'black' });
  return id;
}

/**
 * Moves a board's middle to `at`, with everything on it: rails clipped to it keep their places
 * against it, and wires running only between its pieces keep their bends. A rail clips to the board
 * it's pushed flush against and comes off one it's pulled away from; put back on the board it came
 * from, it goes exactly into its old place, and the board is whole again once both rails are.
 * Returns the board to select afterwards (the board a rail ended up on).
 */
export function moveBoard(doc: CircuitDoc, id: Id, at: { x: number; z: number }): Id {
  const b = doc.boards.find((x) => x.id === id);
  if (!b) return id;
  const dx = at.x - b.x;
  const dz = at.z - b.z;
  const moved = [b, ...clippedTo(doc, b.id)];
  b.x = at.x;
  b.z = at.z;
  for (const m of moved.slice(1)) {
    m.x = round2(m.x + dx);
    m.z = round2(m.z + dz);
  }
  const ids = new Set(moved.map((m) => m.id));
  for (const w of doc.wires) {
    if (w.points && ids.has(w.a.board) && ids.has(w.b.board))
      w.points = w.points.map((p) => ({ x: round1(p.x + dx), z: round1(p.z + dz) }));
  }
  if (!isRailStrip(b.type)) return id;
  const on = clipTarget(doc.boards, b);
  if (on) b.on = on;
  else delete b.on;
  const target = on ? doc.boards.find((x) => x.id === on) : undefined;
  const mine = pieceOf(b.type);
  if (
    target &&
    mine &&
    mine.piece !== 'core' &&
    target.type === `core-${mine.parent}` &&
    Math.abs(b.x - target.x) < 3
  ) {
    b.x = target.x;
    b.z = round2(target.z + pieceOffset(mine.parent, mine.piece));
    rejoinRails(doc, target.id);
  }
  return on ?? b.id;
}

/** Whether moving a board to `at` would change anything at all. */
export function boardWouldMove(doc: CircuitDoc, id: Id, at: { x: number; z: number }): boolean {
  const b = doc.boards.find((x) => x.id === id);
  if (!b) return false;
  return b.x !== at.x || b.z !== at.z || (isRailStrip(b.type) && clipTarget(doc.boards, b) !== b.on);
}

/** Removes one selected thing, and what goes with it: a board's parts, wires and rails; an instrument's leads. */
export function deleteItem(doc: CircuitDoc, sel: ItemRef): void {
  const offBench = (id: Id): void => {
    doc.wires = doc.wires.filter((w) => w.a.board !== id && w.b.board !== id);
    doc.probes = (doc.probes ?? []).filter((p) => p.at.board !== id);
  };
  switch (sel.kind) {
    case 'wire':
      doc.wires = doc.wires.filter((w) => w.id !== sel.id);
      return;
    case 'part':
      doc.parts = doc.parts.filter((p) => p.id !== sel.id);
      return;
    case 'supply':
      doc.supplies = (doc.supplies ?? []).filter((s) => s.id !== sel.id);
      return offBench(sel.id);
    case 'meter':
      doc.meters = (doc.meters ?? []).filter((m) => m.id !== sel.id);
      return offBench(sel.id);
    case 'scope':
      doc.scopes = (doc.scopes ?? []).filter((s) => s.id !== sel.id);
      return offBench(sel.id);
    case 'board': {
      const gone = new Set([sel.id, ...clippedTo(doc, sel.id).map((b) => b.id)]);
      doc.boards = doc.boards.filter((b) => !gone.has(b.id));
      doc.parts = doc.parts.filter((p) => p.pins.every((r) => !gone.has(r.board)));
      doc.wires = doc.wires.filter((w) => !gone.has(w.a.board) && !gone.has(w.b.board));
      doc.probes = (doc.probes ?? []).filter((p) => !gone.has(p.at.board));
    }
  }
}

/** Whether any part leg or wire end on board `id` would have no hole on a board of `type`. */
function holesInUse(doc: CircuitDoc, id: Id, type: BoardType): boolean {
  const spec = boardSpec(type);
  const refs = [...doc.parts.flatMap((p) => p.pins), ...doc.wires.flatMap((w) => [w.a, w.b])];
  return refs.some((r) => r.board === id && !spec.hole(r.hole));
}

/** A rail resized: its new type and middle, or why it can't be. Null if nothing would change. */
export type RailResize = { type: BoardType; x: number; z: number } | { error: string } | null;

/** A rail on its own cut to `holes` holes a row, or lengthened, with hole 1 staying where it is. */
export function railHolesResize(doc: CircuitDoc, id: Id, holes: number): RailResize {
  const b = doc.boards.find((x) => x.id === id);
  const strip = b && railStrip(b.type);
  if (!b || !strip || holes === strip.holes) return null;
  const type = railType(strip.vertical, holes);
  if (!railStrip(type)) return null;
  if (holesInUse(doc, id, type)) return { error: 'Those holes are in use' };
  const now = boardSpec(b.type);
  const next = boardSpec(type);
  const shift = ((next.vertical ? next.width : next.length) - (strip.vertical ? now.width : now.length)) / 2;
  return {
    type,
    x: round1(b.x + (strip.vertical ? 0 : shift)),
    z: round1(b.z + (strip.vertical ? shift : 0)),
  };
}

/** A rail on its own made a BB830's or a BB400's, with hole 1 staying where it is. */
export function railSizeResize(doc: CircuitDoc, id: Id, parent: 'bb830' | 'bb400'): RailResize {
  const b = doc.boards.find((x) => x.id === id);
  const piece = b && pieceOf(b.type);
  if (!b || !piece || piece.piece === 'core' || piece.parent === parent) return null;
  const type = pieceType(parent, piece.piece);
  if (holesInUse(doc, id, type)) return { error: 'Those holes are in use' };
  const first = `${piece.piece === 'top' ? 'T' : 'B'}+1`;
  const was = boardSpec(b.type).hole(first)!;
  const now = boardSpec(type).hole(first)!;
  return { type, x: round2(b.x + was.x - now.x), z: round2(b.z + was.z - now.z) };
}

/** Applies a rail resize; a rail that changes size comes off its board, then clips to whatever it's flush against. */
export function applyRailResize(
  doc: CircuitDoc,
  id: Id,
  to: { type: BoardType; x: number; z: number },
  reclip: boolean,
): void {
  const d = doc.boards.find((o) => o.id === id);
  if (!d) return;
  Object.assign(d, to);
  if (!reclip) return;
  delete d.on;
  const on = clipTarget(doc.boards, d);
  if (on) d.on = on;
}

/** A bench supply's voltage and current limit, kept to what it can do and rounded to its knobs' steps. */
export function setSupplySettings(s: SupplyDoc, change: Partial<Pick<SupplyDoc, 'volts' | 'limit' | 'off'>>): void {
  if (change.off !== undefined) {
    if (change.off) s.off = true;
    else delete s.off;
  }
  if (change.volts !== undefined)
    s.volts = Math.round(Math.max(0, Math.min(SUPPLY_MAX_VOLTS, change.volts)) * 100) / 100;
  if (change.limit !== undefined)
    s.limit = Math.round(Math.max(SUPPLY_MIN_AMPS, Math.min(SUPPLY_MAX_AMPS, change.limit)) * 1000) / 1000;
}

export type ScopeChange = Partial<Omit<ScopeDoc, 'id' | 'x' | 'z' | 'trigger'>> & { trigger?: Partial<ScopeTrigger> };

/** Changes a scope's settings. Defaults aren't saved: a channel on, DC, its 0 V line in the middle. */
export function setScopeSettings(s: ScopeDoc, change: ScopeChange): void {
  const { trigger, ...rest } = change;
  Object.assign(s, rest);
  const saved = s as unknown as Record<string, unknown>;
  for (const [k, v] of Object.entries(rest))
    if (v === undefined || v === false || (k.startsWith('offset') && v === 0)) delete saved[k];
  if (trigger) {
    const t: ScopeTrigger = { ...(s.trigger ?? DEFAULT_TRIGGER), ...trigger };
    if ('level' in trigger && trigger.level === undefined) delete t.level;
    s.trigger = t;
  }
}
