import * as THREE from 'three';
import { canvasFont } from '../fonts';
import type { MeterDoc, Id } from '../engine/circuit';
import {
  autoRange,
  DIAL_ANGLE,
  METER_BUTTONS,
  METER_MODES,
  newPanel,
  pressButton,
  readPanel,
  type MeterButton,
  type MeterPanel,
  METER_BODY,
  METER_FACE_Y,
  METER_JACK_H,
  METER_LAYOUT,
  METER_LIFT,
  METER_SCALE,
  METER_SIZE,
  METER_TILT,
  METER_TOP,
  meterToDesk,
  type MeterDisplay,
  type MeterInputs,
  type MeterMode,
} from '../engine/meter';
import { boxObstacle, type Obstacle } from './routing';

/** Slices along its length that a meter's sloping top is stepped into, for wires to keep out of. */
const SLICES = 8;

/**
 * What wires keep out of: if the meter is tilted, low at the front and high at the back, it's a
 * staircase of boxes under its top (dial and jacks included), not one box as tall as its back. `z0` is
 * where it stands on the desk.
 */
export function meterObstacles(box: THREE.Box3, z0: number): Obstacle[] {
  const L = METER_BODY.z / 2;
  const top = METER_TOP;
  const front = meterToDesk(0, top, L);
  const back = meterToDesk(0, top, -L);
  // Height of the top at desk z: along the line from its back edge to its front edge.
  const heightAt = (z: number): number => {
    const t = THREE.MathUtils.clamp(((z - z0) / METER_SCALE - back.z) / (front.z - back.z), 0, 1);
    return (back.y + (front.y - back.y) * t) * METER_SCALE;
  };
  const out: Obstacle[] = [];
  for (let k = 0; k < SLICES; k++) {
    const a = box.min.z + ((box.max.z - box.min.z) * k) / SLICES;
    const b = box.min.z + ((box.max.z - box.min.z) * (k + 1)) / SLICES;
    out.push(boxObstacle(box.min.x, box.max.x, a, b, Math.min(box.max.y, Math.max(heightAt(a), heightAt(b)) + 1), 0));
  }
  return out;
}

/*
 * One meter = 4 draw calls:
 *   body  – holster, case, display bezel, buttons and jacks merged into a single vertex-coloured mesh
 *   face  – the printed plate (dial markings, jack labels), one shared texture
 *   lcd   – the display, a small canvas redrawn only when the reading changes
 *   dial  – the rotary switch, the only moving part
 */

/* ---------------------------------------------------------------- geometry helpers --- */

interface Part {
  geo: THREE.BufferGeometry;
  color: number;
  at?: THREE.Matrix4;
}

/** Merge parts into one non-indexed geometry with a per-vertex colour. */
function merge(parts: Part[]): THREE.BufferGeometry {
  const pos: number[] = [];
  const nor: number[] = [];
  const col: number[] = [];
  const c = new THREE.Color();
  for (const p of parts) {
    const g = p.geo.index ? p.geo.toNonIndexed() : p.geo.clone();
    if (p.at) g.applyMatrix4(p.at);
    c.set(p.color);
    const P = g.getAttribute('position');
    const N = g.getAttribute('normal');
    for (let i = 0; i < P.count; i++) {
      pos.push(P.getX(i), P.getY(i), P.getZ(i));
      nor.push(N.getX(i), N.getY(i), N.getZ(i));
      col.push(c.r, c.g, c.b);
    }
    g.dispose();
    p.geo.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  out.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  out.computeBoundingSphere();
  out.computeBoundingBox();
  return out;
}

const at = (x: number, y: number, z: number) => new THREE.Matrix4().makeTranslation(x, y, z);

function roundedRect(w: number, h: number, r: number): THREE.Shape {
  const x = -w / 2;
  const y = -h / 2;
  const s = new THREE.Shape();
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y);
  s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + h - r);
  s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  s.lineTo(x + r, y + h);
  s.quadraticCurveTo(x, y + h, x, y + h - r);
  s.lineTo(x, y + r);
  s.quadraticCurveTo(x, y, x + r, y);
  return s;
}

