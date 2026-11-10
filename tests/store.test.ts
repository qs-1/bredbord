import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyDoc } from '../src/engine/circuit';
import { DOC_VERSION } from '../src/engine/document';
import { Store } from '../src/app/store';

const KEY = 'breadboard-sim/doc';

/** A browser's localStorage, with a switch to make it full. */
function fakeStorage() {
  const items = new Map<string, string>();
  return {
    full: false,
    items,
    getItem: (k: string) => items.get(k) ?? null,
    setItem(k: string, v: string) {
      if (this.full) throw new DOMException('full', 'QuotaExceededError');
      items.set(k, v);
    },
    removeItem: (k: string) => void items.delete(k),
  };
}

let storage: ReturnType<typeof fakeStorage>;

beforeEach(() => {
  vi.useFakeTimers();
  storage = fakeStorage();
  vi.stubGlobal('localStorage', storage);
  vi.stubGlobal('window', globalThis);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** One undoable edit, then long enough for the autosave to go out. */
function edit(store: Store, name: string): void {
  store.update((doc) => {
    doc.name = name;
  });
  vi.advanceTimersByTime(1000);
}

const saved = (): unknown => JSON.parse(storage.items.get(KEY) ?? 'null');

describe('autosave', () => {
  it('saves edits and picks them up next time', () => {
    edit(new Store(), 'mine');
    const again = new Store();
    expect(again.doc.name).toBe('mine');
    expect(again.loadProblem).toBeNull();
  });

  it('starts empty, with nothing to warn about, when nothing is saved', () => {
    const store = new Store();
    expect(store.doc.parts).toEqual([]);
    expect(store.loadProblem).toBeNull();
  });

  const unreadable: [string, string][] = [
    ['damaged', '{"version": 1, "boards": ['],
    ['saved by a newer version', JSON.stringify({ ...emptyDoc(), version: DOC_VERSION + 1 })],
    [
      'opened with a part this version doesn’t know',
      JSON.stringify({ ...emptyDoc(), parts: [{ id: 'p1', def: 'flux-capacitor', pins: [] }] }),
    ],
  ];
  for (const [what, raw] of unreadable) {
    it(`leaves a saved circuit alone when it is ${what}`, () => {
      storage.items.set(KEY, raw);
      const store = new Store();
      expect(store.loadProblem).toMatch(/saved in this browser/);
      edit(store, 'scratch');
      expect(storage.items.get(KEY)).toBe(raw);
    });
  }

  it('resumes once the user moves on to another circuit', () => {
    const raw = '{"version": 1, "boards": [';
    storage.items.set(KEY, raw);
    const store = new Store();
    store.replace({ ...emptyDoc(), name: 'fresh start' });
    vi.advanceTimersByTime(1000);
    expect(saved()).toMatchObject({ name: 'fresh start' });
    edit(store, 'carried on');
    expect(saved()).toMatchObject({ name: 'carried on' });
  });

  it('says once when storage is full, and again only after it has worked in between', () => {
    const store = new Store();
    const failed = vi.fn();
    store.onSaveFailed = failed;
    storage.full = true;
    edit(store, 'a');
    edit(store, 'b');
    expect(failed).toHaveBeenCalledTimes(1);
    storage.full = false;
    edit(store, 'c');
    expect(saved()).toMatchObject({ name: 'c' });
    storage.full = true;
    edit(store, 'd');
    expect(failed).toHaveBeenCalledTimes(2);
  });

  it('never touches storage for a document it was handed (the landing page)', () => {
    const store = new Store({ ...emptyDoc(), name: 'demo' });
    edit(store, 'demo, edited');
    expect(storage.items.size).toBe(0);
    store.replace(emptyDoc());
    vi.advanceTimersByTime(1000);
    expect(storage.items.size).toBe(0);
  });
});
