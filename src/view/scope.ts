// A bench oscilloscope on the desk, laid out like a small digital scope: a light case with a dark
// front panel, a large screen on the left, and on the right the run buttons, the time and trigger
// knobs, a volts-per-division knob over each input, and the inputs themselves. The knobs are
// endless encoders, as on digital scopes: the screen says what they're set to.
//
// The screen is drawn into a canvas (the 3D screen's texture), which the inspector also shows large.

import * as THREE from 'three';
import { canvasFont } from '../fonts';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { Id, ScopeDoc } from '../engine/circuit';
import {
  autoLevel,
  DEFAULT_TRIGGER,
  findTrigger,
  formatFrequency,
  formatTime,
  formatVolts,
  measure,
  sampleBefore,
  SCOPE_DIV_X,
  SCOPE_DIV_Y,
  SCOPE_SIZE as S,
  SCOPE_TERMINALS,
  SCOPE_TIMEBASES,
  SCOPE_VOLTS_PER_DIV,
  valueAt,
  type Measurements,
  type Samples,
  type ScopeChannel,
  type ScopeTerminalName,
  type ScopeTrigger,
} from '../engine/scope';

const FRONT = S.z / 2;
/** Corner radius of the case. */
const CASE_R = 4.5;
/** The panel on the flat of the case front, clear of its rounded edges. */
const PANEL = { w: S.x - 2 * CASE_R - 2, h: S.y - 2 * CASE_R - 2, y: S.y / 2 + 2, r: 3 };
const PX = 10;

// Front panel positions are x across from the centre and y up from the desk, mm.
const RIGHT = PANEL.w / 2;
const TOP = PANEL.y + PANEL.h / 2;
const BOTTOM = PANEL.y - PANEL.h / 2;

/** How far a knob stands out of the panel. */
const KNOB_DEPTH = 6;
/** How far a button stands out. */
const BUTTON_DEPTH = 2.2;

export type ScopeKnob = 'time' | 'level' | 'volts1' | 'volts2';
export type ScopeButton = 'run' | 'single' | 'auto';
export type ScopeControl = ScopeKnob | ScopeButton;

/** The control column: centre of the column, and the knobs and buttons in it. */
const COLUMN_X = RIGHT - 27;
export const SCOPE_KNOBS: Record<ScopeKnob, { x: number; y: number; r: number }> = {
  time: { x: COLUMN_X - 9, y: TOP - 34.5, r: 7.5 },
  level: { x: COLUMN_X + 13, y: TOP - 32.5, r: 4.6 },
  volts1: { x: SCOPE_TERMINALS.CH1.x, y: TOP - 57.5, r: 5.6 },
  volts2: { x: SCOPE_TERMINALS.CH2.x, y: TOP - 57.5, r: 5.6 },
};
export const SCOPE_BUTTONS: Record<ScopeButton, { x: number; y: number; w: number; h: number }> = {
  run: { x: COLUMN_X - 15, y: TOP - 13.5, w: 12, h: 6.5 },
  single: { x: COLUMN_X, y: TOP - 13.5, w: 12, h: 6.5 },
  auto: { x: COLUMN_X + 15, y: TOP - 13.5, w: 12, h: 6.5 },
};

/** The display: from near the panel's left edge to the control column, nearly top to bottom. */
const DISPLAY = (() => {
  const x0 = -PANEL.w / 2 + 4;
  const x1 = COLUMN_X - 27;
  const y0 = BOTTOM + 4.5;
  const y1 = TOP - 4.5;
  return { x: (x0 + x1) / 2, y: (y0 + y1) / 2, w: x1 - x0, h: y1 - y0 };
})();

/* --------------------------------------------------------------------------- screen --- */

const SCREEN_PX = 8;
const IMAGE_W = Math.round(DISPLAY.w * SCREEN_PX);
const IMAGE_H = Math.round(DISPLAY.h * SCREEN_PX);
/** Status line along the top and channel readouts along the bottom; the graticule between. */
const TOP_BAR = 62;
const BOTTOM_BAR = 124;
const SIDE = 18;
const GRID = (() => {
  const w = Math.floor((IMAGE_W - 2 * SIDE) / SCOPE_DIV_X) * SCOPE_DIV_X;
  const h = Math.floor((IMAGE_H - TOP_BAR - BOTTOM_BAR) / SCOPE_DIV_Y) * SCOPE_DIV_Y;
  return { x: Math.round((IMAGE_W - w) / 2), y: TOP_BAR, w, h };
})();

/** Each trace is the colour of its input. */
const TRACE: Record<ScopeChannel, string> = { CH1: '#ffc94d', CH2: '#4dc3ff' };
const INK = '#e6ece9';
const DIM = '#7f8a86';

export interface ScopeShown {
  on: boolean;
  paused: boolean;
  time: number;
  ch1?: Samples;
  ch2?: Samples;
  /** Which inputs have a wire to something in the circuit. */
  wired?: { GND: boolean; CH1: boolean; CH2: boolean };
}

export interface ScopeHit {
  id: Id;
  /** The knob or button under the ray, if any. */
  control: ScopeControl | null;
  distance: number;
  point: THREE.Vector3;
}

/** What the screen shows for one channel: its recording on screen and what's measured of it. */
interface Channel {
  name: ScopeChannel;
  trace?: Samples;
  voltsPerDiv: number;
  offset: number;
  on: boolean;
  ac: boolean;
  wired: boolean;
  m: Measurements | null;
}

