// Small working circuits to learn from, in the examples menu.

import { boardSpec, RAIL_GRID_ROW, type RailName } from '../engine/breadboard';
import type { CircuitDoc, HoleRef, WireColor } from '../engine/circuit';

/** Builds a circuit on one breadboard, handing out ids and free rail holes. */
function circuit(name: string) {
  const doc: CircuitDoc = {
    version: 1,
    name,
    boards: [{ id: 'b1', type: 'bb830', x: 0, z: 0 }],
    wires: [],
    parts: [],
    nextId: 2,
  };
  const spec = boardSpec('bb830');
  const used = new Set<string>();
  const h = (hole: string): HoleRef => {
    used.add(hole);
    return { board: 'b1', hole };
  };
  const id = (prefix: string): string => `${prefix}${doc.nextId++}`;
  return {
    doc,
    used,
    part(def: string, holes: string[], extra: { value?: number; state?: number } = {}): void {
      doc.parts.push({ id: id('p'), def, pins: holes.map(h), ...extra });
    },
    wire(a: string, b: string, color: WireColor): void {
      doc.wires.push({ id: id('w'), a: h(a), b: h(b), color });
    },
    /** The free rail hole nearest above (or below) terminal column `col`, counting from 1. */
    rail(rail: RailName, col: number): string {
      for (let d = 0; d < 8; d++) {
        for (const c of [col - 1 + d, col - 1 - d]) {
          const hole = spec.holeAt(c, RAIL_GRID_ROW[rail]);
          if (hole && !used.has(hole.name)) return hole.name;
        }
      }
      throw new Error(`no free ${rail} hole near ${col}`);
    },
  };
}

/** Holes of a DIP chip with pin 1 in column `col` (counting from 1), notch to the left. */
function dip(pins: number, col: number): string[] {
  const n = pins / 2;
  const holes: string[] = [];
  for (let i = 0; i < n; i++) holes.push(`f${col + i}`);
  for (let i = 0; i < n; i++) holes.push(`e${col + n - 1 - i}`);
  return holes;
}

/**
 * A 74LS00 NAND gate with two push buttons on its inputs and an LED on its output. Switch the
 * power on, then press a button. (The inputs float high, as TTL inputs do, so the LED lights
 * while either button is held.)
 */
export function exampleDoc(): CircuitDoc {
  const c = circuit('Example: NAND gate');
  c.part('power', ['T+1', 'T-1', 'B+1', 'B-1'], { state: 0 });
  // 74LS00 in holes 24–30: pin 14 (VCC) is e24, pin 7 (GND) is f30.
  c.part('74LS00', dip(14, 24));
  c.wire('a24', c.rail('T+', 24), 'red');
  c.wire('j30', c.rail('B-', 30), 'black');
  // Two buttons across the channel: top side to ground, bottom side to inputs 1A and 1B.
  c.part('button', ['e15', 'e17', 'f15', 'f17']);
  c.wire('a15', c.rail('T-', 15), 'black');
  c.wire('h15', 'h24', 'yellow');
  c.part('button', ['e19', 'e21', 'f19', 'f21']);
  c.wire('a19', c.rail('T-', 19), 'black');
  c.wire('i19', 'i25', 'green');
  // Output 1Y to a red LED, through a 220 Ω resistor to ground.
  c.wire('h26', 'h40', 'blue');
  c.part('led-red', ['j40', 'j41']);
  c.part('resistor', ['i41', 'i45'], { value: 220 });
  c.wire('j45', c.rail('B-', 45), 'black');
  return c.doc;
}

/**
 * Ben Eater's clock: a 555 astable with a 1 kΩ resistor, a 1 MΩ knob and a 1 µF capacitor, blinking
 * a blue LED from about 0.7 Hz to a few hundred hertz. Turn the knob while it runs.
 */
export function blinkerDoc(): CircuitDoc {
  const c = circuit('Example: 555 clock');
  c.part('power', ['T+1', 'T-1', 'B+1', 'B-1'], { state: 0 });
  // 555 in holes 20–23. Top strips: 20 VCC, 21 DIS, 22 THR, 23 CTRL; bottom: 20 GND, 21 TRIG, 22 OUT, 23 RESET.
  c.part('NE555', dip(8, 20));
  c.wire('a20', c.rail('T+', 19), 'red');
  c.wire('j20', c.rail('B-', 19), 'black');
  c.wire('j23', c.rail('B+', 24), 'red');
  // R1 from + to DIS; the knob (as R2) from DIS to THR; TRIG joined to THR over the chip.
  c.part('resistor', [c.rail('T+', 21), 'b21'], { value: 1000 });
  c.part('pot', ['a26', 'a27', 'a28'], { value: 1e6, state: 500 });
  c.wire('d21', 'd26', 'yellow');
  c.wire('e27', 'd22', 'orange');
  c.wire('g21', 'c22', 'green');
  // The timing capacitor from TRIG to ground, and 0.01 µF on CTRL to keep it steady.
  c.part('cap-electrolytic', ['i21', 'i20'], { value: 1e-6 });
  c.part('cap-ceramic', ['c23', 'c24'], { value: 10e-9 });
  c.wire('a24', c.rail('T-', 25), 'black');
  // The clock LED, legs bent down into the ground rail.
  c.part('led-blue', ['j22', c.rail('B-', 22)]);
  return c.doc;
}

