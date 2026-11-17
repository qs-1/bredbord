# Bredbord's community backend (Supabase)

The tables, rules and one small function behind sharing, likes, reports and accounts, used by the
phone app and later the website.

**The security is in the database rules** (`migrations/`). The app and the site only ever hold the
publishable key, which is public by design. The secret key is used only by the `delete-account`
function, inside Supabase. It is never put in the app, the website, this repo or a log.

## Setting it up (once)

1. **Tables and rules.** In the Supabase dashboard, open SQL Editor, paste all of
   `migrations/20261117000000_community.sql`, and run it.
2. **Check the rules from outside.** From the main project:
   ```bash
   node scripts/check-supabase.mjs
   ```
   Every line should say `ok`. It uses only the publishable key.
3. **Sign-in by email.** Authentication, then Sign In / Providers: Email on. The default "Magic
   Link" email is used as it is. Authentication, then URL Configuration: add `bredbord://auth` to
   the redirect URLs. The email's link must be opened on the phone that asked for it: it comes back
   into the app at that address, which trades it for a session.
4. **Sign-in with Google** (optional, can come later):
   - In Google Cloud Console, make a project, set up the OAuth consent screen, and make an OAuth
     client of type "Web application". Under "Authorised redirect URIs" add the callback URL that
     Supabase shows on its Google provider page.
   - In Supabase, Authentication, then Sign In / Providers, then Google: paste the client ID and
     secret, and turn it on.
   - It comes back to the app at `bredbord://auth` too (step 3).
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
8. **Before release: your own email sender.** Supabase's built-in one is reported to allow only a few
   emails an hour and is meant for testing. Authentication, then Emails, then SMTP Settings, with a
   service such as Resend.

## The app's keys

The app reads `EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY` from
`mobile/.env`, which git ignores. Only those two: never the secret key.

## What the rules allow

|                                     | Signed out         | Signed in                       | Admin           |
| ----------------------------------- | ------------------ | ------------------------------- | --------------- |
| Read public circuits and names      | yes                | yes                             | yes             |
| Open a link-only circuit            | with its link code | with its link code              | yes             |
| List link-only circuits             | no                 | only their own                  | yes             |
| Share, change, delete circuits      | no                 | their own                       | delete any      |
| Like                                | no                 | public circuits, as themselves  |                 |
| Change like or remix counts, unhide | no                 | no                              | hide and unhide |
| Report                              | no                 | 20 a day                        | read and handle |
| Share                               | no                 | 30 a day, 500 in all, 1 MB each |                 |
| Pictures                            | read by address    | their own folder, JPEG, 256 KB  |                 |