/** Run state: running, stopped (holding the last picture), or waiting for one trigger. */
export type ScopeRun = 'run' | 'stop' | 'single';

/** Pixel height of 1 V on a channel, and where its 0 V line is. */
function vertical(ch: Channel): { zero: number; perVolt: number } {
  const perDiv = GRID.h / SCOPE_DIV_Y;
  return { zero: GRID.y + GRID.h / 2 - ch.offset * perDiv, perVolt: perDiv / ch.voltsPerDiv };
}

/**
 * Draws a recording as straight lines between its samples. Where many samples fall in one column
 * of pixels it draws their whole spread there, so a fast signal on a slow time base shows as the
 * band it fills instead of a few samples picked out of it.
 */
function wave(
  g: CanvasRenderingContext2D,
  ch: Channel,
  end: number,
  span: number,
  shift: number,
  color: string,
  width: number,
): void {
  const trace = ch.trace;
  if (!trace?.t.length) return;
  const start = end - span;
  const { zero, perVolt } = vertical(ch);
  const xOf = (t: number): number => GRID.x + ((t - start) / span) * GRID.w;
  const yOf = (v: number): number => zero - (v - shift) * perVolt;
  g.save();
  g.beginPath();
  g.rect(GRID.x, GRID.y, GRID.w, GRID.h);
  g.clip();
  g.strokeStyle = color;
  g.lineWidth = width;
  g.lineJoin = 'round';
  g.lineCap = 'round';
  g.beginPath();
  let drawing = false;
  let column = NaN;
  let lo = 0;
  let hi = 0;
  let last = 0;
  const flush = (): void => {
    if (Number.isNaN(column)) return;
    g.lineTo(column, yOf(lo));
    g.lineTo(column, yOf(hi));
    g.lineTo(column, yOf(last));
  };
  const point = (t: number, v: number): void => {
    if (!Number.isFinite(v)) {
      flush();
      column = NaN;
      drawing = false;
      return;
    }
    const x = xOf(t);
    const c = Math.round(x);
    if (drawing && c === column) {
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
      last = v;
      return;
    }
    flush();
    if (drawing) g.lineTo(x, yOf(v));
    else g.moveTo(x, yOf(v));
    drawing = true;
    column = c;
    lo = hi = last = v;
  };
  point(start, valueAt(trace, start));
  for (let i = Math.max(0, sampleBefore(trace, start) + 1); i < trace.t.length && trace.t[i] < end; i++)
    point(trace.t[i], trace.v[i]);
  point(end, valueAt(trace, end));
  flush();
  g.stroke();
  g.restore();
}

/** The graticule: a fine grid, brighter centre axes with sub-division ticks, and a frame. */
function graticule(g: CanvasRenderingContext2D): void {
  const { x, y, w, h } = GRID;
  g.lineWidth = 1;
  g.strokeStyle = '#1c2724';
  g.beginPath();
  for (let i = 1; i < SCOPE_DIV_X; i++) {
    const px = x + (i * w) / SCOPE_DIV_X + 0.5;
    g.moveTo(px, y);
    g.lineTo(px, y + h);
  }
  for (let i = 1; i < SCOPE_DIV_Y; i++) {
    const py = y + (i * h) / SCOPE_DIV_Y + 0.5;
    g.moveTo(x, py);
    g.lineTo(x + w, py);
  }
  g.stroke();
  g.strokeStyle = '#2f413b';
  g.beginPath();
  g.moveTo(x, y + h / 2 + 0.5);
  g.lineTo(x + w, y + h / 2 + 0.5);
  g.moveTo(x + w / 2 + 0.5, y);
  g.lineTo(x + w / 2 + 0.5, y + h);
  g.stroke();
  // Five ticks per division along both centre axes.
  g.fillStyle = '#3a5048';
  for (let i = 0; i <= SCOPE_DIV_X * 5; i++)
    g.fillRect(x + (i * w) / (SCOPE_DIV_X * 5) - 0.5, y + h / 2 - (i % 5 ? 3 : 5), 1, i % 5 ? 6 : 10);
  for (let i = 0; i <= SCOPE_DIV_Y * 5; i++)
    g.fillRect(x + w / 2 - (i % 5 ? 3 : 5), y + (i * h) / (SCOPE_DIV_Y * 5) - 0.5, i % 5 ? 6 : 10, 1);
  g.strokeStyle = '#2f413b';
  g.lineWidth = 1.5;
  g.strokeRect(x + 0.5, y + 0.5, w, h);
}

/** A small flag on the graticule's edge: a channel's 0 V line on the left, the trigger level on the right. */
function flag(g: CanvasRenderingContext2D, side: 'left' | 'right', y: number, color: string, text: string): void {
  const clamped = Math.max(GRID.y + 13, Math.min(GRID.y + GRID.h - 13, y));
  const x = side === 'left' ? GRID.x : GRID.x + GRID.w;
  const dir = side === 'left' ? 1 : -1;
  g.fillStyle = color;
  g.beginPath();
  g.moveTo(x - dir * 18, clamped - 13);
  g.lineTo(x - dir * 1, clamped - 13);
  g.lineTo(x + dir * 11, clamped);
  g.lineTo(x - dir * 1, clamped + 13);
  g.lineTo(x - dir * 18, clamped + 13);
  g.closePath();
  g.fill();
  g.fillStyle = '#0c0e0d';
  g.font = canvasFont('label', 700, 20);
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, x - dir * 7, clamped + 1);
}

