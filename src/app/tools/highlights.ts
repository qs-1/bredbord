// What the tools draw over the scene: soft boxes round what's selected and what's under the pointer,
// handles on a selected wire's bends and a selected part's legs, the ghost of what's being placed, and a
// glow on the legs whose pins are pointed at on the card.
// Each is rebuilt only when what it shows changes.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { BOARD_HEIGHT as H, boardSpec, SEAM_Z, type BoardType } from '../../engine/breadboard';
import type { Id } from '../../engine/circuit';
import { clippedTo, detachable } from '../../engine/rails';
import { disposeOwned, owned } from '../../view/geometry';
import { palette } from '../../view/materials';
import type { View } from '../../view/view';
import type { SceneSync } from '../scene-sync';
import type { Store } from '../store';

/** Room between a part's body and the box drawn round it. */
const PART_PAD = 0.35;
/** How see-through the box round a selected part is: its grey sides, and its ink edges. */
const SELECTED = { fill: 0.1, edge: 0.9 };
const HOVERED = { fill: 0.04, edge: 0.4 };
/** The glow on a leg pointed at in the card's pin list: amber, round the leg from the hole up past a DIP's shoulder. */
const PIN_GLOW = { color: 0xf59e0b, radius: 0.85, height: 2.4 };

/** Something drawn over the scene, and what it was drawn from. */
interface Slot {
  key: string;
  obj: THREE.Object3D | null;
}

/** A translucent shell and its edges, from boxes merged into one mesh each. */
function boxShell(boxes: readonly THREE.Box3[], look: { fill: number; edge: number }): THREE.Group {
  const shells: THREE.BufferGeometry[] = [];
  const lines: THREE.BufferGeometry[] = [];
  for (const b of boxes) {
    const size = b.getSize(new THREE.Vector3());
    const c = b.getCenter(new THREE.Vector3());
    const g = new THREE.BoxGeometry(size.x, size.y, size.z).translate(c.x, c.y, c.z);
    lines.push(new THREE.EdgesGeometry(g));
    shells.push(g);
  }
  const shell = new THREE.Mesh(
    owned(mergeGeometries(shells)!),
    owned(
      new THREE.MeshBasicMaterial({ color: palette.accent, transparent: true, opacity: look.fill, depthWrite: false }),
    ),
  );
  const outline = new THREE.LineSegments(
    owned(mergeGeometries(lines)!),
    owned(new THREE.LineBasicMaterial({ color: palette.mark, transparent: true, opacity: look.edge })),
  );
  for (const g of [...shells, ...lines]) g.dispose();
  shell.renderOrder = outline.renderOrder = 3;
  const group = new THREE.Group();
  group.add(shell, outline);
  return group;
}

export class Highlights {
  private readonly selected: Slot = { key: '', obj: null };
  private readonly hovered: Slot = { key: '', obj: null };
  private readonly group: Slot = { key: '', obj: null };
  private readonly handles: Slot = { key: '', obj: null };
  private readonly preview: Slot = { key: '', obj: null };
  private readonly pins: Slot = { key: '', obj: null };

  constructor(
    private readonly view: View,
    private readonly store: Store,
    private readonly sync: SceneSync,
  ) {}

  /** Rebuilds everything next time, in the theme's new colours. */
  restyle(): void {
    this.selected.key = this.hovered.key = this.group.key = '\0';
  }

  /** Boxes round the selected thing, the thing under the pointer, and every part of a selected group. */
  setBoxes(selected: Id | '', hovered: Id | '', group: readonly Id[]): void {
    this.setBox(this.selected, selected, SELECTED);
    this.setBox(this.hovered, hovered, HOVERED);
    const layout = this.sync.layoutVersion;
    this.replace(this.group, `${group.join(',')}@${layout}`, () => {
      const boxes = group.flatMap((id) => {
        const box = this.sync.partOutline(id);
        if (!box) return [];
        box.expandByScalar(PART_PAD);
        box.min.y = Math.max(box.min.y, H + 0.05);
        return [box];
      });
      return boxes.length ? boxShell(boxes, SELECTED) : null;
    });
  }

  /** Handles to drag: on a selected wire's bends, or (smaller, so side-by-side legs' don't run together) on a part's legs. */
  setHandles(points: readonly THREE.Vector3[], small: boolean): void {
    const key = points.map((p) => `${p.x},${p.y},${p.z}`).join(';');
    this.replace(this.handles, key, () => {
      if (!points.length) return null;
      const group = new THREE.Group();
      const geometry = owned(new THREE.SphereGeometry(small ? 0.75 : 1.15, 16, 10));
      const fill = owned(new THREE.MeshBasicMaterial({ color: palette.accent, depthTest: false }));
      const ring = owned(new THREE.MeshBasicMaterial({ color: palette.mark, depthTest: false }));
      for (const p of points) {
        const outer = new THREE.Mesh(geometry, ring);
        outer.position.copy(p);
        outer.scale.setScalar(1.25);
        const inner = new THREE.Mesh(geometry, fill);
        inner.position.copy(p);
        outer.renderOrder = 8;
        inner.renderOrder = 9;
        group.add(outer, inner);
      }
      return group;
    });
  }

