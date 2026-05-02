const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createRecurringSchedule,
  createSingleSchedule,
  evaluateSchedules,
  normalizeScheduleStore,
} = require('./schedule-engine');

test('single schedules start in the pending queue', () => {
  const schedule = createSingleSchedule(
    {
      title: 'One shot',
      message: 'Stand up',
      triggerAt: '2026-05-02T09:00:00',
    },
    {
      id: 'single-1',
      now: new Date('2026-05-02T08:00:00'),
    }
  );

  const store = normalizeScheduleStore([]);

  store.pending.push(schedule);

  assert.deepEqual(store.pending.map((entry) => entry.id), ['single-1']);
  assert.deepEqual(store.completed, []);
});

test('single schedules fire once and move from pending to completed', () => {
  const schedule = createSingleSchedule(
    {
      title: 'One shot',
      message: 'Stand up',
      triggerAt: '2026-05-02T09:00:00',
    },
    {
      id: 'single-1',
      now: new Date('2026-05-02T08:00:00'),
    }
  );

  const result = evaluateSchedules({ pending: [schedule], completed: [] }, new Date('2026-05-02T09:00:00'));

  assert.deepEqual(result.due.map((entry) => entry.id), ['single-1']);
  assert.deepEqual(result.store.pending, []);
  assert.deepEqual(result.store.completed.map((entry) => entry.id), ['single-1']);
  assert.equal(result.store.completed[0].completedAt, '2026-05-02T09:00:00');
});

test('recurring schedules start at the next occurrence inside the date range', () => {
  const schedule = createRecurringSchedule(
    {
      title: 'Hydrate',
      message: 'Drink water',
      startAt: '2026-05-02T00:00:00',
      endAt: '2026-05-02T23:59:00',
      intervalMinutes: 30,
    },
    {
      id: 'repeat-1',
      now: new Date('2026-05-02T16:26:00'),
    }
  );

  assert.equal(schedule.type, 'recurring');
  assert.equal(schedule.nextTriggerAt, '2026-05-02T16:30:00');
});

test('recurring schedules default to now through the end of the same day', () => {
  const schedule = createRecurringSchedule(
    {
      title: 'Default range',
      message: 'Every five minutes today',
      intervalMinutes: 5,
    },
    {
      id: 'repeat-default',
      now: new Date('2026-05-02T16:26:12'),
    }
  );

  assert.equal(schedule.startAt, '2026-05-02T16:26:12');
  assert.equal(schedule.endAt, '2026-05-02T23:59:59');
  assert.equal(schedule.nextTriggerAt, '2026-05-02T16:26:12');
});

test('recurring schedules default endAt to 23:59:59 on the startAt date', () => {
  const schedule = createRecurringSchedule(
    {
      title: 'Default end',
      message: 'Every thirty minutes today',
      startAt: '2026-05-02T08:15:00',
      intervalMinutes: 30,
    },
    {
      id: 'repeat-default-end',
      now: new Date('2026-05-02T07:00:00'),
    }
  );

  assert.equal(schedule.startAt, '2026-05-02T08:15:00');
  assert.equal(schedule.endAt, '2026-05-02T23:59:59');
  assert.equal(schedule.nextTriggerAt, '2026-05-02T08:15:00');
});

test('recurring schedules fire once per due check and advance to the next occurrence', () => {
  const schedule = createRecurringSchedule(
    {
      title: 'Hydrate',
      message: 'Drink water',
      startAt: '2026-05-02T00:00:00',
      endAt: '2026-05-02T23:59:00',
      intervalMinutes: 30,
    },
    {
      id: 'repeat-1',
      now: new Date('2026-05-02T16:26:00'),
    }
  );

  const result = evaluateSchedules({ pending: [schedule], completed: [] }, new Date('2026-05-02T16:30:00'));

  assert.deepEqual(result.due.map((entry) => entry.id), ['repeat-1']);
  assert.equal(result.store.pending.length, 1);
  assert.equal(result.store.pending[0].nextTriggerAt, '2026-05-02T17:00:00');
  assert.deepEqual(result.store.completed, []);
});

test('recurring schedules move to completed only after the final occurrence in the range fires', () => {
  const schedule = createRecurringSchedule(
    {
      title: 'Last call',
      message: 'Final reminder',
      startAt: '2026-05-02T23:00:00',
      endAt: '2026-05-02T23:59:00',
      intervalMinutes: 30,
    },
    {
      id: 'repeat-2',
      now: new Date('2026-05-02T22:00:00'),
    }
  );

  const first = evaluateSchedules({ pending: [schedule], completed: [] }, new Date('2026-05-02T23:00:00'));
  const second = evaluateSchedules(first.store, new Date('2026-05-02T23:30:00'));

  assert.deepEqual(first.due.map((entry) => entry.id), ['repeat-2']);
  assert.deepEqual(first.store.pending.map((entry) => entry.id), ['repeat-2']);
  assert.deepEqual(first.store.completed, []);
  assert.deepEqual(second.due.map((entry) => entry.id), ['repeat-2']);
  assert.deepEqual(second.store.pending, []);
  assert.deepEqual(second.store.completed.map((entry) => entry.id), ['repeat-2']);
  assert.equal(second.store.completed[0].completedAt, '2026-05-02T23:30:00');
});

test('overdue recurring schedules fire remaining occurrences before completing', () => {
  const schedule = createRecurringSchedule(
    {
      title: 'Catch up',
      message: 'Do not complete silently',
      startAt: '2026-05-02T23:00:00',
      endAt: '2026-05-02T23:59:00',
      intervalMinutes: 30,
    },
    {
      id: 'repeat-3',
      now: new Date('2026-05-02T22:00:00'),
    }
  );

  const result = evaluateSchedules({ pending: [schedule], completed: [] }, new Date('2026-05-03T00:01:00'));

  assert.deepEqual(result.due.map((entry) => entry.triggerAt), [
    '2026-05-02T23:00:00',
    '2026-05-02T23:30:00',
  ]);
  assert.deepEqual(result.store.pending, []);
  assert.deepEqual(result.store.completed.map((entry) => entry.id), ['repeat-3']);
});

test('legacy schedule arrays normalize into pending and completed queues', () => {
  const single = createSingleSchedule(
    {
      title: 'Legacy',
      message: 'Old storage shape',
      triggerAt: '2026-05-02T09:00:00',
    },
    {
      id: 'legacy-1',
      now: new Date('2026-05-02T08:00:00'),
    }
  );

  const store = normalizeScheduleStore([single]);

  assert.deepEqual(store.pending.map((entry) => entry.id), ['legacy-1']);
  assert.deepEqual(store.completed, []);
});

test('recurring schedules reject ranges with no remaining occurrence', () => {
  assert.throws(
    () => createRecurringSchedule(
      {
        title: 'Expired',
        message: 'Too late',
        startAt: '2026-05-01T00:00:00',
        endAt: '2026-05-01T23:59:00',
        intervalMinutes: 30,
      },
      {
        now: new Date('2026-05-02T00:01:00'),
      }
    ),
    /No recurring reminder occurrence remains/
  );
});
