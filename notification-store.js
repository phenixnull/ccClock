const fs = require('node:fs');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const MAX_PAGE_SIZE = 100;
const PAGE_BYTES = 1024 * 1024;
const PERSISTED_FIELDS = [
  'id', 'title', 'message', 'silent', 'colorIndex',
  'height', 'currentSoundEnabled', 'settingsOpen',
];

function serialize(entry) {
  return JSON.stringify(Object.fromEntries(
    PERSISTED_FIELDS.filter(key => entry[key] !== undefined).map(key => [key, entry[key]]),
  ));
}

function decode(row) {
  return row ? { ...JSON.parse(row.data), sequence: row.sequence } : null;
}

// Read the legacy JSON array a record at a time, including pretty-printed files.
// The stream buffer and one notification are the only text retained in memory.
async function* readLegacyArray(filePath) {
  let started = false;
  let ended = false;
  let afterComma = false;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  let record = '';
  for await (const chunk of fs.createReadStream(filePath, { encoding: 'utf8', highWaterMark: 64 * 1024 })) {
    let start = 0;
    for (let index = 0; index < chunk.length; index++) {
      const char = chunk[index];
      if (!started || ended) {
        if (/\s/.test(char)) continue;
        if (!started && char === '[') { started = true; start = index + 1; continue; }
        throw new Error('Invalid legacy notification array');
      }
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') quoted = false;
      } else if (char === '"') quoted = true;
      else if (depth === 0 && (char === ',' || char === ']')) {
        record += chunk.slice(start, index);
        if (record.trim()) {
          yield JSON.parse(record);
        } else if (char === ',' || afterComma) {
          throw new Error('Empty legacy notification record');
        }
        record = '';
        afterComma = char === ',';
        if (char === ']') ended = true;
        start = index + 1;
      } else if (char === '{' || char === '[') depth++;
      else if (char === '}' || char === ']') depth--;
      if (depth < 0) throw new Error('Invalid legacy notification record');
    }
    if (started && !ended) record += chunk.slice(start);
  }
  if (!started || !ended || quoted || depth !== 0) throw new Error('Truncated legacy notification array');
}

function createNotificationStore(filePath) {
  const db = new DatabaseSync(filePath);
  try {
    // No memory mapping or growing JS index. SQLite's page cache targets 2 MiB.
    db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA cache_size = -2048;
      PRAGMA mmap_size = 0;
      PRAGMA temp_store = FILE;
      PRAGMA journal_size_limit = 4194304;
      CREATE TABLE IF NOT EXISTS notifications (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        data TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT;
    `);
  } catch (error) {
    db.close();
    throw error;
  }

  const insert = db.prepare('INSERT INTO notifications (id, data) VALUES (?, ?)');
  const next = db.prepare('SELECT sequence, data FROM notifications WHERE sequence > ? ORDER BY sequence LIMIT 1');
  const page = db.prepare('SELECT sequence, data FROM notifications WHERE sequence > ? ORDER BY sequence LIMIT ?');
  const find = db.prepare('SELECT sequence, data FROM notifications WHERE id = ?');
  const update = db.prepare('UPDATE notifications SET data = ? WHERE id = ?');
  const remove = db.prepare('DELETE FROM notifications WHERE id = ?');
  const count = db.prepare('SELECT COUNT(*) AS count FROM notifications');
  let size = count.get().count;
  let closed = false;

  return {
    append(entry) {
      const result = insert.run(entry.id, serialize(entry));
      entry.sequence = Number(result.lastInsertRowid);
      size++;
      return entry;
    },
    peekAfter(sequence = 0) {
      return decode(next.get(sequence));
    },
    get(id) {
      return decode(find.get(id));
    },
    update(entry) {
      return update.run(serialize(entry), entry.id).changes > 0;
    },
    remove(id) {
      const changed = Number(remove.run(id).changes);
      size -= changed;
      return changed > 0;
    },
    listAfter(sequence = 0, limit = MAX_PAGE_SIZE) {
      if (!Number.isSafeInteger(sequence) || sequence < 0) throw new TypeError('Invalid notification cursor');
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
        throw new TypeError(`limit must be between 1 and ${MAX_PAGE_SIZE}`);
      }
      const items = [];
      let bytes = 0;
      for (const row of page.iterate(sequence, limit + 1)) {
        if (items.length >= limit || (items.length > 0 && bytes + Buffer.byteLength(row.data) > PAGE_BYTES)) {
          return { items, nextCursor: items.at(-1).sequence };
        }
        items.push(decode(row));
        bytes += Buffer.byteLength(row.data);
      }
      return { items, nextCursor: null };
    },
    size() {
      return size;
    },
    clear() {
      db.exec('DELETE FROM notifications');
      size = 0;
    },
    async migrateLegacy(file) {
      if (db.prepare("SELECT value FROM metadata WHERE key = 'legacy-json-imported'").get()) return 0;
      let imported = 0;
      db.exec('BEGIN IMMEDIATE');
      try {
        if (fs.existsSync(file)) {
          const importRow = db.prepare('INSERT OR IGNORE INTO notifications (id, data) VALUES (?, ?)');
          for await (const data of readLegacyArray(file)) {
            if (typeof data?.title !== 'string' || typeof data.message !== 'string') continue;
            const entry = {
              ...data,
              id: typeof data.id === 'string' ? data.id : crypto.randomUUID(),
            };
            imported += Number(importRow.run(entry.id, serialize(entry)).changes);
          }
        }
        db.prepare("INSERT INTO metadata (key, value) VALUES ('legacy-json-imported', '1')").run();
        db.exec('COMMIT');
        size = count.get().count;
        return imported;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    close() {
      if (!closed) {
        db.close();
        closed = true;
      }
    },
  };
}

module.exports = { createNotificationStore, MAX_PAGE_SIZE };
