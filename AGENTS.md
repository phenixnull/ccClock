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
