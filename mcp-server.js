#!/usr/bin/env node

/**
 * cc-notify MCP Server
 *
 * This is a Model Context Protocol (MCP) server that exposes a "notify" tool.
 * Agents (like Claude Code) can call this tool to:
 *   1. Show a desktop notification popup in the bottom-right corner
 *   2. Play a continuous beeping alarm sound
 *   3. Both persist until the user manually dismisses
 *
 * The MCP server communicates with the Electron app via HTTP (localhost:17329).
 *
 * ─── Setup in Claude Code ───
 * Add to your .claude/settings.json or ~/.claude/settings.json:
 * {
 *   "mcpServers": {
 *     "cc-notify": {
 *       "command": "node",
 *       "args": ["<path-to>/mcp-server.js"]
 *     }
 *   }
 * }
 */

const http = require('http');
const { spawn } = require('child_process');
const path = require('path');

// ─── Config ───
const ELECTRON_HTTP_PORT = 17329;
const ELECTRON_HTTP_HOST = '127.0.0.1';

// ─── Helpers ───
function httpPost(path, data) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(data);
    const req = http.request(
      {
        hostname: ELECTRON_HTTP_HOST,
        port: ELECTRON_HTTP_PORT,
        path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: 5000,
      },
      (res) => {
        let responseBody = '';
        res.on('data', (chunk) => (responseBody += chunk));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, data: JSON.parse(responseBody) });
          } catch {
            resolve({ status: res.statusCode, data: responseBody });
          }
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timed out'));
    });
    req.write(body);
    req.end();
  });
}

function httpGet(urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: ELECTRON_HTTP_HOST,
        port: ELECTRON_HTTP_PORT,
        path: urlPath,
        method: 'GET',
        timeout: 3000,
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, data: JSON.parse(body) });
          } catch {
            resolve({ status: res.statusCode, data: body });
          }
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('timeout'));
    });
    req.end();
  });
}

async function isElectronRunning() {
  try {
    const res = await httpGet('/health');
    return res.status === 200;
  } catch {
    return false;
  }
}

async function launchElectronApp() {
  const electronPath = require.resolve('electron/cli.js', {
    paths: [path.join(__dirname, 'node_modules')],
  });

  const child = spawn(process.execPath, [electronPath, __dirname], {
    detached: true,
    stdio: 'ignore',
    cwd: __dirname,
  });
  child.unref();

  // Wait for it to start
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (await isElectronRunning()) return true;
  }
  return false;
}

async function ensureElectronRunning() {
  if (await isElectronRunning()) return true;

  // Try to launch
  stderr(`[cc-notify] Electron app not running. Launching...`);
  const launched = await launchElectronApp();
  if (!launched) {
    stderr(`[cc-notify] Failed to launch Electron app.`);
    return false;
  }
  stderr(`[cc-notify] Electron app started successfully.`);
  return true;
}

// ─── MCP Protocol (JSON-RPC over stdio) ───

function stderr(msg) {
  process.stderr.write(msg + '\n');
}

function sendResponse(id, result) {
  const response = { jsonrpc: '2.0', id, result };
  const json = JSON.stringify(response);
  const header = `Content-Length: ${Buffer.byteLength(json)}\r\n\r\n`;
  process.stdout.write(header + json);
}

function sendError(id, code, message) {
  const response = { jsonrpc: '2.0', id, error: { code, message } };
  const json = JSON.stringify(response);
  const header = `Content-Length: ${Buffer.byteLength(json)}\r\n\r\n`;
  process.stdout.write(header + json);
}

function sendNotification(method, params) {
  const notification = { jsonrpc: '2.0', method, params };
  const json = JSON.stringify(notification);
  const header = `Content-Length: ${Buffer.byteLength(json)}\r\n\r\n`;
  process.stdout.write(header + json);
}

