// Pointing at a hole for a moment shows a small card by the pointer: the hole's name, every leg and
// wire end in its strip (the holes joined inside the board), any probe on it, and while the power is
// on, its voltage and logic level.

import type { HoleHit, SceneSync } from '../app/scene-sync';
import type { Simulation } from '../app/simulation';
import type { Store } from '../app/store';
import type { Tools } from '../app/tools/tools';
import { describePin } from '../app/tools/describe';
import { boardSpec } from '../engine/breadboard';
import { holeKey, sameHole } from '../engine/circuit';
import { $, el } from './dom';
import { partRef, probeRef, wireRef } from './refs';

const DELAY_MS = 300;

/** A voltage's logic level, as a marker class and words. */
export function levelOf(v: number): { cls: string; words: string } {
  if (!Number.isFinite(v)) return { cls: 'loose', words: 'floating' };
  if (v >= 2) return { cls: 'hi', words: 'high' };
  if (v <= 0.8) return { cls: '', words: 'low' };
  return { cls: 'mid', words: 'in between' };
}

export class HoverCard {
  private readonly card = $('#hcard');
  private readonly desk = $('#desk');
  private hole = '';
  private timer = 0;
  private shown = false;
  private x = 0;
  private y = 0;
  private html = '';

  constructor(
    private readonly store: Store,
    private readonly tools: Tools,
    private readonly sync: SceneSync,
    private readonly sim: Simulation,
  ) {
    const canvas = $('#viewport');
    canvas.addEventListener('pointermove', (e) => {
      this.x = e.clientX;
      this.y = e.clientY;
      if (this.shown) this.place();
    });
    canvas.addEventListener('pointerleave', () => this.hide());
    canvas.addEventListener('pointerdown', () => this.hide());
  }

  refresh(): void {
    const h = this.tools.pointedHole;
    const key = h ? `${h.ref.board}|${h.ref.hole}` : '';
    if (key !== this.hole) {
      this.hide();
      this.hole = key;
      if (h) this.timer = window.setTimeout(() => this.show(), DELAY_MS);
      return;
    }
    if (this.shown && h && !this.fill(h)) this.hide();
  }

  private hide(): void {
    window.clearTimeout(this.timer);
    this.shown = false;
    this.hole = '';
    this.card.classList.remove('show');
  }

  private show(): void {
    const h = this.tools.pointedHole;
    if (!h || !this.fill(h)) return;
    this.shown = true;
    this.card.classList.add('show');
    this.place();
  }

  private place(): void {
    const d = this.desk.getBoundingClientRect();
    const c = this.card;
    let x = this.x - d.left + 16;
    let y = this.y - d.top + 18;
    if (x + c.offsetWidth > d.width - 8) x = this.x - d.left - c.offsetWidth - 12;
    if (y + c.offsetHeight > d.height - 8) y = this.y - d.top - c.offsetHeight - 12;
    c.style.left = `${x}px`;
    c.style.top = `${y}px`;
  }

  /** Fills in the card for a hole; false when there's nothing to say about it (an empty hole, power off). */
  private fill(h: HoleHit): boolean {
    const name = this.holeName(h);
    const connected = h.terminal ? [] : this.connected(h);
    if (!h.terminal && !connected.length && !this.sim.result.live) return false;
    const card = el('div');
    card.append(el('div', 'hn', name));
    if (!h.terminal) {
      if (connected.length) {
        card.append(el('div', 'hl', 'Connected to'));
        const ul = el('ul');
        for (const c of connected) ul.append(el('li', '', c));
        card.append(ul);
      }
    }
    if (this.sim.result.live) {
      const row = el('div', 'hv');
      const v = this.sim.result.volts(h.ref);
      if (v === null) row.append(el('span', 'mut', 'No voltage'));
      else {
        const lv = levelOf(v);
        row.append(
          el('span', `lv${lv.cls ? ` ${lv.cls}` : ''}`),
          document.createTextNode(Number.isFinite(v) ? `${v.toFixed(2)} V, ${lv.words}` : 'Floating, nothing sets it'),
        );
      }
      card.append(row);
    }
    const html = card.innerHTML;
    if (html === this.html) return true;
    this.html = html;
    this.card.innerHTML = html;
    return true;
  }

  private holeName(h: HoleHit): string {
    if (h.terminal) {
      const meter = this.sync.meter(h.ref.board);
      const scope = this.sync.scope(h.ref.board);
      const what = meter ? 'Multimeter' : scope ? 'Oscilloscope' : 'Bench supply';
      return `${what}, ${h.ref.hole} terminal`;
    }
    const doc = this.store.doc;
    const board = doc.boards.filter((b) => !b.on).length > 1 ? `Board ${this.sync.boardNumber(h.board.id)}, ` : '';
    const hole = h.hole;
    if (hole.kind === 'rail' && hole.rail) {
      const side = hole.rail[0] === 'T' ? 'Top' : 'Bottom';
      return `${board}${side} ${hole.rail[1] === '+' ? '+' : '−'} rail, hole ${hole.name.slice(2)}`;
    }
    return `${board}${hole.name}`;
  }

  /** Every leg, wire end and probe in the strip of holes joined to this one inside the board. */
  private connected(h: HoleHit): string[] {
    const doc = this.store.doc;
    const spec = boardSpec(h.board.type);
    const strip = spec.holes.filter((x) => x.group === h.hole.group).map((x) => ({ board: h.ref.board, hole: x.name }));
    const out: string[] = [];
    for (const ref of strip) {
      const occ = this.sync.occupancy.get(holeKey(ref));
      if (occ?.kind === 'part') {
        const part = doc.parts.find((p) => p.id === occ.id);
        if (part) out.push(`${partRef(doc, part.id)}, ${lower(describePin(part, occ.pin))}`);
      } else if (occ?.kind === 'wire') {
        const w = doc.wires.find((x) => x.id === occ.id);
        if (w) out.push(`${wireRef(doc, w.id)} (${w.color} wire)`);
      }
      for (const p of doc.probes ?? []) if (sameHole(p.at, ref)) out.push(`Probe ${probeRef(doc, p.id)}`);
    }
    return [...new Set(out)];
  }
}

/** "Red LED anode (+)" reads better as "red LED anode (+)" after a comma, but chip names keep their case. */
function lower(s: string): string {
  return /^[A-Z][a-z]/.test(s) ? s[0].toLowerCase() + s.slice(1) : s;
}
