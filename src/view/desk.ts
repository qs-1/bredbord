// The desk: a cutting mat under everything, covering most of the screen. It's flat and the light
// never moves, so how a point of it is lit depends only on which way it's seen from and whether
// it's in shadow. Both are worked out ahead of time with three's own lighting (the shadows each
// time the shadow map is redrawn, the light from every direction it can be seen from when the
// theme changes) and each pixel looks them up: little more work than drawing the texture alone.

import * as THREE from 'three';
import type { Theme } from './materials';
import { deskTexture } from './textures';

const SIZE = 6000;
const ROUGHNESS = 0.94;

// ---- shadows ----

// three's PCF shadow takes 5 hardware 2×2 compares on a disc of shadowRadius texels, turned a
// random way per pixel. Averaged over the turns, that's about a 2×2 compare at each corner of a
// texel-wide square around the point: the same blur without the grain, at 4 lookups per texel.
const TAPS = ['vec2(-0.5, -0.5)', 'vec2(0.5, -0.5)', 'vec2(-0.5, 0.5)', 'vec2(0.5, 0.5)'];

const QUAD_VERTEX = /* glsl */ `
void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

// For each shadow-map texel, how much light reaches the point of the desk it looks at.
const SHADOW_FRAGMENT = /* glsl */ `
uniform sampler2DShadow uShadowMap;
uniform mat4 uFromShadow;
uniform vec2 uSize;
uniform float uPlaneY;
uniform float uBias;
uniform float uRadius;
uniform float uIntensity;
const vec2 TAPS[${TAPS.length}] = vec2[](${TAPS.join(', ')});
void main() {
  vec2 uv = gl_FragCoord.xy / uSize;
  vec4 a = uFromShadow * vec4(uv, 0.0, 1.0);
  vec4 b = uFromShadow * vec4(0.0, 0.0, 1.0, 0.0);
  float z = (uPlaneY - a.y) / b.y + uBias;
  float shadow = 1.0;
  if (z <= 1.0) {
    vec2 radius = uRadius / uSize;
    shadow = 0.0;
    for (int i = 0; i < ${TAPS.length}; i++) shadow += texture(uShadowMap, vec3(uv + TAPS[i] * radius, z));
    shadow /= ${TAPS.length}.0;
  }
  gl_FragColor = vec4(mix(1.0, shadow, uIntensity));
}
`;

// ---- light ----

/** Viewing directions along each side of the lighting table. */
const TABLE = 64;

// A direction off the desk ↔ a place in the table: the top half of an octahedral map, turned 45°
// to fill the square. The table holds two squares side by side: the diffuse light per unit of the
// desk's colour, then the specular light; rgb is the light that shadows don't touch, a the key
// light's share.
const TABLE_GLSL = /* glsl */ `
const float DESK_TABLE = ${TABLE}.0;
vec2 deskViewToTable(vec3 v) {
  vec2 p = v.xz / (abs(v.x) + abs(v.y) + abs(v.z));
  return vec2(p.x + p.y, p.x - p.y) * 0.5 + 0.5;
}
vec3 deskTableToView(vec2 t) {
  vec2 q = t * 2.0 - 1.0;
  vec2 p = vec2(q.x + q.y, q.x - q.y) * 0.5;
  return normalize(vec3(p.x, max(0.0, 1.0 - abs(p.x) - abs(p.y)), p.y));
}
`;

/** Layers that only the passes drawing the shadow map and the lighting table see. */
const SHADOW_LAYER = 31;

/** How far above the desk its shadows are looked up from, in mm: just clear of a board's foot resting on it. */
const DESK_SHADOW_LIFT = 0.05;
const LIGHT_LAYER = 30;

export class Desk {
  readonly mesh: THREE.Mesh;
  private readonly material = new THREE.MeshBasicMaterial();
  // No mipmaps, like the shadow map itself: they'd fade thin shadows (along a board's foot) seen at a glancing angle.
  private readonly shadowTarget = new THREE.WebGLRenderTarget(1, 1, {
    format: THREE.RedFormat,
    depthBuffer: false,
    generateMipmaps: false,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
  });
  private readonly lightTarget: THREE.WebGLRenderTarget;
  /** What the shadow-map-only pass draws into: nothing. */
  private readonly scratch = new THREE.WebGLRenderTarget(1, 1, { depthBuffer: false });
  private readonly shadowMaterial = new THREE.ShaderMaterial({
    vertexShader: QUAD_VERTEX,
    fragmentShader: SHADOW_FRAGMENT,
    uniforms: {
      uShadowMap: { value: null },
      uFromShadow: { value: new THREE.Matrix4() },
      uSize: { value: new THREE.Vector2() },
      uPlaneY: { value: 0 },
      uBias: { value: 0 },
      uRadius: { value: 1 },
      uIntensity: { value: 1 },
    },
    depthTest: false,
    depthWrite: false,
  });
  private readonly shadowScene = new THREE.Scene();
  private readonly quadCamera = new THREE.Camera();
  private readonly shadowCamera = new THREE.PerspectiveCamera();
  private readonly lightCamera = new THREE.PerspectiveCamera();
  private readonly uniforms: Record<string, THREE.IUniform>;
  private lightStale = true;

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    private readonly key: THREE.DirectionalLight,
    fill: THREE.HemisphereLight,
  ) {
    const ext = renderer.extensions;
    this.lightTarget = new THREE.WebGLRenderTarget(2 * TABLE, TABLE, {
      // The light is all under 1, so where half floats can't be drawn into, bytes lose little.
      type:
        ext.has('EXT_color_buffer_float') || ext.has('EXT_color_buffer_half_float')
          ? THREE.HalfFloatType
          : THREE.UnsignedByteType,
      depthBuffer: false,
      generateMipmaps: false,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
    });

    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.shadowMaterial);
    quad.frustumCulled = false;
    this.shadowScene.add(quad);

    key.layers.enable(SHADOW_LAYER);
    this.shadowCamera.layers.set(SHADOW_LAYER);
    // A shadow camera on layer 0 alone draws what the viewing camera sees, which here is nothing;
    // on another layer too, it draws everything on its own layers.
    key.shadow.camera.layers.enable(SHADOW_LAYER);

    key.layers.enable(LIGHT_LAYER);
    fill.layers.enable(LIGHT_LAYER);
    this.lightCamera.layers.set(LIGHT_LAYER);
    const table = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.tableMaterial());
    table.frustumCulled = false;
    table.layers.set(LIGHT_LAYER);

    this.uniforms = {
      uDeskShadow: { value: this.shadowTarget.texture },
      uDeskLight: { value: this.lightTarget.texture },
      uShadowMatrix: { value: key.shadow.matrix },
      uShadowLift: { value: key.shadow.normalBias },
    };
    this.material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.uniforms);
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
          uniform mat4 uShadowMatrix;
          uniform float uShadowLift;
          varying vec3 vDeskWorld;
          varying vec4 vDeskShadow;`,
        )
        .replace(
          '#include <fog_vertex>',
          `#include <fog_vertex>
          vDeskWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
          // three looks a surface's shadow up from a point lifted off it by the normal bias.
          vDeskShadow = uShadowMatrix * vec4(vDeskWorld + vec3(0.0, uShadowLift, 0.0), 1.0);`,
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
          ${TABLE_GLSL}
          uniform sampler2D uDeskShadow;
          uniform sampler2D uDeskLight;
          varying vec3 vDeskWorld;
          varying vec4 vDeskShadow;`,
        )
        .replace(
          'vec3 outgoingLight = reflectedLight.indirectDiffuse;',
          `vec2 shadowUv = vDeskShadow.xy / vDeskShadow.w;
          float shadow = shadowUv.x < 0.0 || shadowUv.x > 1.0 || shadowUv.y < 0.0 || shadowUv.y > 1.0 ? 1.0 : texture2D(uDeskShadow, shadowUv).r;
          vec2 place = deskViewToTable(normalize(cameraPosition - vDeskWorld)) * (DESK_TABLE - 1.0) + 0.5;
          vec4 diffuseLight = texture2D(uDeskLight, place / vec2(2.0 * DESK_TABLE, DESK_TABLE));
          vec4 specularLight = texture2D(uDeskLight, (place + vec2(DESK_TABLE, 0.0)) / vec2(2.0 * DESK_TABLE, DESK_TABLE));
          vec3 outgoingLight = diffuseColor.rgb * (diffuseLight.rgb + shadow * diffuseLight.a) + specularLight.rgb + shadow * specularLight.a;`,
        );
    };
    this.material.customProgramCacheKey = () => 'desk';

    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(SIZE, SIZE).rotateX(-Math.PI / 2), this.material);
    // Drawn after the boards and parts on it, so the depth test skips what they hide instead of shading it twice.
    this.mesh.renderOrder = 1;
    scene.add(this.mesh, table);
  }

  setTheme(theme: Theme): void {
    this.material.map = deskTexture(theme);
    this.material.needsUpdate = true;
    this.lightStale = true;
  }

  /** Brings the desk's shadows and light up to date. Call before each render. */
  prepare(scene: THREE.Scene): void {
    const r = this.renderer;
    if (!r.shadowMap.needsUpdate && !this.lightStale) return;
    const previous = r.getRenderTarget();
    if (r.shadowMap.needsUpdate) this.bakeShadows(scene);
    if (this.lightStale) {
      this.lightStale = false;
      r.setRenderTarget(this.lightTarget);
      r.render(scene, this.lightCamera);
    }
    r.setRenderTarget(previous);
  }

  /** Redraws the shadow map, then the desk's shadows from it. */
  private bakeShadows(scene: THREE.Scene): void {
    const r = this.renderer;
    const shadow = this.key.shadow;
    // Draws only the shadow map: nothing but the key light is on the camera's layer.
    r.setRenderTarget(this.scratch);
    r.render(scene, this.shadowCamera);
    const depth = shadow.map?.depthTexture;
    if (!depth) return;
    const size = shadow.mapSize;
    if (this.shadowTarget.width !== size.x || this.shadowTarget.height !== size.y)
      this.shadowTarget.setSize(size.x, size.y);
    const u = this.shadowMaterial.uniforms;
    u.uShadowMap.value = depth;
    u.uFromShadow.value.copy(shadow.matrix).invert();
    u.uSize.value.copy(size);
    // The light's own biases (about 1 mm between them) keep parts from shadowing themselves in specks,
    // but on the desk they'd leave a lit strip along the foot of every board. The desk is flat and its
    // depth here is exact, so it's looked up from just above it, with no bias.
    u.uPlaneY.value = DESK_SHADOW_LIFT;
    u.uBias.value = 0;
    u.uRadius.value = shadow.radius;
    u.uIntensity.value = shadow.intensity;
    this.uniforms.uShadowLift.value = DESK_SHADOW_LIFT;
    r.setRenderTarget(this.shadowTarget);
    r.render(this.shadowScene, this.quadCamera);
  }

  /**
   * three's own lit material, drawn over the lighting table: each texel lights a flat, white,
   * unshadowed piece of desk seen from the direction it stands for, and keeps the parts.
   */
  private tableMaterial(): THREE.MeshStandardMaterial {
    const material = new THREE.MeshStandardMaterial({ roughness: ROUGHNESS });
    material.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader.replace(
        '#include <project_vertex>',
        '#include <project_vertex>\ngl_Position = vec4(position.xy, 0.0, 1.0);',
      );
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\n${TABLE_GLSL}`)
        .replace(
          '#include <normal_fragment_begin>',
          `#include <normal_fragment_begin>
          normal = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
          nonPerturbedNormal = normal;`,
        )
        .replace(
          '#include <lights_fragment_begin>',
          THREE.ShaderChunk.lights_fragment_begin.replace(
            'vec3 geometryViewDir = ( isOrthographic ) ? vec3( 0, 0, 1 ) : normalize( vViewPosition );',
            `vec2 tableTexel = floor(gl_FragCoord.xy);
            tableTexel.x = mod(tableTexel.x, DESK_TABLE);
            vec3 geometryViewDir = normalize((viewMatrix * vec4(deskTableToView(tableTexel / (DESK_TABLE - 1.0)), 0.0)).xyz);`,
          ),
        )
        .replace(
          '#include <dithering_fragment>',
          `#include <dithering_fragment>
          gl_FragColor = gl_FragCoord.x < DESK_TABLE
            ? vec4(reflectedLight.indirectDiffuse, reflectedLight.directDiffuse.g)
            : vec4(reflectedLight.indirectSpecular, reflectedLight.directSpecular.g);`,
        );
    };
    material.customProgramCacheKey = () => 'desk-light-table';
    return material;
  }
}
