// The selection card: a small card at the top right of the desk for what's selected, or for the part
// about to be placed. Its title and reference name, Rotate and Delete, then rows of settings and,
// while the circuit runs, live readings. Several things selected at once get no card.

import { isRailStrip, pieceOf, RAIL_HOLES, railStrip, type BoardType } from '../engine/breadboard';
import { WIRE_COLORS, type Id, type PartDoc } from '../engine/circuit';
import { meterDisplay, METER_MODES, MODE_NAMES } from '../engine/meter';
import {
  CERAMIC_VALUES,
  ELECTROLYTIC_VALUES,
  formatFarads,
  formatOhms,
  NETWORK_VALUES,
  PARTS,
  POT_VALUES,
  POWER_JUMPERS,
  powerJumper,
  displayId,
  resistorBands,
  SEGMENT_NAMES,
  SEGMENT_PINS,
  type CapacitorDef,
  type LedColor,
  type PartDef,
} from '../engine/parts';
import { benDisplayRom, benMicrocodeRom, countRom, hexDigitRom, nopRom, parseRomImage } from '../engine/roms';
import { CHIP_MODELS, GATE_LAYOUTS, type GateLayout } from '../engine/sim/chips';
import { CUSTOM_IMAGE, IMAGES, parseFirmwareHex, SKETCHES, sketchOf } from '../engine/sim/nano';
import { encodeBytes } from '../engine/sim/simulator';
import type { Store } from '../app/store';
import { Card, checkbox, choice, numberField, select, valueSelect, type InspectorDeps } from './card';
import { gatesDrawing } from './gates';
import { $, capitalise, download, el, hexDigits, safeFileName, setText } from './dom';
import { syncSelect } from './menus';
import { icon, paintIcons } from './px';
import { meterRef, nextRef, partRef, scopeRef, supplyRef, wireRef } from './refs';
import { scopeCard } from './scope-card';

/** The colours in the wire swatches, as the chrome draws them (the 3D wires are lit and shaded). */
export const WIRE_CSS: Record<(typeof WIRE_COLORS)[number], string> = {
  red: '#e2362a',
  black: '#262422',
  blue: '#2a62d8',
  yellow: '#f0c419',
  green: '#2fa84f',
  white: '#f2f1ee',
  orange: '#f07a1a',
  purple: '#8a4fd8',
};

const LED_COLORS: readonly LedColor[] = ['red', 'green', 'yellow', 'blue', 'white'];

/** Parts that get a card while being placed: the ones with something to choose, or pins to read. */
const CARD_WHILE_PLACING: ReadonlySet<PartDef['kind']> = new Set([
  'dip',
  'led',
  'resistor',
  'capacitor',
  'pot',
  'diode',
  'transistor',
  'display',
  'dipswitch',
  'nano',
  'network',
  'lcd',
]);

const BAND_CSS: Record<string, string> = {
  black: '#1c1c1c',
  brown: '#6b3a1e',
  red: '#c62a24',
  orange: '#e3701c',
  yellow: '#efc320',
  green: '#2c8f3a',
  blue: '#2958c7',
  violet: '#7d3fba',
  grey: '#8b8b8b',
  white: '#f1f1f1',
  gold: '#b99733',
  silver: '#babdc2',
};

/** What a chip does, in a sentence, for its card. */
const CHIP_NOTES: Record<string, string> = {
  '74LS00': 'Four 2-input NAND gates',
  '74LS02': 'Four 2-input NOR gates',
  '74LS04': 'Six inverters (NOT gates)',
  '74LS08': 'Four 2-input AND gates',
  '74LS10': 'Three 3-input NAND gates',
  '74LS11': 'Three 3-input AND gates',
  '74LS14': 'Six inverters with Schmitt-trigger inputs',
  '74LS27': 'Three 3-input NOR gates',
  '74LS32': 'Four 2-input OR gates',
  '74LS86': 'Four 2-input XOR gates',
  '74LS74': 'Two D flip-flops',
  '74LS76': 'Two JK flip-flops',
  '74LS107': 'Two JK flip-flops',
  '74LS138': 'A 3-to-8 line decoder',
  '74LS139': 'Two 2-to-4 line decoders',
  '74LS47': 'A BCD to 7-segment decoder, for common anode displays',
  '74LS125': 'Four buffers with tri-state outputs',
  '74LS157': 'Four 2-to-1 switches (multiplexers)',
  '74LS161': 'A 4-bit counter',
  '74LS193': 'A 4-bit up and down counter',
  '74LS173': 'A 4-bit register with tri-state outputs',
  '74LS245': 'An 8-bit bus buffer, both ways',
  '74LS273': 'An 8-bit register',
  '74LS283': 'A 4-bit adder',
  '74HC595': 'An 8-bit shift register with a latch',
  NE555: 'A timer, for clocks and delays',
  W65C02S: 'A 6502 processor',
  AT28C256: '32K EEPROM',
  '28C16': '2K EEPROM',
  '62256': '32K RAM',
  '74LS189': '64-bit RAM, 16 words of 4 bits, inverted outputs',
};

