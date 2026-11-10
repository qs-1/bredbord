// The landing page's board, live in 3D: a breadboard the size and shape of a BB830, but made for this
// page (no joining tabs or notches, softly rounded), its logo standing in a panel sunk into its back. It starts upside
// down; scrolling turns it over, exactly as far as you've scrolled. Drawn only when something changes.

import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import Lenis from 'lenis';
import { boardSpec, gridZ, RAIL_GRID_ROW, SEAM_Z } from '../engine/breadboard';
import '../fonts.css';
import { canvasFont, loadFonts } from '../fonts';
import { Clock } from './clock';
import { tryButton } from './try';

const spec = boardSpec('bb830');
const X0 = -spec.length / 2;
const X1 = spec.length / 2;
/** Plain plastic beyond the outer rails, as on a real board. */
const MARGIN = 2.4;
const Z0 = -spec.width / 2 - MARGIN;
const Z1 = spec.width / 2 + MARGIN;
const LX = X1 - X0;
const LZ = Z1 - Z0;
const TOP = spec.height;
const BOTTOM = 0;
const CORNER = 1.8;
const BEVEL = 0.5;
const CHANNEL = { half: 1.4, depth: 2.4 };
const PLASTIC = '#efeee9';
const colX = (col: number): number => -78.74 + (col - 1) * 2.54;
/** Lifted off the floor so it can turn over; the floor only catches its shadow. */
const LIFT = 12;
/** Room kept along the bottom of a tall screen for the Try it button, CSS px. */
const TRY_ROOM = 96;
/** How far the tallest parts on the front stand above it. */
const PARTS_TALL = 12;

// ---- shapes ----

function roundedRect(x0: number, x1: number, y0: number, y1: number, r: number): THREE.Shape {
  const s = new THREE.Shape();
  s.moveTo(x0 + r, y0);
  s.lineTo(x1 - r, y0);
  s.quadraticCurveTo(x1, y0, x1, y0 + r);
  s.lineTo(x1, y1 - r);
  s.quadraticCurveTo(x1, y1, x1 - r, y1);
  s.lineTo(x0 + r, y1);
  s.quadraticCurveTo(x0, y1, x0, y1 - r);
  s.lineTo(x0, y0 + r);
  s.quadraticCurveTo(x0, y0, x0 + r, y0);
  return s;
}

/** Texture coordinates from x, z: the whole board is 0..1 each way. */
function mapUV(g: THREE.BufferGeometry, flipV: boolean): void {
  const p = g.getAttribute('position');
  const uv = new Float32Array(p.count * 2);
  for (let i = 0; i < p.count; i++) {
    uv[2 * i] = (p.getX(i) - X0) / LX;
    const v = (p.getZ(i) - Z0) / LZ;
    uv[2 * i + 1] = flipV ? v : 1 - v;
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
}

function speckle(g: CanvasRenderingContext2D, w: number, h: number, count: number): void {
  for (let i = 0; i < count; i++) {
    g.fillStyle = i % 2 ? 'rgba(60,50,30,0.03)' : 'rgba(255,255,255,0.5)';
    g.fillRect(Math.random() * w, Math.random() * h, 2, 2);
  }
}

// ---- the top: the BB830's print ----

/** Each hole's mouth, cut out of the top's texture; the hole itself is geometry under it. */
const MOUTH = 1.62;

function cutHole(g: CanvasRenderingContext2D, cx: number, cy: number, mm: (v: number) => number): void {
  g.globalCompositeOperation = 'destination-out';
  g.beginPath();
  g.roundRect(cx - mm(MOUTH) / 2, cy - mm(MOUTH) / 2, mm(MOUTH), mm(MOUTH), mm(0.3));
  g.fill();
  g.globalCompositeOperation = 'source-over';
}

/**
 * One hole, as it is in a real board: a short square funnel down to the opening, then a dark shaft
 * with the spring clip's contact just showing at the bottom. Shared by every hole, drawn instanced.
 */
function holeGeometry(): THREE.BufferGeometry {
  const a = MOUTH / 2 + 0.02;
  const b = 0.55;
  const slope = 0.4;
  const shaft = 1.9;
  const pos: number[] = [];
  const col: number[] = [];
  const quad = (p: number[][], c: number[][]): void => {
    for (const i of [0, 1, 2, 0, 2, 3]) {
      pos.push(...p[i]);
      col.push(...c[i]);
    }
  };
  const lip = [0.66, 0.64, 0.6];
  const mid = [0.2, 0.19, 0.18];
  const deep = [0.02, 0.02, 0.022];
  const metal = [0.045, 0.045, 0.045];
  const y1 = -slope;
  const y2 = -slope - shaft;
  // Corners round the square, in order, at a half-width.
  const ring = (h: number, y: number): number[][] => [
    [-h, y, -h],
    [h, y, -h],
    [h, y, h],
    [-h, y, h],
  ];
  const top = ring(a, 0);
  const open = ring(b, y1);
  const bottom = ring(b, y2);
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    quad([top[i], top[j], open[j], open[i]], [lip, lip, mid, mid]);
    quad([open[i], open[j], bottom[j], bottom[i]], [mid, mid, deep, deep]);
  }
  quad(bottom, [metal, metal, metal, metal]);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.computeVertexNormals();
  return g;
}

