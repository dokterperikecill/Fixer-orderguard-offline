const DB_NAME = 'dfixer-orderguard';
const DB_VERSION = 2;
const TABLES = ['parcels', 'manifests', 'sessions', 'incidents', 'imports', 'audit', 'settings', 'outbox', 'conflicts'];
const LABELS = {
  EXPECTED: 'Menunggu scan', SCANNED: 'Dipindai', HANDED_OVER: 'Diterima kurir',
  REJECTED: 'Ditolak kurir', CANCELLED: 'Dibatalkan', DRAFT: 'Draft', READY: 'Siap',
  OPEN: 'Terbuka', HANDOVER_IN_PROGRESS: 'Serah-terima berlangsung',
  RECONCILIATION_REQUIRED: 'Perlu rekonsiliasi', PARTIALLY_HANDED_OVER: 'Diterima sebagian',
  READY_FOR_CONFIRMATION: 'Siap dikonfirmasi', CONFIRMED: 'Terkonfirmasi', CLOSED: 'Ditutup',
  RESOLVED: 'Selesai', OPEN_INCIDENT: 'Terbuka', MATCH: 'Cocok', DUPLICATE_SCAN: 'Scan duplikat',
  NOT_IN_MANIFEST: 'Di luar manifest', ALREADY_HANDED_OVER: 'Sudah diserahkan',
  INVALID_PACKAGE: 'Resi tidak dikenal'
};
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const escapeHtml = (value = '') => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const makeId = prefix => `${prefix}_${crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}_${Math.random().toString(36).slice(2)}`}`;
const now = () => new Date().toISOString();
const fmtDate = value => value ? new Intl.DateTimeFormat('id-ID', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(value)) : '—';
const fmtTime = value => value ? new Intl.DateTimeFormat('id-ID', { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' }).format(new Date(value)) : '—';
const today = () => new Date().toISOString().slice(0, 10);
const normalize = value => String(value ?? '').trim().toLocaleUpperCase('id-ID');
const statusClass = status => ['SCANNED', 'PARTIALLY_HANDED_OVER', 'HANDOVER_IN_PROGRESS'].includes(status) ? 'blue' : ['EXPECTED', 'OPEN_INCIDENT', 'RECONCILIATION_REQUIRED'].includes(status) ? 'amber' : ['REJECTED', 'CANCELLED'].includes(status) ? 'red' : ['CLOSED', 'CONFIRMED', 'HANDED_OVER', 'RESOLVED'].includes(status) ? 'gray' : '';
const statusPill = status => `<span class="status-pill ${statusClass(status)}"><i class="status-dot"></i>${escapeHtml(LABELS[status] || status)}</span>`;

let db;
let backendClient;
let backendConfigKey = '';
let currentView = 'dashboard';
let selectedManifestId = '';
let importDraft = null;
let importRows = [];
let importHeaders = [];
let cameraStream = null;
let cameraFrame = 0;
let cameraDetector = null;
let cameraLastCode = '';
let cameraLastSeenAt = 0;
let handoverEvidence = '';
let handoverEvidenceManifestId = '';

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      for (const table of TABLES) {
        if (!database.objectStoreNames.contains(table)) database.createObjectStore(table, { keyPath: table === 'settings' ? 'key' : 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function dbGetAll(table) {
  return new Promise((resolve, reject) => {
    const request = db.transaction(table, 'readonly').objectStore(table).getAll();
    request.onsuccess = async () => {
      if (table === 'settings') return resolve(request.result);
      const organizationId = await setting('organizationId');
      if (!organizationId) return resolve(request.result.filter(record => !record.organizationId));
      resolve(request.result.filter(record => record.organizationId === organizationId));
    };
    request.onerror = () => reject(request.error);
  });
}

function dbGetAllRaw(table) {
  return new Promise((resolve, reject) => {
    const request = db.transaction(table, 'readonly').objectStore(table).getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function dbGet(table, id) {
  return new Promise((resolve, reject) => {
    const request = db.transaction(table, 'readonly').objectStore(table).get(id);
    request.onsuccess = async () => {
      if (table === 'settings') return resolve(request.result);
      const organizationId = await setting('organizationId');
      const record = request.result;
      if (record && (organizationId ? record.organizationId !== organizationId : Boolean(record.organizationId))) return resolve(undefined);
      resolve(record);
    };
    request.onerror = () => reject(request.error);
  });
}

async function writeRecord(table, record, method) {
  if (table === 'audit' && method !== 'add') throw new Error('Catatan audit tidak dapat ditimpa.');
  const tracksSync = !['settings', 'outbox', 'conflicts'].includes(table);
  const organizationId = tracksSync ? record.organizationId || await setting('organizationId') : '';
  if (tracksSync && organizationId) record.organizationId = organizationId;
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(tracksSync ? [table, 'outbox'] : table, 'readwrite');
    transaction.objectStore(table)[method](record);
    if (tracksSync) {
      transaction.objectStore('outbox').put({
        id: `${table}:${record.id}`,
        table,
        recordId: record.id,
        organizationId,
        payload: structuredClone(record),
        expectedVersion: record._syncVersion || null,
        queuedAt: now()
      });
    }
    transaction.oncomplete = () => resolve(record);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error || new Error('Penyimpanan lokal dibatalkan.'));
  });
}

function dbPut(table, record) { return writeRecord(table, record, 'put'); }

function dbAdd(table, record) {
  return writeRecord(table, record, 'add');
}

function dbLocalPut(table, record) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(table, 'readwrite');
    transaction.objectStore(table).put(record);
    transaction.oncomplete = () => resolve(record);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error || new Error('Penyimpanan lokal dibatalkan.'));
  });
}

function dbLocalDelete(table, id) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(table, 'readwrite');
    transaction.objectStore(table).delete(id);
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error || new Error('Penyimpanan lokal dibatalkan.'));
  });
}

function dbClear(table) {
  return new Promise((resolve, reject) => {
    const request = db.transaction(table, 'readwrite').objectStore(table).clear();
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

async function setting(key, fallback = '') {
  const entry = await dbGet('settings', key);
  return entry?.value ?? fallback;
}

async function audit(action, type, objectId, detail = '') {
  const operator = await setting('operator', 'Operator lokal');
  await dbAdd('audit', { id: makeId('audit'), action, type, objectId, detail, actor: operator, at: now() });
  $('#last-saved').textContent = `Disimpan ${new Intl.DateTimeFormat('id-ID', { hour: '2-digit', minute: '2-digit' }).format(new Date())}`;
}

async function getBackendClient() {
  const url = (await setting('supabaseUrl')).trim().replace(/\/$/, '');
  const key = (await setting('supabaseAnonKey')).trim();
  if (!url || !key) return null;
  const configKey = `${url}|${key}`;
  if (backendClient && backendConfigKey === configKey) return backendClient;
  if (!window.supabase?.createClient) throw new Error('Bundel Supabase belum tersedia. Muat ulang aplikasi saat online.');
  backendClient = window.supabase.createClient(url, key, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
  backendConfigKey = configKey;
  return backendClient;
}

async function authorize(roles, actionName) {
  const role = await setting('role', 'offline_operator');
  if (role === 'offline_operator' || roles.includes(role)) return true;
  toast(`Role ${LABELS[role] || role} tidak berwenang untuk ${actionName}.`, 'error');
  return false;
}

async function loadMemberships(client, userId) {
  const { data: memberships, error } = await client.from('organization_members').select('organization_id,role').eq('user_id', userId);
  if (error) throw error;
  if (!memberships.length) {
    await dbPut('settings', { key: 'memberships', value: [] });
    return [];
  }
  const ids = memberships.map(item => item.organization_id);
  const { data: organizations, error: orgError } = await client.from('organizations').select('id,name').in('id', ids);
  if (orgError) throw orgError;
  const names = new Map(organizations.map(item => [item.id, item.name]));
  const result = memberships.map(item => ({ id: item.organization_id, role: item.role, name: names.get(item.organization_id) || 'Organisasi' }));
  await dbPut('settings', { key: 'memberships', value: result });
  return result;
}

async function backendState() {
  const client = await getBackendClient();
  if (!client) return { client: null, session: null, memberships: await setting('memberships', []), organizationId: await setting('organizationId'), role: await setting('role', 'offline_operator') };
  const { data, error } = await client.auth.getSession();
  if (error) throw error;
  const cachedMemberships = await setting('memberships', []);
  let memberships = cachedMemberships;
  let membershipListIsFresh = false;
  if (data.session?.user && navigator.onLine) {
    try { memberships = await loadMemberships(client, data.session.user.id); membershipListIsFresh = true; }
    catch { memberships = cachedMemberships; }
  }
  let organizationId = await setting('organizationId');
  if (membershipListIsFresh && !memberships.some(item => item.id === organizationId)) {
    organizationId = memberships.length === 1 ? memberships[0].id : '';
    await dbPut('settings', { key: 'organizationId', value: organizationId });
    await dbPut('settings', { key: 'role', value: memberships.length === 1 ? memberships[0].role : 'offline_operator' });
  }
  let membership = memberships.find(item => item.id === organizationId);
  if (!membership && !organizationId && memberships.length === 1) {
    membership = memberships[0];
    await dbPut('settings', { key: 'organizationId', value: membership.id });
  }
  if (membership) await dbPut('settings', { key: 'role', value: membership.role });
  return { client, session: data.session, memberships, organizationId: membership?.id || organizationId, role: membership?.role || await setting('role', 'offline_operator') };
}

async function syncPull(client, organizationId) {
  let offset = 0;
  const pageSize = 500;
  while (true) {
    const { data, error } = await client.from('sync_records').select('table_name,record_id,payload,updated_at').eq('organization_id', organizationId).order('updated_at').range(offset, offset + pageSize - 1);
    if (error) throw error;
    for (const row of data) {
      const queueId = `${row.table_name}:${row.record_id}`;
      if (await dbGet('outbox', queueId) || await dbGet('conflicts', queueId)) continue;
      await dbLocalPut(row.table_name, { ...row.payload, organizationId, _syncVersion: row.updated_at });
    }
    if (data.length < pageSize) break;
    offset += pageSize;
  }
}

async function syncPending() {
  if (!navigator.onLine) { toast('Tidak ada koneksi. Perubahan tetap tersimpan di antrean lokal.', 'error'); return; }
  try {
    const state = await backendState();
    if (!state.client || !state.session) { toast('Atur backend dan masuk sebelum sinkronisasi.', 'error'); return; }
    if (!state.organizationId || !state.memberships.some(item => item.id === state.organizationId)) { toast('Pilih organisasi yang terhubung sebelum sinkronisasi.', 'error'); return; }
    const pending = (await dbGetAll('outbox')).filter(item => item.organizationId === state.organizationId).sort((a, b) => a.queuedAt.localeCompare(b.queuedAt));
    for (let index = 0; index < pending.length; index += 100) {
      const batch = pending.slice(index, index + 100);
      const prepared = await Promise.all(batch.map(item => prepareSyncChange(state.client, state.organizationId, item)));
      const changes = prepared.map(({ evidencePath, ...change }) => change);
      const { data, error } = await state.client.rpc('sync_local_changes', { p_organization_id: state.organizationId, p_changes: changes });
      if (error) throw error;
      for (const result of data || []) {
        const sent = batch.find(item => item.id === result.queue_id);
        const uploaded = prepared.find(item => item.queue_id === result.queue_id);
        await applySyncResult(result, sent, uploaded?.evidencePath);
      }
    }
    await syncPull(state.client, state.organizationId);
    await updateConnectionStatus();
    await render();
    const conflicts = (await dbGetAll('conflicts')).length;
    toast(conflicts ? `Sinkronisasi selesai; ${conflicts} konflik perlu ditinjau.` : 'Sinkronisasi selesai.');
  } catch (error) {
    await updateConnectionStatus();
    toast(`Sinkronisasi tertunda: ${error.message || 'backend tidak dapat dijangkau'}`, 'error');
  }
}

async function prepareSyncChange(client, organizationId, item) {
  const payload = structuredClone(item.payload);
  let evidencePath = '';
  if (item.table === 'sessions' && payload.evidence?.dataUrl) {
    const blob = await (await fetch(payload.evidence.dataUrl)).blob();
    const path = `${organizationId}/${item.recordId}.jpg`;
    const { error } = await client.storage.from('handover-evidence').upload(path, blob, { contentType: 'image/jpeg', upsert: true });
    if (error) throw error;
    evidencePath = path;
    payload.evidence = { path, contentType: 'image/jpeg' };
  }
  return { queue_id: item.id, table: item.table, record_id: item.recordId, payload, expected_version: item.expectedVersion, evidencePath };
}

async function applySyncResult(result, sent, evidencePath = '') {
  if (!sent) return;
  const currentQueue = await dbGet('outbox', sent.id);
  const queueUnchanged = currentQueue?.queuedAt === sent.queuedAt;
  if (result.status === 'synced' || result.status === 'already_synced') {
    const record = await dbGet(sent.table, sent.recordId);
    if (record) {
      record._syncVersion = result.version;
      if (evidencePath && record.evidence?.dataUrl) record.evidence = { path: evidencePath, contentType: 'image/jpeg' };
      await dbLocalPut(sent.table, record);
    }
    if (queueUnchanged) await dbLocalDelete('outbox', sent.id);
    else if (currentQueue) {
      currentQueue.expectedVersion = result.version;
      await dbLocalPut('outbox', currentQueue);
    }
  } else if (result.status === 'conflict') {
    await dbLocalPut('conflicts', { id: sent.id, table: sent.table, recordId: sent.recordId, organizationId: sent.organizationId, localPayload: sent.payload, serverPayload: result.server_payload || null, serverVersion: result.version || null, detectedAt: now() });
    if (queueUnchanged) await dbLocalDelete('outbox', sent.id);
    else if (currentQueue && result.version) {
      currentQueue.expectedVersion = result.version;
      await dbLocalPut('outbox', currentQueue);
    }
  } else if (result.status === 'forbidden') {
    await dbLocalPut('conflicts', { id: sent.id, table: sent.table, recordId: sent.recordId, organizationId: sent.organizationId, localPayload: sent.payload, serverPayload: result.server_payload || null, serverVersion: result.version || null, status: 'forbidden', detectedAt: now() });
    if (queueUnchanged) await dbLocalDelete('outbox', sent.id);
  }
}

async function updateConnectionStatus() {
  const pending = (await dbGetAll('outbox')).length;
  const conflicts = (await dbGetAll('conflicts')).length;
  const configured = Boolean(await getBackendClient().catch(() => null));
  const label = !navigator.onLine ? 'Offline · antrean lokal aktif' : configured ? `${pending} menunggu sync${conflicts ? ` · ${conflicts} konflik` : ''}` : 'Mode lokal · belum terhubung';
  $('#connection-label').textContent = label;
  const syncButton = $('#sync-now');
  if (syncButton) syncButton.disabled = !navigator.onLine || !configured;
}

async function maybeSyncPending() {
  if (!navigator.onLine) return;
  try {
    const client = await getBackendClient();
    if (!client || !(await setting('organizationId'))) return;
    const { data } = await client.auth.getSession();
    if (data.session) await syncPending();
    else await updateConnectionStatus();
  } catch { await updateConnectionStatus(); }
}

async function resolveSyncConflict(id, choice) {
  const conflict = await dbGet('conflicts', id);
  if (!conflict) return;
  if (choice === 'server') {
    if (conflict.serverPayload) await dbLocalPut(conflict.table, { ...conflict.serverPayload, organizationId: conflict.organizationId, _syncVersion: conflict.serverVersion });
    await dbLocalDelete('outbox', id);
  } else {
    const record = await dbGet(conflict.table, conflict.recordId);
    if (!record) { toast('Data lokal untuk konflik ini tidak ditemukan.', 'error'); return; }
    record._syncVersion = conflict.serverVersion;
    await dbLocalPut(conflict.table, record);
    await dbLocalPut('outbox', { id, table: conflict.table, recordId: conflict.recordId, organizationId: conflict.organizationId, payload: record, expectedVersion: conflict.serverVersion, queuedAt: now() });
  }
  await dbLocalDelete('conflicts', id);
  await audit('RESOLVE_SYNC_CONFLICT', conflict.table, conflict.recordId, `Pilihan ${choice === 'server' ? 'server' : 'perangkat lokal'}`);
  await render();
}

async function saveBackendConfig() {
  const url = $('#backend-url').value.trim().replace(/\/$/, '');
  const key = $('#backend-anon-key').value.trim();
  try {
    const parsed = new URL(url);
    if (!['https:', 'http:'].includes(parsed.protocol)) throw new Error('URL proyek harus menggunakan HTTPS atau HTTP lokal.');
    if (parsed.protocol === 'http:' && !['localhost', '127.0.0.1', '::1'].includes(parsed.hostname)) throw new Error('Backend non-lokal wajib menggunakan HTTPS.');
  } catch (error) { toast(error.message || 'URL proyek tidak valid.', 'error'); return; }
  if (!key) { toast('Anon key Supabase wajib diisi.', 'error'); return; }
  await dbPut('settings', { key: 'supabaseUrl', value: url });
  await dbPut('settings', { key: 'supabaseAnonKey', value: key });
  backendClient = null; backendConfigKey = '';
  await getBackendClient();
  await updateConnectionStatus(); await render();
  toast('Konfigurasi backend tersimpan di perangkat ini.');
}

async function authenticate(signUp = false) {
  const client = await getBackendClient();
  if (!client) { toast('Isi URL dan anon key backend terlebih dahulu.', 'error'); return; }
  const email = $('#auth-email').value.trim();
  const password = $('#auth-password').value;
  if (!$('#auth-form').reportValidity()) return;
  const result = signUp ? await client.auth.signUp({ email, password }) : await client.auth.signInWithPassword({ email, password });
  if (result.error) { toast(result.error.message, 'error'); return; }
  if (!result.data.session) toast('Akun dibuat. Periksa email untuk verifikasi sebelum masuk.', '');
  else toast(signUp ? 'Akun dibuat dan berhasil masuk.' : 'Berhasil masuk.');
  await render();
}

async function signOut() {
  const client = await getBackendClient();
  if (client) {
    const { error } = await client.auth.signOut({ scope: 'local' });
    if (error) { toast(error.message, 'error'); return; }
  }
  await dbPut('settings', { key: 'role', value: 'offline_operator' });
  await dbPut('settings', { key: 'memberships', value: [] });
  await render(); await updateConnectionStatus(); toast('Keluar dari sesi cloud. Data perangkat tetap tersimpan.');
}

async function queueUnassignedLocalData(organizationId) {
  let moved = 0;
  for (const table of ['parcels', 'manifests', 'sessions', 'incidents', 'imports', 'audit']) {
    const rows = await dbGetAllRaw(table);
    for (const record of rows.filter(item => !item.organizationId)) {
      record.organizationId = organizationId;
      record._syncVersion = null;
      if (table === 'audit') {
        await dbLocalPut(table, record);
        await dbPut('outbox', { id: `audit:${record.id}`, table: 'audit', recordId: record.id, organizationId, payload: structuredClone(record), expectedVersion: null, queuedAt: now() });
      } else await dbPut(table, record);
      moved++;
    }
  }
  return moved;
}

async function createOrganization() {
  const form = $('#organization-form');
  if (!form.reportValidity()) return;
  const client = await getBackendClient();
  const { data, error } = await client.rpc('create_organization', { p_name: $('#organization-name').value.trim() });
  if (error) { toast(error.message, 'error'); return; }
  await dbPut('settings', { key: 'organizationId', value: data });
  await dbPut('settings', { key: 'role', value: 'owner' });
  let attached = 0;
  if ($('#attach-local-data').checked) attached = await queueUnassignedLocalData(data);
  try { await loadMemberships(client, (await client.auth.getUser()).data.user.id); } catch {}
  await audit('CREATE_ORGANIZATION', 'organization', data, `Owner membuat organisasi${attached ? ` dan menautkan ${attached} catatan lokal` : ''}`);
  await render(); await updateConnectionStatus(); toast(`Organisasi dibuat. ${attached} catatan lokal masuk antrean.`);
}

async function chooseOrganization(id) {
  const memberships = await setting('memberships', []);
  const membership = memberships.find(item => item.id === id);
  await dbPut('settings', { key: 'organizationId', value: id });
  await dbPut('settings', { key: 'role', value: membership?.role || 'offline_operator' });
  await render(); await updateConnectionStatus();
}

function toast(message, kind = '') {
  const node = document.createElement('div');
  node.className = `toast ${kind}`;
  node.textContent = message;
  $('#toast-region').append(node);
  setTimeout(() => node.remove(), 3400);
}

function setView(view) {
  currentView = view;
  location.hash = view;
  render();
  $('#sidebar').classList.remove('open');
}

function emptyState(title, description, action = '') {
  return `<div class="empty-state"><div class="empty-mark">⌁</div><h3>${escapeHtml(title)}</h3><p>${escapeHtml(description)}</p>${action}</div>`;
}

function heading(eyebrow, title, subtitle, action = '') {
  return `<div class="page-heading"><div><p class="eyebrow">${escapeHtml(eyebrow)}</p><h1>${escapeHtml(title)}</h1><p class="page-subtitle">${escapeHtml(subtitle)}</p></div>${action}</div>`;
}

function metric(label, value, note, symbol) {
  return `<article class="metric-card"><div class="metric-top"><span>${escapeHtml(label)}</span><span class="metric-symbol">${symbol}</span></div><div class="metric-value">${value}</div><div class="metric-note">${escapeHtml(note)}</div></article>`;
}

function modal(title, subtitle, body, footer) {
  $('#toast-region').insertAdjacentHTML('beforebegin', `<div class="modal-backdrop" id="modal-backdrop"><section class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title"><header class="modal-header"><div><h2 id="modal-title">${escapeHtml(title)}</h2><p>${escapeHtml(subtitle)}</p></div><button class="icon-button" data-action="close-modal" aria-label="Tutup">×</button></header><div class="modal-body">${body}</div>${footer ? `<footer class="modal-footer">${footer}</footer>` : ''}</section></div>`);
}

