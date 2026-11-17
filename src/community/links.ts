// Shared links: https://bredbord.vercel.app/c/<link code>. The code is the circuit's link_code;
// circuit_by_link() gives the circuit to anyone who has it, when it's shared by link or public and
// not hidden. A circuit that was deleted, hidden or made private all come back the same way (nothing),
// so the page can't tell those apart, and doesn't tell a stranger that a private circuit exists.

/** Where a shared circuit opens on the web. */
export const linkFor = (code: string): string => `https://bredbord.vercel.app/c/${code}`;

/** The link code in a /c/<code> address, or null if it isn't one. */
export function codeFromPath(path: string): string | null {
  const m = /^\/c\/([A-Za-z0-9_-]{4,64})\/?$/.exec(path);
  return m ? m[1] : null;
}

/** The link code in the desk's address (/app/?c=<code>), or null. */
export function codeFromSearch(search: string): string | null {
  const code = new URLSearchParams(search).get('c');
  return code && /^[A-Za-z0-9_-]{4,64}$/.test(code) ? code : null;
}

export type LinkResult =
  | { kind: 'found'; circuit: import('./supabase').RemoteCircuit }
  | { kind: 'missing' }
  | { kind: 'offline' }
  | { kind: 'unavailable' };

/** The shared circuit with its document and its maker's name, by its link code. */
export async function circuitByLink(code: string): Promise<LinkResult> {
  const { supabase } = await import('./supabase');
  if (!supabase) return { kind: 'unavailable' };
  try {
    const { data, error } = await supabase.rpc('circuit_by_link', { code });
    if (error) return { kind: 'offline' };
    const row = (data as import('./supabase').RemoteCircuit[] | null)?.[0];
    if (!row) return { kind: 'missing' };
    const { data: maker } = await supabase
      .from('profiles')
      .select('username, picture')
      .eq('id', row.owner)
      .maybeSingle();
    return {
      kind: 'found',
      circuit: { ...row, maker: (maker as { username: string; picture: string } | null) ?? null },
    };
  } catch {
    return { kind: 'offline' };
  }
}
