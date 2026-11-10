// The parts bin: what each component is, its pinout, and how it sits in the board.

import type { TerminalRow } from './breadboard';

export type LedColor = 'red' | 'green' | 'yellow' | 'blue' | 'white';

interface PartBase {
  readonly id: string;
  readonly title: string;
  readonly subtitle: string;
}

export interface DipDef extends PartBase {
  readonly kind: 'dip';
  readonly family: 'logic' | 'timing' | 'memory' | 'cpu';
  /** Text printed on the package. */
  readonly label: string;
  readonly pins: number;
  /** 0.6" wide package (EEPROMs, RAM) instead of 0.3". */
  readonly wide: boolean;
  readonly pinNames: readonly string[];
}

export interface LedDef extends PartBase {
  readonly kind: 'led';
  readonly color: LedColor;
}

export interface ResistorDef extends PartBase {
  readonly kind: 'resistor';
}

/**
 * An MB102-style module that plugs into the end of a board and feeds both pairs of rails. Like the
 * real one, each side has a jumper choosing 5 V, 3.3 V or off for its + rail; − is always ground.
 */
export interface PowerDef extends PartBase {
  readonly kind: 'power';
}

/** A power module jumper's positions, in the order they sit on the board. */
export const POWER_JUMPERS = [
  { label: '5 V', volts: 5 },
  { label: 'Off', volts: null },
  { label: '3.3 V', volts: 3.3 },
] as const;

/** Which side of a power module: 0 feeds the top rails (pins 1–2), 1 the bottom rails (pins 3–4). */
export type PowerSide = 0 | 1;

// A power module's state: bit 0 is its on switch, bits 1–2 the top jumper, bits 3–4 the bottom one.
// 0 is 5 V, so modules saved before the jumpers existed keep both sides at 5 V.
const jumperShift = (side: PowerSide): number => 1 + 2 * side;

/** Where a side's jumper sits: an index into POWER_JUMPERS. */
export function powerJumper(state: number | undefined, side: PowerSide): number {
  const j = ((state ?? 0) >> jumperShift(side)) & 3;
  return j < POWER_JUMPERS.length ? j : 0;
}

/** The state with a side's jumper moved to position `j`. */
export function withPowerJumper(state: number | undefined, side: PowerSide, j: number): number {
  const shift = jumperShift(side);
  return ((state ?? 0) & ~(3 << shift)) | ((j & 3) << shift);
}

/** What a side's + rail gets: volts, or null when its jumper is off. */
export const powerSideVolts = (state: number | undefined, side: PowerSide): number | null =>
  POWER_JUMPERS[powerJumper(state, side)].volts;

/** A power module's setting in words, such as "5 V" or "Top 5 V, bottom 3.3 V". */
export function powerText(state: number | undefined): string {
  const [top, bottom] = ([0, 1] as const).map((side) => POWER_JUMPERS[powerJumper(state, side)].label);
  return top === bottom
    ? top === 'Off'
      ? 'Both sides off'
      : top
    : `Top ${top === 'Off' ? 'off' : top}, bottom ${bottom === 'Off' ? 'off' : bottom}`;
}

/** A 4-leg 6 mm tactile switch. Legs 1–2 and 3–4 are always joined; pressing joins the two pairs. */
export interface ButtonDef extends PartBase {
  readonly kind: 'button';
}

/** A DIP switch: switch k joins pin k to the pin across from it. */
export interface SwitchDef extends PartBase {
  readonly kind: 'dipswitch';
  readonly positions: number;
}

/** Two legs side by side. `value` is in farads; electrolytics have a + leg (the first). */
export interface CapacitorDef extends PartBase {
  readonly kind: 'capacitor';
  readonly style: 'ceramic' | 'electrolytic';
}

/** An axial diode, anode then cathode (the band). */
export interface DiodeDef extends PartBase {
  readonly kind: 'diode';
  readonly vf: number;
  /** Series resistance once it conducts, ohms. */
  readonly ohms: number;
  readonly glass: boolean;
}

