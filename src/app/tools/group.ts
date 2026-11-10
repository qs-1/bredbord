// Several parts and wires handled together: moved by whole holes (dragged, or nudged with the arrow
// keys), copied, and pasted somewhere else. Wire ends on a bench instrument stay on it.

import * as THREE from 'three';
import {
  allocId,
  sameHole,
  type CircuitDoc,
  type DeskPoint,
  type HoleRef,
  type Id,
  type PartDoc,
  type WireColor,
} from '../../engine/circuit';
import { PARTS, type PartDef } from '../../engine/parts';
import type { ItemRef } from '../scene-sync';
import { MISSES_BOARD, type Fit } from './fit';
import { straddles } from './placement';

const round1 = (v: number): number => Math.round(v * 10) / 10;

/** Parts and wires as they were when picked up: every leg's hole, every wire's ends and bends. */
export interface GroupAsIs {
  parts: Map<Id, HoleRef[]>;
  wires: Map<Id, { a: HoleRef; b: HoleRef; points?: DeskPoint[] }>;
}

/** Parts and wires moved by so many holes: their new holes, and why that won't do if it won't. */
export interface Shifted {
  parts: Map<Id, HoleRef[]>;
  wires: Map<Id, { a: HoleRef; b: HoleRef }>;
  reason?: string;
}

/** Copied parts and wires, where they were on the desk, for pasting somewhere else. */
export interface GroupClip {
  parts: {
    doc: Omit<PartDoc, 'id' | 'pins'>;
    def: PartDef;
    at: THREE.Vector3[];
    rows: (number | undefined)[];
    keepRows: boolean;
  }[];
  /** Ends in holes are where they were; ends on a bench supply's terminals stay on them. */
  wires: { color: WireColor; ends: (THREE.Vector3 | HoleRef)[]; points?: DeskPoint[] }[];
  /** The point that goes to the hole under the pointer. */
  anchor: THREE.Vector3;
}

/** Where a paste would land with its anchor moved `dx`, `dz`. */
export interface PasteTarget {
  dx: number;
  dz: number;
  parts: HoleRef[][];
  wires: [HoleRef, HoleRef][];
  reason?: string;
}

/** The parts and wires named, as they are now, ready to be shifted. */
export function groupAsIs(doc: CircuitDoc, ids: ReadonlySet<Id>): GroupAsIs {
  return {
    parts: new Map(doc.parts.filter((p) => ids.has(p.id)).map((p) => [p.id, p.pins.map((r) => ({ ...r }))])),
    wires: new Map(
      doc.wires
        .filter((w) => ids.has(w.id))
        .map((w) => [w.id, { a: { ...w.a }, b: { ...w.b }, points: w.points?.map((p) => ({ ...p })) }]),
    ),
  };
}

/** The first leg or wire end in a board, which the group's moves are measured from. */
export function groupAnchor(fit: Fit, from: GroupAsIs): HoleRef | undefined {
  return (
    [...from.parts.values()][0]?.[0] ?? [...from.wires.values()].flatMap((w) => [w.a, w.b]).find((r) => !fit.onBench(r))
  );
}

/** Where parts and wires (at the holes in `from`) would go moved `dx`, `dz` mm, and why they can't if they can't. */
export function shiftedGroup(fit: Fit, from: GroupAsIs, dx: number, dz: number): Shifted {
  const sync = fit.sync;
  const ids = new Set([...from.parts.keys(), ...from.wires.keys()]);
  let reason: string | undefined;
  const shift = (r: HoleRef): HoleRef | null => {
    if (fit.onBench(r)) return r;
    const w = sync.holeWorld(r);
    const landed = w ? fit.landing(w, dx, dz, ids) : { ref: null, reason: MISSES_BOARD };
    reason ??= landed.reason;
    return landed.ref;
  };
  const parts = new Map<Id, HoleRef[]>();
  for (const [id, pins] of from.parts) {
    const moved = pins.map(shift);
    const def = fit.partDef(id);
    // Chips and buttons straddle the channel: they keep their rows.
    if (straddles(def) && moved.some((m, i) => m && sync.hole(m)?.row !== sync.hole(pins[i])?.row))
      reason ??= 'Chips have to stay across the centre channel';
    parts.set(id, moved as HoleRef[]);
    const world = moved.map((m) => m && sync.holeWorld(m));
    if (def && !reason && world.every((w) => w))
      reason = fit.bodyReason(def, world as THREE.Vector3[], ids, fit.part(id)?.value);
  }
  const wires = new Map<Id, { a: HoleRef; b: HoleRef }>();
  for (const [id, w] of from.wires) {
    const a = shift(w.a);
    const b = shift(w.b);
    if (a && b && sameHole(a, b)) reason ??= 'A wire would have both ends in one hole';
    wires.set(id, { a: a!, b: b! });
  }
  return { parts, wires, reason };
}