function closeModal() {
  $('#modal-backdrop')?.remove();
  cameraStream?.getTracks().forEach(track => track.stop());
  cameraStream = null;
  cameraDetector = null;
  cameraLastCode = '';
  cameraLastSeenAt = 0;
  cancelAnimationFrame(cameraFrame);
}

async function render() {
  const root = $('#view-root');
  const names = { dashboard: 'Ringkasan', imports: 'Impor data', manifests: 'Manifest', scanner: 'Pemindaian', handover: 'Serah terima', incidents: 'Insiden', reports: 'Laporan & audit', settings: 'Pengaturan & backup' };
  $('#page-label').textContent = names[currentView] || 'Ringkasan';
  $$('.nav-link[data-view]').forEach(link => link.classList.toggle('active', link.dataset.view === currentView));
  const views = { dashboard: renderDashboard, imports: renderImports, manifests: renderManifestsOrDetail, scanner: renderScanner, handover: renderHandover, incidents: renderIncidents, reports: renderReports, settings: renderSettings };
  root.innerHTML = await (views[currentView] || renderDashboard)();
  if (currentView === 'handover' && $('#handover-form')) {
    attachHandoverEvidenceField();
    await attachSessionEvidenceButtons();
  }
  root.scrollTop = 0;
  await updateConnectionStatus();
  await updateNavigationCounts();
}

async function updateNavigationCounts() {
  const [manifests, imports, incidents] = await Promise.all([dbGetAll('manifests'), dbGetAll('imports'), dbGetAll('incidents')]);
  $('#manifest-count').textContent = manifests.filter(item => !['CLOSED', 'CANCELLED'].includes(item.status)).length || '';
  $('#import-count').textContent = imports.length || '';
  $('#incident-count').textContent = incidents.filter(item => item.status !== 'RESOLVED').length || '';
}

