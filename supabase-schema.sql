create table if not exists public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) between 2 and 120),
  created_at timestamptz not null default now()
);

create table if not exists public.organization_members (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('owner', 'store_admin', 'handover_staff', 'supervisor', 'courier_receiver', 'read_only_auditor')),
  created_at timestamptz not null default now(),
  primary key (organization_id, user_id)
);

create table if not exists public.sync_records (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  table_name text not null check (table_name in ('parcels', 'manifests', 'sessions', 'incidents', 'imports', 'audit')),
  record_id text not null,
  payload jsonb not null,
  updated_by uuid not null references auth.users(id),
  updated_at timestamptz not null default clock_timestamp(),
  primary key (organization_id, table_name, record_id)
);

create index if not exists sync_records_org_updated_idx
  on public.sync_records (organization_id, updated_at);

insert into storage.buckets (id, name, public)
values ('handover-evidence', 'handover-evidence', false)
on conflict (id) do update set public = false;

alter table public.organizations enable row level security;
alter table public.organization_members enable row level security;
alter table public.sync_records enable row level security;

create or replace function public.is_org_member(p_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.organization_members
    where organization_id = p_organization_id and user_id = auth.uid()
  );
$$;

revoke all on function public.is_org_member(uuid) from public;
grant execute on function public.is_org_member(uuid) to authenticated;

drop policy if exists organizations_read_member on public.organizations;
create policy organizations_read_member on public.organizations
  for select to authenticated using (public.is_org_member(id));

drop policy if exists members_read_self on public.organization_members;
create policy members_read_self on public.organization_members
  for select to authenticated using (user_id = auth.uid());

drop policy if exists sync_records_read_member on public.sync_records;
create policy sync_records_read_member on public.sync_records
  for select to authenticated using (public.is_org_member(organization_id));

drop policy if exists handover_evidence_read_member on storage.objects;
create policy handover_evidence_read_member on storage.objects
  for select to authenticated using (
    bucket_id = 'handover-evidence'
    and public.is_org_member((storage.foldername(name))[1]::uuid)
  );

drop policy if exists handover_evidence_insert_member on storage.objects;
create policy handover_evidence_insert_member on storage.objects
  for insert to authenticated with check (
    bucket_id = 'handover-evidence'
    and public.is_org_member((storage.foldername(name))[1]::uuid)
  );

drop policy if exists handover_evidence_update_member on storage.objects;
create policy handover_evidence_update_member on storage.objects
  for update to authenticated using (
    bucket_id = 'handover-evidence'
    and public.is_org_member((storage.foldername(name))[1]::uuid)
  ) with check (
    bucket_id = 'handover-evidence'
    and public.is_org_member((storage.foldername(name))[1]::uuid)
  );

revoke all on public.organizations, public.organization_members, public.sync_records from anon, authenticated;
grant select on public.organizations, public.organization_members, public.sync_records to authenticated;

create or replace function public.create_organization(p_name text)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_organization_id uuid;
begin
  if v_user_id is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;
  if length(trim(coalesce(p_name, ''))) not between 2 and 120 then
    raise exception 'Organization name must be 2-120 characters' using errcode = '22023';
  end if;

  insert into public.organizations (name) values (trim(p_name)) returning id into v_organization_id;
  insert into public.organization_members (organization_id, user_id, role)
  values (v_organization_id, v_user_id, 'owner');
  return v_organization_id;
end;
$$;

revoke all on function public.create_organization(text) from public;
grant execute on function public.create_organization(text) to authenticated;

