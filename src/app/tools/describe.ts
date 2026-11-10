// What the status bar says about what's under the pointer, and the labels drawn over the view:
// + and − on a polarised part's legs, and the names of a chip's pins.

import * as THREE from 'three';
import { BOARD_HEIGHT as H, describeHole, isRailStrip } from '../../engine/breadboard';
import { holeKey, type Id, type PartDoc } from '../../engine/circuit';
import { BUTTON_NAMES, MODE_NAMES } from '../../engine/meter';
import {
  formatFarads,
  formatOhms,
  PARTS,
  powerSideVolts,
  powerText,
  SEGMENT_NAMES,
  SEGMENT_PINS,
  type PartDef,
} from '../../engine/parts';
import { formatTime, formatVolts } from '../../engine/scope';
import { sketchOf } from '../../engine/sim/nano';
import type { ScreenTag } from '../../ui/tags';
import type { HoleHit, ItemRef, SceneSync } from '../scene-sync';
import type { Simulation } from '../simulation';
import type { Store } from '../store';

/** What the descriptions read from. */
export interface Describing {
  readonly store: Store;
  readonly sync: SceneSync;
  readonly sim: Simulation;
  /** The trigger level a scope is using now (its own, or the middle of the signal). */
  scopeLevel(id: Id): number;
}

/** How a voltage reads to TTL logic. */
export function describeVolts(v: number): string {
  if (!Number.isFinite(v)) return 'Floating';
  const level = v >= 2 ? 'high' : v <= 0.8 ? 'low' : 'invalid';
  return `${v.toFixed(2)} V ${level}`;
}

const mA = (amps: number, digits = 1): string => `${(amps * 1000).toFixed(digits)} mA`;

/** What a part's leg in a hole is. */
export function describePin(part: PartDoc, pin: number): string {
  const def = PARTS[part.def];
  if (!def) return '';
  switch (def.kind) {
    case 'dip':
      return `${def.id} pin ${pin + 1} (${def.pinNames[pin]})`;
    case 'led':
      return `${def.title} LED ${pin === 0 ? 'anode (+)' : 'cathode (−)'}`;
    case 'resistor':
      return `${formatOhms(part.value ?? 470)} resistor`;
    case 'capacitor': {
      const leg = def.style === 'electrolytic' ? (pin === 0 ? ' + leg' : ' − leg') : '';
      return `${formatFarads(part.value ?? 1e-6)} capacitor${leg}`;
    }
    case 'diode':
      return `${def.title} ${pin === 0 ? 'anode' : 'cathode (band)'}`;
    case 'pot':
      return `Potentiometer ${pin === 1 ? 'wiper' : `end ${pin === 0 ? 1 : 3}`}`;
    case 'slide':
      return `Slide switch ${pin === 1 ? 'common' : `pin ${pin + 1}`}`;
    case 'transistor':
      return `${def.title} ${['emitter', 'base', 'collector'][pin]}`;
    case 'display': {
      const s = SEGMENT_PINS.indexOf(pin + 1);
      const what = s >= 0 ? `segment ${SEGMENT_NAMES[s]}` : def.common === 'cathode' ? 'common −' : 'common +';
      return `7-segment pin ${pin + 1} (${what})`;
    }
    case 'power': {
      if (pin % 2) return 'Power module ground';
      const volts = powerSideVolts(part.state, pin < 2 ? 0 : 1);
      return volts === null ? 'Power module + (jumper off)' : `Power module +${volts} V`;
    }
    case 'button':
      return 'Push button leg';
    case 'dipswitch':
      return `DIP switch ${(pin % def.positions) + 1}`;
    case 'nano':
      return `Nano pin ${pin + 1} (${def.pinNames[pin]})`;
    case 'bargraph':
      return pin < def.segments
        ? `Bar graph pin ${pin + 1} (bar ${pin + 1} +)`
        : `Bar graph pin ${pin + 1} (bar ${2 * def.segments - pin} −)`;
    case 'network':
      return pin === 0 ? 'Resistor network pin 1 (common)' : `Resistor network pin ${pin + 1}`;
    case 'lcd':
      return `LCD pin ${pin + 1} (${def.pinNames[pin]})`;
  }
}

