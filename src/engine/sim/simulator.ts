// Runs the circuit through time. Every change (an edit, a button, a switch) rebuilds the network and
// lets the chips settle. As time passes, clusters with capacitors predict when a chip input or a
// diode is next crossed, and only then is anything worked out again. At each such moment the chips
// react in passes, one gate delay each, until nothing changes, so flip-flops see clean edges.

import type { CircuitDoc, HoleRef, Id, PartDoc, SupplyDoc } from '../circuit';
import type { Connectivity } from '../netlist';
import { SHUNT_A, SHUNT_MA } from '../meter';
import { LED_VF, PARTS, powerSideVolts, SEGMENT_PINS, type PartDef, type TransistorDef } from '../parts';
import { decodeBytes, encodeBytes } from '../roms';
import type { Cpu65 } from './cpu65';
import {
  CHIP_MODELS,
  FAMILIES,
  type Bit,
  type BusRecord,
  type BusTap,
  type ChipIO,
  type ChipModel,
  type ChipState,
  type Drive,
  type Family,
  type FamilyTraits,
} from './chips';
import { Network } from './electrical';
import { NANO_LED_HEADER, NANO_MODEL, NANO_POWER } from './nano';
import { LCD_BACKLIGHT, LCD_MODEL, LCD_V0, lcdReading, type LcdReading } from './lcd';

export { decodeBytes, encodeBytes };

export const SUPPLY_VOLTS = 5;
/** Closed switch contacts, 10 mΩ. */
const G_CONTACT = 100;
/** LED series resistance. */
const G_LED = 1 / 12;
const MAX_PASSES = 400;
/** A CPU's bus log keeps about this many cycles; the oldest half goes when it's full. */
const BUS_LOG_MAX = 8192;
/** Current at which an LED looks fully bright, and where it would start to burn out. */
const LED_FULL = 0.012;
const LED_LIMIT = 0.045;
/** Logic inputs switch this far either side of their threshold, so a slow edge can't chatter. */
const HYSTERESIS = 0.02;
/** Volts above the chip's ground at which an input reading `chip.levels[pin]` flips. */
function switchPoint(chip: ChipRun, pin: number): number {
  const { schmitt } = chip.model;
  if (schmitt) return chip.levels[pin] ? schmitt.fall : schmitt.rise;
  return chip.fam.threshold + (chip.levels[pin] ? -HYSTERESIS : HYSTERESIS);
}
/**
 * What every small-signal transistor here is made of: junctions conducting from 0.65 V (base–emitter) and
 * 0.58 V (base–collector), which leaves about 0.07 V across a saturated one, and reverse gain of 3.
 */
const TRANSISTOR_JUNCTIONS = { betaR: 3, emitter: { vf: 0.65, ohms: 50 }, collector: { vf: 0.58, ohms: 5 } };

/** Adds a transistor (legs emitter, base, collector); returns its index in the network. */
function addTransistor(net: Network, def: TransistorDef, nets: readonly number[]): number {
  return net.addTransistor(nets[2], nets[1], nets[0], { ...TRANSISTOR_JUNCTIONS, pnp: def.pnp, betaF: def.beta });
}

/**
 * Adds a part made only of resistance, contacts and diodes: everything but chips, capacitors,
 * transistors and power. `light` hears of each diode that glows (an LED, a segment, a bar).
 * False if the part isn't one of those.
 */
function addPassive(
  net: Network,
  part: PartDoc,
  def: PartDef,
  nets: readonly number[],
  pressed: ReadonlySet<Id>,
  light: (diode: number, segment: number) => void = () => {},
): boolean {
  switch (def.kind) {
    case 'resistor':
      net.addBranch(nets[0], nets[1], 1 / (part.value ?? 470));
      return true;
    case 'led':
      light(net.addDiode(nets[0], nets[1], LED_VF[def.color], G_LED), -1);
      return true;
    case 'diode':
      net.addDiode(nets[0], nets[1], def.vf, 1 / def.ohms);
      return true;
    case 'pot': {
      const ohms = part.value ?? 1e6;
      const at = (part.state ?? 500) / 1000;
      net.addBranch(nets[0], nets[1], 1 / (ohms * Math.max(at, POT_END)));
      net.addBranch(nets[1], nets[2], 1 / (ohms * Math.max(1 - at, POT_END)));
      return true;
    }
    case 'slide':
      net.addBranch(nets[1], (part.state ?? 0) & 1 ? nets[2] : nets[0], G_CONTACT);
      return true;
    case 'button':
      net.addBranch(nets[0], nets[1], G_CONTACT);
      net.addBranch(nets[2], nets[3], G_CONTACT);
      if (pressed.has(part.id)) net.addBranch(nets[0], nets[2], G_CONTACT);
      return true;
    case 'dipswitch':
      for (let s = 0; s < def.positions; s++) {
        if (((part.state ?? 0) >> s) & 1) net.addBranch(nets[s], nets[2 * def.positions - 1 - s], G_CONTACT);
      }
      return true;
    case 'display': {
      // The two common pins are joined inside; each segment is an LED to (or from) them.
      const common = nets[2];
      net.addBranch(nets[2], nets[7], G_CONTACT);
      SEGMENT_PINS.forEach((pin, s) => {
        const seg = nets[pin - 1];
        light(
          def.common === 'cathode'
            ? net.addDiode(seg, common, LED_VF[def.color], G_LED)
            : net.addDiode(common, seg, LED_VF[def.color], G_LED),
          s,
        );
      });
      return true;
    }
    case 'bargraph':
      // Pins 1–10 are the anodes; each bar's cathode is straight across, pin 20 down to 11.
      for (let s = 0; s < def.segments; s++)
        light(net.addDiode(nets[s], nets[2 * def.segments - 1 - s], LED_VF[def.color], G_LED), s);
      return true;
    case 'network':
      for (let k = 1; k < def.pins; k++) net.addBranch(nets[0], nets[k], 1 / (part.value ?? 1000));
      return true;
    default:
      return false;
  }
}

/**
 * What a meter on resistance, diode test or continuity sees across its leads: the volts from V to
 * COM with the meter driving V from `volts` through `ohms` and nothing else powered. Chips and
 * power are left out (unpowered, their pins hardly conduct), capacitors are open (charged up),
 * and a meter's own current jacks keep their shunts. A real meter reads nonsense on a live
 * circuit; this reads as if the power were off. `volts` itself if the leads aren't joined.
 */