async function renderDashboard() {
  const [parcels, manifests, incidents, sessions, operator] = await Promise.all([dbGetAll('parcels'), dbGetAll('manifests'), dbGetAll('incidents'), dbGetAll('sessions'), setting('operator', 'Operator lokal')]);
  const active = manifests.filter(manifest => !['CLOSED', 'CANCELLED'].includes(manifest.status));
  const openIncidents = incidents.filter(incident => incident.status !== 'RESOLVED');
  const planned = parcels.filter(parcel => !['CANCELLED'].includes(parcel.status)).length;
  const scanned = parcels.filter(parcel => ['SCANNED', 'HANDED_OVER', 'REJECTED'].includes(parcel.status)).length;
  const activeIds = new Set(active.map(manifest => manifest.id));
  const missing = parcels.filter(parcel => parcel.status === 'EXPECTED' && activeIds.has(parcel.manifestId)).length;
  const recent = [...manifests].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 5);
  const rows = recent.length ? recent.map(manifest => {
    const members = parcels.filter(parcel => parcel.manifestId === manifest.id);
    const done = members.filter(parcel => parcel.status === 'HANDED_OVER').length;
    const exceptions = members.filter(parcel => ['EXPECTED', 'REJECTED'].includes(parcel.status)).length;
    const state = manifest.status === 'CLOSED' ? 'CLOSED' : exceptions ? 'RECONCILIATION_REQUIRED' : done && done < members.length ? 'PARTIALLY_HANDED_OVER' : manifest.status;
    return `<tr data-open-manifest="${escapeHtml(manifest.id)}"><td><span class="table-primary">${escapeHtml(manifest.code)}</span><div class="table-secondary">${escapeHtml(manifest.store)} · ${escapeHtml(manifest.courier)}</div></td><td>${fmtDate(manifest.planDate)}</td><td>${members.length}</td><td>${done}/${members.length}</td><td>${statusPill(state)}</td></tr>`;
  }).join('') : `<tr><td colspan="5" class="empty-row">Belum ada manifest. Impor daftar paket untuk memulai.</td></tr>`;
  const attention = [
    openIncidents.length ? `<div class="attention-item"><span class="attention-icon red">⚑</span><div><strong>${openIncidents.length} insiden perlu ditinjau</strong><small>Catatan selisih belum diselesaikan</small></div></div>` : '',
    missing ? `<div class="attention-item"><span class="attention-icon">⌗</span><div><strong>${missing} paket belum dipindai</strong><small>Tersebar di manifest yang masih aktif</small></div></div>` : '',
    active.length ? `<div class="attention-item"><span class="attention-icon">▤</span><div><strong>${active.length} manifest masih terbuka</strong><small>Pantau pemindaian dan konfirmasi kurir</small></div></div>` : ''
  ].filter(Boolean).join('');
  return `${heading(`Ringkasan · ${fmtDate(today())}`, `Selamat bekerja, ${operator}`, 'Ringkasan pergerakan paket di perangkat ini.', `<button class="button button-dark" data-action="go-import">＋ Buat manifest dari impor</button>`)}
    <section class="metric-grid">${metric('Paket direncanakan', planned, 'Dalam semua manifest tersimpan', '▤')}${metric('Dipindai / diserahkan', scanned, `${sessions.length} sesi serah-terima tercatat`, '⌗')}${metric('Belum dipindai', missing, 'Paket yang masih menunggu', '◷')}${metric('Insiden terbuka', openIncidents.length, 'Perlu tindak lanjut', '⚑')}</section>
    <div class="dashboard-grid"><section class="panel"><div class="panel-heading"><h2 class="section-title">Manifest terbaru</h2><a class="text-link" href="#manifests" data-view="manifests">Semua manifest →</a></div><div class="table-wrap"><table><thead><tr><th>Manifest / tujuan</th><th>Jadwal</th><th>Rencana</th><th>Diterima</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table></div></section>
      <section class="panel"><div class="panel-heading"><h2 class="section-title">Perlu perhatian</h2><a class="text-link" href="#incidents" data-view="incidents">Buka insiden</a></div><div class="attention-list">${attention || `<div class="empty-row">Tidak ada pengecualian yang menunggu.</div>`}</div></section></div>
    <div class="quick-strip"><button class="quick-action" data-view="imports"><span>⇧</span><span><strong>Impor daftar paket</strong><small>CSV dengan pemetaan kolom</small></span></button><button class="quick-action" data-view="scanner"><span>⌗</span><span><strong>Pindai manifest</strong><small>Input manual atau barcode scanner</small></span></button><button class="quick-action" data-view="handover"><span>⇄</span><span><strong>Catat serah-terima</strong><small>Simpan penerimaan per sesi</small></span></button></div>`;
}

function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  const input = text.replace(/^\uFEFF/, '');
  for (let index = 0; index < input.length; index++) {
    const char = input[index];
    if (char === '"') {
      if (quoted && input[index + 1] === '"') { field += '"'; index++; }
      else quoted = !quoted;
    } else if (char === ',' && !quoted) { row.push(field.trim()); field = ''; }
    else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && input[index + 1] === '\n') index++;
      row.push(field.trim());
      if (row.some(value => value !== '')) rows.push(row);
      row = []; field = '';
    } else field += char;
  }
  if (quoted) throw new Error('Tanda kutip CSV tidak berpasangan.');
  row.push(field.trim());
  if (row.some(value => value !== '')) rows.push(row);
  if (rows.length < 2) throw new Error('File harus memiliki baris judul dan setidaknya satu baris data.');
  const headers = rows.shift().map((header, index) => header || `Kolom ${index + 1}`);
  return { headers, rows: rows.map(values => Object.fromEntries(headers.map((header, index) => [header, values[index] || '']))) };
}

function parseWorkbook(buffer) {
  const workbook = XLSX.read(buffer, { type: 'array', cellDates: false });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  if (!sheet) throw new Error('Workbook tidak memiliki sheet.');
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: false });
  if (rows.length < 2) throw new Error('Sheet harus memiliki judul dan setidaknya satu baris data.');
  if (rows.length > 30001) throw new Error('Maksimal 30.000 baris data per file.');
  const headers = rows.shift().map((header, index) => String(header || `Kolom ${index + 1}`).trim());
  return { headers, rows: rows.filter(row => row.some(value => String(value ?? '').trim() !== '')).map(values => Object.fromEntries(headers.map((header, index) => [header, String(values[index] ?? '').trim()]))) };
}

function suggestField(header) {
  const value = normalize(header).replace(/[^A-Z0-9]/g, '');
  if (/^(ORDER|ORDERID|ORDERNO|NOMORPESANAN|IDPESANAN|PESANAN)$/.test(value)) return 'order';
  if (/^(AWB|RESI|NOMORRESI|TRACKING|TRACKINGNUMBER|WAYBILL|NORESI)$/.test(value)) return 'awb';
  if (/^(TOKO|STORE|SHOP|NAMA TOKO)$/.test(value)) return 'store';
  if (/^(COURIER|KURIR|EKSPEDISI|SHIPPINGPROVIDER|EXPEDITION)$/.test(value)) return 'courier';
  if (/^(PLANDATE|TANGGALRENCANA|TANGGALSERAH|TANGGAL)$/.test(value)) return 'planDate';
  if (/^(QTY|JUMLAHPAKET|JUMLAH|PACKAGEQUANTITY)$/.test(value)) return 'quantity';
  if (/^(NOTE|CATATAN|REMARKS|KETERANGAN)$/.test(value)) return 'note';
  return '';
}

function mappingSelect(field, required, headers) {
  const names = { order: 'Nomor pesanan', awb: 'Nomor resi', store: 'Toko', courier: 'Kurir / ekspedisi', planDate: 'Tanggal rencana', quantity: 'Jumlah paket', note: 'Catatan' };
  const current = importDraft?.mapping?.[field] || '';
  const options = headers.map(header => `<option value="${escapeHtml(header)}" ${current === header ? 'selected' : ''}>${escapeHtml(header)}</option>`).join('');
  return `<div class="mapping-item"><label>${names[field]}${required ? ' · wajib' : ''}</label><select class="select" data-map-field="${field}"><option value="">${required ? 'Pilih kolom' : 'Tidak dipetakan'}</option>${options}</select></div>`;
}

function buildPreview() {
  const map = importDraft.mapping;
  const seen = new Set();
  const existing = new Set(importDraft.existingAwbs);
  return importRows.map((raw, index) => {
    const awb = String(raw[map.awb] || '').trim();
    const order = String(raw[map.order] || '').trim();
    const courier = String(raw[map.courier] || '').trim();
    const quantity = map.quantity ? String(raw[map.quantity] || '').trim() : '1';
    const key = normalize(awb);
    let issue = '';
    if (!order) issue = 'Nomor pesanan kosong';
    else if (!awb) issue = 'Nomor resi kosong';
    else if (!courier) issue = 'Kurir belum diisi';
    else if (map.quantity && !quantity) issue = 'Jumlah paket kosong';
    else if (Number(quantity) !== 1) issue = 'Jumlah harus 1 (satu baris = satu paket)';
    else if (seen.has(key)) issue = 'Resi duplikat di file';
    else if (existing.has(key)) issue = 'Resi sudah ada di perangkat';
    if (key) seen.add(key);
    return { index, raw, awb, order, courier, issue };
  });
}

async function renderImports() {
  const jobs = (await dbGetAll('imports')).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const preview = importDraft ? buildPreview() : [];
  const valid = preview.filter(row => !row.issue).length;
  const errors = preview.length - valid;
  const previewMarkup = importDraft ? `<section class="panel" style="margin-top:16px"><div class="panel-heading"><h2 class="section-title">Pemetaan & pratinjau · ${escapeHtml(importDraft.fileName)}</h2><button class="button button-light button-small" data-action="clear-import">Buang file</button></div><div class="panel-body"><div class="mapping-grid">${mappingSelect('order', true, importHeaders)}${mappingSelect('awb', true, importHeaders)}${mappingSelect('courier', true, importHeaders)}${mappingSelect('store', false, importHeaders)}${mappingSelect('planDate', false, importHeaders)}${mappingSelect('quantity', false, importHeaders)}${mappingSelect('note', false, importHeaders)}</div><div class="preview-summary"><span class="summary-chip"><strong>${preview.length}</strong> baris</span><span class="summary-chip"><strong>${valid}</strong> valid</span><span class="summary-chip"><strong>${errors}</strong> perlu diperbaiki</span></div><div class="table-wrap"><table><thead><tr><th>Baris</th><th>Nomor pesanan</th><th>Nomor resi</th><th>Kurir</th><th>Hasil validasi</th></tr></thead><tbody>${preview.slice(0, 120).map(row => `<tr><td>${row.index + 2}</td><td>${escapeHtml(row.order || '—')}</td><td>${escapeHtml(row.awb || '—')}</td><td>${escapeHtml(row.courier || '—')}</td><td>${row.issue ? `<span class="status-pill red">${escapeHtml(row.issue)}</span>` : '<span class="status-pill">Valid</span>'}</td></tr>`).join('')}${preview.length > 120 ? `<tr><td colspan="5" class="empty-row">Menampilkan 120 baris pertama dari ${preview.length}.</td></tr>` : ''}</tbody></table></div><div class="toolbar" style="justify-content:space-between;margin-top:14px"><span class="muted">Baris bermasalah tetap masuk laporan impor, tidak dibuat menjadi paket.</span><button class="button button-dark" data-action="commit-import" ${valid ? '' : 'disabled'}>Simpan ${valid} paket valid</button></div></div></section>` : '';
  const history = jobs.length ? jobs.map(job => `<tr><td><span class="table-primary">${escapeHtml(job.fileName)}</span><div class="table-secondary">${fmtTime(job.createdAt)}</div></td><td>${job.total}</td><td>${job.accepted}</td><td>${job.rejected}</td><td>${statusPill(job.rejected ? 'RECONCILIATION_REQUIRED' : 'CONFIRMED')}</td></tr>`).join('') : `<tr><td colspan="5" class="empty-row">Belum ada riwayat impor.</td></tr>`;
  return `${heading('Data masuk', 'Impor paket', 'Pilih CSV atau XLSX, petakan kolom, lalu tinjau setiap hasil validasi sebelum disimpan.', '<button class="button button-light" data-action="sample-csv">↓ Contoh CSV</button>')}
    <div class="callout blue"><span>ⓘ</span><span>CSV UTF-8 dan XLSX dibaca seluruhnya di browser; file tidak diunggah. Untuk XLSX, sheet pertama digunakan. Satu baris mewakili satu paket.</span></div>
    <section class="panel" style="margin-top:15px"><div class="panel-heading"><h2 class="section-title">Pilih file sumber</h2></div><div class="panel-body"><label class="upload-zone" for="csv-file"><span><span class="upload-icon">⇧</span><strong id="upload-label">Pilih file CSV atau XLSX dari perangkat</strong><small>Maksimal 20 MB dan 30.000 baris · kolom minimum: pesanan, resi, kurir</small></span></label><input id="csv-file" type="file" accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" hidden></div></section>
    ${previewMarkup}<section class="panel" style="margin-top:18px"><div class="panel-heading"><h2 class="section-title">Riwayat impor</h2><span class="muted">Tersimpan lokal</span></div><div class="table-wrap"><table><thead><tr><th>File</th><th>Baris</th><th>Disimpan</th><th>Ditolak</th><th>Hasil</th></tr></thead><tbody>${history}</tbody></table></div></section>`;
}