/** Three legs in a row: end, wiper, end. `value` is the full resistance; `state` the knob, 0–1000. */
export interface PotDef extends PartBase {
  readonly kind: 'pot';
}

/** A TO-92 transistor, three legs in a row: emitter, base, collector (datasheet pins 1–3, flat face towards you). */
export interface TransistorDef extends PartBase {
  readonly kind: 'transistor';
  readonly pnp: boolean;
  /** Forward current gain. */
  readonly beta: number;
  /** Collector current it is rated for, amps. */
  readonly maxAmps: number;
}

/** SPDT slide switch, three legs in a row: the middle one joins the first (state 0) or the last (state 1). */
export interface SlideDef extends PartBase {
  readonly kind: 'slide';
}

/** A 0.56" seven-segment digit straddling the channel, pinned like a 5161AS. */
export interface DisplayDef extends PartBase {
  readonly kind: 'display';
  readonly color: LedColor;
  readonly common: 'cathode' | 'anode';
}

/** A seven-segment display's part id: '7seg-cc' and '7seg-ca' are red, other colours add theirs. */
export function displayId(common: DisplayDef['common'], color: LedColor): string {
  return `7seg-c${common === 'cathode' ? 'c' : 'a'}${color === 'red' ? '' : `-${color}`}`;
}

/** A row of LED bars in a 0.3" DIP across the channel: one side all anodes, the other all cathodes. */
export interface BarGraphDef extends PartBase {
  readonly kind: 'bargraph';
  readonly color: LedColor;
  readonly segments: number;
}

/** A bussed resistor network in a single row (SIP): pin 1 is common to a resistor to each other pin. */
export interface NetworkDef extends PartBase {
  readonly kind: 'network';
  readonly pins: number;
}

/**
 * An Arduino Nano straddling the channel like a 0.6" DIP, USB end at pin 1. It runs one of a few
 * built-in sketches (`state`) or loaded ATmega328P firmware, powered over USB whenever the simulation runs.
 */
export interface NanoDef extends PartBase {
  readonly kind: 'nano';
  readonly pins: number;
  readonly pinNames: readonly string[];
}

/**
 * A character LCD module (HD44780 controller) on a single row of 16 header pins. It rides on the
 * header above the board, its screen on the side away from the pins.
 */
export interface LcdDef extends PartBase {
  readonly kind: 'lcd';
  readonly cols: number;
  readonly rows: number;
  readonly pinNames: readonly string[];
}

/** LCD header pins 1–16. */
export const LCD_PIN_NAMES: readonly string[] = [
  'VSS',
  'VDD',
  'V0',
  'RS',
  'RW',
  'E',
  'D0',
  'D1',
  'D2',
  'D3',
  'D4',
  'D5',
  'D6',
  'D7',
  'A',
  'K',
];

export type PartDef =
  | DipDef
  | LedDef
  | ResistorDef
  | PowerDef
  | ButtonDef
  | SwitchDef
  | CapacitorDef
  | DiodeDef
  | PotDef
  | SlideDef
  | TransistorDef
  | DisplayDef
  | NanoDef
  | BarGraphDef
  | NetworkDef
  | LcdDef;

/**
 * Where each LED colour starts to conduct, volts; on top of this its series resistance adds about
 * 0.1–0.2 V at normal currents. Red is fitted to ngspice's common red LED model: 1.82 V at 14.5 mA
 * through 220 Ω from 5 V.
 */
export const LED_VF: Readonly<Record<LedColor, number>> = { red: 1.64, yellow: 2.0, green: 2.1, blue: 2.9, white: 2.9 };

/** Seven-segment pins (1–10) of segments a–g and the decimal point. The two common pins are 3 and 8. */
export const SEGMENT_PINS: readonly number[] = [7, 6, 4, 2, 1, 9, 10, 5];
export const SEGMENT_NAMES: readonly string[] = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'dp'];

