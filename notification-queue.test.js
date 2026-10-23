const test = require('node:test');
const assert = require('node:assert/strict');

const { createNotificationQueue } = require('./notification-queue');
const { createNotificationStore } = require('./notification-store');
const { getNotificationLayout } = require('./notification-layout');

function makeEntry(id, height = 160) {
  return { id, height };
}

function screenQueue(availableHeight, options = {}) {
  let workArea = { x: 0, y: 0, width: 1920, height: availableHeight + 40 };
  const store = createNotificationStore(':memory:');
  test.after(() => store.close());
  const queue = createNotificationQueue({
    store,
    canKeep: entries => getNotificationLayout(entries, workArea) !== null,
    canActivate: (entry, entries) => getNotificationLayout([...entries, entry], workArea) !== null,
    ...options,
  });
  return {
    queue,
    store,
    resize(height) {
      workArea = { ...workArea, height: height + 40 };
      queue.refresh();
    },
  };
}

function waitingIds(queue) {
  return queue.listWaiting().items.map(entry => entry.id);
}

test('admits exactly the cards that fit, including an exact boundary fit', () => {
  const { queue } = screenQueue(504);
  for (let i = 1; i <= 5; i++) queue.add(makeEntry(`n${i}`));
  assert.deepEqual(queue.ids(), ['n1', 'n2', 'n3']);
  assert.deepEqual(waitingIds(queue), ['n4', 'n5']);
  assert.equal(queue.totalSize(), 5);
});

test('one pixel less space leaves the next notification waiting', () => {
  const { queue } = screenQueue(503);
  for (let i = 1; i <= 3; i++) queue.add(makeEntry(`n${i}`));
  assert.deepEqual(queue.ids(), ['n1', 'n2']);
  assert.deepEqual(waitingIds(queue), ['n3']);
});

test('a large screen can show more than seven cards', () => {
  const { queue } = screenQueue(1536);
  for (let i = 1; i <= 11; i++) queue.add(makeEntry(`n${i}`));
  assert.deepEqual(queue.ids(), Array.from({ length: 9 }, (_, index) => `n${index + 1}`));
  assert.deepEqual(waitingIds(queue), ['n10', 'n11']);
});

test('a large FIFO head blocks later small cards without evicting the foreground', () => {
  const activated = [];
  const { queue } = screenQueue(504, { onActivate: entry => activated.push(entry.id) });
  queue.add(makeEntry('n1', 160));
  queue.add(makeEntry('n2', 400));
  queue.add(makeEntry('n3', 160));
  assert.deepEqual(queue.ids(), ['n1']);
  assert.deepEqual(waitingIds(queue), ['n2', 'n3']);
  assert.deepEqual(activated, ['n1']);
  queue.removeById('n1');
  assert.deepEqual(queue.ids(), ['n2']);
  assert.deepEqual(waitingIds(queue), ['n3']);
});

test('unmeasured notifications stay queued and only the FIFO head is prepared', () => {
  const prepared = [];
  const activated = [];
  const { queue } = screenQueue(504, {
    onPrepare(entry) {
      if (!entry.prepared) {
        entry.prepared = true;
        prepared.push(entry.id);
      }
    },
    onActivate(entry) { activated.push(entry.id); },
  });
  queue.add({ id: 'n1' });
  queue.add({ id: 'n2' });
  assert.deepEqual(queue.ids(), []);
  assert.deepEqual(waitingIds(queue), ['n1', 'n2']);
  assert.deepEqual(prepared, ['n1']);
  queue.candidate().height = 160;
  queue.refresh();
  assert.deepEqual(queue.ids(), ['n1']);
  assert.deepEqual(prepared, ['n1', 'n2']);
  assert.deepEqual(activated, ['n1']);
});

