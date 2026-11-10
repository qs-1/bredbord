// Where a part's legs go when it's placed with the pointer over a hole, and whether it fits there.

import * as THREE from 'three';
import { BOARD_HEIGHT as H, boardSpec, PITCH, type Hole } from '../../engine/breadboard';
import { sameHole, type HoleRef, type Id } from '../../engine/circuit';
import { dipFootprint, dipPinHoles, type PartDef } from '../../engine/parts';
import type { HoleHit } from '../scene-sync';
import type { Fit } from './fit';

export interface Placement {
  pins: HoleRef[];
  world: THREE.Vector3[];
  valid: boolean;
  reason?: string;
  facing?: number;
}

/** How the part being placed is turned, and an LED or capacitor's first leg when its legs are being dragged apart. */
export interface Orientation {
  /** Flipped end for end (chips, buttons, rows of legs). */
  flipped: boolean;
  /** Which way two-legged parts point: an index into LEG_DIRECTIONS. */
  direction: number;
  spanFrom: HoleHit | null;
}

/** Columns and rows from a two-legged part's first leg to its second, a quarter turn apart. */
export const LEG_DIRECTIONS: readonly [number, number][] = [
  [1, 0],
  [0, 1],
  [-1, 0],
  [0, -1],
];
/** Holes between a resistor's or diode's legs when it's dropped in. */
const AXIAL_SPAN = 4;
/** A power module's pins at either end of a BB830. */
const POWER_PINS = { left: ['T+1', 'T-1', 'B+1', 'B-1'], right: ['T+50', 'T-50', 'B+50', 'B-50'] };

/** Parts with two legs on wire leads: dragging a leg stretches them. */
export const twoLegged = (def: PartDef | null | undefined): boolean =>
  def?.kind === 'resistor' || def?.kind === 'diode';
/** Parts that drop in with their legs side by side, or can be dragged out to bend them further apart. */
export const bendable = (def: PartDef | null | undefined): boolean => def?.kind === 'led' || def?.kind === 'capacitor';
/** Parts that sit across the centre channel and have to keep their rows when moved. */
export const straddles = (def: PartDef | null | undefined): boolean =>
  !!def && (!!dipFootprint(def) || def.kind === 'button');
/** Parts the R key flips end for end rather than turns. */
export const flips = (def: PartDef): boolean =>
  !!dipFootprint(def) ||
  def.kind === 'button' ||
  def.kind === 'pot' ||
  def.kind === 'slide' ||
  def.kind === 'transistor' ||
  def.kind === 'network' ||
  def.kind === 'lcd';

/** Points in a row with gaps (legs off the board), the gaps filled in by carrying the row on; `step` along x if only one is known. */
function inLine(points: readonly (THREE.Vector3 | undefined)[], step: number): THREE.Vector3[] {
  const known = points.flatMap((p, i) => (p ? [i] : []));
  if (!known.length) return [];
  const i0 = known[0];
  const i1 = known[1];
  const d =
    i1 === undefined
      ? new THREE.Vector3(step, 0, 0)
      : points[i1]!.clone()
          .sub(points[i0]!)
          .divideScalar(i1 - i0);
  return points.map((p, i) => p ?? points[i0]!.clone().addScaledVector(d, i - i0));
}