const ROM_PRESETS: Record<'small' | 'big', readonly { label: string; make: () => Uint8Array; done: string }[]> = {
  small: [
    { label: 'Decimal display (8-bit computer)', make: benDisplayRom, done: 'now holds the decimal display' },
    { label: 'Microcode (8-bit computer)', make: benMicrocodeRom, done: 'now holds the microcode' },
    { label: 'Hex digit', make: hexDigitRom, done: 'now holds the hex digit decoder' },
  ],
  big: [
    { label: 'Zero page counter (6502)', make: countRom, done: 'now holds the counter, reset vector $8000' },
    { label: 'All NOP', make: nopRom, done: 'now holds no-ops, reset vector $EAEA' },
  ],
};

const capacitorValues = (def: CapacitorDef): readonly number[] =>
  def.style === 'ceramic' ? CERAMIC_VALUES : ELECTROLYTIC_VALUES;

/** What a card is called, by the kind of thing on it. */
function partTitle(def: PartDef): string {
  switch (def.kind) {
    case 'dip':
      return def.id;
    case 'led':
      return 'LED';
    case 'capacitor':
      return 'Capacitor';
    case 'diode':
      return 'Diode';
    case 'transistor':
      return 'Transistor';
    case 'display':
      return '7-segment display';
    default:
      return def.title;
  }
}

const BOARD_TITLE: Partial<Record<BoardType, string>> = {
  bb830: 'Breadboard',
  'core-bb830': 'Breadboard',
  bb400: 'Half breadboard',
  mini: 'Mini breadboard',
};

export class Inspector {
  private readonly box = $('#card');
  /** What the card shows, as text: it's only rebuilt when this changes. */
  private key = '';
  /** Readings on the card that change while the circuit runs, updated in place. */
  private live: (() => void)[] = [];
  /** Stops the card copying a scope's screen, once the card goes. */
  private stopScope: (() => void) | null = null;
  private filePick: { kind: 'rom' | 'firmware'; id: Id } | null = null;
  /** Where each memory chip's hex view starts. */
  private readonly memFrom = new Map<Id, number>();
  private readonly deps: InspectorDeps;

  constructor(
    deps: Omit<InspectorDeps, 'pickFile'>,
    /** A colour was picked for an LED; the parts panel's LED tile follows it. */
    private readonly onLedColor: (color: LedColor) => void,
  ) {
    this.deps = { ...deps, pickFile: (kind, id) => this.pickFile(kind, id) };
    const picker = $<HTMLInputElement>('#rom-file');
    picker.addEventListener('change', () => {
      const file = picker.files?.[0];
      const target = this.filePick;
      picker.value = '';
      this.filePick = null;
      picker.setAttribute('accept', '.bin,.rom,.hex,application/octet-stream');
      if (!file || !target) return;
      const { store, toast } = this.deps;
      if (target.kind === 'firmware')
        loadFirmwareFile(store, target.id, file).then(toast, (error: unknown) =>
          toast(error instanceof Error ? error.message : 'Couldn’t read that Intel HEX file'),
        );
      else loadRomFile(store, target.id, file).then(toast, () => toast('Couldn’t read that file'));
    });
  }

  get isOpen(): boolean {
    return !!this.key;
  }

  /** Rebuilds the card if what it shows has changed, then brings its live readings up to date. */
  refresh(): void {
    const key = this.cardKey();
    if (key !== this.key) {
      this.key = key;
      this.build();
    }
    for (const update of this.live) update();
  }

  pickFile(kind: 'rom' | 'firmware', id: Id): void {
    this.filePick = { kind, id };
    const picker = $<HTMLInputElement>('#rom-file');
    if (kind === 'firmware') picker.setAttribute('accept', '.hex,text/plain');
    picker.click();
  }

  /**
   * Everything the card's layout depends on. Values that update in place (knob positions, readings,
   * a supply's settings) are left out, so typing into a field isn't interrupted by a rebuild.
   */
  private cardKey(): string {
    const { tools: t, store, sim } = this.deps;
    const doc = store.doc;
    const result = sim.result;
    if (t.mode === 'place' && t.placing)
      return CARD_WHILE_PLACING.has(t.placing.kind)
        ? `place|${t.placing.id}|${t.valueFor(t.placing)}|${doc.parts.length}`
        : '';
    if (t.group.length) return '';
    const sel = t.selection;
    if (!sel) return '';
    const live = result.live ? 'on' : 'off';
    switch (sel.kind) {
      case 'board': {
        const b = doc.boards.find((x) => x.id === sel.id);
        return b ? `board|${JSON.stringify(b)}|${doc.boards.length}` : '';
      }
      case 'supply': {
        const supply = doc.supplies?.find((x) => x.id === sel.id);
        if (!supply) return '';
        return `supply|${sel.id}|${!!supply.off}|${JSON.stringify(result.problems.filter((p) => p.partId === sel.id))}`;
      }
      case 'meter': {
        const meter = doc.meters?.find((x) => x.id === sel.id);
        return meter ? `meter|${sel.id}|${meter.mode}|${live}` : '';
      }
      case 'scope': {
        const scope = doc.scopes?.find((x) => x.id === sel.id);
        return scope ? `scope|${JSON.stringify(scope)}` : '';
      }
      case 'wire': {
        const wire = doc.wires.find((w) => w.id === sel.id);
        return wire ? `wire|${wire.id}|${wire.color}` : '';
      }
      case 'part': {
        const part = doc.parts.find((p) => p.id === sel.id);
        if (!part) return '';
        // A knob's position and a memory's bytes update in place.
        const shape = { ...part, data: undefined, ...(PARTS[part.def]?.kind === 'pot' ? { state: undefined } : {}) };
        const status = result.live
          ? JSON.stringify(result.problems.filter((p) => p.partId === sel.id).map((p) => p.message))
          : 'off';
        return `part|${JSON.stringify(shape)}|${status}|${sim.isOn}`;
      }
    }
  }

