const { app, BrowserWindow, ipcMain, screen } = require('electron');
const path = require('path');
const http = require('http');
const fs = require('fs');
const crypto = require('crypto');
const { createNotificationSettings } = require('./notification-settings');
const { createNotificationQueue } = require('./notification-queue');
const { createNotificationStore } = require('./notification-store');
const {
  MIN_WINDOW_HEIGHT,
  MAX_WINDOW_HEIGHT,
  getNotificationSpace,
  getStackHeight,
  getNotificationLayout,
} = require('./notification-layout');
const {
  createRecurringSchedule,
  createSingleSchedule,
  evaluateSchedules,
  normalizeScheduleStore,
} = require('./schedule-engine');

if (!app.requestSingleInstanceLock()) app.exit(0);

// ─── State ───
const notificationStore = createNotificationStore(path.join(__dirname, 'notifications.sqlite'));
const notificationQueue = createNotificationQueue({
  store: notificationStore,
  canKeep: entries => getNotificationLayout(entries, workArea) !== null,
  canActivate: (entry, entries) => !isQuitting && entry.ready
    && entries.every(active => active.ready)
    && getNotificationLayout([...entries, entry], workArea) !== null,
  onPrepare: prepareNotificationWindow,
  onActivate: showNotificationWindow,
  onDeactivate: releaseNotificationWindow,
});
const activeWindows = notificationQueue.entries(); // [{ id, win, height, colorIndex }]
let isQuitting = false;
let httpServer = null;
let scheduleStore = { pending: [], completed: [] };
let schedulerTimer = null;
const PORT = 17329;
const SCHEDULES_FILE = path.join(__dirname, 'schedules.json');
const notificationSettings = createNotificationSettings(path.join(__dirname, 'settings.json'));
let workArea = null;
let layoutRevision = 0;
let colorCounter = 0;

// ─── Color Themes (6 distinct gradients) ───
const THEMES = [
  { bg:'linear-gradient(135deg,#1a1a2e 0%,#16213e 50%,#0f3460 100%)',border:'rgba(100,180,255,.4)',p1:'#3c8cff',p2:'#ff6b6b',ttl:'#ffd666',btn:'linear-gradient(135deg,#3c8cff 0%,#2563eb 100%)',btnH:'linear-gradient(135deg,#5ba0ff 0%,#3b7dff 100%)',dot:'#ff4d4d',bellFill:'#ffd666' },
  { bg:'linear-gradient(135deg,#1e1a2e 0%,#2d1b69 50%,#4a1a8a 100%)',border:'rgba(180,130,255,.4)',p1:'#a855f7',p2:'#f472b6',ttl:'#d8b4fe',btn:'linear-gradient(135deg,#a855f7 0%,#7c3aed 100%)',btnH:'linear-gradient(135deg,#c084fc 0%,#a855f7 100%)',dot:'#f472b6',bellFill:'#d8b4fe' },
  { bg:'linear-gradient(135deg,#1a2e1e 0%,#1b4a2e 50%,#146034 100%)',border:'rgba(100,255,160,.4)',p1:'#22c55e',p2:'#fbbf24',ttl:'#86efac',btn:'linear-gradient(135deg,#22c55e 0%,#16a34a 100%)',btnH:'linear-gradient(135deg,#4ade80 0%,#22c55e 100%)',dot:'#fbbf24',bellFill:'#86efac' },
  { bg:'linear-gradient(135deg,#2e201a 0%,#4a3016 50%,#604014 100%)',border:'rgba(255,180,100,.4)',p1:'#f97316',p2:'#ef4444',ttl:'#fdba74',btn:'linear-gradient(135deg,#f97316 0%,#ea580c 100%)',btnH:'linear-gradient(135deg,#fb923c 0%,#f97316 100%)',dot:'#ef4444',bellFill:'#fdba74' },
  { bg:'linear-gradient(135deg,#2e1a28 0%,#4a1640 50%,#601460 100%)',border:'rgba(255,100,200,.4)',p1:'#ec4899',p2:'#a855f7',ttl:'#f9a8d4',btn:'linear-gradient(135deg,#ec4899 0%,#db2777 100%)',btnH:'linear-gradient(135deg,#f472b6 0%,#ec4899 100%)',dot:'#a855f7',bellFill:'#f9a8d4' },
  { bg:'linear-gradient(135deg,#1a2a2e 0%,#163e42 50%,#0f5460 100%)',border:'rgba(100,230,255,.4)',p1:'#06b6d4',p2:'#22c55e',ttl:'#67e8f9',btn:'linear-gradient(135deg,#06b6d4 0%,#0891b2 100%)',btnH:'linear-gradient(135deg,#22d3ee 0%,#06b6d4 100%)',dot:'#22c55e',bellFill:'#67e8f9' },
];

