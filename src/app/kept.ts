// Circuits kept aside in this browser. Opening a shared link puts someone else's circuit on the desk;
// the one that was there is kept here first, so it's never lost, and the menu's "Back to …" brings it
// back (keeping the shared one aside in its turn). Newest first, at most KEEP_MAX.
//
// This stands in until the site has My circuits (a list of the person's circuits); those will join it.

import type { CircuitDoc } from '../engine/circuit';
import { readDoc } from '../engine/document';

const KEY = 'breadboard-sim/kept';
export const KEEP_MAX = 10;

export interface Kept {
  name: string;
  at: number;
  doc: CircuitDoc;
}

function read(): Kept[] {
  try {
    const raw = localStorage.getItem(KEY);
    const list: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(list)) return [];
    const out: Kept[] = [];
    for (const k of list) {
      if (!k || typeof k !== 'object') continue;
      const r = readDoc((k as { doc?: unknown }).doc);
      if ('error' in r) continue;
      out.push({ name: String((k as Kept).name ?? ''), at: Number((k as Kept).at) || 0, doc: r.doc });
    }
    return out;
  } catch {
    return [];
  }
}

function write(list: Kept[]): boolean {
  try {
    localStorage.setItem(KEY, JSON.stringify(list.slice(0, KEEP_MAX)));
    return true;
  } catch {
    return false;
  }
}

/** The newest circuit kept aside, if any. */
export const newestKept = (): Kept | null => read()[0] ?? null;

/** Keeps a circuit aside. False when the browser wouldn't store it (then nothing should replace it). */
export function keepAside(doc: CircuitDoc, now = Date.now()): boolean {
  const name = doc.name?.trim() || 'Untitled circuit';
  return write([{ name, at: now, doc: structuredClone(doc) }, ...read()]);
}

/** Takes the newest kept circuit out of the list, putting `current` (if given) in its place. */
export function takeNewest(current: CircuitDoc | null, now = Date.now()): Kept | null {
  const [first, ...rest] = read();
  if (!first) return null;
  const next = current
    ? [{ name: current.name?.trim() || 'Untitled circuit', at: now, doc: structuredClone(current) }, ...rest]
    : rest;
  return write(next) ? first : null;
}