/** Holster outline: rounded corners, the long sides drawn in a little at the middle for grip. */
function holsterShape(w: number, l: number, r: number, waist: number): THREE.Shape {
  const x = w / 2;
  const y = l / 2;
  const s = new THREE.Shape();
  s.moveTo(-x + r, -y);
  s.lineTo(x - r, -y);
  s.quadraticCurveTo(x, -y, x, -y + r);
  s.quadraticCurveTo(x - waist * 2, 0, x, y - r);
  s.quadraticCurveTo(x, y, x - r, y);
  s.lineTo(-x + r, y);
  s.quadraticCurveTo(-x, y, -x, y - r);
  s.quadraticCurveTo(-x + waist * 2, 0, -x, -y + r);
  s.quadraticCurveTo(-x, -y, -x + r, -y);
  return s;
}

const COLORS = {
  holster: 0xe6a51c,
  case: 0x2a2d31,
  bezel: 0x15171a,
  button: 0x474c53,
  buttonKey: 0xe6a51c,
  shroud: 0x1d1f22,
  jackCom: 0x1a1a1a,
  jackHot: 0xc42a22,
  jackHole: 0x050505,
  dialSkirt: 0x1b1d20,
  dialBody: 0x33373d,
  dialGrip: 0x24272b,
  pointer: 0xf2f2f2,
};

/** How far in from the holster's edge the case's face starts, mm. */
const RIM = 5;
/** How far the holster's rim stands above the face, mm. */
const RIM_H = 2.2;

/** Holster, case, display bezel, buttons and jacks, in body space (what the group holds). */
export function buildBodyGeometry(): THREE.BufferGeometry {
  const { x: W, y: T, z: L } = METER_BODY;
  const parts: Part[] = [];
  const flat = (g: THREE.BufferGeometry) => g.rotateX(-Math.PI / 2);

  // Rubber holster: a thick frame round the case, its rim standing proud of the face.
  const bt = 1.4;
  const outline = holsterShape(W, L, 13, 1.2);
  outline.holes.push(roundedRect(W - 2 * RIM, L - 2 * RIM, 8));
  const holster = flat(
    new THREE.ExtrudeGeometry(outline, {
      depth: T + RIM_H - 2 * bt,
      bevelEnabled: true,
      bevelThickness: bt,
      bevelSize: bt,
      bevelOffset: -bt,
      bevelSegments: 3,
      curveSegments: 10,
    }),
  );
  holster.translate(0, bt, 0);
  parts.push({ geo: holster, color: COLORS.holster });

  // The case inside it, its top the face the plate is printed on.
  parts.push({
    geo: flat(
      new THREE.ExtrudeGeometry(roundedRect(W - 2 * RIM + 0.6, L - 2 * RIM + 0.6, 8), {
        depth: T,
        bevelEnabled: false,
        curveSegments: 8,
      }),
    ),
    color: COLORS.case,
  });

  // Display window: a black frame the LCD sits down inside.
  const { bezel, lcd } = METER_LAYOUT;
  const frame = roundedRect(bezel.w, bezel.h, 3.5);
  frame.holes.push(roundedRect(lcd.w + 0.4, lcd.h + 0.4, 1));
  parts.push({
    geo: flat(
      new THREE.ExtrudeGeometry(frame, {
        depth: 1.2,
        bevelEnabled: true,
        bevelThickness: 0.3,
        bevelSize: 0.3,
        bevelOffset: -0.3,
        bevelSegments: 1,
        curveSegments: 8,
      }),
    ),
    color: COLORS.bezel,
    at: at(0, METER_FACE_Y, bezel.z),
  });

  // Push buttons under the display; the first one is the coloured function key.
  METER_LAYOUT.buttons.x.forEach((x, i) => {
    parts.push({
      geo: flat(
        new THREE.ExtrudeGeometry(roundedRect(11, 5.5, 2.2), {
          depth: 1,
          bevelEnabled: true,
          bevelThickness: 0.5,
          bevelSize: 0.5,
          bevelOffset: -0.5,
          bevelSegments: 2,
          curveSegments: 6,
        }),
      ),
      color: i === 0 ? COLORS.buttonKey : COLORS.button,
      at: at(x, METER_FACE_Y, METER_LAYOUT.buttons.z),
    });
  });

  // Jacks: a raised shroud, a coloured insert, and the socket going down into it.
  for (const [name, x] of Object.entries(METER_LAYOUT.jack.x)) {
    const z = METER_LAYOUT.jack.z;
    parts.push({
      geo: new THREE.CylinderGeometry(5.2, 5.9, METER_JACK_H - 0.6, 24),
      color: COLORS.shroud,
      at: at(x, METER_FACE_Y + (METER_JACK_H - 0.6) / 2, z),
    });
    parts.push({
      geo: new THREE.CylinderGeometry(3.9, 3.9, 0.6, 24),
      color: name === 'COM' ? COLORS.jackCom : COLORS.jackHot,
      at: at(x, METER_FACE_Y + METER_JACK_H - 0.3, z),
    });
    parts.push({
      geo: new THREE.CylinderGeometry(2, 2, 0.2, 16),
      color: COLORS.jackHole,
      at: at(x, METER_FACE_Y + METER_JACK_H + 0.02, z),
    });
  }

  return merge(parts);
}

