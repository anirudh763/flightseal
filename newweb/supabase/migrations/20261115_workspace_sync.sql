-- Optional FlightSeal workspace sync. Apply only to a user-owned Supabase project.
-- Stores a small sample/view preference only, never flight files, receipts or keys.
create table if not exists public.flightseal_workspaces (
  user_id uuid not null references auth.users(id) on delete cascade,
  workspace_id uuid not null,
  revision bigint not null check (revision > 0),
  payload jsonb not null,
  deleted_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (user_id, workspace_id),
  check (octet_length(payload::text) <= 2048),
  check (deleted_at is not null or (
    jsonb_typeof(payload) = 'object' and
    payload ?& array['screen', 'sample', 'record'] and
    (payload - array['screen', 'sample', 'record']) = '{}'::jsonb and
    jsonb_typeof(payload->'screen') = 'string' and payload->>'screen' in ('sandbox', 'verify', 'records', 'receipts', 'video', 'help') and
    jsonb_typeof(payload->'sample') = 'string' and payload->>'sample' in ('intact', 'tampered', 'rewritten', 'truncated', 'px4', 'px4-tampered', 'px4-full') and
    jsonb_typeof(payload->'record') = 'number' and (payload->>'record') ~ '^(0|[1-9][0-9]{0,14})$'
  ))
);
alter table public.flightseal_workspaces enable row level security;
drop policy if exists flightseal_workspaces_select_own on public.flightseal_workspaces;
create policy flightseal_workspaces_select_own on public.flightseal_workspaces for select to authenticated using (auth.uid() = user_id);
revoke all on public.flightseal_workspaces from public, anon, authenticated;
grant select on public.flightseal_workspaces to authenticated;

create or replace function public.flightseal_sync_workspace(p_workspace_id uuid, p_expected_revision bigint, p_payload jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare next_revision bigint;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '42501'; end if;
  if p_expected_revision is not null and p_expected_revision < 1 then raise exception 'invalid expected revision' using errcode = '22023'; end if;
  if p_payload is null or octet_length(p_payload::text) > 2048 or jsonb_typeof(p_payload) <> 'object' or
     not (p_payload ?& array['screen', 'sample', 'record']) or
     (p_payload - array['screen', 'sample', 'record']) <> '{}'::jsonb or
     jsonb_typeof(p_payload->'screen') <> 'string' or p_payload->>'screen' not in ('sandbox', 'verify', 'records', 'receipts', 'video', 'help') or
     jsonb_typeof(p_payload->'sample') <> 'string' or p_payload->>'sample' not in ('intact', 'tampered', 'rewritten', 'truncated', 'px4', 'px4-tampered', 'px4-full') or
     jsonb_typeof(p_payload->'record') <> 'number' or (p_payload->>'record') is null or (p_payload->>'record') !~ '^(0|[1-9][0-9]{0,14})$' then
    raise exception 'invalid bounded workspace payload' using errcode = '22023';
  end if;
  if p_expected_revision is null then
    insert into public.flightseal_workspaces(user_id, workspace_id, revision, payload)
      values (auth.uid(), p_workspace_id, 1, p_payload)
      on conflict (user_id, workspace_id) do nothing
      returning revision into next_revision;
  else
    update public.flightseal_workspaces
       set revision = revision + 1, payload = p_payload, deleted_at = null, updated_at = now()
     where user_id = auth.uid() and workspace_id = p_workspace_id and revision = p_expected_revision and deleted_at is null
     returning revision into next_revision;
  end if;
  if next_revision is null then return jsonb_build_object('status', 'conflict'); end if;
  return jsonb_build_object('status', 'synced', 'revision', next_revision);
end;
$$;
revoke all on function public.flightseal_sync_workspace(uuid, bigint, jsonb) from public, anon;
grant execute on function public.flightseal_sync_workspace(uuid, bigint, jsonb) to authenticated;

create or replace function public.flightseal_delete_workspace(p_workspace_id uuid, p_expected_revision bigint)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare next_revision bigint;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '42501'; end if;
  if p_expected_revision < 1 then raise exception 'invalid expected revision' using errcode = '22023'; end if;
  update public.flightseal_workspaces
     set revision = revision + 1, payload = '{}'::jsonb, deleted_at = now(), updated_at = now()
   where user_id = auth.uid() and workspace_id = p_workspace_id and revision = p_expected_revision and deleted_at is null
   returning revision into next_revision;
  if next_revision is null then return jsonb_build_object('status', 'conflict'); end if;
  return jsonb_build_object('status', 'deleted', 'revision', next_revision);
end;
$$;
revoke all on function public.flightseal_delete_workspace(uuid, bigint) from public, anon;
grant execute on function public.flightseal_delete_workspace(uuid, bigint) to authenticated;
