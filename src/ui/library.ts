// The parts panel: a section dropdown and a search box over tiles in sections, with Recent at the top.
// Clicking a tile picks the part up (one per pick, then it's selected and you're back to normal);
// dragging a tile out drops it where it's let go.

import type { Tools } from '../app/tools/tools';
import type { BoardType } from '../engine/breadboard';
import { PARTS, type LedColor, type PartDef } from '../engine/parts';
import { CATALOGUE, SECTIONS, type Section } from './catalogue';
import { $ } from './dom';
import { closeMenus } from './menus';
import { pictureSVG, type PictureName } from './pictures';
import { readJson, writeJson } from './settings';

const RECENT_MAX = 6;

/** What picking a tile brings out. */
type Pick =
  | { kind: 'part'; def: () => PartDef }
  | { kind: 'board'; type: BoardType }
  | { kind: 'desk'; what: 'supply' | 'meter' | 'scope' }
  | { kind: 'probe' };

interface Entry {
  id: string;
  name: string;
  sub: string;
  section: Section;
  pic: PictureName | { chip: string; pins: number };
  keywords: string;
  pick: Pick;
}

export class Library {
  /** The colour the LED tile places; it follows the last colour picked for an LED. */
  ledColor: LedColor = 'red';

  private readonly list = $('#plist');
  private readonly search = $<HTMLInputElement>('#q');
  private readonly entries: Entry[] = [];
  private section: 'All parts' | Section = 'All parts';
  private recent: string[] = [];
  private activeKey = '';
  /** A drag just ended on a tile: its click isn't a pick. */
  private dragged = false;

