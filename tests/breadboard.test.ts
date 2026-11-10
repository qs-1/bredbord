import { describe, expect, it } from 'vitest';
import {
  boardSpec,
  DATA_BUS_CENTRE_Z,
  DATA_BUS_RAIL_STEPS,
  DATA_BUS_ROW_PITCH,
  DATA_BUS_TRACKS,
  dataBusCathodeHole,
  dataBusCathodeSpareHole,
  dataBusLedHole,
  dataBusTapHole,
  PITCH,
} from '../src/engine/breadboard';

describe('BB830 layout', () => {
  const bb = boardSpec('bb830');
  const hole = (name: string) => {
    const h = bb.hole(name);
    if (!h) throw new Error(`no hole ${name}`);
    return h;
  };

  it('has 830 holes: 630 in the terminal strips and 200 in the rails', () => {
    expect(bb.holes).toHaveLength(830);
    expect(bb.holes.filter((h) => h.kind === 'terminal')).toHaveLength(630);
    expect(bb.holes.filter((h) => h.kind === 'rail')).toHaveLength(200);
    expect(new Set(bb.holes.map((h) => h.name)).size).toBe(830);
  });

  it('names holes like a real board', () => {
    expect(bb.hole('a1')).toBeDefined();
    expect(bb.hole('j63')).toBeDefined();
    expect(bb.hole('k1')).toBeUndefined();
    expect(bb.hole('a64')).toBeUndefined();
    expect(bb.hole('T+50')).toBeDefined();
    expect(bb.hole('B-1')).toBeDefined();
    expect(bb.hole('T+51')).toBeUndefined();
  });

  it('spaces holes 0.1" apart with a 0.3" channel between e and f', () => {
    expect(hole('a2').x - hole('a1').x).toBeCloseTo(PITCH);
    expect(hole('b1').z - hole('a1').z).toBeCloseTo(PITCH);
    expect(hole('f1').z - hole('e1').z).toBeCloseTo(3 * PITCH);
  });

  it('keeps every hole inside the board outline', () => {
    for (const h of bb.holes) {
      expect(Math.abs(h.x)).toBeLessThan(bb.length / 2 - 1);
      expect(Math.abs(h.z)).toBeLessThan(bb.width / 2 - 1);
    }
  });

  it('joins each column into two strips of five', () => {
    const strip = ['a', 'b', 'c', 'd', 'e'].map((r) => hole(`${r}12`).group);
    expect(new Set(strip).size).toBe(1);
    expect(hole('f12').group).not.toBe(hole('e12').group);
    expect(hole('a12').group).not.toBe(hole('a13').group);
    expect(bb.groups.filter((g) => g.length === 5)).toHaveLength(126);
  });

  it('runs each rail the full length in groups of five', () => {
    const rail = bb.holes.filter((h) => h.rail === 'T+');
    expect(new Set(rail.map((h) => h.group)).size).toBe(1);
    const cols = rail.map((h) => h.col);
    expect(cols.slice(0, 6)).toEqual([2, 3, 4, 5, 6, 8]);
    expect(hole('T+1').group).not.toBe(hole('T-1').group);
  });

  it('splits the rails in the middle on split-rail boards', () => {
    const split = boardSpec('bb830-split');
    expect(split.hole('T+25')!.group).not.toBe(split.hole('T+26')!.group);
    expect(split.hole('T+1')!.group).toBe(split.hole('T+25')!.group);
  });

  it('finds the hole under a point, and nothing in the channel', () => {
    const a12 = hole('a12');
    expect(bb.nearestHole(a12.x + 0.4, a12.z - 0.3)?.name).toBe('a12');
    const midChannel = (hole('e12').z + hole('f12').z) / 2;
    expect(bb.nearestHole(a12.x, midChannel)).toBeUndefined();
  });
});

