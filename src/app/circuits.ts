// The circuits kept in this browser ("My circuits"). Each belongs to an account (kept there too, by
// community/sync.ts) or, when made while signed out, to this browser only. My circuits shows the
// signed-in account's, or the browser's own when signed out; the others stay here, out of sight,
// until their account signs in again. The same rules as the phone's mobile/src/circuits.ts.
//
// The desk works on one of them at a time (`current`); the store's autosave keeps working as before,
// and this list follows it. The list is one small entry; each document is an entry of its own.

import { emptyDoc, type CircuitDoc } from '../engine/circuit';
import { readDoc } from '../engine/document';

/** Who can open a circuit: its owner only, anyone with its link, or everyone (in Community). */
export type Visibility = 'me' | 'link' | 'public';

export interface CircuitInfo {
  id: string;
  name: string;
  description: string;
  /** Tags set on the phone, or null to use the ones worked out from the parts. */
  tags: string[] | null;
  visibility: Visibility;
  /** Its copy in the account: the circuit's id there, its link's code, and whose it is. */
  remote: { id: string; code: string; owner: string } | null;
  /** Its picture in the account, if it has one (taken by the phone app). */
  picturePath: string | null;
  /** The picture was framed by hand (in the app), so the automatic one from above mustn't replace it. */
  pictureCustom?: boolean;
  /** Remixed from someone's shared circuit: its id in the account, so the maker is credited. */
  remixOf?: string | null;
  parts: Record<string, number>;
  created: number;
  changed: number;
  /** The account (its user id) that keeps it, or null: made while signed out, in this browser only. */
  owner: string | null;
  /** Changed since it was last saved to the account. */
  dirty: boolean;
  /** Counts its changes, so a save that raced a change leaves it marked changed. */
  rev: number;
  /** The account's copy's updated_at when the two last matched. */
  synced: string | null;
}

const LIST = 'breadboard-sim/circuits';
const CURRENT = 'breadboard-sim/current';
const GONE = 'breadboard-sim/circuits-gone';
const KEPT = 'breadboard-sim/kept';
const docKey = (id: string): string => `breadboard-sim/circuit/${id}`;

const get = (key: string): string | null => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const set = (key: string, value: string): boolean => {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
};
const remove = (key: string): void => {
  try {
    localStorage.removeItem(key);
  } catch {
    // Nothing to do.
  }
};

