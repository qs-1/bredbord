// Shared materials, colours and the light/dark palette used inside the 3D view.

import * as THREE from 'three';
import type { WireColor } from '../engine/circuit';
import type { LedColor } from '../engine/parts';
import { WIRE_RADIUS } from './routing';

export type Theme = 'light' | 'dark';
/** `accent` tints what's selected or being placed (a warm grey, like the chrome); `mark` is the ink for its edges and hole markers. */
type Role = 'accent' | 'mark' | 'danger';

const PALETTES: Record<Theme, Record<Role, number>> = {
  light: { accent: 0x57524a, mark: 0x1f1d1a, danger: 0xd2402f },
  dark: { accent: 0xc8f169, mark: 0x16201b, danger: 0xf0846f },
};

/** Current highlight colours. Short-lived materials read these when they are made. */
export const palette: Record<Role, number> = { ...PALETTES.light };

const themedMaterials: { material: { color: THREE.Color }; role: Role }[] = [];

/** Registers a long-lived material whose colour follows the theme. */
export function themed<M extends { color: THREE.Color }>(material: M, role: Role): M {
  material.color.setHex(palette[role]);
  themedMaterials.push({ material, role });
  return material;
}

export function applyPalette(theme: Theme): void {
  Object.assign(palette, PALETTES[theme]);
  for (const t of themedMaterials) t.material.color.setHex(palette[t.role]);
}

export const WIRE_HEX: Readonly<Record<WireColor, number>> = {
  red: 0xd3343f,
  black: 0x2a2c30,
  blue: 0x2a62cf,
  yellow: 0xe9bd34,
  green: 0x2c9a52,
  white: 0xe6e6e1,
  orange: 0xe8772d,
  purple: 0x7a52d1,
};

export const LED_HEX: Readonly<Record<LedColor, number>> = {
  red: 0xff2d2d,
  green: 0x2bd65a,
  yellow: 0xffcf2e,
  blue: 0x2f7dff,
  white: 0xeef4ff,
};

/** Where the key light shines from: it never moves. */
export const LIGHT_DIRECTION = new THREE.Vector3(-150, 330, 210).normalize();

// ---- wires drawn as ribbons ----
// A wire is a flat strip along its centre line that the vertex shader turns to face the camera,
// as wide as the wire, and the fragment shader gives a round wire's normal across it: it shades
// like a round wire at any zoom for a fraction of a tube's triangles. In the shadow pass the strip
// turns to face the light instead, so it casts a wire-wide shadow.

/** Radius of the wire a ribbon draws, mm (the same as routing's WIRE_RADIUS). */
const RIBBON_RADIUS = WIRE_RADIUS;

const RIBBON_HEAD = /* glsl */ `
attribute vec3 aTangent;
attribute float aSide;
uniform float uWireRadius;
uniform vec3 uWireToLight;
varying float vAcross;
varying vec3 vSideView;
// Towards the eye from a point: an orthographic camera (the light's, drawing shadows) looks one way everywhere.
vec3 wireToEye(vec3 p) {
  return isOrthographic ? normalize(vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2])) : normalize(cameraPosition - p);
}
// Across the wire, square to it and to the eye: the way its edges go.
vec3 wireAcross(vec3 eye) {
  vec3 t = normalize(aTangent);
  vec3 s = cross(t, eye);
  if (dot(s, s) < 1e-8) s = cross(t, abs(t.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0));
  return normalize(s);
}
`;

/** The wire meshes are never moved, so a point's model space is world space. */
function ribbonUniforms(shader: THREE.WebGLProgramParametersWithUniforms): void {
  shader.uniforms.uWireRadius = { value: RIBBON_RADIUS };
  shader.uniforms.uWireToLight = { value: LIGHT_DIRECTION };
  shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\n' + RIBBON_HEAD);
}

