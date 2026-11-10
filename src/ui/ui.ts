// Everything around the 3D view: the two bars and their menus, the camera buttons, the empty desk,
// the hint and toast, and the "save first?" popup. The parts panel, the selection card, the dock, the
// Code panel, the problems button, hover info and the Hold buttons have modules of their own; this
// wires them up and refreshes them all when anything changes.

import { EXAMPLES } from '../app/example';
import type { SceneSync } from '../app/scene-sync';
import type { Simulation } from '../app/simulation';
import type { Store } from '../app/store';
import type { Tools } from '../app/tools/tools';
import { emptyDoc, WIRE_COLORS, type CircuitDoc } from '../engine/circuit';
import { readDoc } from '../engine/document';
import { PARTS } from '../engine/parts';
import type { View } from '../view/view';
import { CodePanel } from './codepanel';
import { Dock } from './dock';
import { whileBusy } from '../loading';
import { $, capitalise, download, el, safeFileName, setText } from './dom';
import { HoldChips } from './hold-chips';
import { HoverCard } from './hover';
import { Inspector, WIRE_CSS } from './inspector';
import { Issues } from './issues';
import { Library } from './library';
import { closeMenus, installMenus, openSub } from './menus';
import { logoSVG, paintIcons, snapPixels, wireIcon } from './px';
import { SelectionBar } from './selection-bar';
import { readFlag, readSetting, writeFlag, writeSetting } from './settings';
import { TagLayer } from './tags';

/** The phone layout is on (see app/index.html). */
const PHONE = document.documentElement.classList.contains('phone');

/** The biggest real circuit is a few hundred KB; reading something far larger would hang the page. */
const MAX_FILE_BYTES = 20e6;
const PANEL_WIDTH = 296;
const CODE_WIDTH = 480;

/** A speed the circuit really runs at, in two figures: 0.42, 0.081, 0.0035. */
const formatSpeed = (x: number): string => (x >= 0.1 ? x.toFixed(2) : String(Number(x.toPrecision(2))));

/** Circuit time with four digits whatever it is (9.999 s, 99.99 s, 999.9 s), so the clock keeps one width. */
function formatClock(t: number): string {
  return `${t < 10 ? t.toFixed(3) : t < 100 ? t.toFixed(2) : t < 1000 ? t.toFixed(1) : Math.round(t)} s`;
}

export class UI {
  private readonly library: Library;
  private readonly inspector: Inspector;
  private readonly issues: Issues;
  private readonly holdChips: HoldChips;
  private readonly tagLayer: TagLayer;
  private readonly hover: HoverCard;
  private readonly selectionBar: SelectionBar;
  private readonly dock: Dock;
  private readonly code: CodePanel;
  private toastTimer = 0;
  private faded = false;
  /** The circuit can't keep up with the speed asked for. */
  private behind = false;
  /** What to do once the "save first?" popup is answered. */
  private asked: (() => void) | null = null;