/** Nano header pins 1–30, counted like a DIP from TX at the USB end. */
export const NANO_PIN_NAMES: readonly string[] = [
  'D1/TX',
  'D0/RX',
  'RST',
  'GND',
  'D2',
  'D3',
  'D4',
  'D5',
  'D6',
  'D7',
  'D8',
  'D9',
  'D10',
  'D11',
  'D12',
  'D13',
  '3V3',
  'AREF',
  'A0',
  'A1',
  'A2',
  'A3',
  'A4',
  'A5',
  'A6',
  'A7',
  '5V',
  'RST',
  'GND',
  'VIN',
];

/** The W65C02S, pin 1 first. */
const CPU_PINS = [
  'VPB',
  'RDY',
  'PHI1O',
  'IRQB',
  'MLB',
  'NMIB',
  'SYNC',
  'VDD',
  'A0',
  'A1',
  'A2',
  'A3',
  'A4',
  'A5',
  'A6',
  'A7',
  'A8',
  'A9',
  'A10',
  'A11',
  'VSS',
  'A12',
  'A13',
  'A14',
  'A15',
  'D7',
  'D6',
  'D5',
  'D4',
  'D3',
  'D2',
  'D1',
  'D0',
  'RWB',
  'NC',
  'BE',
  'PHI2',
  'SOB',
  'PHI2O',
  'RESB',
];

/** The 32K × 8 EEPROM and static RAM share a 28-pin pinout. */
const MEMORY_32K_PINS = [
  'A14',
  'A12',
  'A7',
  'A6',
  'A5',
  'A4',
  'A3',
  'A2',
  'A1',
  'A0',
  'IO0',
  'IO1',
  'IO2',
  'GND',
  'IO3',
  'IO4',
  'IO5',
  'IO6',
  'IO7',
  'CE',
  'A10',
  'OE',
  'A11',
  'A9',
  'A8',
  'A13',
  'WE',
  'VCC',
];

const GATES = ['1A', '1B', '1Y', '2A', '2B', '2Y', 'GND', '3Y', '3A', '3B', '4Y', '4A', '4B', 'VCC'];
const GATES_3 = ['1A', '1B', '2A', '2B', '2C', '2Y', 'GND', '3Y', '3A', '3B', '3C', '1Y', '1C', 'VCC'];

function dip(
  id: string,
  label: string,
  subtitle: string,
  pinNames: string[],
  family: DipDef['family'] = 'logic',
  wide = false,
): DipDef {
  return { kind: 'dip', id, title: id, subtitle, label, pins: pinNames.length, wide, pinNames, family };
}

function led(color: LedColor): LedDef {
  return {
    kind: 'led',
    id: `led-${color}`,
    title: `${color[0].toUpperCase()}${color.slice(1)}`,
    subtitle: '5 mm LED',
    color,
  };
}