export function ohmmeterVolts(
  doc: CircuitDoc,
  conn: Connectivity,
  meterId: Id,
  source: { volts: number; ohms: number },
  pressed: ReadonlySet<Id> = new Set(),
): number {
  const index = new Map<number, number>();
  const netOf = (ref: HoleRef): number => {
    const root = conn.netOf(ref);
    if (root < 0) return -1;
    let i = index.get(root);
    if (i === undefined) index.set(root, (i = index.size));
    return i;
  };
  const v = netOf({ board: meterId, hole: 'V' });
  const com = netOf({ board: meterId, hole: 'COM' });
  if (
    v < 0 ||
    com < 0 ||
    conn.members({ board: meterId, hole: 'V' }).length < 2 ||
    conn.members({ board: meterId, hole: 'COM' }).length < 2
  )
    return source.volts;
  if (v === com) return 0;
  const partNets = doc.parts.map((p) => p.pins.map(netOf));
  // The meter's own source is one more net, held at its test voltage.
  const src = index.size;
  const count = src + 1;
  const net = new Network(
    count,
    new Map([
      [com, 0],
      [src, source.volts],
    ]),
  );
  net.addBranch(src, v, 1 / source.ohms);
  doc.parts.forEach((part, k) => {
    const def = PARTS[part.def];
    const nets = partNets[k];
    if (!def || nets.some((n) => n < 0)) return;
    if (def.kind === 'transistor') addTransistor(net, def, nets);
    else addPassive(net, part, def, nets, pressed);
  });
  for (const meter of doc.meters ?? []) {
    const c = netOf({ board: meter.id, hole: 'COM' });
    for (const [hole, ohms] of [
      ['mA', SHUNT_MA],
      ['A', SHUNT_A],
    ] as const) {
      const n = netOf({ board: meter.id, hole });
      if (c >= 0 && n >= 0 && n !== c && n < src && c < src) net.addBranch(n, c, 1 / ohms);
    }
  }
  net.compile(0);
  net.solveDirty(0, () => {});
  const out = net.volts[v];
  return Number.isFinite(out) ? out : source.volts;
}
/** A potentiometer's track never quite reaches zero ohms at its ends. */
const POT_END = 0.002;
/** Electrolytic capacitors complain past this much reverse voltage. */
const REVERSE_LIMIT = 1;
/** Supply voltage past which each family is damaged (absolute maximum ratings). */
const MAX_VCC: Record<Family, number> = { LS: 7, HC: 7, CMOS: 6.25, NE555: 18, AVR: 6, C02: 7 };
/** What a chip draws from its supply just being powered, amps. */
const IDLE_AMPS: Record<Family, number> = { LS: 0.008, HC: 0.00005, CMOS: 0.03, NE555: 0.003, AVR: 0.02, C02: 0.004 };
/** What a Nano's 3.3 V pin puts out. */
const NANO_3V3 = 3.3;
/** More events than this within a microsecond of circuit time means it's switching too fast to follow. */
const ZENO_EVENTS = 20000;
const noop = (): void => {};
/** How close (as a fraction of the limit) a bench supply holds its current before it counts as at the limit. */
const CC_TOLERANCE = 0.002;
/** While a supply holds its current, how soon it looks again (seconds), and the longest it waits once steady. */
const CC_RECHECK = 1e-4;
const CC_RECHECK_MAX = 0.05;

export interface LedReading {
  current: number;
  brightness: number;
  overCurrent: boolean;
}

export interface ChipReading {
  powered: boolean;
  problems: string[];
}

export interface Problem {
  partId?: Id;
  message: string;
  /**
   * Set when it would harm the part: how bad it is (amps, volts), or 0 when there's no measure. Once
   * seen, it stays listed at its worst until the circuit changes or the power goes off, even if it only
   * happens while a blinking output is high.
   */
  harm?: number;
}

export interface SupplyReading {
  volts: number;
  amps: number;
  /** Holding its current at the limit, with the voltage lowered to do it (constant current). */
  cc: boolean;
}

interface SupplyRun {
  doc: SupplyDoc;
  plus: number;
  minus: number;
  volts: number;
  shared: boolean;
  shorted: boolean;
}

/** Amps into a transistor's base and collector (out of them for a PNP). */
export interface TransistorReading {
  base: number;
  collector: number;
  overCurrent: boolean;
}

/** A microcontroller board: its serial output and its little lights. */
export interface McuReading {
  serial: string;
  /** How far its sketch is through its job, 0–1, if it has one. */
  progress?: number;
  /** The L LED (pin 13) and the TX LED. */
  led: boolean;
  tx: boolean;
}

export interface SimResult {
  /** At least one power module is switched on (and not shorted). */
  live: boolean;
  /** Circuit time, seconds. */
  time: number;
  /** Voltage of the net a hole belongs to: null if nothing electrical is there, NaN if floating. */
  volts(ref: HoleRef): number | null;
  leds: Map<Id, LedReading>;
  /** Seven-segment displays: segments a–g, then the decimal point. Bar graphs: bar 1 first. */
  segments: Map<Id, LedReading[]>;
  chips: Map<Id, ChipReading>;
  /** Voltage across each capacitor, first leg minus second (+ minus − on an electrolytic). */
  capacitors: Map<Id, number>;
  transistors: Map<Id, TransistorReading>;
  /** Bench supplies with something wired to them. */
  supplies: Map<Id, SupplyReading>;
  /** Arduino Nanos, running or as they were left when the simulation stopped. */
  mcus: Map<Id, McuReading>;
  /** Character LCDs whose controller is powered: what's on the screen. Their backlights are in `segments`. */
  lcds: Map<Id, LcdReading>;
  problems: Problem[];
  settled: boolean;
}

export interface Budget {
  /** performance.now() time to stop by. */
  deadline?: number;
  maxEvents?: number;
  /** Checked after each moment something switches: true stops the circuit right there. */
  stop?: () => boolean;
}

/** A chip while the circuit runs; it is also what the chip model reads its pins through. */
class ChipRun implements ChipIO {
  powered = false;
  state: ChipState | null = null;
  dirty = false;
  vcc = 0;
  gnd = 0;
  /** Per pin: 0 or 1 when driving, -1 when letting go. */
  readonly drives: Int8Array;
  readonly levels: Uint8Array;
  readonly prev: Uint8Array;
  readonly slots: Int32Array;
  readonly isInput: Uint8Array;
  readonly pullups: Uint8Array;
  readonly bias: ({ volts: (vcc: number) => number; g: number } | undefined)[] = [];