/** Puts parts and wires where shiftedGroup() worked out, their wires' bends moved `dx`, `dz` from where they were. */
export function applyShift(doc: CircuitDoc, from: GroupAsIs, to: Shifted, dx: number, dz: number): void {
  for (const p of doc.parts) {
    const pins = to.parts.get(p.id);
    if (pins) p.pins = pins;
  }
  for (const w of doc.wires) {
    const moved = to.wires.get(w.id);
    if (!moved) continue;
    w.a = moved.a;
    w.b = moved.b;
    const points = from.wires.get(w.id)?.points;
    if (points) w.points = points.map((p) => ({ x: round1(p.x + dx), z: round1(p.z + dz) }));
  }
}

/** The parts and wires named, as they are, ready to paste; null if none of them can be. */
export function clipGroup(fit: Fit, ids: ReadonlySet<Id>): GroupClip | null {
  const { sync, store } = fit;
  const doc = store.doc;
  const parts: GroupClip['parts'] = [];
  for (const p of doc.parts) {
    const def = PARTS[p.def];
    const at = p.pins.map((r) => sync.holeWorld(r));
    if (!ids.has(p.id) || !def || at.some((v) => !v)) continue;
    const { id: _id, pins: _pins, ...rest } = structuredClone(p);
    parts.push({
      doc: rest,
      def,
      at: at as THREE.Vector3[],
      rows: p.pins.map((r) => sync.hole(r)?.row),
      keepRows: straddles(def),
    });
  }
  const wires: GroupClip['wires'] = [];
  for (const w of doc.wires) {
    if (!ids.has(w.id)) continue;
    const ends = [w.a, w.b].map((r) => (fit.onBench(r) ? { ...r } : sync.holeWorld(r)));
    if (ends.some((e) => !e)) continue;
    wires.push({ color: w.color, ends: ends as (THREE.Vector3 | HoleRef)[], points: w.points?.map((p) => ({ ...p })) });
  }
  const anchor =
    parts[0]?.at[0] ?? wires.flatMap((w) => w.ends).find((e): e is THREE.Vector3 => e instanceof THREE.Vector3);
  return anchor ? { parts, wires, anchor: anchor.clone() } : null;
}

/** Where a pasted group goes with its anchor in the hole at `to`. */
export function pasteTarget(fit: Fit, clip: GroupClip, to: THREE.Vector3): PasteTarget {
  const dx = to.x - clip.anchor.x;
  const dz = to.z - clip.anchor.z;
  const none = new Set<Id>();
  let reason: string | undefined;
  const land = (world: THREE.Vector3): HoleRef | null => {
    const landed = fit.landing(world, dx, dz, none);
    reason ??= landed.reason;
    return landed.ref;
  };
  const parts = clip.parts.map((p) => {
    const pins = p.at.map(land);
    if (p.keepRows && pins.some((r, i) => r && fit.sync.hole(r)?.row !== p.rows[i]))
      reason ??= 'Chips have to stay across the centre channel';
    return pins as HoleRef[];
  });
  const wires = clip.wires.map(
    (w) => w.ends.map((e) => (e instanceof THREE.Vector3 ? land(e) : e)) as [HoleRef, HoleRef],
  );
  if (!reason && wires.some(([a, b]) => sameHole(a, b))) reason = 'A wire would have both ends in one hole';
  return { dx, dz, parts, wires, reason };
}

/** Adds the pasted parts and wires to the document. Returns them, to select. */
export function pasteInto(doc: CircuitDoc, clip: GroupClip, t: PasteTarget): ItemRef[] {
  const items: ItemRef[] = [];
  clip.parts.forEach((p, i) => {
    const id = allocId(doc, 'p');
    doc.parts.push({ id, ...structuredClone(p.doc), pins: t.parts[i] });
    items.push({ kind: 'part', id });
  });
  clip.wires.forEach((w, i) => {
    const id = allocId(doc, 'w');
    const points = w.points?.map((p) => ({ x: round1(p.x + t.dx), z: round1(p.z + t.dz) }));
    doc.wires.push({ id, a: t.wires[i][0], b: t.wires[i][1], color: w.color, ...(points ? { points } : {}) });
    items.push({ kind: 'wire', id });
  });
  return items;
}
