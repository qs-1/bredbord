-- Names may have spaces: lower-case letters, numbers and _, in words with one space between them,
-- 3 to 20 characters in all ("share man", not " share  man ").
alter table public.profiles drop constraint if exists profiles_username_check;
alter table public.profiles add constraint profiles_username_check
  check (char_length(username) between 3 and 20 and username ~ '^[a-z0-9_]+( [a-z0-9_]+)*$');