async function handleFile(file) {
  try {
    if (file.size > 20 * 1024 * 1024) throw new Error('Ukuran file melebihi batas 20 MB.');
    const extension = file.name.toLocaleLowerCase('id-ID').split('.').pop();
    const parsed = extension === 'csv' ? parseCsv(await file.text()) : extension === 'xlsx' ? parseWorkbook(await file.arrayBuffer()) : null;
    if (!parsed) throw new Error('Format file harus CSV atau XLSX.');
    importHeaders = parsed.headers;
    importRows = parsed.rows;
    const parcels = await dbGetAll('parcels');
    const mapping = Object.fromEntries(['order', 'awb', 'store', 'courier', 'planDate', 'quantity', 'note'].map(field => [field, importHeaders.find(header => suggestField(header) === field) || '']));
    importDraft = { fileName: file.name, mapping, existingAwbs: parcels.map(parcel => normalize(parcel.awb)) };
    await render();
    toast(`${parsed.rows.length} baris siap ditinjau.`);
  } catch (error) { toast(error.message || 'File tidak dapat dibaca.', 'error'); }
}

async function commitImport() {
  if (!(await authorize(['owner', 'store_admin'], 'mengimpor paket'))) return;
  if (!importDraft) return;
  const preview = buildPreview();
  const accepted = preview.filter(row => !row.issue);
  const rejected = preview.filter(row => row.issue);
  const jobId = makeId('import');
  const job = { id: jobId, fileName: importDraft.fileName, total: preview.length, accepted: accepted.length, rejected: rejected.length, createdAt: now(), errors: rejected.map(row => ({ row: row.index + 2, awb: row.awb, reason: row.issue })) };
  for (const row of accepted) {
    const mapping = importDraft.mapping;
    const store = String(row.raw[mapping.store] || 'Gudang Utama').trim() || 'Gudang Utama';
    const planDateRaw = String(row.raw[mapping.planDate] || '').trim();
    const parcel = { id: makeId('parcel'), orderNo: row.order, awb: row.awb, normalizedAwb: normalize(row.awb), store, courier: row.courier, planDate: planDateRaw, quantity: 1, note: String(row.raw[mapping.note] || '').trim(), status: 'EXPECTED', manifestId: '', importId: jobId, createdAt: now() };
    await dbAdd('parcels', parcel);
  }
  await dbAdd('imports', job);
  await audit('IMPORT_CSV', 'import', jobId, `${accepted.length} paket disimpan; ${rejected.length} baris ditolak`);
  importDraft = null; importHeaders = []; importRows = [];
  await render();
  toast(`${accepted.length} paket tersimpan. ${rejected.length} baris dicatat sebagai gagal.`);
}

async function renderManifests() {
  const [manifests, parcels] = await Promise.all([dbGetAll('manifests'), dbGetAll('parcels')]);
  manifests.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const content = manifests.length ? `<div class="manifest-list">${manifests.map(manifest => {
    const members = parcels.filter(parcel => parcel.manifestId === manifest.id);
    const received = members.filter(parcel => parcel.status === 'HANDED_OVER').length;
    const missing = members.filter(parcel => ['EXPECTED', 'REJECTED'].includes(parcel.status)).length;
    const state = manifest.status === 'CLOSED' ? 'CLOSED' : missing ? 'RECONCILIATION_REQUIRED' : received && received < members.length ? 'PARTIALLY_HANDED_OVER' : manifest.status;
    return `<article class="manifest-list-item"><div><div class="manifest-code">${escapeHtml(manifest.code)}</div><div class="item-subtitle">${escapeHtml(manifest.store)} · ${escapeHtml(manifest.courier)} · ${fmtDate(manifest.planDate)}</div></div><div class="item-actions"><span class="muted">${received}/${members.length} diterima</span>${statusPill(state)}<button class="button button-light button-small" data-open-manifest="${escapeHtml(manifest.id)}">Buka →</button></div></article>`;
  }).join('')}</div>` : emptyState('Belum ada manifest', 'Paket yang lolos validasi impor akan muncul di sini dan bisa dikelompokkan berdasarkan toko serta kurir.', '<button class="button button-dark" data-view="imports">Impor paket</button>');
  return `${heading('Daftar kerja', 'Manifest', 'Kelompok rencana pengiriman, pemindaian, dan hasil serah-terima.', '<button class="button button-dark" data-action="new-manifest">＋ Buat manifest</button>')}<div class="toolbar" style="margin-bottom:14px"><input class="input filter-input" id="manifest-filter" placeholder="Cari ID, toko, kurir..."><span class="muted">${manifests.length} manifest tersimpan</span></div><div id="manifest-list-root">${content}</div>`;
}

async function openNewManifest() {
  if (!(await authorize(['owner', 'store_admin', 'supervisor'], 'membuat manifest'))) return;
  const parcels = await dbGetAll('parcels');
  const candidates = parcels.filter(parcel => parcel.status === 'EXPECTED' && !parcel.manifestId);
  if (!candidates.length) { toast('Belum ada paket siap dimasukkan. Impor daftar paket terlebih dahulu.', 'error'); return; }
  const stores = [...new Set(candidates.map(parcel => parcel.store))].sort();
  const couriers = [...new Set(candidates.map(parcel => parcel.courier))].sort();
  const body = `<form id="manifest-form" class="stack"><div class="form-grid"><div class="field"><label for="manifest-store">Toko</label><select class="select" id="manifest-store" required>${stores.map(store => `<option>${escapeHtml(store)}</option>`).join('')}</select></div><div class="field"><label for="manifest-courier">Kurir / ekspedisi</label><select class="select" id="manifest-courier" required>${couriers.map(courier => `<option>${escapeHtml(courier)}</option>`).join('')}</select></div><div class="field"><label for="manifest-date">Tanggal rencana</label><input class="input" id="manifest-date" type="date" value="${today()}" required></div><div class="field"><label for="manifest-location">Lokasi</label><input class="input" id="manifest-location" placeholder="Contoh: Gudang A"></div></div><div class="callout"><span>▤</span><span><strong id="candidate-count">${candidates.length} paket siap</strong><br>Semua paket yang belum memiliki manifest untuk toko dan kurir terpilih akan dimasukkan.</span></div></form>`;
  modal('Buat manifest', 'Paket yang ditautkan tidak dapat dipakai di manifest aktif lain.', body, '<button class="button button-light" data-action="close-modal">Batal</button><button class="button button-dark" data-action="save-manifest">Buat manifest</button>');
  const updateCount = () => {
    const count = candidates.filter(parcel => parcel.store === $('#manifest-store').value && parcel.courier === $('#manifest-courier').value).length;
    $('#candidate-count').textContent = `${count} paket siap`;
  };
  $('#manifest-store').addEventListener('change', updateCount);
  $('#manifest-courier').addEventListener('change', updateCount);
  updateCount();
}

