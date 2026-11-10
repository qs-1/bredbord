// The Arduino Nano: which header pin is which Arduino pin, the sketches it comes with, and its chip
// model. A sketch is a generator that drives and reads pins and yields how long (seconds) until its
// next step, the way a real one spends a few microseconds on every digitalWrite.

import type { PartDoc } from '../circuit';
import { benDisplayRom, benMicrocodeRom, decodeBytes, hexDigitRom } from '../roms';
import {
  AVRUSART,
  AVRIOPort,
  avrInstruction,
  CPU,
  PinState,
  portBConfig,
  portCConfig,
  portDConfig,
  timer0Config,
  timer1Config,
  timer2Config,
  usart0Config,
  AVRTimer,
} from 'avr8js';
import type { AvrRun, Bit, ChipIO, ChipModel, SketchRun } from './chips';

/** Header pin (1–30) of Arduino pins D0–D13, then A0–A7. */
const HEADER = [2, 1, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 19, 20, 21, 22, 23, 24, 25, 26];
/** Header pins of the 5V output, the two grounds and the 3.3 V output. */
export const NANO_POWER = { v5: 27, gnd: [4, 29], v3: 17 } as const;
/** Arduino pin that lights the on-board L LED. */
const LED_PIN = 13;

/** A digitalWrite on a 16 MHz ATmega328P. */
const WRITE_TIME = 4e-6;
/** The bootloader's wait after a reset before the sketch starts. */
const BOOT_TIME = 0.5;
/** Serial monitor text kept. */
const SERIAL_KEEP = 12_000;
const CPU_HZ = 16_000_000;
const AVR_SLICE_CYCLES = 64;
const AVR_FLASH_BYTES = 32 * 1024;

// Ben's EEPROM programmer wiring: two chained 74HC595s for the address (and OE), the data bus on D5–D12.
const SHIFT_DATA = 2;
const SHIFT_CLK = 3;
const SHIFT_LATCH = 4;
const EEPROM_D0 = 5;
const EEPROM_D7 = 12;
const WRITE_EN = 13;
/** Ben waits 10 ms after each byte for the EEPROM to finish writing. */
const WRITE_WAIT = 0.01;

/** What a sketch works with: Arduino pin numbers and a serial port. */
class Pins {
  constructor(private readonly run: SketchRun) {}

  private get io(): ChipIO {
    return this.run.board.io;
  }

  write(pin: number, value: Bit): void {
    this.io.set(HEADER[pin], value);
  }

  /** pinMode(pin, INPUT): lets go of it. */
  input(pin: number): void {
    this.io.set(HEADER[pin], null);
  }

  read(pin: number): Bit {
    return this.io.get(HEADER[pin]);
  }

  print(text: string): void {
    const s = this.run.serial + text;
    this.run.serial = s.length > SERIAL_KEEP ? s.slice(s.length - SERIAL_KEEP) : s;
    this.run.txUntil = this.io.now + 0.04;
  }

  set progress(v: number) {
    this.run.progress = v;
  }
}

type Steps<T = void> = Generator<number, T, void>;

function* digitalWrite(p: Pins, pin: number, value: Bit): Steps {
  p.write(pin, value);
  yield WRITE_TIME;
}

function* shiftOut(p: Pins, byte: number): Steps {
  for (let bit = 7; bit >= 0; bit--) {
    yield* digitalWrite(p, SHIFT_DATA, ((byte >> bit) & 1) as Bit);
    yield* digitalWrite(p, SHIFT_CLK, 1);
    yield* digitalWrite(p, SHIFT_CLK, 0);
  }
}

/** Shifts out the address, with the top bit low to turn the EEPROM's outputs on. */
function* setAddress(p: Pins, address: number, outputEnable: boolean): Steps {
  yield* shiftOut(p, (address >> 8) | (outputEnable ? 0x00 : 0x80));
  yield* shiftOut(p, address & 0xff);
  yield* digitalWrite(p, SHIFT_LATCH, 0);
  yield* digitalWrite(p, SHIFT_LATCH, 1);
  yield* digitalWrite(p, SHIFT_LATCH, 0);
}

