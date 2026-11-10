// A bench power supply on the desk: a light case with a dark front panel, a display of volts and
// amps side by side, and along the bottom the binding posts, the output light and the two knobs.
// Labels sit above what they name: anything sticking out of the panel hides what's below it when
// the supply is seen from above.

import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { canvasFont } from '../fonts';
import type { Id, SupplyDoc } from '../engine/circuit';
import { boxObstacle, type Obstacle } from './routing';
import {
  SUPPLY_MAX_AMPS,
  SUPPLY_MAX_VOLTS,
  SUPPLY_SIZE as S,
  SUPPLY_TERMINALS,
  type TerminalName,
} from '../engine/supply';

const FRONT = S.z / 2;
/** Corner radius of the case. */
const CASE_R = 4.5;
// Front panel positions are x across from the centre and y up from the desk, mm.
/** Knob centres on the front panel. */
export const SUPPLY_KNOBS = { volts: { x: 8, y: 18 }, limit: { x: 27, y: 18 } } as const;
export type SupplyKnob = keyof typeof SUPPLY_KNOBS;
const KNOB_R = 6.3;
const KNOB_DEPTH = 7;

/**
 * What wires keep out of: the case with room over its vents, and the knobs sticking out of the front.
 * The binding posts stay open, since leads clip on to them.
 */
export function supplyObstacles(doc: { x: number; z: number }): Obstacle[] {
  const { x, z } = doc;
  const knobs = Object.values(SUPPLY_KNOBS).map((k) =>
    boxObstacle(
      x + k.x - KNOB_R - 0.4,
      x + k.x + KNOB_R + 0.4,
      z + FRONT,
      z + FRONT + KNOB_DEPTH + 1,
      k.y + KNOB_R + 0.4,
      k.y - KNOB_R - 0.4,
    ),
  );
  return [boxObstacle(x - S.x / 2, x + S.x / 2, z - S.z / 2, z + S.z / 2, S.y + 6, 0), ...knobs];
}

/** Knob travel, either side of straight up. */
const SWEEP = (135 * Math.PI) / 180;
/** Scale ticks around each knob: where they start, and how far the long and short ones reach. */
const TICK = { from: KNOB_R + 1.1, major: KNOB_R + 2.6, minor: KNOB_R + 1.9 };
const DISPLAY = { x: 0, y: 40.5, w: 66, h: 12 };
const LED_AT = { x: -6, y: 18 };
/** The panel on the flat of the case front, clear of its rounded edges. */
const PANEL = { w: S.x - 2 * CASE_R - 2, h: S.y - 2 * CASE_R - 2, y: S.y / 2 + 2, r: 3 };
const PX = 10;

/** What the display shows. */
export interface SupplyShown {
  /** Output on: actual readings. Off: the settings, dimmed. */
  on: boolean;
  volts: number;
  amps: number;
  /** Holding its current at the limit: the light turns red, and so does the current. */
  cc: boolean;
}

const caseMaterial = new THREE.MeshStandardMaterial({ color: 0xdedcd6, roughness: 0.55 });
const footMaterial = new THREE.MeshStandardMaterial({ color: 0x1d1e20, roughness: 0.9 });
const ventMaterial = new THREE.MeshStandardMaterial({ color: 0xa9a7a1, roughness: 0.8 });
const knobMaterial = new THREE.MeshStandardMaterial({ color: 0xc9ccd1, metalness: 0.85, roughness: 0.32 });
const knobCapMaterial = new THREE.MeshStandardMaterial({ color: 0xb8bcc2, metalness: 0.9, roughness: 0.22 });
const markMaterial = new THREE.MeshBasicMaterial({ color: 0x24262a });
const postMetal = new THREE.MeshStandardMaterial({ color: 0xd6c48a, metalness: 1, roughness: 0.3 });
const postRed = new THREE.MeshStandardMaterial({ color: 0xc8262b, roughness: 0.4 });
const postBlack = new THREE.MeshStandardMaterial({ color: 0x1b1c1f, roughness: 0.4 });
const ledOff = new THREE.MeshStandardMaterial({ color: 0x2c3a2f, roughness: 0.3 });
const ledOn = new THREE.MeshBasicMaterial({ color: 0x4dff88, toneMapped: false });
const ledCc = new THREE.MeshBasicMaterial({ color: 0xff4a3d, toneMapped: false });
const glassMaterial = new THREE.MeshStandardMaterial({
  color: 0x0b0c0d,
  roughness: 0.08,
  metalness: 0.2,
  transparent: true,
  opacity: 0.35,
});

