// Reading a saved circuit: from this browser's autosave, a file, and later a shared link. Older
// versions are brought up to date; anything that doesn't make sense (a part this app doesn't know,
// a wire into a hole that isn't there) is left out with a note, rather than breaking the workbench.

import { boardSpec, isBoardType, type BoardType } from './breadboard';
import {
  WIRE_COLORS,
  type BoardDoc,
  type CircuitDoc,
  type DeskPoint,
  type HoleRef,
  type MeterDoc,
  type PartDoc,
  type ProbeDoc,
  type ScopeDoc,
  type SupplyDoc,
  type WireDoc,
} from './circuit';
import { PARTS, pinCount } from './parts';
import { SUPPLY_HOLES, SUPPLY_MAX_AMPS, SUPPLY_MAX_VOLTS, SUPPLY_MIN_AMPS } from './supply';
import { isMeterMode, METER_HOLES } from './meter';
import {
  isScopeTimebase,
  isScopeVoltsPerDiv,
  nearestStep,
  SCOPE_HOLES,
  SCOPE_TIMEBASES,
  SCOPE_VOLTS_PER_DIV,
  type ScopeTrigger,
} from './scope';

/** The version this app writes. */
export const DOC_VERSION = 1;

/**
 * Upgrades, by the version they upgrade from: each turns a document of that version into one of the
 * next, in place. A change to the format adds one here and bumps DOC_VERSION.
 */
const UPGRADES: Record<number, (doc: Record<string, unknown>) => void> = {};

export type ReadResult = { doc: CircuitDoc; notes: string[] } | { error: string };

const EDGES = ['rise', 'fall', 'any'] as const;

type Loose = Record<string, unknown>;
const isObject = (x: unknown): x is Loose => typeof x === 'object' && x !== null && !Array.isArray(x);
const isNumber = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const isId = (x: unknown): x is string => typeof x === 'string' && x.length > 0 && x.length <= 64;
const list = (x: unknown): unknown[] => (Array.isArray(x) ? x : []);
const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

/**
 * The most of each thing a circuit can hold, far past anything built by hand (Ben's whole 8-bit
 * computer is 14 boards, ~300 parts and ~730 wires), so a broken or hostile file can't swamp the app.
 */
const MAX = { boards: 1000, parts: 10000, wires: 20000, probes: 100, instruments: 100, bends: 200 } as const;
/** A desk position, in mm from the middle: anything beyond 100 m is nonsense. */
const isPlace = (x: unknown): x is number => isNumber(x) && Math.abs(x) <= 100_000;
/** Base64 for at most 64 KB (the biggest EEPROM and the Nano's flash are 32 KB). */
const isImage = (x: unknown): x is string => typeof x === 'string' && x.length <= 90_000;
/** Ohms and farads a part can have; outside these the solver would divide by nothing or overflow. */
const OHMS: readonly [number, number] = [0.001, 1e12];
const FARADS: readonly [number, number] = [1e-15, 100];
const plural = (n: number, what: string): string => `${n} ${what}${n === 1 ? '' : 's'}`;

/** A saved scope's settings, each put back on one of its knob's steps; anything unreadable is left at its default. */
function readScope(s: Loose, id: string, x: number, z: number): ScopeDoc {
  const out: ScopeDoc = {
    id,
    x,
    z,
    timebase: isScopeTimebase(s.timebase) ? nearestStep(SCOPE_TIMEBASES, s.timebase) : 0.1,
    voltsPerDiv: isScopeVoltsPerDiv(s.voltsPerDiv) ? nearestStep(SCOPE_VOLTS_PER_DIV, s.voltsPerDiv) : 2,
  };
  if (isScopeVoltsPerDiv(s.voltsPerDiv2)) out.voltsPerDiv2 = nearestStep(SCOPE_VOLTS_PER_DIV, s.voltsPerDiv2);
  for (const k of ['offset1', 'offset2'] as const)
    if (isNumber(s[k]) && s[k] !== 0) out[k] = Math.max(-4, Math.min(4, s[k]));
  for (const k of ['off1', 'off2', 'ac1', 'ac2'] as const) if (s[k] === true) out[k] = true;
  const t = s.trigger;
  if (isObject(t)) {
    const trigger: ScopeTrigger = {
      source: t.source === 'CH2' ? 'CH2' : 'CH1',
      edge: t.edge === 'fall' ? 'fall' : 'rise',
      mode: t.mode === 'normal' || t.mode === 'single' ? t.mode : 'auto',
    };
    if (isNumber(t.level)) trigger.level = clamp(t.level, -100, 100);
    out.trigger = trigger;
  }
  return out;
}