  constructor(
    readonly part: PartDoc,
    readonly model: ChipModel,
    readonly fam: FamilyTraits,
    /** Net per pin number (index 0 unused). */
    readonly nets: Int32Array,
    private readonly network: Network,
    private readonly onWrite: (id: Id) => void,
    private readonly clock: () => number,
  ) {
    const size = nets.length;
    this.drives = new Int8Array(size).fill(-1);
    this.levels = new Uint8Array(size);
    this.prev = new Uint8Array(size);
    this.slots = new Int32Array(size).fill(-1);
    this.isInput = new Uint8Array(size);
    this.pullups = new Uint8Array(size);
    for (const p of model.inputs) this.isInput[p] = 1;
    for (const b of model.bias ?? []) this.bias[b.pin] = b;
    for (let pin = 1; pin < size; pin++) {
      const pulls = this.isInput[pin] || model.outputs.includes(pin) || this.bias[pin];
      if (pulls && nets[pin] >= 0) this.slots[pin] = network.addSlot(nets[pin]);
    }
  }

  get now(): number {
    return this.clock();
  }

  get(pin: number): Bit {
    return this.levels[pin] as Bit;
  }

  rose(pin: number): boolean {
    return this.prev[pin] === 0 && this.levels[pin] === 1;
  }

  fell(pin: number): boolean {
    return this.prev[pin] === 1 && this.levels[pin] === 0;
  }

  volts(pin: number): number {
    const n = this.nets[pin];
    return n < 0 ? NaN : this.network.volts[n] - this.gnd;
  }

  steady(pin: number): number {
    const n = this.nets[pin];
    return n < 0 ? NaN : this.network.steady[n] - this.gnd;
  }

  set(pin: number, value: Drive): void {
    this.drives[pin] = value === null ? -1 : value;
  }

  pull(pin: number, enabled: boolean): void {
    this.pullups[pin] = enabled ? 1 : 0;
  }

  wrote(): void {
    this.onWrite(this.part.id);
  }
}

interface Remembered {
  state: ChipState;
  drives: Int8Array;
  levels: Uint8Array;
  prev: Uint8Array;
}

/** Something that lights up: an LED, or one segment of a display. */
interface Light {
  id: Id;
  diode: number;
  /** Segment of a display (a–g, dp), or -1 for an LED. */
  segment: number;
}

export class Simulator {
  /** Circuit time, seconds. */
  time = 0;

  private net: Network | null = null;
  private conn: Connectivity | null = null;
  private netIndex = new Map<number, number>();
  private fixed = new Map<number, number>();
  private live = false;
  private chips: ChipRun[] = [];
  /** Chips that do things by themselves over time (microcontrollers). */
  private clocked: ChipRun[] = [];
  /** What each Nano last showed, kept after the power goes off like a serial monitor keeps its text. */
  private mcuLast = new Map<Id, McuReading>();
  /** Per net: chips with an input, VCC or GND there. */
  private readers: ChipRun[][] = [];
  /** Per net: chip pins whose thresholds are watched there. */
  private watched: { chip: ChipRun; pin: number }[][] = [];
  private dirty: ChipRun[] = [];
  private spare: ChipRun[] = [];
  private lights: Light[] = [];
  private caps: { id: Id; index: number; polarised: boolean }[] = [];
  private transistors: { id: Id; def: TransistorDef; index: number }[] = [];
  private staticProblems: Problem[] = [];
  /** Harmful problems seen since the last rebuild, by part and kind, each at its worst. */
  private harms = new Map<string, { problem: Problem; amount: number }>();
  /**
   * Bench supplies in use. Each holds its + at the set voltage until the circuit would draw more than
   * the limit, then lowers it to hold the current at the limit (`volts` is what it's giving now).
   * `shared`: something else holds its + too, so it can't move. `shorted`: its leads are joined.
   */
  private supplies: SupplyRun[] = [];
  /** When a supply holding its current looks again, and how long it waits between looks. */
  private ccWake = Infinity;
  private ccGap = CC_RECHECK;
  private oscillating = false;
  private tooFast = false;

  /** Chip state carried across edits while the power stays on, like a live breadboard. */
  private memory = new Map<Id, Remembered>();
  private capVolts = new Map<Id, number>();
  /** EEPROM contents, kept through power cycles, and the document text they were last in step with. */
  private nvram = new Map<Id, { bytes: Uint8Array; source: string | undefined }>();
  private written = new Set<Id>();

  /** Lights are shown averaged over each frame, so fast blinking reads as dimmer, like it does to the eye. */
  private windowStart = 0;
  private windowCharge = new Float64Array(0);
  private average: Float64Array | null = null;

  reset(): void {
    this.memory.clear();
    this.capVolts.clear();
    this.net = null;
  }