// Tool definitions
const TOOLS = [
  {
    name: 'notify',
    description: 'Display an instant desktop notification popup with beeping alarm. Persists until user dismisses.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Notification title. Default: "Agent Notification"' },
        message: { type: 'string', description: 'Notification body text (multi-line OK).' },
      },
      required: ['message'],
    },
  },
  {
    name: 'schedule_reminder',
    description: 'Schedule a future reminder that will pop up at the specified time with beeping alarm. Use ISO 8601 local time for triggerAt.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Reminder title.' },
        message: { type: 'string', description: 'Reminder body text.' },
        triggerAt: { type: 'string', description: 'ISO 8601 datetime in local time, e.g. "2026-04-18T15:00:00"' },
      },
      required: ['message', 'triggerAt'],
    },
  },
  {
    name: 'schedule_recurring_reminder',
    description: 'Schedule a recurring reminder. startAt and endAt are optional ISO 8601 local datetimes; omitted startAt defaults to now, omitted endAt defaults to 23:59:59 on the startAt date.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Reminder title.' },
        message: { type: 'string', description: 'Reminder body text.' },
        startAt: { type: 'string', description: 'Optional ISO 8601 local start datetime. Defaults to now when omitted.' },
        endAt: { type: 'string', description: 'Optional ISO 8601 local end datetime. Defaults to 23:59:59 on the startAt date when omitted.' },
        intervalMinutes: { type: 'integer', description: 'Repeat interval in minutes, e.g. 30.' },
      },
      required: ['message', 'intervalMinutes'],
    },
  },
  {
    name: 'list_schedules',
    description: 'List all scheduled reminders with their IDs, titles, messages, and trigger times.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'delete_schedule',
    description: 'Delete a scheduled reminder by ID. IMPORTANT: When user description is ambiguous, first use list_schedules to show options and confirm with user before deleting.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The schedule ID to delete.' },
      },
      required: ['id'],
    },
  },
];

async function handleToolCall(name, args) {
  const running = await ensureElectronRunning();
  if (!running) {
    return { content: [{ type: 'text', text: 'Failed to launch notification service. Run: cd ccClock && npm start' }], isError: true };
  }

  try {
    if (name === 'notify') {
      const res = await httpPost('/notify', { title: args.title || 'Agent Notification', message: args.message || '' });
      if (res.data && res.data.success) {
        return { content: [{ type: 'text', text: `Notification displayed. Title: ${args.title || 'Agent Notification'}` }] };
      }
      return { content: [{ type: 'text', text: `Failed: ${JSON.stringify(res.data)}` }], isError: true };
    }

    if (name === 'schedule_reminder') {
      const res = await httpPost('/schedule', { title: args.title || 'Scheduled Reminder', message: args.message || '', triggerAt: args.triggerAt });
      if (res.data && res.data.success) {
        return { content: [{ type: 'text', text: `Reminder scheduled. ID: ${res.data.id}, fires at: ${res.data.triggerAt}` }] };
      }
      return { content: [{ type: 'text', text: `Failed: ${JSON.stringify(res.data)}` }], isError: true };
    }

    if (name === 'schedule_recurring_reminder') {
      const res = await httpPost('/schedule/recurring', {
        title: args.title || 'Recurring Reminder',
        message: args.message || '',
        startAt: args.startAt,
        endAt: args.endAt,
        intervalMinutes: args.intervalMinutes,
      });
      if (res.data && res.data.success) {
        return {
          content: [{
            type: 'text',
            text: `Recurring reminder scheduled. ID: ${res.data.id}, every ${res.data.intervalMinutes} minute(s), range: ${res.data.startAt} to ${res.data.endAt}, next fires at: ${res.data.nextTriggerAt}`,
          }],
        };
      }
      return { content: [{ type: 'text', text: `Failed: ${JSON.stringify(res.data)}` }], isError: true };
    }

    if (name === 'list_schedules') {
      const res = await httpGet('/schedules');
      const pending = (res.data && res.data.pending) || [];
      const completed = (res.data && res.data.completed) || [];
      if (pending.length === 0 && completed.length === 0) {
        return { content: [{ type: 'text', text: 'No scheduled reminders.' }] };
      }

      const formatSchedule = (s) => {
        if (s.type === 'recurring') {
          return `[${s.id}] recurring "${s.title}" - every ${s.intervalMinutes}m, ${s.startAt} to ${s.endAt}, next ${s.nextTriggerAt} | ${s.message}`;
        }
        return `[${s.id}] single "${s.title}" - ${s.triggerAt} | ${s.message}`;
      };

      const pendingLines = pending.length > 0
        ? pending.map(formatSchedule).join('\n')
        : '(none)';
      const completedLines = completed.length > 0
        ? completed.map((s) => `${formatSchedule(s)} | completedAt: ${s.completedAt || 'unknown'}`).join('\n')
        : '(none)';
      return {
        content: [{
          type: 'text',
          text: `Pending reminders (${pending.length}):\n${pendingLines}\n\nCompleted reminders (${completed.length}):\n${completedLines}`,
        }],
      };
    }

    if (name === 'delete_schedule') {
      const res = await httpPost('/schedule/delete', { id: args.id });
      if (res.data && res.data.success) {
        return { content: [{ type: 'text', text: `Deleted schedule: ${args.id}` }] };
      }
      return { content: [{ type: 'text', text: `Failed: ${JSON.stringify(res.data)}` }], isError: true };
    }
  } catch (err) {
    return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
  }

  return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
}