/** Everything the screen shows, drawn into `g` (IMAGE_W × IMAGE_H). */
function drawScreen(
  g: CanvasRenderingContext2D,
  s: ScopeShown,
  doc: ScopeDoc,
  run: ScopeRun,
  view: { end: number; triggered: boolean; level: number },
  channels: Channel[],
): void {
  g.fillStyle = '#0c0e0d';
  g.fillRect(0, 0, IMAGE_W, IMAGE_H);
  graticule(g);
  const span = doc.timebase;
  const trigger = doc.trigger ?? DEFAULT_TRIGGER;
  const source = channels.find((c) => c.name === trigger.source)!;

  if (s.on) {
    for (const ch of channels) {
      if (!ch.on || !ch.trace) continue;
      const shift = ch.ac && ch.m ? ch.m.mean : 0;
      // A soft glow under a crisp line.
      g.globalAlpha = 0.2;
      wave(g, ch, view.end, span, shift, TRACE[ch.name], 7);
      g.globalAlpha = 1;
      wave(g, ch, view.end, span, shift, TRACE[ch.name], 2.4);
    }
  }
  for (const ch of channels)
    if (ch.on) flag(g, 'left', vertical(ch).zero, TRACE[ch.name], ch.name === 'CH1' ? '1' : '2');
  if (source.on)
    flag(
      g,
      'right',
      vertical(source).zero - (view.level - (source.ac && source.m ? source.m.mean : 0)) * vertical(source).perVolt,
      TRACE[source.name],
      'T',
    );
  // The trigger point, at the middle of the screen.
  g.fillStyle = '#ff8a3d';
  g.beginPath();
  g.moveTo(GRID.x + GRID.w / 2 - 9, GRID.y - 12);
  g.lineTo(GRID.x + GRID.w / 2 + 9, GRID.y - 12);
  g.lineTo(GRID.x + GRID.w / 2, GRID.y - 1);
  g.closePath();
  g.fill();

  // Status line: run state, time base, trigger.
  g.textBaseline = 'middle';
  const midY = TOP_BAR / 2 - 3;
  const state = !s.on
    ? 'OFF'
    : run === 'stop'
      ? 'STOP'
      : run === 'single'
        ? 'WAIT'
        : s.paused
          ? 'HOLD'
          : view.triggered
            ? "TRIG'D"
            : trigger.mode === 'normal'
              ? 'WAIT'
              : 'AUTO';
  const stateColor =
    !s.on || run === 'stop'
      ? '#ff5a52'
      : run === 'single' || state === 'WAIT' || state === 'HOLD'
        ? '#ffb84d'
        : '#4dff88';
  g.font = canvasFont('label', 700, 28);
  const sw = g.measureText(state).width + 24;
  g.fillStyle = stateColor;
  g.beginPath();
  g.roundRect(SIDE, midY - 20, sw, 40, 7);
  g.fill();
  g.fillStyle = '#0c0e0d';
  g.textAlign = 'center';
  g.fillText(state, SIDE + sw / 2, midY + 1);
  g.textAlign = 'left';
  g.font = canvasFont('mono', 600, 30);
  g.fillStyle = INK;
  g.fillText(`${formatTime(span / SCOPE_DIV_X)}/div`, SIDE + sw + 22, midY + 1);
  // Trigger: the source's colour, which way, the level, and the mode in grey after it.
  const mode = trigger.mode === 'auto' ? 'Auto' : trigger.mode === 'normal' ? 'Norm' : 'Single';
  g.textAlign = 'right';
  g.font = canvasFont('label', 600, 24);
  g.fillStyle = DIM;
  g.fillText(mode, IMAGE_W - SIDE, midY + 1);
  const modeW = g.measureText(mode).width + 16;
  g.font = canvasFont('mono', 600, 30);
  g.fillStyle = TRACE[trigger.source];
  g.fillText(
    `${trigger.source}${trigger.edge === 'rise' ? '↑' : '↓'}${formatVolts(view.level)}`,
    IMAGE_W - SIDE - modeW,
    midY + 1,
  );

  // A readout for each channel along the bottom: its scale, then its frequency and swing.
  const gap = 14;
  const half = (IMAGE_W - 2 * SIDE - gap) / 2;
  channels.forEach((ch, k) => {
    const x = SIDE + k * (half + gap);
    const y = GRID.y + GRID.h + 10;
    const h = BOTTOM_BAR - 16;
    g.fillStyle = '#151a18';
    g.beginPath();
    g.roundRect(x, y, half, h, 7);
    g.fill();
    g.globalAlpha = ch.on ? 1 : 0.4;
    g.fillStyle = TRACE[ch.name];
    g.fillRect(x, y, 7, h);
    g.textAlign = 'left';
    g.font = canvasFont('label', 700, 28);
    g.fillText(ch.name, x + 20, y + h * 0.3);
    g.font = canvasFont('mono', 600, 28);
    g.fillStyle = INK;
    g.fillText(`${formatVolts(ch.voltsPerDiv)}/div${ch.ac ? ' AC' : ''}`, x + 92, y + h * 0.3);
    let line = '';
    if (!ch.on) line = 'off';
    else if (!ch.wired) line = 'not connected';
    else if (!s.on) line = '';
    else if (ch.m)
      line = Number.isFinite(ch.m.frequency)
        ? `${formatFrequency(ch.m.frequency)}  ${formatVolts(ch.m.pp)}pp`
        : `${formatVolts(ch.m.mean)} avg`;
    g.font = canvasFont('mono', 600, 28);
    g.fillStyle = line === 'not connected' || line === 'off' ? DIM : INK;
    g.fillText(line, x + 20, y + h * 0.74);
    g.globalAlpha = 1;
  });

  // What's missing, in the middle of the screen.
  const note = !s.on
    ? 'Turn the power on to see signals'
    : s.wired && !s.wired.GND
      ? 'Connect GND to the circuit’s ground'
      : s.wired && !s.wired.CH1 && !s.wired.CH2
        ? 'Wire CH1 or CH2 to a signal'
        : '';
  if (note) {
    g.font = canvasFont('label', 600, 30);
    const w = g.measureText(note).width + 40;
    g.fillStyle = 'rgba(12,14,13,0.85)';
    g.beginPath();
    g.roundRect(GRID.x + (GRID.w - w) / 2, GRID.y + GRID.h / 2 - 30, w, 60, 8);
    g.fill();
    g.fillStyle = s.on ? '#ffb84d' : DIM;
    g.textAlign = 'center';
    g.fillText(note, GRID.x + GRID.w / 2, GRID.y + GRID.h / 2 + 1);
  }
}