export const PART_LIST: readonly PartDef[] = [
  dip('74LS00', 'SN74LS00N', 'Quad 2-input NAND', GATES),
  dip('74LS02', 'SN74LS02N', 'Quad 2-input NOR', [
    '1Y',
    '1A',
    '1B',
    '2Y',
    '2A',
    '2B',
    'GND',
    '3A',
    '3B',
    '3Y',
    '4A',
    '4B',
    '4Y',
    'VCC',
  ]),
  dip('74LS04', 'SN74LS04N', 'Hex inverter', [
    '1A',
    '1Y',
    '2A',
    '2Y',
    '3A',
    '3Y',
    'GND',
    '4Y',
    '4A',
    '5Y',
    '5A',
    '6Y',
    '6A',
    'VCC',
  ]),
  dip('74LS14', 'SN74LS14N', 'Hex Schmitt-trigger inverter', [
    '1A',
    '1Y',
    '2A',
    '2Y',
    '3A',
    '3Y',
    'GND',
    '4Y',
    '4A',
    '5Y',
    '5A',
    '6Y',
    '6A',
    'VCC',
  ]),
  dip('74LS08', 'SN74LS08N', 'Quad 2-input AND', GATES),
  dip('74LS10', 'SN74LS10N', 'Triple 3-input NAND', GATES_3),
  dip('74LS11', 'SN74LS11N', 'Triple 3-input AND', GATES_3),
  dip('74LS27', 'SN74LS27N', 'Triple 3-input NOR', GATES_3),
  dip('74LS32', 'SN74LS32N', 'Quad 2-input OR', GATES),
  dip('74LS86', 'SN74LS86N', 'Quad 2-input XOR', GATES),
  dip('74LS74', 'SN74LS74AN', 'Dual D flip-flop', [
    '1CLR',
    '1D',
    '1CLK',
    '1PRE',
    '1Q',
    '1Q̄',
    'GND',
    '2Q̄',
    '2Q',
    '2PRE',
    '2CLK',
    '2D',
    '2CLR',
    'VCC',
  ]),
  dip('74LS76', 'SN74LS76AN', 'Dual JK flip-flop', [
    '1CLK',
    '1PRE',
    '1CLR',
    '1J',
    'VCC',
    '2CLK',
    '2PRE',
    '2CLR',
    '2J',
    '2Q̄',
    '2Q',
    '2K',
    'GND',
    '1Q̄',
    '1Q',
    '1K',
  ]),
  dip('74LS107', 'SN74LS107AN', 'Dual JK flip-flop', [
    '1J',
    '1Q̄',
    '1Q',
    '1K',
    '2Q',
    '2Q̄',
    'GND',
    '2J',
    '2CLK',
    '2CLR',
    '2K',
    '1CLK',
    '1CLR',
    'VCC',
  ]),
  dip('74LS138', 'SN74LS138N', '3-to-8 decoder', [
    'A',
    'B',
    'C',
    'G2A',
    'G2B',
    'G1',
    'Y7',
    'GND',
    'Y6',
    'Y5',
    'Y4',
    'Y3',
    'Y2',
    'Y1',
    'Y0',
    'VCC',
  ]),
  dip('74LS139', 'SN74LS139AN', 'Dual 2-to-4 decoder', [
    '1G',
    '1A',
    '1B',
    '1Y0',
    '1Y1',
    '1Y2',
    '1Y3',
    'GND',
    '2Y3',
    '2Y2',
    '2Y1',
    '2Y0',
    '2B',
    '2A',
    '2G',
    'VCC',
  ]),
  dip('74LS47', 'SN74LS47N', 'BCD to 7-segment decoder', [
    'B',
    'C',
    'LT',
    'BI/RBO',
    'RBI',
    'D',
    'A',
    'GND',
    'e',
    'd',
    'c',
    'b',
    'a',
    'g',
    'f',
    'VCC',
  ]),
  dip('74LS125', 'SN74LS125AN', 'Quad tri-state buffer', [
    '1G',
    '1A',
    '1Y',
    '2G',
    '2A',
    '2Y',
    'GND',
    '3Y',
    '3A',
    '3G',
    '4Y',
    '4A',
    '4G',
    'VCC',
  ]),
  dip('74LS157', 'SN74LS157N', 'Quad 2-to-1 mux', [
    'S',
    '1A',
    '1B',
    '1Y',
    '2A',
    '2B',
    '2Y',
    'GND',
    '3Y',
    '3B',
    '3A',
    '4Y',
    '4B',
    '4A',
    'G',
    'VCC',
  ]),
  dip('74LS161', 'SN74LS161AN', '4-bit counter', [
    'CLR',
    'CLK',
    'A',
    'B',
    'C',
    'D',
    'ENP',
    'GND',
    'LOAD',
    'ENT',
    'QD',
    'QC',
    'QB',
    'QA',
    'RCO',
    'VCC',
  ]),
  dip('74LS193', 'SN74LS193N', '4-bit up/down counter', [
    'B',
    'QB',
    'QA',
    'DOWN',
    'UP',
    'QC',
    'QD',
    'GND',
    'D',
    'C',
    'LOAD',
    'CO',
    'BO',
    'CLR',
    'A',
    'VCC',
  ]),
  dip('74LS173', 'SN74LS173AN', '4-bit register', [
    'M',
    'N',
    '1Q',
    '2Q',
    '3Q',
    '4Q',
    'CLK',
    'GND',
    'G1',
    'G2',
    '4D',
    '3D',
    '2D',
    '1D',
    'CLR',
    'VCC',
  ]),
  dip('74LS245', 'SN74LS245N', 'Octal bus transceiver', [
    'DIR',
    'A1',
    'A2',
    'A3',
    'A4',
    'A5',
    'A6',
    'A7',
    'A8',
    'GND',
    'B8',
    'B7',
    'B6',
    'B5',
    'B4',
    'B3',
    'B2',
    'B1',
    'OE',
    'VCC',
  ]),
  dip('74LS273', 'SN74LS273N', 'Octal D flip-flop', [
    'CLR',
    '1Q',
    '1D',
    '2D',
    '2Q',
    '3Q',
    '3D',
    '4D',
    '4Q',
    'GND',
    'CLK',
    '5Q',
    '5D',
    '6D',
    '6Q',
    '7Q',
    '7D',
    '8D',
    '8Q',
    'VCC',
  ]),
  dip('74LS283', 'SN74LS283N', '4-bit adder', [
    'S2',
    'B2',
    'A2',
    'S1',
    'A1',
    'B1',
    'C0',
    'GND',
    'C4',
    'S4',
    'B4',
    'A4',
    'S3',
    'A3',
    'B3',
    'VCC',
  ]),
  dip('74HC595', 'SN74HC595N', '8-bit shift register', [
    'QB',
    'QC',
    'QD',
    'QE',
    'QF',
    'QG',
    'QH',
    'GND',
    "QH'",
    'SRCLR',
    'SRCLK',
    'RCLK',
    'OE',
    'SER',
    'QA',
    'VCC',
  ]),
  dip('NE555', 'NE555P', 'Timer', ['GND', 'TRIG', 'OUT', 'RESET', 'CTRL', 'THR', 'DIS', 'VCC'], 'timing'),
  dip(
    '74LS189',
    'SN74LS189N',
    '64-bit RAM (16 × 4)',
    ['A0', 'ME', 'WE', 'D1', 'Q̄1', 'D2', 'Q̄2', 'GND', 'Q̄3', 'D3', 'Q̄4', 'D4', 'A3', 'A2', 'A1', 'VCC'],
    'memory',
  ),
  dip('W65C02S', 'W65C02S6TPG-14', '8-bit microprocessor', CPU_PINS, 'cpu', true),
  dip('AT28C256', 'AT28C256-15PU', '32K × 8 EEPROM', MEMORY_32K_PINS, 'memory', true),
  dip('62256', 'HM62256BLP-7', '32K × 8 static RAM', MEMORY_32K_PINS, 'memory', true),
  dip(
    '28C16',
    'AT28C16-15PC',
    '2K × 8 EEPROM',
    [
      'A7',
      'A6',
      'A5',
      'A4',
      'A3',
      'A2',
      'A1',
      'A0',
      'IO0',
      'IO1',
      'IO2',
      'GND',
      'IO3',
      'IO4',
      'IO5',
      'IO6',
      'IO7',
      'CE',
      'A10',
      'OE',
      'WE',
      'A9',
      'A8',
      'VCC',
    ],
    'memory',
    true,
  ),
  led('red'),
  led('green'),
  led('yellow'),
  led('blue'),
  led('white'),
  { kind: 'resistor', id: 'resistor', title: 'Resistor', subtitle: '¼ W axial' },
  { kind: 'capacitor', id: 'cap-ceramic', title: 'Ceramic capacitor', subtitle: 'Not polarised', style: 'ceramic' },
  {
    kind: 'capacitor',
    id: 'cap-electrolytic',
    title: 'Electrolytic capacitor',
    subtitle: 'Polarised',
    style: 'electrolytic',
  },
  { kind: 'pot', id: 'pot', title: 'Potentiometer', subtitle: 'Turn the knob' },
  { kind: 'diode', id: '1N4148', title: '1N4148', subtitle: 'Signal diode', vf: 0.62, ohms: 4, glass: true },
  { kind: 'diode', id: '1N4007', title: '1N4007', subtitle: 'Rectifier diode', vf: 0.7, ohms: 0.3, glass: false },
  { kind: 'transistor', id: '2N3904', title: '2N3904', subtitle: 'NPN, 200 mA', pnp: false, beta: 150, maxAmps: 0.2 },
  { kind: 'transistor', id: '2N2222', title: '2N2222', subtitle: 'NPN, 600 mA', pnp: false, beta: 150, maxAmps: 0.6 },
  { kind: 'transistor', id: '2N3906', title: '2N3906', subtitle: 'PNP, 200 mA', pnp: true, beta: 120, maxAmps: 0.2 },
  { kind: 'power', id: 'power', title: 'Power module', subtitle: '5 V or 3.3 V per side' },
  { kind: 'button', id: 'button', title: 'Push button', subtitle: '6 mm tactile switch' },
  { kind: 'slide', id: 'slide-switch', title: 'Slide switch', subtitle: 'SPDT' },
  { kind: 'dipswitch', id: 'dip-switch-4', title: 'DIP switch', subtitle: '4 positions', positions: 4 },
  { kind: 'dipswitch', id: 'dip-switch-8', title: 'DIP switch', subtitle: '8 positions', positions: 8 },
  ...(['cathode', 'anode'] as const).flatMap((common) =>
    (['red', 'green', 'yellow', 'blue', 'white'] as const).map((color): DisplayDef => ({
      kind: 'display',
      id: displayId(common, color),
      title: '7-segment display',
      subtitle: `Common ${common}`,
      color,
      common,
    })),
  ),
  { kind: 'bargraph', id: 'bargraph', title: 'LED bar graph', subtitle: '10 segments', color: 'red', segments: 10 },
  {
    kind: 'network',
    id: 'resistor-network',
    title: 'Resistor network',
    subtitle: '8 resistors, pin 1 common',
    pins: 9,
  },
  { kind: 'nano', id: 'nano', title: 'Arduino Nano', subtitle: 'ATmega328P', pins: 30, pinNames: NANO_PIN_NAMES },
  {
    kind: 'lcd',
    id: 'lcd-1602',
    title: 'LCD',
    subtitle: '16 × 2 characters',
    cols: 16,
    rows: 2,
    pinNames: LCD_PIN_NAMES,
  },
];