function* readEEPROM(p: Pins, address: number): Steps<number> {
  for (let pin = EEPROM_D0; pin <= EEPROM_D7; pin++) p.input(pin);
  yield* setAddress(p, address, true);
  let data = 0;
  for (let pin = EEPROM_D7; pin >= EEPROM_D0; pin--) data = (data << 1) | p.read(pin);
  yield WRITE_TIME;
  return data;
}

function* writeEEPROM(p: Pins, address: number, data: number): Steps {
  yield* setAddress(p, address, false);
  for (let pin = EEPROM_D0; pin <= EEPROM_D7; pin++)
    yield* digitalWrite(p, pin, ((data >> (pin - EEPROM_D0)) & 1) as Bit);
  yield* digitalWrite(p, WRITE_EN, 0);
  yield* digitalWrite(p, WRITE_EN, 1);
  yield WRITE_WAIT;
}

const hex = (n: number, digits: number): string => n.toString(16).padStart(digits, '0');

/** The first 256 bytes, sixteen to a line, the way Ben prints them. */
function* printContents(p: Pins): Steps {
  for (let base = 0; base < 256; base += 16) {
    const data: string[] = [];
    for (let offset = 0; offset < 16; offset++) data.push(hex(yield* readEEPROM(p, base + offset), 2));
    p.print(`${hex(base, 3)}:  ${data.slice(0, 8).join(' ')}   ${data.slice(8).join(' ')}\n`);
  }
}

function* programmerSetup(p: Pins): Steps {
  yield* digitalWrite(p, SHIFT_DATA, 0);
  yield* digitalWrite(p, SHIFT_CLK, 0);
  yield* digitalWrite(p, SHIFT_LATCH, 0);
  yield* digitalWrite(p, WRITE_EN, 1);
}

function* programmer(p: Pins, image: Uint8Array): Steps {
  yield* programmerSetup(p);
  p.print('Programming EEPROM');
  for (let address = 0; address < image.length; address++) {
    yield* writeEEPROM(p, address, image[address]);
    if (address % 64 === 0) p.print('.');
    p.progress = (address + 1) / image.length / 1.1;
  }
  p.print(' done\n');
  // Not in Ben's sketch, but it says straight away whether the wiring is right.
  let wrong = 0;
  let first = '';
  for (let address = 0; address < image.length; address++) {
    const read = yield* readEEPROM(p, address);
    if (read !== image[address] && !wrong++)
      first = ` (first at ${hex(address, 3)}: wrote ${hex(image[address], 2)}, read ${hex(read, 2)})`;
    p.progress = (1 + (address + 1) / image.length / 10) / 1.1;
  }
  p.print(wrong ? `Verify failed: ${wrong} bytes differ${first}\n` : 'Verified\n');
  p.print('Reading EEPROM\n');
  yield* printContents(p);
  p.progress = 1;
}

function* reader(p: Pins): Steps {
  yield* programmerSetup(p);
  p.print('Reading EEPROM\n');
  yield* printContents(p);
  p.progress = 1;
}

function* blink(p: Pins): Steps {
  for (;;) {
    p.write(LED_PIN, 1);
    yield 1;
    p.write(LED_PIN, 0);
    yield 1;
  }
}

export interface Sketch {
  title: string;
  /** Writes an EEPROM image (the part's `value`, or `data` for a loaded file). */
  usesImage: boolean;
  start(p: Pins, image: Uint8Array): Steps;
}

/** What a Nano can run, by its `state`. */
export const SKETCHES: readonly Sketch[] = [
  { title: 'EEPROM programmer', usesImage: true, start: programmer },
  { title: 'EEPROM reader', usesImage: false, start: (p) => reader(p) },
  { title: 'Blink', usesImage: false, start: (p) => blink(p) },
];

/** Images the programmer can write, by the part's `value`. */
export const IMAGES: readonly { title: string; bytes: () => Uint8Array }[] = [
  { title: 'Ben’s decimal display', bytes: benDisplayRom },
  { title: 'Ben’s microcode', bytes: benMicrocodeRom },
  { title: 'Hex digit', bytes: hexDigitRom },
  { title: 'Erase (all FF)', bytes: () => new Uint8Array(2048).fill(0xff) },
];
/** `value` for an image loaded from a file into the part's `data`. */
export const CUSTOM_IMAGE = IMAGES.length;

