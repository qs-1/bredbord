import { describe, expect, it } from 'vitest';
import { createDoc, type CircuitDoc, type HoleRef } from '../src/engine/circuit';
import { Connectivity } from '../src/engine/netlist';

const at = (hole: string, board = 'b1'): HoleRef => ({ board, hole });

function docWith(wires: [HoleRef, HoleRef][], extraBoards = 0): CircuitDoc {
  const doc = createDoc();
  for (let i = 0; i < extraBoards; i++) doc.boards.push({ id: `b${i + 2}`, type: 'bb830', x: 0, z: 60 * (i + 1) });
  wires.forEach(([a, b], i) => doc.wires.push({ id: `w${i}`, a, b, color: 'red' }));
  return doc;
}

describe('Connectivity', () => {
  it('joins a five-hole strip and nothing else', () => {
    const c = new Connectivity(docWith([]));
    expect(c.connected(at('a5'), at('e5'))).toBe(true);
    expect(c.connected(at('e5'), at('f5'))).toBe(false);
    expect(c.connected(at('a5'), at('a6'))).toBe(false);
    expect(
      c
        .members(at('c5'))
        .map((r) => r.hole)
        .sort(),
    ).toEqual(['a5', 'b5', 'c5', 'd5', 'e5']);
  });

  it('joins strips through a wire', () => {
    const c = new Connectivity(docWith([[at('a1'), at('j10')]]));
    expect(c.connected(at('c1'), at('g10'))).toBe(true);
    expect(c.members(at('e1'))).toHaveLength(10);
  });

  it('chains wires', () => {
    const c = new Connectivity(
      docWith([
        [at('a1'), at('a2')],
        [at('b2'), at('a3')],
      ]),
    );
    expect(c.connected(at('e1'), at('e3'))).toBe(true);
  });

  it('powers a strip from the rail', () => {
    const c = new Connectivity(docWith([[at('T+3'), at('a20')]]));
    expect(c.connected(at('T+48'), at('d20'))).toBe(true);
    expect(c.connected(at('T-48'), at('d20'))).toBe(false);
    expect(c.members(at('T+1'))).toHaveLength(55);
  });

  it('links boards together', () => {
    const c = new Connectivity(docWith([[at('B+1'), at('T+1', 'b2')]], 1));
    expect(c.connected(at('B+50'), at('T+50', 'b2'))).toBe(true);
    expect(c.connected(at('a1'), at('a1', 'b2'))).toBe(false);
  });

  it('ignores wires to holes that do not exist', () => {
    const c = new Connectivity(docWith([[at('a1'), at('z99')]]));
    expect(c.members(at('a1'))).toHaveLength(5);
    expect(c.netOf(at('z99'))).toBe(-1);
  });
});