async function saveManifest() {
  const form = $('#manifest-form');
  if (!form.reportValidity()) return;
  const store = $('#manifest-store').value;
  const courier = $('#manifest-courier').value;
  const parcels = (await dbGetAll('parcels')).filter(parcel => parcel.status === 'EXPECTED' && !parcel.manifestId && parcel.store === store && parcel.courier === courier);
  if (!parcels.length) { toast('Tidak ada paket yang memenuhi pilihan tersebut.', 'error'); return; }
  const createdAt = now();
  const code = `OG-${createdAt.slice(2, 10).replaceAll('-', '')}-${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
  const manifest = { id: makeId('manifest'), code, store, courier, planDate: $('#manifest-date').value, location: $('#manifest-location').value.trim(), createdAt, createdBy: await setting('operator', 'Operator lokal'), status: 'OPEN', scanEvents: [] };
  await dbAdd('manifests', manifest);
  for (const parcel of parcels) { parcel.manifestId = manifest.id; await dbPut('parcels', parcel); }
  await audit('CREATE_MANIFEST', 'manifest', manifest.id, `${parcels.length} paket · ${store} · ${courier}`);
  selectedManifestId = manifest.id;
  closeModal(); setView('manifests');
  toast(`Manifest ${code} dibuat dengan ${parcels.length} paket.`);
}

async function renderManifestDetail(id) {
  const manifest = await dbGet('manifests', id);
  if (!manifest) { setView('manifests'); return; }
  const parcels = (await dbGetAll('parcels')).filter(parcel => parcel.manifestId === id);
  const sessions = (await dbGetAll('sessions')).filter(session => session.manifestId === id).sort((a, b) => b.confirmedAt.localeCompare(a.confirmedAt));
  const accepted = parcels.filter(parcel => parcel.status === 'HANDED_OVER').length;
  const pending = parcels.filter(parcel => parcel.status === 'EXPECTED').length;
  const scanned = parcels.filter(parcel => parcel.status === 'SCANNED').length;
  const rows = parcels.map(parcel => `<tr><td><span class="table-primary">${escapeHtml(parcel.awb)}</span><div class="table-secondary">Pesanan ${escapeHtml(parcel.orderNo)}</div></td><td>${escapeHtml(parcel.store)}</td><td>${statusPill(parcel.status)}</td><td>${fmtTime(parcel.scannedAt)}</td></tr>`).join('');
  const sessionRows = sessions.length ? sessions.map(session => `<tr><td><span class="table-primary">${escapeHtml(session.code)}</span><div class="table-secondary">${fmtTime(session.confirmedAt)}</div></td><td>${escapeHtml(session.handoverBy)}</td><td>${escapeHtml(session.receiver)}</td><td>${session.items.filter(item => item.result === 'ACCEPTED').length} diterima · ${session.items.filter(item => item.result === 'REJECTED').length} ditolak</td></tr>`).join('') : '<tr><td colspan="4" class="empty-row">Belum ada sesi terkonfirmasi.</td></tr>';
  return `${heading('Manifest', manifest.code, `${manifest.store} · ${manifest.courier} · dibuat ${fmtTime(manifest.createdAt)}`, `<button class="button button-light" data-action="back-manifests">← Kembali</button>`)}<div class="toolbar" style="margin:-10px 0 16px"><button class="button button-dark button-small" data-action="scan-manifest" data-id="${escapeHtml(id)}">⌗ Pindai paket</button><button class="button button-light button-small" data-action="handover-manifest" data-id="${escapeHtml(id)}">⇄ Siapkan serah-terima</button>${manifest.status !== 'CLOSED' ? `<button class="button button-light button-small" data-action="close-manifest" data-id="${escapeHtml(id)}">Tutup manifest</button>` : statusPill('CLOSED')}</div>
    <div class="detail-grid" style="margin-bottom:16px"><div class="detail-cell"><small>Rencana</small><strong>${parcels.length}</strong></div><div class="detail-cell"><small>Diterima</small><strong>${accepted}</strong></div><div class="detail-cell"><small>Belum dipindai</small><strong>${pending}</strong></div><div class="detail-cell"><small>Menunggu sesi</small><strong>${scanned}</strong></div></div>
    ${pending || parcels.some(parcel => parcel.status === 'REJECTED') ? `<div class="callout red" style="margin-bottom:15px"><span>!</span><span>${pending} paket belum dipindai. Manifest hanya dapat ditutup setelah sisa paket diberi alasan dan pengecualian dicatat.</span></div>` : ''}
    <section class="panel"><div class="panel-heading"><div class="tabs"><button class="tab-button active" data-action="detail-tab" data-tab="parcels">Daftar paket (${parcels.length})</button><button class="tab-button" data-action="detail-tab" data-tab="sessions">Sesi serah-terima (${sessions.length})</button></div><button class="button button-light button-small" data-action="export-manifest" data-id="${escapeHtml(id)}">↓ CSV</button></div><div id="manifest-tab-content" class="table-wrap"><table><thead><tr><th>Nomor resi / pesanan</th><th>Toko</th><th>Status paket</th><th>Waktu scan</th></tr></thead><tbody>${rows || '<tr><td colspan="4" class="empty-row">Tidak ada paket.</td></tr>'}</tbody></table></div></section>`;
}

async function renderManifestsOrDetail() {
  return selectedManifestId ? renderManifestDetail(selectedManifestId) : renderManifests();
}

async function renderScanner() {
  const manifests = (await dbGetAll('manifests')).filter(manifest => !['CLOSED', 'CANCELLED'].includes(manifest.status));
  if (!manifests.length) return `${heading('Pemindaian', 'Pemindai paket', 'Pilih manifest aktif untuk mulai mencocokkan nomor resi.')}${emptyState('Belum ada manifest untuk dipindai', 'Buat manifest dari paket yang sudah lolos validasi impor.', '<button class="button button-dark" data-view="manifests">Buka manifest</button>')}`;
  if (!manifests.some(manifest => manifest.id === selectedManifestId)) selectedManifestId = manifests[0].id;
  const manifest = manifests.find(item => item.id === selectedManifestId);
  const parcels = (await dbGetAll('parcels')).filter(parcel => parcel.manifestId === manifest.id);
  const events = [...(manifest.scanEvents || [])].reverse().slice(0, 12);
  const scanned = parcels.filter(parcel => parcel.status === 'SCANNED').length;
  const handed = parcels.filter(parcel => parcel.status === 'HANDED_OVER').length;
  const missing = parcels.filter(parcel => parcel.status === 'EXPECTED').length;
  const logs = events.length ? events.map(event => `<div class="scan-log-row"><div><strong>${escapeHtml(event.code)}</strong><small>${fmtTime(event.at)}</small></div>${statusPill(event.result)}</div>`).join('') : '<div class="empty-row">Belum ada scan di manifest ini.</div>';
  return `${heading('Operasional', 'Pemindaian paket', 'Setiap input dipadankan dengan manifest aktif. Hasil scan tersimpan lokal.', '')}<div class="toolbar" style="margin:-9px 0 15px"><label class="muted" for="scanner-manifest">Manifest aktif</label><select class="select" style="max-width:360px" id="scanner-manifest">${manifests.map(item => `<option value="${escapeHtml(item.id)}" ${item.id === manifest.id ? 'selected' : ''}>${escapeHtml(item.code)} · ${escapeHtml(item.store)} / ${escapeHtml(item.courier)}</option>`).join('')}</select></div>
    <div class="scanner-layout"><section class="panel scanner-stage"><p class="eyebrow">${escapeHtml(manifest.code)} · ${escapeHtml(manifest.courier)}</p><h2>Scan nomor resi</h2><p>Scanner barcode yang bertindak sebagai keyboard bisa langsung mengetik ke kolom ini. Enter akan mencatat hasilnya.</p><form class="scan-form" id="scan-form"><input class="input" id="scan-input" autocomplete="off" placeholder="Ketik / scan nomor resi" autofocus required><button class="button button-lime">Catat scan <span>↵</span></button></form><div class="scan-result" id="scan-result" aria-live="polite">Fokus kolom input lalu scan paket berikutnya.</div></section>
    <section class="panel scanner-side"><div class="panel-heading"><h2 class="section-title">Progres manifest</h2>${statusPill(manifest.status)}</div><div class="mini-stat"><span>Dipindai, menunggu sesi</span><strong>${scanned}</strong></div><div class="mini-stat"><span>Sudah diterima</span><strong>${handed}</strong></div><div class="mini-stat"><span>Belum dipindai</span><strong>${missing}</strong></div><div class="panel-heading"><h2 class="section-title">Aktivitas scan</h2></div><div class="scan-log">${logs}</div></section></div>`;
}

async function openCameraScanner() {
  const manifests = (await dbGetAll('manifests')).filter(manifest => !['CLOSED', 'CANCELLED'].includes(manifest.status));
  if (!manifests.length) { toast('Buat manifest sebelum membuka kamera.', 'error'); return; }
  if (!navigator.mediaDevices?.getUserMedia || !('BarcodeDetector' in window)) {
    toast('Pemindaian kamera tidak didukung browser ini. Gunakan scanner USB/Bluetooth atau input manual.', 'error');
    setView('scanner');
    return;
  }
  if (!manifests.some(manifest => manifest.id === selectedManifestId)) selectedManifestId = manifests[0].id;
  setView('scanner');
  const supported = await BarcodeDetector.getSupportedFormats();
  const formats = ['code_128', 'code_39', 'ean_13', 'ean_8', 'qr_code', 'itf', 'upc_a', 'upc_e'].filter(format => supported.includes(format));
  if (!formats.length) { toast('Browser tidak menyediakan format barcode yang didukung.', 'error'); return; }
  modal('Pindai dengan kamera', 'Arahkan barcode ke area kamera; hasil dipadankan dengan manifest aktif.', '<video class="camera-video" id="camera-video" autoplay muted playsinline></video><p class="field-hint" id="camera-message">Meminta izin kamera…</p>', '<button class="button button-light" data-action="close-modal">Tutup kamera</button>');
  try {
    cameraDetector = new BarcodeDetector({ formats });
    cameraStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
    const video = $('#camera-video');
    video.srcObject = cameraStream;
    await video.play();
    $('#camera-message').textContent = 'Kamera aktif. Tahan barcode dalam bingkai.';
    scanCameraFrame();
  } catch (error) {
    closeModal();
    toast(`Kamera tidak dapat dibuka: ${error.message}`, 'error');
  }
}

async function scanCameraFrame() {
  const video = $('#camera-video');
  if (!cameraStream || !video) return;
  try {
    if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
      const [barcode] = await cameraDetector.detect(video);
      if (barcode?.rawValue) {
        const detectedAt = Date.now();
        const isRepeatedFrame = barcode.rawValue === cameraLastCode && detectedAt - cameraLastSeenAt < 1800;
        cameraLastCode = barcode.rawValue;
        cameraLastSeenAt = detectedAt;
        if (!isRepeatedFrame) {
          $('#camera-message').textContent = `Terbaca: ${barcode.rawValue}`;
          const result = await scanPackage(barcode.rawValue);
          if ($('#scan-result')) $('#scan-result').textContent = result.message;
        }
      } else if (Date.now() - cameraLastSeenAt >= 1800) {
        cameraLastCode = '';
      }
    }
  } catch { }
  if (cameraStream) cameraFrame = requestAnimationFrame(scanCameraFrame);
}

function attachHandoverEvidenceField() {
  const form = $('#handover-form');
  if (handoverEvidenceManifestId && handoverEvidenceManifestId !== selectedManifestId) handoverEvidence = '';
  handoverEvidenceManifestId = selectedManifestId;
  if ($('#handover-evidence')) return;
  const field = document.createElement('div');
  field.className = 'field';
  field.innerHTML = `<label for="handover-evidence">Foto bukti (opsional)</label><input class="input" id="handover-evidence" type="file" accept="image/*" capture="environment"><span class="field-hint" id="handover-evidence-state">${handoverEvidence ? 'Foto bukti siap disertakan.' : 'Bisa diambil langsung dengan kamera HP; akan dikompresi lokal.'}</span>`;
  form.insertBefore(field, form.querySelector('.check-line'));
}

async function attachSessionEvidenceButtons() {
  const sessions = (await dbGetAll('sessions')).sort((a, b) => b.confirmedAt.localeCompare(a.confirmedAt)).slice(0, 8);
  const rows = $$('#view-root .table-wrap table tbody tr');
  sessions.forEach((session, index) => {
    if (!rows[index]) return;
    const cell = document.createElement('td');
    if (session.evidence) {
      const button = document.createElement('button');
      button.className = 'button button-light button-small';
      button.textContent = 'Lihat bukti';
      button.dataset.action = 'view-session-evidence';
      button.dataset.id = session.id;
      cell.append(button);
    } else cell.innerHTML = '<span class="muted">—</span>';
    rows[index].append(cell);
  });
}

async function viewSessionEvidence(id) {
  const session = await dbGet('sessions', id);
  if (!session?.evidence) return;
  let src = session.evidence.dataUrl || '';
  if (!src && session.evidence.path) {
    const client = await getBackendClient();
    if (!client || !navigator.onLine) { toast('Foto ini tersedia di server; sambungkan internet untuk melihatnya.', 'error'); return; }
    const { data, error } = await client.storage.from('handover-evidence').createSignedUrl(session.evidence.path, 60);
    if (error) { toast(error.message, 'error'); return; }
    src = data.signedUrl;
  }
  modal('Bukti foto sesi', `${session.code} · ${session.manifestCode}`, `<img class="evidence-viewer" src="${escapeHtml(src)}" alt="Bukti serah-terima ${escapeHtml(session.code)}">`, '<button class="button button-light" data-action="close-modal">Tutup</button>');
}

async function compressEvidence(file) {
  if (!file) return '';
  if (!file.type.startsWith('image/')) throw new Error('Bukti harus berupa gambar.');
  if (file.size > 12 * 1024 * 1024) throw new Error('Ukuran foto maksimal 12 MB.');
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 1280 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return canvas.toDataURL('image/jpeg', .72);
}

async function scanPackage(code) {
    if (!(await authorize(['owner', 'store_admin', 'supervisor', 'handover_staff', 'courier_receiver'], 'memindai paket'))) return { result: 'FORBIDDEN', message: 'Role saat ini tidak berwenang memindai paket.' };
  const manifest = await dbGet('manifests', selectedManifestId);
  if (!manifest) return { result: 'INVALID_PACKAGE', message: 'Pilih manifest terlebih dahulu.' };
  const input = code.trim();
  const parcels = await dbGetAll('parcels');
  const parcel = parcels.find(item => item.normalizedAwb === normalize(input));
  let result, message;
  if (!input || !parcel) { result = 'INVALID_PACKAGE'; message = 'Nomor resi tidak dikenali dalam data lokal.'; }
  else if (parcel.status === 'HANDED_OVER') { result = 'ALREADY_HANDED_OVER'; message = 'Paket sudah tercatat diterima pada sesi sebelumnya.'; }
  else if (parcel.manifestId !== manifest.id) { result = 'NOT_IN_MANIFEST'; message = 'Paket dikenal, tetapi tidak termasuk manifest aktif.'; }
  else if (parcel.status === 'SCANNED') { result = 'DUPLICATE_SCAN'; message = 'Paket ini sudah dipindai di manifest tersebut.'; }
  else if (parcel.status === 'CANCELLED' || parcel.status === 'REJECTED') { result = 'CANCELLED'; message = `Paket berstatus ${LABELS[parcel.status].toLowerCase()} dan tidak dapat dipindai normal.`; }
  else { result = 'MATCH'; message = `Cocok · ${parcel.awb} · pesanan ${parcel.orderNo}`; parcel.status = 'SCANNED'; parcel.scannedAt = now(); parcel.scannedBy = await setting('operator', 'Operator lokal'); await dbPut('parcels', parcel); }
  manifest.scanEvents ||= [];
  manifest.scanEvents.push({ id: makeId('scan'), code: input, result, at: now(), parcelId: parcel?.id || '' });
  await dbPut('manifests', manifest);
  await audit('SCAN_PACKAGE', 'manifest', manifest.id, `${input}: ${result}`);
  return { result, message };
}

async function renderHandover() {
  const manifests = (await dbGetAll('manifests')).filter(manifest => !['CLOSED', 'CANCELLED'].includes(manifest.status));
  const sessions = (await dbGetAll('sessions')).sort((a, b) => b.confirmedAt.localeCompare(a.confirmedAt));
  if (!manifests.length && !sessions.length) return `${heading('Bukti transaksi', 'Serah-terima', 'Catatan penerimaan kurir per sesi, termasuk pengambilan bertahap.')}${emptyState('Belum ada paket untuk diserahkan', 'Manifest dan hasil pemindaian akan tersedia di sini.', '<button class="button button-dark" data-view="manifests">Buka manifest</button>')}`;
  if (!manifests.some(item => item.id === selectedManifestId)) selectedManifestId = manifests[0]?.id || '';
  const manifest = manifests.find(item => item.id === selectedManifestId);
  const parcels = manifest ? (await dbGetAll('parcels')).filter(parcel => parcel.manifestId === manifest.id) : [];
  const eligible = parcels.filter(parcel => ['SCANNED', 'REJECTED'].includes(parcel.status));
  const sessionList = sessions.length ? sessions.slice(0, 8).map(session => `<tr><td><span class="table-primary">${escapeHtml(session.code)}</span><div class="table-secondary">${escapeHtml(session.manifestCode)} · ${fmtTime(session.confirmedAt)}</div></td><td>${escapeHtml(session.receiver)}</td><td>${session.items.filter(item => item.result === 'ACCEPTED').length}</td><td>${session.items.filter(item => item.result === 'REJECTED').length}</td><td>${statusPill('CONFIRMED')}</td></tr>`).join('') : '<tr><td colspan="5" class="empty-row">Sesi yang sudah dikonfirmasi akan tercatat di sini.</td></tr>';
  return `${heading('Bukti transaksi', 'Serah-terima', 'Pilih paket aktual yang diterima atau ditolak, lalu konfirmasi sebagai sesi tersendiri.')}
    ${manifest ? `<div class="toolbar" style="margin:-9px 0 15px"><label class="muted" for="handover-manifest">Manifest</label><select class="select" style="max-width:420px" id="handover-manifest">${manifests.map(item => `<option value="${escapeHtml(item.id)}" ${item.id === manifest.id ? 'selected' : ''}>${escapeHtml(item.code)} · ${escapeHtml(item.store)} / ${escapeHtml(item.courier)}</option>`).join('')}</select></div><div class="handover-layout"><section class="panel"><div class="panel-heading"><h2 class="section-title">Paket dipindai · ${eligible.length}</h2><label class="check-line"><input type="checkbox" id="select-all-items" checked> Pilih semua</label></div><div class="selection-list">${eligible.length ? eligible.map(parcel => `<label class="select-row"><input type="checkbox" class="handover-check" value="${escapeHtml(parcel.id)}" data-result="ACCEPTED" checked><span><strong>${escapeHtml(parcel.awb)}</strong><small>Pesanan ${escapeHtml(parcel.orderNo)}${parcel.status === 'REJECTED' ? ' · sebelumnya ditolak' : ''}</small></span><select class="select handover-result" data-parcel="${escapeHtml(parcel.id)}" style="width:120px;min-height:29px;padding:4px 6px;font-size:9px"><option value="ACCEPTED">Diterima</option><option value="REJECTED">Ditolak</option><option value="DEFERRED">Tunda</option></select></label>`).join('') : '<div class="empty-row">Belum ada paket dipindai. Paket harus dipindai sebelum bisa dicatat ke sesi.</div>'}</div></section><section class="panel"><div class="panel-heading"><h2 class="section-title">Konfirmasi sesi</h2></div><form id="handover-form" class="panel-body stack"><div class="field"><label for="handover-by">Diserahkan oleh</label><input class="input" id="handover-by" value="${escapeHtml(await setting('operator', 'Operator lokal'))}" required></div><div class="field"><label for="handover-receiver">Penerima / kurir</label><input class="input" id="handover-receiver" placeholder="Nama petugas atau kurir" required></div><div class="field"><label for="handover-note">Catatan sesi</label><textarea class="textarea" id="handover-note" placeholder="Kondisi atau catatan selisih"></textarea></div><label class="check-line"><input id="handover-confirm-check" type="checkbox" required> Saya memeriksa daftar paket dan mencatat penerimaan aktual.</label><button class="button button-dark" ${eligible.length ? '' : 'disabled'}>Konfirmasi sesi</button><span class="field-hint">Sesi yang dikonfirmasi tidak dapat ditimpa. Penolakan dan paket tertunda tetap tercatat.</span></form></section></div>` : ''}
    <section class="panel" style="margin-top:16px"><div class="panel-heading"><h2 class="section-title">Riwayat sesi</h2><span class="muted">${sessions.length} sesi</span></div><div class="table-wrap"><table><thead><tr><th>ID sesi / manifest</th><th>Penerima</th><th>Diterima</th><th>Ditolak</th><th>Status</th><th>Bukti</th></tr></thead><tbody>${sessionList}</tbody></table></div></section>`;
}

async function confirmHandover() {
  if (!(await authorize(['owner', 'store_admin', 'supervisor', 'courier_receiver'], 'mengonfirmasi serah-terima'))) return;
  const form = $('#handover-form');
  if (!form.reportValidity()) return;
  const manifest = await dbGet('manifests', selectedManifestId);
  if (!manifest) return;
  const checks = $$('.handover-check:checked');
  const choices = new Map($$('.handover-result').map(select => [select.dataset.parcel, select.value]));
  const items = checks.filter(check => choices.get(check.value) !== 'DEFERRED').map(check => ({ parcelId: check.value, result: choices.get(check.value) }));
  if (!items.length) { toast('Pilih minimal satu paket untuk sesi ini.', 'error'); return; }
  const sessionId = makeId('session');
  const confirmedAt = now();
  const code = `HO-${confirmedAt.slice(2, 10).replaceAll('-', '')}-${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
  const session = { id: sessionId, code, manifestId: manifest.id, manifestCode: manifest.code, items, handoverBy: $('#handover-by').value.trim(), receiver: $('#handover-receiver').value.trim(), note: $('#handover-note').value.trim(), confirmedAt, confirmed: true, evidence: handoverEvidence ? { dataUrl: handoverEvidence, contentType: 'image/jpeg' } : null };
  await dbAdd('sessions', session);
  for (const item of items) {
    const parcel = await dbGet('parcels', item.parcelId);
    if (!parcel || !['SCANNED', 'REJECTED'].includes(parcel.status)) continue;
    parcel.status = item.result === 'ACCEPTED' ? 'HANDED_OVER' : 'REJECTED';
    parcel.handedOverAt = item.result === 'ACCEPTED' ? confirmedAt : '';
    parcel.sessionId = session.id;
    await dbPut('parcels', parcel);
    if (item.result === 'REJECTED') {
      await dbAdd('incidents', { id: makeId('incident'), category: 'Paket ditolak kurir', awb: parcel.awb, manifestId: manifest.id, manifestCode: manifest.code, description: `Paket ditolak pada sesi ${code}${session.note ? `: ${session.note}` : '.'}`, reporter: session.handoverBy, createdAt: confirmedAt, status: 'OPEN_INCIDENT', resolution: '', resolvedAt: '' });
    }
  }
  const updatedParcels = (await dbGetAll('parcels')).filter(parcel => parcel.manifestId === manifest.id);
  manifest.status = updatedParcels.every(parcel => parcel.status === 'HANDED_OVER') ? 'CONFIRMED' : 'PARTIALLY_HANDED_OVER';
  await dbPut('manifests', manifest);
  await audit('CONFIRM_HANDOVER', 'session', session.id, `${code} · ${items.length} paket · penerima ${session.receiver}`);
  handoverEvidence = '';
  closeModal(); await render(); toast(`Sesi ${code} dikonfirmasi; catatan penerimaan tersimpan.`);
}

async function renderIncidents() {
  const incidents = (await dbGetAll('incidents')).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const open = incidents.filter(item => item.status !== 'RESOLVED');
  const cards = incidents.length ? incidents.map(incident => `<article class="incident-card"><span class="attention-icon ${incident.status === 'RESOLVED' ? '' : 'red'}">⚑</span><div><h3>${escapeHtml(incident.category)}${incident.awb ? ` · ${escapeHtml(incident.awb)}` : ''}</h3><p>${escapeHtml(incident.description)}${incident.resolution ? `<br><strong>Tindakan:</strong> ${escapeHtml(incident.resolution)}` : ''}</p><p style="margin-top:5px">${escapeHtml(incident.manifestCode || 'Tanpa manifest')} · Dilaporkan ${escapeHtml(incident.reporter)} · ${fmtTime(incident.createdAt)}</p></div><div>${incident.status === 'RESOLVED' ? statusPill('RESOLVED') : `<button class="button button-light button-small" data-action="resolve-incident" data-id="${escapeHtml(incident.id)}">Tindak lanjuti</button>`}</div></article>`).join('') : emptyState('Belum ada insiden', 'Paket tidak cocok, selisih, dan penolakan kurir bisa dicatat untuk ditinjau.');
  return `${heading('Pengecualian', 'Insiden & selisih', 'Simpan alasan, paket terkait, penanggung jawab, dan tindakan perbaikan.', '<button class="button button-dark" data-action="new-incident">＋ Catat insiden</button>')}<div class="detail-grid" style="margin-bottom:15px"><div class="detail-cell"><small>Total insiden</small><strong>${incidents.length}</strong></div><div class="detail-cell"><small>Perlu tindak lanjut</small><strong>${open.length}</strong></div><div class="detail-cell"><small>Diselesaikan</small><strong>${incidents.length - open.length}</strong></div><div class="detail-cell"><small>Catatan terbaru</small><strong>${incidents.length ? fmtDate(incidents[0].createdAt) : '—'}</strong></div></div><section class="panel">${cards}</section>`;
}

async function openIncidentForm() {
    if (!(await authorize(['owner', 'store_admin', 'supervisor', 'handover_staff'], 'mencatat insiden'))) return;
  const [manifests, parcels] = await Promise.all([dbGetAll('manifests'), dbGetAll('parcels')]);
  const body = `<form id="incident-form" class="stack"><div class="form-grid"><div class="field"><label for="incident-category">Kategori</label><select class="select" id="incident-category"><option>Paket kurang</option><option>Paket berlebih / di luar manifest</option><option>Resi duplikat</option><option>Paket ditolak kurir</option><option>Kesalahan impor</option><option>Paket sudah diserahkan</option><option>Kesalahan pemindaian</option><option>Lainnya</option></select></div><div class="field"><label for="incident-package">Nomor resi (opsional)</label><input class="input" id="incident-package" list="incident-awbs" placeholder="Cari resi"><datalist id="incident-awbs">${parcels.map(parcel => `<option value="${escapeHtml(parcel.awb)}">${escapeHtml(parcel.orderNo)}</option>`).join('')}</datalist></div><div class="field span-2"><label for="incident-manifest">Manifest terkait</label><select class="select" id="incident-manifest"><option value="">Tanpa manifest</option>${manifests.map(item => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.code)} · ${escapeHtml(item.store)}</option>`).join('')}</select></div><div class="field span-2"><label for="incident-description">Deskripsi</label><textarea class="textarea" id="incident-description" required placeholder="Jelaskan apa yang terjadi"></textarea></div></div></form>`;
  modal('Catat insiden', 'Insiden lokal akan memiliki jejak tindakan dan waktu.', body, '<button class="button button-light" data-action="close-modal">Batal</button><button class="button button-dark" data-action="save-incident">Simpan insiden</button>');
}

async function saveIncident() {
  const form = $('#incident-form');
  if (!form.reportValidity()) return;
  const manifestId = $('#incident-manifest').value;
  const manifest = manifestId ? await dbGet('manifests', manifestId) : null;
  const incident = { id: makeId('incident'), category: $('#incident-category').value, awb: $('#incident-package').value.trim(), manifestId, manifestCode: manifest?.code || '', description: $('#incident-description').value.trim(), reporter: await setting('operator', 'Operator lokal'), createdAt: now(), status: 'OPEN_INCIDENT', resolution: '', resolvedAt: '' };
  await dbAdd('incidents', incident);
  await audit('CREATE_INCIDENT', 'incident', incident.id, incident.category);
  closeModal(); await render(); toast('Insiden tercatat.');
}

async function resolveIncident(id) {
  const incident = await dbGet('incidents', id);
  if (!incident || incident.status === 'RESOLVED') return;
  const body = `<form id="resolve-form" class="stack"><div class="callout"><span>⚑</span><span>${escapeHtml(incident.category)} · ${escapeHtml(incident.awb || incident.manifestCode || 'tanpa paket terkait')}</span></div><div class="field"><label for="resolution-text">Tindakan perbaikan / alasan selesai</label><textarea id="resolution-text" class="textarea" required placeholder="Catat hasil peninjauan"></textarea></div></form>`;
  modal('Tindak lanjuti insiden', 'Penyelesaian menambahkan catatan audit, tidak menghapus laporan awal.', body, `<button class="button button-light" data-action="close-modal">Batal</button><button class="button button-dark" data-action="save-resolution" data-id="${escapeHtml(id)}">Tandai selesai</button>`);
}

async function saveResolution(id) {
    if (!(await authorize(['owner', 'store_admin', 'supervisor'], 'menyelesaikan insiden'))) return;
  const form = $('#resolve-form');
  if (!form.reportValidity()) return;
  const incident = await dbGet('incidents', id);
  if (!incident || incident.status === 'RESOLVED') return;
  incident.status = 'RESOLVED'; incident.resolution = $('#resolution-text').value.trim(); incident.resolvedAt = now(); incident.resolvedBy = await setting('operator', 'Operator lokal');
  await dbPut('incidents', incident);
  await audit('RESOLVE_INCIDENT', 'incident', id, incident.resolution);
  closeModal(); await render(); toast('Tindakan penyelesaian tersimpan.');
}

async function renderReports() {
  const [parcels, manifests, sessions, incidents, auditRows] = await Promise.all([dbGetAll('parcels'), dbGetAll('manifests'), dbGetAll('sessions'), dbGetAll('incidents'), dbGetAll('audit')]);
  const rows = [...auditRows].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 100);
  const auditTable = rows.length ? rows.map(entry => `<tr><td>${fmtTime(entry.at)}</td><td>${escapeHtml(entry.actor)}</td><td><span class="table-primary">${escapeHtml(entry.action)}</span></td><td>${escapeHtml(entry.type)} · ${escapeHtml(entry.objectId)}</td><td>${escapeHtml(entry.detail)}</td></tr>`).join('') : '<tr><td colspan="5" class="empty-row">Aktivitas penting akan muncul setelah Anda mulai bekerja.</td></tr>';
  return `${heading('Transparansi operasional', 'Laporan & audit', 'Angka dihitung dari daftar paket dan catatan transaksi lokal.', '<button class="button button-dark" data-action="export-report">↓ Ekspor paket CSV</button>')}<div class="metric-grid">${metric('Paket', parcels.length, 'Seluruh paket terimpor', '▤')}${metric('Manifest', manifests.length, 'Termasuk yang ditutup', '▣')}${metric('Sesi terkonfirmasi', sessions.length, 'Penerimaan aktual per sesi', '⇄')}${metric('Insiden', incidents.length, `${incidents.filter(item => item.status !== 'RESOLVED').length} belum selesai`, '⚑')}</div><section class="panel"><div class="panel-heading"><h2 class="section-title">Jejak audit</h2><span class="muted">${auditRows.length} aktivitas</span></div><div class="table-wrap"><table><thead><tr><th>Waktu</th><th>Aktor</th><th>Tindakan</th><th>Objek</th><th>Detail</th></tr></thead><tbody>${auditTable}</tbody></table></div></section><div class="callout blue" style="margin-top:13px"><span>ⓘ</span><span>Audit ini tersimpan pada profil browser ini. Data lokal dapat diubah oleh pengguna perangkat melalui developer tools; gunakan backup terkontrol dan perangkat yang aksesnya dibatasi.</span></div>`;
}

async function renderSettings() {
  const operator = await setting('operator', 'Operator lokal');
  const workspace = await setting('workspace', 'Gudang Utama');
  const [parcels, manifests, sessions, incidents, imports, auditRows, pending, conflicts] = await Promise.all(['parcels', 'manifests', 'sessions', 'incidents', 'imports', 'audit', 'outbox', 'conflicts'].map(table => dbGetAll(table)));
  const total = parcels.length + manifests.length + sessions.length + incidents.length + imports.length + auditRows.length;
  const backendUrl = await setting('supabaseUrl');
  const anonKey = await setting('supabaseAnonKey');
  let state = { client: null, session: null, memberships: await setting('memberships', []), organizationId: await setting('organizationId'), role: await setting('role', 'offline_operator') };
  let backendError = '';
  try { state = await backendState(); } catch (error) { backendError = error.message; }
  const memberships = state.memberships || [];
  const selectedMembership = memberships.find(item => item.id === state.organizationId);
  const authPanel = state.session ? `<div class="callout"><span>●</span><span>Masuk sebagai <strong>${escapeHtml(state.session.user.email)}</strong><br>Role perangkat: <strong>${escapeHtml(state.role)}</strong></span></div><div class="field"><label for="organization-select">Organisasi aktif</label><select class="select" id="organization-select"><option value="">Data lokal tanpa organisasi</option>${memberships.map(item => `<option value="${escapeHtml(item.id)}" ${item.id === state.organizationId ? 'selected' : ''}>${escapeHtml(item.name)} · ${escapeHtml(item.role)}</option>`).join('')}</select></div><div class="data-actions"><button class="button button-dark" data-action="sync-now" ${navigator.onLine && state.organizationId ? '' : 'disabled'}>↻ Sinkronkan ${pending.length ? `(${pending.length})` : ''}</button><button class="button button-light" data-action="refresh-memberships">Muat ulang organisasi</button><button class="button button-light" data-action="sign-out">Keluar</button></div>${memberships.length ? '' : `<form id="organization-form" class="stack"><div class="field"><label for="organization-name">Nama organisasi baru</label><input class="input" id="organization-name" minlength="2" maxlength="120" required></div><label class="check-line"><input id="attach-local-data" type="checkbox"> Tautkan ${total} catatan lokal yang belum memiliki organisasi</label><button class="button button-dark" style="justify-self:start">Buat organisasi</button></form>`}` : `<form id="auth-form" class="stack"><div class="field"><label for="auth-email">Email</label><input id="auth-email" class="input" type="email" autocomplete="username" required></div><div class="field"><label for="auth-password">Kata sandi</label><input id="auth-password" class="input" type="password" minlength="8" autocomplete="current-password" required></div><div class="data-actions"><button class="button button-dark">Masuk</button><button type="button" class="button button-light" data-action="sign-up">Buat akun</button></div><span class="field-hint">Akun awal dapat dibuat di sini jika pendaftaran email diaktifkan pada proyek Supabase.</span></form>`;
  const conflictRows = conflicts.length ? conflicts.map(conflict => `<article class="incident-card"><span class="attention-icon red">↔</span><div><h3>${escapeHtml(conflict.table)} · ${escapeHtml(conflict.recordId)}</h3><p>${conflict.status === 'forbidden' ? `Server menolak perubahan karena role ${escapeHtml(state.role)} tidak memiliki izin. Data lokal tetap tersimpan; minta owner memperbarui role lalu coba lagi.` : 'Data pada server berubah sejak perangkat terakhir sinkron. Pilih satu versi; pilihan lokal akan dikirim ulang dengan versi server terbaru.'}</p><p class="muted">Terdeteksi ${fmtTime(conflict.detectedAt)}</p></div><div class="stack"><button class="button button-dark button-small" data-action="resolve-conflict" data-choice="local" data-id="${escapeHtml(conflict.id)}">${conflict.status === 'forbidden' ? 'Coba lagi lokal' : 'Pakai lokal'}</button>${conflict.status === 'forbidden' ? '' : `<button class="button button-light button-small" data-action="resolve-conflict" data-choice="server" data-id="${escapeHtml(conflict.id)}">Pakai server</button>`}</div></article>`).join('') : '';
  return `${heading('Data perangkat', 'Pengaturan & backup', 'Identitas kerja dan salinan data disimpan pada browser ini.')}
    <section class="panel" style="margin-bottom:15px"><div class="panel-heading"><h2 class="section-title">Akun & sinkronisasi</h2><span class="status-pill ${state.session ? 'blue' : 'amber'}"><i class="status-dot"></i>${state.session ? 'Akun aktif' : 'Mode lokal'}</span></div><div class="panel-body stack"><form id="backend-config-form" class="form-grid"><div class="field"><label for="backend-url">URL proyek Supabase</label><input id="backend-url" class="input" type="url" value="${escapeHtml(backendUrl)}" placeholder="https://project.supabase.co" required></div><div class="field"><label for="backend-anon-key">Publishable / anon key</label><input id="backend-anon-key" class="input" value="${escapeHtml(anonKey)}" autocomplete="off" required></div><div class="span-2 toolbar"><button class="button button-light button-small">Simpan koneksi</button><span class="field-hint">Gunakan publishable key saja, jangan masukkan service-role key. Nilai tersimpan lokal di browser ini.</span></div></form>${backendError ? `<div class="callout red">${escapeHtml(backendError)}</div>` : ''}${authPanel}</div></section>
    ${conflicts.length ? `<section class="panel" style="margin-bottom:15px"><div class="panel-heading"><h2 class="section-title">Konflik sinkronisasi · ${conflicts.length}</h2></div>${conflictRows}</section>` : ''}
    <div class="settings-grid"><section class="panel"><div class="panel-heading"><h2 class="section-title">Profil perangkat</h2></div><form class="panel-body stack" id="settings-form"><div class="field"><label for="settings-workspace">Nama ruang kerja</label><input id="settings-workspace" class="input" value="${escapeHtml(workspace)}" required></div><div class="field"><label for="settings-operator">Nama operator</label><input id="settings-operator" class="input" value="${escapeHtml(operator)}" required></div><button class="button button-dark" style="justify-self:start">Simpan pengaturan</button></form></section>
    <section class="panel"><div class="panel-heading"><h2 class="section-title">Backup & pemulihan</h2></div><div class="panel-body stack"><div class="detail-grid" style="grid-template-columns:repeat(2,1fr)"><div class="detail-cell"><small>Entitas lokal</small><strong>${total}</strong></div><div class="detail-cell"><small>Menunggu sync</small><strong>${pending.length}</strong></div></div><p class="muted">Backup JSON mencakup paket, manifest, sesi, konflik, antrean, insiden, impor, pengaturan, dan audit. Simpan salinan pada lokasi aman.</p><div class="data-actions"><button class="button button-dark" data-action="backup-data">↓ Unduh backup JSON</button><button class="button button-light" data-action="restore-data">↑ Pulihkan backup</button></div><hr class="divider"><button class="button button-danger button-small" data-action="clear-data" style="justify-self:start">Hapus semua data lokal</button><span class="muted">Penghapusan permanen untuk profil browser ini.</span></div></section></div>
    <h2 class="subsection">Batas keamanan</h2><div class="callout blue"><span>ⓘ</span><span>RLS dan pemeriksaan role berlaku di server saat sinkron. Tindakan offline tetap tersimpan lokal dan belum dapat diverifikasi server sampai perangkat tersambung. Log lokal bukan bukti anti-manipulasi; gunakan SQL skema Supabase dan perangkat dengan akses terbatas.</span></div>`;
}

function csvDownload(fileName, rows) {
  const quote = value => `"${String(value ?? '').replaceAll('"', '""')}"`;
  const csv = `\uFEFF${rows.map(row => row.map(quote).join(',')).join('\r\n')}`;
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  link.download = fileName; link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

