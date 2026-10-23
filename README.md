# ccClock / cc-notify

`ccClock` 是给本机 Agent 用的 Windows 桌面通知器。它会弹出 Electron 通知窗口，并持续蜂鸣，直到用户手动关闭；同时支持一次性提醒和周期提醒。

## 卡片声音设置

每张通知卡片右上角都有齿轮「设置」按钮：

- **当前卡片声音**：关闭后立即停止这张卡片的蜂鸣，卡片仍保留；重新开启会恢复蜂鸣。其他卡片的声音不受影响。
- **新通知默认声音**：控制之后弹出的即时通知、一次性提醒和周期提醒，自动保存到本机 `settings.json`，重启服务后仍然生效。修改默认值不会改变已显示卡片的声音。

没有保存过设置时，默认开启声音。请求中的 `"silent": true` 会让该张卡片以静音状态打开，即使默认声音开启，也可以在卡片设置中手动打开。

## 前台卡片与后台排队

前台数量由**主屏幕可用空间和每张卡片的实际高度**决定，不设固定张数。计算会留出屏幕边距和卡片间距，避开任务栏；长消息会在卡片内部滚动。最早收到的在最下面，较新的依次向上排列。

下一张卡片放不下时，新通知按收到的顺序进入后台等待，不会挤掉已有卡片，也不会在后台播放蜂鸣。用户确认关闭一张后，上方卡片依次向下移动，后台从最早等待的一张开始补到最上面，直到剩余空间放不下下一张。较小的后续通知也不会插队。

设置展开或收起、屏幕分辨率或缩放变化、任务栏改变可用空间时，都会重新计算。已有卡片因空间缩小而放不下时，较新的卡片暂时返回队列并停止蜂鸣，排在原有后台通知之前；空间恢复后按原顺序继续显示。

即时通知、定时提醒和周期提醒共用这条队列。所有未确认通知先写入本机 **`notifications.sqlite` 文件队列**，重启服务后会继续按原顺序显示和排队。

后台积压不会全部加载到内存：内存只保留当前显示的卡片和最多一条用于测量的队首通知。卡片因屏幕空间变化退回后台时，会销毁对应窗口，声音开关和设置面板状态随通知保存；有空位时再从文件读取并创建。SQLite 页面缓存目标为 2 MiB，单次请求最多 1 MiB，通知列表按页读取。

旧版 `notifications.json` 会在首次启动时逐条迁入数据库，迁移完成后记录标记，避免重启时重复导入已确认通知。原 JSON 文件保留为迁移前备份，之后不再更新。积压仍会占用磁盘空间；确认关闭后删除对应记录，数据库内释放的空间可供后续通知复用。

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

提醒数据保存在 `schedules.json`，未确认通知保存在 `notifications.sqlite`，默认声音设置保存在 `settings.json`。SQLite 运行时可能生成同名的 `-wal`、`-shm` 文件，运行期间请保留它们；移动数据库备份前应先正常退出服务。本地 Codex skill 会把临时 payload 写到 `.cc-notify-payload.json`；这些运行时文件都会被 Git 忽略。

## HTTP API

服务监听 `127.0.0.1:17329`。

- `GET /health`
- `GET /notifications`
- `POST /notify`
- `POST /schedule`
- `POST /schedule/recurring`
- `GET /schedules`
- `POST /schedule/delete`
- `POST /dismiss`

`GET /health` 中，`capacityMode` 为 `screen-space`，`queueStorage` 为 `sqlite`，`residentNotifications` 为当前在内存中的通知条数（前台数量加最多一条队首）。`workArea` 是主屏幕可用区域，`availableHeight` 是扣除边距后的可用高度，`usedHeight` 是前台卡片和间距占用的高度。`windows` 是前台卡片数，`queuedNotifications` 是后台等待数，`notifications` 是全部未确认通知数；`pending` 和 `completed` 仍表示定时提醒任务数。

`GET /notifications?limit=100&cursor=0` 返回前台 `active` 列表和当前页的后台 `queued` 列表。`queuedTotal` 是后台总数，`nextCursor` 非空时可作为下一页的 `cursor`。每页最多 100 条，后台内容目标上限为 1 MiB（至少返回一条通知）；不再一次返回全部积压通知。游标基于通知的 `sequence`，关闭前面的卡片不会导致后续分页跳项。

`POST /notify` 返回通知 `id` 和响应时是否在后台等待的 `queued`；只有成功写入磁盘后才返回成功。`POST /dismiss` 会清空前台和后台通知。

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

## 注册为 Codex Skill

本仓库自带完整的 Codex 技能包，位于 [`skill/`](skill/) 目录：

| 文件 | 作用 |
|---|---|
| `skill/SKILL.md` | 技能说明与触发规则（即时通知、定时/周期提醒、编码防乱码规范） |
| `skill/scripts/send_cc_notify_safe.js` | Node 安全发送器：`\uXXXX` 转义解码 → ASCII JSON 落盘 → 回读校验 → 调用 `send-notify.js` |
| `skill/scripts/send_cc_notify_safe.py` | 等价的 Python 版安全发送器 |

安装步骤：

```powershell
git clone https://github.com/phenixnull/ccClock.git
cd ccClock
npm ci
Copy-Item -Recurse .\skill <你的Codex技能目录>\cc-notify
```

项目目录解析优先级：

1. `--project-dir <path>` 参数
2. `CC_NOTIFY_PROJECT_DIR` 环境变量
3. 默认：脚本位置上两级的仓库根目录（skill 目录留在克隆仓库内时开箱即用）

安装后 Codex 会在你说"完成后通知我"、"3 点提醒我"这类话时自动调用本技能。

快速示例：

```powershell
# 中文即时通知（转义写法防 PowerShell 编码损坏）
node skill\scripts\send_cc_notify_safe.js --title-u "\u4efb\u52a1\u5b8c\u6210" --message-u "\u6784\u5efa\u6210\u529f"

# 一次性提醒
node skill\scripts\send_cc_notify_safe.js --title-u "\u4f1a\u8bae" --message-u "15:00 \u5f00\u59cb" --schedule --trigger-at "2026-09-30T15:00:00"

# 周期提醒（每 30 分钟）
node skill\scripts\send_cc_notify_safe.js --title-u "\u559d\u6c34" --message-u "\u8d77\u8eab\u559d\u6c34" --repeat --interval-minutes 30
```

## 许可证

[ISC](LICENSE)