  constructor(
    private readonly store: Store,
    private readonly tools: Tools,
    private readonly view: View,
    private readonly sync: SceneSync,
    private readonly sim: Simulation,
  ) {
    snapPixels();
    installMenus();
    logoSVG($('#logo') as unknown as SVGSVGElement);
    paintIcons();
    this.graphicsPreviews();

    tools.snapping = readFlag('snapping', true);
    tools.pinNames = readFlag('pinNames', false);
    tools.magnifier = readFlag('magnifier', true);
    this.tagLayer = new TagLayer($('#tags'), view);
    this.library = new Library(tools);
    this.code = new CodePanel(
      store,
      sim,
      (id) => this.inspector.pickFile('firmware', id),
      () => this.refresh(),
    );
    this.dock = new Dock(store, sync, sim, tools);
    this.inspector = new Inspector(
      {
        store,
        tools,
        sim,
        sync,
        toast: (m) => this.toast(m),
        openCode: (id) => this.code.open(id),
        showBus: () => this.dock.show('bus'),
      },
      (color) => (this.library.ledColor = color),
    );
    this.issues = new Issues(store, tools, sim);
    this.holdChips = new HoldChips(tools, sim, sync, view);
    this.hover = new HoverCard(store, tools, sync, sim);
    this.selectionBar = new SelectionBar(tools, view);

    this.bindBar1();
    this.bindMenu();
    this.bindBar2();
    this.bindDesk();
    this.bindKeys();
    this.bindAsk();
    // The logo goes back to the landing page, offering to save first like New does. Opening it in
    // a new tab leaves this one as it is, so that needs no asking.
    $('#home').addEventListener('click', (e) => {
      if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      // A moment's wait, so a file being saved isn't cut off by leaving the page.
      this.saveFirst('home', () => setTimeout(() => location.assign('/'), 300));
    });
    this.setFaded(readFlag('fadeWires', false));
    this.setGraphics(readSetting('wireQuality') === 'fast' ? 'low' : 'high', false);
    this.view.lowResWhileMoving = false;

    tools.toast = (message) => this.toast(message);
    tools.onChange(() => this.refresh());
    store.subscribe(() => this.refresh());
    sim.onChange(() => this.refresh());
    sim.onFrame(() => this.refreshClock());
    view.onCameraChange(() => this.syncViewButtons());
    this.refresh();
    this.syncViewButtons();

    // Autosave problems are worth reading, so these stay up longer than the usual note.
    store.onSaveFailed = () =>
      this.toast('Couldn’t save in this browser: its storage is full or blocked. Save to file keeps your work', 12000);
    if (store.loadProblem)
      this.toast(
        `${store.loadProblem}. It’s kept as it was, so changes aren’t saved in the browser until you start a new circuit or open one`,
        15000,
      );
    if (location.hash.includes('debug')) this.startPerfReadout();
  }

  // ---- bar 1: the name, running, the menu ----

