-- Replacing a circuit's picture (an upload with upsert) needs Storage to see the old file as well as
-- write it, so each person can now list what's in their own folder. Everyone could already fetch any
-- picture by its address (the bucket is public); this adds nothing beyond their own folder.
drop policy if exists "see pictures in your folder" on storage.objects;
create policy "see pictures in your folder" on storage.objects for select to authenticated
  using (bucket_id = 'pictures' and (storage.foldername(name))[1] = auth.uid()::text);