/** Radius of the rotary switch's skirt, mm (body space). */
const DIAL_R = 18;

/**
 * Rotary switch, in dial space (origin on its axis, y up from the face): a round knob with a
 * raised bar across it to turn it by, the pointer a white stripe down one end of the bar (-z).
 */
export function buildDialGeometry(): THREE.BufferGeometry {
  const parts: Part[] = [
    { geo: new THREE.CylinderGeometry(DIAL_R, DIAL_R + 0.4, 2, 40), color: COLORS.dialSkirt, at: at(0, 1, 0) },
    { geo: new THREE.CylinderGeometry(DIAL_R - 1.5, DIAL_R - 0.6, 3, 40), color: COLORS.dialBody, at: at(0, 3.5, 0) },
  ];
  const barL = 2 * (DIAL_R - 1.2);
  const bar = new THREE.ExtrudeGeometry(roundedRect(9, barL, 4.4), {
    depth: 4.4,
    bevelEnabled: true,
    bevelThickness: 1,
    bevelSize: 1,
    bevelOffset: -1,
    bevelSegments: 3,
    curveSegments: 10,
  }).rotateX(-Math.PI / 2);
  parts.push({ geo: bar, color: COLORS.dialGrip, at: at(0, 5, 0) });
  // Pointer stripe along the top of the bar, and a notch on the skirt where it points.
  parts.push({
    geo: new THREE.BoxGeometry(1.8, 0.3, DIAL_R - 4),
    color: COLORS.pointer,
    at: at(0, 10.5, -(DIAL_R - 4) / 2 - 2.2),
  });
  parts.push({ geo: new THREE.BoxGeometry(1.4, 0.3, 2.4), color: COLORS.pointer, at: at(0, 5.1, -(DIAL_R - 1.5)) });
  return merge(parts);
}

/* ------------------------------------------------------------------- printed face --- */

const FACE_PX = 8; // texture pixels per mm
const FACE_W = METER_BODY.x - 2 * RIM;
const FACE_L = METER_BODY.z - 2 * RIM;

