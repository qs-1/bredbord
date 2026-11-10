// Textures painted at startup on 2D canvases: board print, chip markings, desk mat, resistor bands.

import * as THREE from 'three';
import {
  DATA_BUS_TRACKS,
  gridZ,
  PITCH,
  RAIL_GRID_ROW,
  RAIL_WIDTH,
  railStrip,
  SEAM_Z,
  TERMINAL_GRID_ROW,
  TERMINAL_ROWS,
  type BoardSpec,
} from '../engine/breadboard';
import { resistorBands } from '../engine/parts';
import { canvasFont } from '../fonts';

/** How far a rail's red and blue stripes sit in from the sides of the rail strip, mm. */
const RAIL_STRIPE_INSET = 0.9;

function drawBreadboardHole(g: CanvasRenderingContext2D, cx: number, cy: number, mm: (value: number) => number): void {
  const funnel = mm(1.62);
  const opening = mm(1.02);
  g.fillStyle = 'rgba(70, 66, 58, 0.07)';
  g.beginPath();
  g.roundRect(cx - funnel / 2, cy - funnel / 2, funnel, funnel, mm(0.35));
  g.fill();
  const depth = g.createLinearGradient(0, cy - opening / 2, 0, cy + opening / 2);
  depth.addColorStop(0, '#0a0a0b');
  depth.addColorStop(0.62, '#1c1c1e');
  depth.addColorStop(1, '#4b4843');
  g.fillStyle = depth;
  g.beginPath();
  g.roundRect(cx - opening / 2, cy - opening / 2, opening, opening, mm(0.16));
  g.fill();
}

let maxAnisotropy = 1;
export function setMaxAnisotropy(n: number): void {
  maxAnisotropy = n;
}

function canvas2d(width: number, height: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width);
  canvas.height = Math.round(height);
  return [canvas, canvas.getContext('2d')!];
}

function toTexture(canvas: HTMLCanvasElement): THREE.CanvasTexture {
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = maxAnisotropy;
  return tex;
}

function speckle(g: CanvasRenderingContext2D, w: number, h: number, count: number, dark: string, light: string): void {
  for (let i = 0; i < count; i++) {
    g.fillStyle = i % 2 ? dark : light;
    g.fillRect(Math.random() * w, Math.random() * h, 2, 2);
  }
}

const boardTextures = new Map<string, THREE.CanvasTexture>();

/**
 * The printed top face of a breadboard. Mapped onto the board's extruded cap, whose UVs are the
 * shape's own millimetre coordinates, so repeat/offset turn millimetres into 0..1.
 */
