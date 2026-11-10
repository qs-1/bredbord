import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { benchDoc } from '../src/app/bench';
import { BOARD_HEIGHT as H, boardSpec, PITCH } from '../src/engine/breadboard';
import { PARTS } from '../src/engine/parts';
import { partObstacles } from '../src/view/components';
import {
  BASE_HEIGHT,
  heightAt,
  Router,
  STACK,
  WIRE_RADIUS,
  type Obstacle,
  type Route,
  type RouteInput,
} from '../src/view/routing';

/** A hole on a board, counted in pitches. */
const at = (x: number, z: number): THREE.Vector3 => new THREE.Vector3(x * PITCH, H, z * PITCH);
const wire = (...path: THREE.Vector3[]): RouteInput => ({ path });
const route = (wires: RouteInput[], obstacles: Obstacle[] = []): Route[] => new Router().route(wires, obstacles);
const highest = (r: Route): number => Math.max(...r.heights);
const flat = (r: Route): void => {
  expect(highest(r)).toBeCloseTo(BASE_HEIGHT, 6);
  expect(Math.min(...r.heights)).toBeCloseTo(BASE_HEIGHT, 6);
};
/** Which way it runs at its point `k`, seen from above. */
const heading = (r: Route, k: number): THREE.Vector3 => {
  const i = Math.min(k, r.plan.x.length - 2);
  return new THREE.Vector3(r.plan.x[i + 1] - r.plan.x[i], 0, r.plan.z[i + 1] - r.plan.z[i]).normalize();
};
/** Its height at a point on the board it passes over. */
const heightOver = (r: Route, p: THREE.Vector3): number => {
  let best = 0;
  for (let i = 1; i < r.plan.x.length; i++) {
    if (Math.hypot(r.plan.x[i] - p.x, r.plan.z[i] - p.z) < Math.hypot(r.plan.x[best] - p.x, r.plan.z[best] - p.z))
      best = i;
  }
  return r.heights[best];
};