function asRibbon(material: THREE.MeshStandardMaterial): THREE.MeshStandardMaterial {
  material.side = THREE.DoubleSide;
  material.onBeforeCompile = (shader) => {
    ribbonUniforms(shader);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <beginnormal_vertex>',
        `vec3 wireEye = wireToEye((modelMatrix * vec4(position, 1.0)).xyz);
        vec3 wireSide = wireAcross(wireEye);
        vec3 objectNormal = wireEye;`,
      )
      .replace(
        '#include <begin_vertex>',
        `vec3 transformed = position + wireSide * (aSide * uWireRadius);
        vAcross = aSide;
        vSideView = normalize((viewMatrix * vec4(wireSide, 0.0)).xyz);`,
      )
      // Each point looks up its shadow from just outside the wire on the light's side, so the
      // strip isn't shadowed by the wire it stands for.
      .replace(
        '#include <shadowmap_vertex>',
        '#ifdef USE_SHADOWMAP\nworldPosition.xyz += uWireToLight * (uWireRadius * 1.1);\n#endif\n#include <shadowmap_vertex>',
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vAcross;\nvarying vec3 vSideView;')
      .replace(
        '#include <normal_fragment_begin>',
        `#include <normal_fragment_begin>
        {
          float u = clamp(vAcross, -1.0, 1.0);
          normal = normalize(normalize(vSideView) * u + normalize(vViewPosition) * sqrt(max(0.0, 1.0 - u * u)));
          nonPerturbedNormal = normal;
        }`,
      );
  };
  material.customProgramCacheKey = () => 'wire-ribbon';
  return material;
}

/** What a ribbon puts in the shadow map: the strip, turned to face the light. */
export const ribbonDepthMaterial = new THREE.MeshDepthMaterial();
ribbonDepthMaterial.onBeforeCompile = (shader) => {
  ribbonUniforms(shader);
  shader.vertexShader = shader.vertexShader.replace(
    '#include <begin_vertex>',
    `vec3 transformed = position + wireAcross(wireToEye((modelMatrix * vec4(position, 1.0)).xyz)) * (aSide * uWireRadius);`,
  );
};
ribbonDepthMaterial.customProgramCacheKey = () => 'wire-ribbon-depth';

const ribbons = new Map<WireColor | 'levels', THREE.MeshStandardMaterial>();
const tubes = new Map<WireColor | 'levels', THREE.MeshStandardMaterial>();

/**
 * A wire's insulation, as a ribbon (see ribbon in geometry.ts) or a round tube. 'levels' is
 * coloured by its vertices instead: every wire at once, each in the colour of the level it carries.
 */
export function wireMaterial(color: WireColor | 'levels', ribbon: boolean): THREE.MeshStandardMaterial {
  const cache = ribbon ? ribbons : tubes;
  let m = cache.get(color);
  if (!m) {
    m = new THREE.MeshStandardMaterial(
      color === 'levels'
        ? { vertexColors: true, roughness: 0.42, metalness: 0 }
        : { color: WIRE_HEX[color], roughness: 0.42, metalness: 0 },
    );
    cache.set(color, ribbon ? asRibbon(m) : m);
  }
  return m;
}

export const tinMaterial = new THREE.MeshStandardMaterial({ color: 0xc4c8ce, metalness: 1, roughness: 0.32 });
export const epoxyMaterial = new THREE.MeshStandardMaterial({ color: 0x1e1f22, roughness: 0.55 });

// Pulled a little toward the camera, so a ghost over a part already there is drawn on top of it
// rather than flickering through it.
const ghostLook = {
  transparent: true,
  opacity: 0.45,
  depthWrite: false,
  roughness: 0.6,
  polygonOffset: true,
  polygonOffsetFactor: -1,
  polygonOffsetUnits: -4,
};
const ghostOk = themed(new THREE.MeshStandardMaterial(ghostLook), 'accent');
const ghostBad = themed(new THREE.MeshStandardMaterial(ghostLook), 'danger');

/** Turns an object into a translucent placement preview: accent if it fits, red if it doesn't. */
export function ghostify(obj: THREE.Object3D, valid: boolean): void {
  obj.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) if (m.userData.owned) m.dispose();
    o.material = valid ? ghostOk : ghostBad;
    o.castShadow = false;
    o.receiveShadow = false;
    o.renderOrder = 2;
  });
}