// ─── Unacknowledged notifications ───
function notificationData(entry) {
  return {
    id: entry.id,
    title: entry.title,
    message: entry.message,
    silent: entry.silent,
    colorIndex: entry.colorIndex,
    sequence: entry.sequence,
  };
}

// ─── Schedules Persistence ───
function loadSchedules() {
  try {
    if (fs.existsSync(SCHEDULES_FILE)) {
      scheduleStore = normalizeScheduleStore(JSON.parse(fs.readFileSync(SCHEDULES_FILE, 'utf-8')));
    }
  } catch { scheduleStore = normalizeScheduleStore(null); }
}
function saveSchedules() {
  try { fs.writeFileSync(SCHEDULES_FILE, JSON.stringify(scheduleStore, null, 2), 'utf-8'); }
  catch (e) { console.error('[cc-notify] Save error:', e.message); }
}

// ─── Scheduler ───
function startScheduler() {
  loadSchedules();
  schedulerTimer = setInterval(() => {
    try {
      const result = evaluateSchedules(scheduleStore, new Date());
      if (result.due.length > 0) {
        result.due.forEach(s => createNotificationWindow(s.title, s.message));
      }
      if (result.changed) {
        scheduleStore = result.store;
        saveSchedules();
      }
    } catch (error) {
      console.error('[cc-notify] Scheduled notification failed:', error.message);
    }
  }, 1000);
}
// ─── Generate themed HTML ───
function generateHTML(t) {
  const themeStyles = Object.entries(t).map(([key, value]) => `--${key}:${value};`).join('');
  return fs.readFileSync(path.join(__dirname, 'notify.html'), 'utf8')
    .replace('{{themeStyles}}', themeStyles);
}
// ─── Window positioning ───
function removeDestroyedWindows() {
  if (isQuitting) return;
  for (const entry of notificationQueue.residentEntries()) {
    if (entry.win?.isDestroyed()) notificationQueue.removeById(entry.id);
  }
}

function repositionWindows() {
  const bounds = getNotificationLayout(activeWindows, workArea);
  if (!bounds) return;
  activeWindows.forEach((entry, index) => {
    if (entry.win && !entry.win.isDestroyed()) entry.win.setBounds(bounds[index]);
  });
}

function layoutConstraints() {
  const space = getNotificationSpace(workArea);
  return {
    revision: layoutRevision,
    maxCardHeight: Math.max(140, Math.min(MAX_WINDOW_HEIGHT, space.height) - 20),
  };
}

function updateDisplayLayout() {
  workArea = { ...screen.getPrimaryDisplay().workArea };
  layoutRevision++;
  const space = getNotificationSpace(workArea);
  for (const entry of notificationQueue.residentEntries()) {
    if (!entry.win || entry.win.isDestroyed()) continue;
    entry.ready = false;
    entry.win.setSize(Math.max(21, space.width), entry.win.getBounds().height);
    if (entry.loaded) entry.win.webContents.send('layout-changed', layoutConstraints());
  }
  if (notificationQueue.totalSize() > 0) notificationQueue.refresh();
  repositionWindows();
}

function findNotification(sender) {
  return notificationQueue.residentEntries()
    .find(entry => entry.win && !entry.win.isDestroyed() && entry.win.webContents === sender);
}

// ─── Create notification window ───
function createNotificationWindow(title, message, options = {}) {
  removeDestroyedWindows();
  const ci = Number.isInteger(options.colorIndex) && options.colorIndex >= 0 && options.colorIndex < THEMES.length
    ? options.colorIndex
    : colorCounter % THEMES.length;
  colorCounter++;
  const entry = {
    id: typeof options.id === 'string' ? options.id : crypto.randomUUID(),
    title,
    message,
    silent: options.silent === true,
    colorIndex: ci,
    ready: false,
  };
  notificationQueue.add(entry);
  return entry;
}

