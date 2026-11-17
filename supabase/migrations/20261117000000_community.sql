-- Bredbord's community: people, shared circuits, likes and reports, for the phone app and the website.
--
-- The app and the site talk to the database with the publishable key, which anyone can pull out of
-- the app. So the rules here ARE the security: every table has row level security on, and the
-- columns people may write are listed one by one. The secret key is used only by the delete-account
-- function, inside Supabase.
--
-- Apply it once, in the dashboard's SQL editor (or with `supabase db push`). See supabase/README.md.

-- ---------- People ----------

create table public.profiles (
  id uuid primary key references auth.users on delete cascade,
  -- Plain lower-case letters, digits and underscores, 3 to 20 long; unique.
  username text not null unique check (username ~ '^[a-z0-9_]{3,20}$'),
  -- Their picture: one of the parts' pictures, picked at random when they join.
  picture text not null check (
    picture in (
      'led-red', 'led-green', 'led-yellow', 'led-blue', 'led-white', 'NE555', 'resistor',
      'cap-ceramic', 'cap-electrolytic', 'pot', 'button', 'slide-switch', '7seg-cc', 'nano', 'W65C02S'
    )
  ),
  is_admin boolean not null default false,
  created_at timestamptz not null default now()
);

-- ---------- Shared circuits ----------

-- 'Only me' circuits never leave the phone, so only these two are ever stored.
create type public.visibility as enum ('link', 'public');

create table public.circuits (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null default auth.uid() references public.profiles on delete cascade,
  -- What a link carries: long and random, so a link-only circuit can't be guessed.
  link_code text not null unique default replace(gen_random_uuid()::text, '-', ''),
  title text not null check (char_length(title) between 1 and 60),
  description text not null default '' check (char_length(description) <= 500),
  tags text[] not null default '{}' check (cardinality(tags) <= 8),
  -- How many of each part, for filters; worked out by the app from the document.
  parts jsonb not null default '{}' check (pg_column_size(parts) <= 8000),
  doc jsonb not null check (pg_column_size(doc) <= 1000000),
  -- The picture in the 'pictures' bucket: '<owner>/<circuit>.jpg'.
  picture_path text check (picture_path is null or char_length(picture_path) <= 120),
  visibility public.visibility not null default 'public',
  -- Remixes stay when the original goes; `is_remix` keeps "Original removed" honest.
  remix_of uuid references public.circuits on delete set null,
  is_remix boolean not null default false,
  -- Kept by the database itself (triggers below); nobody can write them.
  like_count integer not null default 0,
  remix_count integer not null default 0,
  -- Set by moderation only.
  hidden boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index circuits_public_new on public.circuits (created_at desc) where visibility = 'public' and not hidden;
create index circuits_public_liked on public.circuits (like_count desc) where visibility = 'public' and not hidden;
create index circuits_owner on public.circuits (owner);
create index circuits_tags on public.circuits using gin (tags);

create table public.likes (
  user_id uuid not null default auth.uid() references public.profiles on delete cascade,
  circuit_id uuid not null references public.circuits on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, circuit_id)
);

create table public.reports (
  id bigint generated always as identity primary key,
  reporter uuid not null default auth.uid() references public.profiles on delete cascade,
  circuit_id uuid references public.circuits on delete cascade,
  profile_id uuid references public.profiles on delete cascade,
  reason text not null default '' check (char_length(reason) <= 500),
  handled boolean not null default false,
  created_at timestamptz not null default now(),
  check (circuit_id is not null or profile_id is not null),
  unique (reporter, circuit_id),
  unique (reporter, profile_id)
);

-- ---------- Helpers ----------

create function public.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select is_admin from public.profiles where id = auth.uid()), false);
$$;

-- ---------- Who may read and write what ----------

alter table public.profiles enable row level security;
alter table public.circuits enable row level security;
alter table public.likes enable row level security;
alter table public.reports enable row level security;

-- Supabase gives the app's roles every privilege by default; take them back and hand out only the
-- columns people may set themselves.
revoke all on public.profiles, public.circuits, public.likes, public.reports from anon, authenticated;

grant select on public.profiles to anon, authenticated;
-- (No delete: an account goes with everything in it, through the delete-account function.)
grant insert (id, username, picture), update (username, picture) on public.profiles to authenticated;

grant select on public.circuits to anon, authenticated;
grant insert (title, description, tags, parts, doc, picture_path, visibility, remix_of, is_remix)
  on public.circuits to authenticated;
grant update (title, description, tags, parts, doc, picture_path, visibility) on public.circuits to authenticated;
grant delete on public.circuits to authenticated;

grant select, insert (circuit_id), delete on public.likes to authenticated;
grant insert (circuit_id, profile_id, reason) on public.reports to authenticated;
grant select, update (handled) on public.reports to authenticated;

-- People: anyone can see names and pictures; each person writes only their own.
create policy "profiles are public" on public.profiles for select using (true);
create policy "make your own profile" on public.profiles for insert to authenticated with check (id = auth.uid());
create policy "change your own profile" on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