/* ----------------------------------------------------------------------------- parts --- */

const caseMaterial = new THREE.MeshStandardMaterial({ color: 0xdedcd6, roughness: 0.55 });
const footMaterial = new THREE.MeshStandardMaterial({ color: 0x1d1e20, roughness: 0.9 });
const ventMaterial = new THREE.MeshStandardMaterial({ color: 0xa9a7a1, roughness: 0.8 });
const knobMaterial = new THREE.MeshStandardMaterial({ color: 0x9aa0a8, roughness: 0.5 });
const knobCapMaterial = new THREE.MeshStandardMaterial({ color: 0xbfc4ca, metalness: 0.35, roughness: 0.3 });
const markMaterial = new THREE.MeshBasicMaterial({ color: 0x1d1f22 });
const glassMaterial = new THREE.MeshStandardMaterial({
  color: 0x0b0c0d,
  roughness: 0.08,
  metalness: 0.2,
  transparent: true,
  opacity: 0.3,
});
const buttonMaterial = new THREE.MeshStandardMaterial({ color: 0x8d939b, roughness: 0.5 });
const lit: Record<'green' | 'red' | 'amber' | 'off', THREE.Material> = {
  green: new THREE.MeshBasicMaterial({ color: 0x4dff88, toneMapped: false }),
  red: new THREE.MeshBasicMaterial({ color: 0xff4a40, toneMapped: false }),
  amber: new THREE.MeshBasicMaterial({ color: 0xffb03a, toneMapped: false }),
  off: new THREE.MeshStandardMaterial({ color: 0x55595f, roughness: 0.45 }),
};
const bncMetal = new THREE.MeshStandardMaterial({ color: 0xd6d9de, metalness: 0.92, roughness: 0.24 });
const bncPin = new THREE.MeshStandardMaterial({ color: 0xd6c48a, metalness: 1, roughness: 0.3 });
const bncInsulator: Record<ScopeTerminalName, THREE.MeshStandardMaterial> = {
  GND: new THREE.MeshStandardMaterial({ color: 0x2b2e32, roughness: 0.55 }),
  CH1: new THREE.MeshStandardMaterial({ color: 0xdea228, roughness: 0.45 }),
  CH2: new THREE.MeshStandardMaterial({ color: 0x36a2e8, roughness: 0.45 }),
};
/** Printed label colours, matching each input's insulator. */
const LABEL: Record<ScopeTerminalName, string> = { GND: '#9ca1a8', CH1: TRACE.CH1, CH2: TRACE.CH2 };

let shared: {
  body: THREE.BufferGeometry;
  panel: THREE.BufferGeometry;
  panelMaterial: THREE.MeshStandardMaterial;
  feet: THREE.BufferGeometry;
  vents: THREE.BufferGeometry;
  knobs: Record<ScopeKnob, THREE.BufferGeometry>;
  knobCaps: Record<ScopeKnob, THREE.BufferGeometry>;
  marks: Record<ScopeKnob, THREE.BufferGeometry>;
  button: THREE.BufferGeometry;
  buttonLight: THREE.BufferGeometry;
  bnc: THREE.BufferGeometry;
  bncInsulator: THREE.BufferGeometry;
  bncPin: THREE.BufferGeometry;
  screen: THREE.BufferGeometry;
} | null = null;