/** Strict Intel HEX parser for ATmega program memory. */
export function parseFirmwareHex(text: string): Uint8Array {
  const out = new Uint8Array(AVR_FLASH_BYTES).fill(0xff);
  let base = 0;
  let ended = false;
  let records = 0;
  for (const [lineNumber, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line) continue;
    if (ended) throw new Error(`Intel HEX data after EOF at line ${lineNumber + 1}`);
    if (!/^:[0-9a-fA-F]+$/.test(line) || line.length < 11 || (line.length - 1) % 2) {
      throw new Error(`Invalid Intel HEX record at line ${lineNumber + 1}`);
    }
    const bytes = Uint8Array.from(
      line
        .slice(1)
        .match(/../g)!
        .map((pair) => parseInt(pair, 16)),
    );
    const count = bytes[0];
    if (bytes.length !== count + 5) throw new Error(`Intel HEX byte count mismatch at line ${lineNumber + 1}`);
    if (bytes.reduce((sum, byte) => (sum + byte) & 0xff, 0) !== 0)
      throw new Error(`Intel HEX checksum error at line ${lineNumber + 1}`);
    const address = (bytes[1] << 8) | bytes[2];
    const type = bytes[3];
    const data = bytes.subarray(4, 4 + count);
    if (type === 0) {
      const at = base + address;
      if (at + data.length > out.length) throw new Error(`Firmware exceeds ATmega328P flash at line ${lineNumber + 1}`);
      out.set(data, at);
      records++;
    } else if (type === 1) {
      if (count !== 0 || address !== 0) throw new Error(`Invalid Intel HEX EOF record at line ${lineNumber + 1}`);
      ended = true;
    } else if (type === 2) {
      if (count !== 2) throw new Error(`Invalid Intel HEX segment record at line ${lineNumber + 1}`);
      base = ((data[0] << 8) | data[1]) << 4;
    } else if (type === 4) {
      if (count !== 2) throw new Error(`Invalid Intel HEX linear address record at line ${lineNumber + 1}`);
      base = ((data[0] << 8) | data[1]) << 16;
    } else if (type !== 3 && type !== 5) {
      throw new Error(`Unsupported Intel HEX record type ${type} at line ${lineNumber + 1}`);
    }
  }
  if (!ended) throw new Error('Intel HEX file has no EOF record');
  if (!records) throw new Error('Intel HEX file contains no program data');
  return out;
}

export function firmwareBytes(part: PartDoc): Uint8Array | null {
  if (!part.firmware) return null;
  try {
    return decodeBytes(part.firmware, AVR_FLASH_BYTES);
  } catch {
    return null;
  }
}

const PORT_PINS: readonly { port: 'b' | 'c' | 'd'; bit: number; header: number }[] = [
  { port: 'd', bit: 0, header: 1 },
  { port: 'd', bit: 1, header: 2 },
  { port: 'd', bit: 2, header: 5 },
  { port: 'd', bit: 3, header: 6 },
  { port: 'd', bit: 4, header: 7 },
  { port: 'd', bit: 5, header: 8 },
  { port: 'd', bit: 6, header: 9 },
  { port: 'd', bit: 7, header: 10 },
  { port: 'b', bit: 0, header: 11 },
  { port: 'b', bit: 1, header: 12 },
  { port: 'b', bit: 2, header: 13 },
  { port: 'b', bit: 3, header: 14 },
  { port: 'b', bit: 4, header: 15 },
  { port: 'b', bit: 5, header: 16 },
  { port: 'c', bit: 0, header: 19 },
  { port: 'c', bit: 1, header: 20 },
  { port: 'c', bit: 2, header: 21 },
  { port: 'c', bit: 3, header: 22 },
  { port: 'c', bit: 4, header: 23 },
  { port: 'c', bit: 5, header: 24 },
];

export class AvrFirmwareRun implements AvrRun {
  readonly key: string;
  readonly cpu: CPU;
  readonly ports: Record<'b' | 'c' | 'd', AVRIOPort>;
  serial = '';
  txUntil = 0;