  private bindBar1(): void {
    const name = $<HTMLInputElement>('#name');
    const fit = (): void => void (name.style.width = `${Math.max(60, Math.min(320, name.value.length * 8 + 20))}px`);
    name.addEventListener('input', fit);
    name.addEventListener('change', () => {
      const value = name.value.trim();
      this.store.update((doc) => {
        doc.name = value || undefined;
      });
    });
    name.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === 'Escape') name.blur();
    });
    name.addEventListener('blur', () => {
      name.value = this.store.doc.name ?? 'Untitled circuit';
      fit();
    });

    $('#power').addEventListener('click', () => this.tools.toggleRunning());
    $('#pause').addEventListener('click', () => this.tools.togglePause());
    $('#step').addEventListener('click', () => this.tools.step());
    document.querySelectorAll<HTMLButtonElement>('[data-speed]').forEach((b) =>
      b.addEventListener('click', () => {
        this.sim.timeScale = Number(b.dataset.speed);
        this.refresh();
      }),
    );
  }

  private bindMenu(): void {
    for (const list of [$('#menu-examples'), $('#menu-ex')]) {
      for (const example of EXAMPLES) {
        const b = el('button', 'mi', example.title);
        b.setAttribute('role', 'menuitem');
        b.addEventListener('click', () => {
          closeMenus();
          this.saveFirst('example', () => this.openExample(example), example.title);
        });
        list.append(b);
      }
    }
    document.querySelectorAll<HTMLElement>('[data-file]').forEach((b) =>
      b.addEventListener('click', () => {
        closeMenus();
        const what = b.dataset.file;
        if (what === 'new') this.saveFirst('new', () => this.newCircuit());
        else if (what === 'open') this.saveFirst('open', () => $<HTMLInputElement>('#import-file').click());
        else this.saveToFile();
      }),
    );
    const picker = $<HTMLInputElement>('#import-file');
    picker.addEventListener('change', () => {
      const file = picker.files?.[0];
      picker.value = '';
      if (file) this.openFile(file);
    });
    document
      .querySelectorAll<HTMLButtonElement>('[data-gfx]')
      .forEach((b) => b.addEventListener('click', () => this.setGraphics(b.dataset.gfx === 'low' ? 'low' : 'high')));
    $('#set-magnifier').addEventListener('click', () => {
      this.tools.magnifier = !this.tools.magnifier;
      writeFlag('magnifier', this.tools.magnifier);
      this.syncChecks();
    });
    $('[data-check="names"]').addEventListener('click', () => {
      this.tools.pinNames = !this.tools.pinNames;
      writeFlag('pinNames', this.tools.pinNames);
      this.syncChecks();
      this.tools.restyle();
    });
    this.syncChecks();
  }

  private bindBar2(): void {
    const swatches = $('#swatches');
    WIRE_COLORS.forEach((c, i) => {
      const b = el('button', 'swb');
      b.dataset.color = c;
      b.dataset.tip = capitalise(c);
      b.dataset.key = String(i + 1);
      b.setAttribute('aria-label', capitalise(c));
      const sw = el('span', 'swatch');
      sw.style.background = WIRE_CSS[c];
      b.append(sw, el('small', '', String(i + 1)));
      b.addEventListener('click', () => {
        this.tools.setWireColor(c);
        closeMenus();
      });
      swatches.append(b);
    });
    $('[data-check="fade"]').addEventListener('click', () => this.setFaded(!this.faded));
    $('#t-rotate').addEventListener('click', () => this.tools.rotate());
    $('#t-delete').addEventListener('click', () => this.tools.deleteSelection());
    $('#t-undo').addEventListener('click', () => this.store.undo());
    $('#t-redo').addEventListener('click', () => this.store.redo());
    $('#t-wire').addEventListener('click', () => this.tools.toggleWireTool());
    $('#t-select').addEventListener('click', () => (this.tools.selecting = !this.tools.selecting));
    $('#snap').addEventListener('click', () => {
      this.tools.snapping = !this.tools.snapping;
      writeFlag('snapping', this.tools.snapping);
      this.refresh();
    });
    $('#code').addEventListener('click', () => this.code.toggle());
  }

  // ---- the desk ----

  private bindDesk(): void {
    $('#fit').addEventListener('click', () => this.view.fit(this.sync.boardsBox()));
    $('#zoom-in').addEventListener('click', () => this.view.zoom(0.7));
    $('#zoom-out').addEventListener('click', () => this.view.zoom(1 / 0.7));
    document
      .querySelectorAll<HTMLButtonElement>('[data-view]')
      .forEach((b) => b.addEventListener('click', () => this.view.setTopView(b.dataset.view === 'top')));
    $('#hint-x').addEventListener('click', (e) => {
      e.stopPropagation();
      this.tools.cancel();
    });

    const work = $('#work');
    const fold = $('#fold');
    const syncFold = (): void => {
      const closed = work.classList.contains('collapsed');
      fold.dataset.tip = closed ? 'Show parts' : 'Hide parts';
      fold.setAttribute('aria-label', fold.dataset.tip);
    };
    if (PHONE || document.documentElement.classList.contains('panel-closed')) work.classList.add('collapsed');
    fold.addEventListener('click', () => {
      if (PHONE) return;
      const closed = work.classList.toggle('collapsed');
      writeSetting('panel', closed ? 'closed' : 'open');
      syncFold();
    });
    syncFold();
    if (PHONE) this.bindPhone(work);

    // The parts or Code panel lies over the right of the view: framing (F, Home) centres in what's
    // left of it.
    this.view.coveredBottom = () => parseFloat(getComputedStyle(work).getPropertyValue('--dh')) || 0;
    // Only the side panel counts; the selection card is ignored (owner).
    this.view.coveredRight = () =>
      PHONE ? 0 : this.code.isOpen ? CODE_WIDTH : work.classList.contains('collapsed') ? 0 : PANEL_WIDTH;
  }

  /** The phone layout: the parts list and the card as sheets from the bottom, and the More menu. */
  private bindPhone(work: HTMLElement): void {
    const parts = $('#parts');
    const setOpen = (open: boolean): void => {
      work.classList.toggle('collapsed', !open);
      $('#t-parts').classList.toggle('on', open);
      $('#t-parts').setAttribute('aria-pressed', String(open));
    };
    $('#t-parts').addEventListener('click', () => {
      if (this.code.isOpen) this.code.close();
      setOpen(work.classList.contains('collapsed'));
    });
    this.library.onPick = () => setOpen(false);
    // The handle: dragged, it sets the sheet's height; tapped, it closes the sheet.
    const fold = $('#fold');
    fold.addEventListener('pointerdown', (e) => {
      const top = work.getBoundingClientRect();
      let moved = false;
      fold.setPointerCapture(e.pointerId);
      const move = (ev: PointerEvent): void => {
        if (!moved && Math.abs(ev.clientY - e.clientY) < 6) return;
        moved = true;
        const share = (top.bottom - ev.clientY) / top.height;
        parts.style.setProperty('--sheet', `${Math.round(Math.min(0.95, Math.max(0.25, share)) * 100)}%`);
      };
      const up = (): void => {
        fold.removeEventListener('pointermove', move);
        fold.removeEventListener('pointerup', up);
        fold.removeEventListener('pointercancel', up);
        if (!moved) setOpen(false);
      };
      fold.addEventListener('pointermove', move);
      fold.addEventListener('pointerup', up);
      fold.addEventListener('pointercancel', up);
    });
    // A tap on the card's header (not on a button in it) makes the card taller, or short again.
    const card = $('#card');
    card.addEventListener('click', (e) => {
      const t = e.target as Element;
      if (t.closest('.hd') && !t.closest('button, input, select, a')) card.classList.toggle('tall');
    });
    $('#menu-more').addEventListener('click', (e) => {
      const item = (e.target as Element).closest<HTMLElement>('[data-more]');
      if (!item) return;
      closeMenus();
      $<HTMLButtonElement>(`#${item.dataset.more}`).click();
    });
  }

  private bindKeys(): void {
    window.addEventListener('keydown', (e) => {
      if ($('#ask').classList.contains('open')) return;
      const target = e.target as HTMLElement | null;
      const typing = !!target?.closest?.('input, select, textarea, [contenteditable]');
      if (e.key === 'Escape' && typing) {
        target?.blur();
        return;
      }
      const k = e.key.toLowerCase();
      if ((e.ctrlKey || e.metaKey) && !e.altKey && (k === 's' || k === 'o')) {
        e.preventDefault();
        closeMenus();
        if (k === 's') this.saveToFile();
        else this.saveFirst('open', () => $<HTMLInputElement>('#import-file').click());
        return;
      }
      if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === '/') {
        e.preventDefault();
        if (this.code.isOpen) this.code.close();
        $('#work').classList.remove('collapsed');
        this.library.focusSearch();
      } else if (e.key === '?') {
        closeMenus();
        $('#menu-main').classList.add('open');
        $('[data-menu=main]').setAttribute('aria-expanded', 'true');
        openSub($('#sub-keys'));
      }
    });
    // Drop focus after clicking a control so the shortcuts keep going to the workbench.
    document.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest?.('button');
      if (b && !b.classList.contains('dd')) b.blur();
    });
  }

  // ---- settings ----

  private graphicsPreviews(): void {
    const hole = (x: number, y: number): string =>
      `<rect x="${x - 2}" y="${y - 2}" width="4" height="4" rx="1" fill="#45423d" opacity=".55"/>`;
    const holes = Array.from({ length: 11 }, (_, i) => hole(14 + i * 9.2, 35)).join('');
    const board = `<rect x="6" y="26" width="108" height="18" rx="3" fill="#f9f8f4" stroke="#d6d1c6"/>`;
    const d = 'M23 35Q60 -6 97 35';
    $('#gfx-high').innerHTML =
      board +
      holes +
      `<path d="M24 38Q61 0 98 38" stroke="rgba(31,29,26,.18)" stroke-width="5" fill="none" stroke-linecap="round"/><path d="${d}" stroke="#a52820" stroke-width="5.2" fill="none" stroke-linecap="round"/><path d="${d}" stroke="#e2362a" stroke-width="3.6" fill="none" stroke-linecap="round"/>`;
    // Low: the same wire on a coarse grid of square cells, no outline, no shadow.
    let px = '';
    const seen = new Set<string>();
    for (let i = 0; i <= 60; i++) {
      const t = i / 60;
      const x = (1 - t) * (1 - t) * 23 + 2 * (1 - t) * t * 60 + t * t * 97;
      const y = (1 - t) * (1 - t) * 35 + 2 * (1 - t) * t * -6 + t * t * 35;
      const gx = Math.round(x / 4) * 4;
      const gy = Math.round(y / 4) * 4;
      const k = `${gx},${gy}`;
      if (seen.has(k)) continue;
      seen.add(k);
      px += `<rect x="${gx - 2}" y="${gy - 2}" width="4" height="4" fill="#e2362a"/>`;
    }
    $('#gfx-low').innerHTML =
      `<rect x="6" y="26" width="108" height="18" fill="#f9f8f4" stroke="#d6d1c6"/>` +
      Array.from(
        { length: 11 },
        (_, i) => `<rect x="${12 + i * 9.2}" y="33" width="4" height="4" fill="#45423d" opacity=".55"/>`,
      ).join('') +
      px;
  }

  /** Graphics: High draws smooth wires, Low simpler ones for older computers. */
  private setGraphics(g: 'high' | 'low', save = true): void {
    this.sync.wires.setQuality(g === 'low' ? 'fast' : 'smooth');
    document.querySelectorAll<HTMLButtonElement>('[data-gfx]').forEach((b) => {
      const on = b.dataset.gfx === g;
      b.classList.toggle('on', on);
      b.setAttribute('aria-checked', String(on));
    });
    if (save) writeSetting('wireQuality', g === 'low' ? 'fast' : 'smooth');
    this.view.invalidateShadows();
  }

  private setFaded(on: boolean): void {
    this.faded = on;
    if (this.sync.wires.setFaded(on)) this.view.invalidateShadows();
    this.view.invalidate();
    writeFlag('fadeWires', on);
    this.syncChecks();
  }

  private syncChecks(): void {
    $('[data-check="fade"]').setAttribute('aria-checked', String(this.faded));
    $('[data-check="names"]').setAttribute('aria-checked', String(!this.tools.pinNames));
    $('#set-magnifier').setAttribute('aria-checked', String(this.tools.magnifier));
    $('[data-more="set-magnifier"]').setAttribute('aria-checked', String(this.tools.magnifier));
  }

  // ---- files and examples ----

  private hasSomething(doc: CircuitDoc = this.store.doc): boolean {
    return !!(
      doc.boards.length ||
      doc.parts.length ||
      doc.wires.length ||
      doc.supplies?.length ||
      doc.meters?.length ||
      doc.scopes?.length
    );
  }

  /**
   * New circuit, Open file and the examples replace what's on the desk. The app keeps one circuit in the
   * browser, so they offer to save it to a file first.
   */
  private saveFirst(what: 'new' | 'open' | 'example' | 'home', then: () => void, name = ''): void {
    if (!this.hasSomething() || !this.store.changed) return then();
    const n = this.store.doc.name?.trim() || 'Untitled circuit';
    setText($('#ask-t'), `Save “${n}” first?`);
    setText(
      $('#ask-p'),
      what === 'new'
        ? 'A new circuit starts on an empty desk. Anything you haven’t saved to a file is lost.'
        : what === 'home'
          ? 'It stays in this browser and will be here when you come back, but only a file keeps it safe.'
          : what === 'open'
            ? 'The file you open takes the place of this circuit. Anything you haven’t saved to a file is lost.'
            : `The “${name}” example takes the place of this circuit. Anything you haven’t saved to a file is lost.`,
    );
    this.asked = then;
    $('#ask').classList.add('open');
    $<HTMLButtonElement>('#ask [data-ask=save]').focus();
  }

  private bindAsk(): void {
    const ask = $('#ask');
    const close = (): void => {
      this.asked = null;
      ask.classList.remove('open');
    };
    ask.addEventListener('click', (e) => {
      const b = (e.target as Element).closest<HTMLElement>('[data-ask]');
      if (!b) {
        if (e.target === ask) close();
        return;
      }
      const then = this.asked;
      close();
      if (b.dataset.ask === 'save') {
        this.saveToFile();
        then?.();
      } else if (b.dataset.ask === 'drop') then?.();
    });
    window.addEventListener(
      'keydown',
      (e) => {
        if (!ask.classList.contains('open')) return;
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopImmediatePropagation();
          close();
        } else if (e.key === 'Tab') {
          const f = [...ask.querySelectorAll<HTMLButtonElement>('button')];
          const i = f.indexOf(document.activeElement as HTMLButtonElement);
          e.preventDefault();
          f[(i + (e.shiftKey ? f.length - 1 : 1)) % f.length].focus();
        }
      },
      true,
    );
  }

  private newCircuit(): void {
    this.tools.powerOff();
    this.store.replace(emptyDoc());
    this.view.fit(this.sync.boardsBox());
    this.toast('New circuit');
  }

  /** Puts another circuit on the desk; a big one takes a moment to build, so the loader covers the desk. */
  private swapIn(doc: CircuitDoc): Promise<void> {
    this.tools.powerOff();
    return whileBusy($('#desk'), 'Opening the circuit', () => {
      this.store.replace(doc);
      this.view.fit(this.sync.boardsBox());
    });
  }

  private openExample(example: (typeof EXAMPLES)[number]): void {
    void Promise.resolve(example.make()).then(
      (doc) => this.swapIn(doc),
      () => this.toast('Couldn’t load that example. Check the connection and try again'),
    );
  }

  private saveToFile(): void {
    const doc = this.store.doc;
    const json = JSON.stringify(doc, null, 2);
    download(`${safeFileName(doc.name, 'circuit')}.breadboard.json`, new Blob([json], { type: 'application/json' }));
    this.store.markSaved();
  }

  private openFile(file: File): void {
    if (file.size > MAX_FILE_BYTES) {
      this.toast('That file is too big to be a breadboard circuit');
      return;
    }
    file
      .text()
      .then((text) => {
        const read = readDoc(JSON.parse(text));
        if ('error' in read) {
          this.toast(read.error);
          return;
        }
        void this.swapIn(read.doc).then(() => this.toast([`Opened ${file.name}`, ...read.notes].join('. ')));
      })
      .catch(() => this.toast('That file isn’t a breadboard circuit'));
  }

  // ---- refresh ----

  private refresh(): void {
    this.holdChips.refresh();
    this.tagLayer.update(this.tools.tags);
    this.library.refresh();
    this.refreshTools();
    this.refreshRun();
    this.issues.refresh();
    this.hover.refresh();
    this.code.refresh();
    $('#code').classList.toggle('on', this.code.isOpen);
    const name = $<HTMLInputElement>('#name');
    if (document.activeElement !== name) {
      name.value = this.store.doc.name ?? 'Untitled circuit';
      name.style.width = `${Math.max(60, Math.min(320, name.value.length * 8 + 20))}px`;
    }
    const empty = $('#empty');
    empty.hidden = this.hasSomething();
    empty.classList.toggle('faded', this.tools.bringingIn || !!this.tools.placing);
    this.refreshHint();
    this.inspector.refresh();
    this.selectionBar.refresh();
  }

  private refreshTools(): void {
    const t = this.tools;
    const doc = this.store.doc;
    $<HTMLButtonElement>('#t-undo').disabled = !this.store.canUndo;
    $<HTMLButtonElement>('#t-redo').disabled = !this.store.canRedo;
    $<HTMLButtonElement>('#t-delete').disabled = !t.selection && !t.group.length;
    const sel = t.selection;
    const part = sel?.kind === 'part' ? doc.parts.find((p) => p.id === sel.id) : undefined;
    const board = sel?.kind === 'board' ? doc.boards.find((b) => b.id === sel.id) : undefined;
    const placing = t.placing?.kind;
    const groupParts = t.group.some((g) => {
      const p = g.kind === 'part' ? doc.parts.find((x) => x.id === g.id) : undefined;
      return p && PARTS[p.def]?.kind !== 'power';
    });
    $<HTMLButtonElement>('#t-rotate').disabled = !(
      groupParts ||
      (part && PARTS[part.def]?.kind !== 'power') ||
      (board && board.type.startsWith('strip')) ||
      (placing && placing !== 'power') ||
      t.carryingBoard?.startsWith('strip')
    );
    const selectBtn = $('#t-select');
    selectBtn.classList.toggle('on', t.selecting);
    selectBtn.setAttribute('aria-pressed', String(t.selecting));
    if (PHONE) {
      for (const id of ['pause', 'step']) {
        const item = $<HTMLButtonElement>(`[data-more="${id}"]`);
        item.disabled = $<HTMLButtonElement>(`#${id}`).disabled;
        item.lastChild!.textContent = $(`#${id}`).textContent!.trim();
      }
      $('[data-more="snap"]').setAttribute('aria-checked', String(t.snapping));
    }
    const wireBtn = $('#t-wire');
    wireBtn.classList.toggle('on', t.mode === 'wire');
    wireBtn.setAttribute('aria-pressed', String(t.mode === 'wire'));
    const snap = $('#snap');
    snap.classList.toggle('on', t.snapping);
    snap.setAttribute('aria-pressed', String(t.snapping));

    const wire = sel?.kind === 'wire' ? doc.wires.find((w) => w.id === sel.id) : undefined;
    const color = wire?.color ?? t.wireColor;
    const ic = $('#wire-ic');
    if (ic.dataset.color !== color) {
      ic.dataset.color = color;
      ic.innerHTML = wireIcon(WIRE_CSS[color]);
    }
    document.querySelectorAll<HTMLElement>('.swb').forEach((b) => b.classList.toggle('on', b.dataset.color === color));
  }

  /** Power, Pause, Step, and the clock with its speed. */
  private refreshRun(): void {
    const sim = this.sim;
    const on = sim.isOn;
    $('#app').classList.toggle('running', on);
    const power = $('#power');
    setText($('#power-l'), on ? 'Power off' : 'Power on');
    power.dataset.tip = on ? 'Turn the circuit off' : 'Turn the circuit on';
    const paused = on && sim.isPaused;
    const pause = $<HTMLButtonElement>('#pause');
    pause.disabled = !on;
    pause.classList.toggle('on', paused);
    pause.dataset.tip = paused ? 'Carry on' : 'Pause';
    $<HTMLButtonElement>('#step').disabled = !paused;
    const scale = sim.timeScale;
    const clock = $('#clock');
    // Too busy to keep up: on below 80 % of the speed asked for, off again above 90 %, so it doesn't flicker.
    this.behind = on && !paused && sim.speed < (this.behind ? 0.9 : 0.8);
    clock.classList.toggle('slow', scale !== 1 && !this.behind);
    clock.classList.toggle('behind', this.behind);
    let short = '';
    document.querySelectorAll<HTMLElement>('[data-speed]').forEach((b) => {
      const cur = Number(b.dataset.speed) === scale;
      b.setAttribute('aria-checked', String(cur));
      if (cur) short = b.dataset.short ?? '';
    });
    const real = scale * sim.speed;
    setText($('#speed-l'), this.behind ? `${formatSpeed(real)}×` : short);
    const behind = $('#behind');
    behind.hidden = !this.behind;
    if (this.behind)
      setText(behind, `The circuit is too busy to keep up. It runs at about ${Math.round(sim.speed * 100)} % of this.`);
    clock.dataset.tip = this.behind ? 'Running slower than asked' : 'Circuit time and speed';
    this.refreshClock();
  }

  private refreshClock(): void {
    setText($('#time'), formatClock(this.sim.isOn ? this.sim.sincePowerOn : 0));
  }

  /** The hint bar while something is under way, with Cancel; why a spot won't do takes its place. */
  private refreshHint(): void {
    const t = this.tools;
    const text = t.notice || t.task;
    const hint = $('#hint');
    hint.classList.toggle('show', !!text);
    if (text) setText($('#hint-t'), text);
  }

  private syncViewButtons(): void {
    const top = this.view.isTopView();
    document.querySelectorAll<HTMLButtonElement>('[data-view]').forEach((b) => {
      const on = (b.dataset.view === 'top') === top;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
    });
  }

  toast(message: string, ms = 2400): void {
    const node = $('#toast');
    node.textContent = message;
    node.classList.add('show');
    window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => node.classList.remove('show'), ms);
  }

  /** Frame rate, draw calls and triangles in a corner, with #debug on the address. */
  private startPerfReadout(): void {
    const node = $('#perf');
    node.hidden = false;
    window.setInterval(() => {
      const s = this.view.stats;
      const live = performance.now() - s.lastRender < 700 && s.fps > 0;
      setText(
        node,
        `${live ? `${Math.round(s.fps)} fps` : 'idle'}, ${s.calls} draws, ${Math.round(s.triangles / 1000)}k triangles`,
      );
    }, 500);
  }
}