/** Where a part would go with the pointer over `hit`, and whether it fits. `ignore` is a part being moved. */
export function placementFor(fit: Fit, def: PartDef, hit: HoleHit, o: Orientation, ignore?: Id): Placement | null {
  let h = hit;
  const spec = boardSpec(h.board.type);
  const at = (hole: Hole): THREE.Vector3 => new THREE.Vector3(h.board.x + hole.x, H, h.board.z + hole.z);
  let holes: (Hole | undefined)[];
  let facing: number | undefined;
  let reason: string | undefined;

  // Chips and buttons over a power rail are shown red at the nearest column, so it's clear they won't go there.
  if (straddles(def) && h.hole.kind !== 'terminal') {
    const e = spec.hole('e1');
    const near = e && spec.nearestHole(h.hole.x, e.z, 2 * PITCH);
    if (!near) return null;
    h = { ...h, hole: near };
    reason = 'It has to go across the centre channel';
  }
  const footprint = dipFootprint(def);
  if (footprint) {
    const n = footprint.pins / 2;
    const start = Math.max(0, Math.min(spec.columns - n, h.hole.col - Math.floor((n - 1) / 2)));
    holes = dipPinHoles(footprint, start, o.flipped).map((p) => spec.hole(`${p.row}${p.col + 1}`));
  } else {
    switch (def.kind) {
      case 'button': {
        const c = Math.max(0, Math.min(spec.columns - 3, h.hole.col)) + 1;
        const [e1, e2, f1, f2] = [`e${c}`, `e${c + 2}`, `f${c}`, `f${c + 2}`].map((n) => spec.hole(n)!);
        // Unturned, pressing joins the top half of the board to the bottom half; turned, column to column.
        holes = o.flipped ? [e1, f1, e2, f2] : [e1, e2, f1, f2];
        break;
      }
      case 'power':
        facing = h.hole.x < 0 ? -1 : 1;
        holes = POWER_PINS[facing < 0 ? 'left' : 'right'].map((n) => spec.hole(n));
        break;
      case 'pot':
      case 'slide':
      case 'transistor': {
        const row = [-1, 0, 1].map((d) => spec.holeAt(h.hole.col + d, h.hole.row));
        holes = o.flipped ? row.reverse() : row;
        if (holes.some((x) => !x)) reason = 'No room for its three legs there';
        break;
      }
      case 'network': {
        // Pin 1 (the dot) where you click, the rest along the row.
        const row = Array.from({ length: def.pins }, (_, i) => spec.holeAt(h.hole.col + i, h.hole.row));
        holes = o.flipped ? row.reverse() : row;
        if (holes.some((x) => !x)) reason = 'No room for its nine legs in a row there';
        break;
      }
      case 'lcd': {
        // Its 16 pins along the row, pin 1 where you click; flipped, pin 1 is at the right and the screen faces away.
        const row = Array.from({ length: 16 }, (_, i) =>
          spec.holeAt(h.hole.col + (o.flipped ? 15 - i : i), h.hole.row),
        );
        holes = row;
        if (holes.some((x) => !x)) reason = 'No room for its 16 pins in a row there';
        break;
      }
      case 'led':
      case 'capacitor': {
        const from = o.spanFrom;
        if (from) {
          // Dragged out: legs bent from the first hole to this one.
          if (sameHole(from.ref, h.ref)) return null;
          reason = fit.holesReason([from.ref, h.ref], ignore) ?? fit.bodyReason(def, [from.world, h.world], ignore);
          return { pins: [from.ref, h.ref], world: [from.world, h.world], valid: !reason, reason };
        }
        const [dc, dr] = LEG_DIRECTIONS[o.direction];
        const other = spec.holeAt(h.hole.col + dc, h.hole.row + dr);
        const world = [at(h.hole), at(h.hole).add(new THREE.Vector3(dc * PITCH, 0, dr * PITCH))];
        if (!other) return { pins: [], world, valid: false, reason: 'No hole for the other leg there' };
        holes = [h.hole, other];
        break;
      }
      case 'resistor':
      case 'diode': {
        // Dropped in with its legs four holes apart; drag a leg afterwards to stretch it.
        const [dc, dr] = LEG_DIRECTIONS[o.direction];
        const other = spec.holeAt(h.hole.col + dc * AXIAL_SPAN, h.hole.row + dr * AXIAL_SPAN);
        const world = [
          at(h.hole),
          at(h.hole).add(new THREE.Vector3(dc * AXIAL_SPAN * PITCH, 0, dr * AXIAL_SPAN * PITCH)),
        ];
        if (!other) return { pins: [], world, valid: false, reason: 'No hole for the other leg there' };
        holes = [h.hole, other];
        break;
      }
      default:
        return null;
    }
  }
  const found = holes.filter((x): x is Hole => !!x);
  if (found.length !== holes.length) {
    // Legs off the end of the board: still shown, red, carried on in line.
    return {
      pins: [],
      world: inLine(
        holes.map((x) => x && at(x)),
        o.flipped ? -PITCH : PITCH,
      ),
      valid: false,
      reason: reason ?? "That doesn't fit there",
    };
  }
  const pins = found.map((hole) => ({ board: h.board.id, hole: hole.name }));
  reason ??= fit.holesReason(pins, ignore);
  reason ??= fit.bodyReason(def, found.map(at), ignore, ignore ? fit.part(ignore)?.value : undefined, facing);
  return { pins, world: found.map(at), valid: !reason, reason, facing };
}