  constructor(key: string, flash: Uint8Array) {
    this.key = key;
    const words = new Uint16Array(flash.length / 2);
    for (let i = 0; i < words.length; i++) words[i] = flash[i * 2] | (flash[i * 2 + 1] << 8);
    this.cpu = new CPU(words);
    this.ports = {
      b: new AVRIOPort(this.cpu, portBConfig),
      c: new AVRIOPort(this.cpu, portCConfig),
      d: new AVRIOPort(this.cpu, portDConfig),
    };
    new AVRTimer(this.cpu, timer0Config);
    new AVRTimer(this.cpu, timer1Config);
    new AVRTimer(this.cpu, timer2Config);
    const usart = new AVRUSART(this.cpu, usart0Config, CPU_HZ);
    usart.onByteTransmit = (value) => {
      const text = this.serial + String.fromCharCode(value);
      this.serial = text.length > SERIAL_KEEP ? text.slice(-SERIAL_KEEP) : text;
    };
  }

  step(io: ChipIO): number {
    const serialBefore = this.serial;
    for (const { port, bit, header } of PORT_PINS) this.ports[port].setPin(bit, io.get(header) === 1);
    const target = this.cpu.cycles + AVR_SLICE_CYCLES;
    while (this.cpu.cycles < target) {
      avrInstruction(this.cpu);
      this.cpu.tick();
    }
    for (const { port, bit, header } of PORT_PINS) {
      const state = this.ports[port].pinState(bit);
      io.set(header, state === PinState.Low ? 0 : state === PinState.High ? 1 : null);
      io.pull?.(header, state === PinState.InputPullUp);
    }
    if (this.serial !== serialBefore) this.txUntil = io.now + 0.04;
    return AVR_SLICE_CYCLES / CPU_HZ;
  }
}

export const sketchOf = (part: PartDoc): Sketch => SKETCHES[part.state ?? 0] ?? SKETCHES[0];

export function sketchImage(part: PartDoc): Uint8Array {
  const value = part.value ?? 0;
  return value === CUSTOM_IMAGE ? decodeBytes(part.data, 2048) : (IMAGES[value] ?? IMAGES[0]).bytes();
}

/** What a running sketch was started from: changing any of it starts it again. Parts are replaced on edits, so this is cached per object. */
const keys = new WeakMap<PartDoc, string>();
function sketchKey(part: PartDoc): string {
  let key = keys.get(part);
  if (key === undefined) {
    const sketch = sketchOf(part);
    key = `${part.state ?? 0}|${sketch.usesImage ? `${part.value ?? 0}|${part.value === CUSTOM_IMAGE ? (part.data ?? '') : ''}` : ''}`;
    keys.set(part, key);
  }
  return key;
}

export const NANO_MODEL: ChipModel = {
  family: 'AVR',
  vcc: NANO_POWER.v5,
  gnd: NANO_POWER.gnd[1],
  inputs: HEADER,
  outputs: HEADER,
  clocked: true,
  eval(io, s) {
    if (io.part.firmware) {
      s.run = undefined;
      const key = io.part.firmware;
      if (!s.avr || s.avr.key !== key) {
        const flash = firmwareBytes(io.part);
        if (!flash) {
          s.avr = undefined;
          return;
        }
        s.avr = new AvrFirmwareRun(key, flash);
      }
      const run = s.avr;
      if (!run) return;
      const delay = run.step(io);
      s.wake = io.now + delay;
      return;
    }
    s.avr = undefined;
    const key = sketchKey(io.part);
    if (!s.run || s.run.key !== key) {
      // Reset: every pin an input until the sketch says otherwise.
      for (const pin of HEADER) io.set(pin, null);
      for (const pin of HEADER) io.pull?.(pin, false);
      const run: SketchRun = { key, steps: undefined!, board: { io }, serial: '', txUntil: 0 };
      run.steps = sketchOf(io.part).start(new Pins(run), sketchImage(io.part));
      s.run = run;
      s.wake = io.now + BOOT_TIME;
    }
    s.run.board.io = io;
    while ((s.wake ?? Infinity) <= io.now) {
      const step = s.run.steps.next();
      s.wake = step.done ? Infinity : io.now + Math.max(step.value, 1e-7);
    }
  },
};

/** Arduino pin 13's header pin, which the L LED follows. */
export const NANO_LED_HEADER = HEADER[LED_PIN];