export function boardTopTexture(spec: BoardSpec): THREE.CanvasTexture {
  const cached = boardTextures.get(spec.type);
  if (cached) return cached;

  const PX = 20;
  const L = spec.length;
  const W = spec.width;
  const [canvas, g] = canvas2d(L * PX, W * PX);
  const X = (x: number): number => (x + L / 2) * PX;
  const Z = (z: number): number => (z + W / 2) * PX;
  const mm = (v: number): number => v * PX;

  g.fillStyle = '#efeee9';
  g.fillRect(0, 0, canvas.width, canvas.height);
  speckle(
    g,
    canvas.width,
    canvas.height,
    spec.type === 'data-bus' ? 3300 : 1100,
    'rgba(60,50,30,0.025)',
    'rgba(255,255,255,0.5)',
  );

  if (spec.type === 'data-bus') {
    // Exactly the BB830 rail finish, rotated through 90 degrees: the same
    // narrow red/blue stripe, square funnel holes, and the same 5-hole groups
    // separated by one blank pitch. Only the hole groups' electrical identity
    // differs; each complete vertical line remains one independent bus bit.
    const stripeWidth = mm(0.44);
    for (let pair = 0; pair < DATA_BUS_TRACKS.length; pair += 2) {
      const positive = DATA_BUS_TRACKS[pair];
      const negative = DATA_BUS_TRACKS[pair + 1];
      // BB830 stripes sit just outside each hole row, away from the paired row.
      // Rotate that same arrangement: red outside the left row, blue outside right.
      const redX = X(positive.x - 0.62 * 2.54);
      const blueX = X(negative.x + 0.62 * 2.54);
      g.fillStyle = '#d9473f';
      g.fillRect(redX - stripeWidth / 2, 0, stripeWidth, canvas.height);
      g.fillStyle = '#3c6ed6';
      g.fillRect(blueX - stripeWidth / 2, 0, stripeWidth, canvas.height);
    }

    for (const hole of spec.holes) {
      drawBreadboardHole(g, X(hole.x), Z(hole.z), mm);
    }

    const tex = toTexture(canvas);
    tex.repeat.set(1 / L, 1 / W);
    tex.offset.set(0.5, 0.5);
    boardTextures.set(spec.type, tex);
    return tex;
  }

  if (railStrip(spec.type)) {
    // A rail on its own: its two rows, red beside the + row and blue beside the − row on the outer
    // sides, and + / − at each end, the same print as a BB830's rails.
    const v = spec.vertical;
    const along = (a: number, b: number, at: number, w: number): void => {
      if (v) g.fillRect(X(at) - w / 2, Z(a), w, Z(b) - Z(a));
      else g.fillRect(X(a), Z(at) - w / 2, X(b) - X(a), w);
    };
    const ends = spec.holes.filter((h) => h.rail === 'T+').map((h) => (v ? h.z : h.x));
    const lo = Math.min(...ends) - 1.6;
    const hi = Math.max(...ends) + 1.6;
    // Each stripe the same way in from its side of the strip, as on a BB830's rails.
    const inset = RAIL_WIDTH / 2 - RAIL_STRIPE_INSET;
    g.fillStyle = '#d9473f';
    along(lo, hi, -inset, mm(0.44));
    g.fillStyle = '#3c6ed6';
    along(lo, hi, inset, mm(0.44));
    for (const h of spec.holes) drawBreadboardHole(g, X(h.x), Z(h.z), mm);
    g.font = canvasFont('label', 700, mm(2.1));
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    for (const [sym, across, color] of [
      ['+', -PITCH / 2, '#d9473f'],
      ['−', PITCH / 2, '#3c6ed6'],
    ] as const) {
      g.fillStyle = color;
      for (const end of [lo - 1.4, hi + 1.4]) g.fillText(sym, X(v ? across : end), Z(v ? end : across));
    }
    const tex = toTexture(canvas);
    tex.repeat.set(1 / L, 1 / W);
    tex.offset.set(0.5, 0.5);
    boardTextures.set(spec.type, tex);
    return tex;
  }

  if (spec.type === 'power-rail') {
    const railColors = ['#d9473f', '#3c6ed6', '#d9473f', '#3c6ed6'];
    const rails = ['+5V', 'GND', '+5V', 'GND'];
    const stripeWidth = mm(1.0);
    for (let track = 0; track < 4; track++) {
      const x = X([-7.62, -2.54, 2.54, 7.62][track]);
      g.fillStyle = railColors[track];
      g.fillRect(x - stripeWidth / 2, 0, stripeWidth, canvas.height);
      g.fillStyle = '#8d8981';
      for (const hole of spec.holes.filter((item) => item.col === track)) {
        const cx = X(hole.x);
        const cy = Z(hole.z);
        g.beginPath();
        g.arc(cx, cy, mm(0.9), 0, Math.PI * 2);
        g.fill();
        g.fillStyle = '#171819';
        g.beginPath();
        g.arc(cx, cy, mm(0.56), 0, Math.PI * 2);
        g.fill();
        g.fillStyle = '#8d8981';
      }
      g.fillStyle = railColors[track];
      g.font = canvasFont('label', 700, mm(1.35));
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(rails[track], x, Z(-spec.width / 2 + 2.7));
    }
    const tex = toTexture(canvas);
    tex.repeat.set(1 / L, 1 / W);
    tex.offset.set(0.5, 0.5);
    boardTextures.set(spec.type, tex);
    return tex;
  }

  // The centre channel is a shallow groove; shade it as one.
  const c0 = Z(gridZ(4.95));
  const c1 = Z(gridZ(6.05));
  const groove = g.createLinearGradient(0, c0, 0, c1);
  groove.addColorStop(0, '#d2d0ca');
  groove.addColorStop(0.22, '#e2e0db');
  groove.addColorStop(0.8, '#eae9e4');
  groove.addColorStop(1, '#f8f7f4');
  g.fillStyle = groove;
  g.fillRect(0, c0, canvas.width, c1 - c0);

  // Rail stripes: red beside each + row, blue beside each − row, on the side away from its partner.
  // They run the full length of the terminal strips, marking out the area the holes are in.
  const cols = spec.columns;
  const colX = (col: number): number => (col - spec.centerCol) * PITCH;
  const stripe = (row: number, color: string): void => {
    g.fillStyle = color;
    const x0 = X(colX(0)) - mm(0.8);
    g.fillRect(x0, Z(gridZ(row)) - mm(0.22), X(colX(cols - 1)) + mm(0.8) - x0, mm(0.44));
  };
  if (spec.rails.length) {
    // Each rail's stripes sit the same way in from its two sides: the board's edge and the seam to
    // the body. Red is on the outside at the top and the inside at the bottom, as on a BB830.
    const row = (z: number): number => (z - gridZ(0)) / PITCH;
    const edge = spec.width / 2 - RAIL_STRIPE_INSET;
    const seam = SEAM_Z + RAIL_STRIPE_INSET;
    stripe(row(-edge), '#d9473f');
    stripe(row(-seam), '#3c6ed6');
    stripe(row(seam), '#d9473f');
    stripe(row(edge), '#3c6ed6');
  }

  // Holes: the same soft funnel and dark square opening on all board types.
  for (const h of spec.holes) {
    drawBreadboardHole(g, X(h.x), Z(h.z), mm);
  }

  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillStyle = '#5b5852';
  // Numbers sit between the outer terminal rows and the seam to the rails, clear of both.
  g.font = canvasFont('mono', 600, mm(1.7));
  // (A mini board has no room for them.)
  for (let col = 0; col < cols && spec.type !== 'mini'; col++) {
    const n = col + 1;
    if (n !== 1 && n % 5 !== 0) continue;
    g.fillText(String(n), X(colX(col)), Z(gridZ(-0.8)));
    g.fillText(String(n), X(colX(col)), Z(gridZ(11.8)));
  }
  // Row letters halfway between the end holes and the board's rounded edge.
  g.font = canvasFont('mono', 600, mm(1.7));
  for (const r of TERMINAL_ROWS) {
    const z = Z(gridZ(TERMINAL_GRID_ROW[r]));
    g.fillText(r, X(colX(-0.74)), z);
    g.fillText(r, X(colX(cols - 0.26)), z);
  }
  g.font = canvasFont('label', 700, mm(2.1));
  for (const [rail, row] of Object.entries(RAIL_GRID_ROW).filter(([rail]) => spec.rails.includes(rail as never))) {
    const plus = rail.endsWith('+');
    g.fillStyle = plus ? '#d9473f' : '#3c6ed6';
    const sym = plus ? '+' : '−';
    g.fillText(sym, X(colX(cols > 40 ? 0.4 : -0.6)), Z(gridZ(row)));
    g.fillText(sym, X(colX(cols > 40 ? cols - 1.4 : cols - 0.4)), Z(gridZ(row)));
  }

  const tex = toTexture(canvas);
  tex.repeat.set(1 / L, 1 / W);
  tex.offset.set(0.5, 0.5);
  boardTextures.set(spec.type, tex);
  return tex;
}

