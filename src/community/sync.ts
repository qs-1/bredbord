// Keeps the signed-in account's circuits and this browser's in step, by the same rules as the phone's
// mobile/src/sync.ts: every circuit of the account is kept there (private ones as 'private', seen by
// nobody else); changes go up a few seconds after they're made; the account's copies come down on
// sign-in and when the page comes back to the front. The newest edit wins (a circuit changed here and
// not yet saved keeps this browser's version); deleting in one place deletes everywhere.
//
// Signing in: circuits made while signed out join the account. Signing out: they stay in this
// browser, out of sight, until that account signs in again.
//
// Pictures: a shared circuit open on the desk gets the desk's view as its picture when it's saved
// (once per change); one the phone took is kept until then.

import { readDoc } from '../engine/document';
import {
  adopt,
  allCircuits,
  autoTags,
  dropDeletedElsewhere,
  fromAccount,
  getCircuit,
  markSynced,
  onCircuitsChange,
  readCircuit,
  readGone,
  setGone,
  setOwner,
  type Visibility,
} from '../app/circuits';
import { getAccount, need, onAccountChange, type Account } from './account';

type Online = 'private' | 'link' | 'public';
const sameTags = (a: string[], b: string[]): boolean => a.length === b.length && a.every((t, i) => t === b[i]);
const missingPictureCustomColumn = (error: { code?: string; message?: string } | null): boolean =>
  !!error && ['42703', 'PGRST204'].includes(error.code ?? '') && /picture_custom/i.test(error.message ?? '');
export const toOnline = (v: Visibility): Online => (v === 'me' ? 'private' : v);
const fromOnline = (v: string): Visibility => (v === 'link' || v === 'public' ? v : 'me');

/** Who's signed in with a name: the only time anything is saved to an account. */
function signedIn(): { uid: string } | null {
  const { session, profile } = getAccount();
  return session && profile ? { uid: session.user.id } : null;
}

let takePicture: ((id: string) => string | null) | null = null;
/** The desk says how to take a picture of a circuit: a JPEG data URL, or null when it isn't the one open. */
export function picturesFrom(fn: (id: string) => string | null): void {
  takePicture = fn;
}
/** Which change of each circuit the picture in the account shows. */
const pictured = new Map<string, number>();

async function jpegBlob(dataUrl: string): Promise<Blob> {
  return (await fetch(dataUrl)).blob();
}

/** Saves one circuit to the account. Throws with the database's reason (a limit, say) when it can't. */
export async function push(id: string): Promise<void> {
  const me = signedIn();
  if (!me) throw new Error('Sign in first');
  const sb = await need();
  const info = getCircuit(id);
  if (!info || info.owner !== me.uid) return;
  const doc = readCircuit(id);
  if (!doc) return;
  const rev = info.rev;
  const fields = {
    title: info.name.slice(0, 60) || 'Untitled circuit',
    description: info.description.slice(0, 500),
    tags: (info.tags ?? autoTags(info.parts)).slice(0, 8),
    parts: info.parts,
    doc,
    visibility: toOnline(info.visibility),
  };

  let remote = info.remote?.owner === me.uid ? info.remote : null;
  let stamp = '';
  if (remote) {
    const { data, error } = await sb.from('circuits').update(fields).eq('id', remote.id).select('updated_at');
    if (error) throw new Error(error.message);
    // Deleted from the account elsewhere while it was changed here: it goes back up as new.
    if (data?.length) stamp = data[0].updated_at as string;
    else remote = null;
  }
  if (!remote) {
    const { data, error } = await sb
      .from('circuits')
      .insert({ ...fields, remix_of: info.remixOf ?? null, is_remix: !!info.remixOf })
      .select('id, link_code, updated_at')
      .single();
    if (error) throw new Error(error.message);
    remote = { id: data.id as string, code: data.link_code as string, owner: me.uid };
    stamp = data.updated_at as string;
  }
  if (info.visibility !== 'me' && !info.pictureCustom && pictured.get(id) !== rev) {
    const jpeg = takePicture?.(id);
    if (jpeg) {
      const path = `${me.uid}/${remote.id}.jpg`;
      const up = await sb.storage
        .from('pictures')
        .upload(path, await jpegBlob(jpeg), { contentType: 'image/jpeg', upsert: true });
      if (!up.error) {
        let { data, error } = await sb
          .from('circuits')
          .update({ picture_path: path, picture_custom: false })
          .eq('id', remote.id)
          .select('updated_at')
          .single();
        if (missingPictureCustomColumn(error)) {
          ({ data, error } = await sb
            .from('circuits')
            .update({ picture_path: path })
            .eq('id', remote.id)
            .select('updated_at')
            .single());
        }
        if (error) throw new Error(error.message);
        if (data) stamp = data.updated_at as string;
        pictured.set(id, rev);
      }
    }
  }
  markSynced(id, rev, { remote, synced: stamp });
}

async function flushGone(uid: string): Promise<void> {
  const sb = await need();
  const gone = readGone();
  const left = [];
  for (const g of gone) {
    if (g.owner !== uid) {
      left.push(g);
      continue;
    }
    const { error } = await sb.from('circuits').delete().eq('id', g.id);
    if (error) left.push(g);
    else await sb.storage.from('pictures').remove([`${g.owner}/${g.id}.jpg`]);
  }
  if (left.length !== gone.length) setGone(left);
}