create or replace function public.sync_local_changes(
  p_organization_id uuid,
  p_changes jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_role text;
  v_change jsonb;
  v_table text;
  v_record_id text;
  v_payload jsonb;
  v_expected_version timestamptz;
  v_current public.sync_records%rowtype;
  v_version timestamptz;
  v_results jsonb := '[]'::jsonb;
begin
  if v_user_id is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;
  select role into v_role from public.organization_members
  where organization_id = p_organization_id and user_id = v_user_id;
  if v_role is null then
    raise exception 'Organization membership required' using errcode = '42501';
  end if;
  if jsonb_typeof(p_changes) <> 'array' or jsonb_array_length(p_changes) > 100 then
    raise exception 'Batch must contain at most 100 changes' using errcode = '22023';
  end if;

  for v_change in select value from jsonb_array_elements(p_changes)
  loop
    v_table := v_change->>'table';
    v_record_id := v_change->>'record_id';
    v_payload := coalesce(v_change->'payload', '{}'::jsonb) - '_syncVersion';

    if v_table not in ('parcels', 'manifests', 'sessions', 'incidents', 'imports', 'audit')
      or v_record_id is null or length(v_record_id) > 180 then
      raise exception 'Invalid record in sync batch' using errcode = '22023';
    end if;

    if v_role = 'read_only_auditor'
      or (v_table = 'imports' and v_role not in ('owner', 'store_admin'))
      or (v_table = 'sessions' and (v_role not in ('owner', 'store_admin', 'supervisor', 'courier_receiver') or (v_role = 'courier_receiver' and not exists (select 1 from jsonb_array_elements(coalesce(v_payload->'items', '[]'::jsonb)) item where item->>'result' = 'ACCEPTED'))))
      or (v_table = 'incidents' and (v_role not in ('owner', 'store_admin', 'supervisor', 'handover_staff', 'courier_receiver') or (v_role = 'courier_receiver' and v_payload->>'category' <> 'Paket ditolak kurir')))
      or (v_table = 'incidents' and v_payload->>'status' = 'RESOLVED' and v_role not in ('owner', 'store_admin', 'supervisor'))
      or (v_table = 'manifests' and v_payload->>'status' = 'CLOSED' and (v_role not in ('owner', 'store_admin', 'supervisor') or length(trim(coalesce(v_payload->>'closeReason', ''))) = 0))
      or (v_table = 'parcels' and v_payload->>'status' = 'HANDED_OVER' and (
        v_role not in ('owner', 'store_admin', 'supervisor', 'courier_receiver')
        or not exists (
          select 1 from public.sync_records s
          where s.organization_id = p_organization_id
            and s.table_name = 'sessions'
            and s.record_id = v_payload->>'sessionId'
            and exists (
              select 1 from jsonb_array_elements(coalesce(s.payload->'items', '[]'::jsonb)) item
              where item->>'parcelId' = v_record_id and item->>'result' = 'ACCEPTED'
            )
        )
      ))
      or (v_role = 'courier_receiver' and v_table = 'parcels' and v_payload->>'status' <> 'HANDED_OVER')
      or (v_table not in ('sessions', 'incidents', 'imports') and v_role not in ('owner', 'store_admin', 'supervisor', 'handover_staff', 'courier_receiver')) then
      v_results := v_results || jsonb_build_array(jsonb_build_object(
        'queue_id', v_change->>'queue_id', 'table', v_table, 'record_id', v_record_id, 'status', 'forbidden'
      ));
      continue;
    end if;

    select * into v_current from public.sync_records
    where organization_id = p_organization_id and table_name = v_table and record_id = v_record_id
    for update;

    if v_table = 'audit' and found then
      v_results := v_results || jsonb_build_array(jsonb_build_object(
        'queue_id', v_change->>'queue_id', 'table', v_table, 'record_id', v_record_id,
        'status', case when (v_current.payload - 'actorUserId' - 'serverAcceptedAt') = v_payload then 'already_synced' else 'conflict' end,
        'version', v_current.updated_at, 'server_payload', v_current.payload
      ));
    elsif not found and v_change->>'expected_version' is null then
      if v_table = 'audit' then
        v_payload := v_payload || jsonb_build_object('actorUserId', v_user_id, 'serverAcceptedAt', clock_timestamp());
      end if;
      insert into public.sync_records (organization_id, table_name, record_id, payload, updated_by)
      values (p_organization_id, v_table, v_record_id, v_payload, v_user_id)
      returning updated_at into v_version;
      v_results := v_results || jsonb_build_array(jsonb_build_object(
        'queue_id', v_change->>'queue_id', 'table', v_table, 'record_id', v_record_id,
        'status', 'synced', 'version', v_version
      ));
    elsif v_change->>'expected_version' is null then
      v_results := v_results || jsonb_build_array(jsonb_build_object(
        'queue_id', v_change->>'queue_id', 'table', v_table, 'record_id', v_record_id,
        'status', case when v_current.payload = v_payload then 'already_synced' else 'conflict' end,
        'version', v_current.updated_at, 'server_payload', v_current.payload
      ));
    elsif v_current.updated_at <> (v_change->>'expected_version')::timestamptz then
      v_results := v_results || jsonb_build_array(jsonb_build_object(
        'queue_id', v_change->>'queue_id', 'table', v_table, 'record_id', v_record_id,
        'status', 'conflict', 'version', v_current.updated_at, 'server_payload', v_current.payload
      ));
    elsif v_current.payload = v_payload then
      v_results := v_results || jsonb_build_array(jsonb_build_object(
        'queue_id', v_change->>'queue_id', 'table', v_table, 'record_id', v_record_id,
        'status', 'already_synced', 'version', v_current.updated_at
      ));
    else
      update public.sync_records set payload = v_payload, updated_by = v_user_id, updated_at = clock_timestamp()
      where organization_id = p_organization_id and table_name = v_table and record_id = v_record_id
      returning updated_at into v_version;
      v_results := v_results || jsonb_build_array(jsonb_build_object(
        'queue_id', v_change->>'queue_id', 'table', v_table, 'record_id', v_record_id,
        'status', 'synced', 'version', v_version
      ));
    end if;
  end loop;
  return v_results;
end;
$$;

revoke all on function public.sync_local_changes(uuid, jsonb) from public;
grant execute on function public.sync_local_changes(uuid, jsonb) to authenticated;