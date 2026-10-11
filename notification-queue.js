const DEFAULT_MAX_ACTIVE_WINDOWS = 7;

function createNotificationQueue(options = {}) {
  const maxActive = Number.isInteger(options.maxActive) && options.maxActive > 0
    ? options.maxActive
    : DEFAULT_MAX_ACTIVE_WINDOWS;
  const onActivate = typeof options.onActivate === 'function' ? options.onActivate : () => {};
  const onChange = typeof options.onChange === 'function' ? options.onChange : () => {};
  const entries = [];
  const waiting = [];
  let filling = false;

  function fillSlots() {
    if (filling) return;
    filling = true;
    try {
      while (entries.length < maxActive && waiting.length > 0) {
        const entry = waiting.shift();
        entries.push(entry);
        try {
          onActivate(entry);
        } catch (error) {
          const index = entries.indexOf(entry);
          if (index !== -1) {
            entries.splice(index, 1);
            waiting.unshift(entry);
          }
          throw error;
        }
      }
    } finally {
      filling = false;
    }
  }

  function add(entry) {
    waiting.push(entry);
    try {
      fillSlots();
    } finally {
      onChange();
    }
    return entry;
  }

  function removeById(id) {
    for (const list of [entries, waiting]) {
      const index = list.findIndex((entry) => entry.id === id);
      if (index !== -1) {
        const removed = list.splice(index, 1)[0];
        try {
          fillSlots();
        } finally {
          onChange();
        }
        return removed;
      }
    }
    return null;
  }

  function removeWhere(predicate) {
    let removed = 0;
    for (const list of [entries, waiting]) {
      for (let index = list.length - 1; index >= 0; index -= 1) {
        if (predicate(list[index])) {
          list.splice(index, 1);
          removed++;
        }
      }
    }
    if (removed > 0) {
      try {
        fillSlots();
      } finally {
        onChange();
      }
    }
    return removed;
  }

  function clear() {
    // Empty both lists before window close callbacks can refill the foreground.
    const removed = [...entries.splice(0), ...waiting.splice(0)];
    if (removed.length > 0) onChange();
    return removed;
  }

  return {
    add,
    entries() {
      return entries;
    },
    ids() {
      return entries.map((entry) => entry.id);
    },
    waitingEntries() {
      return waiting;
    },
    waitingIds() {
      return waiting.map((entry) => entry.id);
    },
    waitingSize() {
      return waiting.length;
    },
    totalSize() {
      return entries.length + waiting.length;
    },
    clear,
    removeById,
    removeWhere,
    size() {
      return entries.length;
    },
  };
}

module.exports = {
  DEFAULT_MAX_ACTIVE_WINDOWS,
  createNotificationQueue,
};