function drawFace(): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = FACE_W * FACE_PX;
  c.height = FACE_L * FACE_PX;
  const g = c.getContext('2d');
  if (!g) return c;
  const X = (x: number) => (x + FACE_W / 2) * FACE_PX;
  const Z = (z: number) => (z + FACE_L / 2) * FACE_PX;

  g.fillStyle = '#2a2d31';
  g.fillRect(0, 0, c.width, c.height);

  const dz = METER_LAYOUT.dial.z;
  const polar = (r: number, phi: number) => ({
    x: r * Math.sin(phi),
    z: dz - r * Math.cos(phi),
  });
  const ink = '#eceff1';
  const red = '#ff5a4e';

  // A lighter ring printed round the switch, the positions marked on it.
  g.fillStyle = '#383c42';
  g.beginPath();
  g.arc(X(0), Z(dz), (DIAL_R + 4.5) * FACE_PX, 0, Math.PI * 2);
  g.fill();
  // The jack strip along the bottom.
  g.fillStyle = '#23262a';
  const jz0 = METER_LAYOUT.jack.z - 13.5;
  g.fillRect(0, Z(jz0), c.width, c.height - Z(jz0));

  // A tick at every dial position.
  g.strokeStyle = '#d9dde1';
  g.lineWidth = 0.35 * FACE_PX;
  g.lineCap = 'round';
  for (const mode of METER_MODES) {
    const a = polar(DIAL_R + 1, DIAL_ANGLE[mode]);
    const b = polar(DIAL_R + 3.5, DIAL_ANGLE[mode]);
    g.beginPath();
    g.moveTo(X(a.x), Z(a.z));
    g.lineTo(X(b.x), Z(b.z));
    g.stroke();
  }

  g.fillStyle = ink;
  g.strokeStyle = ink;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  const font = (mm: number) => (g.font = canvasFont('label', 700, mm * FACE_PX));
  const text = (s: string, x: number, z: number) => g.fillText(s, X(x), Z(z));
  /** The DC sign: a solid line over a dashed one, `w` mm long, starting at x. */
  const dcSign = (x: number, z: number, w: number) => {
    g.lineWidth = 0.3 * FACE_PX;
    g.lineCap = 'butt';
    g.beginPath();
    g.moveTo(X(x), Z(z - 0.6));
    g.lineTo(X(x + w), Z(z - 0.6));
    g.stroke();
    g.setLineDash([0.7 * FACE_PX, 0.5 * FACE_PX]);
    g.beginPath();
    g.moveTo(X(x), Z(z + 0.6));
    g.lineTo(X(x + w), Z(z + 0.6));
    g.stroke();
    g.setLineDash([]);
  };
  /** One cycle of a sine, `w` mm long, starting at x. */
  const acSign = (x: number, z: number, w: number) => {
    g.lineWidth = 0.35 * FACE_PX;
    g.beginPath();
    for (let i = 0; i <= 16; i++) {
      const px = X(x + (w * i) / 16);
      const pz = Z(z - 0.9 * Math.sin((i / 16) * Math.PI * 2));
      if (i) g.lineTo(px, pz);
      else g.moveTo(px, pz);
    }
    g.stroke();
  };

  const label = (mode: MeterMode, r = DIAL_R + 7.5) => polar(r, DIAL_ANGLE[mode]);
  font(2.8);
  let p = label('off', DIAL_R + 8.5);
  text('OFF', p.x, p.z);
  p = label('dcv');
  text('V', p.x - 1.6, p.z);
  dcSign(p.x + 0.4, p.z, 3);
  p = label('acv');
  text('V', p.x - 1.6, p.z);
  acSign(p.x + 0.4, p.z, 3);
  p = label('hz');
  text('Hz', p.x, p.z);
  font(3.4);
  p = label('ohm');
  text('Ω', p.x, p.z);
  // Diode: a triangle pointing at a bar.
  p = label('diode');
  g.beginPath();
  g.moveTo(X(p.x - 1.6), Z(p.z - 1.5));
  g.lineTo(X(p.x - 1.6), Z(p.z + 1.5));
  g.lineTo(X(p.x + 1.1), Z(p.z));
  g.closePath();
  g.fill();
  g.fillRect(X(p.x + 1.1), Z(p.z - 1.5), 0.45 * FACE_PX, 3 * FACE_PX);
  // Continuity: a sound coming out of a dot.
  p = label('cont');
  g.beginPath();
  g.arc(X(p.x - 1.8), Z(p.z), 0.6 * FACE_PX, 0, Math.PI * 2);
  g.fill();
  g.lineWidth = 0.35 * FACE_PX;
  for (const r of [1.3, 2.3, 3.3]) {
    g.beginPath();
    g.arc(X(p.x - 1.8), Z(p.z), r * FACE_PX, -0.8, 0.8);
    g.stroke();
  }
  font(2.8);
  g.fillStyle = red;
  p = label('ma');
  text('mA', p.x, p.z);
  p = label('a', DIAL_R + 8.5);
  text('10A', p.x, p.z);
  g.fillStyle = ink;

  // What the buttons do, under each.
  font(1.7);
  g.fillStyle = '#c4c8cc';
  ['LIGHT', 'RANGE', 'HOLD', 'MAX/MIN'].forEach((s, i) =>
    text(s, METER_LAYOUT.buttons.x[i] ?? 0, METER_LAYOUT.buttons.z + 5.2),
  );
  // Name and rating.
  font(2.2);
  g.fillStyle = ink;
  text('DIGITAL MULTIMETER', 0, METER_LAYOUT.bezel.z - METER_LAYOUT.bezel.h / 2 - 2.6);
  font(1.7);
  g.fillStyle = '#c4c8cc';
  text('TRUE RMS  ·  AUTO RANGE', 0, jz0 - 4.5);

  // Jack rings and labels; the current jacks say how much they take.
  const jz = METER_LAYOUT.jack.z;
  const names: Record<string, string> = { A: '10A', mA: 'mA', COM: 'COM', V: 'VΩHz' };
  const limits: Record<string, string> = { A: '10A MAX', mA: '400mA MAX' };
  for (const [name, x] of Object.entries(METER_LAYOUT.jack.x)) {
    g.strokeStyle = name === 'COM' ? '#9ea3a8' : red;
    g.lineWidth = 0.4 * FACE_PX;
    g.beginPath();
    g.arc(X(x), Z(jz), 6.9 * FACE_PX, 0, Math.PI * 2);
    g.stroke();
    g.fillStyle = name === 'COM' ? ink : red;
    font(2.4);
    text(names[name] ?? name, x, jz - 9.6);
    const limit = limits[name];
    if (limit) {
      font(1.5);
      g.fillStyle = '#c4c8cc';
      text(limit, x, jz + 8.6);
    }
  }

  return c;
}

