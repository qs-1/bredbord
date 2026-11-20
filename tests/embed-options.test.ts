import { describe, expect, it } from 'vitest';
import { optionsOf } from '../src/embed-options';
import type { PartDoc } from '../src/engine/circuit';

const part = (def: string, value?: number): PartDoc => ({ id: 'p1', def, pins: [], value }) as PartDoc;

describe('optionsOf', () => {
  it('gives an LED a colour and a size', () => {
    const o = optionsOf(part('led-red'));
    expect(o.map((x) => x.id)).toEqual(['color', 'size']);
    expect(o[0].current).toBe('red');
    expect(o[1].current).toBe('5');
  });
  it('gives a resistor its value, adding one that is not on the list', () => {
    const o = optionsOf(part('resistor', 330.5));
    expect(o).toHaveLength(1);
    expect(o[0].current).toBe('330.5');
    expect(o[0].choices[0].value).toBe('330.5');
    expect(o[0].choices.some((c) => c.value === '470')).toBe(true);
  });
  it('gives a capacitor its value', () => {
    expect(optionsOf(part('cap-ceramic'))[0].current).toBe(String(100e-9));
  });
  it('gives nothing for other parts or no part', () => {
    expect(optionsOf(undefined)).toEqual([]);
    expect(optionsOf(part('nothing-like-this'))).toEqual([]);
  });
});
