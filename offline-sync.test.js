const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { IDBFactory } = require('fake-indexeddb');

const source = fs.readFileSync('app.js', 'utf8');
const setupEnd = source.indexOf('function toast(');
const appStorage = new Function('indexedDB', `${source.slice(0, setupEnd)}
  return { init: async () => { db = await openDatabase(); }, dbPut, dbAdd, dbGet, dbGetAll, dbClear, close: () => db.close() };
`);

test('IndexedDB bisnis write atomically creates and coalesces an outbox item', async () => {
  const storage = appStorage(new IDBFactory());
  await storage.init();
  await storage.dbPut('settings', { key: 'organizationId', value: 'org-1' });

  await storage.dbPut('parcels', { id: 'parcel-1', awb: 'AWB-1', status: 'EXPECTED' });
  let pending = await storage.dbGetAll('outbox');
  assert.equal(pending.length, 1);
  assert.equal(pending[0].organizationId, 'org-1');
  assert.equal(pending[0].payload.status, 'EXPECTED');

  await storage.dbPut('parcels', { id: 'parcel-1', awb: 'AWB-1', status: 'SCANNED' });
  pending = await storage.dbGetAll('outbox');
  assert.equal(pending.length, 1);
  assert.equal(pending[0].payload.status, 'SCANNED');

  await assert.rejects(storage.dbAdd('parcels', { id: 'parcel-1', awb: 'duplicate' }));
  pending = await storage.dbGetAll('outbox');
  assert.equal(pending.length, 1);
  assert.equal(pending[0].payload.status, 'SCANNED');

  await storage.dbAdd('audit', { id: 'audit-1', action: 'SCAN' });
  await assert.rejects(storage.dbPut('audit', { id: 'audit-1', action: 'REWRITTEN' }), /tidak dapat ditimpa/);

  await storage.dbPut('settings', { key: 'organizationId', value: 'org-2' });
  await storage.dbPut('parcels', { id: 'parcel-2', awb: 'AWB-2', status: 'EXPECTED' });
  assert.deepEqual((await storage.dbGetAll('parcels')).map(parcel => parcel.id), ['parcel-2']);
  assert.equal(await storage.dbGet('parcels', 'parcel-1'), undefined);
  assert.deepEqual((await storage.dbGetAll('outbox')).map(item => item.organizationId), ['org-2']);
  await storage.dbPut('settings', { key: 'organizationId', value: '' });
  assert.deepEqual(await storage.dbGetAll('parcels'), []);
  assert.equal(await storage.dbGet('parcels', 'parcel-2'), undefined);
  storage.close();
});