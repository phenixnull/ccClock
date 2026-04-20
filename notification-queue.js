const DEFAULT_MAX_ACTIVE_WINDOWS = 6;

function createNotificationQueue(options = {}) {
  const maxActive = Number.isInteger(options.maxActive) && options.maxActive > 0
    ? options.maxActive
    : DEFAULT_MAX_ACTIVE_WINDOWS;
  const onEvict = typeof options.onEvict === 'function' ? options.onEvict : () => {};
  const entries = [];

  function add(entry) {
    while (entries.length >= maxActive) {
      const evicted = entries.shift();
      if (evicted) {
        onEvict(evicted);
      }
    }

    entries.push(entry);
    return entry;
  }

  function removeById(id) {
    const index = entries.findIndex((entry) => entry.id === id);
    if (index === -1) {
      return null;
    }

    return entries.splice(index, 1)[0];
  }

  function removeWhere(predicate) {
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      if (predicate(entries[index])) {
        entries.splice(index, 1);
      }
    }
  }

  return {
    add,
    entries() {
      return entries;
    },
    ids() {
      return entries.map((entry) => entry.id);
    },
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