async function exportParcels(manifestId = '') {
  const parcels = await dbGetAll('parcels');
  const manifests = await dbGetAll('manifests');
  const manifestById = new Map(manifests.map(manifest => [manifest.id, manifest.code]));
  const items = manifestId ? parcels.filter(parcel => parcel.manifestId === manifestId) : parcels;
  csvDownload(manifestId ? `manifest-${manifestById.get(manifestId) || 'paket'}.csv` : 'orderguard-paket.csv', [['Nomor Pesanan', 'Nomor Resi', 'Toko', 'Kurir', 'Tanggal Rencana', 'Status', 'Manifest', 'Catatan'], ...items.map(parcel => [parcel.orderNo, parcel.awb, parcel.store, parcel.courier, parcel.planDate, LABELS[parcel.status] || parcel.status, manifestById.get(parcel.manifestId) || '', parcel.note])]);
  await audit('EXPORT_CSV', 'parcel', manifestId || 'all', `${items.length} paket diekspor`);
  toast(`${items.length} paket diekspor ke CSV.`);
}

async function backupData() {
  const data = { app: 'D\'Fixer OrderGuard', version: 1, exportedAt: now(), tables: {} };
  for (const table of TABLES) data.tables[table] = await dbGetAll(table);
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  link.download = `orderguard-backup-${today()}.json`; link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  await audit('BACKUP_EXPORT', 'backup', today(), 'Backup JSON diunduh');
  toast('Backup JSON berhasil dibuat.');
}