  private build(): void {
    this.live = [];
    // The pin rows go with the old card, and with them whatever leg was lit by pointing at one.
    this.deps.tools.pointCardPins(null);
    this.stopScope?.();
    this.stopScope = null;
    const box = this.box;
    box.replaceChildren();
    box.className = 'card';
    if (!this.key) return;
    const body = el('div', 'bd');
    const card = new Card(body, (update) => this.live.push(update));
    const { tools: t, store } = this.deps;
    const doc = store.doc;
    let size = '';

    if (t.mode === 'place' && t.placing) {
      const def = t.placing;
      this.header(partTitle(def), nextRef(doc, def), { rotate: turns(def), del: false });
      size = this.partBody(def, null, card);
    } else {
      const sel = t.selection!;
      switch (sel.kind) {
        case 'board':
          this.boardCard(sel.id, card);
          break;
        case 'supply':
          this.header('Bench supply', supplyRef(doc, sel.id), { rotate: false, del: true });
          this.supplyCard(sel.id, card);
          break;
        case 'meter':
          this.header('Multimeter', meterRef(doc, sel.id), { rotate: false, del: true });
          this.meterCard(sel.id, card);
          break;
        case 'scope': {
          this.header('Oscilloscope', scopeRef(doc, sel.id), { rotate: false, del: true });
          size = 'xwide';
          this.stopScope = scopeCard(
            this.deps,
            doc.scopes!.find((s) => s.id === sel.id)!,
            card,
          );
          break;
        }
        case 'wire': {
          const w = doc.wires.find((x) => x.id === sel.id)!;
          this.header('Wire', wireRef(doc, w.id), { rotate: false, del: true });
          const sw = el('div', 'wsw');
          WIRE_COLORS.forEach((c, i) => {
            const b = el('button', c === w.color ? 'on' : '');
            b.style.background = WIRE_CSS[c];
            b.dataset.tip = capitalise(c);
            b.dataset.key = String(i + 1);
            b.setAttribute('aria-label', capitalise(c));
            b.addEventListener('click', () => t.setWireColor(c));
            sw.append(b);
          });
          card.row('Colour', sw);
          break;
        }
        case 'part': {
          const part = doc.parts.find((p) => p.id === sel.id)!;
          const def = PARTS[part.def];
          this.header(partTitle(def), partRef(doc, part.id), { rotate: turns(def), del: true });
          size = this.partBody(def, part, card);
          for (const p of this.deps.sim.result.live ? this.deps.sim.result.problems : [])
            if (p.partId === part.id) card.warn(p.message);
          break;
        }
      }
    }
    // A card with nothing but its title isn't worth showing: Delete and R still work from the keys.
    if (!body.childElementCount) {
      box.replaceChildren();
      return;
    }
    box.append(body);
    box.className = `card open${size ? ` ${size}` : ''}`;
    paintIcons(box);
  }

  /** The title bar: what it is, its reference name, then Rotate and Delete. */
  private header(title: string, ref: string, buttons: { rotate: boolean; del: boolean }): void {
    const hd = el('div', 'hd');
    const tt = el('div', 'tt');
    tt.append(el('b', '', title));
    if (ref) tt.append(el('span', '', ref));
    hd.append(tt);
    const { tools } = this.deps;
    if (buttons.rotate) hd.append(this.headButton('rotate', 'Rotate', 'R', () => tools.rotate()));
    if (buttons.del) hd.append(this.headButton('trash', 'Delete', 'Del', () => tools.deleteSelection()));
    this.box.append(hd);
  }

  private headButton(ic: 'rotate' | 'trash', tip: string, key: string, run: () => void): HTMLButtonElement {
    const b = el('button', 'ib');
    b.dataset.tip = tip;
    b.dataset.key = key;
    b.setAttribute('aria-label', tip);
    b.append(icon(ic));
    b.addEventListener('click', run);
    return b;
  }

  private boardCard(id: Id, card: Card): void {
    const { store, tools, sync } = this.deps;
    const doc = store.doc;
    const type = doc.boards.find((b) => b.id === id)?.type ?? 'bb830';
    const name = isRailStrip(type) ? 'Power rail' : (BOARD_TITLE[type] ?? 'Breadboard');
    const n = doc.boards.filter((b) => !b.on).length;
    this.header(n > 1 && !isRailStrip(type) ? `${name} ${sync.boardNumber(id)}` : name, '', {
      rotate: !!railStrip(type),
      del: true,
    });
    const strip = railStrip(type);
    if (strip) {
      const steps: number[] = [];
      for (let h = RAIL_HOLES.min; h <= RAIL_HOLES.max; h += RAIL_HOLES.step) steps.push(h);
      card.row(
        'Holes a row',
        valueSelect(steps, strip.holes, String, (v) => tools.setRailHoles(id, v)),
      );
    }
    const piece = pieceOf(type);
    if (piece && piece.piece !== 'core' && piece.parent !== 'bb830-split') {
      card.row(
        'Size',
        choice(
          [
            [830, 'Full'],
            [400, 'Half'],
          ],
          piece.parent === 'bb400' ? 400 : 830,
          (v) => tools.setRailSize(id, v === 400 ? 'bb400' : 'bb830'),
        ),
      );
    }
    if (type === 'core-bb830') card.note('630 holes, with no power rails');
    else if (!strip) {
      const off = doc.boards.filter((b) => b.on === id).length;
      if (piece?.piece === 'core' && off < 2)
        card.note(off === 1 ? 'One power rail is off' : 'Its power rails are off');
    }
  }

