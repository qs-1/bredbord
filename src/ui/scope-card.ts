// The oscilloscope's card: its screen, Run/Stop, Single and Auto, the time base, each channel on or off
// with its scale, the trigger, and a folded Measurements table.

import type { ScopeDoc } from '../engine/circuit';
import {
  DEFAULT_TRIGGER,
  formatFrequency,
  formatTime,
  formatVolts,
  SCOPE_TIMEBASES,
  SCOPE_VOLTS_PER_DIV,
  type Measurements,
} from '../engine/scope';
import { checkbox, choice, numberField, select, valueSelect, type Card, type InspectorDeps } from './card';
import { el, setText } from './dom';

const MEASUREMENTS: readonly [string, (m: Measurements) => string][] = [
  ['Frequency', (m) => formatFrequency(m.frequency)],
  ['Period', (m) => (Number.isFinite(m.period) ? formatTime(m.period) : 'None')],
  ['Peak to peak', (m) => formatVolts(m.pp)],
  ['Average', (m) => formatVolts(m.mean)],
  ['Duty', (m) => (Number.isFinite(m.duty) ? `${Math.round(m.duty * 100)} %` : 'None')],
];

/** CH1 yellow and CH2 cyan, as on the scope's own screen. */
const CHANNEL_CSS = ['#f0d33a', '#4fc3d9'];

/**
 * Fills the card. Returns a function that stops copying the scope's screen, to call when the card
 * goes, or null if there's no screen to copy.
 */
export function scopeCard(deps: InspectorDeps, scope: ScopeDoc, card: Card): (() => void) | null {
  const { tools: t, sync, sim } = deps;
  const id = scope.id;

  const screen = el('canvas', 'screen');
  const source = sync.scopes.screen(id);
  let stop: (() => void) | null = null;
  if (source) {
    screen.width = source.width;
    screen.height = source.height;
    const copy = (): void => void screen.getContext('2d')?.drawImage(source, 0, 0);
    copy();
    sync.scopes.onDraw(id, copy);
    stop = () => sync.scopes.onDraw(id, null);
  }
  card.body.append(screen);

  const buttons = el('div', 'grp cardgrp');
  const run = el('button');
  run.addEventListener('click', () => t.pressScope(id, 'run'));
  const single = el('button', '', 'Single');
  single.addEventListener('click', () => t.pressScope(id, 'single'));
  const auto = el('button', '', 'Auto');
  auto.dataset.tip = 'Pick settings that show what’s on the inputs';
  auto.addEventListener('click', () => t.pressScope(id, 'auto'));
  buttons.append(run, single, auto);
  const runLabel = (): void => setText(run, sync.scopes.runState(id) === 'run' ? 'Stop' : 'Run');
  runLabel();
  card.live(runLabel);
  card.body.append(buttons);

  card.row(
    'Time',
    valueSelect(
      SCOPE_TIMEBASES,
      scope.timebase,
      (v) => `${formatTime(v / 10)} a division`,
      (v) => t.setScope(id, { timebase: v }),
    ),
  );

  for (const ch of [1, 2] as const) {
    const off = ch === 1 ? scope.off1 : scope.off2;
    const perDiv = ch === 1 ? scope.voltsPerDiv : (scope.voltsPerDiv2 ?? scope.voltsPerDiv);
    const row = el('div', 'chrow');
    const sw = el('span', 'chs');
    sw.style.background = CHANNEL_CSS[ch - 1];
    row.append(
      sw,
      valueSelect(
        SCOPE_VOLTS_PER_DIV,
        perDiv,
        (v) => `${formatVolts(v)} a division`,
        (v) => t.setScope(id, ch === 1 ? { voltsPerDiv: v } : { voltsPerDiv2: v }),
      ),
    );
    card.row(
      checkbox(!off, `Channel ${ch}`, (on) => t.setScope(id, ch === 1 ? { off1: !on } : { off2: !on })),
      row,
    );
  }

  const trigger = scope.trigger ?? DEFAULT_TRIGGER;
  card.row(
    'Trigger on',
    select(
      [
        ['CH1', 'Channel 1'],
        ['CH2', 'Channel 2'],
      ],
      trigger.source,
      (v) => t.setScope(id, { trigger: { source: v } }),
      'Trigger on',
    ),
  );
  card.row(
    'Edge',
    choice(
      [
        ['rise', 'Rising'],
        ['fall', 'Falling'],
      ],
      trigger.edge,
      (v) => t.setScope(id, { trigger: { edge: v } }),
    ),
  );
  const level = numberField(
    card.live,
    () => t.scopeLevel(id),
    { min: -40, max: 40, step: 0.1, unit: 'V', label: 'Trigger level' },
    (v) => t.setScope(id, { trigger: { level: v } }),
  );
  const middle = el('button', 'btn', '50 %');
  middle.dataset.tip = 'Set the level to the middle of the signal';
  middle.addEventListener('click', () => t.pressScope(id, 'level'));
  level.append(middle);
  card.row('Level', level);
  card.row(
    'No trigger',
    choice(
      [
        ['auto', 'Keep drawing'],
        ['normal', 'Wait'],
      ],
      trigger.mode === 'normal' ? 'normal' : 'auto',
      (v) => t.setScope(id, { trigger: { mode: v } }),
    ),
  );

  card.fold('Position and coupling', (into) => {
    for (const ch of [1, 2] as const) {
      const head = el('div', 'chhead');
      const sw = el('span', 'chs');
      sw.style.background = CHANNEL_CSS[ch - 1];
      head.append(sw, document.createTextNode(`Channel ${ch}`));
      into.append(head);
      card.row(
        'Position',
        numberField(
          card.live,
          () => (ch === 1 ? scope.offset1 : scope.offset2) ?? 0,
          { min: -4, max: 4, step: 0.2, unit: 'div', label: `Channel ${ch} position` },
          (v) => t.setScope(id, ch === 1 ? { offset1: v } : { offset2: v }),
        ),
        into,
      );
      const ac = !!(ch === 1 ? scope.ac1 : scope.ac2);
      card.row(
        'Coupling',
        choice(
          [
            ['dc', 'DC'],
            ['ac', 'AC'],
          ],
          ac ? 'ac' : 'dc',
          (v) => t.setScope(id, ch === 1 ? { ac1: v === 'ac' } : { ac2: v === 'ac' }),
        ),
        into,
      );
    }
  });

  card.fold('Measurements', (into) => {
    const table = el('table', 'meas');
    const head = el('tr');
    head.append(el('th'), el('th', '', 'Channel 1'), el('th', '', 'Channel 2'));
    table.append(head);
    const cells: [0 | 1, HTMLElement, (m: Measurements) => string][] = [];
    for (const [name, read] of MEASUREMENTS) {
      const tr = el('tr');
      tr.append(el('td', '', name));
      for (const ch of [0, 1] as const) {
        const td = el('td', '', 'None');
        tr.append(td);
        cells.push([ch, td, read]);
      }
      table.append(tr);
    }
    const off = el('div', 'note', 'Turn the power on to measure');
    into.append(table, off);
    const update = (): void => {
      off.hidden = sim.isOn;
      table.hidden = !sim.isOn;
      const m = sync.scopes.measurements(id);
      for (const [ch, cell, read] of cells) {
        const x = m?.[ch === 0 ? 'CH1' : 'CH2'];
        setText(cell, x ? read(x) : 'None');
      }
    };
    update();
    card.live(update);
  });
  return stop;
}
