import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { ribbon } from '../src/view/geometry';

describe('wire ribbons', () => {
  it('puts each point down twice, one for either edge, with the way the wire runs there', () => {
    const g = ribbon([new THREE.Vector3(0, 0, 0), new THREE.Vector3(10, 0, 0), new THREE.Vector3(10, 0, 10)]);
    expect(g.attributes.position.count).toBe(6);
    expect(g.index!.count).toBe(12);
    expect(Array.from(g.attributes.aSide.array)).toEqual([-1, 1, -1, 1, -1, 1]);
    const t = g.attributes.aTangent;
    expect([t.getX(0), t.getZ(0)]).toEqual([1, 0]);
    // At the corner it runs halfway between the two ways.
    expect(t.getX(2)).toBeCloseTo(Math.SQRT1_2);
    expect(t.getZ(2)).toBeCloseTo(Math.SQRT1_2);
  });

  it('skips repeated points and draws nothing for a single one', () => {
    const p = new THREE.Vector3(1, 2, 3);
    expect(ribbon([p, p.clone(), new THREE.Vector3(4, 2, 3)]).attributes.position.count).toBe(4);
    expect(ribbon([p]).attributes.position).toBeUndefined();
  });
});