test('closing the oldest card preserves bottom-to-top order and refills FIFO', () => {
  const activated = [];
  const { queue } = screenQueue(504, { onActivate: entry => activated.push(entry.id) });
  for (let i = 1; i <= 6; i++) queue.add(makeEntry(`n${i}`));
  for (let i = 1; i <= 3; i++) {
    assert.equal(queue.removeById(`n${i}`).id, `n${i}`);
    assert.deepEqual(queue.ids(), Array.from({ length: 3 }, (_, index) => `n${index + i + 1}`));
    assert.equal(queue.waitingSize(), 3 - i);
  }
  assert.deepEqual(activated, Array.from({ length: 6 }, (_, index) => `n${index + 1}`));
});

test('closing a middle card preserves the remaining order and promotes the oldest waiting card', () => {
  const { queue } = screenQueue(504);
  for (let i = 1; i <= 6; i++) queue.add(makeEntry(`n${i}`));
  queue.removeById('n2');
  assert.deepEqual(queue.ids(), ['n1', 'n3', 'n4']);
  assert.deepEqual(waitingIds(queue), ['n5', 'n6']);
  queue.add(makeEntry('n7'));
  assert.deepEqual(waitingIds(queue), ['n5', 'n6', 'n7']);
});

test('removing a waiting entry or an unknown id does not replace active cards', () => {
  const { queue } = screenQueue(332);
  for (let i = 1; i <= 5; i++) queue.add(makeEntry(`n${i}`));
  queue.removeById('n4');
  assert.deepEqual(queue.ids(), ['n1', 'n2']);
  assert.deepEqual(waitingIds(queue), ['n3', 'n5']);
  assert.equal(queue.removeById('missing'), null);
  queue.removeById('n1');
  assert.deepEqual(queue.ids(), ['n2', 'n3']);
});

test('removing multiple closed windows fills every vacancy without dropping queued entries', () => {
  const { queue } = screenQueue(504);
  for (let i = 1; i <= 7; i++) queue.add(makeEntry(`n${i}`));
  queue.removeById('n1');
  queue.removeById('n3');
  assert.deepEqual(queue.ids(), ['n2', 'n4', 'n5']);
  assert.deepEqual(waitingIds(queue), ['n6', 'n7']);
});

test('clearing both lists prevents closing windows from activating any waiting cards', () => {
  const activated = [];
  const { queue } = screenQueue(332, { onActivate: entry => activated.push(entry.id) });
  for (let i = 1; i <= 5; i++) queue.add(makeEntry(`n${i}`));
  const removed = queue.clear();
  removed.forEach(entry => queue.removeById(entry.id));
  assert.equal(queue.totalSize(), 0);
  assert.deepEqual(activated, ['n1', 'n2']);
  assert.deepEqual(removed.map(entry => entry.id), ['n1', 'n2', 'n3']);
  queue.add(makeEntry('n6'));
  assert.deepEqual(queue.ids(), ['n6']);
});

test('an activation failure retains the notification at the front of the waiting queue', () => {
  let fail = true;
  const { queue, store } = screenQueue(160, {
    onActivate() { if (fail) throw new Error('Window unavailable'); },
  });
  assert.throws(() => queue.add(makeEntry('n1')), /Window unavailable/);
  assert.equal(queue.size(), 0);
  assert.deepEqual(waitingIds(queue), ['n1']);
  assert.deepEqual(store.listAfter().items.map(entry => entry.id), ['n1']);
  fail = false;
  queue.add(makeEntry('n2'));
  assert.deepEqual(queue.ids(), ['n1']);
  assert.deepEqual(waitingIds(queue), ['n2']);
});

test('reentrant additions remain in FIFO order and stay within the active limit', () => {
  const activated = [];
  const { queue } = screenQueue(332, {
    onActivate(entry) {
      activated.push(entry.id);
      if (entry.id === 'n1') {
        queue.add(makeEntry('n2'));
        queue.add(makeEntry('n3'));
      }
    },
  });
  queue.add(makeEntry('n1'));
  assert.deepEqual(queue.ids(), ['n1', 'n2']);
  assert.deepEqual(waitingIds(queue), ['n3']);
  assert.deepEqual(activated, ['n1', 'n2']);
});