function faceGeometry(): THREE.BufferGeometry {
  const geometry = new THREE.ShapeGeometry(roundedRect(FACE_W, FACE_L, 8), 8);
  const pos = geometry.attributes.position;
  const uv = geometry.attributes.uv;
  for (let i = 0; i < pos.count; i++) {
    uv.setXY(i, pos.getX(i) / FACE_W + 0.5, pos.getY(i) / FACE_L + 0.5);
  }
  return geometry.rotateX(-Math.PI / 2);
}

/* --------------------------------------------------------------------------- LCD --- */

const LCD_W = 288;
const LCD_H = 128;
const LCD_BG = '#aab59a';
const LCD_GHOST = '#a2ad93';
/** Backlit: a cool blue-green glow. */
const LCD_LIT_BG = '#9fe0d2';
const LCD_LIT_GHOST = '#94d4c6';
const LCD_INK = '#1a231a';

const SEGMENTS: Record<string, string> = {
  '0': 'abcdef',
  '1': 'bc',
  '2': 'abdeg',
  '3': 'abcdg',
  '4': 'bcfg',
  '5': 'acdfg',
  '6': 'acdefg',
  '7': 'abc',
  '8': 'abcdefg',
  '9': 'abcdfg',
  L: 'def',
  O: 'abcdef',
  '-': 'g',
  ' ': '',
};

type Pts = [number, number][];

function hSeg(x0: number, x1: number, y: number, t: number): Pts {
  return [
    [x0, y + t / 2],
    [x0 + t / 2, y],
    [x1 - t / 2, y],
    [x1, y + t / 2],
    [x1 - t / 2, y + t],
    [x0 + t / 2, y + t],
  ];
}
function vSeg(x: number, y0: number, y1: number, t: number): Pts {
  return [
    [x, y0 + t / 2],
    [x + t / 2, y0],
    [x + t, y0 + t / 2],
    [x + t, y1 - t / 2],
    [x + t / 2, y1],
    [x, y1 - t / 2],
  ];
}

function segments(x: number, y: number, w: number, h: number, t: number): Record<string, Pts> {
  const gap = 1.5;
  const yc = y + h / 2;
  return {
    a: hSeg(x + gap, x + w - gap, y, t),
    g: hSeg(x + gap, x + w - gap, yc - t / 2, t),
    d: hSeg(x + gap, x + w - gap, y + h - t, t),
    f: vSeg(x, y + gap, yc - gap, t),
    b: vSeg(x + w - t, y + gap, yc - gap, t),
    e: vSeg(x, yc + gap, y + h - gap, t),
    c: vSeg(x + w - t, yc + gap, y + h - gap, t),
  };
}

