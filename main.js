const { app, BrowserWindow, ipcMain, screen } = require('electron');
const path = require('path');
const http = require('http');
const fs = require('fs');
const crypto = require('crypto');
const { createNotificationSettings } = require('./notification-settings');
const {
  DEFAULT_MAX_ACTIVE_WINDOWS,
  createNotificationQueue,
} = require('./notification-queue');
const {
  createRecurringSchedule,
  createSingleSchedule,
  evaluateSchedules,
  normalizeScheduleStore,
} = require('./schedule-engine');

// ─── State ───
const notificationQueue = createNotificationQueue({
  maxActive: DEFAULT_MAX_ACTIVE_WINDOWS,
  onActivate: showNotificationWindow,
  onChange: saveNotifications,
});
const activeWindows = notificationQueue.entries(); // [{ id, win, height, colorIndex }]
let restoringNotifications = false;
let isQuitting = false;
let httpServer = null;
let scheduleStore = { pending: [], completed: [] };
let schedulerTimer = null;
const PORT = 17329;
const SCHEDULES_FILE = path.join(__dirname, 'schedules.json');
const NOTIFICATIONS_FILE = path.join(__dirname, 'notifications.json');
const notificationSettings = createNotificationSettings(path.join(__dirname, 'settings.json'));
const W = 420;
const M = 20;
const GAP = 12;
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
  };
}

function saveNotifications() {
  if (restoringNotifications) return;
  try {
    const notifications = [
      ...activeWindows,
      ...notificationQueue.waitingEntries(),
    ].map(notificationData);
    fs.writeFileSync(NOTIFICATIONS_FILE + '.tmp', JSON.stringify(notifications, null, 2), 'utf8');
    fs.renameSync(NOTIFICATIONS_FILE + '.tmp', NOTIFICATIONS_FILE);
  } catch (e) {
    console.error('[cc-notify] Save notifications error:', e.message);
  }
}

function loadNotifications() {
  let saved;
  try {
    if (!fs.existsSync(NOTIFICATIONS_FILE)) return;
    saved = JSON.parse(fs.readFileSync(NOTIFICATIONS_FILE, 'utf8'));
    if (!Array.isArray(saved)) throw new Error('Expected a notification array');
  } catch (e) {
    console.error('[cc-notify] Load notifications error:', e.message);
    return;
  }

  restoringNotifications = true;
  try {
    for (const data of saved) {
      if (typeof data?.title === 'string' && typeof data.message === 'string') {
        createNotificationWindow(data.title, data.message, data);
      }
    }
  } finally {
    restoringNotifications = false;
    saveNotifications();
  }
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
    const result = evaluateSchedules(scheduleStore, new Date());
    if (result.due.length > 0) {
      result.due.forEach(s => createNotificationWindow(s.title, s.message));
    }
    if (result.changed) {
      scheduleStore = result.store;
      saveSchedules();
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
  // Waiting entries intentionally have no BrowserWindow.
  notificationQueue.removeWhere((entry) => entry.win && entry.win.isDestroyed());
}

function destroyNotificationWindow(entry) {
  if (!entry || !entry.win || entry.win.isDestroyed()) {
    return;
  }

  entry.win.destroy();
}

function repositionWindows() {
  removeDestroyedWindows();
  const display = screen.getPrimaryDisplay();
  const workArea = display.workArea;
  let bottomY = workArea.y + workArea.height - M;
  for (const entry of activeWindows) {
    if (!entry.win || entry.win.isDestroyed()) continue;
    const h = entry.height || 200;
    const y = bottomY - h;
    entry.win.setBounds({ x: workArea.x + workArea.width - W - M, y, width: W, height: h });
    bottomY = y - GAP;
  }
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
  };
  notificationQueue.add(entry);
  return entry;
}