/**
 * A 555 clock counting on a 74LS161: four red LEDs show the count in binary, bit 0 on the left.
 * The LEDs go straight from the outputs into the ground rail with no resistors, the way Ben wires
 * his: a 74LS output can only push about 15 mA into an LED anyway.
 */
export function counterDoc(): CircuitDoc {
  const c = circuit('Example: 4-bit counter');
  c.part('power', ['T+1', 'T-1', 'B+1', 'B-1'], { state: 0 });
  // 555 astable in holes 12–15, about 1.5 Hz: 1 kΩ, 100 kΩ, 4.7 µF.
  c.part('NE555', dip(8, 12));
  c.wire('a12', c.rail('T+', 12), 'red');
  c.wire('j12', c.rail('B-', 12), 'black');
  c.wire('j15', c.rail('B+', 15), 'red');
  c.part('resistor', [c.rail('T+', 13), 'b13'], { value: 1000 });
  // R2 from DIS out to a free strip, then over to THR: lying across the chip, it would sit in it.
  c.part('resistor', ['d9', 'd13'], { value: 100000 });
  c.wire('c9', 'b14', 'green');
  c.wire('h13', 'c14', 'green');
  c.part('cap-electrolytic', ['i13', 'i12'], { value: 4.7e-6 });
  c.part('cap-ceramic', ['c15', 'c16'], { value: 10e-9 });
  c.wire('a16', c.rail('T-', 16), 'black');
  // 74LS161 in holes 31–38. CLR, LOAD, ENP and ENT float high, so it just counts.
  c.part('74LS161', dip(16, 31));
  c.wire('a31', c.rail('T+', 31), 'red');
  c.wire('j38', c.rail('B-', 39), 'black');
  c.wire('j14', 'j32', 'yellow');
  // QA–QD (top strips 33–36) straight to 3 mm LEDs, legs bent into the ground rail above.
  for (const col of [33, 34, 35, 36]) c.part('led-red', [`a${col}`, c.rail('T-', col)], { value: 3 });
  return c.doc;
}

/**
 * A 4-bit register like the ones in Ben's computer: set a number on the DIP switch, press the
 * button to clock it into a 74LS173, and the four LEDs keep showing it after the switches change.
 * Each switch pulls its bit up to 5 V against a 1 kΩ pull-down, since a TTL input left alone
 * reads high.
 */
export function registerDoc(): CircuitDoc {
  const c = circuit('Example: 4-bit register');
  c.part('power', ['T+1', 'T-1', 'B+1', 'B-1'], { state: 0 });
  // The switch in holes 6–9: top side to +, bottom side is bits 0–3, pulled down to ground.
  c.part('dip-switch-4', dip(8, 6), { state: 0b0101 });
  for (const col of [6, 7, 8, 9]) {
    c.wire(`a${col}`, c.rail('T+', col), 'red');
    c.part('resistor', [`j${col}`, c.rail('B-', col)], { value: 1000 });
  }
  // 74LS173 in holes 22–29. Bottom: M, N, 1Q–4Q, CLK, GND; top: VCC, CLR, 1D–4D, G2, G1.
  c.part('74LS173', dip(16, 22));
  c.wire('a22', c.rail('T+', 22), 'red');
  c.wire('j29', c.rail('B-', 30), 'black');
  // Outputs always on (M, N low), loading always on (G1, G2 low), never cleared (CLR low).
  c.wire('j22', c.rail('B-', 21), 'black');
  c.wire('j23', c.rail('B-', 23), 'black');
  c.wire('a23', c.rail('T-', 23), 'black');
  c.wire('a28', c.rail('T-', 28), 'black');
  c.wire('a29', c.rail('T-', 30), 'black');
  // Bits 0–3 over to 1D–4D.
  [6, 7, 8, 9].forEach((col, k) => c.wire(`h${col}`, `b${24 + k}`, (['yellow', 'green', 'blue', 'white'] as const)[k]));
  // 1Q–4Q to 3 mm LEDs, legs bent into the ground rail below.
  for (const col of [24, 25, 26, 27]) c.part('led-red', [`i${col}`, c.rail('B-', col)], { value: 3 });
  // The clock button: pressing it joins + (top) to CLK (bottom), which a 1 kΩ holds low otherwise.
  c.part('button', ['e44', 'e46', 'f44', 'f46']);
  c.wire('a44', c.rail('T+', 44), 'red');
  c.part('resistor', ['j44', c.rail('B-', 44)], { value: 1000 });
  c.wire('h44', 'h28', 'orange');
  return c.doc;
}

/** The examples menu. */
export const EXAMPLES: readonly { title: string; make: () => CircuitDoc | Promise<CircuitDoc> }[] = [
  { title: 'NAND gate', make: exampleDoc },
  { title: '555 clock', make: blinkerDoc },
  { title: '4-bit counter', make: counterDoc },
  { title: '4-bit register', make: registerDoc },
];
