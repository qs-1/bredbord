// A working build the size of Ben Eater's 8-bit computer, for measuring how the simulator copes:
// one 555 clock fanned out over 13 boards, each with a 74LS161 counting, a 74LS86 mixing its bits
// and a 74LS173 latching them, and LEDs on every output. 40 chips, 104 LEDs, all switching.

import { BOARD_LENGTH, BOARD_WIDTH, boardSpec, RAIL_GRID_ROW, type RailName } from '../engine/breadboard';
import { createDoc, type CircuitDoc, type HoleRef, type Id, type WireColor } from '../engine/circuit';

/** Holes of a DIP chip with pin 1 in column `col` (counting from 1), notch to the left. */
function dip(pins: number, col: number): string[] {
  const n = pins / 2;
  const holes: string[] = [];
  for (let i = 0; i < n; i++) holes.push(`f${col + i}`);
  for (let i = 0; i < n; i++) holes.push(`e${col + n - 1 - i}`);
  return holes;
}

/** `clockFarads` sets the clock: 10 nF ticks at about 700 Hz, 4.7 µF at about 1.5 Hz. */
export function benchDoc(boards = 13, clockFarads = 10e-9): CircuitDoc {
  const doc = createDoc();
  doc.name = 'Benchmark: 8-bit computer scale';
  doc.boards = [];
  doc.nextId = boards + 1;
  const spec = boardSpec('bb830');
  const id = (prefix: string): Id => `${prefix}${doc.nextId++}`;

  for (let k = 0; k < boards; k++) {
    const board = `b${k + 1}`;
    doc.boards.push({
      id: board,
      type: 'bb830',
      x: (k % 2 ? 1 : -1) * (BOARD_LENGTH / 2 + 1),
      z: Math.floor(k / 2) * (BOARD_WIDTH + 1),
    });
    const used = new Set<string>();
    const h = (hole: string): HoleRef => {
      used.add(hole);
      return { board, hole };
    };
    const part = (def: string, holes: string[], extra: { value?: number; state?: number } = {}): void => {
      doc.parts.push({ id: id('p'), def, pins: holes.map(h), ...extra });
    };
    const wire = (a: string, b: string, color: WireColor = 'yellow'): void => {
      doc.wires.push({ id: id('w'), a: h(a), b: h(b), color });
    };
    const rail = (name: RailName, col: number): string => {
      for (let d = 0; d < 8; d++) {
        for (const c of [col - 1 + d, col - 1 - d]) {
          const hole = spec.holeAt(c, RAIL_GRID_ROW[name]);
          if (hole && !used.has(hole.name)) return hole.name;
        }
      }
      throw new Error(`no free ${name} hole near ${col}`);
    };

    part('power', ['T+1', 'T-1', 'B+1', 'B-1']);

    // 74LS161 in 5–12: CLK bottom 6, QA–QD top 7–10 (CLR, LOAD, ENP, ENT float high).
    part('74LS161', dip(16, 5));
    wire('a5', rail('T+', 5), 'red');
    wire('j12', rail('B-', 12), 'black');
    for (const col of [7, 8, 9, 10]) part('led-green', [`a${col}`, rail('T-', col)], { value: 3 });

    // 74LS86 in 20–26: 1Y = QA^QB, 2Y = QB^QC, 3Y = QC^QD, 4Y = QD^QA.
    part('74LS86', dip(14, 20));
    wire('a20', rail('T+', 20), 'red');
    wire('j26', rail('B-', 26), 'black');
    wire('b7', 'h20', 'blue');
    wire('b8', 'h21', 'blue');
    wire('c8', 'h23', 'blue');
    wire('b9', 'h24', 'blue');
    wire('c9', 'c25', 'blue');
    wire('b10', 'c24', 'blue');
    wire('c10', 'c22', 'blue');
    wire('c7', 'c21', 'blue');

    // 74LS173 in 35–42 latching the XORs; outputs and loading always on, never cleared.
    part('74LS173', dip(16, 35));
    wire('a35', rail('T+', 35), 'red');
    wire('j42', rail('B-', 42), 'black');
    wire('j35', rail('B-', 34), 'black');
    wire('j36', rail('B-', 36), 'black');
    wire('a36', rail('T-', 36), 'black');
    wire('a41', rail('T-', 41), 'black');
    wire('a42', rail('T-', 43), 'black');
    wire('i22', 'b37', 'white');
    wire('i25', 'b38', 'white');
    wire('d26', 'b39', 'white');
    wire('d23', 'b40', 'white');
    for (const col of [37, 38, 39, 40]) part('led-red', [`j${col}`, rail('B-', col)], { value: 3 });

    // The clock into both chips, and on to the next board.
    wire('i6', 'i41', 'orange');
    if (k + 1 < boards)
      doc.wires.push({ id: id('w'), a: h('g6'), b: { board: `b${k + 2}`, hole: 'g6' }, color: 'orange' });

    if (k === 0) {
      // The 555 astable in 50–53 (1 kΩ, 100 kΩ), its output (bottom 52) driving the clock line.
      part('NE555', dip(8, 50));
      wire('a50', rail('T+', 50), 'red');
      wire('j50', rail('B-', 50), 'black');
      wire('j53', rail('B+', 53), 'red');
      part('resistor', [rail('T+', 51), 'b51'], { value: 1000 });
      part('resistor', ['d51', 'g51'], { value: 100000 });
      wire('h51', 'c52', 'green');
      part('cap-electrolytic', ['i51', 'i50'], { value: clockFarads });
      part('cap-ceramic', ['c53', 'c54'], { value: 10e-9 });
      wire('a54', rail('T-', 54), 'black');
      wire('j52', 'h6', 'orange');
    }
  }
  return doc;
}
