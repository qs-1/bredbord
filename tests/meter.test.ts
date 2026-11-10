import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  DIAL_ANGLE,
  METER_BODY,
  METER_HOLES,
  METER_LIFT,
  METER_TILT,
  METER_SIZE,
  METER_SCALE,
  METER_TERMINALS,
  formatVolts,
  isMeterTerminal,
  meterTerminalPos,
  meterToDesk,
  METER_MODES,
  meterDisplay,
  nextMode,
  ohmsFromVolts,
  SHUNT_MA,
  TEST_OHMS,
  TEST_VOLTS,
  testSource,
  type MeterInputs,
  type MeterMode,
} from '../src/engine/meter';
import { createDoc, type CircuitDoc, type HoleRef } from '../src/engine/circuit';
import { Connectivity } from '../src/engine/netlist';
import { ohmmeterVolts, Simulator } from '../src/engine/sim/simulator';
import { buildBodyGeometry, buildDialGeometry } from '../src/view/meter';

const h = (hole: string): HoleRef => ({ board: 'b1', hole });

describe('meter display', () => {
  const f = (v: number) => {
    const d = formatVolts(v);
    return `${d.text} ${d.unit}`;
  };

  it('auto-ranges like a 3½-digit DMM', () => {
    expect(f(0)).toBe('0.000 V');
    expect(f(0.15)).toBe('150.0 mV');
    expect(f(-0.05)).toBe('-50.0 mV');
    expect(f(1.234)).toBe('1.234 V');
    expect(f(5)).toBe('5.00 V');
    expect(f(12.34)).toBe('12.34 V');
    expect(f(-3.3)).toBe('-3.30 V');
    expect(f(150.55)).toBe('150.6 V');
    expect(f(250)).toBe('250 V');
  });

  it('steps up a range instead of showing 5 digits', () => {
    expect(f(1.9996)).toBe('2.00 V');
    expect(f(0.19996)).toBe('0.200 V');
    expect(f(19.996)).toBe('20.0 V');
  });

  it('overloads above 600 V and on non-finite input', () => {
    expect(f(600.4)).toBe('600 V');
    expect(f(601)).toBe('OL V');
    expect(f(Infinity)).toBe('OL V');
    expect(f(NaN)).toBe('OL V');
  });

  it('never shows a negative zero', () => {
    expect(f(-0.00001)).toBe('0.000 V');
  });
});

describe('meter terminals', () => {
  it('are four separate nets: 10A, mA, COM, V from left to right', () => {
    expect(METER_HOLES.holes.map((h) => h.name)).toEqual(['COM', 'V', 'mA', 'A']);
    expect(METER_HOLES.groups).toEqual([[0], [1], [2], [3]]);
    expect(METER_HOLES.hole('V')?.index).toBe(1);
    expect(METER_HOLES.hole('B')).toBeUndefined();
    const xs = (['A', 'mA', 'COM', 'V'] as const).map((n) => METER_TERMINALS[n].x);
    expect([...xs].sort((a, b) => a - b)).toEqual(xs);
    expect(isMeterTerminal('mA')).toBe(true);
    expect(isMeterTerminal('toString')).toBe(false);
    expect(isMeterTerminal('COM')).toBe(true);
    expect(isMeterTerminal('+')).toBe(false);
  });

  it('are far enough apart to pick and sit above the desk', () => {
    const d = Math.hypot(METER_TERMINALS.COM.x - METER_TERMINALS.V.x, METER_TERMINALS.COM.z - METER_TERMINALS.V.z);
    expect(d).toBeGreaterThan(10);
    expect(METER_TERMINALS.V.y).toBeGreaterThan(METER_BODY.y * METER_SCALE);
  });

  it('are offset by the meter position', () => {
    const p = meterTerminalPos({ x: 100, z: -40 }, 'V');
    expect(p.x).toBeCloseTo(100 + METER_TERMINALS.V.x);
    expect(p.z).toBeCloseTo(-40 + METER_TERMINALS.V.z);
    expect(p.y).toBe(METER_TERMINALS.V.y);
  });
});