function fillPoly(g: CanvasRenderingContext2D, pts: Pts): void {
  g.beginPath();
  pts.forEach(([px, py], i) => (i ? g.lineTo(px, py) : g.moveTo(px, py)));
  g.closePath();
  g.fill();
}

function drawLcd(g: CanvasRenderingContext2D, d: MeterDisplay | null, lit: boolean): void {
  g.setTransform(1, 0, 0, 1, 0, 0);
  // The backlight only works while the meter is on.
  lit &&= !!d;
  g.fillStyle = lit ? LCD_LIT_BG : LCD_BG;
  g.fillRect(0, 0, LCD_W, LCD_H);
  if (!d) return;
  const ghost = lit ? LCD_LIT_GHOST : LCD_GHOST;

  const top = 40;
  const dh = 70;
  const dw = 36;
  const adv = 46;
  const t = 8;

  // Slight italic lean, like a real LCD.
  g.setTransform(1, 0, -0.1, 1, 0.1 * (top + dh), 0);

  const neg = d.text.startsWith('-');
  const slots: { ch: string; dot: boolean }[] = [];
  for (const ch of neg ? d.text.slice(1) : d.text) {
    if (ch === '.') {
      const last = slots[slots.length - 1];
      if (last) last.dot = true;
    } else slots.push({ ch, dot: false });
  }
  while (slots.length < 4) slots.unshift({ ch: ' ', dot: false });

  // Sign slot.
  const sign = segments(6, top, 24, dh, t);
  g.fillStyle = ghost;
  fillPoly(g, sign.g ?? []);
  if (neg) {
    g.fillStyle = LCD_INK;
    fillPoly(g, sign.g ?? []);
  }

  slots.slice(-4).forEach((s, i) => {
    const x = 36 + i * adv;
    const segs = segments(x, top, dw, dh, t);
    g.fillStyle = ghost;
    for (const p of Object.values(segs)) fillPoly(g, p);
    g.fillStyle = LCD_INK;
    for (const k of SEGMENTS[s.ch] ?? '') fillPoly(g, segs[k] ?? []);
    if (s.dot) g.fillRect(x + dw + 2, top + dh - 6, 6, 6);
  });

  g.setTransform(1, 0, 0, 1, 0, 0);
  g.fillStyle = LCD_INK;
  g.strokeStyle = LCD_INK;
  g.textBaseline = 'alphabetic';
  g.textAlign = 'left';
  g.font = canvasFont('label', 700, d.unit.length > 2 ? 24 : 30);
  g.fillText(d.unit, 226, top + dh);
  g.font = canvasFont('label', 700, 17);
  const f = d.flags ?? {};
  if (f.dc) g.fillText('DC', 10, 26);
  if (f.ac) g.fillText('AC', 10, 26);
  if (f.auto) g.fillText('AUTO', 52, 26);
  if (f.hold) g.fillText('H', 212, 26);
  if (f.max) g.fillText('MAX', 236, 26);
  if (f.min) g.fillText('MIN', 238, 26);
  if (f.diode) {
    // A diode: a triangle pointing at a bar.
    g.beginPath();
    g.moveTo(130, 12);
    g.lineTo(130, 28);
    g.lineTo(144, 20);
    g.closePath();
    g.fill();
    g.fillRect(144, 12, 3, 16);
    g.fillRect(122, 19, 30, 2);
  }
  if (f.cont) {
    // A dot, with sound coming out of it while the leads are joined.
    g.beginPath();
    g.arc(176, 20, 4, 0, Math.PI * 2);
    g.fill();
    if (f.beep) {
      g.lineWidth = 2.5;
      for (const r of [8, 13, 18]) {
        g.beginPath();
        g.arc(176, 20, r, -0.8, 0.8);
        g.stroke();
      }
    }
  }
}

/* ------------------------------------------------------------------ shared resources --- */