  /**
   * Amber glow round the legs whose pins are pointed at on the card's pin list. Each leg gets a
   * see-through column from the hole up past its shoulder, and a fainter copy drawn over everything,
   * so a leg on the far side of a chip still shows through the body.
   */
  setPins(points: readonly THREE.Vector3[]): void {
    const key = points.map((p) => `${p.x},${p.y},${p.z}`).join(';');
    this.replace(this.pins, key, () => {
      if (!points.length) return null;
      const group = new THREE.Group();
      const geometry = owned(new THREE.CylinderGeometry(PIN_GLOW.radius, PIN_GLOW.radius, PIN_GLOW.height, 20));
      const ring = owned(new THREE.RingGeometry(PIN_GLOW.radius, PIN_GLOW.radius + 0.45, 32).rotateX(-Math.PI / 2));
      const glow = (opacity: number, depthTest: boolean): THREE.MeshBasicMaterial =>
        owned(
          new THREE.MeshBasicMaterial({
            color: PIN_GLOW.color,
            transparent: true,
            opacity,
            depthTest,
            depthWrite: false,
          }),
        );
      const front = glow(0.65, true);
      const behind = glow(0.28, false);
      const halo = glow(0.9, true);
      for (const p of points) {
        for (const [material, order] of [
          [behind, 6],
          [front, 7],
        ] as const) {
          const column = new THREE.Mesh(geometry, material);
          column.position.set(p.x, p.y + PIN_GLOW.height / 2 - 0.1, p.z);
          column.renderOrder = order;
          group.add(column);
        }
        const flat = new THREE.Mesh(ring, halo);
        flat.position.set(p.x, p.y + 0.06, p.z);
        flat.renderOrder = 7;
        group.add(flat);
      }
      return group;
    });
  }

  /** The ghost of what's being placed, moved or pasted; `make` is only called when `key` changes. */
  setPreview(key: string, make: (() => THREE.Object3D) | null): void {
    this.replace(this.preview, key, () => make?.() ?? null);
  }

  private replace(slot: Slot, key: string, make: () => THREE.Object3D | null): void {
    if (slot.key === key) return;
    slot.key = key;
    if (slot.obj) {
      this.view.overlay.remove(slot.obj);
      disposeOwned(slot.obj);
      slot.obj = null;
    }
    slot.obj = make();
    if (slot.obj) this.view.overlay.add(slot.obj);
  }

  /** A soft box around a selected or hovered part, board or instrument. */
  private setBox(slot: Slot, id: Id | '', look: { fill: number; edge: number }): void {
    // Nothing drawn for something that should have a box (its model wasn't built yet): try again.
    if (id && !slot.obj) slot.key = '';
    this.replace(slot, `${id}@${this.sync.layoutVersion}`, () => {
      if (!id) return null;
      const pieces = this.boardPieces(id);
      if (pieces) return this.pieceBoxes(pieces, look);
      const part = this.sync.partOutline(id);
      const box =
        part ??
        this.sync.supplyBounds(id) ??
        this.sync.meterBounds(id) ??
        this.sync.scopeBounds(id) ??
        this.sync.boardBounds(id);
      if (!box) return null;
      // A part's box hugs its body; anything else gets a little more room. Nothing dips below the
      // board's surface (or the desk).
      box.expandByScalar(part ? PART_PAD : 0.7);
      box.min.y = part ? Math.max(box.min.y, H + 0.05) : Math.max(box.min.y, 0.05);
      return boxShell([box], look);
    });
  }

  /**
   * The separate pieces of a board, on the desk: its rails and its body, whether the rails are still
   * on it or clipped back on. Null for a board in one piece.
   */
  private boardPieces(id: Id): THREE.Box3[] | null {
    const doc = this.store.doc;
    const b = doc.boards.find((x) => x.id === id);
    if (!b) return null;
    const box = (x: number, z: number, type: BoardType, z0?: number, z1?: number): THREE.Box3 => {
      const s = boardSpec(type);
      return new THREE.Box3(
        new THREE.Vector3(x - s.length / 2, 0, z + (z0 ?? -s.width / 2)),
        new THREE.Vector3(x + s.length / 2, H, z + (z1 ?? s.width / 2)),
      );
    };
    if (detachable(b.type)) {
      const w = boardSpec(b.type).width / 2;
      return [
        box(b.x, b.z, b.type, -w, -SEAM_Z),
        box(b.x, b.z, b.type, -SEAM_Z, SEAM_Z),
        box(b.x, b.z, b.type, SEAM_Z, w),
      ];
    }
    const rails = clippedTo(doc, id);
    return rails.length ? [b, ...rails].map((o) => box(o.x, o.z, o.type)) : null;
  }

  /** A selection box round each piece of a board, with a gap where two pieces meet so each reads as its own. */
  private pieceBoxes(pieces: readonly THREE.Box3[], look: { fill: number; edge: number }): THREE.Group {
    const OUT = 0.7;
    const IN = 0.35;
    const touches = (a: THREE.Box3, axis: 'x' | 'z', side: 'min' | 'max'): boolean => {
      const cross = axis === 'x' ? 'z' : 'x';
      const at = a[side][axis];
      return pieces.some(
        (o) =>
          o !== a &&
          Math.abs(o[side === 'min' ? 'max' : 'min'][axis] - at) < 0.05 &&
          Math.min(a.max[cross], o.max[cross]) - Math.max(a.min[cross], o.min[cross]) > 1,
      );
    };
    const boxes = pieces.map((p) => {
      const b = p.clone();
      for (const axis of ['x', 'z'] as const) {
        b.min[axis] += touches(p, axis, 'min') ? IN : -OUT;
        b.max[axis] += touches(p, axis, 'max') ? -IN : OUT;
      }
      b.min.y = 0.05;
      b.max.y += OUT;
      return b;
    });
    return boxShell(boxes, look);
  }
}