async function restoreData(file) {
  try {
    const backup = JSON.parse(await file.text());
    if (backup.app !== 'D\'Fixer OrderGuard' || !backup.tables || !TABLES.every(table => Array.isArray(backup.tables[table]))) throw new Error('Struktur backup tidak dikenali.');
    if (!confirm('Pemulihan akan mengganti seluruh data lokal saat ini. Lanjutkan?')) return;
    for (const table of TABLES) {
      await dbClear(table);
      for (const row of backup.tables[table]) {
        if (table === 'audit') await dbAdd(table, row);
        else await dbPut(table, row);
      }
    }
    await render(); toast('Backup berhasil dipulihkan.');
  } catch (error) { toast(error.message || 'File backup tidak valid.', 'error'); }
}

async function closeManifest(id) {
    if (!(await authorize(['owner', 'store_admin', 'supervisor'], 'menutup manifest'))) return;
  const manifest = await dbGet('manifests', id);
  if (!manifest || manifest.status === 'CLOSED') return;
  const parcels = (await dbGetAll('parcels')).filter(parcel => parcel.manifestId === id);
  const unresolved = parcels.filter(parcel => ['EXPECTED', 'SCANNED', 'REJECTED'].includes(parcel.status));
  const body = `<form id="close-manifest-form" class="stack"><div class="callout ${unresolved.length ? 'red' : ''}"><span>!</span><span>${unresolved.length ? `${unresolved.length} paket belum diterima kurir. Penutupan memerlukan alasan pengecualian.` : 'Semua paket manifest sudah memiliki hasil serah-terima.'}</span></div>${unresolved.length ? '<div class="field"><label for="close-reason">Alasan / persetujuan supervisor</label><textarea class="textarea" id="close-reason" required placeholder="Catat alasan penutupan dan penanggung jawab"></textarea></div>' : ''}<label class="check-line"><input type="checkbox" id="close-confirm" required> Saya memahami penutupan tidak menghapus catatan paket dan sesi.</label></form>`;
  modal('Tutup manifest', 'Manifest tertutup tidak dapat menerima scan baru.', body, `<button class="button button-light" data-action="close-modal">Batal</button><button class="button button-dark" data-action="confirm-close-manifest" data-id="${escapeHtml(id)}">Tutup manifest</button>`);
}

