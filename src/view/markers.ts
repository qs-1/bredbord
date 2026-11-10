// Flat overlays on the board surface: the hole under the cursor, a wire's start, and every hole
// connected to the hovered one.

import * as THREE from 'three';
import { themed } from './materials';

const LIFT = 0.05;

export type MarkerTone = 'ok' | 'bad' | 'info';
/** Logic level shown on the connected holes while the power is on. */
export type NetLevel = 'none' | 'high' | 'low' | 'floating';

function flat(opacity: number): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    transparent: true,
    opacity,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -4,
  });
}

/** A square ring around a hole (RingGeometry radii are measured to the corners). */
const squareRing = (inner: number, outer: number): THREE.BufferGeometry =>
  new THREE.RingGeometry(inner, outer, 4, 1, Math.PI / 4).rotateX(-Math.PI / 2);

export class Markers {
  readonly group = new THREE.Group();
  private readonly hover = new THREE.Mesh(squareRing(1.05, 1.5));
  private readonly start = new THREE.Mesh(squareRing(0, 1.2), themed(flat(0.85), 'mark'));
  private readonly tones: Record<MarkerTone, THREE.Material> = {
    ok: themed(flat(1), 'mark'),
    bad: themed(flat(1), 'danger'),
    info: themed(flat(0.9), 'mark'),
  };
  private readonly netGeometry = squareRing(0.86, 1.14);
  private readonly netMaterials: Record<NetLevel, THREE.MeshBasicMaterial> = {
    none: themed(flat(0.5), 'mark'),
    high: Object.assign(flat(0.75), { color: new THREE.Color(0xef4444) }),
    low: Object.assign(flat(0.6), { color: new THREE.Color(0x334155) }),
    floating: Object.assign(flat(0.7), { color: new THREE.Color(0xf59e0b) }),
  };
  private level: NetLevel = 'none';
  private net: THREE.InstancedMesh;
  private readonly dummy = new THREE.Object3D();

  constructor() {
    this.net = this.makeNet(256);
    for (const m of [this.hover, this.start]) {
      m.visible = false;
      m.renderOrder = 5;
    }
    this.group.add(this.net, this.hover, this.start);
  }

  setHover(p: THREE.Vector3 | null, tone: MarkerTone): void {
    this.hover.visible = !!p;
    if (!p) return;
    this.hover.position.set(p.x, p.y + LIFT, p.z);
    this.hover.material = this.tones[tone];
  }

  setStart(p: THREE.Vector3 | null): void {
    this.start.visible = !!p;
    if (p) this.start.position.set(p.x, p.y + LIFT, p.z);
  }

  setNet(points: readonly THREE.Vector3[]): void {
    if (points.length > this.net.instanceMatrix.count) {
      this.group.remove(this.net);
      this.net.dispose();
      this.net = this.makeNet(2 ** Math.ceil(Math.log2(points.length)));
      this.group.add(this.net);
    }
    points.forEach((p, i) => {
      this.dummy.position.set(p.x, p.y + LIFT * 0.8, p.z);
      this.dummy.updateMatrix();
      this.net.setMatrixAt(i, this.dummy.matrix);
    });
    this.net.count = points.length;
    this.net.instanceMatrix.needsUpdate = true;
  }

  setLevel(level: NetLevel): void {
    this.level = level;
    this.net.material = this.netMaterials[level];
  }

  private makeNet(capacity: number): THREE.InstancedMesh {
    const mesh = new THREE.InstancedMesh(this.netGeometry, this.netMaterials[this.level], capacity);
    mesh.count = 0;
    mesh.renderOrder = 4;
    mesh.frustumCulled = false;
    return mesh;
  }
}

/** Channel colours for probes, in the order they're added. */
export const PROBE_COLORS = [0xf59e0b, 0x22c55e, 0x3b82f6, 0xec4899, 0xa855f7, 0x14b8a6, 0xef4444, 0x84cc16] as const;
export const MAX_PROBES = PROBE_COLORS.length;

const probeStem = new THREE.CylinderGeometry(0.22, 0.22, 11, 8).translate(0, 5.5, 0);
const probeHead = new THREE.SphereGeometry(1.15, 16, 12).translate(0, 11.6, 0);
const probeMaterials = PROBE_COLORS.map((color) => new THREE.MeshStandardMaterial({ color, roughness: 0.45 }));
const stemMaterial = new THREE.MeshStandardMaterial({ color: 0x9aa0a6, metalness: 0.6, roughness: 0.35 });

/** Little pins sticking up out of the probed holes, each in its channel's colour. */
export class ProbePins {
  readonly group = new THREE.Group();
  private key = '';

  set(points: readonly (THREE.Vector3 | null)[]): void {
    const key = points.map((p) => (p ? `${p.x},${p.z}` : '-')).join(';');
    if (key === this.key) return;
    this.key = key;
    this.group.clear();
    points.forEach((p, i) => {
      if (!p) return;
      const pin = new THREE.Group();
      pin.add(
        new THREE.Mesh(probeStem, stemMaterial),
        new THREE.Mesh(probeHead, probeMaterials[i % probeMaterials.length]),
      );
      pin.position.copy(p);
      pin.traverse((o) => (o.castShadow = true));
      this.group.add(pin);
    });
  }
}
