# CC-Notify — Agent 通知工具

## 概述
一个桌面通知工具，Agent 可以调用它来：
1. 🔔 在屏幕右下角弹出通知窗口（Agent 自定义文本）
2. 📢 播放持续的蜂鸣器"滴滴滴"响声
3. 🔒 通知和蜂鸣持续到用户手动点击「确认关闭」才停止

## 架构

```
main.js          — Electron 主进程，创建通知窗口 + HTTP 服务器 (port 17329)
preload.js       — 安全的 IPC 桥接
notify.html      — 通知 UI + Web Audio API 蜂鸣器
mcp-server.js    — MCP 协议服务器 (stdio)，供 Claude Code 调用
send-notify.js   — 命令行快捷发送脚本
```

## 调用方式

### 方式 1: HTTP API（推荐 Agent 使用）
```bash
# 先启动服务: npm start（或 electron .）
# 然后发送通知:
curl -X POST http://127.0.0.1:17329/notify \
  -H "Content-Type: application/json" \
  -d '{"title":"任务完成","message":"所有 42 个测试通过 ✓"}'
```

### 方式 2: MCP 协议
在 Claude Code 设置中添加 MCP server 配置后，Agent 可直接调用 `notify` 工具。

### 方式 3: 命令行
```bash
node send-notify.js "标题" "消息内容"
```

## 端口
HTTP 服务固定监听 `127.0.0.1:17329`

## 周期提醒

除了原有的单次提醒 `POST /schedule`，现在也支持指定日期时间范围内的周期提醒：

```bash
curl -X POST http://127.0.0.1:17329/schedule/recurring \
  -H "Content-Type: application/json" \
  -d '{"title":"喝水提醒","message":"喝点水，活动一下","startAt":"2026-05-02T00:00:00","endAt":"2026-05-02T23:59:00","intervalMinutes":30}'
```

命令行方式：

```bash
node send-notify.js --repeat --file repeat.json
```

MCP 工具名：`schedule_recurring_reminder`。

## 任务队列

提醒任务按两个列表保存：

- `pending`：未完成通知。单次和周期提醒新建后都进入这里。
- `completed`：已完成通知。单次提醒触发后进入这里；周期提醒必须在指定时间范围内所有提醒点都触发完成后，才进入这里。

列表接口：

```bash
curl http://127.0.0.1:17329/schedules
node send-notify.js --list
```
