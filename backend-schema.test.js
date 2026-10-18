const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { PGlite } = require('@electric-sql/pglite');

const schema = fs.readFileSync('supabase-schema.sql', 'utf8');
const authAndStorageStubs = `
  create role anon nologin;
  create role authenticated nologin;
  create schema auth;
  create table auth.users (id uuid primary key);
  create function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
  $$;
  create schema storage;
  create table storage.buckets (id text primary key, name text not null, public boolean not null);
  create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text not null, name text not null);
  create function storage.foldername(text) returns text[] language sql immutable as $$
    select string_to_array($1, '/')
  $$;
`;

test('Supabase schema enforces tenant RLS, roles, append-only audit, and version conflicts', async () => {
  const pg = new PGlite();
  try {
  await pg.exec(authAndStorageStubs);
  await pg.exec(schema);

  const ownerId = '00000000-0000-4000-8000-000000000001';
  const staffId = '00000000-0000-4000-8000-000000000002';
  const outsiderId = '00000000-0000-4000-8000-000000000003';
  await pg.query('insert into auth.users (id) values ($1),($2),($3)', [ownerId, staffId, outsiderId]);
  await pg.query("select set_config('request.jwt.claim.sub', $1, false)", [ownerId]);
  const orgResult = await pg.query('select public.create_organization($1) as id', ['Gudang A']);
  const organizationId = orgResult.rows[0].id;
  await pg.query('insert into public.organization_members (organization_id,user_id,role) values ($1,$2,$3)', [organizationId, staffId, 'handover_staff']);

  const insertParcel = [{ queue_id: 'parcels:p-1', table: 'parcels', record_id: 'p-1', expected_version: null, payload: { id: 'p-1', status: 'EXPECTED' } }];
  let result = await pg.query('select public.sync_local_changes($1,$2::jsonb) as result', [organizationId, JSON.stringify(insertParcel)]);
  assert.equal(result.rows[0].result[0].status, 'synced');

  result = await pg.query('select public.sync_local_changes($1,$2::jsonb) as result', [organizationId, JSON.stringify(insertParcel)]);
  assert.equal(result.rows[0].result[0].status, 'already_synced');

  const insertCollision = [{ ...insertParcel[0], payload: { id: 'p-1', status: 'SCANNED' } }];
  result = await pg.query('select public.sync_local_changes($1,$2::jsonb) as result', [organizationId, JSON.stringify(insertCollision)]);
  assert.equal(result.rows[0].result[0].status, 'conflict');

  const staleUpdate = [{ ...insertParcel[0], expected_version: '2000-01-01T00:00:00Z', payload: { id: 'p-1', status: 'SCANNED' } }];
  result = await pg.query('select public.sync_local_changes($1,$2::jsonb) as result', [organizationId, JSON.stringify(staleUpdate)]);
  assert.equal(result.rows[0].result[0].status, 'conflict');

  const handedWithoutSession = [{ ...insertParcel[0], expected_version: result.rows[0].result[0].version, payload: { id: 'p-1', status: 'HANDED_OVER', sessionId: 's-1' } }];
  await pg.query("select set_config('request.jwt.claim.sub', $1, false)", [staffId]);
  result = await pg.query('select public.sync_local_changes($1,$2::jsonb) as result', [organizationId, JSON.stringify(handedWithoutSession)]);
  assert.equal(result.rows[0].result[0].status, 'forbidden');

  const sessionChange = [{ queue_id: 'sessions:s-1', table: 'sessions', record_id: 's-1', expected_version: null, payload: { id: 's-1', items: [{ parcelId: 'p-1', result: 'ACCEPTED' }] } }];
  result = await pg.query('select public.sync_local_changes($1,$2::jsonb) as result', [organizationId, JSON.stringify(sessionChange)]);
  assert.equal(result.rows[0].result[0].status, 'forbidden');
  await pg.query("select set_config('request.jwt.claim.sub', $1, false)", [ownerId]);
  result = await pg.query('select public.sync_local_changes($1,$2::jsonb) as result', [organizationId, JSON.stringify(sessionChange)]);
  assert.equal(result.rows[0].result[0].status, 'synced');
  result = await pg.query('select public.sync_local_changes($1,$2::jsonb) as result', [organizationId, JSON.stringify(handedWithoutSession)]);
  assert.equal(result.rows[0].result[0].status, 'synced');

  const closedManifest = [{ queue_id: 'manifests:m-1', table: 'manifests', record_id: 'm-1', expected_version: null, payload: { id: 'm-1', status: 'CLOSED', closeReason: 'selisih' } }];
  await pg.query("select set_config('request.jwt.claim.sub', $1, false)", [staffId]);
  result = await pg.query('select public.sync_local_changes($1,$2::jsonb) as result', [organizationId, JSON.stringify(closedManifest)]);
  assert.equal(result.rows[0].result[0].status, 'forbidden');

  const auditEvent = [{ queue_id: 'audit:a-1', table: 'audit', record_id: 'a-1', expected_version: null, payload: { id: 'a-1', action: 'SCAN' } }];
  result = await pg.query('select public.sync_local_changes($1,$2::jsonb) as result', [organizationId, JSON.stringify(auditEvent)]);
  assert.equal(result.rows[0].result[0].status, 'synced');
  const tamperedAudit = [{ ...auditEvent[0], payload: { id: 'a-1', action: 'REWRITTEN' } }];
  result = await pg.query('select public.sync_local_changes($1,$2::jsonb) as result', [organizationId, JSON.stringify(tamperedAudit)]);
  assert.equal(result.rows[0].result[0].status, 'conflict');

  await pg.query("select set_config('request.jwt.claim.sub', $1, false)", [outsiderId]);
  await pg.query('select public.create_organization($1) as id', ['Gudang B']);
  await assert.rejects(pg.query('select public.sync_local_changes($1,$2::jsonb) as result', [organizationId, JSON.stringify(insertParcel)]), /Organization membership required/);

  await pg.exec('set role authenticated');
  const hiddenRows = await pg.query('select * from public.sync_records where organization_id = $1', [organizationId]);
  assert.equal(hiddenRows.rows.length, 0);
  await pg.exec('reset role');
  } finally {
    await pg.close();
  }
});