/** The front panel's printing: control names, input labels, and a frame around the display. */
function panelTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = PANEL.w * PX;
  canvas.height = PANEL.h * PX;
  const g = canvas.getContext('2d')!;
  const X = (x: number): number => (x + PANEL.w / 2) * PX;
  const Y = (y: number): number => (PANEL.y + PANEL.h / 2 - y) * PX;
  const font = (weight: number, mm: number): string => canvasFont('label', weight, mm * PX);
  g.fillStyle = '#26282c';
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  const label = (text: string, x: number, y: number, color = '#b4b9c0', mm = 2.1): void => {
    g.fillStyle = color;
    g.font = font(700, mm);
    g.fillText(text, X(x), Y(y));
  };
  label('RUN/STOP', SCOPE_BUTTONS.run.x, SCOPE_BUTTONS.run.y + 5.6, '#b4b9c0', 1.7);
  label('SINGLE', SCOPE_BUTTONS.single.x, SCOPE_BUTTONS.single.y + 5.6, '#b4b9c0', 1.7);
  label('AUTO', SCOPE_BUTTONS.auto.x, SCOPE_BUTTONS.auto.y + 5.6, '#b4b9c0', 1.7);
  label('TIME/DIV', SCOPE_KNOBS.time.x, SCOPE_KNOBS.time.y + SCOPE_KNOBS.time.r + 3.2);
  label('LEVEL', SCOPE_KNOBS.level.x, SCOPE_KNOBS.level.y + SCOPE_KNOBS.level.r + 3.2);
  label('PUSH 50%', SCOPE_KNOBS.level.x, SCOPE_KNOBS.level.y - SCOPE_KNOBS.level.r - 2.6, '#80858c', 1.5);
  label(
    'VOLTS/DIV',
    (SCOPE_KNOBS.volts1.x + SCOPE_KNOBS.volts2.x) / 2,
    SCOPE_KNOBS.volts1.y + SCOPE_KNOBS.volts1.r + 6.4,
  );
  label('1', SCOPE_KNOBS.volts1.x, SCOPE_KNOBS.volts1.y + SCOPE_KNOBS.volts1.r + 2.6, LABEL.CH1);
  label('2', SCOPE_KNOBS.volts2.x, SCOPE_KNOBS.volts2.y + SCOPE_KNOBS.volts2.r + 2.6, LABEL.CH2);
  for (const [name, t] of Object.entries(SCOPE_TERMINALS) as [ScopeTerminalName, { x: number; y: number }][])
    label(name, t.x, t.y + 6.2, LABEL[name], 2);
  // A thin rule boxing the controls off from the screen.
  g.strokeStyle = '#3a3d42';
  g.lineWidth = 0.35 * PX;
  g.beginPath();
  g.roundRect(X(COLUMN_X - 23.5), Y(TOP - 2.2), 47 * PX, (PANEL.h - 4.4) * PX, 1.5 * PX);
  g.stroke();
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

/** A ridged encoder knob of radius `r`, standing out of the panel along +z. */
function encoder(r: number): THREE.BufferGeometry {
  const knob = new THREE.CylinderGeometry(r, r * 1.05, KNOB_DEPTH, 48, 1);
  const pos = knob.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    if (Math.hypot(x, z) < r * 0.9) continue;
    const k = 1 + 0.04 * Math.max(0, Math.cos(Math.atan2(z, x) * 20));
    pos.setXYZ(i, x * k, pos.getY(i), z * k);
  }
  knob.computeVertexNormals();
  return knob.rotateX(Math.PI / 2).translate(0, 0, KNOB_DEPTH / 2);
}

/** A BNC socket's metal, at about two thirds the size of a real one: hex nut, hollow barrel and bayonet studs. */
function bncBody(): THREE.BufferGeometry {
  const nut = new THREE.CylinderGeometry(5.6, 5.6, 1.5, 6).rotateX(Math.PI / 2).translate(0, 0, 0.75);
  const profile = [
    [0, 1.4],
    [4.5, 1.4],
    [4.5, 5.4],
    [4.1, 5.8],
    [3.3, 5.8],
    [3.3, 2.6],
    [0, 2.6],
  ].map(([r, h]) => new THREE.Vector2(r, h));
  const barrel = new THREE.LatheGeometry(profile, 28).rotateX(Math.PI / 2);
  const studs = new THREE.CylinderGeometry(0.6, 0.6, 11.4, 8).rotateZ(Math.PI / 2).translate(0, 0, 4.2);
  return mergeGeometries([nut, barrel, studs])!.scale(BNC_SCALE, BNC_SCALE, BNC_SCALE);
}
const BNC_SCALE = 0.62;

