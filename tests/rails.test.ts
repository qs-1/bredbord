import { describe, expect, it } from 'vitest';
import { boardSpec, pieceOffset, RAILED, type BoardType } from '../src/engine/breadboard';
import { emptyDoc, type CircuitDoc, type HoleRef } from '../src/engine/circuit';
import { readDoc } from '../src/engine/document';
import { Connectivity } from '../src/engine/netlist';
import { clipTarget, detachRails, rejoinRails, unitOf } from '../src/engine/rails';

function boardWithParts(type: BoardType = 'bb830'): CircuitDoc {
  const doc = emptyDoc();
  doc.boards = [{ id: 'b1', type, x: 10, z: 5 }];
  doc.parts = [
    {
      id: 'p1',
      def: 'resistor',
      pins: [
        { board: 'b1', hole: 'T+5' },
        { board: 'b1', hole: 'a5' },
      ],
      value: 1000,
    },
  ];
  doc.wires = [
    { id: 'w1', a: { board: 'b1', hole: 'B-10' }, b: { board: 'b1', hole: 'j10' }, color: 'black' },
    { id: 'w2', a: { board: 'b1', hole: 'T-3' }, b: { board: 'b1', hole: 'B+3' }, color: 'red' },
  ];
  doc.nextId = 10;
  return doc;
}

/** Where a hole is on the desk. */
function world(doc: CircuitDoc, r: HoleRef): [number, number] {
  const b = doc.boards.find((x) => x.id === r.board)!;
  const h = boardSpec(b.type).hole(r.hole)!;
  return [b.x + h.x, b.z + h.z];
}

describe('detachable rails', () => {
  for (const type of RAILED) {
    it(`pulls a ${type} apart without moving a single hole`, () => {
      const doc = boardWithParts(type);
      const r = detachRails(doc, 'b1');
      if (!('top' in r)) throw new Error(r.reason);
      expect(doc.boards.map((b) => b.type)).toEqual([`core-${type}`, `strip-${type}-top`, `strip-${type}-bottom`]);
      // Every hole of the whole board is in one of the three pieces, at the same spot, same name.
      for (const h of boardSpec(type).holes) {
        const board = h.kind === 'terminal' ? 'b1' : h.name[0] === 'T' ? r.top : r.bottom;
        const [x, z] = world(doc, { board, hole: h.name });
        expect(x).toBeCloseTo(10 + h.x, 6);
        expect(z).toBeCloseTo(5 + h.z, 1);
      }
      expect(doc.parts[0].pins[0]).toEqual({ board: r.top, hole: 'T+5' });
      expect(doc.wires[0].a).toEqual({ board: r.bottom, hole: 'B-10' });
      expect(doc.wires[1].b).toEqual({ board: r.bottom, hole: 'B+3' });
    });
  }

  it('keeps every connection the same', () => {
    for (const type of RAILED) {
      const before = boardWithParts(type);
      const doc = structuredClone(before);
      const r = detachRails(doc, 'b1');
      if (!('top' in r)) throw new Error(r.reason);
      const was = new Connectivity(before);
      const now = new Connectivity(doc);
      const on = (hole: string): HoleRef => ({
        board: /^T[+-]/.test(hole) ? r.top : /^B[+-]/.test(hole) ? r.bottom : 'b1',
        hole,
      });
      const pairs: [string, string][] = [
        ['j10', 'B-20'],
        ['T-3', 'T-20'],
        ['T-20', 'B+20'],
        ['T+5', 'T+24'],
        ['T+5', 'B+5'],
        ['a1', 'e1'],
        ['e1', 'f1'],
      ];
      for (const [a, b] of pairs) {
        expect(now.connected(on(a), on(b)), `${type} ${a}–${b}`).toBe(
          was.connected({ board: 'b1', hole: a }, { board: 'b1', hole: b }),
        );
      }
    }
  });

  it('is whole again with both rails back where they came from', () => {
    const doc = boardWithParts();
    const r = detachRails(doc, 'b1');
    if (!('top' in r)) throw new Error(r.reason);
    expect(rejoinRails(doc, 'b1')).toBe(true);
    expect(doc.boards).toEqual([{ id: 'b1', type: 'bb830', x: 10, z: 5 }]);
    expect(doc.parts[0].pins[0]).toEqual({ board: 'b1', hole: 'T+5' });
    expect(doc.wires[0].a).toEqual({ board: 'b1', hole: 'B-10' });
  });

  it('stays in pieces while a rail is away', () => {
    const doc = boardWithParts();
    const r = detachRails(doc, 'b1');
    if (!('top' in r)) throw new Error(r.reason);
    const top = doc.boards.find((b) => b.id === r.top)!;
    top.z -= 40;
    delete top.on;
    expect(rejoinRails(doc, 'b1')).toBe(false);
    expect(unitOf(doc, r.bottom)).toBe('b1');
    expect(unitOf(doc, r.top)).toBe(r.top);
  });

  it('keeps the rails on while a power module is plugged into them', () => {
    const doc = boardWithParts();
    doc.parts.push({
      id: 'p2',
      def: 'power',
      pins: ['T+1', 'T-1', 'B+1', 'B-1'].map((hole) => ({ board: 'b1', hole })),
    });
    expect('reason' in detachRails(doc, 'b1')).toBe(true);
    expect(doc.boards).toHaveLength(1);
  });

  it('clips a rail pushed flush against a board, and not one left apart from it', () => {
    const boards = [
      { id: 'b1', type: 'core-bb830' as const, x: 0, z: 0 },
      { id: 'r1', type: 'strip-bb830-top' as const, x: 10, z: pieceOffset('bb830', 'top') },
      { id: 'r2', type: 'rail' as const, x: 0, z: 40 },
    ];
    expect(clipTarget(boards, boards[1])).toBe('b1');
    expect(clipTarget(boards, boards[2])).toBeUndefined();
  });

  it('keeps a clip through saving, and drops one to a board that is gone', () => {
    const doc = boardWithParts();
    detachRails(doc, 'b1');
    const saved = JSON.parse(JSON.stringify(doc));
    const read = readDoc(saved);
    if ('error' in read) throw new Error(read.error);
    expect(read.doc.boards.filter((b) => b.on === 'b1')).toHaveLength(2);
    saved.boards = saved.boards.filter((b: { id: string }) => b.id !== 'b1');
    const orphan = readDoc(saved);
    if ('error' in orphan) throw new Error(orphan.error);
    expect(orphan.doc.boards.every((b) => !b.on)).toBe(true);
  });
});