describe('meter placement', () => {
  it('lies flat on the desk', () => {
    const front = meterToDesk(0, 0, METER_BODY.z / 2);
    const back = meterToDesk(0, 0, -METER_BODY.z / 2);
    expect(front.y).toBeCloseTo(0, 6);
    expect(back.y).toBeCloseTo(0, 6);
  });

  it('keeps the body geometry on the desk and inside the reported size', () => {
    const geo = buildBodyGeometry();
    // Body space -> desk space, the same way the view's tilted group does it.
    const m = new THREE.Matrix4()
      .makeTranslation(0, METER_LIFT * METER_SCALE, 0)
      .multiply(new THREE.Matrix4().makeRotationX(METER_TILT))
      .multiply(new THREE.Matrix4().makeScale(METER_SCALE, METER_SCALE, METER_SCALE));
    geo.applyMatrix4(m);
    const box = new THREE.Box3().setFromBufferAttribute(geo.getAttribute('position') as THREE.BufferAttribute);
    expect(box.min.y).toBeGreaterThan(-0.05);
    expect(box.max.y).toBeLessThanOrEqual(METER_SIZE.y);
    expect(box.max.x - box.min.x).toBeLessThanOrEqual(METER_SIZE.x + 0.01);
    expect(box.max.z - box.min.z).toBeLessThanOrEqual(METER_SIZE.z);
    // Jack tops are the highest thing on the near end, so wires land on them.
    expect(box.max.y).toBeGreaterThan(METER_TERMINALS.V.y - 1);
  });

  it('builds coloured geometry with matching attribute counts', () => {
    for (const g of [buildBodyGeometry(), buildDialGeometry()]) {
      const n = g.getAttribute('position').count;
      expect(n).toBeGreaterThan(100);
      expect(g.getAttribute('normal').count).toBe(n);
      expect(g.getAttribute('color').count).toBe(n);
    }
  });
});

describe('meter dial', () => {
  it('steps round every position, both ways', () => {
    expect(nextMode('off')).toBe('dcv');
    expect(nextMode('a')).toBe('off');
    expect(nextMode('off', -1)).toBe('a');
    expect(nextMode('ohm', 2)).toBe('cont');
    for (let i = 1; i < METER_MODES.length; i++)
      expect(DIAL_ANGLE[METER_MODES[i]]).toBeGreaterThan(DIAL_ANGLE[METER_MODES[i - 1]]);
    expect(DIAL_ANGLE.ohm).toBeCloseTo(0);
  });
});

describe('meter readings', () => {
  const show = (mode: MeterMode, r: Partial<MeterInputs>): string => {
    const d = meterDisplay(mode, { volts: 0, amps: 0, hertz: 0, ...r });
    return d ? `${d.text} ${d.unit}` : '';
  };
  const across = (ohms: number, vt = TEST_VOLTS, rs = TEST_OHMS): number => (vt * ohms) / (ohms + rs);

  it('reads resistance from the test current, auto-ranging', () => {
    expect(show('ohm', { volts: across(0) })).toBe('0.0 Ω');
    expect(show('ohm', { volts: across(47) })).toBe('47.0 Ω');
    expect(show('ohm', { volts: across(220) })).toBe('0.220 kΩ');
    expect(show('ohm', { volts: across(4700) })).toBe('4.70 kΩ');
    expect(show('ohm', { volts: across(100e3) })).toBe('100.0 kΩ');
    expect(show('ohm', { volts: across(1e6) })).toBe('1.000 MΩ');
    expect(show('ohm', { volts: across(15e6) })).toBe('15.00 MΩ');
    expect(show('ohm', { volts: TEST_VOLTS })).toBe('OL MΩ');
    expect(ohmsFromVolts(across(3300))).toBeCloseTo(3300, 6);
  });

  it('shows continuity below 50 Ω and OL above its range', () => {
    const beep = (ohms: number) => meterDisplay('cont', { volts: across(ohms), amps: 0, hertz: 0 })?.flags?.beep;
    expect(beep(0)).toBe(true);
    expect(beep(30)).toBe(true);
    expect(beep(100)).toBe(false);
    expect(show('cont', { volts: across(1000) })).toBe('OL Ω');
    expect(show('cont', { volts: across(12.3) })).toBe('12.3 Ω');
  });

  it('shows the diode test voltage, OL when nothing conducts', () => {
    expect(show('diode', { volts: 0.652 })).toBe('0.652 V');
    expect(show('diode', { volts: 2.99 })).toBe('OL V');
  });

  it('reads current on each jack, OL past its limit', () => {
    expect(show('ma', { amps: 0.0145 })).toBe('14.50 mA');
    expect(show('ma', { amps: 0.0012345 })).toBe('1.235 mA');
    expect(show('ma', { amps: -0.15 })).toBe('-150.0 mA');
    expect(show('ma', { amps: 0.25 })).toBe('250 mA');
    expect(show('ma', { amps: 0.5 })).toBe('OL mA');
    expect(show('a', { amps: 1.5 })).toBe('1.500 A');
    expect(show('a', { amps: 12 })).toBe('OL A');
  });

  it('reads frequency and AC volts', () => {
    expect(show('hz', { hertz: 0 })).toBe('0.000 Hz');
    expect(show('hz', { hertz: 34.6 })).toBe('34.6 Hz');
    expect(show('hz', { hertz: 1500 })).toBe('1.500 kHz');
    expect(show('acv', { volts: 2.5 })).toBe('2.50 V');
    expect(show('off', {})).toBe('');
  });
});

