// 3D models of the components: chips, LEDs, resistors, capacitors, diodes, switches, knobs, displays.
// Each is described as pieces (shared geometry + material + a placement matrix) built in a local
// frame with x along the part and y up from the board surface, then placed from its pin holes.

import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { BOARD_HEIGHT as H, PITCH } from '../engine/breadboard';
import {
  capacitorCode,
  formatFarads,
  NANO_PIN_NAMES,
  ohmsCode,
  type BarGraphDef,
  type CapacitorDef,
  type DiodeDef,
  type DipDef,
  type LedColor,
  type LedDef,
  type NetworkDef,
  type PartDef,
  type PowerSide,
  type TransistorDef,
  powerJumper,
} from '../engine/parts';
import { piecesToGroup, type Piece } from './batcher';
import { roundCorners, tube } from './geometry';
import { epoxyMaterial, LED_HEX, tinMaterial } from './materials';
import {
  capacitorCodeTexture,
  chipTopTexture,
  diodeTexture,
  dipSwitchTexture,
  electrolyticTexture,
  nanoTopTexture,
  networkTexture,
  resistorTexture,
  transistorTexture,
} from './textures';
import { boxObstacle, capsuleObstacle, discObstacle, type Obstacle } from './routing';

type V = THREE.Vector3;

const HOLE_DEPTH = 3.2;

const centroid = (pins: readonly V[]): V =>
  pins.reduce((acc, p) => acc.add(p), new THREE.Vector3()).divideScalar(pins.length);
const midpoint = (a: V, b: V): V => a.clone().add(b).multiplyScalar(0.5);

/** Turns local +x towards `to` (seen from `from`) and puts the origin on the board surface at `center`. */
function placement(from: V, to: V, center: V): THREE.Matrix4 {
  return new THREE.Matrix4()
    .makeRotationY(Math.atan2(-(to.z - from.z), to.x - from.x))
    .setPosition(center.x, H, center.z);
}

const cache = new Map<string, THREE.BufferGeometry>();
function cached(key: string, make: () => THREE.BufferGeometry): THREE.BufferGeometry {
  let g = cache.get(key);
  if (!g) cache.set(key, (g = make()));
  return g;
}

// ---- DIP chips ----

const SEAT = 0.6;
const BODY_H = 3.3;
const CHIP_TOP = SEAT + BODY_H;

export function chipSize(def: DipDef): { length: number; width: number; span: number } {
  return { length: (def.pins / 2) * PITCH + 0.8, width: def.wide ? 13.2 : 6.35, span: (def.wide ? 6 : 3) * PITCH };
}