interface Shared {
  body: THREE.BufferGeometry;
  dial: THREE.BufferGeometry;
  plane: THREE.BufferGeometry;
  lcdPlane: THREE.PlaneGeometry;
  bodyMat: THREE.MeshStandardMaterial;
  faceMat: THREE.MeshStandardMaterial;
  face: THREE.CanvasTexture;
}

let shared: Shared | null = null;
function getShared(): Shared {
  if (shared) return shared;
  const face = new THREE.CanvasTexture(drawFace());
  face.colorSpace = THREE.SRGBColorSpace;
  face.anisotropy = 4;
  const plane = faceGeometry();
  const lcdPlane = new THREE.PlaneGeometry(METER_LAYOUT.lcd.w, METER_LAYOUT.lcd.h);
  lcdPlane.rotateX(-Math.PI / 2);
  shared = {
    body: buildBodyGeometry(),
    dial: buildDialGeometry(),
    plane,
    lcdPlane,
    bodyMat: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0 }),
    faceMat: new THREE.MeshStandardMaterial({
      map: face,
      roughness: 0.55,
      metalness: 0,
    }),
    face,
  };
  return shared;
}

/* ----------------------------------------------------------------------------- model --- */

class MeterModel {
  readonly root = new THREE.Group();
  readonly body: THREE.Mesh;
  readonly dial: THREE.Mesh;
  private mode: MeterMode = 'off';
  private inputs: MeterInputs = { volts: 0, amps: 0, hertz: 0 };
  /** What the buttons are set to; not saved with the circuit. */
  private panel: MeterPanel = newPanel();
  /** Body space, for finding which button a hit landed on. */
  readonly tilted = new THREE.Group();
  private readonly lcdCtx: CanvasRenderingContext2D | null;
  private readonly lcdTex: THREE.CanvasTexture;
  private readonly lcdMat: THREE.MeshBasicMaterial;
  private shown = '\0';

