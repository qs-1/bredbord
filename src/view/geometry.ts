// Small geometry helpers for bent wires and leads.

import * as THREE from 'three';

const UP = new THREE.Vector3(0, 1, 0);
const RIGHT = new THREE.Vector3(1, 0, 0);

/** Replaces each interior corner of a polyline with a short quadratic arc. */
export function roundCorners(
  points: readonly THREE.Vector3[],
  radius: number | ((corner: number) => number),
  steps = 6,
): THREE.Vector3[] {
  if (points.length < 3) return points.map((p) => p.clone());
  const out = [points[0].clone()];
  for (let i = 1; i < points.length - 1; i++) {
    const prev = points[i - 1];
    const corner = points[i];
    const next = points[i + 1];
    const d1 = corner.clone().sub(prev);
    const d2 = next.clone().sub(corner);
    const r = Math.min(typeof radius === 'number' ? radius : radius(i), d1.length() / 2, d2.length() / 2);
    d1.normalize();
    d2.normalize();
    if (r < 1e-4 || d1.dot(d2) > 0.9999) {
      out.push(corner.clone());
      continue;
    }
    const s = corner.clone().addScaledVector(d1, -r);
    const e = corner.clone().addScaledVector(d2, r);
    for (let k = 0; k <= steps; k++) {
      const t = k / steps;
      const u = 1 - t;
      out.push(
        new THREE.Vector3()
          .addScaledVector(s, u * u)
          .addScaledVector(corner, 2 * u * t)
          .addScaledVector(e, t * t),
      );
    }
  }
  out.push(points[points.length - 1].clone());
  return out;
}

/**
 * A round tube along a polyline, with a ring of vertices only at each point, so straight runs
 * cost almost nothing. Optional flat caps close both ends.
 */
export function tube(
  path: readonly THREE.Vector3[],
  radius: number,
  radialSegments: number,
  caps = true,
): THREE.BufferGeometry {
  const points = path.filter((p, i) => i === 0 || p.distanceToSquared(path[i - 1]) > 1e-10);
  const n = points.length;
  const ring = radialSegments;
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  if (n < 2) return new THREE.BufferGeometry();

  const tangents = points.map((_, i) =>
    new THREE.Vector3().subVectors(points[Math.min(n - 1, i + 1)], points[Math.max(0, i - 1)]).normalize(),
  );
  const normal = new THREE.Vector3().crossVectors(tangents[0], Math.abs(tangents[0].y) < 0.9 ? UP : RIGHT).normalize();
  const binormal = new THREE.Vector3();
  const dir = new THREE.Vector3();

  for (let i = 0; i < n; i++) {
    const t = tangents[i];
    if (i > 0) {
      // Parallel transport keeps the rings from twisting along the tube.
      normal.addScaledVector(t, -t.dot(normal));
      if (normal.lengthSq() < 1e-10) normal.crossVectors(t, Math.abs(t.y) < 0.9 ? UP : RIGHT);
      normal.normalize();
    }
    binormal.crossVectors(t, normal);
    for (let j = 0; j < ring; j++) {
      const a = (j / ring) * Math.PI * 2;
      dir.copy(normal).multiplyScalar(Math.cos(a)).addScaledVector(binormal, Math.sin(a));
      positions.push(points[i].x + dir.x * radius, points[i].y + dir.y * radius, points[i].z + dir.z * radius);
      normals.push(dir.x, dir.y, dir.z);
    }
  }
  for (let i = 0; i < n - 1; i++) {
    for (let j = 0; j < ring; j++) {
      const a = i * ring + j;
      const b = i * ring + ((j + 1) % ring);
      indices.push(a, b, a + ring, b, b + ring, a + ring);
    }
  }

  if (caps) {
    const cap = (i: number, sign: 1 | -1): void => {
      const t = tangents[i];
      const center = positions.length / 3;
      positions.push(points[i].x, points[i].y, points[i].z);
      normals.push(t.x * sign, t.y * sign, t.z * sign);
      for (let j = 0; j < ring; j++) {
        const k = (i * ring + j) * 3;
        positions.push(positions[k], positions[k + 1], positions[k + 2]);
        normals.push(t.x * sign, t.y * sign, t.z * sign);
      }
      for (let j = 0; j < ring; j++) {
        const a = center + 1 + j;
        const b = center + 1 + ((j + 1) % ring);
        if (sign > 0) indices.push(center, a, b);
        else indices.push(center, b, a);
      }
    };
    cap(0, -1);
    cap(n - 1, 1);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setIndex(indices);
  return geometry;
}

/** Marks a geometry or material as belonging to one object, so it is freed with it. */
export function owned<T extends THREE.BufferGeometry | THREE.Material>(resource: T): T {
  resource.userData.owned = true;
  return resource;
}

/** Frees the geometries and materials an object owns; shared, cached ones are left alone. */
export function disposeOwned(obj: THREE.Object3D): void {
  obj.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    if (o.geometry.userData.owned) o.geometry.dispose();
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) if (m.userData.owned) m.dispose();
  });
}

/**
 * A wire's centre line as a strip for drawing it as a ribbon that turns to face the camera (see
 * wireMaterial): each point twice, one for either edge, with the way the path runs there. Two
 * triangles a step instead of a tube's dozen, which a big circuit's wires add up to.
 */
export function ribbon(path: readonly THREE.Vector3[]): THREE.BufferGeometry {
  const points = path.filter((p, i) => i === 0 || p.distanceToSquared(path[i - 1]) > 1e-10);
  const n = points.length;
  if (n < 2) return new THREE.BufferGeometry();
  const position = new Float32Array(n * 6);
  const tangent = new Float32Array(n * 6);
  const side = new Float32Array(n * 2);
  const t = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    t.subVectors(points[Math.min(n - 1, i + 1)], points[Math.max(0, i - 1)]).normalize();
    for (let k = 0; k < 2; k++) {
      const v = i * 2 + k;
      position[v * 3] = points[i].x;
      position[v * 3 + 1] = points[i].y;
      position[v * 3 + 2] = points[i].z;
      tangent[v * 3] = t.x;
      tangent[v * 3 + 1] = t.y;
      tangent[v * 3 + 2] = t.z;
      side[v] = k ? 1 : -1;
    }
  }
  const index: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    const a = i * 2;
    index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(position, 3));
  g.setAttribute('aTangent', new THREE.BufferAttribute(tangent, 3));
  g.setAttribute('aSide', new THREE.BufferAttribute(side, 1));
  g.setIndex(index);
  return g;
}