/** Called when the account's copy of the circuit on the desk is newer: the desk takes it. */
let onDeskUpdated: (id: string) => void = () => undefined;
export const whenDeskUpdated = (fn: (id: string) => void): void => void (onDeskUpdated = fn);
let deskId: () => string | null = () => null;
export const followDesk = (fn: () => string | null): void => void (deskId = fn);

async function pull(uid: string): Promise<void> {
  const sb = await need();
  const columns =
    'id, link_code, title, description, tags, parts, picture_path, visibility, remix_of, is_remix, created_at, updated_at';
  const withCustom = await sb.from('circuits').select(`${columns}, picture_custom`).eq('owner', uid);
  // A database without the column yet: every picture counts as the automatic one.
  const { data, error } = missingPictureCustomColumn(withCustom.error)
    ? await sb.from('circuits').select(columns).eq('owner', uid)
    : withCustom;
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as Array<Record<string, unknown>>;
  const mine = allCircuits().filter((c) => c.owner === uid);
  const gone = new Set(readGone().map((g) => g.id));
  const online = new Set(rows.map((r) => r.id as string));
  // Saved before, unchanged since, and no longer in the account: deleted on another device.
  for (const c of mine)
    if (c.remote && c.synced && !c.dirty && !online.has(c.remote.id) && c.id !== deskId()) dropDeletedElsewhere(c.id);

  for (const r of rows) {
    if (gone.has(r.id as string)) continue;
    const here = mine.find((c) => c.remote?.id === r.id);
    if (here && (here.dirty || here.synced === r.updated_at)) continue;
    const { data: full } = await sb.from('circuits').select('doc').eq('id', r.id).single();
    const read = full ? readDoc(full.doc) : null;
    if (!read || 'error' in read) continue;
    const local = fromAccount(
      here?.id ?? null,
      {
        name: r.title as string,
        description: r.description as string,
        tags: sameTags(r.tags as string[], autoTags((r.parts as Record<string, number>) ?? {}))
          ? null
          : (r.tags as string[]),
        visibility: fromOnline(r.visibility as string),
        remote: { id: r.id as string, code: r.link_code as string, owner: uid },
        picturePath: (r.picture_path as string | null) ?? null,
        pictureCustom: r.picture_custom === true,
        remixOf: (r.remix_of as string | null) ?? null,
        parts: (r.parts as Record<string, number>) ?? {},
        synced: r.updated_at as string,
        owner: uid,
        created: new Date(r.created_at as string).getTime(),
        changed: new Date(r.updated_at as string).getTime(),
      },
      { ...read.doc, name: r.title as string },
    );
    if (local === deskId()) onDeskUpdated(local);
  }
}

/** What went wrong saving, said once (a limit or a rule); being offline just waits for next time. */
let onProblem: (text: string) => void = () => undefined;
export const whenSyncFails = (fn: (text: string) => void): void => void (onProblem = fn);

async function pushChanged(uid: string): Promise<void> {
  for (const c of allCircuits()) {
    if (c.owner !== uid || !c.dirty) continue;
    const doc = readCircuit(c.id);
    // A circuit with nothing on it yet waits until it has something.
    if (!doc || (!doc.boards.length && !doc.parts.length && !doc.wires.length)) continue;
    try {
      await push(c.id);
    } catch (e) {
      const text = e instanceof Error ? e.message : '';
      if (/Too many|most circuits|limit/i.test(text)) onProblem(text);
      return;
    }
  }
}

let running: Promise<void> | null = null;
let again = false;

/** Everything in step now: deletions, then the account's copies down, then this browser's changes up. */
export function syncNow(): Promise<void> {
  if (running) {
    again = true;
    return running;
  }
  running = (async () => {
    do {
      again = false;
      const me = signedIn();
      if (!me) break;
      try {
        await flushGone(me.uid);
        await pull(me.uid);
        await pushChanged(me.uid);
      } catch {
        // Offline: it catches up next time.
      }
    } while (again);
  })().finally(() => {
    running = null;
  });
  return running;
}

let timer: ReturnType<typeof setTimeout> | undefined;
function pushSoon(): void {
  clearTimeout(timer);
  timer = setTimeout(() => {
    const me = signedIn();
    if (me && !running) void pushChanged(me.uid).catch(() => undefined);
  }, 6000);
}

let shownFor: string | null | undefined;
let onOwnerChange: (uid: string | null) => void = () => undefined;
/** Called when whose circuits show changes (signing in or out), so the desk can follow. */
export const whenOwnerChanges = (fn: (uid: string | null) => void): void => void (onOwnerChange = fn);

function follow(a: Account): void {
  if (!a.ready) return;
  const uid = a.session?.user.id ?? null;
  // Until a name is picked nothing is the account's yet.
  const who = uid && a.profile ? uid : null;
  if (who !== shownFor) {
    const first = shownFor === undefined;
    shownFor = who;
    if (who) adopt(who);
    setOwner(who);
    if (!first || who) onOwnerChange(who);
  }
  if (who) void syncNow();
}

/** Starts following the account. Call once, after the desk's circuit is known. */
export function startSync(): void {
  onAccountChange(follow);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void syncNow();
  });
  onCircuitsChange(() => {
    if (signedIn()) pushSoon();
  });
}
