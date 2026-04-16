const { app, BrowserWindow, ipcMain, screen } = require('electron');
const path = require('path');
const http = require('http');

let notifyWindow = null;
let httpServer = null;
let pendingNotification = null;
const PORT = 17329;

// ─── Inline HTML ───
const NOTIFY_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Type" content="text/html; charset=UTF-8">
<title>CC Notify</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:"Microsoft YaHei","Segoe UI","PingFang SC",sans-serif;background:transparent;overflow:hidden;user-select:none;-webkit-font-smoothing:antialiased}
.card{width:400px;min-height:120px;max-height:500px;background:linear-gradient(135deg,#1a1a2e 0%,#16213e 50%,#0f3460 100%);border:1.5px solid rgba(100,180,255,.4);border-radius:14px;box-shadow:0 8px 32px rgba(0,0,0,.5),0 0 20px rgba(60,140,255,.15),inset 0 1px 0 rgba(255,255,255,.05);display:flex;flex-direction:column;margin:10px;animation:slideIn .35s cubic-bezier(.16,1,.3,1);position:relative;overflow:hidden}
@keyframes slideIn{from{transform:translateX(120%);opacity:0}to{transform:translateX(0);opacity:1}}
@keyframes slideOut{from{transform:translateX(0);opacity:1}to{transform:translateX(120%);opacity:0}}
.card.dismissing{animation:slideOut .2s ease-in forwards}
.card::before{content:'';position:absolute;inset:-1px;border-radius:14px;background:linear-gradient(45deg,#3c8cff,#ff6b6b,#3c8cff);background-size:300% 300%;animation:pulse 2s ease-in-out infinite;z-index:-1;opacity:.6}
@keyframes pulse{0%,100%{background-position:0% 50%;opacity:.4}50%{background-position:100% 50%;opacity:.8}}
.hdr{display:flex;align-items:center;padding:14px 40px 8px 16px;gap:10px}
.bell{width:28px;height:28px;animation:ring .6s ease-in-out infinite alternate;filter:drop-shadow(0 0 6px rgba(255,180,50,.6))}
@keyframes ring{0%{transform:rotate(-12deg)}100%{transform:rotate(12deg)}}
.ttl{color:#ffd666;font-size:16px;font-weight:700;text-shadow:0 0 10px rgba(255,214,102,.3);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.body{padding:4px 18px 14px 18px;flex:1;overflow-y:auto}
.msg{color:#e0e8f0;font-size:14px;line-height:1.7;word-break:break-word;white-space:pre-wrap}
.ftr{display:flex;justify-content:flex-end;padding:8px 14px 12px 14px}
.btn{background:linear-gradient(135deg,#3c8cff 0%,#2563eb 100%);color:#fff;border:none;border-radius:8px;padding:8px 28px;font-size:13px;font-weight:600;cursor:pointer;transition:all .2s;box-shadow:0 2px 8px rgba(60,140,255,.3);font-family:"Microsoft YaHei","Segoe UI",sans-serif}
.btn:hover{background:linear-gradient(135deg,#5ba0ff 0%,#3b7dff 100%);box-shadow:0 4px 16px rgba(60,140,255,.5);transform:translateY(-1px)}
.btn:active{transform:translateY(0)}
.close-x{position:absolute;top:10px;right:12px;width:24px;height:24px;border:none;background:rgba(255,255,255,.1);border-radius:6px;color:#aaa;font-size:16px;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all .15s;z-index:10;line-height:1}
.close-x:hover{background:rgba(255,80,80,.6);color:#fff}
.dot{position:absolute;top:12px;right:44px;width:10px;height:10px;border-radius:50%;background:#ff4d4d;animation:blink .5s ease-in-out infinite alternate;box-shadow:0 0 8px rgba(255,77,77,.6)}
@keyframes blink{from{opacity:1}to{opacity:.3}}
</style>
</head>
<body>
<div class="card" id="card">
  <button class="close-x" id="x" title="Close">&times;</button>
  <div class="dot"></div>
  <div class="hdr">
    <svg class="bell" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M12 2C10.343 2 9 3.343 9 5V5.28C6.607 6.248 5 8.618 5 11.5V16L3 18V19H21V18L19 16V11.5C19 8.618 17.393 6.248 15 5.28V5C15 3.343 13.657 2 12 2Z" fill="#ffd666"/>
      <path d="M10 20C10 21.1046 10.8954 22 12 22C13.1046 22 14 21.1046 14 20H10Z" fill="#ffd666"/>
    </svg>
    <span class="ttl" id="t">Notification</span>
  </div>
  <div class="body"><p class="msg" id="m">...</p></div>
  <div class="ftr"><button class="btn" id="b">\u786e\u8ba4\u5173\u95ed</button></div>
</div>
<script>
let ac=null,iv=null,dis=false;
function go(){
  try{ac=new(window.AudioContext||window.webkitAudioContext)()}catch(e){return}
  function bip(){
    if(!ac||ac.state==='closed')return;
    try{
      let o=ac.createOscillator(),g=ac.createGain();
      o.connect(g);g.connect(ac.destination);
      o.type='square';o.frequency.value=1200;
      g.gain.setValueAtTime(.3,ac.currentTime);
      g.gain.exponentialRampToValueAtTime(.01,ac.currentTime+.12);
      o.start(ac.currentTime);o.stop(ac.currentTime+.12);
    }catch(e){}
  }
  bip();iv=setInterval(bip,600);
}
function stop(){
  if(iv){clearInterval(iv);iv=null}
  if(ac){let c=ac;ac=null;c.close().catch(()=>{})}
}
function dismiss(){
  if(dis)return;dis=true;stop();
  document.getElementById('card').classList.add('dismissing');
  setTimeout(function(){window.ccNotify.dismiss()},150);
}
window.ccNotify.onShowNotification(function(d){
  document.getElementById('t').textContent=d.title;
  document.getElementById('m').textContent=d.message;
  dis=false;go();
  // Tell main process the actual content height so window can resize
  setTimeout(function(){
    var h=document.querySelector('.card').offsetHeight+20;
    window.ccNotify.reportHeight(h);
  },50);
});
document.getElementById('b').addEventListener('click',dismiss);
document.getElementById('x').addEventListener('click',dismiss);
</script>
</body>
</html>`;

// ─── Create notification window ───
function createNotificationWindow(title, message) {
  if (notifyWindow && !notifyWindow.isDestroyed()) {
    notifyWindow.destroy();
  }

  const display = screen.getPrimaryDisplay();
  const workArea = display.workArea;
  const W = 420;
  const initH = 280; // Start taller to avoid clipping
  const M = 20;

  // Position: bottom-right of work area (work area already excludes taskbar)
  notifyWindow = new BrowserWindow({
    width: W,
    height: initH,
    x: workArea.x + workArea.width - W - M,
    y: workArea.y + workArea.height - initH - M,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: false,
    focusable: true,
    show: false,
    icon: path.join(__dirname, 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  pendingNotification = { title, message };

  notifyWindow.loadURL('http://127.0.0.1:' + PORT + '/ui');

  notifyWindow.webContents.once('did-finish-load', () => {
    if (pendingNotification) {
      notifyWindow.webContents.send('show-notification', pendingNotification);
      pendingNotification = null;
    }
    notifyWindow.show();
    notifyWindow.setAlwaysOnTop(true, 'screen-saver');
  });

  notifyWindow.on('closed', () => { notifyWindow = null; });
}

// ─── IPC ───
ipcMain.on('dismiss', () => {
  if (notifyWindow && !notifyWindow.isDestroyed()) notifyWindow.destroy();
});

// Auto-resize window based on content height
ipcMain.on('report-height', (_event, contentHeight) => {
  if (!notifyWindow || notifyWindow.isDestroyed()) return;
  const display = screen.getPrimaryDisplay();
  const workArea = display.workArea;
  const W = 420;
  const M = 20;
  const H = Math.min(Math.max(contentHeight, 160), 500);

  notifyWindow.setBounds({
    x: workArea.x + workArea.width - W - M,
    y: workArea.y + workArea.height - H - M,
    width: W,
    height: H,
  });
});

// ─── HTTP server ───
function startHttpServer() {
  httpServer = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    const p = new URL(req.url, 'http://127.0.0.1').pathname;

    if (req.method === 'GET' && p === '/ui') {
      const buf = Buffer.from(NOTIFY_HTML, 'utf-8');
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': buf.length,
      });
      res.end(buf);
      return;
    }

    if (req.method === 'GET' && p === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ status: 'ok', service: 'cc-notify' }));
      return;
    }

    if (req.method === 'POST' && p === '/notify') {
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => {
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
          createNotificationWindow(data.title || 'Agent Notification', data.message || 'Task completed.');
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ success: true }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ success: false, error: e.message }));
        }
      });
      return;
    }

    if (req.method === 'POST' && p === '/dismiss') {
      if (notifyWindow && !notifyWindow.isDestroyed()) notifyWindow.destroy();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: true }));
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  });

  httpServer.listen(PORT, '127.0.0.1', () => {
    console.log('[cc-notify] Ready on http://127.0.0.1:' + PORT);
  });

  httpServer.on('error', err => {
    console.error('[cc-notify] Port error:', err.code);
  });
}

// ─── App lifecycle ───
app.whenReady().then(() => {
  startHttpServer();
  const args = process.argv;
  const idx = args.indexOf('--notify');
  if (idx !== -1) {
    createNotificationWindow(args[idx+1] || 'Notification', args[idx+2] || 'Done');
  } else {
    console.log('[cc-notify] Server mode.');
  }
});

app.on('window-all-closed', () => {});
app.on('before-quit', () => { if (httpServer) httpServer.close(); });
