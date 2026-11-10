// What the selection card's builders are handed, and the pieces a card is made of: rows of
// "label | control", notes, warnings, joined choice buttons, dropdowns, checkboxes and folds.

import type { SceneSync } from '../app/scene-sync';
import type { Simulation } from '../app/simulation';
import type { Store } from '../app/store';
import type { Tools } from '../app/tools/tools';
import type { Id } from '../engine/circuit';
import { el, setText } from './dom';
import { icon, pxSVG } from './px';
import { readJson, writeJson } from './settings';

export interface InspectorDeps {
  readonly store: Store;
  readonly tools: Tools;
  readonly sim: Simulation;
  readonly sync: SceneSync;
  toast(message: string): void;
  /** Opens the file picker for an EEPROM image or a Nano's firmware, to be loaded into part `id`. */
  pickFile(kind: 'rom' | 'firmware', id: Id): void;
  /** Opens the Code panel on this chip. */
  openCode(id: Id): void;
  /** Shows the dock's bus trace. */
  showBus(): void;
}

/** Registers something to run on every refresh while its card is up (readings that change as the circuit runs). */
export type Live = (update: () => void) => void;

/** A value and the text it's shown with. */
export type Option<V> = readonly [value: V, label: string];

/** The card being built: its body, and helpers that put rows into it. */
export class Card {
  constructor(
    readonly body: HTMLElement,
    readonly live: Live,
  ) {}

  row(label: string | HTMLElement, control: HTMLElement | string, into: HTMLElement = this.body): HTMLElement {
    const row = el('div', 'row');
    if (typeof label === 'string') row.append(el('span', '', label));
    else row.append(label);
    row.append(typeof control === 'string' ? el('span', 'val', control) : control);
    into.append(row);
    return row;
  }

  note(text: string, into: HTMLElement = this.body): HTMLElement {
    const n = el('div', 'note', text);
    into.append(n);
    return n;
  }

  /** A problem the simulator found with this part. */
  warn(text: string): void {
    const w = el('div', 'warn');
    w.append(icon('warn', true), el('span', '', text));
    this.body.append(w);
  }

  /** A row whose value changes as the circuit runs. */
  reading(label: string, read: () => string, into: HTMLElement = this.body): void {
    const out = el('span', 'val');
    const update = (): void => setText(out, read());
    update();
    this.live(update);
    this.row(label, out, into);
  }

  /** A fold: its title as a button, and what's under it, shown while it's open. Remembered by title. */
  fold(title: string, build: (into: HTMLElement) => void, openAtFirst = false): void {
    const all = readJson('folded', {}) as Record<string, boolean>;
    let open = typeof all === 'object' && all && title in all ? !all[title] : openAtFirst;
    const head = el('button', 'fold-h');
    head.append(icon('chevr', true), document.createTextNode(title));
    const body = el('div', 'fold-b');
    const show = (): void => {
      head.setAttribute('aria-expanded', String(open));
      body.hidden = !open;
    };
    head.addEventListener('click', () => {
      open = !open;
      const now = readJson('folded', {}) as Record<string, boolean>;
      writeJson('folded', { ...(typeof now === 'object' && now ? now : {}), [title]: !open });
      show();
    });
    build(body);
    show();
    this.body.append(head, body);
  }
}

/** Joined choice buttons, one of them pressed. */
export function choice<V extends string | number>(
  options: readonly Option<V>[],
  current: V,
  pick: (v: V) => void,
  disabled = false,
): HTMLElement {
  const group = el('div', 'grp cardgrp');
  for (const [v, label] of options) {
    const b = el('button', v === current ? 'on' : '', label);
    b.disabled = disabled && v !== current;
    b.addEventListener('click', () => {
      if (v !== current) pick(v);
    });
    group.append(b);
  }
  return group;
}

/** A dropdown, drawn as the page's own button and menu (menus.ts). */
export function select<V extends string | number>(
  options: readonly Option<V>[],
  current: V,
  pick: (v: V) => void,
  label = '',
): HTMLSelectElement {
  const s = el('select', 'sel');
  if (label) s.setAttribute('aria-label', label);
  for (const [v, text] of options) {
    const o = el('option', '', text);
    o.value = String(v);
    o.selected = v === current;
    s.append(o);
  }
  s.addEventListener('change', () => pick(options[s.selectedIndex][0]));
  return s;
}

/** A dropdown of standard values; a value off the list (from a file, say) is slotted in where it belongs. */
export function valueSelect(
  values: readonly number[],
  current: number,
  format: (v: number) => string,
  pick: (v: number) => void,
): HTMLSelectElement {
  const all = values.includes(current) ? values : [...values, current].sort((a, b) => a - b);
  return select(
    all.map((v) => [v, format(v)] as const),
    current,
    pick,
  );
}

/** A square checkbox with its label. */
export function checkbox(on: boolean, label: string | HTMLElement, toggle: (on: boolean) => void): HTMLButtonElement {
  const b = el('button', 'cb');
  b.setAttribute('role', 'checkbox');
  b.setAttribute('aria-checked', String(on));
  const box = el('i');
  box.innerHTML = pxSVG('check', '#fff');
  b.append(box, typeof label === 'string' ? document.createTextNode(label) : label);
  b.addEventListener('click', () => toggle(b.getAttribute('aria-checked') !== 'true'));
  return b;
}

/** A number box with its unit, kept in step with the value while it isn't being typed in. */
export function numberField(
  live: Live,
  read: () => number,
  range: { min: number; max: number; step: number; unit: string; label: string },
  set: (v: number) => void,
): HTMLElement {
  const wrap = el('div', 'pair');
  const input = el('input', 'inp');
  input.inputMode = 'decimal';
  input.setAttribute('aria-label', range.label);
  const update = (): void => {
    if (document.activeElement === input) return;
    const v = String(Math.round(read() * 100) / 100);
    if (input.value !== v) input.value = v;
  };
  update();
  live(update);
  const commit = (): void => {
    const v = Number(input.value.replace(',', '.'));
    if (Number.isFinite(v)) set(Math.min(range.max, Math.max(range.min, v)));
    update();
  };
  input.addEventListener('change', commit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') input.blur();
    if (e.key === 'Escape') {
      input.value = '';
      input.blur();
    }
  });
  input.addEventListener('blur', update);
  wrap.append(input);
  if (range.unit) wrap.append(el('span', 'unit', range.unit));
  return wrap;
}