describe('meter in a circuit', () => {
  const m = (hole: string): HoleRef => ({ board: 'm1', hole });
  const meterDoc = (mode: MeterMode): CircuitDoc => {
    const doc = createDoc();
    doc.meters = [{ id: 'm1', x: -150, z: 0, mode }];
    return doc;
  };
  const wire = (doc: CircuitDoc, a: HoleRef, b: HoleRef): void => {
    doc.wires.push({ id: `w${doc.wires.length}`, a, b, color: 'red' });
  };
  const volts = (doc: CircuitDoc, mode: 'ohm' | 'diode' | 'cont'): number =>
    ohmmeterVolts(doc, new Connectivity(doc), 'm1', testSource(mode));

  it('measures a resistor with the power off', () => {
    const doc = meterDoc('ohm');
    doc.parts.push({ id: 'r1', def: 'resistor', pins: [h('a10'), h('a14')], value: 4700 });
    wire(doc, m('V'), h('b10'));
    wire(doc, m('COM'), h('b14'));
    expect(ohmsFromVolts(volts(doc, 'ohm'))).toBeCloseTo(4700, 3);
    // Two in parallel read half.
    doc.parts.push({ id: 'r2', def: 'resistor', pins: [h('c10'), h('c14')], value: 4700 });
    expect(ohmsFromVolts(volts(doc, 'ohm'))).toBeCloseTo(2350, 3);
  });

  it('reads OL with a lead loose, and 0 with the leads joined', () => {
    const doc = meterDoc('ohm');
    wire(doc, m('V'), h('b10'));
    expect(volts(doc, 'ohm')).toBe(TEST_VOLTS);
    wire(doc, m('COM'), h('c10'));
    expect(volts(doc, 'ohm')).toBe(0);
  });

  it('drops about 0.6 V across a diode one way and nothing the other', () => {
    const doc = meterDoc('diode');
    doc.parts.push({ id: 'd1', def: '1N4148', pins: [h('a10'), h('a14')] });
    wire(doc, m('V'), h('b10'));
    wire(doc, m('COM'), h('b14'));
    const forward = volts(doc, 'diode');
    expect(forward).toBeGreaterThan(0.5);
    expect(forward).toBeLessThan(0.9);
    // On resistance, the test voltage is too low to turn it on.
    expect(meterDisplay('ohm', { volts: volts(doc, 'ohm'), amps: 0, hertz: 0 })?.text).toBe('OL');
    doc.parts[0].pins.reverse();
    expect(meterDisplay('diode', { volts: volts(doc, 'diode'), amps: 0, hertz: 0 })?.text).toBe('OL');
  });

  it('reads the current through its mA jack, in series with a resistor', () => {
    const doc = meterDoc('ma');
    doc.supplies = [{ id: 's1', x: -250, z: 0, volts: 5, limit: 1 }];
    doc.parts.push({ id: 'r1', def: 'resistor', pins: [h('a10'), h('a14')], value: 1000 });
    wire(doc, { board: 's1', hole: '+' }, h('b10'));
    wire(doc, m('mA'), h('b14'));
    wire(doc, m('COM'), { board: 's1', hole: '-' });
    const r = new Simulator().run(doc, new Connectivity(doc), new Set(), true);
    const amps = ((r.volts(m('mA')) ?? NaN) - (r.volts(m('COM')) ?? NaN)) / SHUNT_MA;
    // 5 V across 1 kΩ plus the 1 Ω shunt.
    expect(amps).toBeCloseTo(5 / 1001, 6);
  });
});