const chipTextures = new Map<string, THREE.CanvasTexture>();

/** Top marking of a DIP package: notch and pin-1 dimple on the left, part number in the middle. */
export function chipTopTexture(label: string, lengthMm: number, widthMm: number): THREE.CanvasTexture {
  const key = `${label}|${lengthMm}|${widthMm}`;
  const cached = chipTextures.get(key);
  if (cached) return cached;

  const PX = 28;
  const [canvas, g] = canvas2d(lengthMm * PX, widthMm * PX);
  const w = canvas.width;
  const h = canvas.height;
  g.fillStyle = '#1e1f22';
  g.fillRect(0, 0, w, h);
  speckle(g, w, h, Math.round(w * h * 0.004), 'rgba(0,0,0,0.25)', 'rgba(255,255,255,0.035)');

  const notch = Math.min(1.05, widthMm * 0.17) * PX;
  const shade = g.createRadialGradient(0, h / 2, 0, 0, h / 2, notch);
  shade.addColorStop(0, '#0b0b0c');
  shade.addColorStop(0.8, '#121214');
  shade.addColorStop(1, '#2a2b2f');
  g.fillStyle = shade;
  g.beginPath();
  g.arc(0, h / 2, notch, -Math.PI / 2, Math.PI / 2);
  g.fill();

  const dot = g.createRadialGradient(1.5 * PX, h - 1.45 * PX, 0, 1.5 * PX, h - 1.45 * PX, 0.5 * PX);
  dot.addColorStop(0, '#151517');
  dot.addColorStop(0.85, '#18191b');
  dot.addColorStop(1, '#2c2d31');
  g.fillStyle = dot;
  g.beginPath();
  g.arc(1.5 * PX, h - 1.45 * PX, 0.5 * PX, 0, Math.PI * 2);
  g.fill();

  // Just the part number, big and bold: thin small print only turns to haze once the camera backs off.
  let size = Math.min(1.95 * PX, widthMm * 0.36 * PX);
  g.font = canvasFont('label', 700, size);
  const room = (lengthMm - 3.2) * PX;
  const measured = g.measureText(label).width;
  if (measured > room) size *= room / measured;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillStyle = '#d2d4d8';
  g.font = canvasFont('label', 700, size);
  g.fillText(label, w / 2 + 0.5 * PX, h / 2);

  const tex = toTexture(canvas);
  chipTextures.set(key, tex);
  return tex;
}