export const PARTS: Readonly<Record<string, PartDef>> = Object.fromEntries(PART_LIST.map((p) => [p.id, p]));

export const RESISTOR_VALUES: readonly number[] = [220, 330, 470, 1000, 2200, 4700, 10000, 47000, 100000, 1000000];
export const CERAMIC_VALUES: readonly number[] = [100e-12, 1e-9, 10e-9, 100e-9, 1e-6];
export const ELECTROLYTIC_VALUES: readonly number[] = [
  1e-6, 2.2e-6, 4.7e-6, 10e-6, 22e-6, 47e-6, 100e-6, 220e-6, 470e-6, 1000e-6,
];
export const POT_VALUES: readonly number[] = [1000, 10000, 100000, 1000000];
/** Resistor networks: LED current limiting, and pull-ups or pull-downs. */
export const NETWORK_VALUES: readonly number[] = [220, 330, 470, 1000, 4700, 10000];
/** LED sizes, mm. 3 mm ones fit side by side in neighbouring columns. */
export const LED_SIZES: readonly number[] = [5, 3];

/** What a freshly placed part holds in `value`. */
export function defaultValue(def: PartDef): number | undefined {
  switch (def.kind) {
    case 'led':
      return 5;
    case 'resistor':
      return 470;
    case 'capacitor':
      return def.style === 'ceramic' ? 100e-9 : 1e-6;
    case 'pot':
      return 1000000;
    case 'network':
      return 1000;
    default:
      return undefined;
  }
}

