import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { describePin, describeVolts, polarityTags } from '../src/app/tools/describe';
import { clearDeskSpot, DESK_GAP, footprint, railSpan, supplySpotBeside } from '../src/app/tools/desk';
import {
  addDeskItem,
  addSupplyWithLeads,
  boardWouldMove,
  deleteItem,
  moveBoard,
  railHolesResize,
  setScopeSettings,
  setSupplySettings,
} from '../src/app/tools/edits';
import { boardSpec } from '../src/engine/breadboard';
import { createDoc, type CircuitDoc, type HoleRef, type ScopeDoc } from '../src/engine/circuit';
import { PARTS, type DipDef } from '../src/engine/parts';
import { detachRails } from '../src/engine/rails';

const h = (hole: string, board = 'b1'): HoleRef => ({ board, hole });

/** A board with a resistor and a wire on it, a probe, and a meter beside it. */
function bench(): CircuitDoc {
  const doc = createDoc();
  doc.parts.push({ id: 'r1', def: 'resistor', pins: [h('a10'), h('a14')], value: 1000 });
  doc.wires.push({ id: 'w1', a: h('c5'), b: h('h5'), color: 'red', points: [{ x: 1, z: 2 }] });
  doc.probes = [{ id: 'p1', at: h('a10') }];
  doc.meters = [{ id: 'm1', x: 0, z: 120, mode: 'dcv' }];
  doc.wires.push({ id: 'w2', a: { board: 'm1', hole: 'V' }, b: h('j20'), color: 'red' });
  return doc;
}

describe('document edits', () => {
  it('adds instruments with their defaults, and boards without selecting them', () => {
    const doc = createDoc();
    expect(addDeskItem(doc, 'board', { x: 200, z: 0 }, 'bb400')).toBeNull();
    expect(doc.boards.at(-1)).toMatchObject({ type: 'bb400', x: 200, z: 0 });
    const meter = addDeskItem(doc, 'meter', { x: 0, z: 100 });
    expect(meter?.kind).toBe('meter');
    expect(doc.meters?.[0]).toMatchObject({ id: meter?.id, mode: 'dcv' });
    const scope = addDeskItem(doc, 'scope', { x: 0, z: -100 });
    expect(doc.scopes?.[0]).toMatchObject({ id: scope?.id, timebase: 0.1, voltsPerDiv: 2 });
  });

  it('puts a bench supply down with red on + and black on −', () => {
    const doc = createDoc();
    const id = addSupplyWithLeads(doc, { x: -150, z: 0 }, h('a1'), h('a5'));
    expect(doc.supplies).toEqual([{ id, x: -150, z: 0, volts: 5, limit: 1 }]);
    expect(doc.wires.map((w) => [w.a.hole, w.b.hole, w.color])).toEqual([
      ['+', 'a1', 'red'],
      ['-', 'a5', 'black'],
    ]);
  });

  it('deletes a board with everything plugged into it, but not what is beside it', () => {
    const doc = bench();
    deleteItem(doc, { kind: 'board', id: 'b1' });
    expect(doc.boards).toEqual([]);
    expect(doc.parts).toEqual([]);
    expect(doc.wires).toEqual([]);
    expect(doc.probes).toEqual([]);
    expect(doc.meters).toHaveLength(1);
  });

  it('deletes an instrument with its leads', () => {
    const doc = bench();
    deleteItem(doc, { kind: 'meter', id: 'm1' });
    expect(doc.meters).toEqual([]);
    expect(doc.wires.map((w) => w.id)).toEqual(['w1']);
    expect(doc.parts).toHaveLength(1);
  });

  it('moves a board with its parts in their holes and its wires’ bends', () => {
    const doc = bench();
    expect(boardWouldMove(doc, 'b1', { x: 0, z: 0 })).toBe(false);
    expect(boardWouldMove(doc, 'b1', { x: 30, z: 0 })).toBe(true);
    expect(moveBoard(doc, 'b1', { x: 30, z: -10 })).toBe('b1');
    expect(doc.boards[0]).toMatchObject({ x: 30, z: -10 });
    expect(doc.parts[0].pins).toEqual([h('a10'), h('a14')]);
    // Both ends on the board: its bend comes along. One end on the meter: the meter stays put.
    expect(doc.wires[0].points).toEqual([{ x: 31, z: -8 }]);
    expect(doc.meters?.[0]).toMatchObject({ x: 0, z: 120 });
  });

  it('moves a board’s clipped rails with it', () => {
    const doc = createDoc();
    const rails = detachRails(doc, 'b1');
    if (!('top' in rails)) throw new Error(rails.reason);
    const before = doc.boards.map((b) => ({ ...b }));
    moveBoard(doc, 'b1', { x: 50, z: 0 });
    for (const b of doc.boards) expect(b.x).toBeCloseTo(before.find((o) => o.id === b.id)!.x + 50);
  });

  it('won’t shorten a rail onto holes in use', () => {
    const doc = createDoc();
    doc.boards = [{ id: 'r', type: 'rail', x: 0, z: 0 }];
    const last = boardSpec('rail').holes.at(-1)!.name;
    doc.wires.push({ id: 'w', a: h(last, 'r'), b: h(boardSpec('rail').holes[0].name, 'r'), color: 'red' });
    expect(railHolesResize(doc, 'r', 10)).toEqual({ error: 'Those holes are in use' });
    expect(railHolesResize(doc, 'r', 50)).toBeNull();
    const longer = railHolesResize(doc, 'r', 60);
    expect(longer && 'type' in longer && longer.type).toBe('rail-60');
  });

  it('keeps a bench supply to what it can do', () => {
    const s = { id: 's', x: 0, z: 0, volts: 5, limit: 1 };
    setSupplySettings(s, { volts: 45, limit: 0.01 });
    expect(s).toMatchObject({ volts: 30, limit: 0.1 });
    setSupplySettings(s, { volts: 3.14159 });
    expect(s.volts).toBe(3.14);
  });

  it('doesn’t save a scope’s defaults', () => {
    const s: ScopeDoc = { id: 'o', x: 0, z: 0, timebase: 0.1, voltsPerDiv: 2, offset1: 1, ac1: true };
    setScopeSettings(s, { offset1: 0, ac1: false, trigger: { level: 1.5 } });
    expect(s).not.toHaveProperty('offset1');
    expect(s).not.toHaveProperty('ac1');
    expect(s.trigger).toMatchObject({ level: 1.5, source: 'CH1' });
    setScopeSettings(s, { trigger: { level: undefined } });
    expect(s.trigger).not.toHaveProperty('level');
  });
});