-- Circuits: public ones (not hidden) for everyone; your own always. Link-only circuits are NOT
-- readable here; they come only through circuit_by_link(), which needs the link's code.
create policy "read public circuits and your own" on public.circuits for select
  using ((visibility = 'public' and not hidden) or owner = auth.uid() or public.is_admin());
create policy "share as yourself" on public.circuits for insert to authenticated with check (owner = auth.uid());
create policy "change your own circuits" on public.circuits for update to authenticated
  using (owner = auth.uid()) with check (owner = auth.uid());
create policy "remove your own circuits, or moderate" on public.circuits for delete to authenticated
  using (owner = auth.uid() or public.is_admin());

-- Likes: only your own, only on public circuits; you see only which ones you liked.
create policy "see your likes" on public.likes for select to authenticated using (user_id = auth.uid());
create policy "like public circuits" on public.likes for insert to authenticated with check (
  user_id = auth.uid()
  and exists (select 1 from public.circuits c where c.id = circuit_id and c.visibility = 'public' and not c.hidden)
);
create policy "unlike" on public.likes for delete to authenticated using (user_id = auth.uid());

-- Reports: anyone signed in can make one; only the admin reads and handles them.
create policy "report as yourself" on public.reports for insert to authenticated with check (reporter = auth.uid());
create policy "admin reads reports" on public.reports for select to authenticated using (public.is_admin());
create policy "admin handles reports" on public.reports for update to authenticated using (public.is_admin());

-- ---------- Kept by the database ----------

create function public.touch_updated() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end;
$$;
create trigger circuits_touch before update on public.circuits for each row execute function public.touch_updated();

-- Limits, so one person or one script can't fill the free plan.
create function public.limit_shares() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if (select count(*) from public.circuits where owner = new.owner and created_at > now() - interval '1 day') >= 30 then
    raise exception 'Too many circuits shared today. Try again tomorrow';
  end if;
  if (select count(*) from public.circuits where owner = new.owner) >= 500 then
    raise exception 'That''s the most circuits one person can share';
  end if;
  return new;
end;
$$;
create trigger circuits_limit before insert on public.circuits for each row execute function public.limit_shares();

create function public.limit_reports() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if (select count(*) from public.reports where reporter = new.reporter and created_at > now() - interval '1 day') >= 20 then
    raise exception 'Too many reports today';
  end if;
  return new;
end;
$$;
create trigger reports_limit before insert on public.reports for each row execute function public.limit_reports();

create function public.count_likes() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    update public.circuits set like_count = like_count + 1 where id = new.circuit_id;
  else
    update public.circuits set like_count = greatest(like_count - 1, 0) where id = old.circuit_id;
  end if;
  return null;
end;
$$;
create trigger likes_count after insert or delete on public.likes for each row execute function public.count_likes();

create function public.count_remixes() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' and new.remix_of is not null then
    update public.circuits set remix_count = remix_count + 1 where id = new.remix_of;
  elsif tg_op = 'DELETE' and old.remix_of is not null then
    update public.circuits set remix_count = greatest(remix_count - 1, 0) where id = old.remix_of;
  end if;
  return null;
end;
$$;
create trigger circuits_remixes after insert or delete on public.circuits for each row execute function public.count_remixes();

-- ---------- Functions the app calls ----------

-- A circuit by its link's code: public or link-only, never hidden.
create function public.circuit_by_link(code text) returns setof public.circuits
language sql stable security definer set search_path = '' as $$
  select * from public.circuits where link_code = code and not hidden limit 1;
$$;
revoke all on function public.circuit_by_link(text) from public;
grant execute on function public.circuit_by_link(text) to anon, authenticated;

-- Moderation: hide or show a circuit.
create function public.set_hidden(circuit uuid, hide boolean) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_admin() then
    raise exception 'Only the admin can do that';
  end if;
  update public.circuits set hidden = hide where id = circuit;
end;
$$;
revoke all on function public.set_hidden(uuid, boolean) from public;
grant execute on function public.set_hidden(uuid, boolean) to authenticated;

-- Trigger functions and helpers aren't for calling directly.
revoke all on function public.touch_updated(), public.limit_shares(), public.limit_reports(),
  public.count_likes(), public.count_remixes() from public, anon, authenticated;

-- ---------- Pictures ----------

-- One small JPEG per shared circuit, readable by address; each person writes only in their folder.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('pictures', 'pictures', true, 262144, array['image/jpeg']);

create policy "put pictures in your folder" on storage.objects for insert to authenticated
  with check (bucket_id = 'pictures' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "replace pictures in your folder" on storage.objects for update to authenticated
  using (bucket_id = 'pictures' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "remove pictures in your folder" on storage.objects for delete to authenticated
  using (bucket_id = 'pictures' and (storage.foldername(name))[1] = auth.uid()::text);