  private supplyCard(id: Id, card: Card): void {
    const { store, tools, sim } = this.deps;
    const now = () => store.doc.supplies?.find((x) => x.id === id);
    card.row(
      'Voltage',
      numberField(
        card.live,
        () => now()?.volts ?? 0,
        { min: 0, max: 30, step: 0.1, unit: 'V', label: 'Voltage' },
        (v) => tools.setSupply(id, { volts: v }, true),
      ),
    );
    card.row(
      'Current limit',
      numberField(
        card.live,
        () => now()?.limit ?? 1,
        { min: 0.1, max: 5, step: 0.05, unit: 'A', label: 'Current limit' },
        (v) => tools.setSupply(id, { limit: v }, true),
      ),
    );
    card.row(
      '',
      checkbox(!now()?.off, 'Output on', (on) => tools.setSupply(id, { off: !on }, true)),
    );
    card.reading('Giving', () => {
      if (!sim.isOn || now()?.off) return 'Nothing';
      const r = sim.result.supplies.get(id);
      if (!r) return 'Its leads aren’t wired';
      const amps = r.amps < 1 ? `${(r.amps * 1000).toFixed(0)} mA` : `${r.amps.toFixed(2)} A`;
      return `${r.volts.toFixed(2)} V, ${amps}`;
    });
    for (const p of sim.result.problems) if (p.partId === id) card.warn(p.message);
  }

  private meterCard(id: Id, card: Card): void {
    const { store, tools, sim } = this.deps;
    const meter = store.doc.meters!.find((x) => x.id === id)!;
    const reading = el('div', `reading${meter.mode === 'off' ? ' off' : ''}`);
    const value = el('span');
    const unit = el('small');
    reading.append(value, unit);
    const update = (): void => {
      const m = store.doc.meters?.find((x) => x.id === id);
      if (!m || m.mode === 'off') {
        setText(value, 'Off');
        setText(unit, '');
        return;
      }
      const d = meterDisplay(m.mode, sim.meterInputs(m));
      setText(value, d ? d.text.trim() : '');
      setText(unit, d ? `${d.unit}${d.flags?.beep ? ', connected' : ''}` : '');
    };
    update();
    card.live(update);
    card.body.append(reading);
    card.row(
      'Mode',
      select(
        METER_MODES.map((mode) => [mode, MODE_NAMES[mode]] as const),
        meter.mode,
        (mode) => tools.setMeter(meter.id, mode),
        'Mode',
      ),
    );
    if ((meter.mode === 'acv' || meter.mode === 'hz') && !sim.isOn) card.note('Turn the power on to measure');
  }