describe('desk layout', () => {
  it('pushes a board dropped onto another out to touch it', () => {
    const doc = createDoc();
    const at = clearDeskSpot(doc, 'board', 10, 5, { type: 'bb830', snapping: true });
    const size = footprint('board', 'bb830');
    expect(at.valid).toBe(true);
    const clear = Math.abs(at.x) >= size.x - 0.01 || Math.abs(at.z) >= size.z - 0.01;
    expect(clear).toBe(true);
  });

  it('keeps instruments a gap away from boards', () => {
    const doc = createDoc();
    const at = clearDeskSpot(doc, 'meter', 0, 0, { snapping: false });
    const board = footprint('board');
    const meter = footprint('meter');
    const gapZ = Math.abs(at.z) - (board.z + meter.z) / 2;
    const gapX = Math.abs(at.x) - (board.x + meter.x) / 2;
    expect(Math.max(gapX, gapZ)).toBeGreaterThanOrEqual(DESK_GAP - 0.1);
  });

  it('puts a supply going in by its leads beside the nearest side of the board', () => {
    const doc = createDoc();
    const spec = boardSpec('bb830');
    const left = spec.hole('a2')!;
    const spot = supplySpotBeside(doc, 'b1', { x: left.x, z: left.z }, false)!;
    expect(spot.valid).toBe(true);
    expect(spot.x).toBeLessThan(-spec.length / 2);
  });

  it('knows the outline of a board with its rails apart', () => {
    const doc = createDoc();
    expect(railSpan(doc, 'b1')).toBeUndefined();
    detachRails(doc, 'b1');
    const span = railSpan(doc, 'b1')!;
    expect(span.x).toBeCloseTo(boardSpec('bb830').length);
    expect(span.z).toBeCloseTo(boardSpec('bb830').width, 0);
  });
});

describe('status bar words', () => {
  it('reads voltages as TTL levels', () => {
    expect(describeVolts(4.8)).toBe('4.80 V high');
    expect(describeVolts(0.2)).toBe('0.20 V low');
    expect(describeVolts(1.4)).toBe('1.40 V invalid');
    expect(describeVolts(NaN)).toBe('Floating');
  });

  it('names a part’s legs', () => {
    expect(describePin({ id: 'l', def: 'led-red', pins: [] }, 0)).toBe('Red LED anode (+)');
    expect(describePin({ id: 'c', def: '74LS00', pins: [] }, 13)).toBe(
      `74LS00 pin 14 (${(PARTS['74LS00'] as DipDef).pinNames[13]})`,
    );
    expect(describePin({ id: 'p', def: 'power', pins: [], state: 1 }, 1)).toBe('Power module ground');
  });

  it('puts + by an LED’s first leg and − by its second', () => {
    const legs = [new THREE.Vector3(0, 0, 0), new THREE.Vector3(2.54, 0, 0)];
    const [plus, minus] = polarityTags(PARTS['led-red'], legs);
    expect(plus.text).toBe('+');
    expect(plus.world.x).toBeLessThan(0);
    expect(minus.world.x).toBeGreaterThan(2.54);
    expect(polarityTags(PARTS.resistor, legs)).toEqual([]);
  });
});