/** The hole or bench terminal under the pointer: where it is, what's in it, and its voltage while running. */
export function describeHoleHit(d: Describing, h: HoleHit): string[] {
  const { store, sync, sim } = d;
  const live = sim.result.live;
  if (h.terminal) {
    const v = live ? sim.result.volts(h.ref) : null;
    const meter = sync.meter(h.ref.board);
    const scope = sync.scope(h.ref.board);
    const label = meter || scope ? h.ref.hole : h.ref.hole === '+' ? '+' : '−';
    const name = meter ? 'Multimeter' : scope ? 'Oscilloscope' : 'Bench supply';
    return [name, `${label} terminal`, ...(v !== null ? [describeVolts(v)] : [])];
  }
  const fields = [describeHole(h.hole)];
  if (store.doc.boards.length > 1) fields.unshift(`Board ${sync.boardNumber(h.board.id)}`);
  fields.push(`${sync.connectivity.members(h.ref).length} connected`);
  const occ = sync.occupancy.get(holeKey(h.ref));
  if (occ) {
    const part = occ.kind === 'part' ? store.doc.parts.find((p) => p.id === occ.id) : undefined;
    fields.push(occ.kind === 'part' ? (part ? describePin(part, occ.pin) : '') : 'Wire end');
  }
  if (live) {
    const v = sim.result.volts(h.ref);
    if (v !== null) fields.push(describeVolts(v));
  }
  return fields;
}

/** A part, wire, board or instrument under the pointer (or one of an instrument's knobs or buttons). */
export function describeItem(d: Describing, item: ItemRef): string[] {
  const { store, sync, sim } = d;
  const doc = store.doc;
  switch (item.kind) {
    case 'wire': {
      const w = doc.wires.find((x) => x.id === item.id);
      return w ? [`${w.color[0].toUpperCase()}${w.color.slice(1)} wire`, `${w.a.hole} → ${w.b.hole}`] : [];
    }
    case 'board': {
      const type = doc.boards.find((b) => b.id === item.id)?.type ?? 'bb830';
      const name = isRailStrip(type) ? 'Power rail' : 'Breadboard';
      return [doc.boards.length > 1 ? `${name} ${sync.boardNumber(item.id)}` : name];
    }
    case 'supply': {
      const s = sync.supply(item.id);
      if (!s) return [];
      if (item.knob === 'volts') return ['Voltage', `${s.volts.toFixed(2)} V`];
      if (item.knob === 'limit') return ['Current limit', `${s.limit.toFixed(2)} A`];
      return ['Bench supply', `${s.volts.toFixed(2)} V`, `${s.limit.toFixed(2)} A limit`];
    }
    case 'meter': {
      const m = sync.meter(item.id);
      if (!m) return [];
      if (item.button) return [BUTTON_NAMES[item.button]];
      return [item.dial ? 'Dial' : 'Multimeter', MODE_NAMES[m.mode]];
    }
    case 'scope':
      return describeScope(d, item);
    case 'part': {
      const p = doc.parts.find((x) => x.id === item.id);
      return p ? describePart(sim, p) : [];
    }
  }
}

function describeScope(d: Describing, item: ItemRef): string[] {
  const s = d.sync.scope(item.id);
  if (!s) return [];
  const v2 = s.voltsPerDiv2 ?? s.voltsPerDiv;
  switch (item.control) {
    case 'time':
      return ['Time per division', formatTime(s.timebase / 10)];
    case 'volts1':
      return ['CH1 volts per division', formatVolts(s.voltsPerDiv)];
    case 'volts2':
      return ['CH2 volts per division', formatVolts(v2)];
    case 'level':
      return [
        'Trigger level',
        formatVolts(d.scopeLevel(item.id)),
        s.trigger?.level === undefined ? 'Middle of the signal' : 'Set by hand',
      ];
    case 'run':
      return ['Run / stop', d.sync.scopes.runState(item.id) === 'stop' ? 'Stopped' : 'Running'];
    case 'single':
      return ['Single', 'Catch one trigger, then stop'];
    case 'auto':
      return ['Auto', 'Set up for what’s on the inputs'];
  }
  return [
    'Oscilloscope',
    `${formatTime(s.timebase / 10)}/div`,
    `CH1 ${formatVolts(s.voltsPerDiv)}/div`,
    `CH2 ${formatVolts(v2)}/div`,
  ];
}

