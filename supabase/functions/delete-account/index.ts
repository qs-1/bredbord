// Deletes the signed-in person's account and everything they shared: their pictures, then the account
// itself, which takes their profile, circuits, likes and reports with it (the tables cascade).
// Remixes other people made stay; they just lose the link back.
//
// Runs inside Supabase, the only place the secret key is used. Supabase gives it SUPABASE_URL and
// SUPABASE_SERVICE_ROLE_KEY itself; nothing is stored in the repo.
import { createClient } from 'npm:@supabase/supabase-js@2';

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('Use POST', { status: 405 });
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer /, '');
  if (!token) return new Response('Sign in first', { status: 401 });

  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false },
  });
  // Who's asking, from their own sign-in token: nobody can delete someone else.
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data.user) return new Response('Sign in first', { status: 401 });
  const id = data.user.id;

  // Their pictures, a page at a time.
  for (;;) {
    const { data: files, error: listError } = await admin.storage.from('pictures').list(id, { limit: 100 });
    if (listError) return new Response('Could not remove pictures', { status: 500 });
    if (!files?.length) break;
    const { error: removeError } = await admin.storage.from('pictures').remove(files.map((f) => `${id}/${f.name}`));
    if (removeError) return new Response('Could not remove pictures', { status: 500 });
  }

  const { error: deleteError } = await admin.auth.admin.deleteUser(id);
  if (deleteError) return new Response('Could not delete the account', { status: 500 });
  return new Response(null, { status: 204 });
});
