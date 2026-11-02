-- Sync v2 (audit fixes). Old functions stay callable for app versions already on phones.
-- * sync_pull2: keyset paging on (updated_at, kind, id), so any number of rows written in the same
--   moment is read page by page; the old 10 s overlap + limit could return the same page forever.
-- * sync_push2: skips invalid, stale and oversized rows instead of failing the whole batch, and
--   reports them, so one bad row no longer blocks every later upload.
-- * Only codes in the app's own format are accepted, and storage is capped per vault and in total,
--   so the public endpoint cannot be used to fill the database.

create or replace function public.sync_vault(p_code text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p_code is null or p_code !~ '^[2-9A-HJ-NP-Z]{4}(-[2-9A-HJ-NP-Z]{4}){5}$' then
    raise exception 'invalid sync code' using errcode = '22023';
  end if;
  return encode(sha256(convert_to(p_code, 'UTF8')), 'hex');
end;
$$;

-- shared guard: per-vault and whole-database limits (free tier is 500 MB)
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
  if (select count(*) from public.sync_records where vault = p_vault) > 100000
     or (select coalesce(sum(pg_column_size(data)), 0) from public.sync_records where vault = p_vault) > 50 * 1024 * 1024 then
    raise exception 'vault is full' using errcode = '54000';
  end if;
end;
$$;

create or replace function public.sync_push2(p_code text, p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_vault text := public.sync_vault(p_code);
  v_applied integer;
  v_rejected jsonb;
begin
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 500 then
    raise exception 'rows must be an array of at most 500 items' using errcode = '22023';
  end if;
  perform public.sync_guard(v_vault);

  create temporary table if not exists pg_temp.sync_in (kind text, id text, data jsonb, ts bigint, ok boolean) on commit drop;
  truncate pg_temp.sync_in;
  insert into pg_temp.sync_in
  select x.kind, x.id, x.data, x.ts,
         x.kind in ('entries', 'myFoods', 'favorites', 'weights', 'settings')
         and length(x.id) between 1 and 200
         and x.ts is not null and x.ts > 0
         and (x.data is null or (jsonb_typeof(x.data) = 'object' and pg_column_size(x.data) < 20000))
  from jsonb_to_recordset(p_rows) as x(kind text, id text, data jsonb, ts bigint);

  with up as (
    insert into public.sync_records as r (vault, kind, id, data, client_ts, updated_at)
    select distinct on (kind, id) v_vault, kind, id, data, ts, clock_timestamp()
    from pg_temp.sync_in where ok
    order by kind, id, ts desc
    on conflict (vault, kind, id) do update
      set data = excluded.data, client_ts = excluded.client_ts, updated_at = clock_timestamp()
      where excluded.client_ts >= r.client_ts
    returning r.kind, r.id
  )
  select count(*) into v_applied from up;

  -- invalid rows, and valid rows the cloud already has a newer version of
  select coalesce(jsonb_agg(jsonb_build_object('kind', i.kind, 'id', i.id,
           'reason', case when not i.ok then 'invalid' else 'stale' end)), '[]'::jsonb)
    into v_rejected
  from pg_temp.sync_in i
  where not i.ok
     or exists (select 1 from public.sync_records r
                where r.vault = v_vault and r.kind = i.kind and r.id = i.id and r.client_ts > i.ts);

  return jsonb_build_object('applied', v_applied, 'rejected', v_rejected);
end;
$$;

create or replace function public.sync_pull2(
  p_code text, p_since timestamptz default null, p_after_kind text default null, p_after_id text default null)
returns table (kind text, id text, data jsonb, ts bigint, updated_at timestamptz)
language sql
security definer
stable
set search_path = ''
as $$
  -- first page of a sync: 10 s overlap (rows committed slightly out of order; merging is idempotent);
  -- later pages: strictly after the last row seen, so paging always advances
  select r.kind, r.id, r.data, r.client_ts, r.updated_at
  from public.sync_records r
  where r.vault = public.sync_vault(p_code)
    and (
      p_since is null
      or (p_after_kind is null and r.updated_at > p_since - interval '10 seconds')
      or (p_after_kind is not null and (r.updated_at, r.kind, r.id) > (p_since, p_after_kind, p_after_id))
    )
  order by r.updated_at, r.kind, r.id
  limit 1000;
$$;

-- the old push: same row filter, so an old app version with one bad row is not blocked either
create or replace function public.sync_push(p_code text, p_rows jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
begin
  return (public.sync_push2(p_code, p_rows) ->> 'applied')::integer;
end;
$$;

revoke all on function public.sync_guard(text) from public, anon, authenticated;
revoke all on function public.sync_push2(text, jsonb) from public;
revoke all on function public.sync_pull2(text, timestamptz, text, text) from public;
grant execute on function public.sync_push2(text, jsonb) to anon, authenticated;
grant execute on function public.sync_pull2(text, timestamptz, text, text) to anon, authenticated;

comment on function public.sync_push2(text, jsonb) is 'Kalorit sync v2: callable by anon by design; the 120-bit sync code is the credential.';
comment on function public.sync_pull2(text, timestamptz, text, text) is 'Kalorit sync v2: callable by anon by design; the 120-bit sync code is the credential.';
