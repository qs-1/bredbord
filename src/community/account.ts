// Signing in and the person's profile, on the website. Optional: the site works the same without it.
// The same rules as the phone app's mobile/src/account.ts, without its React parts.
//
// Sign-in is Google only (no email), with Google's own button and popup (Google Identity Services).
// Google hands back an ID token, and Supabase trades it for a session (signInWithIdToken), so the
// person never sees a Supabase address. The Supabase client is loaded only when someone is already
// signed in on this browser or starts signing in, so the desk stays light for everyone else.

import type { Session } from '@supabase/supabase-js';
import type { Profile } from './supabase';

/** The pictures people can have: parts drawings. Kept in step with the database's check. */
export const PICTURES = [
  'led-red',
  'led-green',
  'led-yellow',
  'led-blue',
  'led-white',
  'NE555',
  'resistor',
  'cap-ceramic',
  'cap-electrolytic',
  'pot',
  'button',
  'slide-switch',
  '7seg-cc',
  'nano',
  'W65C02S',
] as const;

export const randomPicture = (not?: string): string => {
  const choices = PICTURES.filter((p) => p !== not);
  return choices[Math.floor(Math.random() * choices.length)];
};

/** Names are plain lower-case letters, digits and underscores, 3 to 20 long (as the database checks). */
export const cleanName = (name: string): string => name.trim().toLowerCase().replace(/\s+/g, '_');
export const nameProblem = (name: string): string | null =>
  /^[a-z0-9_]{3,20}$/.test(name) ? null : 'Use 3 to 20 lower-case letters, numbers or _';

const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined;
const HAS_SUPABASE = !!(import.meta.env.VITE_SUPABASE_URL && import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY);

/** Whether this copy of the site can sign people in at all. */
export const canSignIn = HAS_SUPABASE && !!GOOGLE_CLIENT_ID;

export interface Account {
  /** False until the saved sign-in has been read. */
  ready: boolean;
  session: Session | null;
  /** Null when signed out, or signed in but no name picked yet. */
  profile: Profile | null;
}

let current: Account = { ready: false, session: null, profile: null };
const listeners = new Set<(a: Account) => void>();
const tell = (a: Account): void => {
  current = a;
  listeners.forEach((fn) => fn(a));
};

export const getAccount = (): Account => current;

/** Calls `fn` now and whenever the sign-in or the profile changes. */
export function onAccountChange(fn: (a: Account) => void): () => void {
  listeners.add(fn);
  fn(current);
  return () => void listeners.delete(fn);
}

let client: Promise<import('@supabase/supabase-js').SupabaseClient> | null = null;

/** The Supabase client, loaded the first time it's needed; it then follows the sign-in. */
export function need(): Promise<import('@supabase/supabase-js').SupabaseClient> {
  client ??= import('./supabase').then(({ supabase }) => {
    if (!supabase) throw new Error('Accounts aren’t available here');
    void supabase.auth.getSession().then(async ({ data }) => {
      tell({ ready: true, session: data.session, profile: await loadProfile(data.session) });
    });
    supabase.auth.onAuthStateChange((_event, session) => {
      // Outside the callback: Supabase asks that nothing else is awaited inside it.
      setTimeout(() => void loadProfile(session).then((profile) => tell({ ready: true, session, profile })), 0);
    });
    return supabase;
  });
  return client;
}

async function loadProfile(session: Session | null): Promise<Profile | null> {
  if (!session) return null;
  const sb = await need();
  const { data } = await sb
    .from('profiles')
    .select('id, username, picture, is_admin, created_at')
    .eq('id', session.user.id)
    .maybeSingle();
  return (data as Profile | null) ?? null;
}

/**
 * Picks up a sign-in kept in this browser, if there is one; otherwise leaves the client unloaded and
 * says "signed out". Call once when the page starts.
 */
export function startAccount(): void {
  if (!HAS_SUPABASE) return tell({ ready: true, session: null, profile: null });
  let saved = false;
  try {
    saved = !!localStorage.getItem('bredbord-auth');
  } catch {
    // Storage blocked: nobody can stay signed in here anyway.
  }
  if (saved) void need().catch(() => tell({ ready: true, session: null, profile: null }));
  else tell({ ready: true, session: null, profile: null });
}

