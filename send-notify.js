#!/usr/bin/env node

/**
 * Send a notification to cc-notify service.
 * Auto-launches the Electron service if not running.
 *
 * Usage:
 *   node send-notify.js --file payload.json     (read JSON from file, UTF-8 safe)
 *   node send-notify.js --stdin                  (read JSON from stdin)
 *   node send-notify.js "Title" "Message"        (CLI args, ASCII only on Windows)
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PORT = 17329;
const PROJECT_DIR = __dirname;

// ─── Check if service is alive ───
function isAlive() {
  return new Promise((resolve) => {
    const req = http.request(
      { hostname: '127.0.0.1', port: PORT, path: '/health', method: 'GET', timeout: 2000 },
      (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(true)); }
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
}

// ─── Auto-launch Electron service ───
function launchService() {
  const electronExe = path.join(PROJECT_DIR, 'node_modules', 'electron', 'dist', 'electron.exe');
  if (!fs.existsSync(electronExe)) {
    console.error('Electron not found at: ' + electronExe);
    process.exit(1);
  }
  const child = spawn(electronExe, [PROJECT_DIR], {
    detached: true,
    stdio: 'ignore',
    cwd: PROJECT_DIR,
  });
  child.unref();
}

// ─── Wait for service to become ready ───
async function waitForService(maxWaitMs) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    if (await isAlive()) return true;
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

// ─── Ensure service is running (auto-launch if needed) ───
async function ensureService() {
  if (await isAlive()) return true;
  console.error('[cc-notify] Service not running, launching...');
  launchService();
  const ok = await waitForService(8000);
  if (ok) {
    console.error('[cc-notify] Service started.');
  } else {
    console.error('[cc-notify] Failed to start service.');
  }
  return ok;
}

// ─── Send notification ───
function send(jsonStr) {
  const buf = Buffer.from(jsonStr, 'utf-8');
  const req = http.request(
    {
      hostname: '127.0.0.1',
      port: PORT,
      path: '/notify',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': buf.length,
      },
      timeout: 5000,
    },
    (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.success) {
            console.log('OK');
          } else {
            console.error('FAIL:', parsed.error || data);
            process.exit(1);
          }
        } catch {
          console.log(data);
        }
      });
    }
  );
  req.on('error', (err) => {
    console.error('Cannot connect:', err.message);
    process.exit(1);
  });
  req.write(buf);
  req.end();
}

// ─── Main ───
async function main() {
  const args = process.argv.slice(2);

  // Parse payload first
  let jsonStr;
  if (args[0] === '--file' && args[1]) {
    jsonStr = fs.readFileSync(args[1], 'utf-8');
  } else if (args[0] === '--stdin') {
    jsonStr = await new Promise((resolve) => {
      let input = '';
      process.stdin.setEncoding('utf-8');
      process.stdin.on('data', (c) => (input += c));
      process.stdin.on('end', () => resolve(input));
    });
  } else if (args.length > 0) {
    let title, message;
    if (args.length === 1) {
      title = 'Agent Notification';
      message = args[0];
    } else {
      title = args[0];
      message = args.slice(1).join(' ');
    }
    jsonStr = JSON.stringify({ title, message });
  } else {
    console.log('Usage:');
    console.log('  node send-notify.js --file payload.json');
    console.log('  node send-notify.js --stdin < payload.json');
    console.log('  node send-notify.js "Title" "Message"');
    process.exit(1);
  }

  // Ensure service is running (auto-launch if needed)
  const ok = await ensureService();
  if (!ok) {
    console.error('Service unavailable. Check electron installation.');
    process.exit(1);
  }

  // Send
  send(jsonStr);
}

main();
