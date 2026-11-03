-- Sync v2.1: a total write budget per hour, so filling the database through the public endpoint
-- takes many hours of sustained abuse instead of 30 calls (a normal phone writes kilobytes a day).
-- The 300 MB total cap stays as the last line of defense.
create index if not exists sync_records_updated on public.sync_records (updated_at);

create or replace function public.sync_guard(p_vault text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if pg_total_relation_size('public.sync_records') > 300 * 1024 * 1024 then
    raise exception 'sync storage is full' using errcode = '54000';
  end if;
  if (select coalesce(sum(pg_column_size(data)), 0) from public.sync_records
      where updated_at > now() - interval '1 hour') > 20 * 1024 * 1024 then
    raise exception 'sync is busy, try again later' using errcode = '54000';
  end if;
  if (select count(*) from public.sync_records where vault = p_vault) > 100000
     or (select coalesce(sum(pg_column_size(data)), 0) from public.sync_records where vault = p_vault) > 50 * 1024 * 1024 then
    raise exception 'vault is full' using errcode = '54000';
  end if;
end;
$$;

revoke all on function public.sync_guard(text) from public, anon, authenticated;