  constructor() {
    const s = getShared();
    const tilted = this.tilted;
    tilted.rotation.x = METER_TILT;
    tilted.position.y = METER_LIFT;
    this.root.add(tilted);
    this.root.scale.setScalar(METER_SCALE);

    this.body = new THREE.Mesh(s.body, s.bodyMat);
    this.body.castShadow = true;
    this.body.receiveShadow = true;
    tilted.add(this.body);

    const face = new THREE.Mesh(s.plane, s.faceMat);
    face.position.y = METER_FACE_Y;
    face.receiveShadow = true;
    tilted.add(face);

    const canvas = document.createElement('canvas');
    canvas.width = LCD_W;
    canvas.height = LCD_H;
    this.lcdCtx = canvas.getContext('2d');
    this.lcdTex = new THREE.CanvasTexture(canvas);
    this.lcdTex.colorSpace = THREE.SRGBColorSpace;
    this.lcdMat = new THREE.MeshBasicMaterial({
      map: this.lcdTex,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    const lcd = new THREE.Mesh(s.lcdPlane, this.lcdMat);
    lcd.position.set(0, METER_FACE_Y + 0.3, METER_LAYOUT.lcd.z);
    tilted.add(lcd);

    this.dial = new THREE.Mesh(s.dial, s.bodyMat);
    this.dial.position.set(0, METER_FACE_Y, METER_LAYOUT.dial.z);
    this.dial.castShadow = true;
    tilted.add(this.dial);

    this.setDisplay(null);
  }

  setMode(mode: MeterDoc['mode']): void {
    // Turning the dial clears range, hold and max/min, as on a real meter; the light stays.
    if (mode !== this.mode) this.panel = newPanel(this.panel.light);
    this.mode = mode;
    this.dial.rotation.y = -DIAL_ANGLE[mode];
    this.refresh();
  }

  setInputs(inputs: MeterInputs): void {
    this.inputs = inputs;
    this.refresh();
  }

  press(b: MeterButton): void {
    pressButton(this.panel, b, this.mode, this.inputs);
    this.refresh();
  }

  autoRange(): void {
    autoRange(this.panel);
    this.refresh();
  }

  /** The button under a body-space point on the face, if any. */
  buttonAt(local: THREE.Vector3): MeterButton | undefined {
    if (local.y < METER_FACE_Y - 0.6) return undefined;
    const i = METER_LAYOUT.buttons.x.findIndex(
      (x) => Math.abs(local.x - x) <= 6 && Math.abs(local.z - METER_LAYOUT.buttons.z) <= 3.3,
    );
    return METER_BUTTONS[i];
  }

  private refresh(): void {
    this.setDisplay(readPanel(this.panel, this.mode, this.inputs), this.panel.light);
  }

  private setDisplay(d: MeterDisplay | null, lit = false): void {
    const key = (d ? `${d.text}|${d.unit}|${JSON.stringify(d.flags ?? {})}` : '') + (lit ? '|lit' : '');
    if (key === this.shown || !this.lcdCtx) return;
    this.shown = key;
    drawLcd(this.lcdCtx, d, lit);
    this.lcdTex.needsUpdate = true;
  }

  dispose(): void {
    this.lcdTex.dispose();
    this.lcdMat.dispose();
  }
}

/* ----------------------------------------------------------------------------- layer --- */

export interface MeterHit {
  id: Id;
  /** True when the ray hit the rotary switch rather than the body. */
  dial: boolean;
  /** The push button the ray hit, if any. */
  button?: MeterButton;
  distance: number;
  point: THREE.Vector3;
}

/** All desk multimeters. Add the layer itself to the scene. */
export class MeterLayer extends THREE.Group {
  private readonly models = new Map<Id, MeterModel>();
  private readonly rc = new THREE.Raycaster();

  /** Alias so it can be used wherever the other layers expose `.group`. */
  get group(): THREE.Group {
    return this;
  }

  /** Create, move and remove models to match the document. */
  update(docs: readonly MeterDoc[]): void {
    const seen = new Set<Id>();
    for (const d of docs) {
      seen.add(d.id);
      let m = this.models.get(d.id);
      if (!m) {
        m = new MeterModel();
        this.models.set(d.id, m);
        this.add(m.root);
      }

      m.root.position.set(d.x, 0, d.z);
      m.setMode(d.mode);
      m.root.updateMatrixWorld(true);
    }
    for (const [id, m] of this.models) {
      if (seen.has(id)) continue;
      this.remove(m.root);
      m.dispose();
      this.models.delete(id);
    }
  }

  /** A short press of one of a meter's buttons. */
  press(id: Id, b: MeterButton): void {
    this.models.get(id)?.press(b);
  }

  /** RANGE held down: back to auto-ranging. */
  autoRange(id: Id): void {
    this.models.get(id)?.autoRange();
  }

  /** Show what one meter reads on its display. Cheap to call every frame. */
  show(id: Id, inputs: MeterInputs): void {
    this.models.get(id)?.setInputs(inputs);
  }

  /** Nearest body or dial hit along a world-space ray. */
  pick(ray: THREE.Ray): MeterHit | null {
    this.rc.ray.copy(ray);
    let best: MeterHit | null = null;
    for (const [id, m] of this.models) {
      const hit = this.rc.intersectObjects([m.dial, m.body], false)[0];
      if (hit && (!best || hit.distance < best.distance)) {
        const dial = hit.object === m.dial;
        const button = dial ? undefined : m.buttonAt(m.tilted.worldToLocal(hit.point.clone()));
        best = { id, dial, distance: hit.distance, point: hit.point, ...(button ? { button } : {}) };
      }
    }
    return best;
  }

  /** Grow a box (e.g. shadow bounds) to cover the meters, or just the one named. */
  expand(box: THREE.Box3, only?: Id): void {
    for (const [id, m] of this.models) {
      if (only && id !== only) continue;
      const { x, z } = m.root.position;
      box.expandByPoint(new THREE.Vector3(x - METER_SIZE.x / 2, 0, z - METER_SIZE.z / 2));
      box.expandByPoint(new THREE.Vector3(x + METER_SIZE.x / 2, METER_SIZE.y, z + METER_SIZE.z / 2));
    }
  }
}

export function meterPreview(): THREE.Group {
  const model = new MeterModel();
  model.setMode('dcv');
  model.setInputs({ volts: 5, amps: 0, hertz: 0 });
  return model.root;
}
