// Whether things fit where they're put: free holes, room for a part's body, and where pins land when
// they're moved. Placing, dragging, pasting and nudging all ask the same questions.

import * as THREE from 'three';
import { boardSpec, PITCH } from '../../engine/breadboard';
import { holeKey, type HoleRef, type Id, type PartDoc } from '../../engine/circuit';
import { PARTS, type PartDef } from '../../engine/parts';
import type { SceneSync } from '../scene-sync';
import type { Store } from '../store';

/** Why a move or paste can't go where it was put. */
export const MISSES_BOARD = 'Part of it would miss the board there';

/** Parts and wires to leave out of a check: one id, or several. */
export type Ignore = Id | ReadonlySet<Id> | undefined;

const skips = (ignore: Ignore, id: Id): boolean => (typeof ignore === 'string' ? id === ignore : !!ignore?.has(id));

export class Fit {
  constructor(
    readonly store: Store,
    readonly sync: SceneSync,
  ) {}

  part(id: Id): PartDoc | undefined {
    return this.store.doc.parts.find((p) => p.id === id);
  }

  partDef(id: Id): PartDef | undefined {
    const part = this.part(id);
    return part && PARTS[part.def];
  }

  /** Why a lead can't go in these holes, if it can't: one has a lead in it, or is under a part (other than those ignored). */
  holesReason(refs: readonly HoleRef[], ignore?: Ignore): string | undefined {
    for (const ref of refs) {
      const occ = this.sync.occupancy.get(holeKey(ref));
      if (occ && !skips(ignore, occ.id))
        return refs.length > 1 ? 'Some of those holes are already in use' : 'That hole already has a lead in it';
    }
    for (const ref of refs) {
      const over = this.sync.covered.get(holeKey(ref));
      if (over && !skips(ignore, over))
        return `That hole is under the ${this.partDef(over)?.title ?? 'part next to it'}`;
    }
    return undefined;
  }

  /** Why a part with its legs at `world` can't go there, if it would sit inside another part's body. */
  bodyReason(
    def: PartDef,
    world: readonly THREE.Vector3[],
    ignore: Ignore,
    value?: number,
    facing?: number,
  ): string | undefined {
    const skip = typeof ignore === 'string' ? new Set([ignore]) : (ignore ?? new Set<Id>());
    const other = this.sync.bodyClash(def, world, { value, facing }, skip);
    if (!other) return undefined;
    const title = this.partDef(other)?.title;
    return title ? `It would sit inside the ${title}` : 'It would sit inside another part';
  }

  /** The hole `dx`, `dz` mm from a point on the desk, and why it won't do if it won't. */
  landing(
    world: THREE.Vector3,
    dx: number,
    dz: number,
    ignore: ReadonlySet<Id>,
  ): { ref: HoleRef | null; reason?: string } {
    const ref = this.sync.holeNear(world.x + dx, world.z + dz);
    if (!ref) return { ref, reason: MISSES_BOARD };
    return { ref, reason: this.holesReason([ref], ignore) };
  }

  /** Whether a wire end is on a bench supply, meter or scope rather than in a board. */
  onBench(r: HoleRef): boolean {
    return !!(this.sync.supply(r.board) || this.sync.meter(r.board) || this.sync.scope(r.board));
  }

  /**
   * Pins moved by `delta` on the desk, snapped so they land in holes, or null if any would miss the
   * boards. Parts that straddle the channel stay in their rows.
   */
  shifted(pins: readonly HoleRef[], delta: THREE.Vector3, keepRows: boolean): HoleRef[] | null {
    const sync = this.sync;
    const first = sync.holeWorld(pins[0]);
    if (!first) return null;
    const near = sync.holeNear(first.x + delta.x, first.z + delta.z, PITCH);
    let target = near && sync.hole(near);
    if (!near || !target) return null;
    if (keepRows) {
      const own = sync.hole(pins[0]);
      const board = this.store.doc.boards.find((b) => b.id === near.board)!;
      target = own && boardSpec(board.type).holeAt(target.col, own.row);
      if (!target) return null;
    }
    const to = sync.holeWorld({ board: near.board, hole: target.name })!;
    const dx = to.x - first.x;
    const dz = to.z - first.z;
    const out: HoleRef[] = [];
    for (const p of pins) {
      const w = sync.holeWorld(p);
      const moved = w && sync.holeNear(w.x + dx, w.z + dz);
      if (!moved) return null;
      out.push(moved);
    }
    return out;
  }
}