function topTexture(maxAniso: number): THREE.CanvasTexture {
  const k = 20;
  const c = document.createElement('canvas');
  c.width = Math.round(LX * k);
  c.height = Math.round(LZ * k);
  const g = c.getContext('2d')!;
  const X = (x: number): number => (x - X0) * k;
  const Z = (z: number): number => (z - Z0) * k;
  const mm = (v: number): number => v * k;
  g.fillStyle = PLASTIC;
  g.fillRect(0, 0, c.width, c.height);
  speckle(g, c.width, c.height, 4000);
  const stripe = (z: number, color: string): void => {
    g.fillStyle = color;
    const x0 = X(colX(1)) - mm(0.8);
    g.fillRect(x0, Z(z) - mm(0.22), X(colX(spec.columns)) + mm(0.8) - x0, mm(0.44));
  };
  const edge = spec.width / 2 - 0.9;
  const seam = SEAM_Z + 0.9;
  stripe(-edge, '#d9473f');
  stripe(-seam, '#3c6ed6');
  stripe(seam, '#d9473f');
  stripe(edge, '#3c6ed6');
  for (const h of spec.holes) cutHole(g, X(h.x), Z(h.z), mm);
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillStyle = '#5b5852';
  g.font = canvasFont('mono', 600, mm(1.7));
  for (let n = 1; n <= spec.columns; n++) {
    if (n !== 1 && n % 5 !== 0) continue;
    g.fillText(String(n), X(colX(n)), Z(gridZ(-0.8)));
    g.fillText(String(n), X(colX(n)), Z(gridZ(11.8)));
  }
  const rows = [...'abcde'].map((r, i) => [r, i] as const).concat([...'fghij'].map((r, i) => [r, i + 7] as const));
  for (const [r, row] of rows) {
    g.fillText(r, X(colX(1) - 0.74 * 2.54), Z(gridZ(row)));
    g.fillText(r, X(colX(spec.columns) + 0.74 * 2.54), Z(gridZ(row)));
  }
  g.font = canvasFont('label', 700, mm(2.1));
  for (const [name, row] of Object.entries(RAIL_GRID_ROW)) {
    const plus = name.endsWith('+');
    g.fillStyle = plus ? '#d9473f' : '#3c6ed6';
    g.fillText(plus ? '+' : '−', X(colX(1) + 1), Z(gridZ(row)));
    g.fillText(plus ? '+' : '−', X(colX(spec.columns) - 1), Z(gridZ(row)));
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = maxAniso;
  return t;
}

// ---- the back: a sunken panel, and the logo standing up in it, one block per pixel ----

const LOGO = [
  '###...###...###..###...###....##...###...###.',
  '#..#..#..#..#....#..#..#..#..#..#..#..#..#..#',
  '####..###...###..#..#..####..#..#..###...#..#',
  '#..#..#.#...#....#..#..#..#..#..#..#.#...#..#',
  '###...#..#..###..###...###....##...#..#..###.',
];
/** The flat border round the panel. */
const RIM = 4;
/** How far the panel is sunk. The logo's blocks stand up from its floor, their faces level with the rim. */
const RECESS = 1.2;
/** The logo's pixels sit on the holes' grid, so each one is right behind a column of holes. */
const PITCH = 2.54;
const PIXEL = 2.14;
const BAR = 44 * PITCH + PIXEL;
const FOOT = { r: 2.6, proud: 0.6 };
const FEET: [number, number][] = [
  [-71.5, 17.5 + MARGIN],
  [71.5, 17.5 + MARGIN],
  [-71.5, -17.5 - MARGIN],
  [71.5, -17.5 - MARGIN],
];

/**
 * On a tall screen the board stands with its long side up and down, so the logo and the line of type
 * are laid across it instead, smaller, to read upright when it's face down.
 */
let tall = false;

/** How the back is laid out, as you look at it: u across, v up, mm. */
const BACK = {
  wide: { scale: 1, logo: 3.2, text: -15.6, type: 3.1 },
  tall: { scale: 0.4, logo: 5, text: -5.5, type: 2.5 },
};

/** A place on the back, as you look at it, in the board's x, z. */
const backAt = (u: number, v: number): [number, number] => (tall ? [-v, u] : [u, v]);

/** What stands on the back's floor: the logo's pixels and its two bars, as rectangles in x, z. */
function logoBlocks(): { x: number; z: number; wx: number; wz: number }[] {
  const b = tall ? BACK.tall : BACK.wide;
  const p = PITCH * b.scale;
  const rect = (u: number, v: number, wu: number, wv: number): { x: number; z: number; wx: number; wz: number } => {
    const [x, z] = backAt(u, v);
    return tall ? { x, z, wx: wv, wz: wu } : { x, z, wx: wu, wz: wv };
  };
  const out: { x: number; z: number; wx: number; wz: number }[] = [];
  LOGO.forEach((row, j) =>
    [...row].forEach((ch, i) => {
      if (ch === '#') out.push(rect((i - 22) * p, b.logo + (2 - j) * p, PIXEL * b.scale, PIXEL * b.scale));
    }),
  );
  for (const v of [b.logo + 5 * p, b.logo - 5 * p]) out.push(rect(0, v, BAR * b.scale, PIXEL * b.scale));
  return out;
}

const panel = (inset: number): THREE.Shape =>
  roundedRect(X0 + RIM + inset, X1 - RIM - inset, Z0 + RIM + inset, Z1 - RIM - inset, 1.6 - inset);

/**
 * The panel's floor: a matte, stippled mould finish, a shade deeper than the rim, with the line of
 * type printed on it. Contact shade is baked in round everything standing on it and along its walls,
 * with the soft shadow the light from the upper left throws down and to the right.
 */
function floorTextures(maxAniso: number): { map: THREE.CanvasTexture; normalMap: THREE.DataTexture } {
  const k = 12;
  const w = Math.round(LX * k);
  const h = Math.round(LZ * k);
  const mm = (v: number): number => v * k;
  const px = (x: number): number => (x - X0) * k;
  const pz = (z: number): number => (Z1 - z) * k;
  const canvas = (): [HTMLCanvasElement, CanvasRenderingContext2D] => {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return [c, c.getContext('2d')!];
  };
  // What stands on the floor.
  const [fc, fg] = canvas();
  fg.fillStyle = '#000';
  for (const b of logoBlocks()) fg.fillRect(px(b.x - b.wx / 2), pz(b.z + b.wz / 2), mm(b.wx), mm(b.wz));
  for (const [x, z] of FEET) {
    fg.beginPath();
    fg.arc(px(x), pz(z), mm(FOOT.r), 0, Math.PI * 2);
    fg.fill();
  }
  // The walls, as a frame round the floor.
  const [wc, wg] = canvas();
  wg.fillRect(0, 0, w, h);
  wg.globalCompositeOperation = 'destination-out';
  wg.beginPath();
  wg.roundRect(mm(RIM + 0.5), mm(RIM + 0.5), w - 2 * mm(RIM + 0.5), h - 2 * mm(RIM + 0.5), mm(1.1));
  wg.fill();

  const [cc, cg] = canvas();
  cg.fillStyle = '#e2dfd6';
  cg.fillRect(0, 0, w, h);
  speckle(cg, w, h, 9000);
  cg.filter = `blur(${mm(1.2)}px)`;
  cg.globalAlpha = 0.3;
  cg.drawImage(fc, 0, 0);
  cg.drawImage(wc, 0, 0);
  cg.filter = `blur(${mm(0.45)}px)`;
  cg.globalAlpha = 0.34;
  // Down and to the right as you look at it, whichever way the board stands.
  const [sx, sy] = tall ? [0.35, -0.6] : [0.6, 0.35];
  cg.drawImage(fc, mm(sx), mm(sy));
  cg.drawImage(wc, mm(sx), mm(sy));
  cg.filter = 'none';
  cg.globalAlpha = 1;
  cg.fillStyle = 'rgba(92, 86, 76, 0.92)';
  const back = tall ? BACK.tall : BACK.wide;
  cg.font = `500 ${mm(back.type)}px "Atkinson Hyperlegible Next", sans-serif`;
  cg.textAlign = 'center';
  cg.textBaseline = 'middle';
  const [tx, tz] = backAt(0, back.text);
  cg.translate(px(tx), pz(tz));
  if (tall) cg.rotate(-Math.PI / 2);
  cg.fillText('A free 3D breadboard simulator', 0, 0);
  cg.setTransform(1, 0, 0, 1, 0, 0);
  const map = new THREE.CanvasTexture(cc);
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = maxAniso;

  // The stipple: a small tile of rounded bumps, repeated across the floor.
  const n = 96;
  let hgt = Float32Array.from({ length: n * n }, () => Math.random());
  const wrap = (x: number, y: number): number => ((y + n) % n) * n + ((x + n) % n);
  for (let pass = 0; pass < 2; pass++) {
    const next = new Float32Array(n * n);
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++) {
        let s = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) s += hgt[wrap(x + dx, y + dy)];
        next[y * n + x] = s / 9;
      }
    hgt = next;
  }
  const d = new Uint8Array(n * n * 4);
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const dx = (hgt[wrap(x + 1, y)] - hgt[wrap(x - 1, y)]) * 14;
      const dy = (hgt[wrap(x, y + 1)] - hgt[wrap(x, y - 1)]) * 14;
      const len = Math.hypot(dx, dy, 1);
      const i = (y * n + x) * 4;
      d[i] = (-dx / len) * 127.5 + 127.5;
      d[i + 1] = (-dy / len) * 127.5 + 127.5;
      d[i + 2] = (1 / len) * 127.5 + 127.5;
      d[i + 3] = 255;
    }
  const normalMap = new THREE.DataTexture(d, n, n);
  normalMap.wrapS = normalMap.wrapT = THREE.RepeatWrapping;
  normalMap.repeat.set(LX / 6, LZ / 6);
  normalMap.magFilter = THREE.LinearFilter;
  normalMap.minFilter = THREE.LinearMipmapLinearFilter;
  normalMap.generateMipmaps = true;
  normalMap.anisotropy = maxAniso;
  normalMap.needsUpdate = true;
  return { map, normalMap };
}

