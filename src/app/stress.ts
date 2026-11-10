// Fills the desk with a build the size of Ben Eater's 8-bit computer and measures the frame rate.
// Run from the browser console: await bb.stress()

import { BOARD_LENGTH, BOARD_WIDTH, boardSpec, COLUMNS, TERMINAL_ROWS } from '../engine/breadboard';
import { createDoc, holeKey, WIRE_COLORS, type HoleRef } from '../engine/circuit';
import { dipPinHoles, PART_LIST, type DipDef } from '../engine/parts';
import type { View } from '../view/view';
import type { SceneSync } from './scene-sync';
import type { Store } from './store';

export async function runStressTest(store: Store, sync: SceneSync, view: View) {
  let seed = 12345;
  const rnd = (): number => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;

  const doc = createDoc();
  doc.boards = [];
  for (let i = 0; i < 14; i++) {
    doc.boards.push({
      id: `b${i + 1}`,
      type: 'bb830',
      x: (i % 2 ? 1 : -1) * (BOARD_LENGTH / 2 + 1),
      z: Math.floor(i / 2) * BOARD_WIDTH,
    });
  }
  doc.nextId = 1000;
  const used = new Set<string>();
  const free = (...refs: HoleRef[]): boolean => refs.every((r) => !used.has(holeKey(r)));
  const take = (...refs: HoleRef[]): void => refs.forEach((r) => used.add(holeKey(r)));

  const chips = PART_LIST.filter((p): p is DipDef => p.kind === 'dip' && !p.wide);
  for (const b of doc.boards) {
    let col = 2;
    while (doc.parts.length < 50) {
      const def = chips[Math.floor(rnd() * chips.length)];
      if (col + def.pins / 2 > COLUMNS - 1) break;
      const pins = dipPinHoles(def, col, rnd() < 0.5).map((p) => ({ board: b.id, hole: `${p.row}${p.col + 1}` }));
      take(...pins);
      doc.parts.push({ id: `p${doc.nextId++}`, def: def.id, pins });
      col += def.pins / 2 + 7;
    }
  }

  let leds = 0;
  const ledColors = ['led-red', 'led-green', 'led-yellow', 'led-blue'];
  for (const b of doc.boards) {
    for (let c = 0; c < COLUMNS - 1 && leds < 100; c += 4) {
      const pins = [
        { board: b.id, hole: `a${c + 1}` },
        { board: b.id, hole: `a${c + 2}` },
      ];
      if (!free(...pins)) continue;
      take(...pins);
      doc.parts.push({ id: `p${doc.nextId++}`, def: ledColors[leds++ % 4], pins });
    }
  }

  const spec = boardSpec('bb830');
  let wires = 0;
  for (let guard = 0; wires < 500 && guard < 50000; guard++) {
    const board = doc.boards[Math.floor(rnd() * doc.boards.length)];
    const start = spec.holes[Math.floor(rnd() * spec.holes.length)];
    const col = Math.max(0, Math.min(COLUMNS - 1, start.col + Math.round((rnd() - 0.5) * 24)));
    const a = { board: board.id, hole: start.name };
    const b = { board: board.id, hole: `${TERMINAL_ROWS[Math.floor(rnd() * 10)]}${col + 1}` };
    if (a.hole === b.hole || !free(a, b)) continue;
    take(a, b);
    doc.wires.push({ id: `w${doc.nextId++}`, a, b, color: WIRE_COLORS[Math.floor(rnd() * WIRE_COLORS.length)] });
    wires++;
  }

  const t0 = performance.now();
  store.replace(doc);
  const buildMs = Math.round(performance.now() - t0);
  view.fit(sync.boardsBox(), false);
  const frame = await view.measure(4000);
  return { ...frame, buildMs, boards: doc.boards.length, chips: doc.parts.length - leds, leds, wires };
}