/** How many legs a part has (and so how many holes it takes). */
export function pinCount(def: PartDef): number {
  switch (def.kind) {
    case 'dip':
    case 'nano':
    case 'network':
      return def.pins;
    case 'bargraph':
      return def.segments * 2;
    case 'dipswitch':
      return def.positions * 2;
    case 'pot':
    case 'slide':
    case 'transistor':
      return 3;
    case 'lcd':
      return 16;
    case 'button':
    case 'power':
      return 4;
    case 'display':
      return 10;
    default:
      return 2;
  }
}

/** Pin count and width of the parts that sit across the centre channel like a DIP. */
export function dipFootprint(def: PartDef): { pins: number; wide: boolean } | null {
  if (def.kind === 'dip') return def;
  if (def.kind === 'dipswitch') return { pins: def.positions * 2, wide: false };
  if (def.kind === 'display') return { pins: 10, wide: true };
  if (def.kind === 'bargraph') return { pins: def.segments * 2, wide: false };
  if (def.kind === 'nano') return { pins: def.pins, wide: true };
  return null;
}

/**
 * Holes for each pin of a DIP straddling the centre channel, pin 1 first.
 * Unflipped, the notch points left and pin 1 is bottom-left (row f), as in a datasheet's top view.
 * Wide packages use rows d and h, six holes apart.
 */