  /**
   * Rebuilds the circuit after a change and lets it settle, carrying on from where it was. `on` starts
   * or stops every power module at once; left out, each module's own switch (its state) decides.
   */
  update(doc: CircuitDoc, conn: Connectivity, pressed: ReadonlySet<Id> = new Set(), on?: boolean): void {
    this.keepState();
    this.harms.clear();
    this.conn = conn;
    const netIndex = (this.netIndex = new Map());
    const netOf = (ref: HoleRef): number => {
      const root = conn.netOf(ref);
      if (root < 0) return -1;
      let i = netIndex.get(root);
      if (i === undefined) netIndex.set(root, (i = netIndex.size));
      return i;
    };
    const partNets = doc.parts.map((p) => p.pins.map(netOf));

    const problems: Problem[] = [];
    const fixed = new Map<number, number>();
    let live = false;
    let shorted = false;
    const fix = (n: number, v: number, partId: Id, message: string): void => {
      const before = fixed.get(n);
      if (before !== undefined && before !== v && !shorted) {
        shorted = true;
        problems.push({ partId, message });
      }
      fixed.set(n, v);
    };
    doc.parts.forEach((part, k) => {
      const nets = partNets[k];
      if (PARTS[part.def]?.kind !== 'power' || !(on ?? (part.state ?? 0) & 1) || nets.some((n) => n < 0)) return;
      live = true;
      // Each side's jumper picks what its + rail gets, or leaves it unconnected; − is always ground.
      const plus = ([0, 1] as const).map((side) => powerSideVolts(part.state, side));
      const message =
        plus[0] !== null && plus[1] !== null && plus[0] !== plus[1]
          ? 'Short circuit: + is wired to −, or the 5 V side to the 3.3 V side. Power cut.'
          : 'Short circuit: + is wired to −. Power cut.';
      [plus[0], 0, plus[1], 0].forEach((v, i) => {
        if (v !== null) fix(nets[i], v, part.id, message);
      });
    });
    // A Nano is powered over USB whenever the simulation runs, and its 5V and 3V3 pins power the board.
    doc.parts.forEach((part, k) => {
      const nets = partNets[k];
      if (PARTS[part.def]?.kind !== 'nano' || on === false || nets.some((n) => n < 0)) return;
      live = true;
      const message = 'Short circuit on the 5V, 3V3 or GND pin. Power cut.';
      fix(nets[NANO_POWER.v5 - 1], SUPPLY_VOLTS, part.id, message);
      fix(nets[NANO_POWER.v3 - 1], NANO_3V3, part.id, message);
      for (const pin of NANO_POWER.gnd) fix(nets[pin - 1], 0, part.id, message);
    });
    this.supplies = [];
    for (const supply of doc.supplies ?? []) {
      const plus = { board: supply.id, hole: '+' };
      const minus = { board: supply.id, hole: '-' };
      // A supply only counts once both its terminals are wired to something.
      if (on === false || supply.off || conn.members(plus).length < 2 || conn.members(minus).length < 2) continue;
      live = true;
      const pn = netOf(plus);
      const mn = netOf(minus);
      // Leads joined: a real supply just sits at its current limit with nothing across it.
      const joined = pn === mn;
      const s: SupplyRun = {
        doc: supply,
        plus: pn,
        minus: mn,
        volts: joined ? 0 : supply.volts,
        shared: fixed.has(pn),
        shorted: joined,
      };
      this.supplies.push(s);
      const message = 'Short circuit: + is wired to another supply. Power cut.';
      if (!joined) fix(s.plus, supply.volts, supply.id, message);
      fix(s.minus, 0, supply.id, message);
    }
    if (shorted) {
      fixed.clear();
      this.supplies = [];
      live = false;
    }
    this.fixed = fixed;
    this.live = live;
    this.staticProblems = problems;
    this.oscillating = false;
    this.tooFast = false;
    this.chips = [];
    this.clocked = [];
    this.lights = [];
    this.caps = [];
    this.transistors = [];
    for (const id of this.nvram.keys()) if (!doc.parts.some((p) => p.id === id)) this.nvram.delete(id);

    if (!live) {
      // Without power every chip forgets, and capacitors drain away.
      this.net = null;
      this.memory.clear();
      this.capVolts.clear();
      this.resetWindow();
      return;
    }

    const net = (this.net = new Network(netIndex.size, fixed));
    const count = netIndex.size;
    this.readers = Array.from({ length: count }, () => []);
    this.watched = Array.from({ length: count }, () => []);
    doc.parts.forEach((part, k) => {
      const def = PARTS[part.def];
      const nets = partNets[k];
      if (!def || nets.some((n) => n < 0)) return;
      switch (def.kind) {
        case 'transistor':
          this.transistors.push({ id: part.id, def, index: addTransistor(net, def, nets) });
          break;
        case 'capacitor':
          this.caps.push({
            id: part.id,
            index: net.addCapacitor(nets[0], nets[1], part.value ?? 1e-6, this.capVolts.get(part.id) ?? 0),
            polarised: def.style === 'electrolytic',
          });
          break;
        case 'dip': {
          const model = CHIP_MODELS[def.id];
          if (model) this.addChip(part, model, nets);
          break;
        }
        case 'nano':
          this.addChip(part, NANO_MODEL, nets);
          break;
        case 'lcd': {
          this.addChip(part, LCD_MODEL, nets);
          // The backlight: an LED behind the module's own resistor, lit or not whatever the controller does.
          const { anode, cathode, vf, ohms } = LCD_BACKLIGHT;
          this.lights.push({
            id: part.id,
            diode: net.addDiode(nets[anode - 1], nets[cathode - 1], vf, 1 / ohms),
            segment: 0,
          });
          break;
        }
        default:
          addPassive(net, part, def, nets, pressed, (diode, segment) =>
            this.lights.push({ id: part.id, diode, segment }),
          );
      }
    });
    // Each meter's current jacks are joined to COM through its shunts, whatever its dial says.
    for (const meter of doc.meters ?? []) {
      const com = netOf({ board: meter.id, hole: 'COM' });
      for (const [hole, ohms] of [
        ['mA', SHUNT_MA],
        ['A', SHUNT_A],
      ] as const) {
        const n = netOf({ board: meter.id, hole });
        if (com >= 0 && n >= 0 && n !== com) net.addBranch(n, com, 1 / ohms);
      }
    }

    net.compile(this.time);
    for (const chip of this.chips) this.mark(chip);
    if (!this.settle()) this.oscillating = true;
    this.ccWake = Infinity;
    this.ccGap = CC_RECHECK;
    this.regulate();
    net.predict(this.time, this.thresholdsOf);
    this.resetWindow();
    this.watcher?.();
  }

  /** Called whenever something switches (and after every rebuild), at that moment's circuit time. */
  watcher: (() => void) | null = null;

  /**
   * Called just before the circuit runs on from `from` to `to` with nothing switching in between,
   * so voltages that move smoothly (a capacitor charging) can be read along the way with
   * `netVoltsAt`. The oscilloscope uses it to draw their real curves.
   */
  between: ((from: number, to: number) => void) | null = null;

  /** A net's voltage at a time between now and the next event, for `between`: NaN if floating or off. */
  netVoltsAt(n: number, t: number): number {
    const net = this.net;
    if (!net || n < 0) return NaN;
    return net.voltsAt(n, t);
  }

  /** How quickly a net's voltage is still moving right now (1 / its time constant); 0 if it's steady. */
  netRate(n: number): number {
    const net = this.net;
    return net && n >= 0 ? net.rateAt(n, this.time) : 0;
  }

  /** The net a hole is on, for reading it often with `netVolts`: -1 if nothing electrical is there. */
  netOf(ref: HoleRef): number {
    const root = this.conn ? this.conn.netOf(ref) : -1;
    return root < 0 ? -1 : (this.netIndex.get(root) ?? -1);
  }

