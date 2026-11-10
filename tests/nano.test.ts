import { describe, expect, it } from 'vitest';
import { boardSpec, RAIL_GRID_ROW, type RailName } from '../src/engine/breadboard';
import { createDoc, type CircuitDoc, type HoleRef } from '../src/engine/circuit';
import { Connectivity } from '../src/engine/netlist';
import { dipFootprint, dipPinHoles, PARTS } from '../src/engine/parts';
import { hexDigitRom } from '../src/engine/roms';
import { Simulator } from '../src/engine/sim/simulator';

const spec = boardSpec('bb830');
const h = (hole: string): HoleRef => ({ board: 'b1', hole });

/** One board with parts placed by column and wires found free holes for, like you'd do by hand. */
class Build {
  readonly doc: CircuitDoc = createDoc();
  readonly sim = new Simulator();
  private used = new Set<string>();
  private pinsOf = new Map<string, string[]>();
  private n = 0;

  part(id: string, def: string, start: number, extra: { value?: number; state?: number; data?: string } = {}): this {
    const holes = dipPinHoles(dipFootprint(PARTS[def])!, start, false).map((p) => `${p.row}${p.col + 1}`);
    holes.forEach((x) => this.used.add(x));
    this.pinsOf.set(id, holes);
    this.doc.parts.push({ id, def, pins: holes.map(h), ...extra });
    return this;
  }

  /** A free hole in the same strip as a part's pin. */
  private near(id: string, pin: number): string {
    const hole = this.pinsOf.get(id)![pin - 1];
    const col = hole.slice(1);
    for (const row of hole[0] <= 'e' ? 'abcde' : 'fghij') {
      const name = `${row}${col}`;
      if (!this.used.has(name)) {
        this.used.add(name);
        return name;
      }
    }
    throw new Error(`strip of ${id} pin ${pin} is full`);
  }

  private free(name: RailName): string {
    for (let col = 0; col < 63; col++) {
      const r = spec.holeAt(col, RAIL_GRID_ROW[name]);
      if (r && !this.used.has(r.name)) {
        this.used.add(r.name);
        return r.name;
      }
    }
    throw new Error('rail full');
  }

  private wire(a: string, b: string): void {
    this.doc.wires.push({ id: `w${this.n++}`, a: h(a), b: h(b), color: 'blue' });
  }

  connect(a: [string, number], b: [string, number]): this {
    this.wire(this.near(...a), this.near(...b));
    return this;
  }

  /** A pin to + or −, on whichever pair of rails is on its side of the board. */
  rail(id: string, pin: number, plus: boolean): this {
    const hole = this.near(id, pin);
    this.wire(hole, this.free(`${hole[0] <= 'e' ? 'T' : 'B'}${plus ? '+' : '-'}` as RailName));
    return this;
  }

  joinRails(): this {
    this.wire(this.free('T+'), this.free('B+'));
    this.wire(this.free('T-'), this.free('B-'));
    return this;
  }

  run(): void {
    this.sim.run(this.doc, new Connectivity(this.doc));
  }
}

// Nano header pins of the Arduino pins Ben's programmer uses.
const D = (n: number): number => (n <= 1 ? 2 - n : n <= 12 ? n + 3 : 16);

/** Ben's EEPROM programmer: a Nano, two chained 74HC595s for the address, and the 28C16. */
function programmer(sketch: number, image: number): Build {
  const b = new Build()
    .part('nano', 'nano', 0, { state: sketch, value: image })
    .part('sr1', '74HC595', 17)
    .part('sr2', '74HC595', 27)
    .part('rom', '28C16', 38)
    .joinRails()
    .rail('nano', 27, true)
    .rail('nano', 29, false);
  for (const sr of ['sr1', 'sr2']) {
    b.rail(sr, 16, true).rail(sr, 8, false).rail(sr, 10, true).rail(sr, 13, false);
    b.connect(['nano', D(3)], [sr, 11]).connect(['nano', D(4)], [sr, 12]);
  }
  b.connect(['nano', D(2)], ['sr1', 14]).connect(['sr1', 9], ['sr2', 14]);
  // Low byte: QA–QH to A0–A7. High byte: QA–QC to A8–A10, QH to OE.
  const Q = [15, 1, 2, 3, 4, 5, 6, 7];
  const A = [8, 7, 6, 5, 4, 3, 2, 1, 23, 22, 19];
  Q.forEach((q, i) => b.connect(['sr1', q], ['rom', A[i]]));
  [0, 1, 2].forEach((i) => b.connect(['sr2', Q[i]], ['rom', A[8 + i]]));
  b.connect(['sr2', 7], ['rom', 20]);
  const IO = [9, 10, 11, 13, 14, 15, 16, 17];
  IO.forEach((io, i) => b.connect(['nano', D(5 + i)], ['rom', io]));
  b.connect(['nano', D(13)], ['rom', 21]);
  b.rail('rom', 24, true).rail('rom', 12, false).rail('rom', 18, false);
  return b;
}

describe('Arduino Nano', () => {
  it('powers the board from its 5V pin and blinks pin 13', () => {
    const b = new Build()
      .part('nano', 'nano', 0, { state: 2 })
      .joinRails()
      .rail('nano', 27, true)
      .rail('nano', 29, false);
    b.run();
    const r = b.sim.snapshot();
    expect(r.live).toBe(true);
    expect(r.volts(h(b.doc.parts[0].pins[26].hole))).toBeCloseTo(5);
    b.sim.advance(0.7);
    expect(b.sim.snapshot().mcus.get('nano')?.led).toBe(true);
    b.sim.advance(1);
    expect(b.sim.snapshot().mcus.get('nano')?.led).toBe(false);
  });

  it('programs a 28C16 through two 74HC595s, the way Ben does', () => {
    const b = programmer(0, 2);
    b.run();
    b.sim.advance(30);
    const rom = b.doc.parts.find((p) => p.id === 'rom')!;
    expect(Array.from(b.sim.memoryOf(rom)!)).toEqual(Array.from(hexDigitRom()));
    const mcu = b.sim.snapshot().mcus.get('nano')!;
    expect(mcu.serial).toContain('Programming EEPROM');
    expect(mcu.serial).toContain('Verified');
    expect(mcu.serial).toContain('000:  7e 30 6d 79 33 5b 5f 70   7f 7b 77 1f 4e 3d 4f 47');
    expect(mcu.progress).toBe(1);
  }, 60_000);

  it('reads back what is there, and notices a wiring mistake', () => {
    const b = programmer(1, 0);
    b.doc.parts.find((p) => p.id === 'rom')!.data = btoa(String.fromCharCode(...hexDigitRom()));
    b.run();
    b.sim.advance(2);
    expect(b.sim.snapshot().mcus.get('nano')!.serial).toContain('010:  7e 30 6d 79');

    // Data line IO0 left off: the programmer's verify pass should catch it.
    const broken = programmer(0, 2);
    const pin9 = broken.doc.parts.find((p) => p.id === 'rom')!.pins[8].hole;
    const io0 = broken.doc.wires.findIndex((w) => w.b.hole.slice(1) === pin9.slice(1) && w.b.hole[0] > 'e');
    expect(io0).toBeGreaterThanOrEqual(0);
    broken.doc.wires.splice(io0, 1);
    broken.run();
    broken.sim.advance(30);
    expect(broken.sim.snapshot().mcus.get('nano')!.serial).toMatch(/Verify failed: \d+ bytes differ/);
  }, 60_000);
});