function geometries(): NonNullable<typeof shared> {
  if (shared) return shared;
  const feet = [
    [-1, -1],
    [1, -1],
    [-1, 1],
    [1, 1],
  ].map(([x, z]) => new THREE.CylinderGeometry(5, 5.5, 2, 20).translate(x * (S.x / 2 - 9), 1, z * (S.z / 2 - 10)));
  const vents = Array.from({ length: 9 }, (_, k) =>
    new THREE.BoxGeometry(S.x * 0.42, 0.3, 1.1).translate(0, S.y + 2.0, -S.z / 2 + 20 + k * 4.5),
  );
  const per = <T>(make: (k: ScopeKnob, r: number) => T): Record<ScopeKnob, T> => ({
    time: make('time', SCOPE_KNOBS.time.r),
    level: make('level', SCOPE_KNOBS.level.r),
    volts1: make('volts1', SCOPE_KNOBS.volts1.r),
    volts2: make('volts2', SCOPE_KNOBS.volts2.r),
  });
  shared = {
    body: new RoundedBoxGeometry(S.x, S.y, S.z, 5, CASE_R).translate(0, S.y / 2 + 2, 0),
    panel: panelGeometry(),
    panelMaterial: new THREE.MeshStandardMaterial({ map: panelTexture(), roughness: 0.62 }),
    feet: mergeGeometries(feet)!,
    vents: mergeGeometries(vents)!,
    knobs: per((_, r) => encoder(r)),
    knobCaps: per((_, r) =>
      new THREE.CylinderGeometry(r * 0.78, r * 0.78, 0.5, 40).rotateX(Math.PI / 2).translate(0, 0, KNOB_DEPTH + 0.05),
    ),
    marks: per((_, r) => new THREE.BoxGeometry(0.8, r * 0.5, 0.3).translate(0, r * 0.5, KNOB_DEPTH + 0.35)),
    button: new RoundedBoxGeometry(SCOPE_BUTTONS.run.w, SCOPE_BUTTONS.run.h, BUTTON_DEPTH, 2, 1).translate(
      0,
      0,
      BUTTON_DEPTH / 2,
    ),
    buttonLight: new THREE.BoxGeometry(SCOPE_BUTTONS.run.w - 5, 1.4, 0.3).translate(0, 0, BUTTON_DEPTH + 0.1),
    bnc: bncBody(),
    bncInsulator: new THREE.CylinderGeometry(2.7 * BNC_SCALE, 2.7 * BNC_SCALE, 1, 24)
      .rotateX(Math.PI / 2)
      .translate(0, 0, 3.1 * BNC_SCALE),
    bncPin: new THREE.CylinderGeometry(0.75 * BNC_SCALE, 0.75 * BNC_SCALE, 2.2 * BNC_SCALE, 12)
      .rotateX(Math.PI / 2)
      .translate(0, 0, 4.6 * BNC_SCALE),
    screen: new THREE.PlaneGeometry(DISPLAY.w, DISPLAY.h),
  };
  return shared;
}

/* ----------------------------------------------------------------------------- model --- */

/** One scope on the desk, with its live display. */
class ScopeModel {
  readonly root = new THREE.Group();
  readonly knobs = {} as Record<ScopeKnob, THREE.Group>;
  readonly buttons = {} as Record<ScopeButton, THREE.Mesh>;
  /** The screen's picture, also shown large in the inspector. */
  readonly canvas: HTMLCanvasElement;
  private readonly context: CanvasRenderingContext2D;
  private readonly texture: THREE.CanvasTexture;
  private readonly screenMaterial: THREE.MeshBasicMaterial;
  private readonly lights = {} as Record<ScopeButton, THREE.Mesh>;
  private doc: ScopeDoc = { id: '', x: 0, z: 0, timebase: 0.1, voltsPerDiv: 2 };
  private last: ScopeShown = { on: false, paused: false, time: 0 };
  run: ScopeRun = 'run';
  /** When Single was pressed: only a trigger after this counts. */
  private armedAt = -Infinity;
  /** The picture held while stopped: each channel's recording on screen then, and where the screen ended. */
  private frozen: { end: number; ch1?: Samples; ch2?: Samples; level: number; triggered: boolean } | null = null;
  /** In Normal trigger mode, where the screen ended at the last trigger. */
  private lastEnd: number | null = null;
  /** What each channel measured on the latest picture. */
  measured: { CH1: Measurements | null; CH2: Measurements | null } = { CH1: null, CH2: null };
  /** Called after the screen is drawn again. */
  onDraw: (() => void) | null = null;

  constructor() {
    const g = geometries();
    const add = (
      geometry: THREE.BufferGeometry,
      material: THREE.Material,
      parent: THREE.Object3D = this.root,
    ): THREE.Mesh => {
      const mesh = new THREE.Mesh(geometry, material);
      mesh.castShadow = mesh.receiveShadow = true;
      parent.add(mesh);
      return mesh;
    };
    add(g.body, caseMaterial);
    add(g.panel, g.panelMaterial);
    add(g.feet, footMaterial);
    add(g.vents, ventMaterial);

    this.canvas = document.createElement('canvas');
    this.canvas.width = IMAGE_W;
    this.canvas.height = IMAGE_H;
    this.context = this.canvas.getContext('2d')!;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 8;
    this.screenMaterial = new THREE.MeshBasicMaterial({ map: this.texture, toneMapped: false });
    const screen = new THREE.Mesh(g.screen, this.screenMaterial);
    screen.position.set(DISPLAY.x, DISPLAY.y, FRONT + 0.15);
    this.root.add(screen);
    const glass = new THREE.Mesh(g.screen, glassMaterial);
    glass.position.set(DISPLAY.x, DISPLAY.y, FRONT + 0.3);
    this.root.add(glass);

    for (const k of Object.keys(SCOPE_KNOBS) as ScopeKnob[]) {
      const group = new THREE.Group();
      add(g.knobs[k], knobMaterial, group);
      add(g.knobCaps[k], knobCapMaterial, group);
      add(g.marks[k], markMaterial, group);
      group.position.set(SCOPE_KNOBS[k].x, SCOPE_KNOBS[k].y, FRONT);
      this.root.add(group);
      this.knobs[k] = group;
    }
    for (const b of Object.keys(SCOPE_BUTTONS) as ScopeButton[]) {
      const mesh = add(g.button, buttonMaterial);
      mesh.position.set(SCOPE_BUTTONS[b].x, SCOPE_BUTTONS[b].y, FRONT);
      this.buttons[b] = mesh;
      const light = add(g.buttonLight, lit.off);
      light.position.set(SCOPE_BUTTONS[b].x, SCOPE_BUTTONS[b].y + 1.6, FRONT);
      this.lights[b] = light;
    }
    for (const [name, t] of Object.entries(SCOPE_TERMINALS) as [ScopeTerminalName, { x: number; y: number }][]) {
      const jack = new THREE.Group();
      add(g.bnc, bncMetal, jack);
      add(g.bncInsulator, bncInsulator[name], jack);
      add(g.bncPin, bncPin, jack);
      jack.position.set(t.x, t.y, FRONT);
      this.root.add(jack);
    }
    this.render();
  }