function describePart(sim: Simulation, p: PartDoc): string[] {
  const def = PARTS[p.def];
  if (!def) return [];
  const live = sim.result.live;
  switch (def.kind) {
    case 'dip':
      return [def.id, def.subtitle];
    case 'led': {
      const reading = sim.result.leds.get(p.id);
      return [
        `${def.title} LED`,
        `+ ${p.pins[0].hole}`,
        `− ${p.pins[1].hole}`,
        ...(live && reading ? [mA(reading.current)] : []),
      ];
    }
    case 'resistor':
      return [`${formatOhms(p.value ?? 470)} resistor`, `${p.pins[0].hole} → ${p.pins[1].hole}`];
    case 'capacitor': {
      const v = live ? sim.result.capacitors.get(p.id) : undefined;
      return [
        `${formatFarads(p.value ?? 1e-6)} ${def.style} capacitor`,
        ...(v !== undefined ? [`${v.toFixed(2)} V`] : []),
      ];
    }
    case 'diode':
      return [def.title, def.subtitle, `Cathode ${p.pins[1].hole}`];
    case 'pot':
      return [`${formatOhms(p.value ?? 1e6)} potentiometer`, `${Math.round((p.state ?? 500) / 10)}%`];
    case 'slide':
      return ['Slide switch', `Common to pin ${(p.state ?? 0) & 1 ? 3 : 1}`];
    case 'transistor': {
      const reading = live ? sim.result.transistors.get(p.id) : undefined;
      return [
        def.title,
        def.subtitle,
        'E B C',
        ...(reading ? [`Ic ${mA(reading.collector)}`, `Ib ${mA(reading.base, 2)}`] : []),
      ];
    }
    case 'display':
      return ['7-segment display', def.subtitle];
    case 'power':
      return ['Power module', powerText(p.state)];
    case 'button':
      return ['Push button', ...(live && sim.isHeld(p.id) ? ['Held'] : [])];
    case 'dipswitch':
      return ['DIP switch', `${def.positions} positions`];
    case 'nano':
      return ['Arduino Nano', sketchOf(p).title];
    case 'bargraph':
      return ['LED bar graph', `${def.segments} segments`];
    case 'network':
      return [`${formatOhms(p.value ?? 1000)} resistor network`, 'Pin 1 common'];
    case 'lcd':
      return ['LCD', `${def.cols} × ${def.rows} characters`];
  }
}

/** Parts whose legs have a + and a − (diodes: anode and cathode). */
export const polarised = (def: PartDef): boolean =>
  def.kind === 'led' || def.kind === 'diode' || (def.kind === 'capacitor' && def.style === 'electrolytic');

/** Short names for each pin, where a part has them. */
function pinNamesOf(def: PartDef): readonly string[] | null {
  if (def.kind === 'dip' || def.kind === 'nano' || def.kind === 'lcd') return def.pinNames;
  if (def.kind === 'transistor') return ['E', 'B', 'C'];
  if (def.kind === 'display') {
    return Array.from({ length: 10 }, (_, i) => {
      const s = SEGMENT_PINS.indexOf(i + 1);
      return s >= 0 ? SEGMENT_NAMES[s] : 'COM';
    });
  }
  return null;
}

/** + and − beside a polarised part's two legs, just outside them. */
export function polarityTags(def: PartDef, legs: readonly THREE.Vector3[]): ScreenTag[] {
  if (!polarised(def) || legs.length !== 2) return [];
  const [a, b] = legs;
  const out = a.clone().sub(b).setY(0);
  if (out.lengthSq() < 1e-6) out.set(-1, 0, 0);
  out.normalize().multiplyScalar(1.9);
  return [
    {
      world: a
        .clone()
        .add(out)
        .setY(H + 0.4),
      text: '+',
      kind: 'plus',
    },
    {
      world: b
        .clone()
        .sub(out)
        .setY(H + 0.4),
      text: '−',
      kind: 'minus',
    },
  ];
}

/** A tag on every pin of a chip (or Nano, display, transistor, LCD), running out away from its body. */
export function pinTags(def: PartDef, at: readonly THREE.Vector3[]): ScreenTag[] {
  const names = pinNamesOf(def);
  if (!names) return [];
  const centre = at.reduce((c, w) => c.add(w), new THREE.Vector3()).divideScalar(at.length);
  // Two rows of pins (DIPs, the Nano, displays): out from the middle, across the rows. One row
  // (transistors): out to the near side of the desk.
  const along = at[at.length > 3 ? Math.floor(at.length / 2) - 1 : at.length - 1]
    .clone()
    .sub(at[0])
    .setY(0)
    .normalize();
  const across = new THREE.Vector3(-along.z, 0, along.x);
  return at.map((w, i) => {
    const out = across.clone();
    // An LCD's one row of pins: away from the screen, which reaches out over the other side.
    if (def.kind === 'lcd') out.negate();
    else if (at.length > 3) out.multiplyScalar(Math.sign(w.clone().sub(centre).dot(across)) || 1);
    else if (out.z < 0) out.negate();
    out.multiplyScalar(1.5);
    return {
      world: w
        .clone()
        .add(out)
        .setY(H + 0.2),
      text: names[i] ?? `${i + 1}`,
      kind: 'pin' as const,
      out,
    };
  });
}