// Measure only the FIFO head. It remains hidden and silent until it fits.
function prepareNotificationWindow(entry) {
  if (isQuitting || entry.win) return;
  if (getNotificationLayout([...activeWindows, { height: MIN_WINDOW_HEIGHT }], workArea) === null) return;
  const space = getNotificationSpace(workArea);
  const initH = Math.min(MAX_WINDOW_HEIGHT, space.height);

  const win = new BrowserWindow({
    width: space.width, height: initH,
    frame: false, transparent: true, alwaysOnTop: true,
    resizable: false, skipTaskbar: true, focusable: true, show: false,
    icon: path.join(__dirname, 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  entry.win = win;
  entry.measurement = new Promise(resolve => { entry.finishMeasurement = resolve; });

  win.webContents.once('did-finish-load', () => {
    if (isQuitting || win.isDestroyed()) return;
    entry.loaded = true;
    const settings = notificationSettings.get();
    win.webContents.send('show-notification', {
      title: entry.title,
      message: entry.message,
      soundEnabled: entry.currentSoundEnabled ?? (settings.soundEnabled && !entry.silent),
      settingsOpen: entry.settingsOpen === true,
      defaultSoundEnabled: settings.soundEnabled,
      ...layoutConstraints(),
    });
  });

  win.webContents.on('did-fail-load', (_event, code, description) => {
    console.error('[cc-notify] Notification UI failed to load:', code, description);
    entry.finishMeasurement?.();
  });

  win.on('closed', () => {
    entry.finishMeasurement?.();
    if (isQuitting || entry.win !== win) return;
    entry.win = null;
    notificationQueue.removeById(entry.id);
    repositionWindows();
  });
  win.loadURL('http://127.0.0.1:' + PORT + '/ui?theme=' + entry.colorIndex);
}

function showNotificationWindow(entry) {
  const win = entry.win;
  repositionWindows();
  const settings = notificationSettings.get();
  const currentSoundEnabled = entry.currentSoundEnabled ?? (settings.soundEnabled && !entry.silent);
  if (entry.currentSoundEnabled !== currentSoundEnabled) {
    notificationQueue.updateState(entry, { currentSoundEnabled });
  }
  win.webContents.send('notification-visibility', {
    active: true,
    defaultSoundEnabled: settings.soundEnabled,
    soundEnabled: currentSoundEnabled,
  });
  win.setSkipTaskbar(false);
  win.show();
  win.setAlwaysOnTop(true, 'screen-saver');
}

function releaseNotificationWindow(entry) {
  entry.finishMeasurement?.();
  const win = entry.win;
  entry.win = null;
  entry.ready = false;
  entry.loaded = false;
  // Detach before destruction so returning to disk cannot acknowledge a card.
  if (win && !win.isDestroyed()) win.destroy();
}
// ─── IPC ───
ipcMain.handle('set-default-sound', (event, enabled) => {
  const entry = findNotification(event.sender);
  if (!entry || !activeWindows.includes(entry)) return { success: false, error: 'Notification window is no longer active.' };

  try {
    const settings = notificationSettings.setSoundEnabled(enabled);
    notificationQueue.residentEntries().forEach(({ win }) => {
      if (win && !win.isDestroyed()) win.webContents.send('settings-changed', settings);
    });
    return { success: true, settings };
  } catch (e) {
    console.error('[cc-notify] Settings error:', e.message);
    return { success: false, error: '声音设置保存失败，请重试。' };
  }
});

ipcMain.on('dismiss', (event) => {
  const entry = findNotification(event.sender);
  if (!entry || entry.dismissing || isQuitting) return;
  entry.dismissing = true;
  // Keep the acknowledgement even if the card returns to disk during animation.
  setTimeout(() => {
    if (isQuitting) return;
    try {
      notificationQueue.removeById(entry.id);
      repositionWindows();
    } catch (error) {
      entry.dismissing = false;
      console.error('[cc-notify] Dismiss failed:', error.message);
    }
  }, 150);
});

ipcMain.on('card-state', (event, state) => {
  if (isQuitting) return;
  const entry = findNotification(event.sender);
  if (!entry || !notificationQueue.isActive(entry.id)) return;
  if (typeof state?.currentSoundEnabled !== 'boolean' || typeof state.settingsOpen !== 'boolean') return;
  if (entry.currentSoundEnabled === state.currentSoundEnabled && entry.settingsOpen === state.settingsOpen) return;
  try {
    notificationQueue.updateState(entry, {
      currentSoundEnabled: state.currentSoundEnabled,
      settingsOpen: state.settingsOpen,
    });
  } catch (error) {
    console.error('[cc-notify] Card state save failed:', error.message);
  }
});

ipcMain.on('report-height', (event, contentHeight, revision) => {
  const entry = findNotification(event.sender);
  if (isQuitting || !entry || revision !== layoutRevision || !Number.isFinite(contentHeight)) return;
  const height = Math.min(Math.max(Math.ceil(contentHeight), MIN_WINDOW_HEIGHT), MAX_WINDOW_HEIGHT);
  if (entry.ready && entry.height === height) return;
  entry.height = height;
  entry.ready = true;
  try {
    notificationQueue.refresh();
    repositionWindows();
  } catch (error) {
    console.error('[cc-notify] Notification layout failed:', error.message);
  }
  entry.finishMeasurement?.();
});

// ─── HTTP server ───
function startHttpServer() {
  httpServer = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    const url = new URL(req.url, 'http://127.0.0.1');
    const p = url.pathname;

    // Serve themed UI
    if (req.method === 'GET' && p === '/ui') {
      const ti = parseInt(url.searchParams.get('theme') || '0', 10) % THEMES.length;
      const html = generateHTML(THEMES[ti]);
      const buf = Buffer.from(html, 'utf-8');
      res.writeHead(200, { 'Content-Type':'text/html; charset=utf-8', 'Content-Length':buf.length });
      res.end(buf); return;
    }

    if (req.method === 'GET' && p === '/health') {
      removeDestroyedWindows();
      res.writeHead(200, { 'Content-Type':'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        status:'ok',
        service:'cc-notify',
        capacityMode: 'screen-space',
        queueStorage: 'sqlite',
        residentNotifications: notificationQueue.residentEntries().length,
        workArea,
        availableHeight: getNotificationSpace(workArea).height,
        usedHeight: getStackHeight(activeWindows),
        windows: activeWindows.length,
        queuedNotifications: notificationQueue.waitingSize(),
        notifications: notificationQueue.totalSize(),
        schedules: scheduleStore.pending.length,
        pending: scheduleStore.pending.length,
        completed: scheduleStore.completed.length,
        defaultSoundEnabled: notificationSettings.get().soundEnabled,
      }));
      return;
    }

    // Instant notification
    if (req.method === 'POST' && p === '/notify') {
      readBody(req, (data) => {
        const entry = createNotificationWindow(data.title || 'Agent Notification', data.message || 'Task completed.', { silent: data.silent === true });
        const respond = () => jsonOk(res, {
          success: true, id: entry.id, queued: !notificationQueue.isActive(entry.id),
        });
        // Return the measured admission result for a newly prepared queue head.
        if (entry.measurement && !entry.ready) {
          const timeout = setTimeout(respond, 1500);
          entry.measurement.then(() => {
            if (!res.writableEnded) {
              clearTimeout(timeout);
              respond();
            }
          });
        } else respond();
      }, res); return;
    }

    if (req.method === 'GET' && p === '/notifications') {
      removeDestroyedWindows();
      try {
        const page = notificationQueue.listWaiting({
          cursor: Number(url.searchParams.get('cursor') || 0),
          limit: Number(url.searchParams.get('limit') || 100),
        });
        jsonOk(res, {
          active: activeWindows.map(notificationData),
          queued: page.items.map(notificationData),
          queuedTotal: notificationQueue.waitingSize(),
          nextCursor: page.nextCursor,
        });
      } catch (error) {
        jsonErr(res, error instanceof TypeError ? 400 : 500, error.message);
      }
      return;
    }

    // Schedule a future reminder
    if (req.method === 'POST' && p === '/schedule') {
      readBody(req, (data) => {
        try {
          if (!data.triggerAt) { jsonErr(res, 400, 'triggerAt is required'); return; }
          const entry = createSingleSchedule(data);
          scheduleStore.pending.push(entry);
          saveSchedules();
          jsonOk(res, { success:true, id: entry.id, type: entry.type, triggerAt: entry.triggerAt });
        } catch (e) {
          jsonErr(res, 400, e.message);
        }
      }, res); return;
    }

    // Schedule a recurring reminder inside a date/time range
    if (req.method === 'POST' && p === '/schedule/recurring') {
      readBody(req, (data) => {
        try {
          const entry = createRecurringSchedule(data);
          scheduleStore.pending.push(entry);
          saveSchedules();
          jsonOk(res, {
            success:true,
            id: entry.id,
            type: entry.type,
            startAt: entry.startAt,
            endAt: entry.endAt,
            intervalMinutes: entry.intervalMinutes,
            nextTriggerAt: entry.nextTriggerAt,
          });
        } catch (e) {
          jsonErr(res, 400, e.message);
        }
      }, res); return;
    }
    // List all schedules
    if (req.method === 'GET' && p === '/schedules') {
      res.writeHead(200, { 'Content-Type':'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        pending: scheduleStore.pending,
        completed: scheduleStore.completed,
        schedules: scheduleStore.pending,
      }));
      return;
    }

    // Delete a schedule
    if (req.method === 'POST' && p === '/schedule/delete') {
      readBody(req, (data) => {
        if (!data.id) { jsonErr(res, 400, 'id is required'); return; }
        const beforePending = scheduleStore.pending.length;
        const beforeCompleted = scheduleStore.completed.length;
        scheduleStore.pending = scheduleStore.pending.filter(s => s.id !== data.id);
        scheduleStore.completed = scheduleStore.completed.filter(s => s.id !== data.id);
        if (
          scheduleStore.pending.length === beforePending &&
          scheduleStore.completed.length === beforeCompleted
        ) { jsonErr(res, 404, 'Schedule not found: ' + data.id); return; }
        saveSchedules();
        jsonOk(res, { success:true, deleted: data.id });
      }, res); return;
    }

    // Dismiss all foreground and waiting notifications without refilling.
    if (req.method === 'POST' && p === '/dismiss') {
      removeDestroyedWindows();
      const closed = activeWindows.length;
      const clearedQueued = notificationQueue.waitingSize();
      try {
        notificationQueue.clear();
        jsonOk(res, { success:true, closed, clearedQueued });
      } catch (error) {
        jsonErr(res, 500, error.message);
      }
      return;
    }

    res.writeHead(404); res.end('Not found');
  });

  httpServer.listen(PORT, '127.0.0.1', () => {
    console.log('[cc-notify] Ready on http://127.0.0.1:' + PORT);
  });
  httpServer.on('error', err => {
    console.error('[cc-notify] Port error:', err.code);
    app.quit();
  });
}

