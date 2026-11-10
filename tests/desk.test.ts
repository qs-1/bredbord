import { describe, expect, it } from 'vitest';
import { deskSpot, type DeskThing } from '../src/app/tools/desk';

const BOARD = { x: 165.1, z: 54.6 };
const board = (x: number, z: number): DeskThing => ({ x, z, size: BOARD, gap: 0 });

describe('placing things on the desk', () => {
  it('snaps a board flush beside another and in line with it', () => {
    // Dropped a little off, just below the first: it sits right against it, ends level.
    expect(deskSpot(BOARD, [board(0, 0)], 3, 58)).toEqual({ x: 0, z: 54.6, valid: true });
  });

  it('slides a board dropped partly onto another out the short way, not somewhere else', () => {
    // Overlapping by 10 mm at the bottom, well along to the right: pushed down, x left where it was.
    const at = deskSpot(BOARD, [board(0, 0)], 60, 44.6);
    expect(at.valid).toBe(true);
    expect(at.z).toBeCloseTo(54.6);
    expect(at.x).toBe(60);
  });

  it('keeps following the pointer while it slides along an edge', () => {
    const xs = [20, 40, 60, 80].map((x) => deskSpot(BOARD, [board(0, 0)], x, 40).x);
    expect(xs).toEqual([20, 40, 60, 80]);
  });

  it('leaves a gap from an instrument', () => {
    const supply: DeskThing = { x: 0, z: 0, size: { x: 86, z: 120 }, gap: 5 };
    const at = deskSpot(BOARD, [supply], 100, 0);
    expect(at.valid).toBe(true);
    expect(at.x - 165.1 / 2 - (0 + 86 / 2)).toBeGreaterThanOrEqual(5 - 0.01);
  });

  it('gets clear of two boards it lands between', () => {
    const at = deskSpot(BOARD, [board(0, 0), board(0, 60)], 0, 30);
    expect(at.valid).toBe(true);
    for (const o of [0, 60]) expect(Math.abs(at.z - o) >= 54.6 - 0.02 || Math.abs(at.x) >= 165.1 - 0.02).toBe(true);
  });
});
