// What the parts panel offers, in its sections: plain data, so the phone app's parts sheet is made from
// the same list (scripts/build-embed.mjs writes it into the app).

import type { BoardType } from '../engine/breadboard';
import { PART_LIST, PARTS, type PartDef } from '../engine/parts';
import type { PictureName } from './pictures';

export const SECTIONS = [
  'Boards and power',
  'Instruments',
  'Basics',
  'Switches and displays',
  'Logic chips',
  'Memory and CPU',
] as const;
export type Section = (typeof SECTIONS)[number];

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
  '74HC153': '2 4-to-1 switches',
  '74LS161': '4-bit counter',
  '74LS193': 'Up and down counter',
  '74LS173': '4-bit register',
  '74LS245': 'Bus buffer',
  '74LS273': '8-bit register',
  '74LS283': '4-bit adder',
  '74HC595': 'Shift register',
  '74HC165': 'Parallel to serial',
  NE555: 'Timer',
  W65C02S: '6502 processor',
  AT28C256: '32K EEPROM',
  '62256': '32K RAM',
  '28C16': '2K EEPROM',
  '74LS189': '64-bit RAM',
};
const MEMORY_ORDER = ['W65C02S', 'AT28C256', '62256', '28C16', '74LS189'];

/**
 * What picking a tile brings out: a part by its id ('led' is the LED in the last colour picked), a
 * board, something for the desk, or the probe.
 */
export type CataloguePick =
  | { kind: 'part'; part: string }
  | { kind: 'led' }
  | { kind: 'board'; type: BoardType }
  | { kind: 'desk'; what: 'supply' | 'meter' | 'scope' }
  | { kind: 'probe' };

export interface CatalogueEntry {
  id: string;
  name: string;
  sub: string;
  section: Section;
  pic: PictureName | { chip: string; pins: number };
  keywords: string;
  pick: CataloguePick;
}

function build(): CatalogueEntry[] {
  const out: CatalogueEntry[] = [];
  const part = (id: string, name: string, sub: string, section: Section, pic: CatalogueEntry['pic'], keywords = '') => {
    if (PARTS[id]) out.push({ id, name, sub, section, pic, keywords, pick: { kind: 'part', part: id } });
  };
  const board = (id: string, type: BoardType, name: string, sub: string, pic: PictureName, keywords: string) =>
    out.push({ id, name, sub, section: 'Boards and power', pic, keywords, pick: { kind: 'board', type } });
  const desk = (
    what: 'supply' | 'meter' | 'scope',
    name: string,
    sub: string,
    section: Section,
    pic: PictureName,
    keywords: string,
  ) => out.push({ id: what, name, sub, section, pic, keywords, pick: { kind: 'desk', what } });

  board('bb', 'bb830', 'Breadboard', '830 holes', 'bb', 'bb830 full');
  board('bb-bare', 'core-bb830', 'Breadboard without rails', '630 holes', 'core', 'bb830 630 bare core no rails');
  board('half', 'bb400', 'Half breadboard', '400 holes', 'half', 'bb400');
  board('mini', 'mini', 'Mini breadboard', '170 holes', 'mini', 'small');
  board('rail', 'strip-bb830-top', 'Power rail', '+ and −', 'rail', 'bus strip');
  part('power', 'Power module', '5 V or 3.3 V', 'Boards and power', 'pmod', 'usb mb102');
  desk('supply', 'Bench supply', '0 to 30 V', 'Boards and power', 'bench', 'power psu');
  out.push({
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

  part('resistor', 'Resistor', 'Any value', 'Basics', 'res', 'ohm');
  out.push({
    id: 'led',
    name: 'LED',
    sub: '3 or 5 mm',
    section: 'Basics',
    pic: 'led',
    keywords: 'light diode',
    pick: { kind: 'led' },
  });
  part('cap-ceramic', 'Capacitor', 'Ceramic', 'Basics', 'cer', 'disc');
  part('cap-electrolytic', 'Capacitor', 'Electrolytic', 'Basics', 'elec', 'polarised polarized');
  part('1N4148', 'Diode', '1N4148, 1N4007', 'Basics', 'diode', 'signal rectifier 1n4007');
  part('2N3904', 'Transistor', 'NPN', 'Basics', 'npn', 'bjt 2n3904 2n2222');
  part('2N3906', 'Transistor', 'PNP', 'Basics', 'pnp', 'bjt 2n3906');
  part('pot', 'Potentiometer', 'Knob', 'Basics', 'pot', 'variable resistor trimmer');
  part('resistor-network', 'Resistor network', '8 resistors', 'Basics', 'network', 'sip array bussed');

  part('button', 'Push button', 'Press to close', 'Switches and displays', 'push', 'tactile momentary');
  part('slide-switch', 'Slide switch', 'On or off', 'Switches and displays', 'slide', 'toggle spdt');
  part(
    'push-switch',
    'Push switch',
    'Push on, push off',
    'Switches and displays',
    'latch',
    'dpdt latching self-locking toggle',
  );
  part('dip-switch-8', 'DIP switch', '4 or 8 switches', 'Switches and displays', 'dip', '');
  part('7seg-cc', '7-segment', 'One digit', 'Switches and displays', 'seg7', 'seven segment display');
  part('bargraph', 'LED bar graph', '10 segments', 'Switches and displays', 'bar', 'array');
  part('lcd-1602', 'LCD', '16 × 2 characters', 'Switches and displays', 'lcd', 'character display 1602 hd44780');

  const chips = PART_LIST.filter((d): d is Extract<PartDef, { kind: 'dip' }> => d.kind === 'dip');
  for (const d of chips.filter((c) => !MEMORY_ORDER.includes(c.id)))
    part(d.id, d.id, CHIP_SUB[d.id] ?? d.subtitle, 'Logic chips', { chip: d.id, pins: d.pins }, d.subtitle);
  for (const id of MEMORY_ORDER) {
    const d = PARTS[id];
    if (d?.kind === 'dip')
      part(
        id,
        d.id,
        CHIP_SUB[id] ?? d.subtitle,
        'Memory and CPU',
        { chip: d.id === 'W65C02S' ? '65C02' : d.id.replace('AT', ''), pins: d.pins },
        d.subtitle,
      );
  }
  part('nano', 'Arduino Nano', 'Runs sketches', 'Memory and CPU', 'nano', 'atmega328 arduino');
  return out;
}

export const CATALOGUE: readonly CatalogueEntry[] = build();