export function dipPinHoles(
  def: { pins: number; wide: boolean },
  startCol: number,
  flipped: boolean,
): { row: TerminalRow; col: number }[] {
  const n = def.pins / 2;
  const near: TerminalRow = def.wide ? 'h' : 'f';
  const far: TerminalRow = def.wide ? 'd' : 'e';
  const pins: { row: TerminalRow; col: number }[] = [];
  for (let i = 0; i < n; i++)
    pins.push(flipped ? { row: far, col: startCol + n - 1 - i } : { row: near, col: startCol + i });
  for (let i = 0; i < n; i++)
    pins.push(flipped ? { row: near, col: startCol + i } : { row: far, col: startCol + n - 1 - i });
  return pins;
}

const BAND_NAMES = ['black', 'brown', 'red', 'orange', 'yellow', 'green', 'blue', 'violet', 'grey', 'white'];

/** Four-band colour code: two digits, a multiplier, then gold for 5 % tolerance. */
export function resistorBands(ohms: number): string[] {
  let exp = Math.floor(Math.log10(ohms)) - 1;
  let sig = Math.round(ohms / 10 ** exp);
  if (sig >= 100) {
    sig = Math.round(sig / 10);
    exp += 1;
  }
  const multiplier = exp >= 0 ? BAND_NAMES[exp] : exp === -1 ? 'gold' : 'silver';
  return [BAND_NAMES[Math.floor(sig / 10)], BAND_NAMES[sig % 10], multiplier, 'gold'];
}

export function formatOhms(ohms: number): string {
  const trim = (v: number): string => String(Number(v.toFixed(2)));
  if (ohms >= 1e6) return `${trim(ohms / 1e6)} MΩ`;
  if (ohms >= 1e3) return `${trim(ohms / 1e3)} kΩ`;
  return `${trim(ohms)} Ω`;
}

/** Capacitance the way kits label it: µF from 0.01 µF up, then nF and pF. */
export function formatFarads(farads: number): string {
  const trim = (v: number): string => String(Number(v.toPrecision(3)));
  if (farads >= 1e-8 * 0.999) return `${trim(farads * 1e6)} µF`;
  if (farads >= 1e-9 * 0.999) return `${trim(farads * 1e9)} nF`;
  return `${trim(farads * 1e12)} pF`;
}

/** The three-digit code printed on a ceramic capacitor: 104 is 10 × 10⁴ pF = 0.1 µF. */
/** A resistor network's three-digit value code: two figures and a count of zeros (102 is 1 kΩ). */
export function ohmsCode(ohms: number): string {
  const exp = Math.max(0, Math.floor(Math.log10(ohms) + 1e-9) - 1);
  return `${Math.round(ohms / 10 ** exp)}${exp}`;
}

export function capacitorCode(farads: number): string {
  const pf = farads * 1e12;
  if (pf < 10) return `${Math.round(pf)}`;
  const exp = Math.floor(Math.log10(pf) + 1e-9) - 1;
  return `${Math.round(pf / 10 ** exp)}${exp}`;
}
