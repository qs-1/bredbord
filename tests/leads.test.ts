import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { BOARD_HEIGHT as H } from '../src/engine/breadboard';
import { boxObstacle, Router, WIRE_RADIUS } from '../src/view/routing';
import { routePath, wireShape } from '../src/view/wires';

const board = (x: number, z: number) => new THREE.Vector3(x, H, z);
const post = (x: number, z: number, y = 24) => new THREE.Vector3(x, y, z);
const routed = (a: THREE.Vector3, b: THREE.Vector3, obstacles = [] as ReturnType<typeof boxObstacle>[]) =>
  new Router().route([{ path: routePath(a, [], b) }], obstacles)[0];

const expectPoint = (actual: THREE.Vector3, expected: THREE.Vector3): void => {
  expect(actual.x).toBeCloseTo(expected.x, 6);
  expect(actual.y).toBeCloseTo(expected.y, 6);
  expect(actual.z).toBeCloseTo(expected.z, 6);
};

describe('bench leads', () => {
  it('renders a board-to-post cable in its original direction without a U-turn', () => {
    const a = board(0, 0);
    const b = post(120, 0);
    const shape = wireShape(a, b, [], routed(a, b));
    expect(shape.bareA).toHaveLength(2);
    expect(shape.bareB).toHaveLength(0);
    expectPoint(shape.insulation.at(-1)!, b);
    expectPoint(shape.bareA.at(-1)!, new THREE.Vector3(a.x, H - 3.2, a.z));
    // A direct run should not reverse beyond either endpoint in the desk plane.
    for (const p of shape.insulation) {
      expect(p.x).toBeGreaterThanOrEqual(-1e-6);
      expect(p.x).toBeLessThanOrEqual(120 + 1e-6);
    }
  });

  it('keeps the one stripped end on the breadboard for a post-to-board cable', () => {
    const a = post(0, 0);
    const b = board(120, 0);
    const shape = wireShape(a, b, [], routed(a, b));
    expect(shape.bareA).toHaveLength(0);
    expect(shape.bareB).toHaveLength(2);
    expectPoint(shape.insulation[0], a);
    expectPoint(shape.bareB.at(-1)!, new THREE.Vector3(b.x, H - 3.2, b.z));
  });

  it('draws a post-to-post cable fully insulated and above the desk', () => {
    const a = post(0, 0, 20);
    const b = post(120, 0, 27);
    const shape = wireShape(a, b, [], routed(a, b));
    expect(shape.bareA).toHaveLength(0);
    expect(shape.bareB).toHaveLength(0);
    expectPoint(shape.insulation[0], a);
    expectPoint(shape.insulation.at(-1)!, b);
    expect(Math.min(...shape.insulation.map((p) => p.y))).toBeGreaterThan(H + 2);
  });

  it('takes a lead above a desk obstacle instead of diving through it', () => {
    const a = post(0, 0, 20);
    const b = post(120, 0, 20);
    const shape = wireShape(a, b, [], routed(a, b, [boxObstacle(45, 75, -15, 15, 52, 0)]));
    expect(Math.max(...shape.insulation.map((p) => p.y))).toBeGreaterThan(52.8);
  });

  it('leaves a post forwards without doubling back into a hook', () => {
    // A hole off to the side, level with the socket: the cable must come out of the post and
    // curve away, never swing back towards the case it just left.
    const a = post(0, 0);
    const b = board(-120, 0);
    const shape = wireShape(a, b, [], routed(a, b));
    let left = false;
    for (const p of shape.insulation) {
      if (p.x < -20) break;
      if (p.z > 6) left = true;
      else if (left) expect(p.z).toBeGreaterThan(4);
    }
    expect(left).toBe(true);
  });

  it('takes crossing leads one over the other instead of through each other', () => {
    // Two leads from neighbouring posts to holes in swapped order cross on their way.
    const ends = [
      [post(0, -40), board(60, 0)],
      [post(10, -40), board(50, 0)],
    ] as const;
    const routes = new Router().route(
      ends.map(([a, b]) => ({ path: routePath(a, [], b) })),
      [],
    );
    const [p, q] = ends.map(([a, b], k) => wireShape(a, b, [], routes[k]).insulation);
    // The closest the two cables' centrelines come, sampled every 0.2 mm along one of them.
    const on = new THREE.Vector3();
    let closest = Infinity;
    for (let i = 0; i < p.length - 1; i++) {
      const n = Math.max(1, Math.ceil(p[i].distanceTo(p[i + 1]) / 0.2));
      for (let k = 0; k <= n; k++) {
        const x = p[i].clone().lerp(p[i + 1], k / n);
        for (let j = 0; j < q.length - 1; j++)
          closest = Math.min(closest, new THREE.Line3(q[j], q[j + 1]).closestPointToPoint(x, true, on).distanceTo(x));
      }
    }
    expect(closest).toBeGreaterThan(2 * WIRE_RADIUS - 0.05);
  });
});