// ─── MCP message handler ───
async function handleMessage(msg) {
  const { id, method, params } = msg;

  switch (method) {
    case 'initialize':
      sendResponse(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: {
          name: 'cc-notify',
          version: '1.0.0',
        },
      });
      break;

    case 'notifications/initialized':
      stderr('[cc-notify] MCP initialized successfully');
      break;

    case 'tools/list':
      sendResponse(id, { tools: TOOLS });
      break;

    case 'tools/call': {
      const { name, arguments: args } = params;
      stderr(`[cc-notify] Tool call: ${name}(${JSON.stringify(args)})`);
      const result = await handleToolCall(name, args || {});
      sendResponse(id, result);
      break;
    }

    case 'ping':
      sendResponse(id, {});
      break;

    default:
      if (id !== undefined) {
        sendError(id, -32601, `Method not found: ${method}`);
      }
      break;
  }
}

// ─── stdin parser (Content-Length framing) ───
let inputBuffer = Buffer.alloc(0);

process.stdin.on('data', (chunk) => {
  inputBuffer = Buffer.concat([inputBuffer, chunk]);
  processBuffer();
});

function processBuffer() {
  while (true) {
    const headerEnd = inputBuffer.indexOf('\r\n\r\n');
    if (headerEnd === -1) break;

    const header = inputBuffer.slice(0, headerEnd).toString();
    const match = header.match(/Content-Length:\s*(\d+)/i);
    if (!match) {
      stderr(`[cc-notify] Bad header: ${header}`);
      inputBuffer = inputBuffer.slice(headerEnd + 4);
      continue;
    }

    const contentLength = parseInt(match[1], 10);
    const totalLength = headerEnd + 4 + contentLength;

    if (inputBuffer.length < totalLength) break; // Wait for more data

    const content = inputBuffer.slice(headerEnd + 4, totalLength).toString();
    inputBuffer = inputBuffer.slice(totalLength);

    try {
      const msg = JSON.parse(content);
      handleMessage(msg).catch((err) => {
        stderr(`[cc-notify] Error handling message: ${err.message}`);
        if (msg.id !== undefined) {
          sendError(msg.id, -32603, err.message);
        }
      });
    } catch (err) {
      stderr(`[cc-notify] JSON parse error: ${err.message}`);
    }
  }
}

process.stdin.on('end', () => {
  stderr('[cc-notify] stdin closed, exiting');
  process.exit(0);
});

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

stderr('[cc-notify] MCP server started, waiting for messages...');
