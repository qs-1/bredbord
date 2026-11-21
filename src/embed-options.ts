// The settings of the selected part that the phone app shows in its card (an LED's colour and size, a
// resistor's value, a switch's position, a power module's jumpers...), as lists to choose from, and its
// pins. The app sends a choice back as `{ type: 'option', id, value }` and a pin tapped in its diagram as
// `{ type: 'pin', index }` (see src/embed.ts, where `applyOption` below is called).

import type { PartDoc } from './engine/circuit';
import {
  CERAMIC_VALUES,
  displayId,
  ELECTROLYTIC_VALUES,
  formatFarads,
  formatOhms,
  NETWORK_VALUES,
  PARTS,
  POT_VALUES,
  POWER_JUMPERS,
  powerJumper,
  RESISTOR_VALUES,
  type LedColor,
  type PartDef,
} from './engine/parts';

export interface DeskOption {
  /**
   * What it sets: 'color' (an LED's or a display's colour), 'size' (an LED's), 'value' (resistance or
   * capacitance), 'def' (which kind: diode, transistor, display), 'held' (a push button), 'switch' (a
   * slide or push switch, or one of a DIP switch's), 'jumper0' / 'jumper1' (a power module's sides).
   */
  id: 'color' | 'size' | 'value' | 'def' | 'held' | 'switch' | 'jumper0' | 'jumper1';
  label: string;
  /**
   * How it's drawn: 'choice' (one of, the default), 'swatch' (one of, as colour squares: each choice has
   * a `color`), 'toggles' (each choice on or off by itself: a DIP switch's switches; `current` is a
   * bit mask and a tap sends the choice's `value`, the switch's number).
   */
  look?: 'choice' | 'swatch' | 'toggles';
  choices: { value: string; label: string; color?: string }[];
  /** The `value` of the choice that is on now (for 'toggles', the bit mask). */
  current: string;
}

/** A part's pins, for the app's pin diagram. */
export interface DeskPins {
  /** In pin order, pin 1 first. */
  names: string[];
  /** 'dip': drawn as a chip from above, pin 1 top left; 'list': one under another. */
  layout: 'dip' | 'list';
}

export const LED_COLORS: readonly LedColor[] = ['red', 'green', 'yellow', 'blue', 'white'];

/** The swatch colours, as on the site's card. */
const LED_CSS: Record<LedColor, string> = {
  red: '#e2362a',
  green: '#2fa84f',
  yellow: '#f0c419',
  blue: '#2a62d8',
  white: '#f2f1ee',
};

const capitalise = (s: string): string => s[0].toUpperCase() + s.slice(1);

/** The choices for a number, with the part's own value added at the front when it isn't one of them. */
function numbers(values: readonly number[], now: number, format: (n: number) => string): DeskOption['choices'] {
  const list = values.includes(now) ? [...values] : [now, ...values];
  return list.map((v) => ({ value: String(v), label: format(v) }));
}

const colours = (current: LedColor): DeskOption => ({
  id: 'color',
  label: 'Colour',
  look: 'swatch',
  choices: LED_COLORS.map((c) => ({ value: c, label: capitalise(c), color: LED_CSS[c] })),
  current,
});

const kinds = (label: string, ids: readonly string[], current: string): DeskOption => ({
  id: 'def',
  label,
  choices: ids.map((id) => ({ value: id, label: PARTS[id]?.title ?? id })),
  current,
});

/** `held`: a push button is being held down (the simulation knows, not the circuit). */
export function optionsOf(part: PartDoc | undefined, held = false): DeskOption[] {
  const def = part ? PARTS[part.def] : undefined;
  if (!part || !def) return [];
  switch (def.kind) {
    case 'led':
      return [
        colours(def.color),
        {
          id: 'size',
          label: 'Size',
          choices: [
            { value: '3', label: '3 mm' },
            { value: '5', label: '5 mm' },
          ],
          current: String(part.value ?? 5),
        },
      ];
    case 'resistor': {
      const now = part.value ?? 470;
      return [
        { id: 'value', label: 'Resistance', choices: numbers(RESISTOR_VALUES, now, formatOhms), current: String(now) },
      ];
    }
    case 'network': {
      const now = part.value ?? 1000;
      return [
        { id: 'value', label: 'Resistance', choices: numbers(NETWORK_VALUES, now, formatOhms), current: String(now) },
      ];
    }
    case 'pot': {
      const now = part.value ?? 1e6;
      return [
        { id: 'value', label: 'Resistance', choices: numbers(POT_VALUES, now, formatOhms), current: String(now) },
      ];
    }
    case 'capacitor': {
      const now = part.value ?? (def.style === 'ceramic' ? 100e-9 : 1e-6);
      const values = def.style === 'ceramic' ? CERAMIC_VALUES : ELECTROLYTIC_VALUES;
      return [{ id: 'value', label: 'Capacitance', choices: numbers(values, now, formatFarads), current: String(now) }];
    }
    case 'diode':
      return [kinds('Type', ['1N4148', '1N4007'], def.id)];
    case 'transistor':
      return def.pnp ? [] : [kinds('Type', ['2N3904', '2N2222'], def.id)];
    case 'display':
      return [
        {
          id: 'def',
          label: 'Type',
          choices: [
            { value: displayId('cathode', def.color), label: 'Common cathode' },
            { value: displayId('anode', def.color), label: 'Common anode' },
          ],
          current: def.id,
        },
        colours(def.color),
      ];
    case 'button':
      return [
        {
          id: 'held',
          label: 'Button',
          choices: [
            { value: '0', label: 'Up' },
            { value: '1', label: 'Held down' },
          ],
          current: held ? '1' : '0',
        },
      ];
    case 'slide':
    case 'pushswitch': {
      const [a, b] = def.kind === 'slide' ? ['Left', 'Right'] : ['Out', 'In'];
      return [
        {
          id: 'switch',
          label: 'Position',
          choices: [
            { value: '0', label: a },
            { value: '1', label: b },
          ],
          current: String((part.state ?? 0) & 1),
        },
      ];
    }
    case 'dipswitch':
      return [
        {
          id: 'switch',
          label: 'Switches',
          look: 'toggles',
          choices: Array.from({ length: def.positions }, (_, k) => ({ value: String(k), label: String(k + 1) })),
          current: String((part.state ?? 0) & ((1 << def.positions) - 1)),
        },
      ];
    case 'power':
      return ([0, 1] as const).map((side) => ({
        id: side === 0 ? 'jumper0' : 'jumper1',
        label: side === 0 ? 'Top side' : 'Bottom side',
        choices: POWER_JUMPERS.map((j, i) => ({ value: String(i), label: j.label })).reverse(),
        current: String(powerJumper(part.state, side)),
      }));
    default:
      return [];
  }
}

/** The line under a part's name: what a chip is ("Timer"); nothing where the name says it already. */
export function subtitleOf(def: PartDef | undefined): string {
  return def && (def.kind === 'dip' || def.kind === 'nano' || def.kind === 'lcd') ? def.subtitle : '';
}

export function pinsOf(def: PartDef | undefined): DeskPins | null {
  if (!def) return null;
  if (def.kind === 'dip') return { names: [...def.pinNames], layout: 'dip' };
  if (def.kind === 'nano' || def.kind === 'lcd') return { names: [...def.pinNames], layout: 'list' };
  return null;
}
