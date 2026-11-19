import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDoc } from '../src/engine/circuit';
import { codeFromPath, codeFromSearch, linkFor } from '../src/community/links';
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

describe('my circuits in this browser', () => {
  const items = new Map<string, string>();
  beforeEach(() => {
    items.clear();
    vi.resetModules();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => items.get(k) ?? null,
      setItem: (k: string, v: string) => void items.set(k, v),
      removeItem: (k: string) => void items.delete(k),
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  const named = (name: string) => ({ ...createDoc(), name });

  it('starts with the desk’s circuit and the ones kept aside before', async () => {
    items.set('breadboard-sim/kept', JSON.stringify([{ name: 'Old', at: 1, doc: named('Old') }]));
    const c = await import('../src/app/circuits');
    const id = c.startCircuits(named('Desk'));
    expect(c.currentId()).toBe(id);
    expect(
      c
        .listCircuits()
        .map((x) => x.name)
        .sort(),
    ).toEqual(['Desk', 'Old']);
    expect(items.has('breadboard-sim/kept')).toBe(false);
  });

  it('marks changes to go up, and only clean once the same version went up', async () => {
    const c = await import('../src/app/circuits');
    const info = c.addCircuit(named('A'))!;
    c.markSynced(info.id, info.rev, { synced: 't1' });
    expect(c.getCircuit(info.id)!.dirty).toBe(false);
    c.saveCircuit(info.id, named('B'));
    const rev = c.getCircuit(info.id)!.rev;
    c.saveCircuit(info.id, named('C'));
    c.markSynced(info.id, rev, { synced: 't2' });
    expect(c.getCircuit(info.id)!.dirty).toBe(true);
    expect(c.getCircuit(info.id)!.name).toBe('C');
  });

  it('shows only the signed-in account’s; signed-out circuits join the account', async () => {
    const c = await import('../src/app/circuits');
    c.addCircuit(named('Mine here'));
    c.setOwner('someone');
    expect(c.listCircuits()).toHaveLength(0);
    c.adopt('someone');
    expect(c.listCircuits().map((x) => x.name)).toEqual(['Mine here']);
    c.setOwner(null);
    expect(c.listCircuits()).toHaveLength(0);
  });

  it('remembers account circuits deleted here, to delete them there', async () => {
    const c = await import('../src/app/circuits');
    c.setOwner('u');
    const info = c.addCircuit(named('Shared'), { remote: { id: 'r1', code: 'x', owner: 'u' } })!;
    c.deleteCircuit(info.id);
    expect(c.readGone()).toEqual([{ id: 'r1', owner: 'u' }]);
    expect(c.readCircuit(info.id)).toBeNull();
  });
});

describe('account names', async () => {
  const { cleanName, nameProblem, PICTURES } = await import('../src/community/account');

  it('tidies a name the way the database wants it', () => {
    expect(cleanName('  Test   Maker ')).toBe('test maker');
    expect(nameProblem('test maker')).toBeNull();
    expect(nameProblem('test_maker')).toBeNull();
    for (const bad of ['ab', 'a'.repeat(21), 'no-dash', 'Caps', ' lead', 'two  spaces'])
      expect(nameProblem(bad)).not.toBeNull();
  });

  it('only offers pictures the database allows, each with a drawing', () => {
    expect(PICTURES).toHaveLength(15);
    for (const id of PICTURES) expect(partPictureBody(id)).not.toBe('');
  });
});
