// The community on the website: the public feed, a circuit by id, likes, reports, people's pages and
// moderation. The same queries as the phone's mobile/src/community.ts. Remixing (a credited copy in My
// circuits) happens on the desk, in ui.ts.

import { getAccount, need } from './account';
import type { Profile, RemoteCircuit } from './supabase';

export const LIST_COLUMNS =
  'id, owner, link_code, title, description, tags, parts, picture_path, visibility, remix_of, is_remix, like_count, remix_count, created_at, updated_at, maker:profiles!circuits_owner_fkey(username, picture)';

/** The tags the feed can be filtered by (the ones worked out from parts, as in the app). */
export const TAGS = ['Logic', 'Timers', 'CPU', 'Memory', 'Arduino', 'Displays', 'Sound'] as const;

export type FeedSort = 'popular' | 'new' | 'remixed';
export const PAGE = 24;

/** Public circuits, a page at a time. */
export async function feed(opts: {
  sort: FeedSort;
  tags?: string[];
  search?: string;
  owner?: string;
  page?: number;
}): Promise<RemoteCircuit[]> {
  const sb = await need();
  const from = (opts.page ?? 0) * PAGE;
  let q = sb.from('circuits').select(LIST_COLUMNS).eq('visibility', 'public').eq('hidden', false);
  if (opts.owner) q = q.eq('owner', opts.owner);
  if (opts.tags?.length) q = q.overlaps('tags', opts.tags);
  const search = opts.search?.trim().replace(/[%_,()]/g, ' ');
  if (search) q = q.ilike('title', `%${search}%`);
  const { data, error } = await q
    .order(opts.sort === 'new' ? 'created_at' : opts.sort === 'remixed' ? 'remix_count' : 'like_count', {
      ascending: false,
    })
    .order('created_at', { ascending: false })
    .range(from, from + PAGE - 1);
  if (error) throw new Error(error.message);
  return (data ?? []) as unknown as RemoteCircuit[];
}

export async function liked(circuitId: string): Promise<boolean> {
  const uid = getAccount().session?.user.id;
  if (!uid) return false;
  const sb = await need();
  const { data } = await sb
    .from('likes')
    .select('circuit_id')
    .eq('circuit_id', circuitId)
    .eq('user_id', uid)
    .maybeSingle();
  return !!data;
}

export async function setLiked(circuitId: string, on: boolean): Promise<void> {
  const uid = getAccount().session?.user.id;
  if (!uid) throw new Error('Sign in first');
  const sb = await need();
  const { error } = on
    ? await sb.from('likes').insert({ circuit_id: circuitId })
    : await sb.from('likes').delete().eq('circuit_id', circuitId).eq('user_id', uid);
  if (error && error.code !== '23505') throw new Error(error.message);
}

export async function report(circuitId: string, reason: string): Promise<void> {
  const sb = await need();
  const { error } = await sb.from('reports').insert({ circuit_id: circuitId, reason: reason.slice(0, 500) });
  if (error && error.code !== '23505') throw new Error(error.message);
}

export async function profileByName(username: string): Promise<Profile | null> {
  const sb = await need();
  const { data } = await sb
    .from('profiles')
    .select('id, username, picture, is_admin, created_at')
    .eq('username', username)
    .maybeSingle();
  return (data as Profile | null) ?? null;
}

/** Your own circuit's visibility, changed straight in the account (the desk's copy follows on its next sync). */
export async function setVisibility(circuitId: string, visibility: 'private' | 'link' | 'public'): Promise<void> {
  const sb = await need();
  const { error } = await sb.from('circuits').update({ visibility }).eq('id', circuitId);
  if (error) throw new Error(error.message);
}

export async function deleteShared(circuit: RemoteCircuit): Promise<void> {
  const sb = await need();
  const { error } = await sb.from('circuits').delete().eq('id', circuit.id);
  if (error) throw new Error(error.message);
  if (circuit.picture_path) await sb.storage.from('pictures').remove([circuit.picture_path]);
}

/** Moderation (admin only; the database refuses anyone else). */
export async function setHidden(circuitId: string, hide: boolean): Promise<void> {
  const sb = await need();
  const { error } = await sb.rpc('set_hidden', { circuit: circuitId, hide });
  if (error) throw new Error(error.message);
}

export interface Report {
  id: number;
  reason: string;
  created_at: string;
  circuit: { id: string; title: string; link_code: string; hidden: boolean; maker: { username: string } | null } | null;
}

/** Reports nobody has dealt with yet, newest first (admin only; the database shows nobody else any). */
export async function openReports(): Promise<Report[]> {
  const sb = await need();
  const { data, error } = await sb
    .from('reports')
    .select(
      'id, reason, created_at, circuit:circuits(id, title, link_code, hidden, maker:profiles!circuits_owner_fkey(username))',
    )
    .eq('handled', false)
    .not('circuit_id', 'is', null)
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) throw new Error(error.message);
  return (data ?? []) as unknown as Report[];
}

/** Marks every report of a circuit as dealt with (admin only). */
export async function handleReports(circuitId: string): Promise<void> {
  const sb = await need();
  const { error } = await sb.from('reports').update({ handled: true }).eq('circuit_id', circuitId);
  if (error) throw new Error(error.message);
}

/** Hidden circuits (admin only), newest first. */
export async function hiddenCircuits(): Promise<RemoteCircuit[]> {
  const sb = await need();
  const { data, error } = await sb
    .from('circuits')
    .select(LIST_COLUMNS)
    .eq('hidden', true)
    .order('updated_at', { ascending: false })
    .limit(100);
  if (error) throw new Error(error.message);
  return (data ?? []) as unknown as RemoteCircuit[];
}