async function confirmCloseManifest(id) {
    if (!(await authorize(['owner', 'store_admin', 'supervisor'], 'menutup manifest'))) return;
  const form = $('#close-manifest-form');
  if (!form.reportValidity()) return;
  const manifest = await dbGet('manifests', id);
  if (!manifest || manifest.status === 'CLOSED') return;
  const reason = $('#close-reason')?.value.trim() || 'Semua paket telah tercatat dalam sesi serah-terima.';
  manifest.status = 'CLOSED'; manifest.closedAt = now(); manifest.closeReason = reason;
  await dbPut('manifests', manifest);
  await audit('CLOSE_MANIFEST', 'manifest', id, reason);
  closeModal(); selectedManifestId = id; await render(); toast('Manifest ditutup dan alasan tercatat.');
}

async function clearAllData() {
  if (!confirm('Hapus permanen semua paket, manifest, sesi, insiden, audit, dan pengaturan dari browser ini?')) return;
  for (const table of TABLES) await dbClear(table);
  selectedManifestId = ''; await render(); toast('Semua data lokal telah dihapus.');
}

function downloadSampleCsv() {
  csvDownload('contoh-impor-orderguard.csv', [['Nomor Pesanan', 'Nomor Resi', 'Toko', 'Kurir', 'Tanggal Rencana', 'Jumlah Paket', 'Catatan'], ['ORD-001', 'RESI-001', 'Toko Contoh', 'Kurir A', today(), '1', 'Paket contoh'], ['ORD-002', 'RESI-002', 'Toko Contoh', 'Kurir A', today(), '1', '']]);
}

function handleClick(event) {
  const target = event.target.closest('[data-action], [data-view], [data-open-manifest]');
  if (!target) return;
  if (target.dataset.openManifest) { selectedManifestId = target.dataset.openManifest; setView('manifests'); return; }
  if (target.dataset.view) { event.preventDefault(); selectedManifestId = ''; setView(target.dataset.view); return; }
  const { action, id } = target.dataset;
  if (action === 'close-modal') closeModal();
  else if (action === 'go-import') setView('imports');
  else if (action === 'new-manifest') openNewManifest();
  else if (action === 'save-manifest') saveManifest();
  else if (action === 'clear-import') { importDraft = null; importRows = []; importHeaders = []; render(); }
  else if (action === 'commit-import') commitImport();
  else if (action === 'sample-csv') downloadSampleCsv();
  else if (action === 'scan-manifest') { selectedManifestId = id; setView('scanner'); }
  else if (action === 'handover-manifest') { selectedManifestId = id; setView('handover'); }
  else if (action === 'back-manifests') { selectedManifestId = ''; render(); }
  else if (action === 'detail-tab') switchManifestTab(target.dataset.tab);
  else if (action === 'export-manifest') exportParcels(id);
  else if (action === 'close-manifest') closeManifest(id);
  else if (action === 'confirm-close-manifest') confirmCloseManifest(id);
  else if (action === 'new-incident') openIncidentForm();
  else if (action === 'save-incident') saveIncident();
  else if (action === 'resolve-incident') resolveIncident(id);
  else if (action === 'save-resolution') saveResolution(id);
  else if (action === 'export-report') exportParcels();
  else if (action === 'backup-data') backupData();
  else if (action === 'restore-data') $('#restore-file').click();
  else if (action === 'clear-data') clearAllData();
  else if (action === 'sync-now') syncPending();
  else if (action === 'sign-up') authenticate(true);
  else if (action === 'sign-out') signOut();
  else if (action === 'refresh-memberships') backendState().then(render).catch(error => toast(error.message, 'error'));
  else if (action === 'resolve-conflict') resolveSyncConflict(id, target.dataset.choice);
  else if (action === 'open-camera') openCameraScanner();
  else if (action === 'view-session-evidence') viewSessionEvidence(id);
}

async function switchManifestTab(tab) {
  $$('.tab-button').forEach(button => button.classList.toggle('active', button.dataset.tab === tab));
  const content = $('#manifest-tab-content');
  const [parcels, sessions] = await Promise.all([dbGetAll('parcels'), dbGetAll('sessions')]);
  if (tab === 'sessions') {
    const items = sessions.filter(session => session.manifestId === selectedManifestId).sort((a, b) => b.confirmedAt.localeCompare(a.confirmedAt));
    content.innerHTML = `<table><thead><tr><th>ID sesi</th><th>Dikonfirmasi</th><th>Penyerah / penerima</th><th>Hasil</th><th>Catatan</th></tr></thead><tbody>${items.length ? items.map(session => `<tr><td><span class="table-primary">${escapeHtml(session.code)}</span></td><td>${fmtTime(session.confirmedAt)}</td><td>${escapeHtml(session.handoverBy)} → ${escapeHtml(session.receiver)}</td><td>${session.items.filter(item => item.result === 'ACCEPTED').length} diterima · ${session.items.filter(item => item.result === 'REJECTED').length} ditolak</td><td>${escapeHtml(session.note || '—')}</td></tr>`).join('') : '<tr><td colspan="5" class="empty-row">Belum ada sesi.</td></tr>'}</tbody></table>`;
  } else {
    const items = parcels.filter(parcel => parcel.manifestId === selectedManifestId);
    content.innerHTML = `<table><thead><tr><th>Nomor resi / pesanan</th><th>Toko</th><th>Status paket</th><th>Waktu scan</th></tr></thead><tbody>${items.map(parcel => `<tr><td><span class="table-primary">${escapeHtml(parcel.awb)}</span><div class="table-secondary">Pesanan ${escapeHtml(parcel.orderNo)}</div></td><td>${escapeHtml(parcel.store)}</td><td>${statusPill(parcel.status)}</td><td>${fmtTime(parcel.scannedAt)}</td></tr>`).join('')}</tbody></table>`;
  }
}

async function handleSubmit(event) {
  event.preventDefault();
  if (event.target.id === 'backend-config-form') await saveBackendConfig();
  else if (event.target.id === 'auth-form') await authenticate(false);
  else if (event.target.id === 'organization-form') await createOrganization();
  else if (event.target.id === 'scan-form') {
    const input = $('#scan-input');
    const result = await scanPackage(input.value);
    const output = $('#scan-result');
    output.textContent = result.message;
    output.className = `scan-result ${result.result === 'MATCH' ? '' : result.result === 'INVALID_PACKAGE' ? 'error' : 'warn'}`;
    input.value = ''; input.focus();
    await render();
    $('#scan-result').textContent = result.message;
    $('#scan-result').className = `scan-result ${result.result === 'MATCH' ? '' : result.result === 'INVALID_PACKAGE' ? 'error' : 'warn'}`;
    $('#scan-input')?.focus();
  } else if (event.target.id === 'handover-form') confirmHandover();
  else if (event.target.id === 'settings-form') {
    await dbPut('settings', { key: 'workspace', value: $('#settings-workspace').value.trim() });
    await dbPut('settings', { key: 'operator', value: $('#settings-operator').value.trim() });
    $('#workspace-name').textContent = $('#settings-workspace').value.trim();
    $('#operator-label').textContent = $('#settings-operator').value.trim();
    await audit('UPDATE_SETTINGS', 'settings', 'profile', 'Profil perangkat diperbarui');
    await render(); toast('Pengaturan tersimpan di perangkat.');
  }
}

async function handleChange(event) {
  const target = event.target;
  if (target.id === 'organization-select') await chooseOrganization(target.value);
  else if (target.id === 'handover-evidence' && target.files?.[0]) {
    try { handoverEvidence = await compressEvidence(target.files[0]); $('#handover-evidence-state').textContent = 'Foto dikompresi dan akan ikut dalam sesi ini.'; }
    catch (error) { handoverEvidence = ''; toast(error.message, 'error'); }
  }
  else if (target.id === 'csv-file' && target.files?.[0]) { await handleFile(target.files[0]); target.value = ''; }
  else if (target.matches('[data-map-field]') && importDraft) { importDraft.mapping[target.dataset.mapField] = target.value; await render(); }
  else if (target.id === 'scanner-manifest') { selectedManifestId = target.value; await render(); $('#scan-input')?.focus(); }
  else if (target.id === 'handover-manifest') { selectedManifestId = target.value; await render(); }
  else if (target.id === 'select-all-items') $$('.handover-check').forEach(check => { check.checked = target.checked; });
  else if (target.matches('.handover-result')) {
    const checkbox = $(`.handover-check[value="${CSS.escape(target.dataset.parcel)}"]`);
    if (target.value === 'DEFERRED') checkbox.checked = false;
    else checkbox.checked = true;
  }
  else if (target.id === 'restore-file' && target.files?.[0]) { await restoreData(target.files[0]); target.value = ''; }
}

function handleInput(event) {
  if (event.target.id !== 'manifest-filter') return;
  const query = normalize(event.target.value);
  $$('.manifest-list-item').forEach(row => { row.hidden = !normalize(row.textContent).includes(query); });
}

async function boot() {
  try {
    db = await openDatabase();
    const currentWorkspace = await setting('workspace', 'Gudang Utama');
    const operator = await setting('operator', 'Operator lokal');
    $('#workspace-name').textContent = currentWorkspace;
    $('#operator-label').textContent = operator;
    $('#today-label').textContent = new Intl.DateTimeFormat('id-ID', { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date());
    const hashView = location.hash.slice(1);
    currentView = ['dashboard', 'imports', 'manifests', 'scanner', 'handover', 'incidents', 'reports', 'settings'].includes(hashView) ? hashView : 'dashboard';
    await render();
    await updateConnectionStatus();
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
    maybeSyncPending();
  } catch (error) {
    $('#view-root').innerHTML = `<div class="callout red">Penyimpanan lokal tidak tersedia. Buka aplikasi melalui localhost/HTTPS dan pastikan IndexedDB tidak diblokir. Detail: ${escapeHtml(error.message)}</div>`;
  }
}

document.addEventListener('click', handleClick);
document.addEventListener('submit', handleSubmit);
document.addEventListener('change', handleChange);
document.addEventListener('input', handleInput);
document.addEventListener('keydown', event => { if (event.key === 'Escape') closeModal(); });
$('#quick-import').addEventListener('click', () => setView('imports'));
$('#mobile-menu').addEventListener('click', () => $('#sidebar').classList.toggle('open'));
$('#edit-operator').addEventListener('click', () => setView('settings'));
window.addEventListener('hashchange', () => {
  const next = location.hash.slice(1);
  if (next && next !== currentView) { currentView = next; render(); }
});
window.addEventListener('online', () => { $('#connection-label').textContent = 'Koneksi pulih · menyinkronkan'; maybeSyncPending(); });
window.addEventListener('offline', () => { $('#connection-label').textContent = 'Mode offline siap'; });
$('#connection-label').textContent = navigator.onLine ? 'Internet tersedia · tetap lokal' : 'Mode offline siap';
boot();