export const newId = (): string =>
  typeof crypto?.randomUUID === 'function'
    ? crypto.randomUUID()
    : `c${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;

/** How many of each part, by its id. */
export function partsOf(doc: CircuitDoc): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of doc.parts) out[p.def] = (out[p.def] ?? 0) + 1;
  return out;
}

const RULES: [RegExp, string][] = [
  [/555/, 'Timers'],
  [/^74/, 'Logic'],
  [/^CD40/, 'Logic'],
  [/^(W65C|65C|6502|6522)/, 'CPU'],
  [/^(AT28|28C|62256)/, 'Memory'],
  [/^nano$/, 'Arduino'],
  [/^(lcd|7seg)/, 'Displays'],
  [/^(buzzer|speaker)/, 'Sound'],
];

/** Tags worked out from the parts, as the phone does. */
export function autoTags(parts: Record<string, number>): string[] {
  const tags = new Set<string>();
  for (const id of Object.keys(parts)) for (const [test, tag] of RULES) if (test.test(id)) tags.add(tag);
  return [...tags];
}

export const isEmpty = (doc: CircuitDoc): boolean =>
  !doc.boards.length &&
  !doc.parts.length &&
  !doc.wires.length &&
  !doc.supplies?.length &&
  !doc.meters?.length &&
  !doc.scopes?.length;

const listeners = new Set<() => void>();
export function onCircuitsChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

let cache: CircuitInfo[] | null = null;
function all(): CircuitInfo[] {
  if (!cache) {
    try {
      const raw = JSON.parse(get(LIST) ?? '[]') as CircuitInfo[];
      cache = Array.isArray(raw) ? raw.filter((c) => c && typeof c.id === 'string') : [];
    } catch {
      cache = [];
    }
  }
  return cache;
}
function writeList(list: CircuitInfo[]): void {
  cache = list;
  set(LIST, JSON.stringify(list));
  listeners.forEach((fn) => fn());
}

// Whose circuits show: the signed-in account's, or this browser's own (null).
let owner: string | null = null;
export const currentOwner = (): string | null => owner;
export function setOwner(next: string | null): void {
  owner = next;
  listeners.forEach((fn) => fn());
}

/** The circuits that show, newest change first. */
export const listCircuits = (): CircuitInfo[] =>
  all()
    .filter((c) => c.owner === owner)
    .sort((a, b) => b.changed - a.changed);

export const allCircuits = (): CircuitInfo[] => all();
export const getCircuit = (id: string): CircuitInfo | null => all().find((c) => c.id === id) ?? null;

export function readCircuit(id: string): CircuitDoc | null {
  const raw = get(docKey(id));
  if (!raw) return null;
  try {
    const r = readDoc(JSON.parse(raw));
    return 'error' in r ? null : r.doc;
  } catch {
    return null;
  }
}

export const currentId = (): string | null => get(CURRENT);
export const setCurrent = (id: string): void => void set(CURRENT, id);

/** A new circuit in the list (the signed-in account's, if any). False if the browser wouldn't keep it. */
export function addCircuit(doc: CircuitDoc, extra: Partial<CircuitInfo> = {}): CircuitInfo | null {
  const now = Date.now();
  const info: CircuitInfo = {
    id: newId(),
    name: doc.name?.trim() || 'Untitled circuit',
    description: '',
    tags: null,
    visibility: 'me',
    remote: null,
    picturePath: null,
    parts: partsOf(doc),
    created: now,
    changed: now,
    owner,
    dirty: true,
    rev: 1,
    synced: null,
    ...extra,
  };
  if (!set(docKey(info.id), JSON.stringify(doc))) return null;
  writeList([...all(), info]);
  return info;
}

/** The desk's circuit changed: keep it, and mark it to go up. */
export function saveCircuit(id: string, doc: CircuitDoc): boolean {
  const info = getCircuit(id);
  if (!info) return false;
  if (!set(docKey(id), JSON.stringify(doc))) return false;
  writeList(
    all().map((c) =>
      c.id === id
        ? {
            ...c,
            name: doc.name?.trim() || 'Untitled circuit',
            parts: partsOf(doc),
            changed: Date.now(),
            dirty: true,
            rev: c.rev + 1,
          }
        : c,
    ),
  );
  return true;
}

export function changeCircuit(id: string, change: Partial<CircuitInfo>, markDirty = true): void {
  writeList(
    all().map((c) => (c.id === id ? { ...c, ...change, ...(markDirty ? { dirty: true, rev: c.rev + 1 } : {}) } : c)),
  );
}

/** Saved to the account: clean, unless it changed again meanwhile. */
export function markSynced(id: string, rev: number, fields: Partial<CircuitInfo>): void {
  writeList(all().map((c) => (c.id === id ? { ...c, ...fields, dirty: c.rev !== rev } : c)));
}

/** Deletes it here; one kept in an account is deleted there too (now, or when back online). */
export function deleteCircuit(id: string): void {
  const info = getCircuit(id);
  if (!info) return;
  if (info.remote && info.owner) set(GONE, JSON.stringify([...readGone(), { id: info.remote.id, owner: info.owner }]));
  remove(docKey(id));
  writeList(all().filter((c) => c.id !== id));
}

export function readGone(): { id: string; owner: string }[] {
  try {
    const list = JSON.parse(get(GONE) ?? '[]') as { id: string; owner: string }[];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}
export const setGone = (list: { id: string; owner: string }[]): void => void set(GONE, JSON.stringify(list));

/** Deleted in the account from elsewhere: gone here too, without being queued for deletion. */
export function dropDeletedElsewhere(id: string): void {
  remove(docKey(id));
  writeList(all().filter((c) => c.id !== id));
}

/** The account's copy, new or newer: into the list. Returns the local id. */
export function fromAccount(
  id: string | null,
  info: Omit<CircuitInfo, 'id' | 'dirty' | 'rev'>,
  doc: CircuitDoc,
): string {
  const local = id ?? newId();
  set(docKey(local), JSON.stringify(doc));
  const entry: CircuitInfo = { ...info, id: local, dirty: false, rev: 0 };
  writeList(id ? all().map((c) => (c.id === id ? { ...entry, rev: c.rev } : c)) : [...all(), entry]);
  return local;
}

/** Circuits made while signed out join the account that signs in. */
export function adopt(uid: string): void {
  if (!all().some((c) => c.owner === null)) return;
  writeList(all().map((c) => (c.owner === null ? { ...c, owner: uid, dirty: true, rev: c.rev + 1 } : c)));
}

/**
 * Once, when the site first has this list: the circuit on the desk and any kept aside (from opening a
 * shared link) become circuits in it. Returns the id of the desk's circuit; when the desk was empty
 * and an older circuit is picked instead, the caller puts that one on the desk.
 */
export function startCircuits(desk: CircuitDoc): string {
  const list = all();
  const cur = currentId();
  if (cur && list.some((c) => c.id === cur)) return cur;
  try {
    const kept = JSON.parse(get(KEPT) ?? '[]') as { doc?: unknown }[];
    for (const k of Array.isArray(kept) ? kept : []) {
      const r = readDoc(k.doc);
      if (!('error' in r)) addCircuit(r.doc);
    }
    remove(KEPT);
  } catch {
    // Nothing kept.
  }
  const mine = listCircuits()[0];
  const info = isEmpty(desk) && mine ? mine : addCircuit(isEmpty(desk) ? emptyDoc() : desk);
  if (!info) return '';
  setCurrent(info.id);
  return info.id;
}