describe('central eight-bit data bus', () => {
  const bb = boardSpec('bb830');
  const bus = boardSpec('data-bus');

  it('has eight independent continuous conductors grouped as four rail pairs', () => {
    expect(DATA_BUS_TRACKS).toHaveLength(8);
    expect(bus.groups).toHaveLength(16); // Eight bus lanes plus eight isolated LED-cathode strips.
    expect(bus.holes.every((hole) => hole.rail === undefined)).toBe(true); // No +5V or GND rails here.

    const laneGroups = DATA_BUS_TRACKS.map(({ bit }) => bus.hole(dataBusLedHole(bit))!.group);
    expect(new Set(laneGroups).size).toBe(8);

    for (const { bit } of DATA_BUS_TRACKS) {
      const group = bus.hole(dataBusLedHole(bit))!.group;
      for (let row = 0; row < 7; row++) {
        expect(bus.hole(dataBusTapHole(bit, 'L', row))!.group).toBe(group);
        expect(bus.hole(dataBusTapHole(bit, 'R', row))!.group).toBe(group);
      }
    }
  });

  it('keeps each bus indicator LED cathode separate from its data line', () => {
    for (const { bit } of DATA_BUS_TRACKS) {
      const lane = bus.hole(dataBusLedHole(bit))!.group;
      const cathode = bus.hole(dataBusCathodeHole(bit))!.group;
      expect(cathode).not.toBe(lane);
      expect(bus.hole(dataBusCathodeSpareHole(bit))!.group).toBe(cathode);
    }
  });

  it('uses the exact BB830 five-hole groups and one-pitch gap', () => {
    const standard = bb.holes
      .filter((hole) => hole.rail === 'T+')
      .slice(0, 10)
      .map((hole) => hole.col - 2);
    expect(DATA_BUS_RAIL_STEPS.slice(0, 10)).toEqual(standard);
    expect(bus.hole('BUS_7_P4')!.group).toBe(bus.hole('BUS_7_P6')!.group);
    expect(bus.hole('BUS_7_P6')!.z - bus.hole('BUS_7_P4')!.z).toBeCloseTo(2 * PITCH);
  });

  it('uses standard 0.1-inch hole pitch along each vertical rail', () => {
    const first = bus.hole('BUS_7_P3')!;
    const next = bus.hole('BUS_7_P4')!;
    expect(next.x).toBeCloseTo(first.x);
    expect(next.z - first.z).toBeCloseTo(PITCH);
  });

  it('places left and right taps alongside all seven breadboard levels', () => {
    for (const { bit } of DATA_BUS_TRACKS) {
      for (let row = 0; row < 7; row++) {
        const boardZ = (row - 3) * DATA_BUS_ROW_PITCH;
        const left = bus.hole(dataBusTapHole(bit, 'L', row))!;
        const right = bus.hole(dataBusTapHole(bit, 'R', row))!;
        expect(Math.abs(left.z + DATA_BUS_CENTRE_Z - (boardZ - 2.54))).toBeLessThanOrEqual(PITCH / 2 + 1e-6);
        expect(Math.abs(right.z + DATA_BUS_CENTRE_Z - (boardZ + 2.54))).toBeLessThanOrEqual(PITCH / 2 + 1e-6);
      }
    }
  });
});

describe('other board types', () => {
  const count = (t: Parameters<typeof boardSpec>[0]): number => boardSpec(t).holes.length;
  const groups = (t: Parameters<typeof boardSpec>[0]): number => boardSpec(t).groups.filter((g) => g.length).length;
  it('has the right number of holes', () => {
    expect(count('core-bb830')).toBe(630);
    expect(count('bb400')).toBe(400);
    expect(count('mini')).toBe(170);
    expect(count('rail')).toBe(100);
    expect(count('rail-v')).toBe(100);
  });
  it('joins rail strips into two lines', () => {
    expect(groups('rail')).toBe(2);
    expect(groups('rail-v')).toBe(2);
    expect(boardSpec('rail-v').vertical).toBe(true);
  });
  it('keeps the 830 holes where they were', () => {
    const a = boardSpec('core-bb830').hole('a1')!;
    const b = boardSpec('bb830').hole('a1')!;
    expect([a.x, a.z]).toEqual([b.x, b.z]);
  });
});

describe('rail length', () => {
  it('cuts a rail to so many holes a row', async () => {
    const { railStrip, railType } = await import('../src/engine/breadboard');
    expect(railStrip('rail')).toEqual({ vertical: false, holes: 50 });
    expect(railStrip(railType(true, 20))).toEqual({ vertical: true, holes: 20 });
    expect(railType(false, 50)).toBe('rail');
    expect(railStrip('rail-7' as never)).toBeNull();
    const short = boardSpec(railType(false, 25));
    expect(short.holes.length).toBe(50);
    expect(short.groups.filter((g) => g.length).length).toBe(2);
    expect(boardSpec(railType(true, 25)).width).toBeLessThan(boardSpec('rail-v').width);
    expect(boardSpec(railType(false, 50)).length).toBeCloseTo(165.1);
  });
});
