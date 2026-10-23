const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createNotificationStore } = require('./notification-store');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccclock-store-test-'));
  const file = path.join(dir, 'notifications.sqlite');
  const legacy = path.join(dir, 'notifications.json');
  const handles = [];
  function open() {
    const store = createNotificationStore(file);
    handles.push(store);
    return store;
  }
  t.after(() => {
    handles.forEach(store => store.close());
    const resolved = path.resolve(dir);
    assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep));
    assert.ok(path.basename(resolved).startsWith('ccclock-store-test-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  return { dir, file, legacy, open };
}

function entry(id, message = 'Message') {
  return { id, title: `Notification ${id}`, message, silent: true, colorIndex: 0 };
}

test('committed notifications and per-card state survive closing and reopening the file', t => {
  const files = fixture(t);
  let store = files.open();
  store.append(entry('a', '\u4e2d\u6587\u901a\u77e5'));
  store.append(entry('b'));
  store.append(entry('c'));
  store.remove('b');
  store.update({ ...store.get('a'), currentSoundEnabled: false, settingsOpen: true });
  store.close();
  store = files.open();
  assert.equal(store.size(), 2);
  assert.deepEqual(store.listAfter().items.map(item => item.id), ['a', 'c']);
  assert.equal(store.get('a').message, '\u4e2d\u6587\u901a\u77e5');
  assert.equal(store.get('a').settingsOpen, true);
  assert.equal(store.get('a').currentSoundEnabled, false);
  const d = store.append(entry('d'));
  assert.ok(d.sequence > store.get('c').sequence);
});

test('migration streams Unicode, escaped quotes and records crossing file buffers in FIFO order', async t => {
  const files = fixture(t);
  const legacyEntries = [
    entry('a', '\\ " [ ] { }\n\u901a\u77e5'.repeat(7000)),
    entry('b'),
    { title: 'Missing id', message: 'Generate one' },
    { id: 'invalid', title: 10, message: 'Ignored' },
  ];
  const original = JSON.stringify(legacyEntries, null, 2);
  fs.writeFileSync(files.legacy, original);
  const store = files.open();
  assert.equal(await store.migrateLegacy(files.legacy), 3);
  assert.equal(store.size(), 3);
  assert.equal(store.peekAfter().id, 'a');
  assert.equal(store.get('a').message, legacyEntries[0].message);
  assert.equal(fs.readFileSync(files.legacy, 'utf8'), original);
  store.remove('a');
  store.close();
  const restored = files.open();
  assert.equal(await restored.migrateLegacy(files.legacy), 0);
  assert.equal(restored.get('a'), null, 'Acknowledged legacy notifications cannot return');
  assert.equal(restored.size(), 2);
});

test('a corrupt legacy file rolls back the entire migration and can be retried safely', async t => {
  const files = fixture(t);
  const store = files.open();
  fs.writeFileSync(files.legacy, `[${JSON.stringify(entry('a'))},${JSON.stringify(entry('b'))}`);
  await assert.rejects(store.migrateLegacy(files.legacy), /Truncated/);
  assert.equal(store.size(), 0);
  assert.equal(store.peekAfter(), null);
  fs.writeFileSync(files.legacy, JSON.stringify([entry('a'), entry('b')]));
  assert.equal(await store.migrateLegacy(files.legacy), 2);
});

test('migration marker prevents stale legacy data from returning even after clearing the queue', async t => {
  const files = fixture(t);
  fs.writeFileSync(files.legacy, JSON.stringify([entry('a')]));
  const store = files.open();
  await store.migrateLegacy(files.legacy);
  store.clear();
  store.close();
  const restored = files.open();
  assert.equal(await restored.migrateLegacy(files.legacy), 0);
  assert.equal(restored.size(), 0);
});

test('cursor pages do not skip records when preceding notifications are acknowledged', t => {
  const store = fixture(t).open();
  for (let index = 1; index <= 12; index++) store.append(entry(String(index)));
  const first = store.listAfter(0, 5);
  assert.deepEqual(first.items.map(item => item.id), ['1', '2', '3', '4', '5']);
  store.remove('1');
  store.remove('3');
  const second = store.listAfter(first.nextCursor, 5);
  assert.deepEqual(second.items.map(item => item.id), ['6', '7', '8', '9', '10']);
  const third = store.listAfter(second.nextCursor, 5);
  assert.deepEqual(third.items.map(item => item.id), ['11', '12']);
  assert.equal(third.nextCursor, null);
  assert.throws(() => store.listAfter(0, 10000), /limit/);
  assert.throws(() => store.listAfter(NaN), /cursor/);
});

test('large messages also bound the page byte size', t => {
  const store = fixture(t).open();
  for (let index = 1; index <= 4; index++) store.append(entry(String(index), 'x'.repeat(400000)));
  const page = store.listAfter();
  assert.equal(page.items.length, 2);
  assert.equal(page.nextCursor, page.items[1].sequence);
  assert.equal(store.size(), 4);
});

test('an abrupt process exit retains committed entries and acknowledgements', t => {
  const files = fixture(t);
  const child = spawnSync(process.execPath, ['-e', `
    const { createNotificationStore } = require(${JSON.stringify(path.join(__dirname, 'notification-store.js'))});
    const store = createNotificationStore(process.argv[1]);
    store.append({ id: 'a', title: 'A', message: 'First' });
    store.append({ id: 'b', title: 'B', message: 'Second' });
    store.remove('a');
    process.exit(0);
  `, files.file], { encoding: 'utf8', windowsHide: true });
  assert.equal(child.status, 0, child.stderr);
  const store = files.open();
  assert.equal(store.size(), 1);
  assert.equal(store.peekAfter().id, 'b');
});

test('runtime objects and promises are never serialized into the disk queue', t => {
  const store = fixture(t).open();
  const data = entry('a');
  data.win = { circular: data };
  data.measurement = Promise.resolve();
  data.ready = true;
  store.append(data);
  assert.equal(store.get('a').win, undefined);
  assert.equal(store.get('a').ready, undefined);
});
