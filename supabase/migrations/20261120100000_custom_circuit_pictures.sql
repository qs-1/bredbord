-- Keep the app's custom-preview preference with the account copy so it follows other devices.
-- Existing circuits use automatic previews until their owner chooses a custom frame.
alter table public.circuits
  add column picture_custom boolean not null default false;

-- The table grants are column-scoped; allow owners to persist this preference.
grant insert (picture_custom) on public.circuits to authenticated;
grant update (picture_custom) on public.circuits to authenticated;
