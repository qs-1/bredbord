// The settings of the selected part that the phone app shows in its sheet (an LED's colour and size,
// a resistor's or capacitor's value), as lists to choose from. The app sends a choice back as
// `{ type: 'option', id, value }` (see src/embed.ts).

import type { PartDoc } from './engine/circuit';
import {
  CERAMIC_VALUES,
  ELECTROLYTIC_VALUES,
  formatFarads,
  formatOhms,
  PARTS,
  RESISTOR_VALUES,
  type LedColor,
} from './engine/parts';

export interface DeskOption {
  /** 'color' (LEDs), 'size' (LEDs) or 'value' (resistors and capacitors). */
  id: 'color' | 'size' | 'value';
  label: string;
  choices: { value: string; label: string }[];
  /** The `value` of the choice that is on now. */
  current: string;
}

export const LED_COLORS: readonly LedColor[] = ['red', 'green', 'yellow', 'blue', 'white'];

const capitalise = (s: string): string => s[0].toUpperCase() + s.slice(1);

/** The choices for a number, with the part's own value added at the front when it isn't one of them. */
function numbers(values: readonly number[], now: number, format: (n: number) => string): DeskOption['choices'] {
  const list = values.includes(now) ? [...values] : [now, ...values];
  return list.map((v) => ({ value: String(v), label: format(v) }));
}

export function optionsOf(part: PartDoc | undefined): DeskOption[] {
  const def = part ? PARTS[part.def] : undefined;
  if (!part || !def) return [];
  switch (def.kind) {
    case 'led':
      return [
        {
          id: 'color',
          label: 'Colour',
          choices: LED_COLORS.map((c) => ({ value: c, label: capitalise(c) })),
          current: def.color,
        },
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
    case 'capacitor': {
      const now = part.value ?? (def.style === 'ceramic' ? 100e-9 : 1e-6);
      const values = def.style === 'ceramic' ? CERAMIC_VALUES : ELECTROLYTIC_VALUES;
      return [{ id: 'value', label: 'Capacitance', choices: numbers(values, now, formatFarads), current: String(now) }];
    }
    default:
      return [];
  }
}