  /** The rows for a part, selected (`part`) or about to be placed (`part` null). Returns the card's width. */
  private partBody(def: PartDef, part: PartDoc | null, card: Card): string {
    const { tools: t, sim } = this.deps;
    const live = !!part && sim.result.live;
    const value = part ? part.value : t.valueFor(def);
    switch (def.kind) {
      case 'dip':
        return this.chipBody(def, part, card);
      case 'led': {
        card.row(
          'Colour',
          select(
            LED_COLORS.map((c) => [c, capitalise(c)] as const),
            def.color,
            (c) => {
              this.onLedColor(c);
              t.setLedColor(c);
            },
            'Colour',
          ),
        );
        card.row(
          'Size',
          choice(
            [
              [3, '3 mm'],
              [5, '5 mm'],
            ],
            value ?? 5,
            (v) => t.setValue(v),
          ),
        );
        if (live && part)
          card.reading('Current', () => {
            const current = sim.result.leds.get(part.id)?.current ?? 0;
            return current > 1e-5 ? `${(current * 1000).toFixed(1)} mA` : 'Off';
          });
        return '';
      }
      case 'resistor':
        this.resistance(value ?? 470, card);
        return '';
      case 'network':
        card.note('Eight resistors with pin 1 common to all of them');
        card.row(
          'Resistance',
          valueSelect(NETWORK_VALUES, value ?? 1000, formatOhms, (v) => t.setValue(v)),
        );
        return '';
      case 'capacitor':
        card.row(
          'Capacitance',
          valueSelect(capacitorValues(def), value ?? 1e-6, formatFarads, (v) => t.setValue(v)),
        );
        if (live && part) card.reading('Voltage', () => `${(sim.result.capacitors.get(part.id) ?? 0).toFixed(2)} V`);
        return '';
      case 'diode':
        card.row(
          'Type',
          choice(
            [
              ['1N4148', '1N4148'],
              ['1N4007', '1N4007'],
            ],
            def.id,
            (id) => t.setDef(id),
          ),
        );
        card.note(def.id === '1N4148' ? 'Small signal diode' : 'Rectifier diode');
        return '';
      case 'transistor': {
        if (def.pnp) card.row('Type', '2N3906, 200 mA');
        else
          card.row(
            'Type',
            select(
              [
                ['2N3904', '2N3904, 200 mA'],
                ['2N2222', '2N2222, 600 mA'],
              ],
              def.id,
              (id) => t.setDef(id),
              'Type',
            ),
          );
        const legs = el('div', 'legs');
        for (const l of ['E', 'B', 'C']) legs.append(el('span', '', l));
        card.row('Legs', legs);
        return '';
      }
      case 'pot':
        card.row(
          'Resistance',
          valueSelect(POT_VALUES, value ?? 1e6, formatOhms, (v) => t.setValue(v)),
        );
        if (part) {
          this.knob(part.id, card);
        }
        return '';
      case 'button': {
        if (!part || !live) return '';
        const held = checkbox(sim.isHeld(part.id), 'Held down', (on) => (on ? sim.hold(part.id) : sim.unhold(part.id)));
        // Kept in step with the button, which a click on the board also lets go of.
        card.live(() => held.setAttribute('aria-checked', String(sim.isHeld(part.id))));
        card.body.append(held);
        return '';
      }
      case 'slide': {
        const position = ((part?.state ?? 0) & 1) as 0 | 1;
        card.row(
          'Position',
          choice(
            [
              [0, 'Left'],
              [1, 'Right'],
            ],
            position,
            () => part && sim.toggleSwitch(part.id, 0),
            !part,
          ),
        );
        return '';
      }
      case 'dipswitch': {
        const n = def.positions;
        if (part) card.row('Switches', String(n));
        else
          card.row(
            'Switches',
            choice(
              [
                [4, '4'],
                [8, '8'],
              ],
              n,
              (v) => t.setDef(`dip-switch-${v}`),
            ),
          );
        if (part) {
          const dips = el('div', 'dips');
          for (let k = 0; k < n; k++) {
            const on = ((part.state ?? 0) >> k) & 1;
            const b = el('button', `dipb${on ? ' on' : ''}`);
            b.setAttribute('aria-pressed', String(!!on));
            b.setAttribute('aria-label', `Switch ${k + 1}`);
            b.append(el('i'), document.createTextNode(String(k + 1)));
            b.addEventListener('click', () => sim.toggleSwitch(part.id, k));
            dips.append(b);
          }
          card.body.append(dips);
        }
        return '';
      }
      case 'display':
        card.row(
          'Type',
          select(
            [
              ['cathode', 'Common cathode'],
              ['anode', 'Common anode'],
            ],
            def.common,
            (common) => t.setDef(displayId(common, def.color)),
            'Type',
          ),
        );
        card.row(
          'Colour',
          select(
            LED_COLORS.map((c) => [c, capitalise(c)] as const),
            def.color,
            (c) => t.setDef(displayId(def.common, c)),
            'Colour',
          ),
        );
        card.fold('Pins', (into) => into.append(this.segmentLegend(def.common, part?.id ?? null)));
        return '';
      case 'bargraph':
        card.note('Pins 1–10 are the + legs, 11–20 the − legs');
        return '';
      case 'lcd':
        card.note('16 characters on 2 lines, with an HD44780 controller');
        card.fold('Pins', (into) => into.append(pinList(def.pinNames, part, this.deps, card, true)));
        return '';
      case 'power':
        card.note('The − rails are always ground');
        for (const side of [0, 1] as const)
          card.row(
            side === 0 ? 'Top side' : 'Bottom side',
            choice(
              // In the order the jumper's pins are on the module: 3.3 V, Off, 5 V.
              POWER_JUMPERS.map((j, i) => [i, j.label] as const).reverse(),
              powerJumper(part?.state, side),
              (j) => part && sim.setPowerJumper(part.id, side, j),
            ),
          );
        return '';
      case 'nano':
        if (part) this.nanoBody(part, card);
        else card.fold('Pins', (into) => into.append(pinList(def.pinNames, null, this.deps, card)));
        return '';
    }
  }

  /** Resistance as a number and a unit, with the colour bands it gets. */
  private resistance(ohms: number, card: Card): void {
    const t = this.deps.tools;
    const scale = ohms >= 1e6 ? 1e6 : ohms >= 1e3 ? 1e3 : 1;
    const pair = el('div', 'pair');
    const input = el('input', 'inp');
    input.value = String(Math.round((ohms / scale) * 1000) / 1000);
    input.inputMode = 'decimal';
    input.setAttribute('aria-label', 'Resistance');
    const units = select(
      [
        [1, 'Ω'],
        [1e3, 'kΩ'],
        [1e6, 'MΩ'],
      ],
      scale,
      () => commit(),
      'Unit',
    );
    const commit = (): void => {
      const n = Number(input.value.replace(',', '.'));
      const mult = Number(units.value);
      const v = n * mult;
      if (Number.isFinite(v) && v >= 1 && v <= 1e8) t.setValue(Math.round(v * 1000) / 1000);
      else input.value = String(Math.round((ohms / scale) * 1000) / 1000);
    };
    input.addEventListener('change', commit);
    input.addEventListener('keydown', (e) => e.key === 'Enter' && input.blur());
    pair.append(input, units);
    card.row('Resistance', pair);
    const bands = el('div', 'bands');
    resistorBands(ohms).forEach((band, i, all) => {
      const stripe = el('i');
      stripe.style.background = BAND_CSS[band] ?? '#888';
      if (i < all.length - 1 || all.length < 4) bands.append(stripe);
      else {
        bands.append(stripe);
        bands.append(el('em', '', band === 'gold' ? '±5%' : band === 'silver' ? '±10%' : ''));
      }
    });
    card.row('Bands', bands);
  }

