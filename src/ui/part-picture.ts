// A part's picture and short name by its id ('NE555', 'led-red', 'resistor'): the same drawings as the
// parts panel's tiles. Used by the shared-circuit page, and by build-embed for the phone app's copy.

import { PARTS, type PartDef } from '../engine/parts';
import { chipPicture, PICTURES } from './pictures';

const LED_COLOURS: Record<string, [string, string]> = {
  red: ['#e2362a', '#c42b21'],
  green: ['#2fa84f', '#23843d'],
  yellow: ['#f0c419', '#c99f0e'],
  blue: ['#2a62d8', '#1f4caa'],
  white: ['#f2f1ee', '#cfcbc2'],
};

const BY_KIND: Partial<Record<PartDef['kind'], string>> = {
  resistor: PICTURES.res,
  pot: PICTURES.pot,
  diode: PICTURES.diode,
  power: PICTURES.pmod,
  button: PICTURES.push,
  slide: PICTURES.slide,
  pushswitch: PICTURES.latch,
  dipswitch: PICTURES.dip,
  display: PICTURES.seg7,
  bargraph: PICTURES.bar,
  network: PICTURES.network,
  nano: PICTURES.nano,
  lcd: PICTURES.lcd,
};

/** The drawing's insides (64 × 48), or '' for an id this version doesn't know. */
export function partPictureBody(id: string): string {
  const d = PARTS[id];
  if (!d) return '';
  switch (d.kind) {
    case 'dip':
      return chipPicture(d.id === 'W65C02S' ? '65C02' : d.id.replace(/^AT/, ''), d.pins);
    case 'led': {
      const [body, rim] = LED_COLOURS[d.id.slice(4)] ?? LED_COLOURS.red;
      return PICTURES.led.replaceAll('#e2362a', body).replaceAll('#c42b21', rim);
    }
    case 'capacitor':
      return d.id === 'cap-electrolytic' ? PICTURES.elec : PICTURES.cer;
    case 'transistor':
      return d.id === '2N3906' ? PICTURES.pnp : PICTURES.npn;
    default:
      return BY_KIND[d.kind] ?? '';
  }
}

const NAMES: Record<string, string> = {
  'cap-ceramic': 'Ceramic capacitor',
  'cap-electrolytic': 'Electrolytic capacitor',
  'resistor-network': 'Resistor network',
  'dip-switch-4': 'DIP switch',
  'dip-switch-8': 'DIP switch',
  nano: 'Arduino Nano',
  'lcd-1602': 'LCD',
  '2N3904': 'NPN transistor',
  '2N3906': 'PNP transistor',
};

/** A short name for a parts list: chips by number, the rest in words. */
export function partName(id: string): string {
  const d = PARTS[id];
  if (!d) return id;
  if (d.kind === 'dip') return id;
  if (d.kind === 'led') {
    const colour = id.slice(4);
    return LED_COLOURS[colour] ? `${colour[0].toUpperCase()}${colour.slice(1)} LED` : 'LED';
  }
  if (d.kind === 'display') return '7-segment display';
  return NAMES[id] ?? d.title;
}

/** Chips first, then the most used. Unknown ids (from a newer version) are left out. */
export function partsInOrder(parts: Record<string, number>): { id: string; count: number }[] {
  const chip = (id: string): number => (PARTS[id]?.kind === 'dip' || id === 'nano' ? 0 : 1);
  return Object.entries(parts)
    .filter(([id, n]) => PARTS[id] && Number.isFinite(n) && n > 0)
    .sort(([a, x], [b, y]) => chip(a) - chip(b) || y - x || a.localeCompare(b))
    .map(([id, count]) => ({ id, count }));
}