test('shrinking the screen queues newer visible cards ahead of the older backlog', () => {
  const hidden = [];
  const { queue, resize } = screenQueue(504, { onDeactivate: entry => hidden.push(entry.id) });
  for (let i = 1; i <= 5; i++) queue.add(makeEntry(`n${i}`));
  const entries = [...queue.entries()];
  resize(160);
  assert.deepEqual(queue.ids(), ['n1']);
  assert.deepEqual(waitingIds(queue), ['n2', 'n3', 'n4', 'n5']);
  assert.deepEqual(hidden, ['n4', 'n2', 'n3']);
  resize(848);
  assert.deepEqual(queue.ids(), ['n1', 'n2', 'n3', 'n4', 'n5']);
  assert.equal(queue.entries()[1].id, entries[1].id);
  assert.equal(queue.entries()[2].id, entries[2].id);
});

test('expanding and collapsing settings reflows the stack without losing notifications', () => {
  const { queue } = screenQueue(504);
  for (let i = 1; i <= 4; i++) queue.add(makeEntry(`n${i}`));
  queue.entries()[0].height = 320;
  queue.refresh();
  assert.deepEqual(queue.ids(), ['n1', 'n2']);
  assert.deepEqual(waitingIds(queue), ['n3', 'n4']);
  queue.entries()[0].height = 160;
  queue.refresh();
  assert.deepEqual(queue.ids(), ['n1', 'n2', 'n3']);
  assert.deepEqual(waitingIds(queue), ['n4']);
});

test('when no card fits every notification stays queued until space returns', () => {
  const { queue, resize } = screenQueue(159);
  queue.add(makeEntry('n1'));
  queue.add(makeEntry('n2'));
  assert.equal(queue.size(), 0);
  assert.deepEqual(waitingIds(queue), ['n1', 'n2']);
  resize(332);
  assert.deepEqual(queue.ids(), ['n1', 'n2']);
});

test('a large disk backlog retains only visible entries and one queue head', () => {
  const { queue, store } = screenQueue(332);
  for (let index = 1; index <= 10000; index++) queue.add(makeEntry(`n${index}`));
  assert.equal(store.size(), 10000);
  assert.equal(queue.size(), 2);
  assert.equal(queue.waitingSize(), 9998);
  assert.deepEqual(queue.residentEntries().map(entry => entry.id), ['n1', 'n2', 'n3']);
  assert.equal(queue.listWaiting().items.length, 100);
  assert.equal(queue.listWaiting().nextCursor, 102);
  assert.throws(() => queue.listWaiting({ cursor: -1 }), /cursor/);
  queue.clear();
  assert.equal(store.size(), 0);
  assert.equal(queue.residentEntries().length, 0);
});

test('a failed disk insert is rejected before the notification can be activated', () => {
  const activated = [];
  const { queue, store } = screenQueue(332, { onActivate: entry => activated.push(entry.id) });
  store.close();
  assert.throws(() => queue.add(makeEntry('n1')), /closed|not open|finalized/i);
  assert.deepEqual(activated, []);
  assert.equal(queue.residentEntries().length, 0);
});

test('a new queue restores only the active prefix and head from the stored backlog', () => {
  const { queue, store } = screenQueue(332);
  for (let index = 1; index <= 10; index++) queue.add(makeEntry(`n${index}`));
  queue.updateState(queue.entries()[1], { currentSoundEnabled: false, settingsOpen: true });
  queue.removeById('n1');
  const restored = createNotificationQueue({
    store,
    canActivate: (_entry, active) => active.length < 2,
  });
  restored.refresh();
  assert.deepEqual(restored.ids(), ['n2', 'n3']);
  assert.equal(restored.residentEntries().length, 3);
  assert.equal(restored.entries()[0].currentSoundEnabled, false);
  assert.equal(restored.entries()[0].settingsOpen, true);
  assert.deepEqual(waitingIds(restored), ['n4', 'n5', 'n6', 'n7', 'n8', 'n9', 'n10']);
});