  private chipBody(def: Extract<PartDef, { kind: 'dip' }>, part: PartDoc | null, card: Card): string {
    const model = CHIP_MODELS[def.id];
    card.note(CHIP_NOTES[def.id] ?? def.subtitle);
    const memory = !!model?.nonvolatile || def.id === '62256' || def.id === '74LS189';
    if (def.id === 'W65C02S') {
      if (part) this.cpuBody(part, card);
      card.fold('Pins', (into) => into.append(pinList(def.pinNames, part, this.deps, card)));
      return 'wide';
    }
    if (memory) {
      if (part) this.memoryBody(def, part, card);
      card.fold('Pins', (into) => into.append(pinList(def.pinNames, part, this.deps, card)));
      return 'wide';
    }
    const gates = GATE_LAYOUTS[def.id];
    card.fold('Pins', (into) => into.append(pinList(def.pinNames, part, this.deps, card, false, gates)));
    return '';
  }

  /** An EEPROM's or RAM's contents as a hex view, 8 bytes a row, with loading, saving and erasing. */
  private memoryBody(def: Extract<PartDef, { kind: 'dip' }>, part: PartDoc, card: Card): void {
    const { store, sim } = this.deps;
    const model = CHIP_MODELS[def.id];
    const rom = !!model?.nonvolatile;
    const size = rom ? model!.nonvolatile! : def.id === '62256' ? 32768 : 16;
    const nibbles = def.id === '74LS189';
    const clamp = (a: number): number => Math.max(0, Math.min(Math.max(0, size - 8), a & ~7));
    const from = (): number => clamp(this.memFrom.get(part.id) ?? 0);
    const setFrom = (a: number): void => {
      this.memFrom.set(part.id, clamp(a));
      at.value = hexDigits(from(), 4);
      draw();
    };

    const pair = el('div', 'pair');
    const at = el('input', 'inp mono');
    at.maxLength = 4;
    at.value = hexDigits(from(), 4);
    at.setAttribute('aria-label', 'Show from address');
    at.addEventListener('change', () => setFrom(parseInt(at.value, 16) || 0));
    at.addEventListener('keydown', (e) => e.key === 'Enter' && at.blur());
    const pages = el('div', 'grp');
    for (const [d, ic, label] of [
      [-64, 'chevl', 'Back'],
      [64, 'chevr', 'On'],
    ] as const) {
      const b = el('button');
      b.setAttribute('aria-label', label);
      b.append(icon(ic, true));
      b.addEventListener('click', () => setFrom(from() + d));
      pages.append(b);
    }
    pair.append(at, pages);
    if (size > 64) card.row('Show from', pair);

    const hex = el('div', 'hex');
    card.body.append(hex);
    let shown = '';
    const draw = (): void => {
      const now = store.doc.parts.find((p) => p.id === part.id);
      const bytes = now ? sim.memoryOf(now) : null;
      const start = from();
      let html = '';
      if (!bytes) html = '';
      else
        for (let r = 0; r < Math.min(8, Math.ceil((size - start) / 8)); r++) {
          const ad = start + r * 8;
          html += `<span class="a">${hexDigits(ad, 4)}</span>`;
          for (let i = 0; i < 8; i++) {
            const b = bytes[ad + i];
            html +=
              b === undefined
                ? '<span></span>'
                : `<span${b === 0xff && rom ? ' class="ff"' : ''}>${nibbles ? (b & 15).toString(16).toUpperCase() : hexDigits(b, 2)}</span>`;
          }
        }
      if (html === shown) return;
      shown = html;
      hex.hidden = !bytes;
      hex.innerHTML = html;
    };
    draw();
    card.live(draw);
    if (!rom) {
      const none = card.note('Turn the power on to see what it holds');
      card.live(() => (none.hidden = !!sim.memoryOf(part)));
      return;
    }

    const write = (bytes: Uint8Array, message: string): void => {
      store.update(
        (doc) => {
          const p = doc.parts.find((x) => x.id === part.id);
          if (p) p.data = encodeBytes(bytes);
        },
        { history: false },
      );
      this.deps.toast(message);
    };
    const ref = partRef(store.doc, part.id);
    const acts = el('div', 'grp cardgrp');
    const button = (label: string, run: () => void): void => {
      const b = el('button', '', label);
      b.addEventListener('click', run);
      acts.append(b);
    };
    button('Load file', () => this.deps.pickFile('rom', part.id));
    button('Save', () => {
      const now = store.doc.parts.find((p) => p.id === part.id);
      const bytes = now && sim.memoryOf(now);
      if (bytes)
        download(
          `${safeFileName(store.doc.name, 'eeprom')}-${ref}.bin`,
          new Blob([bytes.slice()], { type: 'application/octet-stream' }),
        );
    });
    button('Erase', () => write(new Uint8Array(size).fill(0xff), `${ref} erased`));
    card.body.append(acts);
    const presets = ROM_PRESETS[size > 2048 ? 'big' : 'small'];
    const ready = select(
      [[-1, 'Pick one'], ...presets.map((p, i) => [i, p.label] as const)],
      -1,
      (i) => {
        const p = presets[i];
        if (p) write(p.make(), `${ref} ${p.done}`);
      },
      'Ready-made',
    );
    card.row('Ready-made', ready);
    if (size >= 8192) {
      const code = el('button', 'wbtn');
      code.append(icon('code', true), document.createTextNode('Edit in Code'));
      code.addEventListener('click', () => this.deps.openCode(part.id));
      card.body.append(code);
    }
  }

