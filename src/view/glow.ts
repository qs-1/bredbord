// Light from things that are on. A lit LED keeps its glossy lens but glows from inside: an emissive
// body, a hot core where the chip is, a soft halo, and a pool of its colour on the board around it.
// Display segments light flat, the way a diffused segment does.

import * as THREE from 'three';
import { BOARD_HEIGHT as H } from '../engine/breadboard';
import { ledCoreGeometry, ledLensGeometry, litBarGeometry, litSegmentGeometry, powerLedGeometry } from './components';

export interface GlowItem {
  /** A 5 mm or 3 mm LED, a little surface-mount LED (power module, Nano), one segment of a display, or a display's halo. */
  kind: 'led' | 'small' | 'segment' | 'bar' | 'halo';
  /** Segment a–g, dp (0–7), for segments. */
  segment?: number;
  /** LED size, mm. */
  size?: number;
  /** The part's placement; the lens and segment geometry are in the part's own frame. */
  matrix: THREE.Matrix4;
  color: number;
  /** 0..1 */
  level: number;
  /** World position of the middle of the light. */
  center: THREE.Vector3;
}

/** Brightness steps lit lenses are drawn in; each step is its own material. */
const STEPS = 6;
const WHITE = new THREE.Color(0xffffff);

/**
 * Soft round light, many at once in one draw: each instance's matrix gives its centre and size,
 * and its colour is already scaled by how bright it is. Billboarded ones always face the camera
 * (halos); flat ones lie on the board (the colour a light throws around it).
 */