// ---- the board ----

/**
 * One body: a top plate with the centre channel cut through it, over a body whose top is the channel's
 * floor, over a rim round the sunken panel on the back. Each meets the next where its rounded edge
 * begins, so the sides read as one surface. The panel's floor is a plane just inside the rim's walls.
 */
function buildBoard(maxAniso: number): THREE.Group {
  const group = new THREE.Group();
  // The holes are cut out of the top's texture, so it's drawn with its alpha as a stencil.
  const top = new THREE.MeshStandardMaterial({
    map: topTexture(maxAniso),
    roughness: 0.62,
    alphaTest: 0.5,
    alphaToCoverage: true,
  });
  const side = new THREE.MeshStandardMaterial({ color: PLASTIC, roughness: 0.62 });
  const satin = new THREE.MeshStandardMaterial({ color: PLASTIC, roughness: 0.46 });
  const channel = new THREE.MeshStandardMaterial({ color: 0xc9c6bf, roughness: 0.85 });
  const extrude = (shape: THREE.Shape, y0: number, y1: number): THREE.ExtrudeGeometry => {
    const g = new THREE.ExtrudeGeometry(shape, {
      depth: y1 - y0 - 2 * BEVEL,
      bevelEnabled: true,
      bevelThickness: BEVEL,
      bevelSize: BEVEL,
      bevelSegments: 4,
      curveSegments: 8,
    });
    g.rotateX(-Math.PI / 2);
    g.translate(0, y0 + BEVEL, 0);
    mapUV(g, false);
    return g;
  };
  // Only the body casts a shadow, and only the floor under it takes one: the small relief has its
  // shade drawn in, which keeps the shadow pass cheap enough to redraw on every frame of the turn.
  const add = (m: THREE.Mesh, cast = false): void => {
    m.castShadow = cast;
    group.add(m);
  };
  const floorY = TOP - CHANNEL.depth;
  const outline = (): THREE.Shape => roundedRect(X0 + BEVEL, X1 - BEVEL, -(Z1 - BEVEL), -(Z0 + BEVEL), CORNER);
  // The channel, a round-ended slot through the top plate that stops short of the ends, so the
  // board's outline is never broken.
  const plate = outline();
  const w = CHANNEL.half - BEVEL;
  plate.holes.push(roundedRect(colX(1) - 2.2 + BEVEL, colX(spec.columns) + 2.2 - BEVEL, -w, w, w));
  // The front catches the shadows of the parts and wires on it.
  const front = new THREE.Mesh(extrude(plate, floorY - 2 * BEVEL, TOP), [top, side]);
  const middle = new THREE.Mesh(extrude(outline(), RECESS, floorY), [channel, side]);
  front.receiveShadow = middle.receiveShadow = true;
  add(front, true);
  add(middle, true);
  const ring = outline();
  ring.holes.push(panel(0));
  add(new THREE.Mesh(extrude(ring, BOTTOM, RECESS + 2 * BEVEL), [satin, side]), true);
  const holes = new THREE.InstancedMesh(
    holeGeometry(),
    new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7, side: THREE.DoubleSide }),
    spec.holes.length,
  );
  const at = new THREE.Matrix4();
  spec.holes.forEach((h, i) => holes.setMatrixAt(i, at.makeTranslation(h.x, TOP, h.z)));
  add(holes);

  const { map, normalMap } = floorTextures(maxAniso);
  const floor = new THREE.ShapeGeometry(panel(0.35), 8).rotateX(Math.PI / 2);
  floor.translate(0, BOTTOM + RECESS - 0.02, 0);
  mapUV(floor, true);
  const floorMat = new THREE.MeshStandardMaterial({
    map,
    normalMap,
    normalScale: new THREE.Vector2(0.3, 0.3),
    roughness: 0.9,
  });
  add(new THREE.Mesh(floor, floorMat));

  // The logo: a block for each pixel, its face level with the rim, its foot sunk into the floor.
  const high = RECESS + 0.4;
  const block = (b: { x: number; z: number; wx: number; wz: number }): THREE.BufferGeometry =>
    new RoundedBoxGeometry(b.wx, high, b.wz, 3, Math.min(0.28, b.wx / 3, b.wz / 3)).translate(
      b.x,
      BOTTOM + high / 2,
      b.z,
    );
  const blocks = logoBlocks();
  const bars = blocks.splice(-2);
  add(new THREE.Mesh(mergeGeometries(blocks.map(block)), satin));
  const paint = (color: string): THREE.MeshStandardMaterial =>
    new THREE.MeshStandardMaterial({ color, roughness: 0.42 });
  add(new THREE.Mesh(block(bars[0]), paint('#d8392e')));
  add(new THREE.Mesh(block(bars[1]), paint('#2e63d2')));

  // Four soft feet, standing a little proud of the rim.
  const profile = [
    [0, -FOOT.proud],
    [FOOT.r - 0.7, -FOOT.proud],
    [FOOT.r - 0.25, -FOOT.proud + 0.12],
    [FOOT.r - 0.03, -FOOT.proud + 0.4],
    [FOOT.r, -FOOT.proud + 0.8],
    [FOOT.r, RECESS + 0.3],
  ].map(([r, y]) => new THREE.Vector2(r, y));
  const rubber = new THREE.MeshStandardMaterial({ color: 0xb3ada2, roughness: 0.8, side: THREE.DoubleSide });
  const foot = new THREE.LatheGeometry(profile, 40);
  add(new THREE.Mesh(mergeGeometries(FEET.map(([x, z]) => foot.clone().translate(x, BOTTOM, z))), rubber));
  return group;
}