let shared: {
  body: THREE.BufferGeometry;
  panel: THREE.BufferGeometry;
  panelMaterial: THREE.MeshStandardMaterial;
  foot: THREE.BufferGeometry;
  vent: THREE.BufferGeometry;
  knob: THREE.BufferGeometry;
  knobCap: THREE.BufferGeometry;
  mark: THREE.BufferGeometry;
  postBase: THREE.BufferGeometry;
  postCap: THREE.BufferGeometry;
  postStud: THREE.BufferGeometry;
  led: THREE.BufferGeometry;
  screen: THREE.BufferGeometry;
} | null = null;

/** The front panel's printing: knob scales, labels, and a frame around the display. */
function panelTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = PANEL.w * PX;
  canvas.height = PANEL.h * PX;
  const g = canvas.getContext('2d')!;
  const X = (x: number): number => (x + PANEL.w / 2) * PX;
  const Y = (y: number): number => (PANEL.y + PANEL.h / 2 - y) * PX;
  g.fillStyle = '#26282c';
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.fillStyle = '#9ca1a8';
  g.strokeStyle = '#6f747b';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  const font = (weight: number, mm: number): string => canvasFont('label', weight, mm * PX);
  for (const [name, at] of Object.entries(SUPPLY_KNOBS)) {
    // A scale of ticks around each knob, its name above it.
    for (let k = 0; k <= 20; k++) {
      const a = -SWEEP + (2 * SWEEP * k) / 20;
      const r0 = TICK.from * PX;
      const r1 = (k % 5 === 0 ? TICK.major : TICK.minor) * PX;
      g.lineWidth = k % 5 === 0 ? 4 : 2.5;
      g.beginPath();
      g.moveTo(X(at.x) + Math.sin(a) * r0, Y(at.y) - Math.cos(a) * r0);
      g.lineTo(X(at.x) + Math.sin(a) * r1, Y(at.y) - Math.cos(a) * r1);
      g.stroke();
    }
    g.font = font(600, 2.2);
    g.fillText(name === 'volts' ? 'VOLTAGE' : 'CURRENT', X(at.x), Y(at.y + TICK.major + 1.7));
  }
  g.font = font(700, 3.4);
  g.fillStyle = '#e35a5e';
  g.fillText('+', X(SUPPLY_TERMINALS['+'].x), Y(SUPPLY_TERMINALS['+'].y + 7));
  g.fillStyle = '#9ca1a8';
  g.fillText('−', X(SUPPLY_TERMINALS['-'].x), Y(SUPPLY_TERMINALS['-'].y + 7));
  g.font = font(600, 2.1);
  g.fillText('CV/CC', X(LED_AT.x), Y(LED_AT.y + 4.4));
  // A raised frame around the display.
  g.fillStyle = '#1a1b1e';
  const pad = 1.4;
  g.beginPath();
  g.roundRect(
    X(DISPLAY.x - DISPLAY.w / 2 - pad),
    Y(DISPLAY.y + DISPLAY.h / 2 + pad),
    (DISPLAY.w + 2 * pad) * PX,
    (DISPLAY.h + 2 * pad) * PX,
    1.6 * PX,
  );
  g.fill();
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/** The front panel: a rounded rectangle, its UVs spanning the printed texture. */
function panelGeometry(): THREE.BufferGeometry {
  const { w, h, r } = PANEL;
  const shape = new THREE.Shape();
  shape.moveTo(-w / 2 + r, -h / 2);
  shape.lineTo(w / 2 - r, -h / 2);
  shape.quadraticCurveTo(w / 2, -h / 2, w / 2, -h / 2 + r);
  shape.lineTo(w / 2, h / 2 - r);
  shape.quadraticCurveTo(w / 2, h / 2, w / 2 - r, h / 2);
  shape.lineTo(-w / 2 + r, h / 2);
  shape.quadraticCurveTo(-w / 2, h / 2, -w / 2, h / 2 - r);
  shape.lineTo(-w / 2, -h / 2 + r);
  shape.quadraticCurveTo(-w / 2, -h / 2, -w / 2 + r, -h / 2);
  const geometry = new THREE.ShapeGeometry(shape, 8);
  // A shape's UVs are its own millimetres: bring them to 0..1.
  const pos = geometry.attributes.position;
  const uv = geometry.attributes.uv;
  for (let i = 0; i < pos.count; i++) uv.setXY(i, pos.getX(i) / w + 0.5, pos.getY(i) / h + 0.5);
  return geometry.translate(0, PANEL.y, FRONT + 0.05);
}