  set(doc: ScopeDoc): void {
    this.root.position.set(doc.x, 0, doc.z);
    this.doc = doc;
    // Endless knobs: each step turns them a little further.
    const turn = (list: readonly number[], v: number): number => -list.indexOf(v) * (Math.PI / 10);
    this.knobs.time.rotation.z = -turn(SCOPE_TIMEBASES, doc.timebase);
    this.knobs.volts1.rotation.z = -turn(SCOPE_VOLTS_PER_DIV, doc.voltsPerDiv);
    this.knobs.volts2.rotation.z = -turn(SCOPE_VOLTS_PER_DIV, doc.voltsPerDiv2 ?? doc.voltsPerDiv);
    this.knobs.level.rotation.z = -(doc.trigger?.level ?? 0) * 0.6;
    // A turned knob changes the picture even if no new samples arrive.
    this.render();
  }

  show(shown: ScopeShown): void {
    // Each run starts afresh: what was held from the last one no longer applies.
    if (shown.on && !this.last.on) {
      this.frozen = null;
      this.lastEnd = null;
      if (this.run === 'stop') this.run = 'run';
    }
    this.last = shown;
    this.render();
  }

  /** RUN/STOP: freezes the picture, or carries on. */
  toggleRun(): void {
    if (this.run === 'run') this.freeze();
    else {
      this.run = 'run';
      this.frozen = null;
    }
    this.render();
  }

  /** SINGLE: waits for the next trigger, then holds that picture. */
  single(): void {
    this.run = 'single';
    this.frozen = null;
    this.armedAt = this.last.time;
    this.render();
  }

  /** Holds what's on screen now. */
  private freeze(): void {
    const view = this.picture();
    const cut = (trace?: Samples): Samples | undefined => {
      if (!trace) return undefined;
      const from = Math.max(0, sampleBefore(trace, view.end - this.doc.timebase));
      const to = sampleBefore(trace, view.end) + 2;
      return { t: trace.t.slice(from, to), v: trace.v.slice(from, to) };
    };
    this.frozen = {
      end: view.end,
      ch1: cut(this.last.ch1),
      ch2: cut(this.last.ch2),
      level: view.level,
      triggered: view.triggered,
    };
    this.run = 'stop';
  }

  private channels(): Channel[] {
    const d = this.doc;
    const s = this.frozen ?? this.last;
    return (['CH1', 'CH2'] as const).map((name) => {
      const one = name === 'CH1';
      return {
        name,
        trace: one ? s.ch1 : s.ch2,
        voltsPerDiv: one ? d.voltsPerDiv : (d.voltsPerDiv2 ?? d.voltsPerDiv),
        offset: (one ? d.offset1 : d.offset2) ?? 0,
        on: !(one ? d.off1 : d.off2),
        ac: !!(one ? d.ac1 : d.ac2),
        wired: this.last.wired?.[name] ?? true,
        m: null,
      };
    });
  }

  /** Where the picture ends and whether a trigger put it there, and the trigger level in use. */
  private picture(): { end: number; triggered: boolean; level: number } {
    const s = this.last;
    const trigger: ScopeTrigger = this.doc.trigger ?? DEFAULT_TRIGGER;
    const span = this.doc.timebase;
    const trace = trigger.source === 'CH1' ? s.ch1 : s.ch2;
    const level = trigger.level ?? (trace ? autoLevel(trace, s.time, span) : 0);
    const end = findTrigger(trace, s.time, span, trigger.edge, level);
    if (end !== null) {
      this.lastEnd = end;
      return { end, triggered: true, level };
    }
    if (trigger.mode === 'normal' && this.lastEnd !== null) return { end: this.lastEnd, triggered: false, level };
    return { end: s.time, triggered: false, level };
  }

  render(): void {
    const s = this.last;
    let view: { end: number; triggered: boolean; level: number };
    if (this.frozen) view = this.frozen;
    else {
      view = this.picture();
      // Waiting for one trigger: once one comes after Single was pressed, hold it.
      if (this.run === 'single' && s.on && view.triggered && view.end - this.doc.timebase / 2 > this.armedAt) {
        this.freeze();
        view = this.frozen!;
      }
    }
    const channels = this.channels();
    for (const ch of channels)
      ch.m = s.on && ch.on && ch.wired ? measure(ch.trace, view.end - this.doc.timebase, view.end) : null;
    this.measured = { CH1: channels[0].m, CH2: channels[1].m };
    drawScreen(this.context, s, this.doc, this.run, view, channels);
    this.texture.needsUpdate = true;
    this.lights.run.material = !s.on ? lit.off : this.run === 'stop' ? lit.red : lit.green;
    this.lights.single.material = s.on && this.run === 'single' ? lit.amber : lit.off;
    this.onDraw?.();
  }

  dispose(): void {
    this.texture.dispose();
    this.screenMaterial.dispose();
  }
}

