#!/usr/bin/env node

/**
 * Send notifications / manage schedules for cc-notify service.
 *
 * Usage:
 *   node send-notify.js --file payload.json          (instant notification from JSON file)
 *   node send-notify.js --stdin                       (read JSON from stdin)
 *   node send-notify.js "Title" "Message"             (instant, ASCII only on Windows)
 *
 *   node send-notify.js --schedule --file sched.json  (schedule a future reminder)
 *   node send-notify.js --repeat --file repeat.json    (schedule a recurring reminder)
 *   node send-notify.js --list                        (list all scheduled reminders)
 *   node send-notify.js --delete <id>                 (delete a scheduled reminder)
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PORT = 17329;
const PROJECT_DIR = __dirname;

// ─── HTTP helpers ───
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

function launchService() {
  const electronExe = path.join(PROJECT_DIR, 'node_modules', 'electron', 'dist', 'electron.exe');
  if (!fs.existsSync(electronExe)) {
    console.error('Electron not found at: ' + electronExe);
    process.exit(1);
  }
  const child = spawn(electronExe, [PROJECT_DIR], {
    detached: true, stdio: 'ignore', cwd: PROJECT_DIR,
  });
  child.unref();
}

async function waitForService(maxWaitMs) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    if (await isAlive()) return true;
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}
async function ensureService() {
  if (await isAlive()) return true;
  console.error('[cc-notify] Service not running, launching...');
  launchService();
  const ok = await waitForService(8000);
  console.error(ok ? '[cc-notify] Service started.' : '[cc-notify] Failed to start service.');
  return ok;
}

function httpPost(urlPath, jsonStr) {
  return new Promise((resolve, reject) => {
    const buf = Buffer.from(jsonStr, 'utf-8');
    const req = http.request({
      hostname: '127.0.0.1', port: PORT, path: urlPath, method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': buf.length },
      timeout: 5000,
    }, (res) => {
      let data = ''; res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(data); } });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(buf); req.end();
  });
}

function httpGet(urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port: PORT, path: urlPath, method: 'GET', timeout: 5000,
    }, (res) => {
      let data = ''; res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(data); } });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

function describeSchedule(schedule) {
  const type = schedule.type === 'recurring' ? 'recurring' : 'single';
  const base = `[${schedule.id}] ${type} "${schedule.title}"`;
  if (type === 'recurring') {
    return `${base} every ${schedule.intervalMinutes}m, ${schedule.startAt} to ${schedule.endAt}, next ${schedule.nextTriggerAt} | ${schedule.message || ''}`;
  }
  return `${base} ${schedule.triggerAt} | ${schedule.message || ''}`;
}

function printScheduleList(result) {
  const pending = Array.isArray(result.pending) ? result.pending : (result.schedules || []);
  const completed = Array.isArray(result.completed) ? result.completed : [];

  console.log(`Pending reminders (${pending.length}):`);
  if (pending.length === 0) {
    console.log('  (none)');
  } else {
    pending.forEach((schedule) => console.log(`  ${describeSchedule(schedule)}`));
  }

  console.log('');
  console.log(`Completed reminders (${completed.length}):`);
  if (completed.length === 0) {
    console.log('  (none)');
  } else {
    completed.forEach((schedule) => {
      console.log(`  ${describeSchedule(schedule)} | completedAt: ${schedule.completedAt || 'unknown'}`);
    });
  }
}

// ─── Main ───
async function main() {
  const args = process.argv.slice(2);

  // --list: show all scheduled reminders
  if (args[0] === '--list') {
    if (!(await ensureService())) { console.error('Service unavailable.'); process.exit(1); }
    const result = await httpGet('/schedules');
    if (args.includes('--json')) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      printScheduleList(result);
    }
    return;
  }

  // --delete <id>: remove a scheduled reminder
  if (args[0] === '--delete' && args[1]) {
    if (!(await ensureService())) { console.error('Service unavailable.'); process.exit(1); }
    const result = await httpPost('/schedule/delete', JSON.stringify({ id: args[1] }));
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  // Parse payload from --file, --stdin, or positional args
  let jsonStr;
  const isSchedule = args.includes('--schedule');
  const isRepeat = args.includes('--repeat') || args.includes('--recurring');
  if (isSchedule && isRepeat) {
    console.error('Use either --schedule or --repeat, not both.');
    process.exit(1);
  }
  const cleanArgs = args.filter(a => a !== '--schedule' && a !== '--repeat' && a !== '--recurring');

  if (cleanArgs[0] === '--file' && cleanArgs[1]) {
    jsonStr = fs.readFileSync(cleanArgs[1], 'utf-8');
  } else if (cleanArgs[0] === '--stdin') {
    jsonStr = await new Promise((resolve) => {
      let input = ''; process.stdin.setEncoding('utf-8');
      process.stdin.on('data', c => input += c);
      process.stdin.on('end', () => resolve(input));
    });
  } else if (cleanArgs.length > 0) {
    const title = cleanArgs.length === 1 ? 'Agent Notification' : cleanArgs[0];
    const message = cleanArgs.length === 1 ? cleanArgs[0] : cleanArgs.slice(1).join(' ');
    jsonStr = JSON.stringify({ title, message });
  } else {
    console.log('Usage:');
    console.log('  node send-notify.js --file payload.json');
    console.log('  node send-notify.js --schedule --file sched.json');
    console.log('  node send-notify.js --repeat --file repeat.json');
    console.log('  node send-notify.js --list');
    console.log('  node send-notify.js --list --json');
    console.log('  node send-notify.js --delete <id>');
    console.log('  node send-notify.js "Title" "Message"');
    console.log('');
    console.log('Recurring JSON: {"title":"Hydrate","message":"Drink water","startAt":"2026-05-02T00:00:00","endAt":"2026-05-02T23:59:00","intervalMinutes":30}');
    process.exit(1);
  }

  if (!(await ensureService())) { console.error('Service unavailable.'); process.exit(1); }

  const endpoint = isRepeat ? '/schedule/recurring' : (isSchedule ? '/schedule' : '/notify');
  const result = await httpPost(endpoint, jsonStr);
  console.log(JSON.stringify(result, null, 2));
}

main();