function geometries(): NonNullable<typeof shared> {
  if (shared) return shared;
  // A knurled knob: a slightly fluted cylinder with a polished cap.
  const knob = new THREE.CylinderGeometry(KNOB_R, KNOB_R * 1.04, KNOB_DEPTH, 48, 1);
  const pos = knob.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    const r = Math.hypot(x, z);
    if (r < KNOB_R * 0.9) continue;
    const a = Math.atan2(z, x);
    const k = 1 + 0.025 * Math.cos(a * 24);
    pos.setXYZ(i, x * k, pos.getY(i), z * k);
  }
  knob.computeVertexNormals();
  knob.rotateX(Math.PI / 2).translate(0, 0, KNOB_DEPTH / 2);
  shared = {
    body: new RoundedBoxGeometry(S.x, S.y, S.z, 5, CASE_R).translate(0, S.y / 2 + 2, 0),
    panel: panelGeometry(),
    panelMaterial: new THREE.MeshStandardMaterial({ map: panelTexture(), roughness: 0.62 }),
    foot: new THREE.CylinderGeometry(5, 5.5, 2, 20).translate(0, 1, 0),
    vent: new THREE.BoxGeometry(S.x * 0.42, 0.3, 1.1),
    knob,
    knobCap: new THREE.CylinderGeometry(KNOB_R * 0.82, KNOB_R * 0.82, 0.6, 40)
      .rotateX(Math.PI / 2)
      .translate(0, 0, KNOB_DEPTH + 0.1),
    mark: new THREE.BoxGeometry(0.9, KNOB_R * 0.55, 0.3).translate(0, KNOB_R * 0.48, KNOB_DEPTH + 0.45),
    postBase: new THREE.CylinderGeometry(3.9, 4.3, 3.4, 6).rotateX(Math.PI / 2).translate(0, 0, 1.7),
    postStud: new THREE.CylinderGeometry(1.4, 1.4, 5, 16).rotateX(Math.PI / 2).translate(0, 0, 5),
    postCap: new THREE.CylinderGeometry(3.4, 3.6, 3.6, 24).rotateX(Math.PI / 2).translate(0, 0, 6.4),
    led: new THREE.SphereGeometry(1.2, 16, 10),
    screen: new THREE.PlaneGeometry(DISPLAY.w, DISPLAY.h),
  };
  return shared;
}

/** One supply on the desk, with its live display. */
class SupplyModel {
  readonly group = new THREE.Group();
  private readonly canvas = document.createElement('canvas');
  private readonly screen: THREE.CanvasTexture;
  private readonly knobs: Record<SupplyKnob, THREE.Group>;
  private readonly led: THREE.Mesh;
  private shownKey = '';
  key = '';

