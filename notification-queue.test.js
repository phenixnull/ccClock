const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_MAX_ACTIVE_WINDOWS,
  createNotificationQueue,
} = require('./notification-queue');

function makeEntry(id) {
  return { id };
}

test('keeps notifications when queue has not reached the max', () => {
  const queue = createNotificationQueue({ maxActive: DEFAULT_MAX_ACTIVE_WINDOWS });

  for (let i = 1; i <= DEFAULT_MAX_ACTIVE_WINDOWS - 1; i += 1) {
    queue.add(makeEntry(`n${i}`));
  }

  assert.equal(queue.size(), DEFAULT_MAX_ACTIVE_WINDOWS - 1);
  assert.deepEqual(queue.ids(), ['n1', 'n2', 'n3', 'n4', 'n5', 'n6']);
  assert.equal(queue.waitingSize(), 0);
});

test('does not evict any notification when queue reaches exactly the max', () => {
  const queue = createNotificationQueue({ maxActive: DEFAULT_MAX_ACTIVE_WINDOWS });

  for (let i = 1; i <= DEFAULT_MAX_ACTIVE_WINDOWS; i += 1) {
    queue.add(makeEntry(`n${i}`));
  }

  assert.equal(queue.size(), DEFAULT_MAX_ACTIVE_WINDOWS);
  assert.deepEqual(queue.ids(), ['n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7']);
  assert.equal(queue.waitingSize(), 0);
});

test('keeps the first seven active and queues later notifications without activating them', () => {
  const activated = [];
  const queue = createNotificationQueue({
    onActivate(entry) {
      activated.push(entry.id);
    },
  });

  for (let i = 1; i <= 10; i++) queue.add(makeEntry(`n${i}`));
  assert.equal(queue.size(), DEFAULT_MAX_ACTIVE_WINDOWS);
  assert.deepEqual(queue.ids(), ['n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7']);
  assert.deepEqual(queue.waitingIds(), ['n8', 'n9', 'n10']);
  assert.deepEqual(activated, queue.ids());
  assert.equal(queue.totalSize(), 10);
});

test('closing the oldest card shifts the rest down and fills from the waiting queue in order', () => {
  const activated = [];
  const queue = createNotificationQueue({ onActivate: entry => activated.push(entry.id) });
  for (let i = 1; i <= 10; i++) queue.add(makeEntry(`n${i}`));

  for (let i = 1; i <= 3; i++) {
    assert.equal(queue.removeById(`n${i}`).id, `n${i}`);
    assert.deepEqual(queue.ids(), Array.from({ length: 7 }, (_, index) => `n${index + i + 1}`));
    assert.equal(queue.waitingSize(), 3 - i);
  }
  assert.deepEqual(activated, Array.from({ length: 10 }, (_, index) => `n${index + 1}`));
});

test('closing a middle card preserves the remaining order and promotes the oldest waiting card', () => {
  const queue = createNotificationQueue({ maxActive: 3 });
  for (let i = 1; i <= 6; i++) queue.add(makeEntry(`n${i}`));
  queue.removeById('n2');
  assert.deepEqual(queue.ids(), ['n1', 'n3', 'n4']);
  assert.deepEqual(queue.waitingIds(), ['n5', 'n6']);
  queue.add(makeEntry('n7'));
  assert.deepEqual(queue.waitingIds(), ['n5', 'n6', 'n7']);
});

test('removing a waiting entry or an unknown id does not replace active cards', () => {
  const queue = createNotificationQueue({ maxActive: 2 });
  for (let i = 1; i <= 5; i++) queue.add(makeEntry(`n${i}`));
  queue.removeById('n4');
  assert.deepEqual(queue.ids(), ['n1', 'n2']);
  assert.deepEqual(queue.waitingIds(), ['n3', 'n5']);
  assert.equal(queue.removeById('missing'), null);
  queue.removeById('n1');
  assert.deepEqual(queue.ids(), ['n2', 'n3']);
});

test('removing multiple closed windows fills every vacancy without dropping queued entries', () => {
  const queue = createNotificationQueue({ maxActive: 3 });
  for (let i = 1; i <= 7; i++) queue.add(makeEntry(`n${i}`));
  assert.equal(queue.removeWhere(entry => entry.id === 'n1' || entry.id === 'n3'), 2);
  assert.deepEqual(queue.ids(), ['n2', 'n4', 'n5']);
  assert.deepEqual(queue.waitingIds(), ['n6', 'n7']);
});

test('clearing both lists prevents closing windows from activating any waiting cards', () => {
  const activated = [];
  const queue = createNotificationQueue({ maxActive: 2, onActivate: entry => activated.push(entry.id) });
  for (let i = 1; i <= 5; i++) queue.add(makeEntry(`n${i}`));
  const removed = queue.clear();
  removed.forEach(entry => queue.removeById(entry.id));
  assert.equal(queue.totalSize(), 0);
  assert.deepEqual(activated, ['n1', 'n2']);
  assert.deepEqual(removed.map(entry => entry.id), ['n1', 'n2', 'n3', 'n4', 'n5']);
  queue.add(makeEntry('n6'));
  assert.deepEqual(queue.ids(), ['n6']);
});

test('an activation failure retains the notification at the front of the waiting queue', () => {
  let fail = true;
  let savedIds;
  const queue = createNotificationQueue({
    maxActive: 1,
    onActivate() { if (fail) throw new Error('Window unavailable'); },
    onChange() { savedIds = [...queue.ids(), ...queue.waitingIds()]; },
  });
  assert.throws(() => queue.add(makeEntry('n1')), /Window unavailable/);
  assert.equal(queue.size(), 0);
  assert.deepEqual(queue.waitingIds(), ['n1']);
  assert.deepEqual(savedIds, ['n1']);
  fail = false;
  queue.add(makeEntry('n2'));
  assert.deepEqual(queue.ids(), ['n1']);
  assert.deepEqual(queue.waitingIds(), ['n2']);
});

test('reentrant additions remain in FIFO order and stay within the active limit', () => {
  const activated = [];
  const queue = createNotificationQueue({
    maxActive: 2,
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
  assert.deepEqual(queue.waitingIds(), ['n3']);
  assert.deepEqual(activated, ['n1', 'n2']);
});
