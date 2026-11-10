// The dock along the bottom of the desk, over the 3D view: Probes, and Bus trace while a CPU is on the
// desk. It shows up with the first probe or CPU, collapses to its header rather than vanishing, and its
// top edge drags to make it taller.
//
// Probes: one lane per probe, high and low drawn as a line with the highs shaded, a loose input dashed
// through the middle, with the probe's hole and reading on the left. The cursor reads every lane; a click
// drops a marker to time things against. Scroll to zoom, drag to look back.

import { canvasFont } from '../fonts';
import type { SceneSync } from '../app/scene-sync';
import type { Simulation, Trace } from '../app/simulation';
import type { Store } from '../app/store';
import type { Tools } from '../app/tools/tools';
import { busRows, type BusViewMode } from '../engine/busview';
import { holeKey, type Id, type ProbeDoc } from '../engine/circuit';
import { CHIP_MODELS } from '../engine/sim/chips';
import { $, el, setText } from './dom';
import { levelOf } from './hover';
import { icon, paintIcons } from './px';
import { probeRef } from './refs';
import { readSetting, writeSetting } from './settings';

const RULER = 22;
const LANE = 40;
const MIN_SPAN = 1e-6;
const MAX_SPAN = 10;
const DRAG_START = 3;
const MIN_HEIGHT = 96;
const HEADER = 41;

/** A stretch of circuit time, short, in whatever unit suits it. */
export function formatSpan(t: number): string {
  const a = Math.abs(t);
  if (a === 0) return '0 s';
  if (a < 1e-6) return `${+(t * 1e9).toPrecision(3)} ns`;
  if (a < 1e-3) return `${+(t * 1e6).toPrecision(3)} µs`;
  if (a < 1) return `${+(t * 1e3).toPrecision(3)} ms`;
  return `${+t.toPrecision(4)} s`;
}

