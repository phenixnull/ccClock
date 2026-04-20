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
  assert.deepEqual(queue.ids(), ['n1', 'n2', 'n3', 'n4', 'n5']);
});

test('does not evict any notification when queue reaches exactly the max', () => {
  const queue = createNotificationQueue({ maxActive: DEFAULT_MAX_ACTIVE_WINDOWS });

  for (let i = 1; i <= DEFAULT_MAX_ACTIVE_WINDOWS; i += 1) {
    queue.add(makeEntry(`n${i}`));
  }

  assert.equal(queue.size(), DEFAULT_MAX_ACTIVE_WINDOWS);
  assert.deepEqual(queue.ids(), ['n1', 'n2', 'n3', 'n4', 'n5', 'n6']);
});

test('evicts the oldest notification when a new one exceeds the max', () => {
  const evicted = [];
  const queue = createNotificationQueue({
    maxActive: DEFAULT_MAX_ACTIVE_WINDOWS,
    onEvict(entry) {
      evicted.push(entry.id);
    },
  });

  for (let i = 1; i <= DEFAULT_MAX_ACTIVE_WINDOWS + 1; i += 1) {
    queue.add(makeEntry(`n${i}`));
  }

  assert.equal(queue.size(), DEFAULT_MAX_ACTIVE_WINDOWS);
  assert.deepEqual(queue.ids(), ['n2', 'n3', 'n4', 'n5', 'n6', 'n7']);
  assert.deepEqual(evicted, ['n1']);
});