  /** A net's voltage right now: NaN if it's floating or the power is off. */
  netVolts(n: number): number {
    const net = this.net;
    if (!net || n < 0) return NaN;
    net.advanceTo(this.time);
    return net.volts[n];
  }

  /** Runs the circuit on by `seconds`, or until the budget runs out. Returns the time actually covered. */
  advance(seconds: number, budget: Budget = {}): number {
    // Running backwards would send every capacitor's exponential the wrong way, off to infinity.
    if (!(seconds >= 0)) return 0;
    const net = this.net;
    const start = this.time;
    const target = start + seconds;
    if (!net) {
      this.time = target;
      return seconds;
    }
    const maxEvents = budget.maxEvents ?? Infinity;
    let events = 0;
    let burst = 0;
    let burstStart = start;
    for (;;) {
      const next = Math.min(net.nextEvent(), this.nextWake());
      if (next > target) break;
      if (events >= maxEvents) return this.time - start;
      if (budget.deadline !== undefined && (events & 15) === 15 && performance.now() > budget.deadline)
        return this.time - start;
      if (this.between && next > this.time) this.between(this.time, next);
      this.time = Math.max(this.time, next);
      if (this.time - burstStart > 1e-6) {
        burstStart = this.time;
        burst = 0;
      } else if (++burst > ZENO_EVENTS) this.tooFast = true;
      net.advanceTo(this.time);
      net.fire(this.time, this.touched);
      for (const chip of this.clocked) if ((chip.state?.wake ?? Infinity) <= this.time) this.mark(chip);
      if (!this.settle()) this.oscillating = true;
      this.regulate();
      net.predict(this.time, this.thresholdsOf);
      this.watcher?.();
      events++;
      if (budget.stop?.()) return this.time - start;
    }
    if (this.between && target > this.time) this.between(this.time, target);
    this.time = target;
    net.advanceTo(target);
    return seconds;
  }

  /**
   * Runs on to the next moment anything switches, or by `fallback` seconds if nothing is due to.
   * Returns the time covered.
   */
  stepToNext(fallback: number): number {
    const next = this.nextEventTime;
    return this.advance((next < Infinity ? Math.max(0, next - this.time) : fallback) + 1e-12);
  }

  /** Whether anything changes as time goes by: something charging, or something about to switch. */
  get active(): boolean {
    const net = this.net;
    return !!net && (net.nextEvent() < Infinity || this.nextWake() < Infinity || net.settleTime() > this.time);
  }

  /** When the next thing is due to happen on its own (Infinity if nothing is). */
  get nextEventTime(): number {
    return this.net ? Math.min(this.net.nextEvent(), this.nextWake()) : Infinity;
  }

  /** When a microcontroller next does something by itself. */
  private nextWake(): number {
    let next = this.ccWake;
    for (const chip of this.clocked) {
      const wake = chip.powered ? (chip.state?.wake ?? Infinity) : Infinity;
      if (wake < next) next = wake;
    }
    return next;
  }

  /** Presses a Nano's reset button: its sketch starts over at the next update. */
  restart(id: Id): void {
    for (const chip of this.chips) {
      if (chip.part.id !== id || !chip.state) continue;
      chip.state.run = undefined;
      chip.state.avr = undefined;
    }
    this.mcuLast.delete(id);
  }

  /** Ends a frame: lights show how bright they were on average since the last one. */
  frame(): void {
    const net = this.net;
    if (!net) return;
    net.advanceTo(this.time);
    const span = this.time - this.windowStart;
    if (span <= 0) return;
    if (!this.average || this.average.length !== this.lights.length)
      this.average = new Float64Array(this.lights.length);
    this.lights.forEach((light, i) => {
      const q = net.dQ[light.diode];
      this.average![i] = (q - this.windowCharge[i]) / span;
      this.windowCharge[i] = q;
    });
    this.windowStart = this.time;
  }

  /** Readings as of now. */
  snapshot(): SimResult {
    const net = this.net;
    net?.advanceTo(this.time);
    const problems = [...this.staticProblems];
    const leds = new Map<Id, LedReading>();
    const segments = new Map<Id, LedReading[]>();
    const chips = new Map<Id, ChipReading>();
    const capacitors = new Map<Id, number>();
    const transistors = new Map<Id, TransistorReading>();
    const supplies = new Map<Id, SupplyReading>();
    const mcus = new Map<Id, McuReading>();
    const lcds = new Map<Id, LcdReading>();
    if (net) {
      this.lights.forEach((light, i) => {
        const current = this.average ? this.average[i] : net.diodeCurrent(light.diode);
        const reading = {
          current,
          brightness: Math.min(1, (current / LED_FULL) ** 0.55),
          overCurrent: current > LED_LIMIT,
        };
        if (light.segment < 0) leds.set(light.id, reading);
        else {
          let list = segments.get(light.id);
          if (!list) segments.set(light.id, (list = []));
          list[light.segment] = reading;
        }
      });
      for (const [id, r] of leds) {
        if (r.overCurrent)
          problems.push({
            partId: id,
            message: `Too much current: ${(r.current * 1000).toFixed(0)} mA, limit ${LED_LIMIT * 1000} mA.`,
            harm: r.current,
          });
      }
      for (const [id, list] of segments) {
        const worst = Math.max(...list.map((r) => r.current));
        if (worst > LED_LIMIT)
          problems.push({
            partId: id,
            message: `Too much current in a segment: ${(worst * 1000).toFixed(0)} mA, limit ${LED_LIMIT * 1000} mA.`,
            harm: worst,
          });
      }
      for (const t of this.transistors) {
        const { base, collector } = net.transistorCurrents(t.index);
        const reading = { base, collector, overCurrent: collector > t.def.maxAmps };
        transistors.set(t.id, reading);
        if (reading.overCurrent) {
          problems.push({
            partId: t.id,
            message: `Too much collector current: ${(collector * 1000).toFixed(0)} mA, limit ${t.def.maxAmps * 1000} mA.`,
            harm: collector,
          });
        }
      }
      for (const c of this.caps) {
        const v = net.capacitorVolts(c.index);
        capacitors.set(c.id, v);
        if (c.polarised && v < -REVERSE_LIMIT) {
          problems.push({ partId: c.id, message: `Reversed: − is ${(-v).toFixed(1)} V above +.`, harm: -v });
        }
      }
      for (const chip of this.chips) chips.set(chip.part.id, { powered: chip.powered, problems: [] });
      for (const chip of this.chips) {
        const vcc = net.volts[chip.nets[chip.model.vcc]] - chip.gnd;
        if (chip.powered && vcc > MAX_VCC[chip.model.family]) {
          problems.push({
            partId: chip.part.id,
            message: `Supply too high: ${vcc.toFixed(1)} V, limit ${MAX_VCC[chip.model.family]} V.`,
            harm: vcc,
          });
        }
      }
      for (const s of this.supplies)
        supplies.set(s.doc.id, {
          volts: s.volts,
          amps: s.shorted ? s.doc.limit : this.supplyCurrent(s.plus),
          cc: s.shorted || s.volts < s.doc.volts - 1e-3,
        });
      for (const chip of this.clocked) {
        const run = chip.state?.run ?? chip.state?.avr;
        if (!chip.powered || !run) continue;
        const reading = {
          serial: run.serial,
          progress: run.progress,
          led: chip.volts(NANO_LED_HEADER) > 2.5,
          tx: run.txUntil > this.time,
        };
        mcus.set(chip.part.id, reading);
        this.mcuLast.set(chip.part.id, { ...reading, led: false, tx: false });
      }
      for (const chip of this.chips) {
        const lcd = chip.model === LCD_MODEL && chip.powered ? chip.state?.lcd : undefined;
        if (!lcd) continue;
        const v0 = chip.volts(LCD_V0);
        const reading = lcdReading(lcd, chip.vcc - v0, this.time);
        lcds.set(chip.part.id, reading);
        if (reading.contrast < 0.05)
          problems.push({
            partId: chip.part.id,
            message: `Contrast too low: V0 is at ${v0.toFixed(1)} V.`,
          });
      }
      this.diagnose(chips, problems);
      if (this.tooFast) problems.push({ message: 'Switching too fast to simulate.' });
      else if (this.oscillating) problems.push({ message: 'Doesn’t settle: a logic loop keeps flipping.' });
      this.keepHarms(problems);
    }
    const conn = this.conn;
    const index = this.netIndex;
    const volts = net?.volts;
    return {
      live: this.live,
      time: this.time,
      volts: (ref) => {
        const root = conn ? conn.netOf(ref) : -1;
        const i = root < 0 ? undefined : index.get(root);
        return i === undefined ? null : volts ? volts[i] : NaN;
      },
      leds,
      segments,
      chips,
      capacitors,
      transistors,
      supplies,
      mcus: net ? mcus : new Map(this.mcuLast),
      lcds,
      problems,
      settled: !this.oscillating && !this.tooFast,
    };
  }