export async function refreshProfile(): Promise<void> {
  tell({ ...current, profile: await loadProfile(current.session) });
}

// ---- Google ----

interface GoogleId {
  initialize(options: {
    client_id: string;
    callback: (response: { credential?: string }) => void;
    nonce?: string;
    use_fedcm_for_button?: boolean;
    ux_mode?: 'popup';
  }): void;
  renderButton(parent: HTMLElement, options: Record<string, string | number>): void;
}
declare global {
  interface Window {
    google?: { accounts: { id: GoogleId } };
  }
}

let gis: Promise<GoogleId> | null = null;
function loadGoogle(): Promise<GoogleId> {
  gis ??= new Promise((resolve, reject) => {
    if (window.google?.accounts.id) return resolve(window.google.accounts.id);
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true;
    s.onload = () => (window.google?.accounts.id ? resolve(window.google.accounts.id) : reject(new Error('no gsi')));
    s.onerror = () => {
      gis = null;
      reject(new Error('Couldn’t reach Google. Check your connection and try again'));
    };
    document.head.append(s);
  });
  return gis;
}

async function sha256Hex(text: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Draws Google's "Continue with Google" button in `parent`. Choosing an account signs in; `done` is
 * called with null when it worked or with what went wrong. A fresh nonce each time ties Google's
 * answer to this request.
 */
export async function showGoogleButton(parent: HTMLElement, done: (problem: string | null) => void): Promise<void> {
  if (!GOOGLE_CLIENT_ID) throw new Error('Google sign-in isn’t set up here');
  const [google, sb] = await Promise.all([loadGoogle(), need()]);
  const nonce = crypto.randomUUID();
  google.initialize({
    client_id: GOOGLE_CLIENT_ID,
    nonce: await sha256Hex(nonce),
    use_fedcm_for_button: true,
    ux_mode: 'popup',
    callback: ({ credential }) => {
      if (!credential) return done('Google didn’t sign you in. Try again');
      void sb.auth
        .signInWithIdToken({ provider: 'google', token: credential, nonce })
        .then(({ error }) => done(error ? error.message : null));
    },
  });
  parent.replaceChildren();
  google.renderButton(parent, {
    type: 'standard',
    theme: 'outline',
    size: 'large',
    text: 'continue_with',
    shape: 'rectangular',
    logo_alignment: 'left',
    width: Math.min(360, parent.clientWidth || 360),
  });
}

// ---- the profile ----

export async function createProfile(name: string): Promise<void> {
  const sb = await need();
  const id = current.session?.user.id;
  if (!id) throw new Error('Sign in first');
  const { error } = await sb.from('profiles').insert({ id, username: cleanName(name), picture: randomPicture() });
  if (error) throw error.code === '23505' ? new Error('That name is taken') : new Error(error.message);
  await refreshProfile();
}

export async function changeName(name: string): Promise<void> {
  const id = current.session?.user.id;
  if (!id) throw new Error('Sign in first');
  const sb = await need();
  const { error } = await sb
    .from('profiles')
    .update({ username: cleanName(name) })
    .eq('id', id);
  if (error) throw error.code === '23505' ? new Error('That name is taken') : new Error(error.message);
  await refreshProfile();
}

/** Shows at once; saved in the background, and put back if that fails. */
export async function setPicture(picture: string): Promise<void> {
  const id = current.session?.user.id;
  const before = current.profile;
  if (!id || !before || picture === before.picture) return;
  tell({ ...current, profile: { ...before, picture } });
  const sb = await need();
  const { error } = await sb.from('profiles').update({ picture }).eq('id', id);
  if (error) {
    if (current.profile?.picture === picture)
      tell({ ...current, profile: { ...current.profile, picture: before.picture } });
    throw new Error(error.message);
  }
}

export async function signOut(): Promise<void> {
  const sb = await need();
  await sb.auth.signOut();
}

/** Removes the account and everything kept in it (supabase/functions/delete-account). */
export async function deleteAccount(): Promise<void> {
  const sb = await need();
  const { error } = await sb.functions.invoke('delete-account', { method: 'POST' });
  if (error) throw new Error('The account wasn’t deleted. Try again');
  await sb.auth.signOut({ scope: 'local' });
}
