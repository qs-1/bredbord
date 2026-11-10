// The parts panel: a section dropdown and a search box over tiles in sections, with Recent at the top.
// Clicking a tile picks the part up (one per pick, then it's selected and you're back to normal);
// dragging a tile out drops it where it's let go.

import type { Tools } from '../app/tools/tools';
import type { BoardType } from '../engine/breadboard';
import { PART_LIST, PARTS, type LedColor, type PartDef } from '../engine/parts';
import { $ } from './dom';
import { closeMenus } from './menus';
import { pictureSVG, type PictureName } from './pictures';
import { readJson, writeJson } from './settings';

const SECTIONS = [
  'Boards and power',
  'Instruments',
  'Basics',
  'Switches and displays',
  'Logic chips',
  'Memory and CPU',
] as const;
type Section = (typeof SECTIONS)[number];

/** Short descriptions for the chip tiles, in the panel's words. */
const CHIP_SUB: Record<string, string> = {
  '74LS00': '4 NAND gates',
  '74LS02': '4 NOR gates',
  '74LS04': '6 inverters',
  '74LS08': '4 AND gates',
  '74LS10': '3 NAND gates, 3 inputs',
  '74LS11': '3 AND gates, 3 inputs',
  '74LS14': '6 Schmitt inverters',
  '74LS27': '3 NOR gates, 3 inputs',
  '74LS32': '4 OR gates',
  '74LS86': '4 XOR gates',
  '74LS74': '2 flip-flops',
  '74LS76': '2 JK flip-flops',
  '74LS107': '2 JK flip-flops',
  '74LS138': '3-to-8 decoder',
  '74LS139': '2 2-to-4 decoders',
  '74LS47': '7-segment decoder',
  '74LS125': '4 tri-state buffers',
  '74LS157': '4 2-to-1 switches',
  '74LS161': '4-bit counter',
  '74LS193': 'Up and down counter',
  '74LS173': '4-bit register',
  '74LS245': 'Bus buffer',
  '74LS273': '8-bit register',
  '74LS283': '4-bit adder',
  '74HC595': 'Shift register',
  NE555: 'Timer',
  W65C02S: '6502 processor',
  AT28C256: '32K EEPROM',
  '62256': '32K RAM',
  '28C16': '2K EEPROM',
  '74LS189': '64-bit RAM',
};
const MEMORY_ORDER = ['W65C02S', 'AT28C256', '62256', '28C16', '74LS189'];

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

const RECENT_MAX = 6;

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

  private add(e: Omit<Entry, 'keywords'> & { keywords?: string }): void {
    this.entries.push({ keywords: '', ...e });
  }

  private part(id: string, name: string, sub: string, section: Section, pic: Entry['pic'], keywords = ''): void {
    const def = PARTS[id];
    if (!def) return;
    this.add({ id, name, sub, section, pic, keywords, pick: { kind: 'part', def: () => def } });
  }

  private buildEntries(): void {
    const board = (id: string, type: BoardType, name: string, sub: string, pic: PictureName, keywords: string): void =>
      this.add({ id, name, sub, section: 'Boards and power', pic, keywords, pick: { kind: 'board', type } });
    board('bb', 'bb830', 'Breadboard', '830 holes', 'bb', 'bb830 full');
    board('bb-bare', 'core-bb830', 'Breadboard without rails', '630 holes', 'core', 'bb830 630 bare core no rails');
    board('half', 'bb400', 'Half breadboard', '400 holes', 'half', 'bb400');
    board('mini', 'mini', 'Mini breadboard', '170 holes', 'mini', 'small');
    board('rail', 'strip-bb830-top', 'Power rail', '+ and −', 'rail', 'bus strip');
    this.part('power', 'Power module', '5 V or 3.3 V', 'Boards and power', 'pmod', 'usb mb102');
    const desk = (
      what: 'supply' | 'meter' | 'scope',
      name: string,
      sub: string,
      section: Section,
      pic: PictureName,
      keywords: string,
    ) => this.add({ id: what, name, sub, section, pic, keywords, pick: { kind: 'desk', what } });
    desk('supply', 'Bench supply', '0 to 30 V', 'Boards and power', 'bench', 'power psu');
    this.add({
      id: 'probe',
      name: 'Probe',
      sub: 'Watch one hole',
      section: 'Instruments',
      pic: 'probe',
      keywords: 'logic analyser analyzer',
      pick: { kind: 'probe' },
    });
    desk('meter', 'Multimeter', 'Volts, ohms, amps', 'Instruments', 'meter', 'voltmeter ammeter dmm continuity');
    desk('scope', 'Oscilloscope', '2 channels', 'Instruments', 'scope', 'scope');

    this.part('resistor', 'Resistor', 'Any value', 'Basics', 'res', 'ohm');
    this.add({
      id: 'led',
      name: 'LED',
      sub: '3 or 5 mm',
      section: 'Basics',
      pic: 'led',
      keywords: 'light diode',
      pick: { kind: 'part', def: () => PARTS[`led-${this.ledColor}`] },
    });
    this.part('cap-ceramic', 'Capacitor', 'Ceramic', 'Basics', 'cer', 'disc');
    this.part('cap-electrolytic', 'Capacitor', 'Electrolytic', 'Basics', 'elec', 'polarised polarized');
    this.part('1N4148', 'Diode', '1N4148, 1N4007', 'Basics', 'diode', 'signal rectifier 1n4007');
    this.part('2N3904', 'Transistor', 'NPN', 'Basics', 'npn', 'bjt 2n3904 2n2222');
    this.part('2N3906', 'Transistor', 'PNP', 'Basics', 'pnp', 'bjt 2n3906');
    this.part('pot', 'Potentiometer', 'Knob', 'Basics', 'pot', 'variable resistor trimmer');
    this.part('resistor-network', 'Resistor network', '8 resistors', 'Basics', 'network', 'sip array bussed');

    this.part('button', 'Push button', 'Press to close', 'Switches and displays', 'push', 'tactile momentary');
    this.part('slide-switch', 'Slide switch', 'On or off', 'Switches and displays', 'slide', 'toggle spdt');
    this.part('dip-switch-8', 'DIP switch', '4 or 8 switches', 'Switches and displays', 'dip', '');
    this.part('7seg-cc', '7-segment', 'One digit', 'Switches and displays', 'seg7', 'seven segment display');
    this.part('bargraph', 'LED bar graph', '10 segments', 'Switches and displays', 'bar', 'array');
    this.part('lcd-1602', 'LCD', '16 × 2 characters', 'Switches and displays', 'lcd', 'character display 1602 hd44780');

    const chips = PART_LIST.filter((d): d is Extract<PartDef, { kind: 'dip' }> => d.kind === 'dip');
    for (const d of chips.filter((c) => !MEMORY_ORDER.includes(c.id)))
      this.part(d.id, d.id, CHIP_SUB[d.id] ?? d.subtitle, 'Logic chips', { chip: d.id, pins: d.pins }, d.subtitle);
    for (const id of MEMORY_ORDER) {
      const d = PARTS[id];
      if (d?.kind === 'dip')
        this.part(
          id,
          d.id,
          CHIP_SUB[id] ?? d.subtitle,
          'Memory and CPU',
          { chip: d.id === 'W65C02S' ? '65C02' : d.id.replace('AT', ''), pins: d.pins },
          d.subtitle,
        );
    }
    this.part('nano', 'Arduino Nano', 'Runs sketches', 'Memory and CPU', 'nano', 'atmega328 arduino');
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