  /**
   * Current out of a supply's + terminal: what flows through everything wired to it, plus what
   * chips powered from it draw, idle and through their outputs.
   */
  /**
   * Each bench supply over its current limit lowers its voltage until the circuit draws just the limit,
   * and one holding its current raises it back towards the set voltage as the load allows. Tries are
   * solved without the chips reacting (a try far too low mustn't reset them); the chips then settle at
   * the voltage chosen, which can change what they draw, so it's done a few rounds.
   */
  private regulate(): void {
    const net = this.net;
    if (!net || !this.supplies.length) return;
    let holding = false;
    let moved = false;
    for (const s of this.supplies) {
      if (s.shared || s.shorted) continue;
      const set = s.doc.volts;
      const limit = s.doc.limit;
      const high = limit * (1 + CC_TOLERANCE);
      const draw = (v: number): number => {
        net.setFixed(s.plus, v);
        net.solveDirty(this.time, noop);
        return this.supplyCurrent(s.plus);
      };
      for (let round = 0; round < 4; round++) {
        const now = this.supplyCurrent(s.plus);
        let lo: number;
        let hi: number;
        if (now > high) [lo, hi] = [0, s.volts];
        else if (s.volts < set && now < limit * (1 - CC_TOLERANCE)) {
          if (draw(set) <= high) [lo, hi] = [set, set];
          else [lo, hi] = [s.volts, set];
        } else break;
        for (let i = 0; i < 40 && hi - lo > 1e-5; i++) {
          const mid = (lo + hi) / 2;
          if (draw(mid) > limit) hi = mid;
          else lo = mid;
        }
        if (Math.abs(lo - s.volts) > 1e-3 * Math.max(1, set)) moved = true;
        s.volts = lo;
        net.setFixed(s.plus, lo);
        // The chips see the new voltage: every one looks again, since tries moved nets they weren't told about.
        for (const chip of this.chips) this.mark(chip);
        if (!this.settle()) this.oscillating = true;
      }
      if (s.volts < set - 1e-3) holding = true;
    }
    if (!holding) {
      this.ccWake = Infinity;
      this.ccGap = CC_RECHECK;
      return;
    }
    // Capacitors charging change what the circuit draws with nothing switching, so keep looking:
    // often while it's moving, less and less once it's steady.
    this.ccGap = moved ? CC_RECHECK : Math.min(CC_RECHECK_MAX, this.ccGap * 2);
    this.ccWake = this.time + this.ccGap;
  }

  private supplyCurrent(plus: number): number {
    const net = this.net!;
    let amps = net.outflow(plus);
    for (const chip of this.chips) {
      if (!chip.powered || chip.nets[chip.model.vcc] !== plus) continue;
      amps += IDLE_AMPS[chip.model.family];
      for (const slot of chip.slots) if (slot >= 0) amps += Math.max(0, net.slotCurrent(slot));
    }
    return Math.max(0, amps);
  }

  /** Updates and reads in one go. */
  run(doc: CircuitDoc, conn: Connectivity, pressed: ReadonlySet<Id> = new Set(), on?: boolean): SimResult {
    this.update(doc, conn, pressed, on);
    return this.snapshot();
  }

  /** EEPROM contents the circuit wrote since the last call, base64, for saving with the document. */
  takeWrites(): Map<Id, string> {
    const out = new Map<Id, string>();
    for (const id of this.written) {
      const entry = this.nvram.get(id);
      if (!entry) continue;
      entry.source = encodeBytes(entry.bytes);
      out.set(id, entry.source);
    }
    this.written.clear();
    return out;
  }

  /** A powered 6502, for showing its registers. */
  cpuOf(part: PartDoc): Cpu65 | null {
    return this.chips.find((c) => c.part.id === part.id)?.state?.cpu ?? null;
  }