function softLight(billboard: boolean): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    defines: billboard ? { BILLBOARD: '' } : {},
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      varying vec3 vColor;
      void main() {
        vUv = uv;
        vColor = instanceColor;
        #ifdef BILLBOARD
          vec4 center = modelViewMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
          center.xy += position.xy * length(instanceMatrix[0].xyz);
          gl_Position = projectionMatrix * center;
        #else
          gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
        #endif
      }`,
    fragmentShader: /* glsl */ `
      varying vec2 vUv;
      varying vec3 vColor;
      void main() {
        float d = min(1.0, length(vUv - 0.5) * 2.0);
        // Bright middle falling away smoothly to nothing at the edge.
        float a = (1.0 - d) * (1.0 - d) * (0.55 + 0.45 * exp(-12.0 * d * d));
        gl_FragColor = vec4(vColor * a, a);
      }`,
    transparent: true,
    depthWrite: false,
    // Light adds to what's behind it; colours arrive already scaled by brightness.
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneFactor,
    toneMapped: false,
  });
}

const haloMaterial = softLight(true);
const spillMaterial = softLight(false);
const haloGeometry = new THREE.PlaneGeometry(1, 1);

const lensMaterials = new Map<string, THREE.MeshStandardMaterial>();
/** A glossy lens glowing in its colour at a given brightness step. */
function litLens(color: number, step: number): THREE.MeshStandardMaterial {
  const key = `${color}-${step}`;
  let m = lensMaterials.get(key);
  if (!m) {
    const c = new THREE.Color(color);
    m = new THREE.MeshStandardMaterial({
      color: c.clone().multiplyScalar(0.7),
      emissive: c,
      emissiveIntensity: 0.9 + (2.1 * step) / STEPS,
      roughness: 0.12,
      transparent: true,
      opacity: 0.95,
      toneMapped: false,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    });
    lensMaterials.set(key, m);
  }
  return m;
}

const spillGeometry = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
const dummy = new THREE.Object3D();

export class Glow {
  readonly group = new THREE.Group();
  private parts: THREE.Object3D[] = [];
  private readonly flat = new THREE.MeshBasicMaterial({
    toneMapped: false,
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -4,
  });
  private readonly core = new THREE.MeshBasicMaterial({ toneMapped: false, transparent: true, depthWrite: false });

  update(items: readonly GlowItem[]): void {
    for (const o of this.parts) {
      this.group.remove(o);
      if (o instanceof THREE.InstancedMesh) o.dispose();
    }
    this.parts = [];
    const lit = items.filter((i) => i.level > 0.02);
    const color = new THREE.Color();
    const add = (o: THREE.Object3D, order: number): void => {
      o.renderOrder = order;
      this.group.add(o);
      this.parts.push(o);
    };
    const instanced = (
      geometry: THREE.BufferGeometry,
      material: THREE.Material,
      list: GlowItem[],
      tint?: (item: GlowItem) => THREE.Color,
    ): void => {
      if (!list.length) return;
      const mesh = new THREE.InstancedMesh(geometry, material, list.length);
      list.forEach((item, i) => {
        mesh.setMatrixAt(i, item.matrix);
        if (tint) mesh.setColorAt(i, tint(item));
      });
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
      add(mesh, 6);
    };

    // 5 mm and 3 mm lenses, grouped by colour and brightness step so each group shares a material.
    const leds = lit.filter((i) => i.kind === 'led');
    const groups = new Map<string, GlowItem[]>();
    for (const item of leds) {
      const key = `${item.size ?? 5}|${item.color}|${Math.max(1, Math.round(item.level * STEPS))}`;
      const list = groups.get(key);
      if (list) list.push(item);
      else groups.set(key, [item]);
    }
    for (const [key, list] of groups) {
      const [size, hex, step] = key.split('|').map(Number);
      instanced(ledLensGeometry(size), litLens(hex, step), list);
    }
    for (const size of [5, 3]) {
      instanced(
        ledCoreGeometry(size),
        this.core,
        leds.filter((i) => (i.size ?? 5) === size),
        (item) =>
          color
            .setHex(item.color)
            .lerp(WHITE, 0.2 + 0.25 * item.level)
            .multiplyScalar(0.5 + 0.5 * item.level),
      );
    }
    const small = lit.filter((i) => i.kind === 'small');
    for (const hex of new Set(small.map((i) => i.color)))
      instanced(
        powerLedGeometry(),
        litLens(hex, STEPS),
        small.filter((i) => i.color === hex),
      );
    for (let s = 0; s < 8; s++) {
      instanced(
        litSegmentGeometry(s),
        this.flat,
        lit.filter((i) => i.kind === 'segment' && i.segment === s),
        (item) =>
          color
            .setHex(item.color)
            .multiplyScalar(0.55 + 0.6 * item.level)
            .lerp(WHITE, 0.2 * item.level),
      );
    }

    instanced(
      litBarGeometry(),
      this.flat,
      lit.filter((i) => i.kind === 'bar'),
      (item) =>
        color
          .setHex(item.color)
          .multiplyScalar(0.45 + 0.55 * item.level)
          .lerp(WHITE, 0.12 * item.level),
    );

    // A soft halo around each light, and its colour thrown onto the board around it.
    const halos: [THREE.Vector3, number, THREE.Color][] = [];
    const spills: [THREE.Vector3, number, THREE.Color][] = [];
    for (const item of lit) {
      if (item.kind === 'segment' || item.kind === 'bar') continue;
      const scale = item.kind === 'led' ? (item.size ?? 5) / 5 : 1;
      const size = (item.kind === 'small' ? 7 : item.kind === 'halo' ? 26 : 19) * scale * (0.75 + 0.25 * item.level);
      halos.push([
        item.center,
        size,
        new THREE.Color(item.color).multiplyScalar(
          (item.kind === 'halo' ? 0.2 : item.kind === 'small' ? 0.26 : 0.38) * item.level,
        ),
      ]);
      if (item.kind === 'small') continue;
      const reach = (item.kind === 'halo' ? 30 : 18) * scale;
      spills.push([
        new THREE.Vector3(item.center.x, H + 0.06, item.center.z),
        reach,
        new THREE.Color(item.color).multiplyScalar(0.34 * item.level),
      ]);
    }
    this.lights(haloGeometry, haloMaterial, halos, 7, add);
    this.lights(spillGeometry, spillMaterial, spills, 5, add);
  }

  private lights(
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    list: [THREE.Vector3, number, THREE.Color][],
    order: number,
    add: (o: THREE.Object3D, order: number) => void,
  ): void {
    if (!list.length) return;
    const mesh = new THREE.InstancedMesh(geometry, material, list.length);
    list.forEach(([at, size, color], i) => {
      dummy.position.copy(at);
      dummy.scale.setScalar(size);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      mesh.setColorAt(i, color);
    });
    // Billboards reach out of their own bounds, so never cull them.
    mesh.frustumCulled = false;
    add(mesh, order);
  }
}
