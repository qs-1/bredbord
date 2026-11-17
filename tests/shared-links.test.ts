import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyDoc } from '../src/engine/circuit';
import { codeFromPath, codeFromSearch, linkFor } from '../src/community/links';
import { KEEP_MAX, keepAside, newestKept, takeNewest } from '../src/app/kept';
import { partName, partPictureBody, partsInOrder } from '../src/ui/part-picture';

describe('link addresses', () => {
  const code = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

  it('reads the code from /c/<code>, with or without a slash', () => {
    expect(codeFromPath(`/c/${code}`)).toBe(code);
    expect(codeFromPath(`/c/${code}/`)).toBe(code);
    expect(new URL(linkFor(code)).pathname).toBe(`/c/${code}`);
  });

  it('turns down anything that isn’t a link code', () => {
    for (const path of ['/c/', '/c', '/c/a/b', '/c/ab', '/c/<script>', `/x/${code}`])
      expect(codeFromPath(path)).toBeNull();
  });

  it('reads the desk’s ?c=', () => {
    expect(codeFromSearch(`?c=${code}`)).toBe(code);
    expect(codeFromSearch('?c=no%20way')).toBeNull();
    expect(codeFromSearch('')).toBeNull();
  });
});

describe('parts list', () => {
  it('puts chips first, then the most used, and leaves out unknown parts', () => {
    const list = partsInOrder({ resistor: 4, NE555: 1, 'led-red': 2, 'no-such-part': 3, '74HC595': 2 });
    expect(list.map((p) => p.id)).toEqual(['74HC595', 'NE555', 'resistor', 'led-red']);
  });

  it('names and draws parts as the parts panel does', () => {
    expect(partName('NE555')).toBe('NE555');
    expect(partName('led-green')).toBe('Green LED');
    expect(partPictureBody('NE555')).toContain('555');
    expect(partPictureBody('led-green')).toContain('#2fa84f');
    expect(partPictureBody('no-such-part')).toBe('');
  });
});

describe('circuits kept aside', () => {
  const items = new Map<string, string>();
  let full = false;
  beforeEach(() => {
    items.clear();
    full = false;
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => items.get(k) ?? null,
      setItem: (k: string, v: string) => {
        if (full) throw new DOMException('full', 'QuotaExceededError');
        items.set(k, v);
      },
      removeItem: (k: string) => void items.delete(k),
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  const named = (name: string) => ({ ...emptyDoc(), name });

  it('keeps the newest first and gives it back', () => {
    expect(newestKept()).toBeNull();
    expect(keepAside(named('First'))).toBe(true);
    expect(keepAside(named('Second'))).toBe(true);
    expect(newestKept()?.name).toBe('Second');
  });

  it('swaps: going back keeps what was on the desk in its place', () => {
    keepAside(named('Mine'));
    const back = takeNewest(named('Shared'));
    expect(back?.doc.name).toBe('Mine');
    expect(newestKept()?.name).toBe('Shared');
    expect(takeNewest(null)?.name).toBe('Shared');
    expect(newestKept()).toBeNull();
  });

  it('says so when the browser won’t store it, so nothing replaces it', () => {
    full = true;
    expect(keepAside(named('Mine'))).toBe(false);
  });

  it('keeps at most KEEP_MAX', () => {
    for (let i = 0; i < KEEP_MAX + 3; i++) keepAside(named(`C${i}`));
    expect(JSON.parse(items.get('breadboard-sim/kept')!)).toHaveLength(KEEP_MAX);
  });
});
