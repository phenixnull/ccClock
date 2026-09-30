# ccClock / cc-notify

`ccClock` 是给本机 Agent 用的 Windows 桌面通知器。它会弹出 Electron 通知窗口，并持续蜂鸣，直到用户手动关闭；同时支持一次性提醒和周期提醒。

## 安装

在本项目目录运行：

```powershell
npm ci
```

如果想手动常驻启动服务：

```powershell
npm start
```

也可以直接调用 `send-notify.js`。它会检查 `http://127.0.0.1:17329/health`，服务没启动时会自动拉起 Electron。

## 立即通知

把 payload 保存为 `.cc-notify-payload.json`：

```json
{"title":"Task Done","message":"Build completed successfully."}
```

发送通知：

```powershell
node .\send-notify.js --file .\.cc-notify-payload.json
```

纯 ASCII 文本也可以直接用位置参数：

```powershell
node .\send-notify.js "Task Done" "Build completed successfully."
```

Windows 上发送中文或其他非 ASCII 文本时，优先写入无 BOM 的 UTF-8 JSON 文件，再通过 `--file` 传入。

## 一次性定时提醒

时间使用本地时间的 ISO 8601 格式：

```json
{"title":"Meeting Reminder","message":"Team standup in 5 minutes","triggerAt":"2026-06-28T15:00:00"}
```

添加提醒：

```powershell
node .\send-notify.js --schedule --file .\reminder.json
```

## 周期提醒

`intervalMinutes` 必填。`startAt` 省略时默认为当前时间，`endAt` 省略时默认为开始日期当天的 `23:59:59`。

```json
{"title":"Hydrate","message":"Drink water","intervalMinutes":30,"startAt":"2026-06-28T09:00:00","endAt":"2026-06-28T18:00:00"}
```

添加周期提醒：

```powershell
node .\send-notify.js --repeat --file .\repeat.json
```

## 管理提醒

列出提醒：

```powershell
node .\send-notify.js --list
node .\send-notify.js --list --json
```

删除提醒：

```powershell
node .\send-notify.js --delete <id>
```

提醒数据保存在 `schedules.json`。本地 Codex skill 会把临时 payload 写到 `.cc-notify-payload.json`；这两个运行时文件都会被 Git 忽略。

## HTTP API

服务监听 `127.0.0.1:17329`。

- `GET /health`
- `POST /notify`
- `POST /schedule`
- `POST /schedule/recurring`
- `GET /schedules`
- `POST /schedule/delete`
- `POST /dismiss`

示例：

```powershell
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:17329/notify -ContentType "application/json; charset=utf-8" -Body '{"title":"Task Done","message":"Build completed successfully."}'
```

## MCP Server

MCP 入口是 `mcp-server.js`。

```json
{
  "mcpServers": {
    "cc-notify": {
      "command": "node",
      "args": [
        "D:/Users/hd/Desktop/2026-CommercialOrder/OnGoingOrders/ccClock/mcp-server.js"
      ]
    }
  }
}
```

MCP 工具包括 `notify`、`schedule_reminder`、`schedule_recurring_reminder`、`list_schedules` 和 `delete_schedule`。
