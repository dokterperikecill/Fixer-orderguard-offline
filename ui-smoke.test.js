const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');
const { IDBFactory } = require('fake-indexeddb');

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const value = predicate();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  return null;
}

test('application boots locally and navigates to import view', async () => {
  const dom = new JSDOM(fs.readFileSync('index.html', 'utf8'), {
    url: 'http://localhost/',
    runScripts: 'outside-only',
    pretendToBeVisual: true
  });
  const { window } = dom;
  Object.defineProperty(window, 'indexedDB', { value: new IDBFactory() });
  Object.defineProperty(window.navigator, 'serviceWorker', { value: { register: async () => ({}) } });
  window.eval(`${fs.readFileSync('app.js', 'utf8')}\nwindow.__databaseReady = new Promise(resolve => { const check = () => db ? resolve(db) : setTimeout(check, 0); check(); });`);

  try {
    const database = await window.__databaseReady;
    const dashboardHeading = await waitFor(() => window.document.querySelector('#view-root h1')?.textContent);
    assert.equal(dashboardHeading, 'Selamat bekerja, Operator lokal', window.document.querySelector('#view-root').textContent);

    window.document.querySelector('[data-view="imports"]').click();
    const importHeading = await waitFor(() => window.document.querySelector('#view-root h1')?.textContent === 'Impor paket' && 'Impor paket');
    assert.equal(importHeading, 'Impor paket', window.document.querySelector('#view-root').textContent);
    assert.ok(window.document.querySelector('#csv-file'));
    database.close();
  } finally {
    dom.window.close();
  }
});