/** What a trace read at time `t` (NaN before it starts). */
function valueAt(trace: Trace, t: number): number {
  let lo = 0;
  let hi = trace.t.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (trace.t[mid] <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo > 0 ? trace.v[lo - 1] : NaN;
}

type Tab = 'probes' | 'bus';

export class Dock {
  private readonly root = $('#dock');
  private readonly work = $('#work');
  private readonly body = el('div', 'dbody');
  private readonly tools = el('div', 'dtools');
  private readonly busTab = el('button', 'dtab', 'Bus trace');
  private readonly probesTab = el('button', 'dtab', 'Probes');
  private readonly min = el('button', 'ib dmin');
  private tab: Tab = 'probes';
  private open = false;
  /** Opened from its button with nothing in it yet: stays until something shows up in it. */
  private byHand = false;
  private collapsed = false;
  private height = 184;
  private toolsKey = '';
  /** How many probes there were last time, to notice the last one going. */
  private lastProbes = 0;

  // ---- probes ----
  private readonly lanes = el('div', 'lanes');
  private readonly lcol = el('div', 'lcol');
  private readonly lsvg = el('div', 'lsvg');
  private readonly canvas = el('canvas');
  private readonly g = this.canvas.getContext('2d')!;
  private readonly labels: { value: HTMLElement }[] = [];
  private rowsKey = '';
  private span = 1;
  private frozenAt: number | null = null;
  private hoverX: number | null = null;
  private marker: number | null = null;
  private press: { x: number; end: number; moved: boolean } | null = null;
  private readonly empty = el('div', 'dempty');

  // ---- bus ----
  private busMode: BusViewMode = 'cycles';
  private busFrozen = false;
  private busCleared = -1;
  private busKey = '';
  private readonly table = el('table', 'bus');

  constructor(
    private readonly store: Store,
    private readonly sync: SceneSync,
    private readonly sim: Simulation,
    private readonly tool: Tools,
  ) {
    const grip = el('div', 'grip');
    const head = el('div', 'dhead');
    this.min.append(icon('chev', true));
    head.append(this.probesTab, this.busTab, this.tools, this.min);
    this.root.append(grip, head, this.body);
    this.lcol.append(el('div', 'lsp'));
    this.lsvg.append(this.canvas);
    this.lanes.append(this.lcol, this.lsvg);
    const h = Number(readSetting('dockHeight'));
    if (h >= MIN_HEIGHT) this.height = h;
    this.collapsed = readSetting('dockMin') === '1';

    this.probesTab.addEventListener('click', () => this.show('probes'));
    this.busTab.addEventListener('click', () => this.show('bus'));
    this.min.addEventListener('click', () => {
      this.collapsed = !this.collapsed;
      writeSetting('dockMin', this.collapsed ? '1' : '0');
      this.layout();
    });
    this.tools.addEventListener('click', (e) => {
      const b = (e.target as Element).closest<HTMLElement>('[data-dact]');
      if (!b) return;
      const k = b.dataset.dact;
      if (k === 'unmark') this.marker = null;
      else if (k === 'cycles' || k === 'instructions') this.busMode = k;
      else if (k === 'freeze') this.busFrozen = !this.busFrozen;
      else if (k === 'clear') this.busCleared = this.sim.time;
      this.busKey = '';
      this.draw();
    });
    grip.addEventListener('pointerdown', (e) => {
      const y0 = e.clientY;
      const h0 = this.height;
      const max = $('.deskcol').clientHeight - 180;
      grip.setPointerCapture(e.pointerId);
      document.body.classList.add('dragging');
      const move = (ev: PointerEvent): void => {
        this.height = Math.max(MIN_HEIGHT, Math.min(max, h0 + y0 - ev.clientY));
        this.layout();
      };
      const up = (): void => {
        grip.removeEventListener('pointermove', move);
        document.body.classList.remove('dragging');
        writeSetting('dockHeight', String(Math.round(this.height)));
      };
      grip.addEventListener('pointermove', move);
      grip.addEventListener('pointerup', up, { once: true });
    });
    this.listenLanes();
    new ResizeObserver(() => this.draw()).observe(this.body);
    store.subscribe(() => this.draw());
    sim.onChange(() => this.draw());
    sim.onFrame(() => this.draw());
    sim.onBreak((hit) => {
      const p = this.sim.probes.find((x) => x.id === hit.probe);
      if (p) this.tool.toast(`Paused: ${probeRef(this.store.doc, p.id)} went ${hit.edge === 'rise' ? 'high' : 'low'}`);
    });
    this.draw();
  }

  /** Opens the dock on a tab. */
  show(tab: Tab): void {
    this.tab = tab;
    this.open = true;
    this.byHand = true;
    this.collapsed = false;
    writeSetting('dockMin', '0');
    this.draw();
  }

  private get cpu(): Id | null {
    return this.store.doc.parts.find((p) => CHIP_MODELS[p.def]?.bus)?.id ?? null;
  }

  private layout(): void {
    const shown = this.open;
    this.root.hidden = !shown;
    this.root.classList.toggle('min', this.collapsed);
    this.root.style.height = `${this.height}px`;
    this.work.style.setProperty('--dh', shown ? `${this.collapsed ? HEADER : this.height}px` : '0px');
    this.min.dataset.tip = this.collapsed ? 'Expand' : 'Collapse';
    this.min.setAttribute('aria-label', this.min.dataset.tip);
    this.probesTab.classList.toggle('on', this.tab === 'probes');
    this.busTab.classList.toggle('on', this.tab === 'bus');
    this.busTab.hidden = !this.cpu;
  }

  private draw(): void {
    const cpu = this.cpu;
    const probes = this.sim.probes.length;
    // It appears with the first probe or CPU and goes when there's nothing left to show.
    if (probes || cpu) {
      this.byHand = false;
      if (!this.open) {
        this.open = true;
        if (!probes && cpu) this.tab = 'bus';
      }
    } else if (!this.byHand) this.open = false;
    if (this.tab === 'bus' && !cpu) this.tab = 'probes';
    // A circuit with a CPU and no probes opens on its bus.
    if (this.tab === 'probes' && !probes && cpu && this.lastProbes) this.tab = 'bus';
    this.lastProbes = probes;
    this.layout();
    if (!this.open) return;
    this.syncTools();
    if (this.collapsed) return;
    if (this.tab === 'bus') this.drawBus();
    else this.drawProbes();
  }

  private syncTools(): void {
    let html = '';
    if (!this.collapsed) {
      if (this.tab === 'probes')
        html =
          this.marker !== null
            ? `<span class="dnote">Marker at ${formatSpan(this.marker)}</span><div class="grp"><button class="txt" data-dact="unmark">Clear marker</button></div>`
            : this.sim.probes.length
              ? '<span class="dnote">Click the trace to drop a marker</span>'
              : '';
      else
        html = `<div class="grp"><button class="txt${this.busMode === 'cycles' ? ' on' : ''}" data-dact="cycles">Cycles</button><button class="txt${this.busMode === 'instructions' ? ' on' : ''}" data-dact="instructions">Instructions</button></div><div class="grp"><button class="txt${this.busFrozen ? ' on' : ''}" data-dact="freeze" aria-pressed="${this.busFrozen}">Freeze</button></div><div class="grp"><button class="txt" data-dact="clear">Clear</button></div>`;
    }
    if (html === this.toolsKey) return;
    this.toolsKey = html;
    this.tools.innerHTML = html;
  }

  // ---- bus trace ----

  private drawBus(): void {
    const cpu = this.cpu;
    const part = cpu ? this.store.doc.parts.find((p) => p.id === cpu) : undefined;
    if (!part) return;
    if (!this.sim.result.live) {
      this.setBody(this.empty);
      setText(this.empty, 'Turn the power on to see every bus cycle');
      return;
    }
    if (this.busFrozen && this.busKey) return;
    const log = this.sim.busOf(part) ?? [];
    const last = log[log.length - 1];
    const key = `${log.length}|${last?.t ?? 0}|${this.busMode}|${this.busCleared}`;
    if (key === this.busKey && this.body.firstChild === this.table) return;
    this.busKey = key;
    const rows = busRows(log, this.busMode, this.busCleared, 200);
    const stick = this.body.scrollTop + this.body.clientHeight >= this.body.scrollHeight - 4;
    const cycles = this.busMode === 'cycles';
    const head = cycles
      ? '<tr><th>Cycle</th><th>Address</th><th>Data</th><th>R/W</th><th>Instruction</th></tr>'
      : '<tr><th>Cycle</th><th>Address</th><th>Bytes</th><th>Instruction</th></tr>';
    this.table.innerHTML =
      `<thead>${head}</thead><tbody>` +
      rows
        .map((r) =>
          cycles
            ? `<tr class="${r.write ? 'w' : ''}"><td class="n">${r.cycle}</td><td>${r.addr}</td><td>${r.data}</td><td class="rw">${r.rw}</td><td>${r.text}</td></tr>`
            : `<tr><td class="n">${r.cycle}</td><td>${r.addr}</td><td>${r.data}</td><td>${r.text}</td></tr>`,
        )
        .join('') +
      '</tbody>';
    this.setBody(this.table);
    if (!rows.length) {
      this.setBody(this.empty);
      setText(this.empty, 'No cycles yet');
    } else if (stick || !this.busFrozen) this.body.scrollTop = this.body.scrollHeight;
  }

  private setBody(node: HTMLElement): void {
    if (this.body.firstChild !== node) this.body.replaceChildren(node);
  }

  // ---- probes ----

  private drawProbes(): void {
    const probes = this.sim.probes;
    if (!probes.length) {
      this.setBody(this.empty);
      setText(this.empty, 'No probes');
      return;
    }
    this.setBody(this.lanes);
    if (this.marker !== null && this.marker > this.sim.time) this.marker = null;
    if (this.frozenAt !== null && this.frozenAt > this.sim.time) this.frozenAt = null;
    this.syncRows(probes);
    const at = this.cursorTime();
    probes.forEach((p, i) => {
      const trace = this.sim.traces.get(p.id);
      const label = this.labels[i];
      if (!label) return;
      let text: string;
      if (!trace?.v.length) text = this.sim.isOn ? 'No voltage' : 'Nothing yet';
      else {
        const v = at !== null ? valueAt(trace, at) : trace.v[trace.v.length - 1];
        text = Number.isFinite(v) ? `${v.toFixed(2)} V, ${levelOf(v).words}` : 'Floating';
      }
      setText(label.value, text);
    });
    this.paint(probes);
  }

  /** One label per probe: its name, its hole on one line (cut short if it must), and its reading. */
  private syncRows(probes: readonly ProbeDoc[]): void {
    const key = probes.map((p) => `${p.id}@${holeKey(p.at)}`).join(';') + `|${this.store.doc.boards.length}`;
    if (key === this.rowsKey) return;
    this.rowsKey = key;
    this.labels.length = 0;
    this.lcol.replaceChildren(el('div', 'lsp'));
    for (const p of probes) {
      const row = el('div', 'lname');
      const text = el('div', 'lt');
      const top = el('div');
      const where = this.where(p.at);
      const hole = el('span', '', where);
      hole.title = where;
      top.append(el('b', '', probeRef(this.store.doc, p.id)), hole);
      const value = el('em');
      text.append(top, value);
      const remove = el('button', 'ib');
      remove.dataset.tip = 'Remove this probe';
      remove.setAttribute('aria-label', 'Remove this probe');
      remove.append(icon('close', true));
      remove.addEventListener('click', () => this.tool.removeProbe(p.id));
      row.append(text, remove);
      this.lcol.append(row);
      this.labels.push({ value });
    }
    paintIcons(this.lcol);
  }

  /** A probe's hole, as its lane is labelled. */
  private where(at: ProbeDoc['at']): string {
    const hole = this.sync.hole(at);
    const name = hole?.name ?? at.hole;
    const board =
      this.store.doc.boards.filter((b) => !b.on).length > 1 ? `Board ${this.sync.boardNumber(at.board)}, ` : '';
    if (hole?.kind === 'rail' && hole.rail)
      return `${board}${hole.rail[0] === 'T' ? 'top' : 'bottom'} ${hole.rail[1] === '+' ? '+' : '−'} rail, hole ${name.slice(2)}`;
    return `${board}hole ${name}`;
  }

  private get end(): number {
    return this.frozenAt ?? this.sim.time;
  }

  private cursorTime(): number | null {
    const w = this.canvas.clientWidth;
    if (this.hoverX === null || !w || this.press?.moved) return null;
    return this.end - this.span + (this.hoverX / w) * this.span;
  }

  private clampEnd(end: number): number {
    const now = this.sim.time;
    const oldest = Math.max(0, now - MAX_SPAN - 1);
    return Math.max(Math.min(now, oldest + this.span), Math.min(now, end));
  }

  private listenLanes(): void {
    const c = this.canvas;
    c.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const w = c.clientWidth;
        if (!w) return;
        const span = Math.max(MIN_SPAN, Math.min(MAX_SPAN, this.span * Math.exp(e.deltaY * 0.0015)));
        if (this.frozenAt === null && this.sim.isOn && !this.sim.isPaused) this.span = span;
        else {
          const t = this.end - this.span + (e.offsetX / w) * this.span;
          this.span = span;
          this.frozenAt = this.clampEnd(t + (1 - e.offsetX / w) * span);
        }
        this.draw();
      },
      { passive: false },
    );
    c.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      this.press = { x: e.clientX, end: this.end, moved: false };
      c.setPointerCapture(e.pointerId);
    });
    c.addEventListener('pointermove', (e) => {
      this.hoverX = e.offsetX;
      const p = this.press;
      if (p && (p.moved || Math.abs(e.clientX - p.x) > DRAG_START)) {
        p.moved = true;
        const end = p.end - ((e.clientX - p.x) / c.clientWidth) * this.span;
        if (end >= this.sim.time) {
          this.frozenAt = null;
          p.x = e.clientX;
          p.end = this.sim.time;
        } else this.frozenAt = this.clampEnd(end);
      }
      this.draw();
    });
    c.addEventListener('pointerup', () => {
      const p = this.press;
      this.press = null;
      if (!p || p.moved) return this.draw();
      const at = this.cursorTime();
      if (at === null) return;
      const near = this.marker !== null && Math.abs(((this.marker - at) / this.span) * c.clientWidth) < 5;
      this.marker = near ? null : at;
      this.draw();
    });
    c.addEventListener('pointerleave', () => {
      if (this.press) return;
      this.hoverX = null;
      this.draw();
    });
  }

  private paint(probes: readonly ProbeDoc[]): void {
    const ratio = window.devicePixelRatio || 1;
    const w = this.lsvg.clientWidth;
    const h = RULER + probes.length * LANE;
    if (!w) return;
    if (this.canvas.width !== Math.round(w * ratio) || this.canvas.height !== Math.round(h * ratio)) {
      this.canvas.width = Math.round(w * ratio);
      this.canvas.height = Math.round(h * ratio);
      this.canvas.style.height = `${h}px`;
    }
    const g = this.g;
    g.setTransform(ratio, 0, 0, ratio, 0, 0);
    g.clearRect(0, 0, w, h);
    const end = this.end;
    const start = end - this.span;
    const xOf = (t: number): number => ((t - start) / this.span) * w;

    // The time scale: no more than six ticks, at round numbers of circuit time.
    const steps = [1, 2, 5]
      .flatMap((m) => [-7, -6, -5, -4, -3, -2, -1, 0, 1].map((e) => m * 10 ** e))
      .sort((a, b) => a - b);
    const step = steps.find((s) => this.span / s <= 6) ?? 10;
    g.font = canvasFont('ui', 400, 11);
    g.textBaseline = 'alphabetic';
    for (let t = Math.ceil(start / step) * step; t <= end + 1e-12; t += step) {
      const x = Math.round(xOf(t)) + 0.5;
      g.fillStyle = 'rgba(31,29,26,.06)';
      g.fillRect(x - 0.5, 16, 1, h - 16);
      g.fillStyle = '#7b756b';
      if (t >= 0) g.fillText(formatSpan(+t.toPrecision(6)), x + 4, 15);
    }
    g.fillStyle = 'rgba(31,29,26,.10)';
    g.fillRect(0, RULER, w, 1);

    probes.forEach((p, i) => {
      const top = RULER + i * LANE;
      g.fillStyle = 'rgba(31,29,26,.10)';
      g.fillRect(0, top + LANE, w, 1);
      const trace = this.sim.traces.get(p.id);
      if (trace?.t.length) this.trace(trace, start, end, xOf, top + 9, top + 31, top + 20);
    });
    if (!this.sim.isOn && !probes.some((p) => this.sim.traces.get(p.id)?.t.length)) {
      g.font = canvasFont('ui', 400, 12.5);
      g.fillStyle = '#7b756b';
      g.textAlign = 'center';
      g.fillText('Turn the power on to see what each probe sees', w / 2, RULER + (probes.length * LANE) / 2 + 4);
      g.textAlign = 'start';
    }

    if (this.marker !== null) {
      const x = Math.round(xOf(this.marker)) + 0.5;
      if (x >= 0 && x <= w) {
        g.strokeStyle = '#1f1d1a';
        g.setLineDash([4, 3]);
        g.beginPath();
        g.moveTo(x, 0);
        g.lineTo(x, h);
        g.stroke();
        g.setLineDash([]);
        g.fillStyle = '#1f1d1a';
        g.beginPath();
        g.roundRect(x - 7, 2, 14, 14, 2);
        g.fill();
        g.fillStyle = '#fff';
        g.font = canvasFont('code', 400, 10);
        g.textAlign = 'center';
        g.fillText('M', x, 13);
        g.textAlign = 'start';
      }
    }
    const at = this.cursorTime();
    if (at === null) return;
    const x = Math.round(xOf(at)) + 0.5;
    g.fillStyle = '#7b756b';
    g.fillRect(x - 0.5, 0, 1, h);
    const label = formatSpan(at) + (this.marker !== null ? `, ${formatSpan(at - this.marker)} from M` : '');
    g.font = canvasFont('ui', 400, 11);
    const tw = g.measureText(label).width + 12;
    const lx = Math.min(x + 6, w - tw - 2);
    g.fillStyle = '#1f1d1a';
    g.beginPath();
    g.roundRect(lx, 2, tw, 16, 3);
    g.fill();
    g.fillStyle = '#fff';
    g.fillText(label, lx + 6, 14);
  }

  /** A lane: high at the top, low at the bottom, in between half way, highs shaded, loose dashed through the middle. */
  private trace(
    trace: Trace,
    start: number,
    end: number,
    xOf: (t: number) => number,
    yh: number,
    yl: number,
    ym: number,
  ): void {
    const g = this.g;
    const { t, v } = trace;
    const yOf = (x: number): number => (x >= 2 ? yh : x <= 0.8 ? yl : ym);
    let k = 0;
    while (k + 1 < t.length && t[k + 1] <= start) k++;
    if (t[k] > end) return;
    const loose: [number, number][] = [];
    g.fillStyle = 'rgba(31,29,26,.06)';
    for (let j = k; j < t.length && t[j] <= end; j++) {
      if (!(v[j] >= 2)) continue;
      const a = Math.max(0, xOf(t[j]));
      const b = Math.min(xOf(end), j + 1 < t.length ? xOf(t[j + 1]) : xOf(end));
      if (b > a) g.fillRect(a, yh, b - a, yl - yh);
    }
    g.strokeStyle = '#1f1d1a';
    g.lineWidth = 1.5;
    g.lineJoin = 'miter';
    g.beginPath();
    let drawing = false;
    let lastX = -Infinity;
    for (; k < t.length && t[k] <= end; k++) {
      const x0 = Math.max(0, xOf(t[k]));
      const x1 = Math.min(xOf(end), k + 1 < t.length ? xOf(t[k + 1]) : xOf(end));
      if (x1 < 0) continue;
      if (!Number.isFinite(v[k])) {
        loose.push([x0, x1]);
        drawing = false;
        continue;
      }
      const y = yOf(v[k]);
      if (!drawing) g.moveTo(x0, y);
      else g.lineTo(x0, y);
      if (x1 - lastX >= 0.5 || k + 1 >= t.length) g.lineTo(x1, y);
      lastX = x1;
      drawing = true;
    }
    g.stroke();
    if (!loose.length) return;
    g.strokeStyle = '#7b756b';
    g.setLineDash([3, 3]);
    g.beginPath();
    for (const [a, b] of loose) {
      g.moveTo(a, ym);
      g.lineTo(b, ym);
    }
    g.stroke();
    g.setLineDash([]);
  }
}