describe('wire routing', () => {
  it('lays a wire flat when nothing is in its way, bends and all', () => {
    const [r] = route([wire(at(0, 0), at(10, 0), at(10, 6), at(20, 6))]);
    flat(r);
  });

  it('hops the later wire over the earlier one only where they cross', () => {
    const [first, second] = route([wire(at(0, 0), at(20, 0)), wire(at(10, -8), at(10, 8))]);
    flat(first);
    expect(heightOver(second, at(10, 0))).toBeGreaterThanOrEqual(BASE_HEIGHT + STACK - 1e-6);
    expect(heightAt(second, 0)).toBeCloseTo(BASE_HEIGHT, 6);
    expect(heightAt(second, second.plan.length)).toBeCloseTo(BASE_HEIGHT, 6);
    // It's back down on the board well before its ends.
    expect(heightOver(second, at(10, -4))).toBeCloseTo(BASE_HEIGHT, 6);
    expect(heightOver(second, at(10, 4))).toBeCloseTo(BASE_HEIGHT, 6);
  });

  it('hops a wire over another one ending in a hole under it, whichever went down first', () => {
    for (const longFirst of [true, false]) {
      const long = wire(at(0, 0), at(20, 0));
      const short = wire(at(10, 0), at(10, 6));
      const routes = route(longFirst ? [long, short] : [short, long]);
      const [l, s] = longFirst ? routes : routes.reverse();
      // The short one comes straight up out of its hole and stays low; the long one clears it.
      expect(s.heights[0]).toBeCloseTo(BASE_HEIGHT, 6);
      expect(highest(s)).toBeCloseTo(BASE_HEIGHT, 6);
      expect(heightOver(l, at(10, 0))).toBeGreaterThanOrEqual(BASE_HEIGHT + STACK - 1e-6);
      expect(heightAt(l, 0)).toBeCloseTo(BASE_HEIGHT, 6);
      expect(heightOver(l, at(4, 0))).toBeCloseTo(BASE_HEIGHT, 6);
    }
  });

  it('carries a wire still being drawn over the one its loose end is above', () => {
    const [placed, drawing] = route([wire(at(0, 0), at(20, 0)), { path: [at(10, 6), at(10, 0)], open: true }]);
    flat(placed);
    expect(heightAt(drawing, drawing.plan.length)).toBeGreaterThanOrEqual(BASE_HEIGHT + STACK - 1e-6);
  });

  it('keeps a wire flat beside an LED, under the edge of its lens', () => {
    const led = partObstacles(PARTS['led-red'], [at(10, 1), at(11, 1)], { value: 5 });
    const [r] = route([wire(at(0, 0), at(20, 0))], led);
    flat(r);
  });

  it('takes a wire through an LED leg up over the LED, and only there', () => {
    const led = partObstacles(PARTS['led-red'], [at(10, 0), at(11, 0)], { value: 5 });
    const [r] = route([wire(at(0, 0), at(30, 0))], led);
    // Clear of the top of its 5 mm lens (11.9 mm up).
    expect(heightOver(r, at(10.5, 0))).toBeGreaterThan(H + 11.9 + WIRE_RADIUS);
    expect(heightAt(r, 0)).toBeCloseTo(BASE_HEIGHT, 6);
    expect(heightAt(r, r.plan.length)).toBeCloseTo(BASE_HEIGHT, 6);
  });

  it('lets wires under a capacitor up on bent legs, but hops one standing on the board', () => {
    const cap = PARTS['cap-electrolytic'];
    const raised = partObstacles(cap, [at(10, 1), at(13, 1)], { value: 10e-6 });
    const standing = partObstacles(cap, [at(10, 1), at(11, 1)], { value: 10e-6 });
    flat(route([wire(at(0, 0.5), at(20, 0.5))], raised)[0]);
    expect(highest(route([wire(at(0, 1.5), at(20, 1.5))], standing)[0])).toBeGreaterThan(H + 11);
  });

  it('runs a wire under a Nano between its headers, and over it across them', () => {
    const pins = Array.from({ length: 30 }, (_, i) => (i < 15 ? at(i - 7, 3) : at(7 - (i - 15), -3)));
    const nano = partObstacles(PARTS['nano'], pins);
    flat(route([wire(at(-12, 0), at(12, 0))], nano)[0]);
    const [across] = route([wire(at(0, -12), at(0, 12))], nano);
    expect(heightOver(across, at(0, 0))).toBeGreaterThan(H + 4.1 + WIRE_RADIUS);
    expect(heightAt(across, 0)).toBeCloseTo(BASE_HEIGHT, 6);
  });

  it('hops over a chip it crosses and lies flat beside one', () => {
    const pins = [
      ...Array.from({ length: 7 }, (_, i) => at(i, 1.5)),
      ...Array.from({ length: 7 }, (_, i) => at(6 - i, -1.5)),
    ];
    const chip = partObstacles(PARTS['74LS00'], pins);
    const [across] = route([wire(at(3, -6), at(3, 6))], chip);
    expect(heightOver(across, at(3, 0))).toBeGreaterThan(H + 3.9 + WIRE_RADIUS);
    expect(heightAt(across, 0)).toBeCloseTo(BASE_HEIGHT, 6);
    flat(route([wire(at(-2, 2.5), at(10, 2.5))], chip)[0]);
  });

  // The benchmark is a stress test: dense fan-outs, and wires laid along each other on one row,
  // where wires going over each other in a loop can't all be stacked cleanly. A few may still touch.
  it('routes the 8-bit-scale benchmark quickly, with hardly any wires touching and no tall stacks', () => {
    const doc = benchDoc();
    const boards = new Map(doc.boards.map((b) => [b.id, b]));
    const world = (r: { board: string; hole: string }): THREE.Vector3 => {
      const b = boards.get(r.board)!;
      const hole = boardSpec(b.type).hole(r.hole)!;
      return new THREE.Vector3(b.x + hole.x, H, b.z + hole.z);
    };
    const obstacles = doc.parts.flatMap((p) => {
      const pins = p.pins.map(world);
      return partObstacles(PARTS[p.def], pins, {
        value: p.value,
        state: p.state,
        facing: p.pins[0]?.hole === 'T+1' ? -1 : 1,
      });
    });
    const wires = doc.wires.map((w) =>
      wire(world(w.a), ...(w.points ?? []).map((p) => new THREE.Vector3(p.x, H, p.z)), world(w.b)),
    );
    const router = new Router();
    let t = performance.now();
    const routes = router.route(wires, obstacles);
    const firstMs = performance.now() - t;
    // Routing again with nothing changed, as happens on every edit elsewhere: the middle of several runs.
    const again: number[] = [];
    for (let k = 0; k < 9; k++) {
      t = performance.now();
      router.route(wires, obstacles);
      again.push(performance.now() - t);
    }
    const againMs = again.sort((a, b) => a - b)[4];
    console.log(
      `routing ${wires.length} wires: ${firstMs.toFixed(1)} ms, again ${againMs.toFixed(1)} ms; ${routes.filter((r) => highest(r) > BASE_HEIGHT + 1e-6).length} hop`,
    );

    const clashes: string[] = [];
    for (let i = 0; i < routes.length; i++) {
      for (let j = i + 1; j < routes.length; j++) {
        const a = routes[i];
        const b = routes[j];
        if (
          a.plan.minX > b.plan.maxX + 2 ||
          b.plan.minX > a.plan.maxX + 2 ||
          a.plan.minZ > b.plan.maxZ + 2 ||
          b.plan.minZ > a.plan.maxZ + 2
        )
          continue;
        for (let k = 0; k < a.plan.x.length; k++) {
          for (let m = 0; m < b.plan.x.length; m++) {
            const d = Math.hypot(a.plan.x[k] - b.plan.x[m], a.plan.z[k] - b.plan.z[m]);
            if (d >= 2 * WIRE_RADIUS) continue;
            // Wires laid along each other (the benchmark has some on the same row) can't both
            // come up out of holes under the other; only crossings are checked.
            if (Math.abs(heading(a, k).cross(heading(b, m)).y) < Math.sin((15 * Math.PI) / 180)) continue;
            if (Math.hypot(d, a.heights[k] - b.heights[m]) < 2 * WIRE_RADIUS - 0.05)
              clashes.push(`${doc.wires[i].id}/${doc.wires[j].id}`);
          }
        }
      }
    }
    expect(new Set(clashes).size).toBeLessThanOrEqual(2 * doc.boards.length);
    // In mm, not wire thicknesses: the highest wire is lifted by a part it crosses (20.9 mm at the
    // old 0.78 mm radius, 20.8 at 0.66), so it barely changes with how thick wires are.
    expect(Math.max(...routes.map(highest))).toBeLessThan(21.1);
    expect(firstMs).toBeLessThan(1500);
    expect(againMs).toBeLessThan(25);
    // Its all-pairs clash check is slow beside other test files; the routing itself is timed above.
  }, 20_000);
});
