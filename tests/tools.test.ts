import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { Store } from '../src/app/store';
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
import { Tools } from '../src/app/tools/tools';
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

  it('keeps instruments off a power module hanging off the end of a board', () => {
    const doc = createDoc();
    const spec = boardSpec('bb830');
    const pins = ['T+1', 'T-1', 'B+1', 'B-1'].map((hole) => ({ board: 'b1', hole }));
    doc.parts.push({ id: 'p1', def: 'power', pins });
    const left = Math.min(...pins.map((p) => spec.hole(p.hole)!.x));
    // The module reaches past the board's left end, so a meter just clear of the board alone overlaps it.
    const meter = footprint('meter');
    const want = { x: -spec.length / 2 - DESK_GAP - meter.x / 2, z: 0 };
    expect(left - 24).toBeLessThan(-spec.length / 2);
    const at = clearDeskSpot(doc, 'meter', want.x, want.z, { snapping: false });
    expect(at.valid).toBe(true);
    const clearOfModule = at.x + meter.x / 2 <= left - 24 - DESK_GAP + 0.1 || Math.abs(at.z) >= meter.z / 2 + 26;
    expect(clearOfModule).toBe(true);
    // Dragged with its board, the module counts as part of the board's outline.
    const span = railSpan(doc, 'b1')!;
    expect(span.x).toBeGreaterThan(spec.length);
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

function createToolsFixture(doc: CircuitDoc = createDoc()) {
  const mockElement = () => ({
    addEventListener: () => {},
    removeEventListener: () => {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600 }),
    append: () => {},
    classList: { add: () => {}, remove: () => {} },
    style: {},
    hidden: false,
    className: '',
  });

  if (typeof globalThis.document === 'undefined') {
    (globalThis as any).document = {
      body: mockElement(),
      createElement: () => mockElement(),
    };
  }
  if (typeof globalThis.window === 'undefined') {
    (globalThis as any).window = {
      addEventListener: () => {},
      removeEventListener: () => {},
    };
  }

  const camera = new THREE.PerspectiveCamera(50, 800 / 600, 0.1, 2000);
  camera.position.set(0, 500, 0);
  camera.up.set(0, 0, -1);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  camera.updateProjectionMatrix();

  const store = new Store(doc);

  // A controllable surface point: tests set this to steer moveBoardGroup / surfacePoint().
  let surfacePt = new THREE.Vector3(0, 0, 0);
  const setSurface = (v: THREE.Vector3) => {
    surfacePt = v;
  };

  // Proxy: any property access returns a no-op function or empty value by default;
  // specific overrides are defined below so the tests can actually assert on board geometry.
  const syncBase = {
    layoutVersion: 1,
    occupancy: new Map<string, unknown>(),
    covered: new Set<string>(),
    wires: new Proxy({ restyle: () => {} }, { get: (t, k) => (k in t ? t[k as keyof typeof t] : () => []) }),
    connectivity: { members: () => [] as any[] },
    // Returns the live surfacePt so tests can steer moveBoardGroup.
    surfacePoint: () => surfacePt.clone(),
    boardBounds: (id: string) => {
      const b = store.doc.boards.find((x) => x.id === id);
      if (!b) return null;
      const spec = boardSpec(b.type);
      return new THREE.Box3(
        new THREE.Vector3(b.x - spec.length / 2, 0, b.z - spec.width / 2),
        new THREE.Vector3(b.x + spec.length / 2, 10, b.z + spec.width / 2),
      );
    },
    partOutline: () => new THREE.Box3(new THREE.Vector3(-10, 0, -10), new THREE.Vector3(10, 10, 10)),
  };
  const sync: any = new Proxy(syncBase, {
    get(target, key) {
      if (key in target) return target[key as keyof typeof target];
      return () => null;
    },
  });

  const view: any = {
    overlay: new THREE.Group(),
    world: new THREE.Group(),
    camera,
    onCameraChange: () => {},
    invalidate: () => {},
    rayFrom: () => new THREE.Ray(),
    stopGliding: () => {},
    touchMove: () => {},
    setLoupe: () => {},
    setWheelZooms: () => {},
    fit: () => {},
    panBy: () => {},
    setLeftButtonPans: () => {},
    toggleTopView: () => {},
    frameFace: () => {},
  };
  const sim: any = {
    onChange: () => {},
    toggleSwitch: () => {},
    setPowerJumper: () => {},
  };
  const canvas: any = mockElement();

  const tools = new Tools(view, store, sync, sim, canvas);
  return { tools, store, sync, view, setSurface };
}

describe('board group selection and movement', () => {
  it('shift-click-selects multiple boards into a group and toggles them', () => {
    const doc = createDoc();
    // doc starts with b1 at 0, 0. Add a second board b2 at 0, 80.
    doc.boards.push({ id: 'b2', type: 'bb830', x: 0, z: 80 });
    const { tools } = createToolsFixture(doc);

    // Initial click selects b1
    (tools as any).hoverItem = { kind: 'board', id: 'b1' };
    (tools as any).clickSelect(false);
    expect(tools.selection).toEqual({ kind: 'board', id: 'b1' });
    expect(tools.selectionCount).toBe(1);

    // Shift-click on b2 adds it to the group
    (tools as any).hoverItem = { kind: 'board', id: 'b2' };
    (tools as any).clickSelect(true);
    expect((tools as any).group).toEqual([
      { kind: 'board', id: 'b1' },
      { kind: 'board', id: 'b2' },
    ]);
    expect(tools.selectionCount).toBe(2);

    // Shift-clicking b1 removes it from the group, leaving b2 as a single selection
    (tools as any).hoverItem = { kind: 'board', id: 'b1' };
    (tools as any).clickSelect(true);
    expect(tools.selection).toEqual({ kind: 'board', id: 'b2' });
    expect(tools.selectionCount).toBe(1);
  });

  it('box-selects 2+ boards inside the selection rectangle', () => {
    const doc = createDoc();
    doc.boards.push({ id: 'b2', type: 'bb830', x: 0, z: 60 });
    const { tools } = createToolsFixture(doc);

    // Drag a box covering the full viewport which contains both boards
    (tools as any).finishBox({ kind: 'box', x: 0, y: 0, add: false }, { clientX: 800, clientY: 600 } as PointerEvent);
    const selectedIds = (tools as any).group.map((item: any) => item.id);
    expect(selectedIds).toContain('b1');
    expect(selectedIds).toContain('b2');
  });

  it('drags a board-only group together and refuses to merge or overlap onto obstacles', () => {
    const doc = createDoc();
    // b1 at 0, 0 and b2 at 0, 70. Obstacle board b3 at 0, 170.
    doc.boards = [
      { id: 'b1', type: 'bb400', x: 0, z: 0 },
      { id: 'b2', type: 'bb400', x: 0, z: 70 },
      { id: 'b3', type: 'bb400', x: 0, z: 170 },
    ];
    const { tools, store, setSurface } = createToolsFixture(doc);
    (tools as any).setGroup([
      { kind: 'board', id: 'b1' },
      { kind: 'board', id: 'b2' },
    ]);

    // Start drag on b1 from origin; surfacePoint starts at (0,0,0)
    (tools as any).startDrag({ item: { kind: 'board', id: 'b1' } }, new THREE.Vector3(0, 0, 0));
    expect((tools as any).gesture?.kind).toBe('board-group');

    // Drag group to a valid position: pointer moves to z=-40, so group shifts -40 in z
    (tools as any).pointerInside = true;
    setSurface(new THREE.Vector3(0, 0, -40));
    (tools as any).moveBoardGroup((tools as any).gesture);

    expect(store.doc.boards.find((b) => b.id === 'b1')!.z).toBeCloseTo(-40);
    expect(store.doc.boards.find((b) => b.id === 'b2')!.z).toBeCloseTo(30); // 70 - 40

    // Now try to drag group by delta dz=+100: b1 lands at z=100 (clear), but b2 would land at z=170 (collides with b3)
    setSurface(new THREE.Vector3(0, 0, 100));
    (tools as any).moveBoardGroup((tools as any).gesture);

    // The move is refused because b2's destination is blocked by b3
    expect((tools as any).gesture.reason).toBe('Something is in the way');
    // Positions remain at the last valid spot (-40 and 30)
    expect(store.doc.boards.find((b) => b.id === 'b1')!.z).toBeCloseTo(-40);
    expect(store.doc.boards.find((b) => b.id === 'b2')!.z).toBeCloseTo(30);
  });

  it('confirms mixed board+part selection does not crash and falls back as intended', () => {
    const doc = createDoc();
    doc.parts.push({
      id: 'r1',
      def: 'resistor',
      pins: [
        { board: 'b1', hole: 'a1' },
        { board: 'b1', hole: 'a5' },
      ],
    });
    const { tools } = createToolsFixture(doc);

    // Mixed group with a board and a part
    (tools as any).setGroup([
      { kind: 'board', id: 'b1' },
      { kind: 'part', id: 'r1' },
    ]);

    // Dragging either member should gracefully return without crashing or starting invalid move
    expect(() => {
      (tools as any).startDrag({ item: { kind: 'board', id: 'b1' } }, new THREE.Vector3(0, 0, 0));
    }).not.toThrow();
    expect((tools as any).gesture).toBeNull();

    expect(() => {
      (tools as any).startDrag({ item: { kind: 'part', id: 'r1' } }, new THREE.Vector3(0, 0, 0));
    }).not.toThrow();
    expect((tools as any).gesture).toBeNull();
  });
});