/** A green self-healing cutting mat with white rules: sage in light mode, deep green in dark. */
const DESK_STYLES = {
  // A warm grey bench with a faint square grid, like a cutting mat: the workbench's own desk colour.
  light: {
    base: '#e2dfd8',
    minor: 'rgba(31,29,26,0.05)',
    major: 'rgba(31,29,26,0.08)',
    dark: 'rgba(31,29,26,0.025)',
    light: 'rgba(255,255,255,0.05)',
  },
  dark: {
    base: '#1e3d34',
    minor: 'rgba(200,255,220,0.05)',
    major: 'rgba(200,255,220,0.12)',
    dark: 'rgba(0,0,0,0.10)',
    light: 'rgba(255,255,255,0.025)',
  },
};
const deskTextures = new Map<string, THREE.CanvasTexture>();

/** A cutting-mat style desk: 10 mm grid with heavier lines every 50 mm. One tile = 100 mm. */
export function deskTexture(theme: 'light' | 'dark'): THREE.CanvasTexture {
  const cached = deskTextures.get(theme);
  if (cached) return cached;
  const style = DESK_STYLES[theme];
  const S = 1024;
  const [canvas, g] = canvas2d(S, S);
  g.fillStyle = style.base;
  g.fillRect(0, 0, S, S);
  speckle(g, S, S, 26000, style.dark, style.light);
  const step = S / 10;
  for (let i = 0; i < 10; i++) {
    const major = i % 5 === 0;
    g.fillStyle = major ? style.major : style.minor;
    const t = major ? 2 : 1;
    g.fillRect(i * step, 0, t, S);
    g.fillRect(0, i * step, S, t);
  }
  const tex = toTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(60, 60);
  deskTextures.set(theme, tex);
  return tex;
}

const switchTextures = new Map<number, THREE.CanvasTexture>();

/** Top of a DIP switch: a window per switch, numbers along the near side, "ON" along the far side. */
export function dipSwitchTexture(n: number, lengthMm: number, widthMm: number): THREE.CanvasTexture {
  const cached = switchTextures.get(n);
  if (cached) return cached;
  const PX = 24;
  const [canvas, g] = canvas2d(lengthMm * PX, widthMm * PX);
  const w = canvas.width;
  const h = canvas.height;
  g.fillStyle = '#2457c5';
  g.fillRect(0, 0, w, h);
  const pitch = 2.54 * PX;
  const x0 = w / 2 - ((n - 1) / 2) * pitch;
  g.fillStyle = '#1a3f8f';
  for (let k = 0; k < n; k++) {
    g.beginPath();
    g.roundRect(x0 + k * pitch - 0.85 * PX, h / 2 - 2 * PX, 1.7 * PX, 4 * PX, 0.3 * PX);
    g.fill();
  }
  g.fillStyle = '#f4f6fb';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = canvasFont('label', 600, 1.15 * PX);
  for (let k = 0; k < n; k++) g.fillText(String(k + 1), x0 + k * pitch, h - 1.05 * PX);
  g.textAlign = 'left';
  g.font = canvasFont('label', 700, 1.15 * PX);
  g.fillText('ON', x0 - 0.85 * PX, 1.05 * PX);
  const tex = toTexture(canvas);
  switchTextures.set(n, tex);
  return tex;
}