  /** What a memory chip holds right now: an EEPROM's contents, or a powered RAM's. */
  memoryOf(part: PartDoc): Uint8Array | null {
    const model = CHIP_MODELS[part.def];
    if (model?.nonvolatile) return this.eeprom(part).bytes;
    return this.chips.find((c) => c.part.id === part.id)?.state?.mem ?? null;
  }

  /** A CPU's bus log: a row per clock cycle it has run since it was powered on. */
  busOf(part: PartDoc): readonly BusRecord[] | null {
    return this.chips.find((c) => c.part.id === part.id)?.state?.bus ?? null;
  }

  // ---- internals ----

  private addChip(part: PartDoc, model: ChipModel, nets: number[]): void {
    const net = this.net!;
    const chip = new ChipRun(
      part,
      model,
      FAMILIES[model.family],
      Int32Array.from([-1, ...nets]),
      net,
      (id) => this.written.add(id),
      () => this.time,
    );
    const remembered = this.memory.get(part.id);
    if (remembered) {
      chip.powered = true;
      chip.state = remembered.state;
      chip.drives.set(remembered.drives);
      chip.levels.set(remembered.levels);
      chip.prev.set(remembered.prev);
      if (model.nonvolatile) chip.state.mem = this.eeprom(part).bytes;
    }
    const watch = (pin: number, threshold: boolean): void => {
      const n = chip.nets[pin];
      if (n < 0) return;
      if (!this.readers[n].includes(chip)) this.readers[n].push(chip);
      if (threshold) this.watched[n].push({ chip, pin });
    };
    for (const pin of model.inputs) watch(pin, true);
    watch(model.vcc, true);
    watch(model.gnd, false);
    this.chips.push(chip);
    if (model.clocked) this.clocked.push(chip);
    // Start from what it was driving, so the first solve already has its outputs in.
    const gnd = net.volts[chip.nets[model.gnd]];
    this.applySlots(chip, net.volts[chip.nets[model.vcc]] - gnd, gnd);
  }

  private eeprom(part: PartDoc): { bytes: Uint8Array; source: string | undefined } {
    let entry = this.nvram.get(part.id);
    if (!entry || entry.source !== part.data) {
      entry = { bytes: decodeBytes(part.data, CHIP_MODELS[part.def]?.nonvolatile ?? 0), source: part.data };
      this.nvram.set(part.id, entry);
      const chip = this.chips.find((c) => c.part.id === part.id);
      if (chip?.state) chip.state.mem = entry.bytes;
    }
    return entry;
  }

  private keepState(): void {
    const net = this.net;
    if (!net) return;
    net.advanceTo(this.time);
    this.capVolts.clear();
    for (const c of this.caps) this.capVolts.set(c.id, net.capacitorVolts(c.index));
    this.memory.clear();
    for (const chip of this.chips) {
      if (chip.powered && chip.state) {
        this.memory.set(chip.part.id, {
          state: chip.state,
          drives: chip.drives.slice(),
          levels: chip.levels.slice(),
          prev: chip.prev.slice(),
        });
      }
    }
  }

  private resetWindow(): void {
    this.windowStart = this.time;
    this.windowCharge = new Float64Array(this.lights.length);
    this.average = null;
  }

  private mark(chip: ChipRun): void {
    if (chip.dirty) return;
    chip.dirty = true;
    this.dirty.push(chip);
  }

  private readonly touched = (n: number): void => {
    for (const chip of this.readers[n]) this.mark(chip);
  };

  /** Lets the chips react, a gate delay at a time, until nothing changes. False if it never stops. */
  private settle(): boolean {
    const net = this.net!;
    for (let pass = 0; pass < MAX_PASSES; pass++) {
      net.solveDirty(this.time, this.touched);
      if (!this.dirty.length) return true;
      // Every chip in a pass sees the same voltages, then they all change together.
      const list = this.dirty;
      this.dirty = this.spare;
      this.spare = list;
      for (const chip of list) {
        chip.dirty = false;
        this.step(chip);
      }
      list.length = 0;
    }
    for (const chip of this.dirty) chip.dirty = false;
    this.dirty.length = 0;
    return false;
  }

  /** A CPU's pins on the falling edge of its clock, as one row of its bus log. */
  private logBus(chip: ChipRun, tap: BusTap): void {
    const bit = (pin: number): number => (chip.drives[pin] >= 0 ? chip.drives[pin] : chip.levels[pin]);
    const word = (pins: readonly number[]): number => pins.reduce((acc, p, i) => acc | (bit(p) << i), 0);
    const state = chip.state!;
    if (!state.bus) state.bus = [];
    state.cycles = (state.cycles ?? 0) + 1;
    state.bus.push({
      t: this.time,
      n: state.cycles,
      addr: word(tap.addr),
      data: word(tap.data),
      read: bit(tap.rw) === 1,
      sync: tap.sync !== undefined && bit(tap.sync) === 1,
    });
    if (state.bus.length > BUS_LOG_MAX) state.bus.splice(0, BUS_LOG_MAX / 2);
  }

  /** One gate delay for one chip. */
  private step(chip: ChipRun): void {
    const { model, fam } = chip;
    const net = this.net!;
    const gnd = net.volts[chip.nets[model.gnd]];
    const vcc = net.volts[chip.nets[model.vcc]] - gnd;
    if (!(vcc > 4)) {
      if (chip.powered || chip.state) {
        chip.powered = false;
        chip.state = null;
        chip.drives.fill(-1);
        this.applySlots(chip, 0, 0);
        this.rewatch(chip);
      }
      return;
    }
    chip.gnd = gnd;
    chip.vcc = vcc;
    // A Schmitt input floating in its dead band should read high, like a floating TTL input, so start high.
    if (model.schmitt && !chip.powered) chip.levels.fill(1);
    chip.prev.set(chip.levels);
    for (const pin of model.inputs) {
      const v = chip.volts(pin);
      // A floating TTL input reads high; a floating CMOS input is anyone's guess, call it low.
      chip.levels[pin] = Number.isFinite(v) ? (v > switchPoint(chip, pin) ? 1 : 0) : fam.input ? 1 : 0;
    }
    if (!chip.powered || !chip.state) {
      chip.powered = true;
      const initial = model.init?.() ?? {};
      // A volatile RAM part may carry a base64 power-on image. This seeds its
      // contents once at power-up; normal writes still change the live RAM.
      if (initial.mem && chip.part.initialMemory && !model.nonvolatile) {
        const mask = chip.part.def === '74LS189' ? 0x0f : 0xff;
        initial.mem = Uint8Array.from(
          decodeBytes(chip.part.initialMemory, initial.mem.length),
          (value) => value & mask,
        );
      }
      chip.state = { q: 0, latch: 0, addr: 0, ...initial };
      if (model.nonvolatile) chip.state.mem = this.eeprom(chip.part).bytes;
      // Waking up isn't an edge.
      chip.prev.set(chip.levels);
    }
    // Log the cycle that has just ended, before eval lets the CPU advance and drive the next address.
    if (model.bus && chip.fell(model.bus.clock)) this.logBus(chip, model.bus);
    model.eval(chip, chip.state);
    this.applySlots(chip, vcc, gnd);
    this.rewatch(chip);
  }

