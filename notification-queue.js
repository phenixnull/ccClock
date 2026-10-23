function createNotificationQueue(options = {}) {
  const { store } = options;
  if (!store) throw new TypeError('A notification store is required');
  const canActivate = options.canActivate || (() => true);
  const canKeep = options.canKeep || (() => true);
  const onPrepare = options.onPrepare || (() => {});
  const onActivate = options.onActivate || (() => {});
  const onDeactivate = options.onDeactivate || (() => {});
  const entries = [];
  let head = null;
  let filling = false;

  function lastActiveSequence() {
    return entries.at(-1)?.sequence || 0;
  }

  function release(entry) {
    onDeactivate(entry);
  }

  function refresh() {
    if (filling) return;
    filling = true;
    try {
      // Active cards form a prefix of the disk queue. Returning a suffix to disk
      // preserves FIFO without copying or indexing the backlog.
      let keep = entries.length;
      while (keep > 0 && !canKeep(entries.slice(0, keep))) keep--;
      if (keep < entries.length) {
        if (head) { release(head); head = null; }
        const overflow = entries.splice(keep);
        overflow.forEach(entry => {
          store.update(entry);
          release(entry);
        });
      }

      while (true) {
        if (!head) head = store.peekAfter(lastActiveSequence());
        if (!head) break;
        onPrepare(head);
        if (!canActivate(head, entries)) break;
        const entry = head;
        head = null;
        entries.push(entry);
        try {
          onActivate(entry);
        } catch (error) {
          entries.pop();
          head = entry;
          throw error;
        }
      }
    } finally {
      filling = false;
    }
  }

  function add(entry) {
    const wasEmpty = store.size() === entries.length;
    store.append(entry); // Commit before allowing display or reporting success.
    if (wasEmpty && !head) head = entry;
    refresh();
    return entry;
  }

  function removeById(id) {
    const index = entries.findIndex(entry => entry.id === id);
    const resident = index !== -1 ? entries[index] : head?.id === id ? head : null;
    const removed = resident || store.get(id);
    if (!removed || !store.remove(id)) return null;
    if (index !== -1) entries.splice(index, 1);
    if (head?.id === id) head = null;
    release(removed);
    refresh();
    return removed;
  }

  function clear() {
    store.clear();
    // Only resident windows need cleanup. Never load the disk backlog.
    const removed = [...entries.splice(0), ...(head ? [head] : [])];
    head = null;
    removed.forEach(release);
    return removed;
  }

  return {
    add,
    refresh,
    clear,
    removeById,
    entries() { return entries; },
    ids() { return entries.map(entry => entry.id); },
    residentEntries() { return [...entries, ...(head ? [head] : [])]; },
    candidate() { return head; },
    isActive(id) { return entries.some(entry => entry.id === id); },
    listWaiting({ cursor = 0, limit = 100 } = {}) {
      if (!Number.isSafeInteger(cursor) || cursor < 0) throw new TypeError('Invalid notification cursor');
      return store.listAfter(Math.max(cursor, lastActiveSequence()), limit);
    },
    waitingSize() { return store.size() - entries.length; },
    totalSize() { return store.size(); },
    size() { return entries.length; },
    updateState(entry, changes) {
      const updated = { ...entry, ...changes };
      store.update(updated);
      Object.assign(entry, changes);
    },
  };
}

module.exports = {
  createNotificationQueue,
};