  constructor() {
    const g = geometries();
    const add = (
      geometry: THREE.BufferGeometry,
      material: THREE.Material,
      parent: THREE.Object3D = this.group,
    ): THREE.Mesh => {
      const mesh = new THREE.Mesh(geometry, material);
      mesh.castShadow = mesh.receiveShadow = true;
      parent.add(mesh);
      return mesh;
    };
    add(g.body, caseMaterial);
    add(g.panel, g.panelMaterial);
    for (const [x, z] of [
      [-1, -1],
      [1, -1],
      [-1, 1],
      [1, 1],
    ])
      add(g.foot, footMaterial).position.set(x * (S.x / 2 - 9), 0, z * (S.z / 2 - 10));
    for (let k = 0; k < 8; k++) add(g.vent, ventMaterial).position.set(0, S.y + 2.0, -S.z / 2 + 22 + k * 4.5);

    this.canvas.width = DISPLAY.w * PX;
    this.canvas.height = DISPLAY.h * PX;
    this.screen = new THREE.CanvasTexture(this.canvas);
    this.screen.colorSpace = THREE.SRGBColorSpace;
    const screen = new THREE.Mesh(g.screen, new THREE.MeshBasicMaterial({ map: this.screen, toneMapped: false }));
    screen.position.set(DISPLAY.x, DISPLAY.y, FRONT + 0.15);
    this.group.add(screen);
    const glass = new THREE.Mesh(g.screen, glassMaterial);
    glass.position.set(DISPLAY.x, DISPLAY.y, FRONT + 0.3);
    this.group.add(glass);

    const knob = (at: { x: number; y: number }): THREE.Group => {
      const k = new THREE.Group();
      add(g.knob, knobMaterial, k);
      add(g.knobCap, knobCapMaterial, k);
      add(g.mark, markMaterial, k);
      k.position.set(at.x, at.y, FRONT);
      this.group.add(k);
      return k;
    };
    this.knobs = { volts: knob(SUPPLY_KNOBS.volts), limit: knob(SUPPLY_KNOBS.limit) };

    for (const name of ['+', '-'] as TerminalName[]) {
      const t = SUPPLY_TERMINALS[name];
      const post = new THREE.Group();
      add(g.postBase, name === '+' ? postRed : postBlack, post);
      add(g.postStud, postMetal, post);
      add(g.postCap, name === '+' ? postRed : postBlack, post);
      post.position.set(t.x, t.y, FRONT);
      this.group.add(post);
    }
    this.led = add(g.led, ledOff);
    this.led.position.set(LED_AT.x, LED_AT.y, FRONT + 0.4);
  }

  place(doc: SupplyDoc): void {
    this.group.position.set(doc.x, 0, doc.z);
    this.knobs.volts.rotation.z = -(-SWEEP + (2 * SWEEP * doc.volts) / SUPPLY_MAX_VOLTS);
    this.knobs.limit.rotation.z = -(-SWEEP + (2 * SWEEP * doc.limit) / SUPPLY_MAX_AMPS);
  }

  show(shown: SupplyShown): void {
    const key = `${shown.on}|${shown.volts.toFixed(2)}|${shown.amps.toFixed(3)}|${shown.cc}`;
    if (key === this.shownKey) return;
    this.shownKey = key;
    this.led.material = !shown.on ? ledOff : shown.cc ? ledCc : ledOn;
    const g = this.canvas.getContext('2d')!;
    const w = this.canvas.width;
    const h = this.canvas.height;
    g.fillStyle = '#0c0e0d';
    g.fillRect(0, 0, w, h);
    // Each reading right-aligned in its half, its unit after it.
    const reading = (text: string, unit: string, end: number, color: string): void => {
      g.textBaseline = 'middle';
      g.textAlign = 'right';
      g.font = canvasFont('mono', 600, 7.4 * PX);
      g.fillStyle = color;
      g.fillText(text, end - 4.6 * PX, h / 2 + 0.3 * PX);
      g.font = canvasFont('label', 600, 3.4 * PX);
      g.textAlign = 'left';
      g.fillText(unit, end - 3.8 * PX, h / 2 + 1.3 * PX);
    };
    g.fillStyle = '#1b201e';
    g.fillRect(w / 2 - 1, h * 0.2, 2, h * 0.6);
    const dim = shown.on ? 1 : 0.45;
    const volts = shown.volts < 10 ? `${shown.volts.toFixed(2)}` : shown.volts.toFixed(1);
    reading(volts, 'V', w / 2, `rgba(94, 232, 196, ${dim})`);
    reading(shown.amps.toFixed(3), 'A', w, shown.cc ? '#ff5a52' : `rgba(255, 184, 77, ${dim})`);
    this.screen.needsUpdate = true;
  }