// ---- the scene ----

/**
 * The most canvas pixels per CSS pixel. Phones are mostly 3×: drawn at 2× and stretched to fit, the
 * board came out soft and its edges stepped. A computer screen is at most 2×, and draws more of them.
 */
const MAX_DPR = matchMedia('(pointer: coarse)').matches ? 3 : 2;

async function main(): Promise<void> {
  await Promise.all([loadFonts(), document.fonts.load('500 30px "Atkinson Hyperlegible Next"')]);
  const canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  // On a sharp screen the pixels are small enough to go without multisampling, which costs the most there.
  const dpr = Math.min(devicePixelRatio, MAX_DPR);
  const r = new THREE.WebGLRenderer({ canvas, antialias: dpr < 1.5, alpha: true, powerPreference: 'high-performance' });
  r.setPixelRatio(dpr);
  r.outputColorSpace = THREE.SRGBColorSpace;
  r.toneMapping = THREE.NeutralToneMapping;
  r.shadowMap.enabled = true;
  r.shadowMap.type = THREE.VSMShadowMap;
  // Shadows are redrawn only when something moves, not when a light blinks.
  r.shadowMap.autoUpdate = false;
  r.toneMappingExposure = 0.86;
  const aniso = r.capabilities.getMaxAnisotropy();

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(r);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  pmrem.dispose();
  scene.environmentIntensity = 0.22;
  scene.add(new THREE.HemisphereLight(0xfff8ee, 0xb8b0a2, 0.7));
  const key = new THREE.DirectionalLight(0xffeedb, 1.7);
  key.position.set(-1, 0.62, -0.7).normalize().multiplyScalar(400);
  key.position.y += LIFT;
  key.target.position.set(0, LIFT, 0);
  key.castShadow = true;
  // The shadow is soft anyway, so a small map with a short blur looks the same and redraws far faster.
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.radius = 8;
  key.shadow.blurSamples = 12;
  Object.assign(key.shadow.camera, { left: -115, right: 115, top: 115, bottom: -115, near: 200, far: 650 });
  key.shadow.bias = -0.0005;
  key.shadow.normalBias = 0.2;
  const rim = new THREE.DirectionalLight(0xe6edff, 0.3);
  rim.position.set(0.8, 0.5, -0.6).normalize().multiplyScalar(400);
  scene.add(key, key.target, rim);
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(2000, 2000).rotateX(-Math.PI / 2),
    new THREE.ShadowMaterial({ opacity: 0.16 }),
  );
  floor.receiveShadow = true;
  scene.add(floor);

  // On a tall screen the whole board is turned a quarter round, its long side up and down; it still
  // turns over about its own length. The lights stay put, so they still come from the upper left.
  const turn = new THREE.Group();
  const holder = new THREE.Group();
  turn.add(holder);
  scene.add(turn);
  let board = new THREE.Group();

  // Straight above, looking down at the board flat in front of you: the back to start, the front to finish.
  const cam = new THREE.PerspectiveCamera(20, 1, 20, 3000);
  cam.up.set(0, 0, -1);
  const fit = (): void => {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (!board.parent || tall !== w < h) {
      tall = w < h;
      clock.group.removeFromParent();
      board.removeFromParent();
      board.traverse((o) => {
        if (!(o instanceof THREE.Mesh)) return;
        o.geometry.dispose();
        for (const m of [o.material].flat()) {
          (m as THREE.MeshStandardMaterial).map?.dispose();
          (m as THREE.MeshStandardMaterial).normalMap?.dispose();
          m.dispose();
        }
      });
      board = buildBoard(aniso);
      board.position.y = -(TOP + BOTTOM) / 2; // turn about the board's middle
      board.add(clock.group);
      holder.add(board);
      turn.rotation.y = tall ? -Math.PI / 2 : 0;
    }
    // Read each time: browser zoom changes the pixel ratio, and kept from page load, zooming out drew
    // ever more pixels.
    r.setPixelRatio(Math.min(devicePixelRatio, MAX_DPR));
    r.setSize(w, h, false);
    cam.aspect = w / h;
    // Far enough that the board, with room round it, fits both ways.
    const half = THREE.MathUtils.degToRad(cam.fov / 2);
    const [across, along] = tall ? [LZ * 1.3, LX * 1.24] : [LX * 1.5, LZ * 2.3];
    const byWidth = across / (2 * Math.tan(half) * cam.aspect);
    // On a tall screen the Try it button is pinned along the bottom: the board fits the space above it.
    const reserve = tall ? Math.min(TRY_ROOM, h * 0.2) : 0;
    const byHeight = (along / (2 * Math.tan(half))) * (h / (h - reserve));
    const dist = Math.max(byWidth, byHeight);
    // Moving the camera towards the bottom of the screen (+z) lifts the board up out of the button's way.
    const shift = (reserve / 2) * ((2 * Math.tan(half) * dist) / h);
    cam.position.set(0, LIFT + dist, shift);
    cam.lookAt(0, LIFT, shift);
    // The depth range hugs the board and the floor under it: a phone may keep depth in 16 bits, and
    // from a near plane at 20 mm that's too coarse at this distance to keep thin layers apart.
    cam.near = Math.max(20, dist - 100);
    cam.far = dist + LIFT + 200;
    cam.updateProjectionMatrix();
  };

  // How far the board has turned: straight from the scroll, so it moves exactly with your hand.
  const section = document.querySelector<HTMLElement>('#flip')!;
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const progress = (): number => {
    if (still) return 1;
    const span = section.offsetHeight - innerHeight;
    const p = Math.min(1, Math.max(0, (scrollY - section.offsetTop) / span));
    return p * p * (3 - 2 * p);
  };
  // Ben Eater's clock module, running on the front. It only says something changed; the frame loop draws.
  let dirty = true;
  let moved = true;
  const tryIt = tryButton(document.querySelector<HTMLAnchorElement>('.try')!);
  const clock = new Clock((m) => {
    dirty = true;
    moved ||= m;
  });

  let shadowAngle = NaN;
  const draw = (): void => {
    dirty = false;
    const p = progress();
    const angle = Math.PI * (1 - p);
    // The Try it button comes up as the board lands.
    const landed = p > 0.9;
    if (landed && !document.body.classList.contains('landed')) tryIt.show();
    document.body.classList.toggle('landed', landed);
    document.body.classList.toggle('turning', p > 0.03);
    holder.rotation.x = angle;
    // Face down, the circuit is out of sight behind the board. Hidden, too: the printing on its parts'
    // sides, seen exactly edge on from below, would otherwise show through the back as thin lines.
    clock.group.visible = angle < Math.PI * 0.95;
    // The printing on the parts (chip and capacitor labels) and the LEDs' lenses and glow are pulled
    // towards the camera so they never flicker on the surface under them. The pull grows as a surface
    // turns edge on, until it reaches through the whole board: once the front faces away, mid-turn,
    // they showed through the back as thin lines. Facing away, they're out of sight anyway.
    const facing = angle <= Math.PI / 2;
    clock.group.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      for (const m of [o.material as THREE.Material].flat())
        if (m.polygonOffset && m.polygonOffsetFactor < 0) m.visible = facing;
    });
    if (angle !== shadowAngle || moved) {
      r.shadowMap.needsUpdate = true;
      shadowAngle = angle;
      moved = false;
    }
    // It rises a little towards you as it turns, and settles back down.
    const rise = Math.sin(angle) * 14;
    holder.position.y = LIFT + rise;
    // Standing on edge mid-turn it reaches lower than when flat; the floor drops out of its way.
    // Face down, the parts on the front hang below it.
    const reach =
      Math.abs(Math.sin(angle)) * (LZ / 2) +
      Math.abs(Math.cos(angle)) * ((TOP - BOTTOM) / 2) +
      Math.max(0, -Math.cos(angle)) * PARTS_TALL;
    floor.position.y = Math.min(0, LIFT + rise - reach - 1);
    r.render(scene, cam);
  };
  fit();
  holder.position.y = LIFT;
  // Compile every shader before the first frame, off the main thread where the browser can, so the
  // loader keeps running and the board doesn't stall on its first turn.
  await r.compileAsync(scene, cam);
  draw();
  await (window as { loader?: { finish(): Promise<void> } }).loader?.finish();
  document.body.classList.add('ready');

  // One loop for everything: the wheel glides, as a trackpad does, the clock runs on, and the board is
  // drawn once, in the same frame, only if either changed it.
  const lenis = still ? null : new Lenis({ lerp: 0.09 });
  lenis?.on('scroll', () => (dirty = true));
  if (still) addEventListener('scroll', () => (dirty = true), { passive: true });
  let prev = performance.now();
  const loop = (t: number): void => {
    lenis?.raf(t);
    clock.step((t - prev) / 1000);
    prev = t;
    if (dirty) draw();
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  addEventListener('resize', () => {
    fit();
    draw();
  });
  // The knob turns as you drag across it; the button is held while the mouse is down; the switch flips.
  const raycaster = new THREE.Raycaster();
  const rayAt = (e: PointerEvent): THREE.Ray => {
    const rect = canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    );
    raycaster.setFromCamera(ndc, cam);
    board.updateWorldMatrix(true, false);
    return raycaster.ray.clone().applyMatrix4(board.matrixWorld.clone().invert());
  };
  // A fingertip is far bigger than a mouse pointer: touches reach a little further round each control.
  const target = (e: PointerEvent): ReturnType<Clock['hit']> =>
    // Live as soon as the front faces you, halfway through the turn.
    progress() > 0.5 ? clock.hit(rayAt(e), e.pointerType === 'touch' ? 3 : 0.8) : null;
  let drag: { x: number; from: number } | null = null;
  let holding = false;
  canvas.addEventListener('pointermove', (e) => {
    if (drag) clock.knob = drag.from + (e.clientX - drag.x) * 4;
    else canvas.style.cursor = target(e) ? 'pointer' : '';
  });
  canvas.addEventListener('pointerdown', (e) => {
    const what = target(e);
    if (!what) return;
    canvas.setPointerCapture(e.pointerId);
    if (what === 'knob') drag = { x: e.clientX, from: clock.knob };
    else if (what === 'button') clock.press((holding = true));
    else clock.toggle();
  });
  const up = (): void => {
    drag = null;
    if (holding) clock.press((holding = false));
  };
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', up);
  Object.assign(window, { landing: { scene, cam, holder, draw, clock } });
}

void main();