const codeTextures = new Map<string, THREE.CanvasTexture>();

/** The value code printed on a ceramic disc capacitor, e.g. "104". */
const networkTextures = new Map<string, THREE.CanvasTexture>();

/** The printed face of a resistor network: a dot at pin 1, then its value code. */
export function networkTexture(code: string): THREE.CanvasTexture {
  const cached = networkTextures.get(code);
  if (cached) return cached;
  const [canvas, g] = canvas2d(512, 112);
  g.fillStyle = '#1d1d20';
  g.fillRect(0, 0, 512, 112);
  g.fillStyle = '#e9e7e2';
  g.beginPath();
  g.arc(34, 56, 11, 0, Math.PI * 2);
  g.fill();
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = canvasFont('label', 600, 50);
  g.fillText(`A${code}J`, 280, 58);
  const tex = toTexture(canvas);
  networkTextures.set(code, tex);
  return tex;
}

const transistorTextures = new Map<string, THREE.CanvasTexture>();

/** The flat face of a TO-92 transistor: its type, printed in white on the black package. */
export function transistorTexture(name: string): THREE.CanvasTexture {
  const cached = transistorTextures.get(name);
  if (cached) return cached;
  const [canvas, g] = canvas2d(256, 256);
  g.fillStyle = '#1d1d20';
  g.fillRect(0, 0, 256, 256);
  g.fillStyle = '#e9e7e2';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = canvasFont('label', 600, 52);
  g.fillText(name, 128, 132);
  const tex = toTexture(canvas);
  transistorTextures.set(name, tex);
  return tex;
}

export function capacitorCodeTexture(code: string): THREE.CanvasTexture {
  const cached = codeTextures.get(code);
  if (cached) return cached;
  const [canvas, g] = canvas2d(96, 52);
  g.fillStyle = '#c4712c';
  g.fillRect(0, 0, 96, 52);
  g.fillStyle = '#3d1f0b';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = canvasFont('label', 700, 34);
  g.fillText(code, 48, 28);
  const tex = toTexture(canvas);
  codeTextures.set(code, tex);
  return tex;
}

const sleeveTextures = new Map<string, THREE.CanvasTexture>();

/**
 * The plastic sleeve of an electrolytic capacitor, wrapped around a cylinder: u goes round from the
 * front (+z), so the − stripe at u = 0.25 faces +x, the − leg. v runs up the can.
 */
export function electrolyticTexture(label: string): THREE.CanvasTexture {
  const cached = sleeveTextures.get(label);
  if (cached) return cached;
  const W = 512;
  const Hh = 256;
  const [canvas, g] = canvas2d(W, Hh);
  g.fillStyle = '#1f3f8c';
  g.fillRect(0, 0, W, Hh);
  g.fillStyle = '#c9ced6';
  g.fillRect(W * 0.15, 0, W * 0.2, Hh);
  g.fillStyle = '#1f3f8c';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = canvasFont('label', 700, 44);
  for (let y = 30; y < Hh; y += 64) g.fillText('−', W * 0.25, y);
  // Value and rating along the can, facing the other way.
  g.save();
  g.translate(W * 0.75, Hh / 2);
  g.rotate(-Math.PI / 2);
  g.fillStyle = '#e8ecf3';
  g.font = canvasFont('label', 600, 30);
  g.fillText(label, 0, 0);
  g.restore();
  const tex = toTexture(canvas);
  sleeveTextures.set(label, tex);
  return tex;
}

const diodeTextures = new Map<boolean, THREE.CanvasTexture>();

