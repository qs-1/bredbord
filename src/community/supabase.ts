// The connection to Bredbord's community (Supabase), with the publishable key only: what anyone may do
// is decided by the database's rules (supabase/migrations), not by the site. Loaded only when needed
// (a shared link, signing in, or someone already signed in), so the desk on its own doesn't carry it.
//
// The sign-in is kept in localStorage under AUTH_KEY; account.ts looks for it without loading this.
//
// The site works without it: when it's built without the two VITE_ keys, `supabase` is null and the
// community parts say they aren't available.

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const URL = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined;

export const AUTH_KEY = 'bredbord-auth';

export const supabase: SupabaseClient | null =
  URL && KEY
    ? createClient(URL, KEY, {
        auth: { storageKey: AUTH_KEY, persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
      })
    : null;

export interface Profile {
  id: string;
  username: string;
  picture: string;
  is_admin: boolean;
  created_at: string;
}

/** A circuit row as the database has it (the same as the phone app's). */
export interface RemoteCircuit {
  id: string;
  owner: string;
  link_code: string;
  title: string;
  description: string;
  tags: string[];
  parts: Record<string, number>;
  doc?: unknown;
  picture_path: string | null;
  visibility: 'private' | 'link' | 'public';
  remix_of: string | null;
  is_remix: boolean;
  like_count: number;
  remix_count: number;
  created_at: string;
  updated_at: string;
  maker?: { username: string; picture: string } | null;
}

/** A circuit's picture, by address; `stamp` makes a changed picture load again. */
export function pictureUrl(path: string | null, stamp?: string): string | null {
  if (!supabase || !path) return null;
  const url = supabase.storage.from('pictures').getPublicUrl(path).data.publicUrl;
  return stamp ? `${url}?v=${encodeURIComponent(stamp)}` : url;
}
