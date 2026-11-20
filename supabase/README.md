# Bredbord's community backend (Supabase)

The tables, rules and one small function behind sharing, likes, reports and accounts, used by the
phone app and later the website.

**The security is in the database rules** (`migrations/`). The app and the site only ever hold the
publishable key, which is public by design. The secret key is used only by the `delete-account`
function, inside Supabase. It is never put in the app, the website, this repo or a log.

## Setting it up (once)

1. **Tables and rules.** In the Supabase dashboard, open SQL Editor, and run each file in
   `migrations/` in name order, pasting all of it: `20261117000000_community.sql`, then
   `20261118000000_picture_replace.sql` (lets a circuit's picture be replaced), then
   `20261118100000_private_circuits.sql` (every circuit kept in its owner's account, private ones too), then
   `20261120100000_custom_circuit_pictures.sql` (keeps custom preview behavior in step across devices).
2. **Check the rules from outside.** From the main project:
   ```bash
   node scripts/check-supabase.mjs
   ```
   Every line should say `ok`. It uses only the publishable key.
3. **Sign-in is Google only** (no email), on the app and the site. Authentication, then Sign In /
   Providers: turn Email off. No redirect URLs are needed: neither the app nor the site goes through
   a Supabase address (`bredbord://auth` can be removed from URL Configuration).
4. **Google sign-in.** In Google Cloud Console (one project, OAuth consent screen set up, with the
   privacy page's address, `https://bredbord.vercel.app/privacy`):
   - Make an OAuth client of type **Web application**. Under "Authorised JavaScript origins" add
     `https://bredbord.vercel.app` and `http://localhost:5173`. No redirect URIs. This one client ID
     is used by both the site and the app (the app asks Google for an ID token made out to it).
   - Make an OAuth client of type **Android**: package name `app.bredbord.proto`, and the SHA-1
     fingerprint of the key the APK is signed with. Make one for each key: the debug key
     (`cd mobile/android && ./gradlew signingReport`) and the release key. The app never uses this
     client's ID; Google just needs it to exist to allow the app.
   - In Supabase, Authentication, then Sign In / Providers, then Google: turn it on and put the web
     client's ID in "Client IDs". The client secret isn't needed for ID-token sign-in.
   - The web client's ID is public. Put it in Vercel's environment variables as
     `VITE_GOOGLE_CLIENT_ID` (with `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY`, then
     redeploy), and in `mobile/.env` as `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID`. After adding the Google
     library, the app needs `npx expo prebuild` and a new build.
5. **The delete-account function.** Edge Functions, Deploy a new function, name it
   `delete-account`, and paste `functions/delete-account/index.ts`. Supabase gives it the keys it
   needs itself.
6. **Make yourself the admin**, after signing in once in the app and picking a name. In SQL Editor:
   ```sql
   update public.profiles set is_admin = true where username = 'your_name';
   ```
7. **Keep it awake.** A free project is paused after about a week without activity (reported by
   third-party guides; check Supabase's own pricing page). `.github/workflows/keep-supabase-awake.yml`
   asks it for one row a day. In the GitHub repo's Settings, then Secrets and variables, then
   Actions, add `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY`.
8. **Email sender: not needed.** Sign-in is Google only, so Supabase sends no sign-in emails. If email
   is ever turned back on: Supabase's built-in sender is meant for testing; Authentication, then
   Emails, then SMTP Settings, with a
   service such as Resend.

## The app's keys

The app reads `EXPO_PUBLIC_SUPABASE_URL`, `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY` and
`EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID` from `mobile/.env`, which git ignores. All three are public; never
the secret key. The site reads the same values as `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`
and `VITE_GOOGLE_CLIENT_ID`.

## What the rules allow

|                                     | Signed out         | Signed in                       | Admin           |
| ----------------------------------- | ------------------ | ------------------------------- | --------------- |
| Read public circuits and names      | yes                | yes                             | yes             |
| Open a link-only circuit            | with its link code | with its link code              | yes             |
| See a private circuit               | no                 | only their own                  | no              |
| List link-only circuits             | no                 | only their own                  | yes             |
| Keep, share, change, delete         | no                 | their own                       | delete shared   |
| Like                                | no                 | public circuits, as themselves  |                 |
| Change like or remix counts, unhide | no                 | no                              | hide and unhide |
| Report                              | no                 | 20 a day                        | read and handle |
| Keep                                | no                 | 200 new a day, 2000 in all      |                 |
| Share                               | no                 | 30 a day, 500 in all, 1 MB each |                 |
| Pictures                            | read by address    | their own folder, JPEG, 256 KB  |                 |