const decalMaterials = new Map<string, THREE.Material>();
function decalMaterial(def: DipDef, length: number, width: number): THREE.Material {
  let m = decalMaterials.get(def.id);
  if (!m) {
    m = new THREE.MeshStandardMaterial({
      map: chipTopTexture(def.label, length - 0.9, width - 0.9),
      roughness: 0.55,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    decalMaterials.set(def.id, m);
  }
  return m;
}

/** Gull-wing DIP legs: a tab out of the body, a wide shoulder, then the narrow pin into the hole. */
function chipLegs(def: DipDef): THREE.BufferGeometry {
  return cached(`legs-${def.pins}-${def.wide}`, () => {
    const { width, span } = chipSize(def);
    const n = def.pins / 2;
    const half = width / 2;
    const tabLen = span / 2 - half + 0.2;
    const parts: THREE.BufferGeometry[] = [];
    for (let i = 0; i < n; i++) {
      const x = (i - (n - 1) / 2) * PITCH;
      for (const side of [1, -1]) {
        const z = (side * span) / 2;
        parts.push(
          new THREE.BoxGeometry(0.55, 0.26, tabLen).translate(x, 1.75, side * (half - 0.2 + tabLen / 2)),
          new THREE.BoxGeometry(1.25, 1.5, 0.26).translate(x, 1.1, z),
          new THREE.BoxGeometry(0.48, HOLE_DEPTH + 0.6, 0.26).translate(x, (0.6 - HOLE_DEPTH) / 2, z),
        );
      }
    }
    return mergeGeometries(parts)!;
  });
}

function chipPieces(def: DipDef, pins: readonly V[]): Piece[] {
  const { length, width } = chipSize(def);
  const matrix = placement(pins[0], pins[def.pins / 2 - 1], centroid(pins));
  const size = `${length}-${width}`;
  return [
    {
      key: `chip-body-${size}`,
      geometry: cached(`chip-body-${size}`, () =>
        new RoundedBoxGeometry(length, BODY_H, width, 2, 0.42).translate(0, SEAT + BODY_H / 2, 0),
      ),
      material: epoxyMaterial,
      matrix,
    },
    {
      key: `chip-decal-${def.id}`,
      geometry: cached(`chip-decal-${size}`, () =>
        new THREE.PlaneGeometry(length - 0.9, width - 0.9).rotateX(-Math.PI / 2).translate(0, CHIP_TOP + 0.01, 0),
      ),
      material: decalMaterial(def, length, width),
      matrix,
    },
    { key: `chip-legs-${def.pins}-${def.wide}`, geometry: chipLegs(def), material: tinMaterial, matrix },
  ];
}

// ---- LEDs ----

const LED_BASE = 4.2;
/**
 * A 5 mm and a 3 mm LED: flange radius, body radius, and the straight part above the flange. The
 * 3 mm one is drawn a touch slim, so a row of them fits side by side in neighbouring holes, as
 * they do on a real board.
 */
const LED_SHAPES: Record<number, { flange: number; body: number; straight: number }> = {
  5: { flange: 2.53, body: 2.36, straight: 4.34 },
  3: { flange: 1.26, body: 1.2, straight: 2.6 },
};
const ledShape = (size: number): { flange: number; body: number; straight: number } =>
  LED_SHAPES[size] ?? LED_SHAPES[5];
const ledTop = (size: number): number => LED_BASE + 1 + ledShape(size).straight + ledShape(size).body;

function ledBody(size: number): THREE.BufferGeometry {
  return cached(`led-body-${size}`, () => {
    const s = ledShape(size);
    const shoulder = LED_BASE + 1 + s.straight;
    const pts = [
      new THREE.Vector2(0, LED_BASE),
      new THREE.Vector2(s.flange, LED_BASE),
      new THREE.Vector2(s.flange, LED_BASE + 1),
      new THREE.Vector2(s.body, LED_BASE + 1.05),
      new THREE.Vector2(s.body, shoulder),
    ];
    for (let i = 1; i <= 6; i++) {
      const a = (i / 6) * (Math.PI / 2);
      pts.push(new THREE.Vector2(s.body * Math.cos(a), shoulder + s.body * Math.sin(a)));
    }
    return new THREE.LatheGeometry(pts, 20);
  });
}

/**
 * Two legs from holes `span` mm apart up into a body whose legs are a pitch apart, bent outwards
 * near the board when the holes are further apart, the way you'd bend an LED to reach a rail.
 */
function bentLegs(key: string, span: number, top: number, radius: number, gap = PITCH): THREE.BufferGeometry {
  return cached(`${key}-${span.toFixed(2)}-${gap}`, () => {
    const leg = (sign: number): THREE.BufferGeometry => {
      const foot = (sign * span) / 2;
      const body = (sign * gap) / 2;
      const points =
        Math.abs(foot - body) < 0.01
          ? [new THREE.Vector3(foot, -HOLE_DEPTH, 0), new THREE.Vector3(foot, top, 0)]
          : roundCorners(
              [
                new THREE.Vector3(foot, -HOLE_DEPTH, 0),
                new THREE.Vector3(foot, 0.9, 0),
                new THREE.Vector3(body, Math.min(top - 0.5, 0.9 + Math.min(2.2, Math.abs(foot - body))), 0),
                new THREE.Vector3(body, top, 0),
              ],
              0.7,
              4,
            );
      return tube(points, radius, 6, false);
    };
    return mergeGeometries([leg(-1), leg(1)])!;
  });
}

const legSpan = (pins: readonly V[]): number => Math.hypot(pins[1].x - pins[0].x, pins[1].z - pins[0].z);

function ledLegs(span: number, size: number): THREE.BufferGeometry {
  const top = LED_BASE + 1.6;
  if (size !== 3) return bentLegs('led-legs', span, top, 0.24);
  // The 3 mm body is narrower than the pitch, so its legs meet it inside its edge: bent in from
  // further holes in one go, or from neighbouring holes stepped in just under it.
  const inside = ledShape(3).body - 0.5;
  if (span > PITCH + 0.01) return bentLegs('led-legs', span, top, 0.24, inside * 2);
  return cached(`led-legs-3-${span.toFixed(2)}`, () => {
    const leg = (sign: number): THREE.BufferGeometry => {
      const foot = (sign * span) / 2;
      const points = [
        new THREE.Vector3(foot, -HOLE_DEPTH, 0),
        new THREE.Vector3(foot, LED_BASE - 1.2, 0),
        new THREE.Vector3(sign * inside, LED_BASE - 0.2, 0),
        new THREE.Vector3(sign * inside, top, 0),
      ];
      return tube(roundCorners(points, 0.5, 4), 0.24, 6, false);
    };
    return mergeGeometries([leg(-1), leg(1)])!;
  });
}

/** The reflector cup (cathode) and post (anode) you can see through the lens. */
function ledInner(size: number): THREE.BufferGeometry {
  const k = size === 3 ? 0.62 : 1;
  return cached(`led-inner-${size}`, () =>
    mergeGeometries([
      new THREE.BoxGeometry(1.2 * k, 1.7 * k, 0.55 * k).translate(0.55 * k, LED_BASE + 1 + 1.45 * k, 0),
      new THREE.BoxGeometry(0.45 * k, 2.3 * k, 0.45 * k).translate(-0.75 * k, LED_BASE + 1 + 1.05 * k, 0),
    ])!,
  );
}

const lensMaterials = new Map<LedColor, THREE.Material>();
function lensMaterial(color: LedColor): THREE.Material {
  let m = lensMaterials.get(color);
  if (!m) {
    // Unlit, a coloured lens looks much deeper than the colour it glows, so on and off read at a glance.
    const c = new THREE.Color(LED_HEX[color]).multiplyScalar(color === 'white' ? 0.7 : 0.28);
    m = new THREE.MeshStandardMaterial({ color: c, roughness: 0.22, transparent: true, opacity: 0.88 });
    lensMaterials.set(color, m);
  }
  return m;
}

function ledPieces(def: LedDef, pins: readonly V[], size: number): Piece[] {
  const matrix = placement(pins[0], pins[1], midpoint(pins[0], pins[1]));
  const span = legSpan(pins);
  return [
    { key: `led-legs-${size}-${span.toFixed(2)}`, geometry: ledLegs(span, size), material: tinMaterial, matrix },
    { key: `led-inner-${size}`, geometry: ledInner(size), material: tinMaterial, matrix },
    { key: `led-lens-${def.color}-${size}`, geometry: ledBody(size), material: lensMaterial(def.color), matrix },
  ];
}

// ---- resistors ----

const RES_AXIS = 1.5;
const RES_LEN = 6.3;

/** Holes closer than this leave no room for an axial part to lie between them, so it stands up instead. */
const STAND_SPAN = 3 * PITCH - 0.01;
/** Height of the bottom of a standing axial part's body. */
const STAND_BASE = 1;
/** Height of the hairpin bend over a standing body `half` mm half-long. */
const standTop = (half: number): number => STAND_BASE + 2 * half + 1.2;

/**
 * Leads of an axial part standing on the first of two holes `span` mm apart: one straight up into
 * its body, the other up past the top and bent back down into it, a hairpin.
 */
function standingLeads(span: number, half: number, radius: number): THREE.BufferGeometry {
  return cached(`standing-leads-${span.toFixed(2)}-${half}-${radius}`, () => {
    const x = -span / 2;
    const top = standTop(half);
    const near = tube(
      [new THREE.Vector3(x, -HOLE_DEPTH, 0), new THREE.Vector3(x, STAND_BASE + 0.3, 0)],
      radius,
      6,
      false,
    );
    const far = tube(
      roundCorners(
        [
          new THREE.Vector3(-x, -HOLE_DEPTH, 0),
          new THREE.Vector3(-x, top, 0),
          new THREE.Vector3(x, top, 0),
          new THREE.Vector3(x, STAND_BASE + 2 * half - 0.3, 0),
        ],
        Math.min(0.9, span / 3),
        5,
      ),
      radius,
      6,
      false,
    );
    return mergeGeometries([near, far])!;
  });
}

/** Dog-bone profile of a carbon-film body: rounded tips, bulging end caps, slimmer middle. */
function resistorRadius(t: number): number {
  const e = Math.min(t, 1 - t);
  if (e < 0.02) return 0.45 + (e / 0.02) * 0.6;
  if (e < 0.1) return 1.05 + Math.sin(((e - 0.02) / 0.08) * (Math.PI / 2)) * 0.2;
  if (e < 0.2) return 1.25 - ((e - 0.1) / 0.1) * 0.2;
  return 1.05;
}

/** A resistor's body along y, centred on the origin. */
function resistorLathe(): THREE.BufferGeometry {
  return cached('resistor-lathe', () => {
    // Points only where the outline changes, at the ends: the middle is a plain cylinder.
    const ends = [0, 0.02, 0.04, 0.06, 0.08, 0.1, 0.2];
    const along = [
      ...ends,
      ...ends
        .slice()
        .reverse()
        .map((e) => 1 - e),
    ];
    const pts = [
      new THREE.Vector2(0, -RES_LEN / 2),
      ...along.map((t) => new THREE.Vector2(resistorRadius(t), (t - 0.5) * RES_LEN)),
      new THREE.Vector2(0, RES_LEN / 2),
    ];
    const body = new THREE.LatheGeometry(pts, 16);
    // The colour bands run along the body: map them by length, not by which outline point it is.
    const pos = body.attributes.position;
    const uv = body.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setY(i, pos.getY(i) / RES_LEN + 0.5);
    return body;
  });
}

function resistorBody(): THREE.BufferGeometry {
  return cached('resistor-body', () =>
    resistorLathe()
      .clone()
      .rotateZ(-Math.PI / 2)
      .translate(0, RES_AXIS, 0),
  );
}

/**
 * Both leads of an axial part, bent down into holes `span` mm apart, reaching `inner` mm either side
 * of the middle at height `axis`. Spans repeat (grid distances), so these cache well.
 */
function axialLeads(span: number, inner = RES_LEN / 2 - 0.3, axis = RES_AXIS, radius = 0.27): THREE.BufferGeometry {
  return cached(`axial-leads-${span.toFixed(2)}-${inner}-${axis}-${radius}`, () => {
    const lead = (sign: number) =>
      tube(
        roundCorners(
          [
            new THREE.Vector3((sign * span) / 2, -HOLE_DEPTH, 0),
            new THREE.Vector3((sign * span) / 2, axis, 0),
            new THREE.Vector3(sign * inner, axis, 0),
          ],
          0.9,
          5,
        ),
        radius,
        6,
        false,
      );
    return mergeGeometries([lead(-1), lead(1)])!;
  });
}

const resistorMaterials = new Map<number, THREE.Material>();
function resistorMaterial(ohms: number): THREE.Material {
  let m = resistorMaterials.get(ohms);
  if (!m)
    resistorMaterials.set(ohms, (m = new THREE.MeshStandardMaterial({ map: resistorTexture(ohms), roughness: 0.5 })));
  return m;
}

function resistorPieces(ohms: number, pins: readonly V[]): Piece[] {
  const [a, b] = pins;
  const span = Math.hypot(b.x - a.x, b.z - a.z);
  const matrix = placement(a, b, midpoint(a, b));
  if (span < STAND_SPAN) {
    const half = RES_LEN / 2;
    const body = cached(`resistor-standing-${span.toFixed(2)}`, () =>
      resistorLathe()
        .clone()
        .translate(-span / 2, STAND_BASE + half, 0),
    );
    return [
      {
        key: `resistor-standing-leads-${span.toFixed(2)}`,
        geometry: standingLeads(span, half, 0.27),
        material: tinMaterial,
        matrix,
      },
      { key: `resistor-standing-${ohms}-${span.toFixed(2)}`, geometry: body, material: resistorMaterial(ohms), matrix },
    ];
  }
  return [
    { key: `axial-leads-${span.toFixed(2)}`, geometry: axialLeads(span), material: tinMaterial, matrix },
    { key: `resistor-body-${ohms}`, geometry: resistorBody(), material: resistorMaterial(ohms), matrix },
  ];
}

// ---- diodes ----

const DIODE = {
  glass: { half: 1.9, radius: 0.85, axis: 1.35 },
  epoxy: { half: 2.6, radius: 1.35, axis: 1.75 },
};
const diodeMaterials = new Map<boolean, THREE.Material>();

function diodePieces(def: DiodeDef, pins: readonly V[]): Piece[] {
  const [a, b] = pins;
  const span = Math.hypot(b.x - a.x, b.z - a.z);
  const size = def.glass ? DIODE.glass : DIODE.epoxy;
  const matrix = placement(a, b, midpoint(a, b));
  let material = diodeMaterials.get(def.glass);
  if (!material) {
    material = new THREE.MeshStandardMaterial({ map: diodeTexture(def.glass), roughness: def.glass ? 0.12 : 0.45 });
    diodeMaterials.set(def.glass, material);
  }
  const kind = def.glass ? 'glass' : 'epoxy';
  if (span < STAND_SPAN) {
    const body = cached(`diode-standing-${kind}-${span.toFixed(2)}`, () =>
      new THREE.CylinderGeometry(size.radius, size.radius, size.half * 2, 16).translate(
        -span / 2,
        STAND_BASE + size.half,
        0,
      ),
    );
    return [
      {
        key: `diode-standing-leads-${kind}-${span.toFixed(2)}`,
        geometry: standingLeads(span, size.half, def.glass ? 0.24 : 0.3),
        material: tinMaterial,
        matrix,
      },
      { key: `diode-standing-${kind}-${span.toFixed(2)}`, geometry: body, material, matrix },
    ];
  }
  return [
    {
      key: `diode-leads-${kind}-${span.toFixed(2)}`,
      geometry: axialLeads(span, size.half - 0.2, size.axis, def.glass ? 0.24 : 0.3),
      material: tinMaterial,
      matrix,
    },
    {
      key: `diode-body-${kind}`,
      geometry: cached(`diode-body-${kind}`, () =>
        new THREE.CylinderGeometry(size.radius, size.radius, size.half * 2, 16)
          .rotateZ(-Math.PI / 2)
          .translate(0, size.axis, 0),
      ),
      material,
      matrix,
    },
  ];
}

// ---- capacitors ----

const DISC_R = 2.5;
const DISC_T = 1.05;
const DISC_Y = 1.2 + DISC_R;
const discMaterial = new THREE.MeshStandardMaterial({ color: 0xc4712c, roughness: 0.6 });
const codeMaterials = new Map<string, THREE.Material>();

/** Height and radius of an electrolytic's can for its value, roughly as sold. */
function canSize(farads: number): { r: number; h: number } {
  if (farads >= 999e-6) return { r: 5, h: 16 };
  if (farads >= 469e-6) return { r: 5, h: 12.5 };
  if (farads >= 219e-6) return { r: 4, h: 11.5 };
  if (farads >= 46e-6) return { r: 3.15, h: 11 };
  return { r: 2.5, h: 11 };
}

function canLabel(farads: number): string {
  return `${formatFarads(farads).replace(' ', '')} ${farads >= 469e-6 ? 16 : farads >= 46e-6 ? 25 : 50}V`;
}

const canTops = new THREE.MeshStandardMaterial({ color: 0xc9ccd2, metalness: 0.9, roughness: 0.35 });
const canBottoms = new THREE.MeshStandardMaterial({ color: 0x2a2a2c, roughness: 0.7 });
const sleeveMaterials = new Map<string, THREE.Material[]>();

/**
 * An electrolytic's can, its bottom 0.5 mm up: the printed sleeve with the crimp groove pressed in
 * near the bottom and rolled over the top edge, the bare aluminium top with its scored vent, and the
 * rubber bung underneath. Groups: sleeve, aluminium, rubber.
 */
function canGeometry(r: number, h: number): THREE.BufferGeometry {
  return cached(`cap-can-${r}-${h}`, () => {
    const groove = Math.min(2.2, h * 0.16);
    const pts = [new THREE.Vector2(r - 0.3, 0), new THREE.Vector2(r - 0.05, 0.12), new THREE.Vector2(r, 0.35)];
    pts.push(
      new THREE.Vector2(r, groove - 0.45),
      new THREE.Vector2(r - 0.3, groove - 0.12),
      new THREE.Vector2(r - 0.3, groove + 0.12),
      new THREE.Vector2(r, groove + 0.45),
    );
    // Rolled over the top: a quarter round into the lip.
    const roll = 0.55;
    for (let i = 0; i <= 6; i++) {
      const a = (i / 6) * (Math.PI / 2);
      pts.push(new THREE.Vector2(r - roll + roll * Math.cos(a), h - roll + roll * Math.sin(a)));
    }
    pts.push(new THREE.Vector2(r - roll - 0.25, h));
    const sleeve = new THREE.LatheGeometry(pts, 32);
    // The label is printed up the can, so it's mapped by height rather than along the outline.
    const pos = sleeve.attributes.position;
    const uv = sleeve.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setY(i, pos.getY(i) / h);
    const metal = r - roll - 0.25;
    const top = new THREE.CircleGeometry(metal, 32).rotateX(-Math.PI / 2).translate(0, h - 0.12, 0);
    // The vent: a K-shaped score on small cans is a cross on bigger ones; drawn as a cross either way.
    const score = (angle: number): THREE.BufferGeometry =>
      new THREE.BoxGeometry(metal * 1.5, 0.06, 0.2).rotateY(angle).translate(0, h - 0.1, 0);
    const bung = new THREE.CircleGeometry(r - 0.3, 24).rotateX(Math.PI / 2);
    const rubber = mergeGeometries([bung, score(0), score(Math.PI / 2)])!;
    return mergeGeometries([sleeve, top, rubber], true)!.translate(0, 0.5, 0);
  });
}

function capacitorPieces(def: CapacitorDef, pins: readonly V[], farads: number): Piece[] {
  const matrix = placement(pins[0], pins[1], midpoint(pins[0], pins[1]));
  const span = legSpan(pins);
  if (def.style === 'ceramic') {
    const code = capacitorCode(farads);
    let decal = codeMaterials.get(code);
    if (!decal) {
      decal = new THREE.MeshStandardMaterial({
        map: capacitorCodeTexture(code),
        roughness: 0.6,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
      });
      codeMaterials.set(code, decal);
    }
    return [
      {
        key: `cap-disc-legs-${span.toFixed(2)}`,
        geometry: bentLegs('cap-disc-legs', span, DISC_Y - 1.2, 0.25),
        material: tinMaterial,
        matrix,
      },
      {
        key: 'cap-disc',
        geometry: cached('cap-disc', () => {
          // A disc with rounded edges, standing up with its faces to the front and back.
          const pts = [new THREE.Vector2(0, -DISC_T)];
          for (let i = 0; i <= 10; i++) {
            const a = -Math.PI / 2 + (i / 10) * Math.PI;
            pts.push(new THREE.Vector2(DISC_R - DISC_T + DISC_T * Math.cos(a), DISC_T * Math.sin(a)));
          }
          pts.push(new THREE.Vector2(0, DISC_T));
          const disc = new THREE.LatheGeometry(pts, 20).rotateX(Math.PI / 2).translate(0, DISC_Y, 0);
          const drip = (x: number): THREE.BufferGeometry => {
            const g = new THREE.SphereGeometry(0.62, 12, 8);
            g.deleteAttribute('uv');
            return g.scale(1, 1.7, 0.9).translate(x, DISC_Y - Math.sqrt(DISC_R ** 2 - (PITCH / 2) ** 2) - 0.1, 0);
          };
          disc.deleteAttribute('uv');
          return mergeGeometries([disc, drip(-PITCH / 2), drip(PITCH / 2)])!;
        }),
        material: discMaterial,
        matrix,
      },
      {
        key: `cap-code-${code}`,
        geometry: cached('cap-code', () =>
          mergeGeometries([
            new THREE.PlaneGeometry(2.7, 1.45).translate(0, DISC_Y + 0.2, DISC_T + 0.01),
            new THREE.PlaneGeometry(2.7, 1.45).rotateY(Math.PI).translate(0, DISC_Y + 0.2, -DISC_T - 0.01),
          ])!,
        ),
        material: decal,
        matrix,
      },
    ];
  }
  const { r, h } = canSize(farads);
  const label = canLabel(farads);
  let materials = sleeveMaterials.get(label);
  if (!materials) {
    materials = [
      new THREE.MeshStandardMaterial({ map: electrolyticTexture(label), roughness: 0.4 }),
      canTops,
      canBottoms,
    ];
    sleeveMaterials.set(label, materials);
  }
  // A can sits higher when its legs are bent out, so they have room to bend.
  const lift = Math.abs(span - PITCH) < 0.01 ? 0 : 2.4;
  const raised = lift ? matrix.clone().multiply(new THREE.Matrix4().makeTranslation(0, lift, 0)) : matrix;
  return [
    {
      key: `cap-can-legs-${span.toFixed(2)}`,
      geometry: bentLegs('cap-can-legs', span, 0.6 + lift, 0.27),
      material: tinMaterial,
      matrix,
    },
    {
      key: `cap-can-${label}`,
      geometry: canGeometry(r, h),
      material: materials,
      matrix: raised,
    },
  ];
}

// ---- potentiometer ----
// A breadboard trimmer: three legs in a row, a square body and a knob on top that turns through 270°.

const POT_BODY = 9.6;
const POT_KNOB_TOP = 8.6;
const potBody = new THREE.MeshStandardMaterial({ color: 0x2457c5, roughness: 0.5 });
const knobMaterial = new THREE.MeshStandardMaterial({ color: 0x2b2d31, roughness: 0.55 });
const pointerMaterial = new THREE.MeshStandardMaterial({ color: 0xf4f4f2, roughness: 0.4 });
/** The metal plate on top of a switch or button: a warm grey, so it doesn't melt into the board's white. */
const plateMaterial = new THREE.MeshStandardMaterial({ color: 0x8e8a82, metalness: 0.5, roughness: 0.45 });
/** A slide switch's lever: black, so you can see which way it's thrown against the plate. */
const leverMaterial = new THREE.MeshStandardMaterial({ color: 0x1c1b19, roughness: 0.5 });

/** Knob angle for a pot position (0–1000), clockwise from straight up, radians. */
export function knobAngle(position: number): number {
  return ((-135 + 270 * (position / 1000)) * Math.PI) / 180;
}

function rowLegs(key: string, count: number): THREE.BufferGeometry {
  return cached(key, () =>
    mergeGeometries(
      Array.from({ length: count }, (_, k) =>
        new THREE.BoxGeometry(0.5, HOLE_DEPTH + 0.6, 0.3).translate(
          (k - (count - 1) / 2) * PITCH,
          (0.6 - HOLE_DEPTH) / 2,
          0,
        ),
      ),
    )!,
  );
}

function potPieces(pins: readonly V[], position: number): Piece[] {
  const matrix = placement(pins[0], pins[2], pins[1]);
  const knob = matrix.clone().multiply(new THREE.Matrix4().makeRotationY(-knobAngle(position)));
  return [
    { key: 'pot-legs', geometry: rowLegs('pot-legs', 3), material: tinMaterial, matrix },
    {
      key: 'pot-body',
      geometry: cached('pot-body', () =>
        new RoundedBoxGeometry(POT_BODY, 3.6, POT_BODY, 2, 0.6).translate(0, 0.4 + 1.8, 0),
      ),
      material: potBody,
      matrix,
    },
    {
      key: 'pot-knob',
      geometry: cached('pot-knob', () =>
        new THREE.CylinderGeometry(3.2, 3.35, POT_KNOB_TOP - 4, 24).translate(0, 4 + (POT_KNOB_TOP - 4) / 2, 0),
      ),
      material: knobMaterial,
      matrix: knob,
    },
    {
      key: 'pot-pointer',
      geometry: cached('pot-pointer', () =>
        new THREE.BoxGeometry(0.7, 0.2, 2.5).translate(0, POT_KNOB_TOP + 0.1, -1.5),
      ),
      material: pointerMaterial,
      matrix: knob,
    },
  ];
}

// ---- slide switch (SPDT) ----

const SLIDE_TOP = 3.8;

function slidePieces(pins: readonly V[], state: number): Piece[] {
  const matrix = placement(pins[0], pins[2], pins[1]);
  const lever = matrix.clone().multiply(new THREE.Matrix4().makeTranslation(state & 1 ? 1.3 : -1.3, 0, 0));
  return [
    { key: 'slide-legs', geometry: rowLegs('slide-legs', 3), material: tinMaterial, matrix },
    {
      key: 'slide-body',
      geometry: cached('slide-body', () =>
        new THREE.BoxGeometry(8.6, SLIDE_TOP - 0.4, 3.6).translate(0, 0.4 + (SLIDE_TOP - 0.4) / 2, 0),
      ),
      material: epoxyMaterial,
      matrix,
    },
    {
      key: 'slide-plate',
      geometry: cached('slide-plate', () => new THREE.BoxGeometry(8.8, 0.3, 3.8).translate(0, SLIDE_TOP + 0.15, 0)),
      material: plateMaterial,
      matrix,
    },
    {
      key: 'slide-lever',
      geometry: cached('slide-lever', () => new THREE.BoxGeometry(2.8, 2.6, 2.8).translate(0, SLIDE_TOP + 1.3, 0)),
      material: leverMaterial,
      matrix: lever,
    },
  ];
}

// ---- transistors (TO-92) ----
// A half-round plastic body on three legs, its flat face (printed with the type) towards +z.

const TO92 = { radius: 2.35, flat: 1.0, base: 1.5, height: 4.6 };
const transistorMaterials = new Map<string, THREE.Material>();

function to92Body(): THREE.BufferGeometry {
  return cached('to92-body', () => {
    const { radius, flat, base, height } = TO92;
    const edge = Math.asin(flat / radius);
    const shape = new THREE.Shape();
    for (let i = 0; i <= 24; i++) {
      const a = -edge + (i / 24) * (Math.PI + 2 * edge);
      const x = radius * Math.cos(a);
      const y = radius * Math.sin(a);
      if (i === 0) shape.moveTo(x, y);
      else shape.lineTo(x, y);
    }
    // Extruded along +z, then stood up: the shape's y becomes -z, so the flat (at y = -flat) faces +z.
    return new THREE.ExtrudeGeometry(shape, { depth: height, bevelEnabled: false, curveSegments: 1 })
      .rotateX(-Math.PI / 2)
      .translate(0, base, 0);
  });
}

function transistorPieces(def: TransistorDef, pins: readonly V[]): Piece[] {
  const matrix = placement(pins[0], pins[2], pins[1]);
  let material = transistorMaterials.get(def.id);
  if (!material) {
    material = new THREE.MeshStandardMaterial({ map: transistorTexture(def.id), roughness: 0.55 });
    transistorMaterials.set(def.id, material);
  }
  const { flat, base, height } = TO92;
  return [
    {
      key: 'to92-legs',
      geometry: cached('to92-legs', () =>
        mergeGeometries(
          [0, 1, 2].map((k) =>
            new THREE.BoxGeometry(0.5, HOLE_DEPTH + base + 0.3, 0.3).translate(
              (k - 1) * PITCH,
              (base + 0.3 - HOLE_DEPTH) / 2,
              0,
            ),
          ),
        )!,
      ),
      material: tinMaterial,
      matrix,
    },
    { key: 'to92-body', geometry: to92Body(), material: epoxyMaterial, matrix },
    {
      key: `to92-face-${def.id}`,
      geometry: cached('to92-face', () =>
        new THREE.PlaneGeometry(4.2, height - 0.4).translate(0, base + height / 2, flat + 0.01),
      ),
      material,
      matrix,
    },
  ];
}

// ---- seven-segment display ----
// A 0.56" digit, straddling the channel with its pins 0.6" apart. Pin 1 is bottom left; the top of
// the digit faces the far row of pins (local -z).

const DISPLAY = { length: 12.6, width: 19, top: 8.5 };
const faceMaterial = new THREE.MeshStandardMaterial({ color: 0x161617, roughness: 0.45 });
// Unlit segments are a dull grey, well below the lit ones.
const segmentOff = new THREE.MeshStandardMaterial({ color: 0x5f5d59, roughness: 0.85 });

/** Outline of each segment (a–g, dp) on the face, in the display's own frame (x right, z down). */
function segmentOutlines(): THREE.Vector2[][] {
  const W = 7;
  const Hh = 13;
  const T = 1.45;
  const gap = 0.32;
  const cx = -0.9;
  const xl = -W / 2 + T / 2 + cx;
  const xr = W / 2 - T / 2 + cx;
  const zt = -Hh / 2 + T / 2;
  const zb = Hh / 2 - T / 2;
  const bar = (x0: number, z0: number, x1: number, z1: number): THREE.Vector2[] => {
    const len = Math.hypot(x1 - x0, z1 - z0);
    const dx = (x1 - x0) / len;
    const dz = (z1 - z0) / len;
    const w = T / 2;
    const s = [x0 + dx * gap, z0 + dz * gap];
    const e = [x1 - dx * gap, z1 - dz * gap];
    return [
      [s[0], s[1]],
      [s[0] + dx * w - dz * w, s[1] + dz * w + dx * w],
      [e[0] - dx * w - dz * w, e[1] - dz * w + dx * w],
      [e[0], e[1]],
      [e[0] - dx * w + dz * w, e[1] - dz * w - dx * w],
      [s[0] + dx * w + dz * w, s[1] + dz * w - dx * w],
    ].map(([x, z]) => new THREE.Vector2(x - 0.12 * z, z));
  };
  const dp: THREE.Vector2[] = [];
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    const z = zb + 0.1 + 0.78 * Math.sin(a);
    dp.push(new THREE.Vector2(xr + 2.1 + 0.78 * Math.cos(a) - 0.12 * z, z));
  }
  return [
    bar(xl, zt, xr, zt),
    bar(xr, zt, xr, 0),
    bar(xr, 0, xr, zb),
    bar(xl, zb, xr, zb),
    bar(xl, 0, xl, zb),
    bar(xl, zt, xl, 0),
    bar(xl, 0, xr, 0),
    dp,
  ];
}

/** One segment's shape lying on the face, raised by `lift`. */
function segmentGeometry(s: number, lift: number): THREE.BufferGeometry {
  return cached(`seg-${s}-${lift}`, () =>
    new THREE.ShapeGeometry(new THREE.Shape(segmentOutlines()[s].map((p) => new THREE.Vector2(p.x, -p.y))))
      .rotateX(-Math.PI / 2)
      .translate(0, DISPLAY.top + lift, 0),
  );
}

/** A lit segment, drawn just above the unlit one. */
export function litSegmentGeometry(s: number): THREE.BufferGeometry {
  return segmentGeometry(s, 0.05);
}

/** Middle of the digit in a display's own frame, where its glow sits. */
export const DISPLAY_CENTER = new THREE.Vector3(-0.9, DISPLAY.top + 1, 0);

function displayPieces(pins: readonly V[]): Piece[] {
  const matrix = placement(pins[0], pins[4], centroid(pins));
  return [
    {
      key: 'display-legs',
      geometry: cached('display-legs', () =>
        mergeGeometries(
          Array.from({ length: 5 }, (_, k) => (k - 2) * PITCH).flatMap((x) =>
            [1, -1].map((side) =>
              new THREE.BoxGeometry(0.5, HOLE_DEPTH + 0.6, 0.3).translate(x, (0.6 - HOLE_DEPTH) / 2, side * 3 * PITCH),
            ),
          ),
        )!,
      ),
      material: tinMaterial,
      matrix,
    },
    {
      key: 'display-body',
      geometry: cached('display-body', () =>
        new THREE.BoxGeometry(DISPLAY.length, DISPLAY.top - 0.5, DISPLAY.width).translate(
          0,
          0.5 + (DISPLAY.top - 0.5) / 2,
          0,
        ),
      ),
      material: [epoxyMaterial, epoxyMaterial, faceMaterial, epoxyMaterial, epoxyMaterial, epoxyMaterial],
      matrix,
    },
    {
      key: 'display-segments',
      geometry: cached('display-segments', () =>
        mergeGeometries(Array.from({ length: 8 }, (_, s) => segmentGeometry(s, 0.02)))!,
      ),
      material: segmentOff,
      matrix,
    },
  ];
}

// ---- LED bar graph ----
// A 0.3" DIP-20 across the channel; its bars run across the body, one over each pair of legs.

const BAR = { length: 25.3, width: 10.1, top: 7.8, bar: { width: 1.55, length: 5.4 } };

/** Where bar `s` of `n` sits along the body, in its own frame. */
const barX = (s: number, n: number): number => (s - (n - 1) / 2) * PITCH;

function barGraphPieces(def: BarGraphDef, pins: readonly V[]): Piece[] {
  const n = def.segments;
  const matrix = placement(pins[0], pins[n - 1], centroid(pins));
  return [
    {
      key: `bar-legs-${n}`,
      geometry: cached(`bar-legs-${n}`, () =>
        mergeGeometries(
          Array.from({ length: n }, (_, k) => barX(k, n)).flatMap((x) =>
            [1, -1].map((side) =>
              new THREE.BoxGeometry(0.5, HOLE_DEPTH + 0.6, 0.3).translate(
                x,
                (0.6 - HOLE_DEPTH) / 2,
                (side * 3 * PITCH) / 2,
              ),
            ),
          ),
        )!,
      ),
      material: tinMaterial,
      matrix,
    },
    {
      key: 'bar-body',
      geometry: cached('bar-body', () =>
        new THREE.BoxGeometry(BAR.length, BAR.top - 0.5, BAR.width).translate(0, 0.5 + (BAR.top - 0.5) / 2, 0),
      ),
      material: [epoxyMaterial, epoxyMaterial, faceMaterial, epoxyMaterial, epoxyMaterial, epoxyMaterial],
      matrix,
    },
    {
      key: `bar-bars-${n}`,
      geometry: cached(`bar-bars-${n}`, () =>
        mergeGeometries(
          Array.from({ length: n }, (_, s) =>
            new THREE.PlaneGeometry(BAR.bar.width, BAR.bar.length)
              .rotateX(-Math.PI / 2)
              .translate(barX(s, n), BAR.top + 0.02, 0),
          ),
        )!,
      ),
      material: segmentOff,
      matrix,
    },
  ];
}

/** A lit bar, drawn just above the unlit one, in the bar graph's frame with the bar at its middle. */
export function litBarGeometry(): THREE.BufferGeometry {
  return cached('bar-lit', () =>
    new THREE.PlaneGeometry(BAR.bar.width, BAR.bar.length).rotateX(-Math.PI / 2).translate(0, BAR.top + 0.05, 0),
  );
}

/** A bar graph's placement moved along to bar `s` of `n`, for its lit bar. */
export function barMatrix(matrix: THREE.Matrix4, s: number, n: number): THREE.Matrix4 {
  return matrix.clone().multiply(new THREE.Matrix4().makeTranslation(barX(s, n), 0, 0));
}

/** Middle of a bar graph's face in its own frame, where its glow sits. */
export const BAR_CENTER = new THREE.Vector3(0, BAR.top + 1, 0);

// ---- resistor network ----
// A single-in-line package standing in one row of holes, pin 1 marked with a dot.

const SIP = { height: 5.2, thick: 2.5 };
const networkMaterials = new Map<string, THREE.Material[]>();

function networkPieces(def: NetworkDef, pins: readonly V[], ohms: number): Piece[] {
  const n = def.pins;
  const matrix = placement(pins[0], pins[n - 1], centroid(pins));
  const code = ohmsCode(ohms);
  let materials = networkMaterials.get(code);
  if (!materials) {
    // The value is printed on the front; the other faces are plain.
    materials = [
      epoxyMaterial,
      epoxyMaterial,
      epoxyMaterial,
      epoxyMaterial,
      new THREE.MeshStandardMaterial({ map: networkTexture(code), roughness: 0.55 }),
      epoxyMaterial,
    ];
    networkMaterials.set(code, materials);
  }
  return [
    { key: `sip-legs-${n}`, geometry: rowLegs(`sip-legs-${n}`, n), material: tinMaterial, matrix },
    {
      key: `sip-body-${n}-${code}`,
      geometry: cached(`sip-body-${n}`, () =>
        new THREE.BoxGeometry(n * PITCH - 0.3, SIP.height, SIP.thick).translate(0, 0.6 + SIP.height / 2, 0),
      ),
      material: materials,
      matrix,
    },
  ];
}

// ---- power module (MB102) ----
// Local frame: origin on the board surface between the rails at the pins' column, -x pointing
// out past the end of the board. A red board on short headers with yellow spacers: its body sits off
// the end of the breadboard, and two narrow arms reach in over the rails to the pins, so no terminal or
// rail hole is under it. On the body, from one end to the other: the barrel jack, a capacitor, the
// on/off slide switch, another capacitor, the fuse and the mini-USB socket; a jumper header at each
// corner by an arm.

const PCB_Y = 2.5;
const PCB_T = 1.2;
const PCB_TOP = PCB_Y + PCB_T;
/** The body's inner edge, short of a BB830's (and a BB400's) first terminal column. */
const BODY_INNER = -6.4;
const OUTER = -24;
const PCB_WIDTH = 52;
/** The arms: as far in as just past the pins, and across the desk where the rails are. */
const ARM_INNER = 1;
const ARM_NEAR = 20.1;
const ARM_FAR = 26.1;
/** The tallest thing on it, the barrel jack, and where it sits across the module. */
const JACK = { x0: OUTER, x1: -15.5, z0: -PCB_WIDTH / 2, z1: -14, top: 11 };
/** Where the module's power LED sits, in its local frame. */
export const POWER_LED = new THREE.Vector3(-9, PCB_TOP + 0.4, -12);

const pcbMaterial = new THREE.MeshStandardMaterial({ color: 0xc21f26, roughness: 0.55 });
const yellowMaterial = new THREE.MeshStandardMaterial({ color: 0xf2c230, roughness: 0.5 });
const keyMaterial = new THREE.MeshStandardMaterial({ color: 0xd9dbde, roughness: 0.45 });
const canMaterial = new THREE.MeshStandardMaterial({ color: 0xc9ccd0, metalness: 0.6, roughness: 0.35 });
const fuseMaterial = new THREE.MeshStandardMaterial({ color: 0x2f7d4a, roughness: 0.5 });

/** Rail pin positions across the board, in pitches from the centre between the rails. */
const RAIL_PINS = [-9.5, -8.5, 8.5, 9.5];

/** The two capacitors' centres across the module. */
const CAPS_Z = [-8.6, 7.4];

function powerParts(): {
  black: THREE.BufferGeometry;
  metal: THREE.BufferGeometry;
  pcb: THREE.BufferGeometry;
  yellow: THREE.BufferGeometry;
  key: THREE.BufferGeometry;
  led: THREE.BufferGeometry;
  cans: THREE.BufferGeometry;
  fuse: THREE.BufferGeometry;
} {
  const box = (w: number, h: number, d: number, x: number, y: number, z: number): THREE.BufferGeometry =>
    new THREE.BoxGeometry(w, h, d).translate(x, y, z);
  const span = (x0: number, x1: number, z0: number, z1: number, y0: number, h: number): THREE.BufferGeometry =>
    box(x1 - x0, h, z1 - z0, (x0 + x1) / 2, y0 + h / 2, (z0 + z1) / 2);
  return {
    pcb: cached('pm-pcb', () =>
      mergeGeometries([
        span(OUTER, BODY_INNER, -PCB_WIDTH / 2, PCB_WIDTH / 2, PCB_Y, PCB_T),
        ...[-1, 1].map((side) =>
          span(
            BODY_INNER - 0.01,
            ARM_INNER,
            side < 0 ? -ARM_FAR : ARM_NEAR,
            side < 0 ? -ARM_NEAR : ARM_FAR,
            PCB_Y,
            PCB_T,
          ),
        ),
      ])!,
    ),
    black: cached('pm-black', () => {
      // The barrel jack: a block with a round mouth facing out past the module's outer edge.
      const jack = span(JACK.x0 + 1.5, JACK.x1, JACK.z0 + 0.5, JACK.z1, PCB_TOP, JACK.top - 1);
      const mouth = new THREE.CylinderGeometry(4.2, 4.2, 1.5, 24)
        .rotateZ(Math.PI / 2)
        .translate(JACK.x0 + 0.75, PCB_TOP + 5.6, (JACK.z0 + JACK.z1) / 2 + 0.2);
      return mergeGeometries([
        jack,
        mouth,
        // the capacitors' plastic bases, and the slide switch's body between them
        ...CAPS_Z.map((z) => box(6.6, 1, 6.6, -14, PCB_TOP + 0.5, z)),
        box(4.4, 3, 8.6, -14, PCB_TOP + 1.5, -0.6),
      ])!;
    }),
    metal: cached('pm-metal', () =>
      mergeGeometries([
        ...RAIL_PINS.map((p) => box(0.64, PCB_Y + HOLE_DEPTH, 0.64, 0, (PCB_Y - HOLE_DEPTH) / 2, p * PITCH)),
        // the mini-USB socket at the outer edge, and the barrel jack's pin inside its mouth
        span(OUTER - 0.4, OUTER + 8.6, 14.2, 22, PCB_TOP, 3.9),
        new THREE.CylinderGeometry(1, 1, 1.6, 12)
          .rotateZ(Math.PI / 2)
          .translate(JACK.x0 + 0.7, PCB_TOP + 5.6, (JACK.z0 + JACK.z1) / 2 + 0.2),
      ])!,
    ),
    // the spacers on the pin headers under the arms
    yellow: cached('pm-yellow', () =>
      mergeGeometries([-1, 1].map((side) => box(2.4, PCB_Y, 5.1, 0, PCB_Y / 2, side * 9 * PITCH)))!,
    ),
    key: cached('pm-key', () => box(1.8, 2.2, 2.6, -14, PCB_TOP + 3.6, -1.6)),
    cans: cached('pm-cans', () =>
      mergeGeometries(
        CAPS_Z.map((z) => new THREE.CylinderGeometry(3.15, 3.15, 5.4, 24).translate(-14, PCB_TOP + 1 + 2.7, z)),
      )!,
    ),
    fuse: cached('pm-fuse', () => box(3.2, 1, 2, -19.5, PCB_TOP + 0.5, 11.6)),
    led: cached('pm-led', () =>
      new THREE.SphereGeometry(0.9, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2).translate(POWER_LED.x, PCB_TOP, POWER_LED.z),
    ),
  };
}

/** Placement of a power module: `facing` is -1 at the left end of a board, +1 at the right end. */
export function powerMatrix(pins: readonly V[], facing: number): THREE.Matrix4 {
  const midZ = (pins[0].z + pins[3].z) / 2;
  return new THREE.Matrix4().makeRotationY(facing < 0 ? 0 : Math.PI).setPosition(pins[0].x, H, midZ);
}

// ---- its jumpers ----
// Each side has a 2 × 3 pin header in the corner by its arm, its three pairs running out from the
// board (5 V nearest it, then off, then 3.3 V) and a cap across one pair: the + rail on that side gets
// what the cap picks.

/** The header pairs' x, by position (an index into POWER_JUMPERS). */
const JUMPER_X = [-8.4, -8.4 - PITCH, -8.4 - 2 * PITCH];
/** How far either header is from the module's middle, across it. */
const JUMPER_Z = 22.5;
const JUMPER_BASE = 2;
const JUMPER_CAP_TOP = 5.2;
const jumperCapMaterial = new THREE.MeshStandardMaterial({ color: 0x2457c5, roughness: 0.5 });

/** Which way across the module (in its own frame) the top rails' side is: -1 or +1. */
function topSideSign(pins: readonly V[], facing: number): number {
  const local = pins[0].clone().applyMatrix4(powerMatrix(pins, facing).invert());
  return local.z < 0 ? -1 : 1;
}

function jumperHeaders(): THREE.BufferGeometry {
  return cached('pm-jumper-pins', () =>
    mergeGeometries(
      [-1, 1].flatMap((sign) =>
        JUMPER_X.flatMap((x) =>
          [-1, 1].map((d) =>
            new THREE.BoxGeometry(0.64, JUMPER_CAP_TOP - 0.6, 0.64).translate(
              x,
              PCB_TOP + (JUMPER_CAP_TOP - 0.6) / 2,
              sign * JUMPER_Z + (d * PITCH) / 2,
            ),
          ),
        ),
      ),
    )!,
  );
}

function jumperBases(): THREE.BufferGeometry {
  const length = JUMPER_X.length * PITCH;
  const mid = (JUMPER_X[0] + JUMPER_X[JUMPER_X.length - 1]) / 2;
  return cached('pm-jumper-base', () =>
    mergeGeometries(
      [-1, 1].map((sign) =>
        new THREE.BoxGeometry(length, JUMPER_BASE, 2 * PITCH).translate(
          mid,
          PCB_TOP + JUMPER_BASE / 2,
          sign * JUMPER_Z,
        ),
      ),
    )!,
  );
}

function jumperCap(sign: number, position: number): THREE.BufferGeometry {
  const h = JUMPER_CAP_TOP - JUMPER_BASE - 0.3;
  return cached(`pm-jumper-cap-${sign}-${position}`, () =>
    new RoundedBoxGeometry(2.4, h, 2 * PITCH - 0.1, 2, 0.3).translate(
      JUMPER_X[position],
      PCB_TOP + JUMPER_BASE + 0.3 + h / 2,
      sign * JUMPER_Z,
    ),
  );
}

/**
 * The power module jumper a ray points at, if any: which side (0 top, 1 bottom) and the position
 * nearest where it crosses the tops of the headers.
 */
export function powerJumperAt(
  pins: readonly V[],
  facing: number,
  ray: THREE.Ray,
): { side: PowerSide; position: number } | null {
  const point = ray.intersectPlane(
    new THREE.Plane(new THREE.Vector3(0, 1, 0), -(H + PCB_TOP + JUMPER_CAP_TOP - 0.5)),
    new THREE.Vector3(),
  );
  if (!point) return null;
  const local = point.applyMatrix4(powerMatrix(pins, facing).invert());
  const across = Math.abs(local.z);
  if (across < JUMPER_Z - PITCH - 0.5 || across > JUMPER_Z + PITCH + 0.5) return null;
  if (local.x > JUMPER_X[0] + PITCH || local.x < JUMPER_X[JUMPER_X.length - 1] - PITCH) return null;
  let position = 0;
  JUMPER_X.forEach((x, j) => {
    if (Math.abs(local.x - x) < Math.abs(local.x - JUMPER_X[position])) position = j;
  });
  const side: PowerSide = Math.sign(local.z) === topSideSign(pins, facing) ? 0 : 1;
  return { side, position };
}

function powerPieces(pins: readonly V[], facing: number, state: number): Piece[] {
  const g = powerParts();
  const matrix = powerMatrix(pins, facing);
  const top = topSideSign(pins, facing);
  const caps = ([0, 1] as const).map((side): Piece => {
    const sign = side === 0 ? top : -top;
    const position = powerJumper(state, side);
    return {
      key: `pm-jumper-cap-${sign}-${position}`,
      geometry: jumperCap(sign, position),
      material: jumperCapMaterial,
      matrix,
    };
  });
  return [
    { key: 'pm-pcb', geometry: g.pcb, material: pcbMaterial, matrix },
    { key: 'pm-black', geometry: g.black, material: epoxyMaterial, matrix },
    { key: 'pm-metal', geometry: g.metal, material: tinMaterial, matrix },
    { key: 'pm-yellow', geometry: g.yellow, material: yellowMaterial, matrix },
    { key: 'pm-key', geometry: g.key, material: keyMaterial, matrix },
    { key: 'pm-led', geometry: g.led, material: lensMaterial('green'), matrix },
    { key: 'pm-cans', geometry: g.cans, material: canMaterial, matrix },
    { key: 'pm-fuse', geometry: g.fuse, material: fuseMaterial, matrix },
    { key: 'pm-jumper-base', geometry: jumperBases(), material: epoxyMaterial, matrix },
    { key: 'pm-jumper-pins', geometry: jumperHeaders(), material: tinMaterial, matrix },
    ...caps,
  ];
}

export function powerLedGeometry(): THREE.BufferGeometry {
  return powerParts().led;
}

// ---- 6 mm push button ----
// Four legs at the corners of a 2 × 3 hole rectangle (two columns, across the centre channel).

const BUTTON_TOP = 3.9;

/** The cap of a button that's being held down: hard to miss, so it isn't forgotten. */
const heldCapMaterial = new THREE.MeshStandardMaterial({
  color: 0xf0a020,
  roughness: 0.4,
  emissive: 0xf0a020,
  emissiveIntensity: 0.25,
});

function buttonPieces(pins: readonly V[], pressed: boolean, held: boolean): Piece[] {
  const matrix = new THREE.Matrix4().makeTranslation(centroid(pins).x, H, centroid(pins).z);
  const legs = cached('btn-metal', () => {
    const parts: THREE.BufferGeometry[] = [];
    for (const x of [-PITCH, PITCH]) {
      for (const z of [-1.5 * PITCH, 1.5 * PITCH]) {
        parts.push(
          new THREE.BoxGeometry(0.7, 0.3, Math.abs(z) - 2.8).translate(
            x,
            1,
            Math.sign(z) * (2.8 + (Math.abs(z) - 2.8) / 2),
          ),
          new THREE.BoxGeometry(0.7, HOLE_DEPTH + 1.15, 0.3).translate(x, (1.15 - HOLE_DEPTH) / 2, z),
        );
      }
    }
    return mergeGeometries(parts)!;
  });
  const plate = cached('btn-plate', () => new THREE.BoxGeometry(6.2, 0.3, 6.2).translate(0, BUTTON_TOP - 0.15, 0));
  const body = cached('btn-body', () => new THREE.BoxGeometry(6, 3.4, 6).translate(0, 0.2 + 1.7, 0));
  const cap = cached('btn-cap', () =>
    new THREE.CylinderGeometry(1.75, 1.75, 1.4, 24).translate(0, BUTTON_TOP + 0.7, 0),
  );
  // Pressing only moves the cap, so the scene can update it in place.
  const capMatrix = pressed ? matrix.clone().multiply(new THREE.Matrix4().makeTranslation(0, -0.6, 0)) : matrix;
  return [
    { key: 'btn-body', geometry: body, material: epoxyMaterial, matrix },
    { key: 'btn-metal', geometry: legs, material: tinMaterial, matrix },
    { key: 'btn-plate', geometry: plate, material: plateMaterial, matrix },
    {
      key: held ? 'btn-cap-held' : 'btn-cap',
      geometry: cap,
      material: held ? heldCapMaterial : epoxyMaterial,
      matrix: capMatrix,
    },
  ];
}

// ---- DIP switch ----

const SWITCH_H = 5;
const switchBody = new THREE.MeshStandardMaterial({ color: 0x2457c5, roughness: 0.5 });
const sliderMaterial = new THREE.MeshStandardMaterial({ color: 0xf4f4f2, roughness: 0.4 });
const switchDecals = new Map<number, THREE.Material>();

function switchSize(n: number): { length: number; width: number } {
  return { length: n * PITCH + 0.6, width: 9.9 };
}

function switchPieces(n: number, pins: readonly V[], state: number): Piece[] {
  const { length, width } = switchSize(n);
  const matrix = placement(pins[0], pins[n - 1], centroid(pins));
  let decal = switchDecals.get(n);
  if (!decal) {
    decal = new THREE.MeshStandardMaterial({
      map: dipSwitchTexture(n, length - 0.8, width - 0.8),
      roughness: 0.5,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    switchDecals.set(n, decal);
  }
  const pieces: Piece[] = [
    {
      key: `sw-body-${n}`,
      geometry: cached(`sw-body-${n}`, () =>
        new RoundedBoxGeometry(length, SWITCH_H, width, 2, 0.35).translate(0, 0.4 + SWITCH_H / 2, 0),
      ),
      material: switchBody,
      matrix,
    },
    {
      key: `sw-decal-${n}`,
      geometry: cached(`sw-decal-${n}`, () =>
        new THREE.PlaneGeometry(length - 0.8, width - 0.8).rotateX(-Math.PI / 2).translate(0, 0.4 + SWITCH_H + 0.01, 0),
      ),
      material: decal,
      matrix,
    },
    {
      key: `sw-legs-${n}`,
      geometry: cached(`sw-legs-${n}`, () =>
        mergeGeometries(
          Array.from({ length: n }, (_, k) => (k - (n - 1) / 2) * PITCH).flatMap((x) => [
            new THREE.BoxGeometry(0.5, HOLE_DEPTH + 0.6, 0.3).translate(x, (0.6 - HOLE_DEPTH) / 2, 1.5 * PITCH),
            new THREE.BoxGeometry(0.5, HOLE_DEPTH + 0.6, 0.3).translate(x, (0.6 - HOLE_DEPTH) / 2, -1.5 * PITCH),
          ]),
        )!,
      ),
      material: tinMaterial,
      matrix,
    },
  ];
  const slider = cached('sw-slider', () => new THREE.BoxGeometry(1.3, 0.9, 1.7));
  for (let k = 0; k < n; k++) {
    // On is towards the far row (where "ON" is printed).
    const on = (state >> k) & 1;
    const local = new THREE.Matrix4().makeTranslation(
      (k - (n - 1) / 2) * PITCH,
      0.4 + SWITCH_H + 0.35,
      on ? -1.05 : 1.05,
    );
    pieces.push({
      key: 'sw-slider',
      geometry: slider,
      material: sliderMaterial,
      matrix: matrix.clone().multiply(local),
    });
  }
  return pieces;
}

// ---- Arduino Nano ----
// Local frame: x from the USB end (pin 1) towards pin 15, pins 1–15 at +z. The board rides on its
// header's plastic strips, which sit on the breadboard.

const NANO = { length: 43.2, width: 18, spacer: 2.5, pcb: 1.6, span: 6 * PITCH };
const NANO_TOP = NANO.spacer + NANO.pcb;
/** The four little LEDs by the reset button, in the Nano's frame. */
export const NANO_LEDS = {
  tx: new THREE.Vector3(-10, NANO_TOP + 0.3, -3.6),
  rx: new THREE.Vector3(-10, NANO_TOP + 0.3, -1.2),
  pwr: new THREE.Vector3(-10, NANO_TOP + 0.3, 1.2),
  l: new THREE.Vector3(-10, NANO_TOP + 0.3, 3.6),
} as const;
export type NanoLed = keyof typeof NANO_LEDS;
export const NANO_LED_COLORS: Record<NanoLed, LedColor> = { tx: 'yellow', rx: 'yellow', pwr: 'green', l: 'red' };

/** Header pin positions in the Nano's frame, pin 1 first. */
function nanoPins(): { x: number; z: number; name: string }[] {
  return NANO_PIN_NAMES.map((name, i) =>
    i < 15 ? { x: (i - 7) * PITCH, z: NANO.span / 2, name } : { x: (7 - (i - 15)) * PITCH, z: -NANO.span / 2, name },
  );
}

const nanoPcbMaterial = new THREE.MeshStandardMaterial({ color: 0x1f5f9e, roughness: 0.5 });
const nanoChromeMaterial = new THREE.MeshStandardMaterial({ color: 0xc8ccd2, metalness: 0.9, roughness: 0.3 });
const nanoButtonMaterial = new THREE.MeshStandardMaterial({ color: 0xe8e4da, roughness: 0.5 });
let nanoDecal: THREE.Material | null = null;

function nanoParts(): {
  pcb: THREE.BufferGeometry;
  top: THREE.BufferGeometry;
  black: THREE.BufferGeometry;
  metal: THREE.BufferGeometry;
  chrome: THREE.BufferGeometry;
  button: THREE.BufferGeometry;
} {
  const box = (w: number, h: number, d: number, x: number, y: number, z: number): THREE.BufferGeometry =>
    new THREE.BoxGeometry(w, h, d).translate(x, y, z);
  const pins = nanoPins();
  return {
    pcb: cached('nano-pcb', () =>
      new RoundedBoxGeometry(NANO.length, NANO.pcb, NANO.width, 2, 0.5).translate(0, NANO.spacer + NANO.pcb / 2, 0),
    ),
    top: cached('nano-top', () =>
      new THREE.PlaneGeometry(NANO.length - 0.4, NANO.width - 0.4)
        .rotateX(-Math.PI / 2)
        .translate(0, NANO_TOP + 0.01, 0),
    ),
    black: cached('nano-black', () =>
      mergeGeometries([
        // header strips under the board
        box(15 * PITCH, NANO.spacer, 2.5, 0, NANO.spacer / 2, NANO.span / 2),
        box(15 * PITCH, NANO.spacer, 2.5, 0, NANO.spacer / 2, -NANO.span / 2),
        // ATmega328P (TQFP, turned 45°) and the ICSP header's plastic
        new THREE.BoxGeometry(7, 1, 7).rotateY(Math.PI / 4).translate(5, NANO_TOP + 0.5, 0),
        box(5, 2.5, 7.6, 18.5, NANO_TOP + 1.25, 0),
        // reset button body and the voltage regulator
        box(6, 1.6, 3.6, -3.5, NANO_TOP + 0.8, 0),
        box(3, 1.1, 1.6, -14.5, NANO_TOP + 0.55, 5.2),
      ])!,
    ),
    metal: cached('nano-metal', () =>
      mergeGeometries([
        ...pins.flatMap((p) => [
          box(0.64, NANO_TOP + HOLE_DEPTH + 0.8, 0.64, p.x, (NANO_TOP + 0.8 - HOLE_DEPTH) / 2, p.z),
          // solder on top of each pad
          new THREE.SphereGeometry(0.75, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2)
            .scale(1, 0.6, 1)
            .translate(p.x, NANO_TOP, p.z),
        ]),
        // ICSP pins and the TQFP's legs
        ...[-1, 0, 1].flatMap((k) =>
          [-1, 1].map((side) => box(0.64, 6, 0.64, 18.5 + side * 1.27, NANO_TOP + 3, k * PITCH)),
        ),
        new THREE.BoxGeometry(8.6, 0.2, 8.6).rotateY(Math.PI / 4).translate(5, NANO_TOP + 0.1, 0),
      ])!,
    ),
    chrome: cached('nano-chrome', () =>
      mergeGeometries([
        // mini USB socket, overhanging the end, and the 16 MHz crystal
        new RoundedBoxGeometry(9.2, 4, 7.7, 2, 0.5).translate(-NANO.length / 2 + 3.3, NANO_TOP + 2, 0),
        new RoundedBoxGeometry(4.6, 1.3, 2.2, 2, 0.6).rotateY(Math.PI / 2).translate(12.5, NANO_TOP + 0.65, 0),
      ])!,
    ),
    button: cached('nano-button', () =>
      new THREE.CylinderGeometry(0.85, 0.85, 0.7, 16).translate(-3.5, NANO_TOP + 1.95, 0),
    ),
  };
}

function nanoPieces(pins: readonly V[]): Piece[] {
  const g = nanoParts();
  const matrix = placement(pins[0], pins[14], centroid(pins));
  nanoDecal ??= new THREE.MeshStandardMaterial({
    map: nanoTopTexture(NANO.length - 0.4, NANO.width - 0.4, nanoPins()),
    roughness: 0.5,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  const pieces: Piece[] = [
    { key: 'nano-pcb', geometry: g.pcb, material: nanoPcbMaterial, matrix },
    { key: 'nano-top', geometry: g.top, material: nanoDecal, matrix },
    { key: 'nano-black', geometry: g.black, material: epoxyMaterial, matrix },
    { key: 'nano-metal', geometry: g.metal, material: tinMaterial, matrix },
    { key: 'nano-chrome', geometry: g.chrome, material: nanoChromeMaterial, matrix },
    { key: 'nano-button', geometry: g.button, material: nanoButtonMaterial, matrix },
  ];
  const led = cached('nano-led', () => new THREE.BoxGeometry(1.6, 0.6, 0.8));
  for (const [name, at] of Object.entries(NANO_LEDS) as [NanoLed, V][]) {
    const color = NANO_LED_COLORS[name];
    pieces.push({
      key: `nano-led-${color}`,
      geometry: led,
      material: lensMaterial(color),
      matrix: matrix.clone().multiply(new THREE.Matrix4().makeTranslation(at.x, at.y, at.z)),
    });
  }
  return pieces;
}

/** Where to draw a Nano's lit LED: the power module's LED shape, shrunk and moved onto the Nano. */
export function nanoLedMatrix(part: THREE.Matrix4, led: NanoLed): THREE.Matrix4 {
  const at = NANO_LEDS[led];
  return part
    .clone()
    .multiply(new THREE.Matrix4().makeTranslation(at.x, at.y - 0.3, at.z))
    .multiply(new THREE.Matrix4().makeScale(0.55, 0.5, 0.4))
    .multiply(new THREE.Matrix4().makeTranslation(-POWER_LED.x, -PCB_TOP, -POWER_LED.z));
}

// ---- character LCD (16 × 2, HD44780) ----

/**
 * A 1602 module: an 80 × 36 mm board on a row of 16 header pins, a metal frame round the glass.
 * In its own frame pin 1 is at the left, the pins run along x, and the board reaches out towards
 * +z, so the text reads the right way up from the front of the desk.
 */
const LCD = { length: 80, width: 36, spacer: 2.5, pcb: 1.6, frame: { length: 71.2, width: 24.2, height: 7 } };
const LCD_PCB_TOP = LCD.spacer + LCD.pcb;
/** Where the board's middle is from the middle of the pins: pin 1 is 8 mm in from its left edge and 2.5 mm from its top. */
const LCD_CENTER = { x: LCD.length / 2 - 8 - 7.5 * PITCH, z: LCD.width / 2 - 2.5 };
/** The window in the frame where the glass shows, in the LCD's frame. The live screen is drawn on it. */
export const LCD_SCREEN = {
  center: new THREE.Vector3(LCD_CENTER.x, LCD_PCB_TOP + LCD.frame.height + 0.02, LCD_CENTER.z),
  length: 64.5,
  width: 16,
};

const lcdPcbMaterial = new THREE.MeshStandardMaterial({ color: 0x2c6a36, roughness: 0.55 });
const lcdFrameMaterial = new THREE.MeshStandardMaterial({ color: 0x2a2b2c, metalness: 0.55, roughness: 0.45 });
/** The glass with the backlight off: a dull olive green. */
const lcdGlassMaterial = new THREE.MeshStandardMaterial({ color: 0x8d985a, roughness: 0.3 });

function lcdParts(): {
  pcb: THREE.BufferGeometry;
  frame: THREE.BufferGeometry;
  glass: THREE.BufferGeometry;
  black: THREE.BufferGeometry;
  metal: THREE.BufferGeometry;
} {
  const box = (w: number, h: number, d: number, x: number, y: number, z: number): THREE.BufferGeometry =>
    new THREE.BoxGeometry(w, h, d).translate(x, y, z);
  const pinX = (i: number): number => (i - 7.5) * PITCH;
  const { x: cx, z: cz } = LCD_CENTER;
  return {
    pcb: cached('lcd-pcb', () =>
      new RoundedBoxGeometry(LCD.length, LCD.pcb, LCD.width, 2, 0.4).translate(cx, LCD.spacer + LCD.pcb / 2, cz),
    ),
    frame: cached('lcd-frame', () =>
      new RoundedBoxGeometry(LCD.frame.length, LCD.frame.height, LCD.frame.width, 2, 0.6).translate(
        cx,
        LCD_PCB_TOP + LCD.frame.height / 2,
        cz,
      ),
    ),
    glass: cached('lcd-glass', () =>
      new THREE.PlaneGeometry(LCD_SCREEN.length, LCD_SCREEN.width)
        .rotateX(-Math.PI / 2)
        .translate(cx, LCD_PCB_TOP + LCD.frame.height + 0.01, cz),
    ),
    black: cached('lcd-black', () =>
      mergeGeometries([
        // the header's plastic strip under the board
        box(16 * PITCH, LCD.spacer, 2.5, 0, LCD.spacer / 2, 0),
        // the four mounting holes, seen as dark rings on the board
        ...[-1, 1].flatMap((sx) =>
          [-1, 1].map((sz) =>
            new THREE.CylinderGeometry(1.6, 1.6, 0.05, 20).translate(
              cx + sx * (LCD.length / 2 - 2.5),
              LCD_PCB_TOP + 0.03,
              cz + sz * (LCD.width / 2 - 2.5),
            ),
          ),
        ),
      ])!,
    ),
    metal: cached('lcd-metal', () =>
      mergeGeometries(
        Array.from({ length: 16 }, (_, i) => [
          box(0.64, LCD_PCB_TOP + HOLE_DEPTH + 0.8, 0.64, pinX(i), (LCD_PCB_TOP + 0.8 - HOLE_DEPTH) / 2, 0),
          new THREE.SphereGeometry(0.75, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2)
            .scale(1, 0.6, 1)
            .translate(pinX(i), LCD_PCB_TOP, 0),
        ]).flat(),
      )!,
    ),
  };
}

function lcdPieces(pins: readonly V[]): Piece[] {
  const g = lcdParts();
  const matrix = placement(pins[0], pins[15], centroid(pins));
  return [
    { key: 'lcd-pcb', geometry: g.pcb, material: lcdPcbMaterial, matrix },
    { key: 'lcd-frame', geometry: g.frame, material: lcdFrameMaterial, matrix },
    { key: 'lcd-glass', geometry: g.glass, material: lcdGlassMaterial, matrix },
    { key: 'lcd-black', geometry: g.black, material: epoxyMaterial, matrix },
    { key: 'lcd-metal', geometry: g.metal, material: tinMaterial, matrix },
  ];
}

// ---- dispatch ----

export interface PartOptions {
  value?: number;
  state?: number;
  pressed?: boolean;
  /** A push button kept down by its Hold popup. */
  held?: boolean;
  /** Power modules: -1 at the left end of a board, +1 at the right end. */
  facing?: number;
}

export function partPieces(def: PartDef, pins: readonly V[], options: PartOptions = {}): Piece[] {
  switch (def.kind) {
    case 'dip':
      return chipPieces(def, pins);
    case 'led':
      return ledPieces(def, pins, options.value ?? 5);
    case 'resistor':
      return resistorPieces(options.value ?? 470, pins);
    case 'power':
      return powerPieces(pins, options.facing ?? -1, options.state ?? 0);
    case 'button':
      return buttonPieces(pins, !!options.pressed, !!options.held);
    case 'dipswitch':
      return switchPieces(def.positions, pins, options.state ?? 0);
    case 'capacitor':
      return capacitorPieces(def, pins, options.value ?? (def.style === 'ceramic' ? 100e-9 : 1e-6));
    case 'diode':
      return diodePieces(def, pins);
    case 'pot':
      return potPieces(pins, options.state ?? 500);
    case 'slide':
      return slidePieces(pins, options.state ?? 0);
    case 'transistor':
      return transistorPieces(def, pins);
    case 'display':
      return displayPieces(pins);
    case 'bargraph':
      return barGraphPieces(def, pins);
    case 'network':
      return networkPieces(def, pins, options.value ?? 1000);
    case 'nano':
      return nanoPieces(pins);
    case 'lcd':
      return lcdPieces(pins);
  }
}

/** A stand-alone copy of a part, for placement previews. */
export function buildPart(def: PartDef, pins: readonly V[], options: PartOptions = {}): THREE.Group {
  return piecesToGroup(partPieces(def, pins, options));
}

/** A part's two legs, each from its hole in to where it meets the body: they splay out when the holes are further apart. */
function legObstacles(pins: readonly V[], top: number, radius: number): Obstacle[] {
  const mid = midpoint(pins[0], pins[1]);
  const span = legSpan(pins);
  return [pins[0], pins[1]].map((p) =>
    capsuleObstacle(p, span > PITCH + 0.01 ? mid.clone().lerp(p, PITCH / span) : p, radius, top),
  );
}

/** An axial part lying on its legs: the legs run out to their holes at the height of its body. */
function axialObstacles(pins: readonly V[], half: number, radius: number, axis: number): Obstacle[] {
  if (legSpan(pins) < STAND_SPAN) return [capsuleObstacle(pins[0], pins[1], radius + 0.05, H + standTop(half) + 0.3)];
  const mid = midpoint(pins[0], pins[1]);
  const along = pins[1]
    .clone()
    .sub(pins[0])
    .setY(0)
    .normalize()
    .multiplyScalar(Math.max(0, half - radius));
  return [
    capsuleObstacle(pins[0], pins[1], 0.3, H + axis + 0.3),
    capsuleObstacle(mid.clone().sub(along), mid.clone().add(along), radius + 0.05, H + axis + radius),
  ];
}

/**
 * The solid pieces of a part that wires keep out of. Leaded parts block only at their legs and
 * bodies, so a wire can pass right beside one, or under an LED's lens up on its legs.
 */
export function partObstacles(def: PartDef, pins: readonly V[], options: PartOptions = {}): Obstacle[] {
  switch (def.kind) {
    case 'dip': {
      const { length, width, span } = chipSize(def);
      const c = centroid(pins);
      // The body and the legs coming down from its sides.
      const half = Math.max(width, span + 0.7) / 2;
      return [boxObstacle(c.x - length / 2, c.x + length / 2, c.z - half, c.z + half, H + CHIP_TOP)];
    }
    case 'led': {
      const size = options.value ?? 5;
      return [
        ...legObstacles(pins, H + LED_BASE + 1, 0.24),
        discObstacle(midpoint(pins[0], pins[1]), ledShape(size).flange, H + ledTop(size), H + LED_BASE),
      ];
    }
    case 'resistor':
      return axialObstacles(pins, RES_LEN / 2, 1.25, RES_AXIS);
    case 'power': {
      const x = pins[0].x;
      const f = options.facing ?? -1;
      // Local x along the board to world x: the module is turned round at the right-hand end.
      const along = (a: number, b: number): [number, number] => [
        Math.min(x - f * a, x - f * b),
        Math.max(x - f * a, x - f * b),
      ];
      const z = (pins[0].z + pins[3].z) / 2;
      const top = H + PCB_TOP + 3.2;
      // The board is up on its pin headers: wires go under it, but not through the headers.
      const headers = [-1, 1].map((side) =>
        boxObstacle(x - 1.2, x + 1.2, z + side * 8 * PITCH - 2.55, z + side * 8 * PITCH + 2.55, H + PCB_Y),
      );
      const arms = [-1, 1].map((side) =>
        boxObstacle(
          ...along(BODY_INNER, ARM_INNER),
          side < 0 ? z - ARM_FAR : z + ARM_NEAR,
          side < 0 ? z - ARM_NEAR : z + ARM_FAR,
          top,
          H + PCB_Y,
        ),
      );
      // Across the module, local z to world z (turned round at the right-hand end, so mirrored).
      const across = (a: number, b: number): [number, number] => [
        Math.min(z - f * a, z - f * b),
        Math.max(z - f * a, z - f * b),
      ];
      const body = boxObstacle(
        ...along(OUTER, BODY_INNER),
        z - PCB_WIDTH / 2,
        z + PCB_WIDTH / 2,
        H + PCB_TOP + 6.4,
        H + PCB_Y,
      );
      const jack = boxObstacle(
        ...along(JACK.x0, JACK.x1),
        ...across(JACK.z0, JACK.z1),
        H + PCB_TOP + JACK.top,
        H + PCB_Y,
      );
      return [body, jack, ...arms, ...headers];
    }
    case 'button': {
      const c = centroid(pins);
      return [boxObstacle(c.x - 3.2, c.x + 3.2, c.z - 3.2, c.z + 3.2, H + BUTTON_TOP + 1.4)];
    }
    case 'dipswitch': {
      const { length, width } = switchSize(def.positions);
      const c = centroid(pins);
      return [
        boxObstacle(c.x - length / 2, c.x + length / 2, c.z - width / 2, c.z + width / 2, H + 0.4 + SWITCH_H + 0.8),
      ];
    }
    case 'capacitor': {
      const mid = midpoint(pins[0], pins[1]);
      if (def.style === 'ceramic') {
        // A disc standing up in line with its legs.
        const along = pins[1]
          .clone()
          .sub(pins[0])
          .setY(0)
          .normalize()
          .multiplyScalar(DISC_R - DISC_T);
        return [
          ...legObstacles(pins, H + DISC_Y - 1.2, 0.25),
          capsuleObstacle(
            mid.clone().sub(along),
            mid.clone().add(along),
            DISC_T,
            H + DISC_Y + DISC_R,
            H + DISC_Y - DISC_R,
          ),
        ];
      }
      // A can stands on the board, or up on its legs when they're bent out.
      const { r, h } = canSize(options.value ?? 1e-6);
      const lift = Math.abs(legSpan(pins) - PITCH) < 0.01 ? 0 : 2.4;
      return [...legObstacles(pins, H + 0.6 + lift, 0.27), discObstacle(mid, r, H + 0.5 + lift + h, H + 0.5 + lift)];
    }
    case 'diode': {
      const size = def.glass ? DIODE.glass : DIODE.epoxy;
      return axialObstacles(pins, size.half, size.radius, size.axis);
    }
    case 'pot': {
      const c = pins[1];
      return [
        boxObstacle(
          c.x - POT_BODY / 2,
          c.x + POT_BODY / 2,
          c.z - POT_BODY / 2,
          c.z + POT_BODY / 2,
          H + POT_KNOB_TOP + 0.3,
        ),
      ];
    }
    case 'slide': {
      const c = pins[1];
      return [boxObstacle(c.x - 4.4, c.x + 4.4, c.z - 1.9, c.z + 1.9, H + SLIDE_TOP + 2.7)];
    }
    case 'transistor': {
      const c = pins[1];
      return [boxObstacle(c.x - 2.5, c.x + 2.5, c.z - 2.5, c.z + 2.5, H + TO92.base + TO92.height + 0.3)];
    }
    case 'display': {
      const c = centroid(pins);
      return [
        boxObstacle(
          c.x - DISPLAY.length / 2,
          c.x + DISPLAY.length / 2,
          c.z - DISPLAY.width / 2,
          c.z + DISPLAY.width / 2,
          H + DISPLAY.top,
        ),
      ];
    }
    case 'bargraph': {
      const c = centroid(pins);
      return [
        boxObstacle(c.x - BAR.length / 2, c.x + BAR.length / 2, c.z - BAR.width / 2, c.z + BAR.width / 2, H + BAR.top),
      ];
    }
    case 'network': {
      // Turned or not, it stands along its row.
      const a = pins[0];
      const b = pins[pins.length - 1];
      const along = Math.abs(b.x - a.x) >= Math.abs(b.z - a.z);
      const c = centroid(pins);
      const half = (pins.length * PITCH) / 2;
      const t = SIP.thick / 2 + 0.2;
      return along
        ? [boxObstacle(c.x - half, c.x + half, c.z - t, c.z + t, H + 0.6 + SIP.height)]
        : [boxObstacle(c.x - t, c.x + t, c.z - half, c.z + half, H + 0.6 + SIP.height)];
    }
    case 'lcd': {
      // It rides on its header, its board reaching out to the screen side (away from the
      // viewer when it's flipped). Wires can pass under it; nothing tall can.
      const c = centroid(pins);
      const dir = pins[15].x >= pins[0].x ? 1 : -1;
      const x = c.x + dir * LCD_CENTER.x;
      const z = c.z + dir * LCD_CENTER.z;
      return [
        boxObstacle(
          x - LCD.length / 2,
          x + LCD.length / 2,
          z - LCD.width / 2,
          z + LCD.width / 2,
          H + LCD_PCB_TOP + LCD.frame.height + 0.3,
          H + LCD.spacer,
        ),
        boxObstacle(c.x - 8 * PITCH, c.x + 8 * PITCH, c.z - 1.25, c.z + 1.25, H + LCD.spacer),
      ];
    }
    case 'nano': {
      // Flipped or not, its long side runs along the board. It rides on its header strips, so
      // wires can pass under it between them.
      const c = centroid(pins);
      const half = NANO.length / 2 + 1.5;
      const strips = [-1, 1].map((side) =>
        boxObstacle(
          c.x - 7.5 * PITCH,
          c.x + 7.5 * PITCH,
          c.z + (side * NANO.span) / 2 - 1.25,
          c.z + (side * NANO.span) / 2 + 1.25,
          H + NANO.spacer,
        ),
      );
      return [
        boxObstacle(
          c.x - half,
          c.x + half,
          c.z - NANO.width / 2,
          c.z + NANO.width / 2,
          H + NANO_TOP + 4.2,
          H + NANO.spacer,
        ),
        ...strips,
      ];
    }
  }
}

/** The LED lens, for drawing it lit up. */
export function ledLensGeometry(size: number): THREE.BufferGeometry {
  return ledBody(size);
}

/** Middle of an LED's dome in its local frame, where the glow sits. */
export function ledDome(size: number): THREE.Vector3 {
  const shape = ledShape(size);
  return new THREE.Vector3(0, LED_BASE + 1 + shape.straight + shape.body * 0.32, 0);
}

/** The glowing chip inside a lit LED: a small bright core just above the reflector cup. */
export function ledCoreGeometry(size: number): THREE.BufferGeometry {
  const k = size === 3 ? 0.62 : 1;
  return cached(`led-core-${size}`, () =>
    new THREE.SphereGeometry(0.9 * k, 14, 10).scale(1, 1.25, 1).translate(0, LED_BASE + 1 + 2.6 * k, 0),
  );
}
