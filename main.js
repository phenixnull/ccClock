const { app, BrowserWindow, ipcMain, screen } = require('electron');
const path = require('path');
const http = require('http');
const fs = require('fs');
const crypto = require('crypto');
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
  onEvict(entry) {
    destroyNotificationWindow(entry);
  },
});
const activeWindows = notificationQueue.entries(); // [{ id, win, height, colorIndex }]
let httpServer = null;
let scheduleStore = { pending: [], completed: [] };
let schedulerTimer = null;
const PORT = 17329;
const SCHEDULES_FILE = path.join(__dirname, 'schedules.json');
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
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>CC Notify</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:"Microsoft YaHei","Segoe UI",sans-serif;background:transparent;overflow:hidden;user-select:none}
.card{width:400px;min-height:120px;max-height:500px;background:${t.bg};border:1.5px solid ${t.border};border-radius:14px;box-shadow:0 8px 32px rgba(0,0,0,.5),0 0 20px rgba(0,0,0,.2),inset 0 1px 0 rgba(255,255,255,.05);display:flex;flex-direction:column;margin:10px;animation:slideIn .35s cubic-bezier(.16,1,.3,1);position:relative;overflow:hidden}
@keyframes slideIn{from{transform:translateX(120%);opacity:0}to{transform:translateX(0);opacity:1}}
@keyframes slideOut{from{transform:translateX(0);opacity:1}to{transform:translateX(120%);opacity:0}}
.card.dismissing{animation:slideOut .2s ease-in forwards}
.card::before{content:'';position:absolute;inset:-1px;border-radius:14px;background:linear-gradient(45deg,${t.p1},${t.p2},${t.p1});background-size:300% 300%;animation:pulse 2s ease-in-out infinite;z-index:-1;opacity:.6}
@keyframes pulse{0%,100%{background-position:0% 50%;opacity:.4}50%{background-position:100% 50%;opacity:.8}}
.hdr{display:flex;align-items:center;padding:14px 40px 8px 16px;gap:10px}
.bell{width:28px;height:28px;animation:ring .6s ease-in-out infinite alternate;filter:drop-shadow(0 0 6px rgba(255,180,50,.6))}
@keyframes ring{0%{transform:rotate(-12deg)}100%{transform:rotate(12deg)}}
.ttl{color:${t.ttl};font-size:16px;font-weight:700;text-shadow:0 0 10px rgba(255,255,255,.15);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.body{padding:4px 18px 14px 18px;flex:1;overflow-y:auto}
.msg{color:#e0e8f0;font-size:14px;line-height:1.7;word-break:break-word;white-space:pre-wrap}
.ftr{display:flex;justify-content:flex-end;padding:8px 14px 12px 14px}
.btn{background:${t.btn};color:#fff;border:none;border-radius:8px;padding:8px 28px;font-size:13px;font-weight:600;cursor:pointer;transition:all .2s;box-shadow:0 2px 8px rgba(0,0,0,.2);font-family:"Microsoft YaHei","Segoe UI",sans-serif}
.btn:hover{background:${t.btnH};box-shadow:0 4px 16px rgba(0,0,0,.3);transform:translateY(-1px)}
.btn:active{transform:translateY(0)}
.close-x{position:absolute;top:10px;right:12px;width:24px;height:24px;border:none;background:rgba(255,255,255,.1);border-radius:6px;color:#aaa;font-size:16px;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all .15s;z-index:10;line-height:1}
.close-x:hover{background:rgba(255,80,80,.6);color:#fff}
.dot{position:absolute;top:12px;right:44px;width:10px;height:10px;border-radius:50%;background:${t.dot};animation:blink .5s ease-in-out infinite alternate;box-shadow:0 0 8px rgba(0,0,0,.3)}
@keyframes blink{from{opacity:1}to{opacity:.3}}
</style></head><body>
<div class="card" id="card">
  <button class="close-x" id="x" title="Close">&times;</button>
  <div class="dot"></div>
  <div class="hdr">
    <svg class="bell" viewBox="0 0 24 24" fill="none"><path d="M12 2C10.343 2 9 3.343 9 5V5.28C6.607 6.248 5 8.618 5 11.5V16L3 18V19H21V18L19 16V11.5C19 8.618 17.393 6.248 15 5.28V5C15 3.343 13.657 2 12 2Z" fill="${t.bellFill}"/><path d="M10 20C10 21.1046 10.8954 22 12 22C13.1046 22 14 21.1046 14 20H10Z" fill="${t.bellFill}"/></svg>
    <span class="ttl" id="t">Notification</span>
  </div>
  <div class="body"><p class="msg" id="m">...</p></div>
  <div class="ftr"><button class="btn" id="b">\u786e\u8ba4\u5173\u95ed</button></div>
</div>
<script>
let ac=null,iv=null,dis=false;
function go(){try{ac=new(window.AudioContext||window.webkitAudioContext)()}catch(e){return}function bip(){if(!ac||ac.state==='closed')return;try{let o=ac.createOscillator(),g=ac.createGain();o.connect(g);g.connect(ac.destination);o.type='square';o.frequency.value=1200;g.gain.setValueAtTime(.3,ac.currentTime);g.gain.exponentialRampToValueAtTime(.01,ac.currentTime+.12);o.start(ac.currentTime);o.stop(ac.currentTime+.12)}catch(e){}}bip();iv=setInterval(bip,600)}
function stop(){if(iv){clearInterval(iv);iv=null}if(ac){let c=ac;ac=null;c.close().catch(()=>{})}}
function dismiss(){if(dis)return;dis=true;stop();document.getElementById('card').classList.add('dismissing');setTimeout(function(){window.ccNotify.dismiss()},150)}
window.ccNotify.onShowNotification(function(d){document.getElementById('t').textContent=d.title;document.getElementById('m').textContent=d.message;dis=false;go();setTimeout(function(){var h=document.querySelector('.card').offsetHeight+20;window.ccNotify.reportHeight(h)},50)});
document.getElementById('b').addEventListener('click',dismiss);
document.getElementById('x').addEventListener('click',dismiss);
</script></body></html>`;
}
// ─── Window positioning ───
function removeDestroyedWindows() {
  notificationQueue.removeWhere((entry) => !entry || !entry.win || entry.win.isDestroyed());
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
    if (entry.win.isDestroyed()) continue;
    const h = entry.height || 200;
    const y = bottomY - h;
    entry.win.setBounds({ x: workArea.x + workArea.width - W - M, y, width: W, height: h });
    bottomY = y - GAP;
  }
}

// ─── Create notification window ───
function createNotificationWindow(title, message) {
  removeDestroyedWindows();
  const ci = colorCounter % THEMES.length;
  colorCounter++;
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

  const id = crypto.randomUUID();
  const entry = { id, win, height: initH, colorIndex: ci };
  notificationQueue.add(entry);
  repositionWindows();

  const pending = { title, message };
  win.loadURL('http://127.0.0.1:' + PORT + '/ui?theme=' + ci);

  win.webContents.once('did-finish-load', () => {
    win.webContents.send('show-notification', pending);
    win.show();
    win.setAlwaysOnTop(true, 'screen-saver');
  });

  win.on('closed', () => {
    notificationQueue.removeById(id);
    repositionWindows();
  });
}
// ─── IPC ───
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
        schedules: scheduleStore.pending.length,
        pending: scheduleStore.pending.length,
        completed: scheduleStore.completed.length,
      }));
      return;
    }

    // Instant notification
    if (req.method === 'POST' && p === '/notify') {
      readBody(req, (data) => {
        createNotificationWindow(data.title || 'Agent Notification', data.message || 'Task completed.');
        jsonOk(res, { success:true });
      }, res); return;
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

    // Dismiss all active windows
    if (req.method === 'POST' && p === '/dismiss') {
      removeDestroyedWindows();
      const closed = activeWindows.length;
      [...activeWindows].forEach(destroyNotificationWindow);
      jsonOk(res, { success:true, closed });
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
  if (schedulerTimer) clearInterval(schedulerTimer);
  if (httpServer) httpServer.close();
});
