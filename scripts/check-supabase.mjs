// Checks the community database's rules from the outside, the way anyone with the app could: with
// the publishable key only. Everything here must be refused except reading public circuits and
// people's names. Run it after applying supabase/migrations (see supabase/README.md):
//
//   node scripts/check-supabase.mjs
//
// It reads SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY from the environment, or from
// .cache/apk-test/.env. It never prints them, and never reads the secret key.
import { readFile } from 'node:fs/promises';

async function config() {
  let url = process.env.SUPABASE_URL;
  let key = process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) {
    const env = await readFile(new URL('../.cache/apk-test/.env', import.meta.url), 'utf8').catch(() => '');
    for (const line of env.split(/\r?\n/)) {
      const [name, ...rest] = line.split('=');
      const value = rest
        .join('=')
        .trim()
        .replace(/^["']|["']$/g, '');
      if (name.trim() === 'SUPABASE_URL') url ??= value;
      if (name.trim() === 'SUPABASE_PUBLISHABLE_KEY') key ??= value;
    }
  }
  if (!url || !key) throw new Error('Set SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY');
  return { url: url.replace(/\/$/, ''), key };
}

const { url, key } = await config();
const call = (path, init = {}) =>
  fetch(`${url}${path}`, {
    ...init,
    headers: { apikey: key, 'Content-Type': 'application/json', Prefer: 'return=representation', ...init.headers },
  });

let failed = 0;
async function expect(what, run, ok) {
  try {
    const res = await run();
    const body = await res.text();
    const pass = ok(res.status, body);
    if (!pass) failed++;
    console.log(`${pass ? 'ok  ' : 'FAIL'} ${what} (${res.status})`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${what}: ${e.message}`);
  }
}
const refused = (status, body) => status >= 400 || body === '[]';
const allowed = (status) => status >= 200 && status < 300;

await expect('anyone can read public circuits', () => call('/rest/v1/circuits?select=id,title&limit=1'), allowed);
await expect('anyone can read names', () => call('/rest/v1/profiles?select=username&limit=1'), allowed);
await expect(
  'nobody can list link-only circuits',
  () => call('/rest/v1/circuits?select=id&visibility=eq.link'),
  (s, b) => s === 200 && b === '[]',
);
await expect(
  'a wrong link code finds nothing',
  () => call('/rest/v1/rpc/circuit_by_link', { method: 'POST', body: JSON.stringify({ code: 'not-a-real-code' }) }),
  (s, b) => s === 200 && b === '[]',
);
await expect(
  'signed out, nobody can share',
  () => call('/rest/v1/circuits', { method: 'POST', body: JSON.stringify({ title: 'x', doc: {} }) }),
  refused,
);
await expect(
  'signed out, nobody can make a profile',
  () =>
    call('/rest/v1/profiles', {
      method: 'POST',
      body: JSON.stringify({ id: '00000000-0000-0000-0000-000000000000', username: 'nobody', picture: 'NE555' }),
    }),
  refused,
);
await expect(
  'nobody can change like counts',
  () =>
    call('/rest/v1/circuits?id=neq.00000000-0000-0000-0000-000000000000', {
      method: 'PATCH',
      body: JSON.stringify({ like_count: 9999 }),
    }),
  refused,
);
await expect(
  'nobody can unhide circuits',
  () =>
    call('/rest/v1/circuits?id=neq.00000000-0000-0000-0000-000000000000', {
      method: 'PATCH',
      body: JSON.stringify({ hidden: false }),
    }),
  refused,
);
await expect('nobody can read reports', () => call('/rest/v1/reports?select=id'), refused);
await expect('nobody can read likes', () => call('/rest/v1/likes?select=user_id'), refused);
await expect(
  'nobody but the admin can hide',
  () =>
    call('/rest/v1/rpc/set_hidden', {
      method: 'POST',
      body: JSON.stringify({ circuit: '00000000-0000-0000-0000-000000000000', hide: true }),
    }),
  refused,
);
await expect(
  'signed out, nobody can upload pictures',
  () =>
    call('/storage/v1/object/pictures/someone/x.jpg', {
      method: 'POST',
      headers: { 'Content-Type': 'image/jpeg', Authorization: `Bearer ${key}` },
      body: new Uint8Array([0xff, 0xd8, 0xff]),
    }),
  refused,
);

console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