  /** A 6502's registers and flags, live while running, and the way to its bus trace. */
  private cpuBody(part: PartDoc, card: Card): void {
    const { sim } = this.deps;
    const regs = el('div', 'regs');
    const names = ['A', 'X', 'Y', 'SP', 'PC'];
    const cells = names.map((n) => {
      const r = el('div', 'reg');
      const b = el('b');
      r.append(el('span', '', n), b);
      regs.append(r);
      return b;
    });
    const flags = el('div', 'flags');
    const letters = 'NV-BDIZC'.split('');
    const boxes = letters.map((l) => {
      const f = el('span', 'flag', l === '-' ? '–' : l);
      flags.append(f);
      return f;
    });
    card.body.append(regs);
    card.row('Flags', flags);
    const state = card.note('');
    const update = (): void => {
      const cpu = sim.cpuOf(part);
      const v = cpu
        ? [hexDigits(cpu.a, 2), hexDigits(cpu.x, 2), hexDigits(cpu.y, 2), hexDigits(cpu.sp, 2), hexDigits(cpu.pc, 4)]
        : names.map(() => '');
      cells.forEach((c, i) => setText(c, v[i]));
      boxes.forEach((b, i) => b.classList.toggle('on', !!cpu && !!(cpu.p & (0x80 >> i))));
      setText(
        state,
        !cpu
          ? 'Turn the power on to see it run'
          : cpu.stopped
            ? 'Stopped'
            : cpu.waiting
              ? 'Waiting for an interrupt'
              : cpu.resetLow
                ? 'Held in reset'
                : '',
      );
      state.hidden = !state.textContent;
    };
    update();
    card.live(update);
    const bus = el('button', 'wbtn');
    bus.append(icon('trace', true), document.createTextNode('Show the bus trace'));
    bus.addEventListener('click', () => this.deps.showBus());
    card.body.append(bus);
  }

  /** A Nano's sketch, its firmware and image, and what it's doing. */
  private nanoBody(part: PartDoc, card: Card): void {
    const { store, sim } = this.deps;
    const set = (change: (p: PartDoc) => void): void =>
      store.update((doc) => {
        const p = doc.parts.find((x) => x.id === part.id);
        if (p) change(p);
      });
    const sketch = sketchOf(part);
    const hasFirmware = !!part.firmware;
    const options: [number, string][] = SKETCHES.map((s, i) => [i, s.title]);
    if (hasFirmware) options.push([-1, part.firmwareName ?? 'Own .hex file']);
    card.row(
      'Sketch',
      select(
        options,
        hasFirmware ? -1 : SKETCHES.indexOf(sketch),
        (i) => {
          if (i < 0) return;
          set((p) => {
            delete p.firmware;
            delete p.firmwareName;
            p.state = i;
          });
        },
        'Sketch',
      ),
    );
    if (!hasFirmware && sketch.usesImage) {
      const value = part.value ?? 0;
      const titles: [number, string][] = IMAGES.map((img, i) => [i, img.title]);
      if (value === CUSTOM_IMAGE) titles.push([CUSTOM_IMAGE, 'A file you loaded']);
      // The last choice opens a file to program instead of a ready-made image.
      titles.push([-1, 'Load a file']);
      const images = select(
        titles,
        value,
        (i) => {
          if (i >= 0) return set((p) => (p.value = i));
          images.value = String(value);
          syncSelect(images);
          this.deps.pickFile('rom', part.id);
        },
        'Image',
      );
      card.row('Image', images);
    }
    const acts = el('div', 'grp cardgrp');
    const hex = el('button', '', 'Load .hex');
    hex.addEventListener('click', () => this.deps.pickFile('firmware', part.id));
    const code = el('button', '', 'Open in Code');
    code.addEventListener('click', () => this.deps.openCode(part.id));
    acts.append(hex, code);
    card.body.append(acts);
    card.reading('Doing', () => {
      if (!sim.isOn) return 'Nothing, the power is off';
      const mcu = sim.result.mcus.get(part.id);
      if (!mcu) return 'Starting';
      if (mcu.progress === undefined) return 'Running';
      if (mcu.progress >= 1) return 'Done';
      return `${sketch.usesImage ? 'Programming' : 'Reading'}, ${Math.floor(mcu.progress * 100)} %`;
    });
  }

  /** A potentiometer's knob as a slider, following the knob when it's turned on the board. */
  private knob(id: Id, card: Card): void {
    const { store, sim } = this.deps;
    const pair = el('div', 'pair');
    const slider = el('input', 'rng');
    slider.type = 'range';
    slider.min = '0';
    slider.max = '1000';
    slider.setAttribute('aria-label', 'Knob');
    slider.addEventListener('input', () => sim.setKnob(id, Number(slider.value)));
    const percent = el('span', 'unit w');
    pair.append(slider, percent);
    card.row('Knob', pair);
    card.live(() => {
      const at = store.doc.parts.find((p) => p.id === id)?.state ?? 500;
      if (document.activeElement !== slider) slider.value = String(at);
      setText(percent, `${Math.round(at / 10)} %`);
    });
  }