/** A diode body, glass or black epoxy, with its cathode band near v = 1 (the second leg). */
export function diodeTexture(glass: boolean): THREE.CanvasTexture {
  const cached = diodeTextures.get(glass);
  if (cached) return cached;
  const [canvas, g] = canvas2d(32, 256);
  if (glass) {
    const shine = g.createLinearGradient(0, 0, 32, 0);
    shine.addColorStop(0, '#9c2a12');
    shine.addColorStop(0.45, '#f08a4b');
    shine.addColorStop(1, '#a8361a');
    g.fillStyle = shine;
  } else g.fillStyle = '#1b1b1d';
  g.fillRect(0, 0, 32, 256);
  g.fillStyle = glass ? '#141414' : '#c9ccd1';
  g.fillRect(0, 256 * 0.12, 32, 256 * 0.16);
  const tex = toTexture(canvas);
  diodeTextures.set(glass, tex);
  return tex;
}

const BAND_HEX: Record<string, string> = {
  black: '#1c1c1c',
  brown: '#6b3a1e',
  red: '#c62a24',
  orange: '#e3701c',
  yellow: '#efc320',
  green: '#2c8f3a',
  blue: '#2958c7',
  violet: '#7d3fba',
  grey: '#8b8b8b',
  white: '#f1f1f1',
  gold: '#b99733',
  silver: '#babdc2',
};

const resistorTextures = new Map<number, THREE.CanvasTexture>();

/** Body of a carbon-film resistor. v runs along the body from lead A (v = 0) to lead B. */
export function resistorTexture(ohms: number): THREE.CanvasTexture {
  const cached = resistorTextures.get(ohms);
  if (cached) return cached;
  const [canvas, g] = canvas2d(64, 256);
  g.fillStyle = '#d9c8a2';
  g.fillRect(0, 0, 64, 256);
  speckle(g, 64, 256, 400, 'rgba(90,70,30,0.08)', 'rgba(255,255,255,0.12)');
  const at = [0.27, 0.38, 0.49, 0.75];
  resistorBands(ohms).forEach((band, i) => {
    g.fillStyle = BAND_HEX[band];
    const v = at[i];
    g.fillRect(0, (1 - v - 0.04) * 256, 64, 0.08 * 256);
  });
  const tex = toTexture(canvas);
  resistorTextures.set(ohms, tex);
  return tex;
}

let nanoTexture: THREE.CanvasTexture | null = null;

/**
 * The top of an Arduino Nano's board, `lengthMm` long with the USB end at the left: blue solder
 * mask, gold pads for the header pins and their names printed beside them.
 */
export function nanoTopTexture(
  lengthMm: number,
  widthMm: number,
  pins: readonly { x: number; z: number; name: string }[],
): THREE.CanvasTexture {
  if (nanoTexture) return nanoTexture;
  const PX = 24;
  const [canvas, g] = canvas2d(lengthMm * PX, widthMm * PX);
  const X = (x: number): number => (x + lengthMm / 2) * PX;
  const Z = (z: number): number => (z + widthMm / 2) * PX;
  g.fillStyle = '#1f5f9e';
  g.fillRect(0, 0, canvas.width, canvas.height);
  speckle(g, canvas.width, canvas.height, 1800, 'rgba(10, 40, 80, 0.25)', 'rgba(120, 170, 220, 0.12)');
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  for (const pin of pins) {
    g.fillStyle = '#d9b964';
    g.beginPath();
    g.arc(X(pin.x), Z(pin.z), 0.85 * PX, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#3a3527';
    g.fillRect(X(pin.x) - 0.32 * PX, Z(pin.z) - 0.32 * PX, 0.64 * PX, 0.64 * PX);
    // Names read across the board, just inside each row of pins.
    g.save();
    g.translate(X(pin.x), Z(pin.z - Math.sign(pin.z) * 2.35));
    g.rotate(-Math.PI / 2);
    g.fillStyle = '#eef2f6';
    g.font = canvasFont('label', 600, 0.95 * PX);
    g.fillText(pin.name.replace('D1/TX', 'TX1').replace('D0/RX', 'RX0'), 0, 0);
    g.restore();
  }
  g.fillStyle = '#eef2f6';
  g.font = canvasFont('label', 700, 1.5 * PX);
  g.fillText('NANO', X(-1), Z(-3.6));
  g.font = canvasFont('label', 600, 0.85 * PX);
  for (const [label, z] of [
    ['TX', -3.6],
    ['RX', -1.2],
    ['PWR', 1.2],
    ['L', 3.6],
  ] as const)
    g.fillText(label, X(-11.9), Z(z));
  nanoTexture = toTexture(canvas);
  return nanoTexture;
}