// ─── Helpers ───
function readBody(req, cb, res) {
  const chunks = [];
  let bytes = 0;
  req.on('data', c => {
    bytes += c.length;
    if (bytes > 1024 * 1024) {
      if (!res.writableEnded) jsonErr(res, 413, 'Notification request exceeds 1 MiB');
      chunks.length = 0;
    } else if (!res.writableEnded) chunks.push(c);
  });
  req.on('end', () => {
    if (res.writableEnded) return;
    let data;
    try { data = JSON.parse(Buffer.concat(chunks).toString('utf-8')); }
    catch (error) { jsonErr(res, 400, 'Invalid JSON: ' + error.message); return; }
    try { cb(data); }
    catch (error) {
      console.error('[cc-notify] Request failed:', error.message);
      jsonErr(res, 500, 'Notification could not be saved: ' + error.message);
    }
  });
}
function jsonOk(res, obj) {
  res.writeHead(200, { 'Content-Type':'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}
function jsonErr(res, code, msg) {
  res.writeHead(code, { 'Content-Type':'application/json; charset=utf-8' });
  res.end(JSON.stringify({ success:false, error:msg }));
}

// ─── App lifecycle ───
app.whenReady().then(async () => {
  const imported = await notificationStore.migrateLegacy(path.join(__dirname, 'notifications.json'));
  if (imported) console.log('[cc-notify] Imported legacy notifications:', imported);
  startHttpServer();
  updateDisplayLayout();
  screen.on('display-metrics-changed', updateDisplayLayout);
  screen.on('display-added', updateDisplayLayout);
  screen.on('display-removed', updateDisplayLayout);
  startScheduler();
  const args = process.argv;
  const idx = args.indexOf('--notify');
  if (idx !== -1) {
    createNotificationWindow(args[idx+1] || 'Notification', args[idx+2] || 'Done');
  } else {
    console.log('[cc-notify] Server mode with scheduler active.');
  }
}).catch(error => {
  console.error('[cc-notify] Startup failed:', error.message);
  app.quit();
});

app.on('window-all-closed', () => {});
app.on('before-quit', () => {
  isQuitting = true;
  if (schedulerTimer) clearInterval(schedulerTimer);
  if (httpServer) httpServer.close();
});
app.on('will-quit', () => notificationStore.close());