/* ----------------------------------------------------------------------------- layer --- */

/** Every scope on the desk. */
export class ScopeLayer extends THREE.Group {
  private readonly models = new Map<Id, ScopeModel>();
  private readonly raycaster = new THREE.Raycaster();

  update(docs: readonly ScopeDoc[]): void {
    const seen = new Set<Id>();
    for (const doc of docs) {
      seen.add(doc.id);
      let model = this.models.get(doc.id);
      if (!model) {
        model = new ScopeModel();
        this.models.set(doc.id, model);
        this.add(model.root);
      }
      model.set(doc);
    }
    for (const [id, model] of this.models) {
      if (seen.has(id)) continue;
      this.remove(model.root);
      model.dispose();
      this.models.delete(id);
    }
  }

  show(id: Id, shown: ScopeShown): void {
    this.models.get(id)?.show(shown);
  }

  toggleRun(id: Id): void {
    this.models.get(id)?.toggleRun();
  }

  single(id: Id): void {
    this.models.get(id)?.single();
  }

  runState(id: Id): ScopeRun | null {
    return this.models.get(id)?.run ?? null;
  }

  /** The screen's picture, for showing it large. */
  screen(id: Id): HTMLCanvasElement | null {
    return this.models.get(id)?.canvas ?? null;
  }

  measurements(id: Id): ScopeModel['measured'] | null {
    return this.models.get(id)?.measured ?? null;
  }

  /** Called whenever a scope's screen is drawn again. */
  onDraw(id: Id, fn: (() => void) | null): void {
    const model = this.models.get(id);
    if (model) model.onDraw = fn;
  }

  /** The scope under the ray, and which knob or button if it's on one. */
  pick(ray: THREE.Ray): ScopeHit | null {
    let best: ScopeHit | null = null;
    const hit = new THREE.Vector3();
    for (const [id, model] of this.models) {
      const { x, z } = model.root.position;
      const box = new THREE.Box3(
        new THREE.Vector3(x - S.x / 2, 0, z - S.z / 2),
        new THREE.Vector3(x + S.x / 2, S.y + 4, z + FRONT + KNOB_DEPTH),
      );
      if (!ray.intersectBox(box, hit)) continue;
      const distance = hit.distanceTo(ray.origin);
      if (best && distance >= best.distance) continue;
      let control: ScopeControl | null = null;
      // Knobs and buttons stick out of the front: test the planes through their faces.
      const at = (depth: number): THREE.Vector3 | null =>
        ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 0, 1), -(z + FRONT + depth)), new THREE.Vector3());
      const knobFace = at(KNOB_DEPTH * 0.6);
      if (knobFace) {
        for (const [k, c] of Object.entries(SCOPE_KNOBS) as [ScopeKnob, (typeof SCOPE_KNOBS)[ScopeKnob]][]) {
          if (Math.hypot(knobFace.x - (x + c.x), knobFace.y - c.y) < c.r + 0.8) control = k;
        }
      }
      const buttonFace = control ? null : at(BUTTON_DEPTH);
      if (buttonFace) {
        for (const [b, c] of Object.entries(SCOPE_BUTTONS) as [ScopeButton, (typeof SCOPE_BUTTONS)[ScopeButton]][]) {
          if (Math.abs(buttonFace.x - (x + c.x)) < c.w / 2 + 0.5 && Math.abs(buttonFace.y - c.y) < c.h / 2 + 0.5)
            control = b;
        }
      }
      // From a steep angle the planes miss: fall back to the meshes themselves.
      if (!control) {
        this.raycaster.ray.copy(ray);
        const knobMeshes = Object.entries(model.knobs).map(([k, group]) => [k, group.children[0]] as const);
        const buttonMeshes = Object.entries(model.buttons);
        const targets = [...knobMeshes, ...buttonMeshes] as [ScopeControl, THREE.Object3D][];
        const first = this.raycaster.intersectObjects(
          targets.map(([, o]) => o),
          false,
        )[0];
        if (first) control = targets.find(([, o]) => o === first.object)?.[0] ?? null;
      }
      best = { id, control, distance, point: hit.clone() };
    }
    return best;
  }

  /** Grows `box` to take in every scope, or just `only`. */
  expand(box: THREE.Box3, only?: Id): void {
    for (const [id, model] of this.models) {
      if (only && id !== only) continue;
      const { x, z } = model.root.position;
      box.expandByPoint(new THREE.Vector3(x - S.x / 2, 0, z - S.z / 2));
      box.expandByPoint(new THREE.Vector3(x + S.x / 2, S.y + 4, z + FRONT + 10));
    }
  }
}

/** A scope on its own, for the parts panel picture: a square wave and a sine across the screen. */
export function scopePreview(): THREE.Group {
  const model = new ScopeModel();
  model.set({ id: 'preview', x: 0, z: 0, timebase: 0.1, voltsPerDiv: 2, voltsPerDiv2: 2 });
  const t: number[] = [];
  for (let i = 0; i <= 400; i++) t.push(i * 0.0005);
  model.show({
    on: true,
    paused: false,
    time: 0.2,
    ch1: { t, v: t.map((x) => (Math.floor(x / 0.025) % 2 ? 0 : 5)) },
    ch2: { t, v: t.map((x) => 2.5 + 1.8 * Math.sin((x / 0.05) * Math.PI * 2)) },
  });
  return model.root;
}
