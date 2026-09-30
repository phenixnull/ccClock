#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// Default: the ccClock repo root (two levels above this script).
// Override with CC_NOTIFY_PROJECT_DIR env var or --project-dir argument.
const DEFAULT_PROJECT_DIR = process.env.CC_NOTIFY_PROJECT_DIR
  || path.resolve(__dirname, '..', '..');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const current = argv[i];
    if (!current.startsWith('--')) {
      continue;
    }

    const key = current.slice(2);
    if (key === 'dry-run' || key === 'schedule' || key === 'repeat' || key === 'recurring') {
      args[key] = true;
      continue;
    }

    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      args[key] = '';
      continue;
    }

    args[key] = next;
    i += 1;
  }
  return args;
}

function decodeUnicodeEscapes(value) {
  return String(value || '')
    .replace(/\\u\{([0-9a-fA-F]+)\}/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\r/g, '\r')
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t');
}

function hasBadPlaceholder(text) {
  return String(text).includes('????') || String(text).includes('\uFFFD');
}

function asciiJson(value) {
  return JSON.stringify(value).replace(/[^\x20-\x7E]/g, (char) => {
    const code = char.charCodeAt(0);
    return `\\u${code.toString(16).padStart(4, '0')}`;
  });
}

function fail(message, code = 2) {
  console.error(`[ERROR] ${message}`);
  process.exit(code);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const isRepeat = Boolean(args.repeat || args.recurring);

  const title = args['title-u'] ? decodeUnicodeEscapes(args['title-u']) : (args.title || '');
  const message = args['message-u'] ? decodeUnicodeEscapes(args['message-u']) : (args.message || '');

  if (!title.trim() || !message.trim()) {
    fail('title and message are required');
  }
  if (args.schedule && isRepeat) {
    fail('use either --schedule or --repeat, not both');
  }
  if (hasBadPlaceholder(title) || hasBadPlaceholder(message)) {
    console.error(JSON.stringify({ title, message }));
    fail('notification text contains mojibake placeholder', 3);
  }

  const payload = { title, message };
  if (args.schedule) {
    if (!String(args['trigger-at'] || '').trim()) {
      fail('--trigger-at is required with --schedule');
    }
    payload.triggerAt = args['trigger-at'];
  } else if (isRepeat) {
    const intervalMinutes = Number(args['interval-minutes']);
    if (!Number.isInteger(intervalMinutes) || intervalMinutes <= 0) {
      fail('--interval-minutes must be a positive integer with --repeat');
    }
    payload.intervalMinutes = intervalMinutes;
    if (String(args['start-at'] || '').trim()) payload.startAt = args['start-at'];
    if (String(args['end-at'] || '').trim()) payload.endAt = args['end-at'];
  }

  const projectDir = args['project-dir'] || DEFAULT_PROJECT_DIR;
  const payloadPath = args['payload-path'] || path.join(projectDir, '.cc-notify-payload.json');
  const notifierPath = args['notifier-path'] || path.join(projectDir, 'send-notify.js');

  if (!fs.existsSync(notifierPath)) {
    fail(`notifier script not found: ${notifierPath}`, 5);
  }

  fs.mkdirSync(path.dirname(payloadPath), { recursive: true });
  fs.writeFileSync(payloadPath, asciiJson(payload), { encoding: 'utf8' });

  const readback = JSON.parse(fs.readFileSync(payloadPath, 'utf8'));
  if (
    JSON.stringify(readback) !== JSON.stringify(payload)
    || hasBadPlaceholder(readback.title)
    || hasBadPlaceholder(readback.message)
  ) {
    console.error(fs.readFileSync(payloadPath, 'utf8'));
    fail('payload readback failed notification hygiene check', 4);
  }

  console.log(JSON.stringify(readback));
  if (args['dry-run']) {
    return;
  }

  const commandArgs = [notifierPath];
  if (args.schedule) {
    commandArgs.push('--schedule');
  } else if (isRepeat) {
    commandArgs.push('--repeat');
  }
  commandArgs.push('--file', payloadPath);

  const result = spawnSync('node', commandArgs, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exit(result.status === null ? 1 : result.status);
}

main();