  dispose(): void {
    this.screen.dispose();
    for (const child of this.group.children) {
      if (
        child instanceof THREE.Mesh &&
        child.material instanceof THREE.MeshBasicMaterial &&
        child.material.map === this.screen
      )
        child.material.dispose();
    }
  }
}

export interface SupplyHit {
  id: Id;
  /** What was hit: a knob, or the case. */
  on: SupplyKnob | 'case';
  point: THREE.Vector3;
  distance: number;
}

/** Every supply on the desk. */
export class SupplyLayer {
  readonly group = new THREE.Group();
  private models = new Map<Id, SupplyModel>();
  private docs: SupplyDoc[] = [];

  update(supplies: readonly SupplyDoc[]): void {
    this.docs = supplies.slice();
    const next = new Map<Id, SupplyModel>();
    for (const doc of supplies) {
      let model = this.models.get(doc.id);
      if (!model) {
        model = new SupplyModel();
        model.show({ on: false, volts: doc.volts, amps: doc.limit, cc: false });
        this.group.add(model.group);
      }
      model.place(doc);
      next.set(doc.id, model);
    }
    for (const [id, model] of this.models) {
      if (next.has(id)) continue;
      this.group.remove(model.group);
      model.dispose();
    }
    this.models = next;
  }

  show(id: Id, shown: SupplyShown): void {
    this.models.get(id)?.show(shown);
  }

  /** The supply under the ray, and which knob if it's on one. */
  pick(ray: THREE.Ray): SupplyHit | null {
    let best: SupplyHit | null = null;
    const hit = new THREE.Vector3();
    for (const doc of this.docs) {
      const box = new THREE.Box3(
        new THREE.Vector3(doc.x - S.x / 2, 0, doc.z - S.z / 2),
        new THREE.Vector3(doc.x + S.x / 2, S.y + 2, doc.z + FRONT + KNOB_DEPTH),
      );
      if (!ray.intersectBox(box, hit)) continue;
      const distance = hit.distanceTo(ray.origin);
      if (best && distance >= best.distance) continue;
      let on: SupplyHit['on'] = 'case';
      // Knobs stick out of the front: test the plane through their faces.
      const face = ray.intersectPlane(
        new THREE.Plane(new THREE.Vector3(0, 0, 1), -(doc.z + FRONT + KNOB_DEPTH * 0.6)),
        new THREE.Vector3(),
      );
      if (face) {
        for (const [name, at] of Object.entries(SUPPLY_KNOBS) as [SupplyKnob, { x: number; y: number }][]) {
          if (Math.hypot(face.x - (doc.x + at.x), face.y - at.y) < KNOB_R + 1) on = name;
        }
      }
      best = { id: doc.id, on, point: hit.clone(), distance };
    }
    return best;
  }

  /** Grows `box` to take in every supply, or just `only`. */
  expand(box: THREE.Box3, only?: SupplyDoc): void {
    for (const doc of only ? [only] : this.docs) {
      box.expandByPoint(new THREE.Vector3(doc.x - S.x / 2, 0, doc.z - S.z / 2));
      box.expandByPoint(new THREE.Vector3(doc.x + S.x / 2, S.y, doc.z + FRONT + 10));
    }
  }
}

/** A supply on its own, for the parts panel picture. */
export function supplyPreview(): THREE.Group {
  const model = new SupplyModel();
  model.place({ id: '', x: 0, z: 0, volts: 5, limit: 1 });
  model.show({ on: true, volts: 5, amps: 0.25, cc: false });
  return model.group;
}