  /** Which pin drives which segment, lit while the display shows it. As seen from above. */
  private segmentLegend(common: 'cathode' | 'anode', id: Id | null): HTMLElement {
    const grid = el('div', 'segs');
    const cells: HTMLElement[] = [];
    for (let pin = 1; pin <= 10; pin++) {
      const s = SEGMENT_PINS.indexOf(pin);
      const cell = el('span');
      cell.append(
        el('b', '', s >= 0 ? SEGMENT_NAMES[s] : common === 'cathode' ? 'COM −' : 'COM +'),
        el('small', '', String(pin)),
      );
      cells[pin] = cell;
    }
    for (const pin of [10, 9, 8, 7, 6, 1, 2, 3, 4, 5]) grid.append(cells[pin]);
    if (id)
      this.live.push(() => {
        const segments = this.deps.sim.result.segments.get(id);
        SEGMENT_PINS.forEach((pin, s) => cells[pin].classList.toggle('lit', (segments?.[s]?.brightness ?? 0) > 0.05));
      });
    return grid;
  }
}

/** Whether a part turns or flips with R. */
function turns(def: PartDef): boolean {
  return def.kind !== 'power';
}

/**
 * A chip's pins in two columns, as on a datasheet's top view, with each pin's level while running.
 * Pointing at a pin of a part on the desk lights its leg there.
 */
function pinList(
  names: readonly string[],
  part: PartDoc | null,
  deps: InspectorDeps,
  card: Card,
  inLine = false,
  gates?: GateLayout,
): HTMLElement {
  const n = names.length;
  const half = Math.ceil(n / 2);
  // Drawn like a datasheet's top view: the package in the middle, pin 1 by the notch at top left,
  // numbers inside, names outside. Parts with one row of pins (the screen) get a strip down the left.
  const list = el('div', inLine ? 'pinl inline' : gates ? 'pinl dip gated' : 'pinl dip');
  const body = el('div', 'pkg');
  body.style.gridRow = `1 / span ${inLine ? n : half}`;
  // Logic chips show their gates inside the outline, wired to their pins.
  if (gates) body.append(gatesDrawing(gates, n));
  if (!inLine) body.append(el('span', 'notch'));
  list.classList.toggle('on-desk', !!part);
  list.append(body);
  const marks: (HTMLElement | null)[] = [];
  const cell = (i: number, side: 'l' | 'r', row: number): void => {
    const d = el('div', side);
    const lv = el('span', 'lv');
    lv.hidden = true;
    // Numbers in a column with two-digit ones get a leading 0, so the names line up.
    const wide = side === 'r' ? n >= 10 : half >= 10;
    const name = el('b', '', names[i]);
    d.append(name, el('i', '', String(i + 1).padStart(wide ? 2 : 1, '0')), lv);
    // The full name as a tooltip, only when it's cut short; otherwise it would just repeat the row.
    d.addEventListener('pointerenter', () => {
      if (name.scrollWidth > name.clientWidth) d.title = names[i];
      else d.removeAttribute('title');
    });
    d.style.gridRow = String(row + 1);
    // Pointing at a pin lights its leg on the desk.
    if (part) {
      d.addEventListener('pointerenter', () => deps.tools.pointCardPins(part.id, [i]));
      d.addEventListener('pointerleave', () => deps.tools.pointCardPins(null));
    }
    marks[i] = lv;
    list.append(d);
  };
  if (inLine) for (let i = 0; i < n; i++) cell(i, 'r', i);
  else
    for (let r = 0; r < half; r++) {
      cell(r, 'l', r);
      const other = n - 1 - r;
      if (other !== r && other >= half) cell(other, 'r', r);
    }
  if (part) {
    const { sim } = deps;
    card.live(() => {
      const live = sim.result.live;
      part.pins.forEach((ref, i) => {
        const m = marks[i];
        if (!m) return;
        const v = live ? sim.result.volts(ref) : null;
        m.hidden = v === null;
        if (v === null) return;
        const lvl = !Number.isFinite(v) ? 'loose' : v >= 2 ? 'hi' : v <= 0.8 ? '' : 'mid';
        const cls = `lv${lvl ? ` ${lvl}` : ''}`;
        if (m.className !== cls) m.className = cls;
        m.title = !Number.isFinite(v) ? 'Floating' : `${v.toFixed(2)} V`;
      });
    });
  }
  return list;
}

/** Loads a .bin or Intel HEX image into an EEPROM, or as a Nano's image to program. Resolves to what to tell the user. */
export async function loadRomFile(store: Store, id: Id, file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const size = CHIP_MODELS[store.doc.parts.find((x) => x.id === id)?.def ?? '']?.nonvolatile ?? 2048;
  const bytes = parseRomImage(new Uint8Array(buffer), size);
  store.update(
    (doc) => {
      const p = doc.parts.find((x) => x.id === id);
      if (!p) return;
      p.data = encodeBytes(bytes);
      if (PARTS[p.def]?.kind === 'nano') p.value = CUSTOM_IMAGE;
    },
    { history: false },
  );
  const cut = buffer.byteLength > size && !file.name.endsWith('.hex');
  return `Loaded ${file.name}${cut ? ` (the first ${size / 1024} KB)` : ''}`;
}

/** Loads compiled ATmega328P Intel HEX firmware into a Nano. Rejects with a readable message. */
export async function loadFirmwareFile(store: Store, id: Id, file: File): Promise<string> {
  const bytes = parseFirmwareHex(await file.text());
  store.update(
    (doc) => {
      const p = doc.parts.find((x) => x.id === id);
      if (!p) return;
      p.firmware = encodeBytes(bytes);
      p.firmwareName = file.name;
    },
    { history: false },
  );
  return `Loaded ${file.name} into the Nano`;
}
