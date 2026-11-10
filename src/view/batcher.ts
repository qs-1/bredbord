// Draws every copy of the same piece (a 14-pin chip body, a red LED lens, a board...) in one
// instanced draw call, so a desk full of parts costs a handful of draw calls instead of hundreds.

import * as THREE from 'three';

/** One mesh-worth of a part: shared geometry and material, placed by a matrix. */
export interface Piece {
  /** Pieces with the same key share geometry and material and are drawn together. */
  key: string;
  geometry: THREE.BufferGeometry;
  material: THREE.Material | THREE.Material[];
  matrix: THREE.Matrix4;
}

export class InstanceBatcher {
  readonly group = new THREE.Group();
  private meshes: THREE.InstancedMesh[] = [];
  private layout = '';

  rebuild(pieces: Iterable<Piece>): void {
    const byKey = new Map<string, Piece[]>();
    for (const p of pieces) {
      const list = byKey.get(p.key);
      if (list) list.push(p);
      else byKey.set(p.key, [p]);
    }
    // Same pieces in different places (a knob turned, a button pressed): just move the instances.
    const layout = [...byKey].map(([key, list]) => `${key}:${list.length}`).join('|');
    if (layout === this.layout) {
      let i = 0;
      for (const list of byKey.values()) {
        const mesh = this.meshes[i++];
        list.forEach((p, k) => mesh.setMatrixAt(k, p.matrix));
        mesh.instanceMatrix.needsUpdate = true;
        mesh.computeBoundingSphere();
      }
      return;
    }
    this.layout = layout;
    for (const m of this.meshes) {
      this.group.remove(m);
      m.dispose();
    }
    this.meshes = [];
    for (const list of byKey.values()) {
      const { geometry, material } = list[0];
      const mesh = new THREE.InstancedMesh(geometry, material, list.length);
      list.forEach((p, i) => mesh.setMatrixAt(i, p.matrix));
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
      const transparent = (Array.isArray(material) ? material : [material]).some((m) => m.transparent);
      mesh.castShadow = true;
      mesh.receiveShadow = !transparent;
      // Boards go after the parts and wires on them, so the depth test skips what those cover
      // instead of shading it twice; the desk goes after the boards.
      if (list[0].key.startsWith('board-')) mesh.renderOrder = 0.5;
      this.group.add(mesh);
      this.meshes.push(mesh);
    }
  }
}

/** Separate meshes for a handful of pieces: used for placement previews. */
export function piecesToGroup(pieces: readonly Piece[]): THREE.Group {
  const group = new THREE.Group();
  for (const p of pieces) {
    const mesh = new THREE.Mesh(p.geometry, p.material);
    mesh.applyMatrix4(p.matrix);
    group.add(mesh);
  }
  return group;
}

/** World-space bounds of a set of pieces. */
export function piecesBounds(pieces: readonly Piece[]): THREE.Box3 {
  const box = new THREE.Box3();
  for (const p of pieces) {
    if (!p.geometry.boundingBox) p.geometry.computeBoundingBox();
    box.union(p.geometry.boundingBox!.clone().applyMatrix4(p.matrix));
  }
  return box;
}
