import { describe, expect, it } from 'vitest';
import { createDoc } from '../src/engine/circuit';
import { Connectivity } from '../src/engine/netlist';
import { type Bit, type ChipIO, type Drive } from '../src/engine/sim/chips';
import { AvrFirmwareRun, parseFirmwareHex } from '../src/engine/sim/nano';
import { encodeBytes, Simulator } from '../src/engine/sim/simulator';
import { h } from './helpers/bench';

describe('AVR firmware', () => {
  const avrIo = (): { io: ChipIO; levels: Uint8Array; drives: Int8Array; pulls: Uint8Array } => {
    const levels = new Uint8Array(31);
    const drives = new Int8Array(31).fill(-1);
    const pulls = new Uint8Array(31);
    const io = {
      vcc: 5,
      now: 0,
      part: { id: 'nano', def: 'nano', pins: [] },
      get: (pin: number) => levels[pin] as Bit,
      rose: () => false,
      fell: () => false,
      volts: () => 0,
      steady: () => 0,
      set: (pin: number, value: Drive) => {
        drives[pin] = value === null ? -1 : value;
      },
      pull: (pin: number, enabled: boolean) => {
        pulls[pin] = enabled ? 1 : 0;
      },
      wrote: () => {},
    } satisfies ChipIO;
    return { io, levels, drives, pulls };
  };

  it('parses Intel HEX records and rejects bad checksums', () => {
    const flash = parseFirmwareHex(':0400000001020304F2\n:00000001FF\n');
    expect([...flash.slice(0, 4)]).toEqual([1, 2, 3, 4]);
    expect(flash[4]).toBe(0xff);
    expect(() => parseFirmwareHex(':0400000001020304F3\n:00000001FF\n')).toThrow(/checksum/);
  });

  it('rejects firmware without an EOF record', () => {
    expect(() => parseFirmwareHex(':0100000000FF\n')).toThrow(/EOF/);
  });

  it('executes firmware that configures and drives an AVR port', () => {
    const flash = parseFirmwareHex(':06000000259A2D9AFFCFA6\n:00000001FF\n');
    const { io, drives } = avrIo();
    new AvrFirmwareRun('test', flash).step(io);
    expect(drives[16]).toBe(1);
  });

  it('reads a board input', () => {
    // SBI DDRB,5; CBI PORTB,5; SBIS PIND,2; RJMP +1; SBI PORTB,5; RJMP -5.
    const flash = parseFirmwareHex(':0C000000259A2D984A9B01C02D9AFBCF39\n:00000001FF\n');
    const run = new AvrFirmwareRun('input', flash);
    const { io, levels, drives, pulls } = avrIo();
    run.step(io);
    expect(drives[16]).toBe(0);
    levels[5] = 1;
    run.step(io);
    expect(drives[16]).toBe(1);
    expect(pulls[5]).toBe(0);
  });

  it('exposes an AVR input pull-up to the simulated net', () => {
    // SBI PORTD,2; RJMP -1.
    const flash = parseFirmwareHex(':040000005A9AFFCF3A\n:00000001FF\n');
    const { io, pulls } = avrIo();
    new AvrFirmwareRun('pullup', flash).step(io);
    expect(pulls[5]).toBe(1);
  });

  it('drives a real simulator net from a loaded Nano firmware', () => {
    const doc = createDoc();
    doc.parts.push({ id: 'pwr', def: 'power', pins: [h('T+1'), h('T-1'), h('B+1'), h('B-1')], state: 1 });
    const pins = Array.from({ length: 30 }, (_, i) => h(`a${i + 1}`));
    const firmware = parseFirmwareHex(':04000000259A2D9A76\n:00000001FF\n');
    doc.parts.push({ id: 'nano', def: 'nano', pins, firmware: encodeBytes(firmware), firmwareName: 'blink.hex' });
    doc.wires.push(
      { id: 'w1', a: pins[26], b: h('T+2'), color: 'red' },
      { id: 'w2', a: pins[28], b: h('T-2'), color: 'black' },
    );
    const sim = new Simulator();
    const conn = new Connectivity(doc);
    sim.run(doc, conn, new Set(), true);
    sim.advance(20e-6);
    const result = sim.snapshot();
    expect(result.volts(pins[15])).toBeGreaterThan(4);
    expect(result.mcus.get('nano')?.led).toBe(true);
  });

  it('starts a reset with outputs released', () => {
    const flash = parseFirmwareHex(':04000000259A2D9A76\n:00000001FF\n');
    const { io, drives } = avrIo();
    new AvrFirmwareRun('reset', flash).step(io);
    expect(drives[16]).toBe(1);
    const second = avrIo();
    new AvrFirmwareRun('reset', flash).step(second.io);
    expect(second.drives[16]).toBe(1);
  });
});