// Only foreground notifications allocate a window or start a buzzer.
function showNotificationWindow(entry) {
  const display = screen.getPrimaryDisplay();
  const workArea = display.workArea;
  const initH = 200;

  const win = new BrowserWindow({
    width: W, height: initH,
    x: workArea.x + workArea.width - W - M,
    y: workArea.y + workArea.height - initH - M,
    frame: false, transparent: true, alwaysOnTop: true,
    resizable: false, skipTaskbar: false, focusable: true, show: false,
    icon: path.join(__dirname, 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false,
    },
  });

  entry.win = win;
  entry.height = initH;
  repositionWindows();

  win.webContents.once('did-finish-load', () => {
    if (isQuitting || win.isDestroyed()) return;
    const settings = notificationSettings.get();
    win.webContents.send('show-notification', {
      title: entry.title,
      message: entry.message,
      silent: entry.silent,
      soundEnabled: settings.soundEnabled && !entry.silent,
      defaultSoundEnabled: settings.soundEnabled,
    });
    win.show();
    win.setAlwaysOnTop(true, 'screen-saver');
  });

  win.on('closed', () => {
    if (isQuitting) return;
    notificationQueue.removeById(entry.id);
    repositionWindows();
  });
  win.loadURL('http://127.0.0.1:' + PORT + '/ui?theme=' + entry.colorIndex);
}
// ─── IPC ───
ipcMain.handle('set-default-sound', (event, enabled) => {
  const entry = activeWindows.find(w => !w.win.isDestroyed() && w.win.webContents === event.sender);
  if (!entry) return { success: false, error: 'Notification window is no longer active.' };

  try {
    const settings = notificationSettings.setSoundEnabled(enabled);
    activeWindows.forEach(({ win }) => {
      if (!win.isDestroyed()) win.webContents.send('settings-changed', settings);
    });
    return { success: true, settings };
  } catch (e) {
    console.error('[cc-notify] Settings error:', e.message);
    return { success: false, error: '声音设置保存失败，请重试。' };
  }
});

ipcMain.on('dismiss', (event) => {
  const entry = activeWindows.find(w => !w.win.isDestroyed() && w.win.webContents === event.sender);
  if (entry && !entry.win.isDestroyed()) entry.win.destroy();
});

ipcMain.on('report-height', (event, contentHeight) => {
  const entry = activeWindows.find(w => !w.win.isDestroyed() && w.win.webContents === event.sender);
  if (!entry) return;
  entry.height = Math.min(Math.max(contentHeight, 160), 500);
  repositionWindows();
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
        maxWindows: DEFAULT_MAX_ACTIVE_WINDOWS,
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
        jsonOk(res, {
          success: true,
          id: entry.id,
          queued: notificationQueue.waitingEntries().includes(entry),
        });
      }, res); return;
    }

    if (req.method === 'GET' && p === '/notifications') {
      removeDestroyedWindows();
      jsonOk(res, {
        active: activeWindows.map(notificationData),
        queued: notificationQueue.waitingEntries().map(notificationData),
      });
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
      notificationQueue.clear().forEach(destroyNotificationWindow);
      jsonOk(res, { success:true, closed, clearedQueued });
      return;
    }

    res.writeHead(404); res.end('Not found');
  });

  httpServer.listen(PORT, '127.0.0.1', () => {
    console.log('[cc-notify] Ready on http://127.0.0.1:' + PORT);
  });
  httpServer.on('error', err => { console.error('[cc-notify] Port error:', err.code); });
}

// ─── Helpers ───
function readBody(req, cb, res) {
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    try { cb(JSON.parse(Buffer.concat(chunks).toString('utf-8'))); }
    catch (e) { jsonErr(res, 400, 'Invalid JSON: ' + e.message); }
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
app.whenReady().then(() => {
  startHttpServer();
  loadNotifications();
  startScheduler();
  const args = process.argv;
  const idx = args.indexOf('--notify');
  if (idx !== -1) {
    createNotificationWindow(args[idx+1] || 'Notification', args[idx+2] || 'Done');
  } else {
    console.log('[cc-notify] Server mode with scheduler active.');
  }
});

app.on('window-all-closed', () => {});
app.on('before-quit', () => {
  isQuitting = true;
  saveNotifications();
  if (schedulerTimer) clearInterval(schedulerTimer);
  if (httpServer) httpServer.close();
});
