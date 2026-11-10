// Holes no lead can get into: under the body of a part, like the middle rows of a wide chip or the
// rail holes beneath a power module's board. A wire or leg plugged in there would have to come up
// through the part.

import * as THREE from 'three';
import { BOARD_HEIGHT as H, boardSpec, type BoardSpec, type Hole } from '../engine/breadboard';
import { holeKey, type CircuitDoc, type Id } from '../engine/circuit';
import { PARTS } from '../engine/parts';
import { partObstacles } from './components';
import type { Obstacle } from './routing';

/** How far (mm) round a hole the body has to reach for it to count as under it, so a body's edge passing a hole doesn't. */
const MARGIN = 0.5;

/** A board's holes in order across it, to find the ones under something without trying them all. */
const byX = new WeakMap<BoardSpec, { xs: Float64Array; holes: Hole[] }>();
function holesByX(spec: BoardSpec): { xs: Float64Array; holes: Hole[] } {
  let index = byX.get(spec);
  if (!index) {
    const holes = [...spec.holes].sort((a, b) => a.x - b.x);
    byX.set(spec, (index = { xs: Float64Array.from(holes, (h) => h.x), holes }));
  }
  return index;
}

/** Every hole under a part's body (other than that part's own pins), and the part over it. */
export function coveredHoles(doc: CircuitDoc, solids?: ReadonlyMap<Id, readonly Obstacle[]>): Map<string, Id> {
  const boards = doc.boards.map((b) => ({ doc: b, spec: boardSpec(b.type) }));
  const byId = new Map(boards.map((b) => [b.doc.id, b]));
  const out = new Map<string, Id>();
  for (const part of doc.parts) {
    const def = PARTS[part.def];
    if (!def) continue;
    const world: THREE.Vector3[] = [];
    for (const ref of part.pins) {
      const b = byId.get(ref.board);
      const h = b?.spec.hole(ref.hole);
      if (!b || !h) break;
      world.push(new THREE.Vector3(b.doc.x + h.x, H, b.doc.z + h.z));
    }
    if (world.length !== part.pins.length) continue;
    const own = new Set(part.pins.map(holeKey));
    const facing = part.pins[0]?.hole === 'T+1' ? -1 : 1;
    for (const o of solids?.get(part.id) ??
      partObstacles(def, world, { value: part.value, state: part.state, facing })) {
      // Thin legs never cover a hole: the body has to reach right round it.
      const inside = (x: number, z: number): boolean => o.distance(x, z) === 0;
      for (const b of boards) {
        const { x: bx, z: bz } = b.doc;
        if (
          o.maxX < bx - b.spec.length / 2 ||
          o.minX > bx + b.spec.length / 2 ||
          o.maxZ < bz - b.spec.width / 2 ||
          o.minZ > bz + b.spec.width / 2
        )
          continue;
        const { xs, holes } = holesByX(b.spec);
        let lo = 0;
        let hi = xs.length;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (xs[mid] < o.minX - bx) lo = mid + 1;
          else hi = mid;
        }
        for (let i = lo; i < xs.length && xs[i] <= o.maxX - bx; i++) {
          const h = holes[i];
          const x = bx + h.x;
          const z = bz + h.z;
          if (z < o.minZ || z > o.maxZ) continue;
          if (!(inside(x - MARGIN, z) && inside(x + MARGIN, z) && inside(x, z - MARGIN) && inside(x, z + MARGIN)))
            continue;
          const key = holeKey({ board: b.doc.id, hole: h.name });
          if (!own.has(key)) out.set(key, part.id);
        }
      }
    }
  }
  return out;
}
