-- Every circuit is now kept in its owner's account, the private ones too ("Only me"), so signing in on
-- another phone brings them all back. Private circuits are seen by their owner only: not by others,
-- not through a link, and not by the admin.
--
-- 'private' is added to the enum below and can't be named as a value in the same run, so the rules
-- here say "shared" as visibility in ('link', 'public') and compare as text inside functions.

alter type public.visibility add value if not exists 'private';

-- When it was last made link-only or public from private (or put up shared), for the daily sharing
-- limit. Set by the database only (no grant).
alter table public.circuits add column shared_at timestamptz;
update public.circuits set shared_at = created_at;

-- Reading: public ones for everyone, your own always, shared ones for the admin (to moderate).
drop policy "read public circuits and your own" on public.circuits;
create policy "read public circuits and your own" on public.circuits for select
  using (
    (visibility = 'public' and not hidden)
    or owner = auth.uid()
    or (public.is_admin() and visibility in ('link', 'public'))
  );

drop policy "remove your own circuits, or moderate" on public.circuits;
create policy "remove your own circuits, or moderate" on public.circuits for delete to authenticated
  using (owner = auth.uid() or (public.is_admin() and visibility in ('link', 'public')));

-- A link opens a link-only or public circuit, never a private one.
create or replace function public.circuit_by_link(code text) returns setof public.circuits
language sql stable security definer set search_path = '' as $$
  select * from public.circuits
  where link_code = code and not hidden and visibility in ('link', 'public')
  limit 1;
$$;

create or replace function public.set_hidden(circuit uuid, hide boolean) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_admin() then
    raise exception 'Only the admin can do that';
  end if;
  update public.circuits set hidden = hide where id = circuit and visibility::text <> 'private';
end;
$$;

-- Limits: keeping circuits is generous; sharing them stays as before (30 a day, 500 shared at once).
create or replace function public.limit_shares() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    if (select count(*) from public.circuits where owner = new.owner and created_at > now() - interval '1 day') >= 200 then
      raise exception 'Too many new circuits today. Try again tomorrow';
    end if;
    if (select count(*) from public.circuits where owner = new.owner) >= 2000 then
      raise exception 'That''s the most circuits one account can keep';
    end if;
  end if;
  if new.visibility::text <> 'private' and (tg_op = 'INSERT' or old.visibility::text = 'private') then
    if (select count(*) from public.circuits
        where owner = new.owner and id <> new.id and shared_at > now() - interval '1 day') >= 30 then
      raise exception 'Too many circuits shared today. Try again tomorrow';
    end if;
    if (select count(*) from public.circuits
        where owner = new.owner and id <> new.id and visibility::text <> 'private') >= 500 then
      raise exception 'That''s the most circuits one person can share';
    end if;
    new.shared_at := now();
  end if;
  return new;
end;
$$;
drop trigger circuits_limit on public.circuits;
create trigger circuits_limit before insert or update of visibility on public.circuits
  for each row execute function public.limit_shares();