  /** Its thresholds may have moved (hysteresis, the 555's control voltage): predict again where it's watched. */
  private rewatch(chip: ChipRun): void {
    for (const pin of chip.model.inputs) {
      const n = chip.nets[pin];
      if (n >= 0) this.net!.watchChanged(n);
    }
  }

  /** Chip outputs, TTL inputs and internal pulls, as Thevenin sources on their nets. */
  private applySlots(chip: ChipRun, vcc: number, gnd: number): void {
    const net = this.net!;
    const { fam } = chip;
    const on = chip.powered && Number.isFinite(vcc) && Number.isFinite(gnd);
    for (let pin = 1; pin < chip.slots.length; pin++) {
      const s = chip.slots[pin];
      if (s < 0) continue;
      const d = chip.drives[pin];
      const bias = chip.bias[pin];
      if (!on) net.setSlot(s, 0, 0);
      else if (d === 1) net.setSlot(s, 1 / fam.roh, gnd + fam.voh(vcc));
      else if (d === 0) net.setSlot(s, 1 / fam.rol, gnd + fam.vol);
      else if (chip.pullups[pin]) net.setSlot(s, 1 / 20000, gnd + vcc);
      else if (chip.isInput[pin] && fam.input) net.setSlot(s, fam.input.g, gnd + fam.input.volts);
      else if (bias) net.setSlot(s, bias.g, gnd + bias.volts(vcc));
      else net.setSlot(s, 0, 0);
    }
  }

  /** Where each watched pin on a net switches, for predicting when a capacitor gets there. */
  private readonly thresholdsOf = (n: number, out: number[]): void => {
    const volts = this.net!.volts;
    for (const { chip, pin } of this.watched[n]) {
      const gnd = volts[chip.nets[chip.model.gnd]];
      if (!Number.isFinite(gnd)) continue;
      if (pin === chip.model.vcc) {
        out.push(gnd + 4);
        continue;
      }
      if (!chip.powered) continue;
      if (chip.model.thresholds) for (const v of chip.model.thresholds(pin, chip)) out.push(gnd + v);
      else out.push(gnd + switchPoint(chip, pin));
    }
  };

  /**
   * Remembers each harmful problem at its worst and puts back the ones not happening right now, so a
   * problem that comes and goes with a blinking output stays listed instead of flickering.
   */
  private keepHarms(problems: Problem[]): void {
    const now = new Set<string>();
    for (let i = 0; i < problems.length; i++) {
      const p = problems[i];
      if (p.harm === undefined) continue;
      // Same part, same kind of problem. A measured one's kind is its message up to the reading.
      const key = `${p.partId ?? ''}|${p.harm > 0 ? p.message.split(':')[0] : p.message}`;
      const kept = this.harms.get(key);
      if (!kept || p.harm > kept.amount) this.harms.set(key, { problem: p, amount: p.harm });
      else problems[i] = kept.problem;
      now.add(key);
    }
    for (const [key, kept] of this.harms) if (!now.has(key)) problems.push(kept.problem);
  }

  private diagnose(readings: Map<Id, ChipReading>, problems: Problem[]): void {
    const volts = this.net!.volts;
    const drivers = new Map<number, { chip: ChipRun; pin: number; value: number }[]>();
    for (const chip of this.chips) {
      const def = PARTS[chip.part.def];
      const reading = readings.get(chip.part.id)!;
      if (def?.kind !== 'dip' && def?.kind !== 'nano') continue;
      if (!chip.powered) {
        const msg = `No power. VCC is pin ${chip.model.vcc}, GND is pin ${chip.model.gnd}.`;
        reading.problems.push(msg);
        problems.push({ partId: chip.part.id, message: msg });
        continue;
      }
      if (def.kind === 'dip' && !chip.fam.input && chip.model.family !== 'NE555') {
        const floating = chip.model.inputs.filter(
          (pin) => chip.drives[pin] < 0 && !Number.isFinite(volts[chip.nets[pin]]),
        );
        if (floating.length) {
          const msg = `Input${floating.length > 1 ? 's' : ''} not connected: pin${floating.length > 1 ? 's' : ''} ${floating.join(', ')}.`;
          reading.problems.push(msg);
          problems.push({ partId: chip.part.id, message: msg });
        }
      }
      for (const pin of chip.model.outputs) {
        const value = chip.drives[pin];
        if (value < 0) continue;
        const n = chip.nets[pin];
        const list = drivers.get(n);
        if (list) list.push({ chip, pin, value });
        else drivers.set(n, [{ chip, pin, value }]);
      }
    }
    const name = (d: { chip: ChipRun; pin: number }): string => `${d.chip.part.def} pin ${d.pin}`;
    for (const [n, list] of drivers) {
      const supply = this.fixed.get(n);
      if (supply !== undefined) {
        // An output wired straight to a rail fights the power supply whenever it disagrees.
        for (const d of list) {
          if ((supply > 0 ? 1 : 0) === d.value) continue;
          const msg = `${name(d)} drives ${d.value ? 'high' : 'low'}, wired to ${supply > 0 ? '+' : '−'}.`;
          readings.get(d.chip.part.id)!.problems.push(msg);
          problems.push({ partId: d.chip.part.id, message: msg, harm: 0 });
        }
        continue;
      }
      const high = list.find((d) => d.value === 1);
      const low = list.find((d) => d.value === 0);
      if (!high || !low) continue;
      const msg = `Outputs fighting: ${name(high)} high, ${name(low)} low.`;
      for (const d of [high, low]) readings.get(d.chip.part.id)!.problems.push(msg);
      problems.push({ partId: high.chip.part.id, message: msg, harm: 0 });
    }
  }
}