  constructor(private readonly tools: Tools) {
    this.buildEntries();
    this.recent = this.readRecent();
    this.renderSections();
    this.render();
    this.search.addEventListener('input', () => this.render());
    this.search.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.search.blur();
    });
    this.list.addEventListener('click', (e) => {
      const tile = (e.target as Element).closest<HTMLElement>('.tile');
      if (!tile || this.dragged) return;
      const entry = this.entries.find((x) => x.id === tile.dataset.part);
      if (entry) this.pick(entry, this.isActive(entry));
    });
    this.list.addEventListener('pointerdown', (e) => {
      const tile = (e.target as Element).closest<HTMLElement>('.tile');
      const entry = tile && this.entries.find((x) => x.id === tile.dataset.part);
      // A finger on the list scrolls it; a tap picks the part up.
      if (entry && e.button === 0 && e.pointerType !== 'touch') this.dragOut(entry, e);
    });
    $('#menu-cat').addEventListener('click', (e) => {
      const b = (e.target as Element).closest<HTMLElement>('[data-cat]');
      if (!b) return;
      this.section = b.dataset.cat as Section;
      $('#cat-l').textContent = this.section;
      this.search.value = '';
      this.renderSections();
      this.render();
      this.list.scrollTop = 0;
      closeMenus();
    });
  }

  /** Lights the tile of whatever is being placed or carried. */
  refresh(): void {
    const key = this.entries.find((x) => this.isActive(x))?.id ?? '';
    if (key === this.activeKey) return;
    this.activeKey = key;
    this.list.querySelectorAll<HTMLElement>('.tile').forEach((t) => t.classList.toggle('on', t.dataset.part === key));
  }

  focusSearch(): void {
    this.search.focus();
    this.search.select();
  }

  /** The tile picture of a part, for the ghost dragged out. */
  private picture(entry: Entry): string {
    return pictureSVG(entry.pic);
  }

  /** The panel's tiles, from the catalogue the phone app shares. */
  private buildEntries(): void {
    for (const c of CATALOGUE) {
      const p = c.pick;
      const pick: Pick =
        p.kind === 'part'
          ? { kind: 'part', def: () => PARTS[p.part] }
          : p.kind === 'led'
            ? { kind: 'part', def: () => PARTS[`led-${this.ledColor}`] }
            : p;
      this.entries.push({ ...c, pick });
    }
  }

  private isActive(e: Entry): boolean {
    const t = this.tools;
    switch (e.pick.kind) {
      case 'part': {
        const def = e.pick.def();
        if (!t.placing) return false;
        if (e.id === 'led') return t.placing.kind === 'led';
        // A tile stands for the kinds its card can switch between while placing.
        if (e.id === '7seg-cc') return t.placing.kind === 'display';
        return t.placing.id === def.id || SAME_TILE[t.placing.id] === e.id;
      }
      case 'board':
        return t.carryingBoard === e.pick.type;
      case 'desk':
        return t.carrying === e.pick.what;
      case 'probe':
        return t.mode === 'probe';
    }
  }

  /** Called when a part is picked up from the list. */
  onPick: () => void = () => {};

  /** Picks a tile's part up (or puts it back, if it's already in hand). */
  private pick(e: Entry, again: boolean): void {
    const t = this.tools;
    if (!again) this.onPick();
    if (again) {
      t.cancel();
      return;
    }
    this.addRecent(e.id);
    switch (e.pick.kind) {
      case 'part':
        return t.startPlacing(e.pick.def());
      case 'board':
        t.boardType = e.pick.type;
        return t.carry('board');
      case 'desk':
        return t.carry(e.pick.what);
      case 'probe':
        t.setMode('probe');
    }
  }

  private renderSections(): void {
    $('#menu-cat').innerHTML = ['All parts', ...SECTIONS]
      .map((n) => `<button class="mi${n === this.section ? ' cur' : ''}" data-cat="${n}">${n}</button>`)
      .join('');
  }

  private tileHTML(e: Entry): string {
    return `<button class="tile${this.isActive(e) ? ' on' : ''}" data-part="${e.id}">${this.picture(e)}<b>${e.name}</b><span>${e.sub}</span></button>`;
  }

  private render(): void {
    const q = this.search.value.trim().toLowerCase();
    let html = '';
    if (!q && this.section === 'All parts' && this.recent.length)
      html += `<div class="sect"><h3>Recent</h3><div class="grid">${this.recent
        .map((id) => this.entries.find((x) => x.id === id))
        .filter((x): x is Entry => !!x)
        .map((x) => this.tileHTML(x))
        .join('')}</div></div>`;
    for (const name of SECTIONS) {
      if (!q && this.section !== 'All parts' && this.section !== name) continue;
      const hits = this.entries.filter(
        (x) => x.section === name && (!q || `${x.name} ${x.sub} ${x.keywords}`.toLowerCase().includes(q)),
      );
      if (!hits.length) continue;
      html += `<div class="sect"><h3>${name}</h3><div class="grid">${hits.map((x) => this.tileHTML(x)).join('')}</div></div>`;
    }
    const safe = q.replace(/[<>&"]/g, '');
    this.list.innerHTML = html || `<div class="none">Nothing called “${safe}”</div>`;
    this.activeKey = '\0';
    this.refresh();
  }

  private readRecent(): string[] {
    const list = readJson('recentParts', []);
    if (!Array.isArray(list)) return [];
    // Earlier versions kept the part's id and value; a tile id or a part's id both find their tile.
    const ids = list
      .map((r: unknown) => (typeof r === 'string' ? r : r && typeof r === 'object' && 'def' in r ? String(r.def) : ''))
      .map((id) => (id.startsWith('led-') ? 'led' : id.startsWith('7seg-') ? '7seg-cc' : (SAME_TILE[id] ?? id)))
      .filter((id) => this.entries.some((x) => x.id === id));
    return [...new Set(ids)].slice(0, RECENT_MAX);
  }

  /** Recent fills in above the list; the list scrolls by the same amount so nothing you're looking at moves. */
  private addRecent(id: string): void {
    const next = [id, ...this.recent.filter((x) => x !== id)].slice(0, RECENT_MAX);
    if (next.join() === this.recent.join()) return;
    this.recent = next;
    writeJson('recentParts', this.recent);
    const h = this.list.scrollHeight;
    this.render();
    const d = this.list.scrollHeight - h;
    if (d > 0) this.list.scrollTop += d;
  }

  /** Pressing a tile and dragging brings its part out onto the desk; a plain click still picks it up. */
  private dragOut(e: Entry, down: PointerEvent): void {
    const canvas = $('#viewport');
    const ghost = $('#ghost');
    const over = (ev: PointerEvent): boolean => document.elementFromPoint(ev.clientX, ev.clientY) === canvas;
    let dragging = false;
    const t = this.tools;
    const move = (ev: PointerEvent): void => {
      if (!dragging) {
        if (Math.hypot(ev.clientX - down.clientX, ev.clientY - down.clientY) < 6) return;
        dragging = true;
        document.body.classList.add('dragging');
        ghost.innerHTML = this.picture(e);
        this.addRecent(e.id);
        switch (e.pick.kind) {
          case 'part':
            t.beginDragIn(e.pick.def());
            break;
          case 'board':
            t.boardType = e.pick.type;
            t.beginDragIn('board');
            break;
          case 'desk':
            t.beginDragIn(e.pick.what);
            break;
          case 'probe':
            t.setMode('probe');
        }
      }
      // Over the 3D view the part itself shows where it'll go; elsewhere a picture follows the pointer.
      const inside = over(ev);
      ghost.classList.toggle('show', !inside);
      ghost.style.left = `${ev.clientX}px`;
      ghost.style.top = `${ev.clientY}px`;
      t.moveDragIn(ev, inside);
    };
    const up = (ev: PointerEvent): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (!dragging) return;
      this.dragged = true;
      window.setTimeout(() => (this.dragged = false), 0);
      document.body.classList.remove('dragging');
      ghost.classList.remove('show');
      if (e.pick.kind === 'probe') t.dropProbe(over(ev) ? ev : null);
      else t.endDragIn(ev, over(ev));
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }
}

/** Parts whose card switches between them while placing, and the tile they share. */
export const SAME_TILE: Record<string, string> = {
  '1N4007': '1N4148',
  '2N2222': '2N3904',
  'dip-switch-4': 'dip-switch-8',
  '7seg-ca': '7seg-cc',
};
