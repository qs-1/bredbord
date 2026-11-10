import { describe, expect, it } from 'vitest';
import { benchDoc } from '../src/app/bench';
import { blinkerDoc, counterDoc, exampleDoc, registerDoc } from '../src/app/example';
import { createDoc, type CircuitDoc } from '../src/engine/circuit';
import { DOC_VERSION, readDoc } from '../src/engine/document';

const read = (raw: unknown): { doc: CircuitDoc; notes: string[] } => {
  const r = readDoc(raw);
  if ('error' in r) throw new Error(r.error);
  return r;
};

describe('reading saved circuits', () => {
  it('reads back every example and the benchmark exactly as saved', () => {
    for (const doc of [exampleDoc(), blinkerDoc(), counterDoc(), registerDoc(), benchDoc()]) {
      const saved = JSON.parse(JSON.stringify(doc));
      const { doc: back, notes } = read(saved);
      expect(notes).toEqual([]);
      expect(back).toEqual(saved);
    }
  });

  it('keeps loaded Nano firmware in saved circuits', () => {
    const doc = createDoc();
    doc.parts.push({
      id: 'nano1',
      def: 'nano',
      pins: Array.from({ length: 30 }, () => ({ board: 'b1', hole: 'a1' })),
      firmware: 'AQID',
      firmwareName: 'blink.hex',
    });
    expect(read(JSON.parse(JSON.stringify(doc))).doc.parts[0]).toMatchObject({
      firmware: 'AQID',
      firmwareName: 'blink.hex',
    });
  });

  it('reads scopes and their terminals, and rejects an invalid scope terminal', () => {
    const doc = createDoc();
    doc.scopes = [{ id: 'o1', x: 180, z: -70, timebase: 0.5, voltsPerDiv: 1 }];
    doc.wires.push(
      { id: 'w1', a: { board: 'o1', hole: 'GND' }, b: { board: 'b1', hole: 'T-1' }, color: 'black' },
      { id: 'w2', a: { board: 'o1', hole: 'CH1' }, b: { board: 'b1', hole: 'T+1' }, color: 'yellow' },
      { id: 'w3', a: { board: 'o1', hole: 'NOPE' }, b: { board: 'b1', hole: 'a1' }, color: 'blue' },
    );
    const { doc: back, notes } = read(JSON.parse(JSON.stringify(doc)));
    expect(back.scopes).toEqual(doc.scopes);
    expect(back.wires.map((w) => w.id)).toEqual(['w1', 'w2']);
    expect(notes).toHaveLength(1);
  });

  it('turns away things that aren’t circuits, and circuits from a newer version', () => {
    for (const junk of [null, 42, 'circuit', [], {}, { version: 1 }, { version: '1', boards: [] }])
      expect('error' in readDoc(junk)).toBe(true);
    const newer = readDoc({ ...createDoc(), version: DOC_VERSION + 1 });
    expect('error' in newer && newer.error).toMatch(/newer/);
  });

  it('leaves out what doesn’t make sense, and says so', () => {
    const doc = createDoc();
    doc.parts.push(
      {
        id: 'p2',
        def: 'resistor',
        pins: [
          { board: 'b1', hole: 'a1' },
          { board: 'b1', hole: 'a5' },
        ],
      },
      {
        id: 'p3',
        def: 'flux-capacitor',
        pins: [
          { board: 'b1', hole: 'a7' },
          { board: 'b1', hole: 'a9' },
        ],
      },
      // A resistor with one leg, and one into a board that isn't there.
      { id: 'p4', def: 'resistor', pins: [{ board: 'b1', hole: 'b1' }] },
      {
        id: 'p5',
        def: 'resistor',
        pins: [
          { board: 'b9', hole: 'a1' },
          { board: 'b9', hole: 'a5' },
        ],
      },
    );
    doc.wires.push(
      { id: 'w6', a: { board: 'b1', hole: 'j1' }, b: { board: 'b1', hole: 'j9' }, color: 'blue' },
      { id: 'w7', a: { board: 'b1', hole: 'j10' }, b: { board: 'b1', hole: 'z99' }, color: 'blue' },
    );
    const { doc: back, notes } = read(JSON.parse(JSON.stringify(doc)));
    expect(back.parts.map((p) => p.id)).toEqual(['p2']);
    expect(back.wires.map((w) => w.id)).toEqual(['w6']);
    expect(notes).toHaveLength(2);
  });

  it('keeps handing out unused ids even when the saved counter is behind', () => {
    const doc = createDoc();
    doc.wires.push({ id: 'w40', a: { board: 'b1', hole: 'j1' }, b: { board: 'b1', hole: 'j9' }, color: 'red' });
    doc.nextId = 3;
    expect(read(JSON.parse(JSON.stringify(doc))).doc.nextId).toBe(41);
  });

  it('drops a second thing with an id already taken, and tidies bad values', () => {
    const raw = {
      ...createDoc(),
      wires: [
        {
          id: 'w2',
          a: { board: 'b1', hole: 'j1' },
          b: { board: 'b1', hole: 'j9' },
          color: 'chartreuse',
          points: [{ x: 1, z: 2 }, { x: 'no' }],
        },
        { id: 'w2', a: { board: 'b1', hole: 'j2' }, b: { board: 'b1', hole: 'j8' }, color: 'red' },
      ],
      supplies: [{ id: 's3', x: 0, z: 0, volts: 500, limit: -1 }],
      probes: [
        { id: 'p4', at: { board: 's3', hole: '+' }, break: 'rise' },
        { id: 'p5', at: { board: 'b1', hole: 'a1' }, break: 'sideways' },
      ],
    };
    const { doc } = read(raw);
    expect(doc.wires).toEqual([
      {
        id: 'w2',
        a: { board: 'b1', hole: 'j1' },
        b: { board: 'b1', hole: 'j9' },
        color: 'red',
        points: [{ x: 1, z: 2 }],
      },
    ]);
    expect(doc.supplies?.[0].volts).toBe(30);
    expect(doc.supplies?.[0].limit).toBeGreaterThan(0);
    expect(doc.probes).toEqual([
      { id: 'p4', at: { board: 's3', hole: '+' }, break: 'rise' },
      { id: 'p5', at: { board: 'b1', hole: 'a1' } },
    ]);
  });

  it('gives a resistor or capacitor of nothing its default, and keeps others in range', () => {
    const doc = createDoc();
    const two = [
      { board: 'b1', hole: 'a1' },
      { board: 'b1', hole: 'a5' },
    ];
    doc.parts.push(
      { id: 'r1', def: 'resistor', pins: two, value: 0 },
      { id: 'r2', def: 'resistor', pins: two, value: -220 },
      { id: 'r3', def: 'resistor', pins: two, value: 1e-30 },
      { id: 'c1', def: 'cap-ceramic', pins: two, value: 1e9 },
      { id: 'c2', def: 'cap-ceramic', pins: two, value: 100e-9 },
    );
    const parts = read(JSON.parse(JSON.stringify(doc))).doc.parts;
    expect(parts.map((p) => p.value)).toEqual([undefined, undefined, 0.001, 100, 100e-9]);
  });

  it('caps how much a circuit can hold, and says what it left out', () => {
    const doc = createDoc();
    const wire = (i: number) => ({
      id: `w${i}`,
      a: { board: 'b1', hole: 'a1' },
      b: { board: 'b1', hole: 'a2' },
      color: 'red' as const,
    });
    doc.wires = Array.from({ length: 20005 }, (_, i) => wire(i));
    doc.wires[0].points = Array.from({ length: 500 }, (_, i) => ({ x: i, z: 0 }));
    doc.boards.push({ id: 'far', type: 'bb830', x: 1e9, z: 0 });
    const { doc: back, notes } = read(JSON.parse(JSON.stringify(doc)));
    expect(back.wires).toHaveLength(20000);
    expect(back.wires[0].points).toHaveLength(200);
    expect(back.boards.map((b) => b.id)).toEqual(['b1']);
    expect(notes).toEqual(['Skipped 5 wires to missing holes', 'Skipped 1 invalid item']);
  });

  it('leaves out an EEPROM image too big for any chip', () => {
    const doc = createDoc();
    doc.parts.push({
      id: 'e1',
      def: '28C16',
      pins: Array.from({ length: 24 }, () => ({ board: 'b1', hole: 'a1' })),
      data: 'A'.repeat(200_000),
    });
    expect(read(JSON.parse(JSON.stringify(doc))).doc.parts[0].data).toBeUndefined();
  });
});
