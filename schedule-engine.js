const crypto = require('crypto');

const TYPE_SINGLE = 'single';
const TYPE_RECURRING = 'recurring';

function makeId() {
  return crypto.randomUUID().slice(0, 8);
}

function pad(value) {
  return String(value).padStart(2, '0');
}

function toLocalIso(date) {
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
  ].join('-') + 'T' + [
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join(':');
}

function parseDateTime(value, fieldName) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new Error(`${fieldName} must be a valid datetime`);
  }
  return date;
}

function parseIntervalMinutes(value) {
  const intervalMinutes = Number(value);
  if (!Number.isInteger(intervalMinutes) || intervalMinutes <= 0) {
    throw new Error('intervalMinutes must be a positive integer');
  }
  return intervalMinutes;
}

function endOfDay(date) {
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
    23,
    59,
    59,
    0
  );
}

function createSingleSchedule(data, options = {}) {
  const triggerAt = parseDateTime(data.triggerAt, 'triggerAt');
  const now = parseDateTime(options.now || new Date(), 'now');

  return {
    id: options.id || data.id || makeId(),
    type: TYPE_SINGLE,
    title: data.title || 'Scheduled Reminder',
    message: data.message || '',
    triggerAt: toLocalIso(triggerAt),
    createdAt: data.createdAt || toLocalIso(now),
  };
}

function cloneSchedule(schedule) {
  return { ...schedule };
}

function normalizeScheduleStore(value) {
  if (Array.isArray(value)) {
    return {
      pending: value.map(cloneSchedule),
      completed: [],
    };
  }

  if (!value || typeof value !== 'object') {
    return {
      pending: [],
      completed: [],
    };
  }

  return {
    pending: Array.isArray(value.pending) ? value.pending.map(cloneSchedule) : [],
    completed: Array.isArray(value.completed) ? value.completed.map(cloneSchedule) : [],
  };
}

function completeSchedule(schedule, now, reason) {
  return {
    ...schedule,
    completedAt: toLocalIso(now),
    completionReason: reason,
  };
}

function getFirstOccurrenceAtOrAfter(startAt, intervalMinutes, now) {
  const intervalMs = intervalMinutes * 60 * 1000;

  if (now.getTime() <= startAt.getTime()) {
    return new Date(startAt.getTime());
  }

  const intervalsElapsed = Math.ceil((now.getTime() - startAt.getTime()) / intervalMs);
  return new Date(startAt.getTime() + intervalsElapsed * intervalMs);
}

function getFirstOccurrenceAfter(startAt, intervalMinutes, now) {
  const intervalMs = intervalMinutes * 60 * 1000;
  const intervalsElapsed = Math.floor((now.getTime() - startAt.getTime()) / intervalMs) + 1;
  return new Date(startAt.getTime() + Math.max(1, intervalsElapsed) * intervalMs);
}

function addInterval(date, intervalMinutes) {
  return new Date(date.getTime() + intervalMinutes * 60 * 1000);
}

function createRecurringSchedule(data, options = {}) {
  const now = parseDateTime(options.now || new Date(), 'now');
  const startAt = data.startAt === undefined || data.startAt === null || data.startAt === ''
    ? new Date(now.getTime())
    : parseDateTime(data.startAt, 'startAt');
  const endAt = data.endAt === undefined || data.endAt === null || data.endAt === ''
    ? endOfDay(startAt)
    : parseDateTime(data.endAt, 'endAt');
  const intervalMinutes = parseIntervalMinutes(data.intervalMinutes);

  if (endAt.getTime() < startAt.getTime()) {
    throw new Error('endAt must be greater than or equal to startAt');
  }

  const nextTriggerAt = getFirstOccurrenceAtOrAfter(startAt, intervalMinutes, now);
  if (nextTriggerAt.getTime() > endAt.getTime()) {
    throw new Error('No recurring reminder occurrence remains inside the date range');
  }

  return {
    id: options.id || data.id || makeId(),
    type: TYPE_RECURRING,
    title: data.title || 'Recurring Reminder',
    message: data.message || '',
    startAt: toLocalIso(startAt),
    endAt: toLocalIso(endAt),
    intervalMinutes,
    nextTriggerAt: toLocalIso(nextTriggerAt),
    createdAt: data.createdAt || toLocalIso(now),
  };
}

function isRecurringSchedule(schedule) {
  return schedule.type === TYPE_RECURRING || (
    schedule.intervalMinutes !== undefined &&
    schedule.startAt !== undefined &&
    schedule.endAt !== undefined
  );
}

function evaluateSingleSchedule(schedule, now, result) {
  const triggerAt = parseDateTime(schedule.triggerAt, 'triggerAt');
  if (triggerAt.getTime() <= now.getTime()) {
    result.due.push(schedule);
    result.store.completed.push(completeSchedule(schedule, now, 'triggered'));
    result.changed = true;
    return;
  }

  result.store.pending.push(schedule);
}

function evaluateRecurringSchedule(schedule, now, result) {
  const endAt = parseDateTime(schedule.endAt, 'endAt');
  const intervalMinutes = parseIntervalMinutes(schedule.intervalMinutes);
  const nextTriggerAt = parseDateTime(schedule.nextTriggerAt || schedule.startAt, 'nextTriggerAt');

  if (nextTriggerAt.getTime() > endAt.getTime()) {
    result.store.completed.push(completeSchedule(schedule, now, 'expired'));
    result.changed = true;
    return;
  }

  if (nextTriggerAt.getTime() > now.getTime()) {
    result.store.pending.push(schedule);
    return;
  }

  const dueUntil = new Date(Math.min(now.getTime(), endAt.getTime()));
  let next = nextTriggerAt;
  while (next.getTime() <= dueUntil.getTime()) {
    result.due.push({
      ...schedule,
      triggerAt: toLocalIso(next),
    });
    next = addInterval(next, intervalMinutes);
  }

  if (next.getTime() <= endAt.getTime()) {
    result.store.pending.push({
      ...schedule,
      type: TYPE_RECURRING,
      nextTriggerAt: toLocalIso(next),
    });
  } else {
    result.store.completed.push(completeSchedule(schedule, now, 'triggered'));
  }
  result.changed = true;
}

function evaluateSchedules(input, nowValue = new Date()) {
  const now = parseDateTime(nowValue, 'now');
  const store = normalizeScheduleStore(input);
  const result = {
    due: [],
    store: {
      pending: [],
      completed: store.completed,
    },
    changed: false,
  };

  for (const schedule of store.pending) {
    try {
      if (isRecurringSchedule(schedule)) {
        evaluateRecurringSchedule(schedule, now, result);
      } else {
        evaluateSingleSchedule(schedule, now, result);
      }
    } catch {
      result.changed = true;
    }
  }

  result.schedules = result.store.pending;

  return result;
}

module.exports = {
  TYPE_RECURRING,
  TYPE_SINGLE,
  createRecurringSchedule,
  createSingleSchedule,
  evaluateSchedules,
  normalizeScheduleStore,
  toLocalIso,
};
