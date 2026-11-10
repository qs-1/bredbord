import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { EXAMPLES } from '../src/app/example';
import { BOARD_HEIGHT as H, boardSpec, PITCH } from '../src/engine/breadboard';
import { holeKey, type CircuitDoc } from '../src/engine/circuit';
import { PARTS } from '../src/engine/parts';
import { partObstacles } from '../src/view/components';
import { coveredHoles } from '../src/view/covered';
import { obstaclesMeet, type Obstacle } from '../src/view/routing';

const at = (col: number, row: number): THREE.Vector3 => new THREE.Vector3(col * PITCH, H, row * PITCH);
const meet = (a: Obstacle[], b: Obstacle[]): boolean => a.some((x) => b.some((y) => obstaclesMeet(x, y)));

/** Every pair of parts in `doc` whose bodies are inside each other, as "id/id". */
function clashes(doc: CircuitDoc): string[] {
  const boards = new Map(doc.boards.map((b) => [b.id, b]));
  const world = (r: { board: string; hole: string }): THREE.Vector3 => {
    const b = boards.get(r.board)!;
    const hole = boardSpec(b.type).hole(r.hole)!;
    return new THREE.Vector3(b.x + hole.x, H, b.z + hole.z);
  };
  const solids = doc.parts.map((p) => ({
    id: p.id,
    solid: partObstacles(PARTS[p.def], p.pins.map(world), {
      value: p.value,
      state: p.state,
      facing: p.pins[0]?.hole === 'T+1' ? -1 : 1,
    }),
  }));
  const out: string[] = [];
  for (let i = 0; i < solids.length; i++) {
    for (let j = i + 1; j < solids.length; j++)
      if (meet(solids[i].solid, solids[j].solid)) out.push(`${solids[i].id}/${solids[j].id}`);
  }
  return out;
}

describe('parts sitting inside each other', () => {
  it('catches 5 mm LEDs in neighbouring holes, but not a hole apart', () => {
    const led = (col: number): Obstacle[] => partObstacles(PARTS['led-red'], [at(col, 0), at(col, 1)], { value: 5 });
    expect(meet(led(0), led(1))).toBe(true);
    expect(meet(led(0), led(2))).toBe(false);
  });

  it('lets chips sit end to end', () => {
    const chip = (col: number): Obstacle[] => {
      const pins = [
        ...Array.from({ length: 7 }, (_, i) => at(col + i, 2)),
        ...Array.from({ length: 7 }, (_, i) => at(col + 6 - i, -1)),
      ];
      return partObstacles(PARTS['74LS00'], pins);
    };
    expect(meet(chip(0), chip(7))).toBe(false);
    expect(meet(chip(0), chip(5))).toBe(true);
  });

  for (const ex of EXAMPLES) {
    it(`has none in the ${ex.title} example, nor anything plugged in under a part`, async () => {
      const doc = await ex.make();
      expect(clashes(doc)).toEqual([]);
      const covered = coveredHoles(doc);
      const under = [
        ...doc.parts.flatMap((p) => p.pins.map((r) => [p.id, r] as const)),
        ...doc.wires.flatMap(
          (w) =>
            [
              [w.id, w.a],
              [w.id, w.b],
            ] as const,
        ),
      ]
        .filter(([, r]) => covered.has(holeKey(r)))
        .map(([id, r]) => `${id} in ${holeKey(r)} under ${covered.get(holeKey(r))}`);
      expect(under).toEqual([]);
    });
  }
});
