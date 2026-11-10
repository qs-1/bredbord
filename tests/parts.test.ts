import { describe, expect, it } from 'vitest';
import { dipPinHoles, formatOhms, ohmsCode, PARTS, resistorBands, type DipDef } from '../src/engine/parts';

const nand = PARTS['74LS00'] as DipDef;
const eeprom = PARTS['28C16'] as DipDef;
const name = (p: { row: string; col: number }) => `${p.row}${p.col + 1}`;

describe('DIP placement', () => {
  it('puts pin 1 bottom-left and counts anticlockwise', () => {
    const pins = dipPinHoles(nand, 9, false).map(name);
    expect(pins[0]).toBe('f10');
    expect(pins[6]).toBe('f16');
    expect(pins[7]).toBe('e16');
    expect(pins[13]).toBe('e10');
  });

  it('flips the chip end for end', () => {
    const pins = dipPinHoles(nand, 9, true).map(name);
    expect(pins[0]).toBe('e16');
    expect(pins[6]).toBe('e10');
    expect(pins[7]).toBe('f10');
    expect(pins[13]).toBe('f16');
  });

  it('seats wide chips six holes apart', () => {
    const pins = dipPinHoles(eeprom, 0, false).map(name);
    expect(pins).toHaveLength(24);
    expect(pins[0]).toBe('h1');
    expect(pins[23]).toBe('d1');
  });

  it('has a name for every pin', () => {
    for (const def of Object.values(PARTS)) {
      if (def.kind === 'dip') expect(def.pinNames).toHaveLength(def.pins);
    }
  });
});

describe('resistor colour code', () => {
  it.each([
    [220, ['red', 'red', 'brown', 'gold']],
    [470, ['yellow', 'violet', 'brown', 'gold']],
    [1000, ['brown', 'black', 'red', 'gold']],
    [4700, ['yellow', 'violet', 'red', 'gold']],
    [10, ['brown', 'black', 'black', 'gold']],
    [1000000, ['brown', 'black', 'green', 'gold']],
  ])('%i Ω', (ohms, bands) => {
    expect(resistorBands(ohms)).toEqual(bands);
  });

  it('formats values the way they are written', () => {
    expect(formatOhms(470)).toBe('470 Ω');
    expect(formatOhms(4700)).toBe('4.7 kΩ');
    expect(formatOhms(1000000)).toBe('1 MΩ');
  });
});

describe('resistor network codes', () => {
  it('prints two figures and a count of zeros', () => {
    expect([220, 330, 470, 1000, 4700, 10000].map(ohmsCode)).toEqual(['221', '331', '471', '102', '472', '103']);
  });
});