/** Reads a document from parsed JSON: upgraded, checked and tidied, or why it can't be used. */
export function readDoc(raw: unknown): ReadResult {
  if (!isObject(raw) || !isNumber(raw.version) || !Array.isArray(raw.boards))
    return { error: 'That isn’t a saved circuit' };
  if (raw.version > DOC_VERSION) return { error: 'Saved by a newer version. Reload the page to update' };
  const doc = structuredClone(raw);
  for (let v = doc.version as number; v < DOC_VERSION; v++) {
    const upgrade = UPGRADES[v];
    if (!upgrade) return { error: `Circuits saved by version ${v} can’t be opened any more` };
    upgrade(doc);
    doc.version = v + 1;
  }

  const dropped = { parts: 0, wires: 0, other: 0 };
  const ids = new Set<string>();
  /** The first `max` items of a list; any past that are counted under `what` and left out. */
  const upTo = (x: unknown, max: number, what: keyof typeof dropped): unknown[] => {
    const all = list(x);
    dropped[what] += Math.max(0, all.length - max);
    return all.slice(0, max);
  };
  const fresh = (id: unknown): id is string => isId(id) && !ids.has(id) && !!ids.add(id);

  const boards: BoardDoc[] = [];
  for (const b of upTo(doc.boards, MAX.boards, 'other')) {
    // The old separate no-rails board is now a BB830's body: same holes, same places.
    if (isObject(b) && b.type === 'bb830-bare') b.type = 'core-bb830';
    // So is the old power rail on its own, full length or half: a BB830's or BB400's rail, hole 1 where it was.
    if (isObject(b) && (b.type === 'rail' || b.type === 'rail-25') && isNumber(b.x) && isNumber(b.z)) {
      const to = b.type === 'rail' ? 'strip-bb830-top' : 'strip-bb400-top';
      const was = boardSpec(b.type).hole('T+1')!;
      const now = boardSpec(to).hole('T+1')!;
      b.x = b.x + was.x - now.x;
      b.z = b.z + was.z - now.z;
      b.type = to;
    }
    if (isObject(b) && fresh(b.id) && typeof b.type === 'string' && isBoardType(b.type) && isPlace(b.x) && isPlace(b.z))
      boards.push({ id: b.id, type: b.type as BoardType, x: b.x, z: b.z, ...(isId(b.on) ? { on: b.on } : {}) });
    else dropped.other++;
  }
  // A rail clipped to a board that isn't there is just a rail.
  for (const b of boards) if (b.on && !boards.some((o) => o.id === b.on && o.id !== b.id)) delete b.on;
  const supplies: SupplyDoc[] = [];
  for (const s of upTo(doc.supplies, MAX.instruments, 'other')) {
    if (isObject(s) && fresh(s.id) && isPlace(s.x) && isPlace(s.z)) {
      supplies.push({
        id: s.id,
        x: s.x,
        z: s.z,
        volts: clamp(isNumber(s.volts) ? s.volts : 5, 0, SUPPLY_MAX_VOLTS),
        limit: clamp(isNumber(s.limit) ? s.limit : 1, SUPPLY_MIN_AMPS, SUPPLY_MAX_AMPS),
        ...(s.off === true ? { off: true } : {}),
      });
    } else dropped.other++;
  }
  const meters: MeterDoc[] = [];
  for (const m of upTo(doc.meters, MAX.instruments, 'other')) {
    if (isObject(m) && fresh(m.id) && isPlace(m.x) && isPlace(m.z)) {
      meters.push({ id: m.id, x: m.x, z: m.z, mode: isMeterMode(m.mode) ? m.mode : 'dcv' });
    } else dropped.other++;
  }
  const scopes: ScopeDoc[] = [];
  for (const s of upTo(doc.scopes, MAX.instruments, 'other')) {
    if (isObject(s) && fresh(s.id) && isPlace(s.x) && isPlace(s.z)) {
      scopes.push(readScope(s, s.id, s.x, s.z));
    } else dropped.other++;
  }

  // A hole is real if its board (or bench supply) is here and has a hole by that name.
  const boardTypes = new Map(boards.map((b) => [b.id, b.type]));
  const supplyIds = new Set(supplies.map((s) => s.id));
  const meterIds = new Set(meters.map((m) => m.id));
  const scopeIds = new Set(scopes.map((s) => s.id));
  const hole = (r: unknown): HoleRef | null => {
    if (!isObject(r) || typeof r.board !== 'string' || typeof r.hole !== 'string') return null;
    const type = boardTypes.get(r.board);
    const real = type
      ? !!boardSpec(type).hole(r.hole)
      : supplyIds.has(r.board)
        ? !!SUPPLY_HOLES.hole(r.hole)
        : meterIds.has(r.board)
          ? !!METER_HOLES.hole(r.hole)
          : scopeIds.has(r.board) && !!SCOPE_HOLES.hole(r.hole);
    return real ? { board: r.board, hole: r.hole } : null;
  };
  const holes = (refs: unknown): HoleRef[] | null => {
    const out = list(refs).map(hole);
    return out.every((r): r is HoleRef => r !== null) ? out : null;
  };

  const parts: PartDoc[] = [];
  for (const p of upTo(doc.parts, MAX.parts, 'parts')) {
    const def = isObject(p) && typeof p.def === 'string' ? PARTS[p.def] : undefined;
    const pins = isObject(p) ? holes(p.pins) : null;
    if (!isObject(p) || !def || !pins || pins.length !== pinCount(def) || !fresh(p.id)) {
      dropped.parts++;
      continue;
    }
    const part: PartDoc = { id: p.id, def: def.id, pins };
    if (isNumber(p.value)) {
      // A resistance or capacitance of nothing (or less) would break the solver: such a part gets its default.
      const range =
        def.kind === 'resistor' || def.kind === 'pot' || def.kind === 'network'
          ? OHMS
          : def.kind === 'capacitor'
            ? FARADS
            : null;
      if (!range) part.value = p.value;
      else if (p.value > 0) part.value = clamp(p.value, range[0], range[1]);
    }
    if (isNumber(p.state)) part.state = p.state;
    if (isImage(p.data)) part.data = p.data;
    if (isImage(p.initialMemory)) part.initialMemory = p.initialMemory;
    if (isImage(p.firmware)) part.firmware = p.firmware;
    if (typeof p.firmwareName === 'string') part.firmwareName = p.firmwareName.slice(0, 200);
    if (typeof p.source === 'string') part.source = p.source.slice(0, 100000);
    parts.push(part);
  }

  const wires: WireDoc[] = [];
  for (const w of upTo(doc.wires, MAX.wires, 'wires')) {
    const ends = isObject(w) ? [hole(w.a), hole(w.b)] : [];
    if (!isObject(w) || !ends[0] || !ends[1] || !fresh(w.id)) {
      dropped.wires++;
      continue;
    }
    const wire: WireDoc = {
      id: w.id,
      a: ends[0],
      b: ends[1],
      color: WIRE_COLORS.includes(w.color as WireDoc['color']) ? (w.color as WireDoc['color']) : 'red',
    };
    const points = list(w.points)
      .slice(0, MAX.bends)
      .filter((p): p is DeskPoint => isObject(p) && isPlace(p.x) && isPlace(p.z));
    if (points.length) wire.points = points.map((p) => ({ x: p.x, z: p.z }));
    wires.push(wire);
  }

  const probes: ProbeDoc[] = [];
  for (const p of upTo(doc.probes, MAX.probes, 'other')) {
    const at = isObject(p) ? hole(p.at) : null;
    if (!isObject(p) || !at || !fresh(p.id)) {
      dropped.other++;
      continue;
    }
    const probe: ProbeDoc = { id: p.id, at };
    if (EDGES.includes(p.break as ProbeDoc['break'] & string)) probe.break = p.break as ProbeDoc['break'];
    probes.push(probe);
  }

  // New ids carry on past every id in use, whatever the saved counter says.
  let next = isNumber(doc.nextId) ? Math.floor(doc.nextId) : 1;
  for (const id of ids) {
    const n = Number(/\d+$/.exec(id)?.[0]);
    if (n >= next) next = n + 1;
  }

  const out: CircuitDoc = { version: DOC_VERSION, boards, wires, parts, nextId: Math.max(1, next) };
  if (typeof doc.name === 'string') out.name = doc.name.slice(0, 200);
  if (probes.length) out.probes = probes;
  if (supplies.length) out.supplies = supplies;
  if (meters.length) out.meters = meters;
  if (scopes.length) out.scopes = scopes;

  const notes: string[] = [];
  if (dropped.parts) notes.push(`Skipped ${plural(dropped.parts, 'unknown or misplaced part')}`);
  if (dropped.wires) notes.push(`Skipped ${plural(dropped.wires, 'wire')} to missing holes`);
  if (dropped.other) notes.push(`Skipped ${plural(dropped.other, 'invalid item')}`);
  return { doc: out, notes };
}
