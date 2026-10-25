-- Applied to Supabase project "kalorit" (ihvbbrfwawzhksyifemd). Kept here for reference and re-creation.
-- Cloud sync for Kalorit. Clients never touch the table directly: they call sync_push / sync_pull
-- with a secret sync code. Rows are partitioned by vault = sha256(code), so the code never reaches the DB.

create table public.sync_records (
  vault      text        not null,
  kind       text        not null check (kind in ('entries', 'myFoods', 'favorites', 'weights', 'settings')),
  id         text        not null check (length(id) between 1 and 200),
  data       jsonb,                                   -- null = deleted
  client_ts  bigint      not null,                    -- device modification time (ms), last write wins
  updated_at timestamptz not null default clock_timestamp(),
  primary key (vault, kind, id)
);

create index sync_records_vault_updated on public.sync_records (vault, updated_at);

alter table public.sync_records enable row level security;
-- no policies: anon/authenticated cannot read or write the table directly
revoke all on public.sync_records from anon, authenticated;

create or replace function public.sync_vault(p_code text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p_code is null or length(p_code) < 24 or length(p_code) > 128 then
    raise exception 'invalid sync code' using errcode = '22023';
  end if;
  return encode(sha256(convert_to(p_code, 'UTF8')), 'hex');
end;
$$;

create or replace function public.sync_push(p_code text, p_rows jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_vault text := public.sync_vault(p_code);
  v_count integer;
begin
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 500 then
    raise exception 'rows must be an array of at most 500 items' using errcode = '22023';
  end if;
  if (select count(*) from public.sync_records where vault = v_vault) > 100000 then
    raise exception 'vault is full' using errcode = '54000';
  end if;

  insert into public.sync_records as r (vault, kind, id, data, client_ts, updated_at)
  select v_vault, x.kind, x.id, x.data, x.ts, clock_timestamp()
  from jsonb_to_recordset(p_rows) as x(kind text, id text, data jsonb, ts bigint)
  where pg_column_size(x.data) is null or pg_column_size(x.data) < 20000
  on conflict (vault, kind, id) do update
    set data = excluded.data, client_ts = excluded.client_ts, updated_at = clock_timestamp()
    where excluded.client_ts >= r.client_ts;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

create or replace function public.sync_pull(p_code text, p_since timestamptz default null)
returns table (kind text, id text, data jsonb, ts bigint, updated_at timestamptz)
language sql
security definer
stable
set search_path = ''
as $$
  -- 10 s overlap guards against rows committed slightly out of order; merging is idempotent
  select r.kind, r.id, r.data, r.client_ts, r.updated_at
  from public.sync_records r
  where r.vault = public.sync_vault(p_code)
    and (p_since is null or r.updated_at > p_since - interval '10 seconds')
  order by r.updated_at
  limit 5000;
$$;

revoke all on function public.sync_vault(text) from public;
revoke all on function public.sync_push(text, jsonb) from public;
revoke all on function public.sync_pull(text, timestamptz) from public;
grant execute on function public.sync_push(text, jsonb) to anon, authenticated;
grant execute on function public.sync_pull(text, timestamptz) to anon, authenticated;

comment on function public.sync_push(text, jsonb) is 'Kalorit sync: callable by anon by design; the 120-bit sync code is the credential.';
comment on function public.sync_pull(text, timestamptz) is 'Kalorit sync: callable by anon by design; the 120-bit sync code is the credential.';
