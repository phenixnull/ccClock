---
name: cc-notify
description: Use this skill to send immediate desktop alerts or manage scheduled reminders through the local `ccClock` notifier. Triggers on requests like "notify me when it's done", "remind me at 3pm", "beep after this finishes", or equivalent Chinese requests for reminding, alerting, listing reminders, or deleting reminders. Do not use for app-development notification features, browser push notifications, or generic OS notification API design.
---

# CC Notify

Use this skill to send immediate desktop alerts or manage scheduled reminders through the local `ccClock` notifier (an Electron app in this repository).

## Setup

1. Clone this repository and install dependencies once:

   ```powershell
   git clone https://github.com/phenixnull/ccClock.git
   cd ccClock
   npm ci
   ```

2. Register the skill with Codex by copying (or symlinking) the `skill/` folder into your Codex skills directory as `cc-notify`:

   ```powershell
   Copy-Item -Recurse <repo>\skill <codex-skills-dir>\cc-notify
   ```

   The bundled `scripts/send_cc_notify_safe.js` resolves the notifier project directory in this order:
   1. `--project-dir <path>` argument
   2. `CC_NOTIFY_PROJECT_DIR` environment variable
   3. Default: the repository root two levels above the script (`<repo>/skill/scripts/..`), so it works out of the box when the skill folder stays inside the cloned repo

   If you copy the skill elsewhere, either keep the repo path via `CC_NOTIFY_PROJECT_DIR` or pass `--project-dir` each time.

## Tooling

- Use the bundled safe sender script for all notifier interactions.
- For Chinese/non-ASCII notifications, prefer the safe sender script instead of hand-writing JSON in an inline shell command:

```powershell
node <skill-dir>/scripts/send_cc_notify_safe.js --title-u "MSVD MC-value \u5b9e\u9a8c\u5b8c\u6210" --message-u "CIDEr 121.58\uff0c\u4f4e\u4e8e rank0 122.34\u3002"
```

- The `--title-u` and `--message-u` arguments must be ASCII-only strings containing `\uXXXX` escapes for Chinese text. Do not pass raw Chinese text to this helper through PowerShell.
- When the payload contains Chinese or other text that may be mangled by shell encoding, the safe sender writes a UTF-8 JSON file first, then passes `--file` to the notifier.
- JSON payload files must be written as UTF-8 without BOM. On Windows, `Set-Content -Encoding utf8` and `Out-File -Encoding utf8` may add a BOM and cause `send-notify.js` to fail with `Invalid JSON`.
- When generating a temporary **PowerShell script** that will later write or send notifications, do **not** embed raw Chinese literals directly in the script body. The script source itself can be mojibake before it ever writes the JSON payload.
- For dynamic watcher/wrapper scripts, keep the script body ASCII-only and use `\uXXXX` escapes inside JSON strings, or generate the payload through the bundled safe sender instead of inline Chinese PowerShell strings.
- Notifier script: `<project-dir>/send-notify.js`
- Preferred temp file: `<project-dir>/.cc-notify-payload.json`
- If `send-notify.js` reports that Electron is missing, run `npm ci` in the project directory.

## Instant notification

1. If the notification contains Chinese/non-ASCII text, use the safe sender script with `--title-u` and `--message-u`.
2. Otherwise, write a JSON payload file with `title` and `message`.
3. Run:

```powershell
node <project-dir>/send-notify.js --file <project-dir>/.cc-notify-payload.json
```

Recommended BOM-free write in PowerShell:

```powershell
$payload = '{"title":"Task Done","message":"Your build completed successfully."}'
[System.IO.File]::WriteAllText(
  "<project-dir>/.cc-notify-payload.json",
  $payload,
  [System.Text.UTF8Encoding]::new($false)
)
```

Example payload:

```json
{"title":"Task Done","message":"Your build completed successfully."}
```

## Silent notification

Pass `"silent": true` in the JSON payload (or `POST /notify` body) to show the card without beeping:

```json
{"title":"FYI","message":"Background sync finished.","silent":true}
```

The safe sender does not expose `--silent`; add the field by writing the payload file yourself or by calling the HTTP API directly.

## Scheduled reminder

Before adding a reminder, list existing schedules first:

```powershell
node <project-dir>/send-notify.js --list
```

Scheduling is additive. Never overwrite or delete an existing reminder just because the new one has the same time.

Payload requirements:

- Include `title`, `message`, and `triggerAt`
- `triggerAt` must be local China time in ISO 8601 form like `2026-04-18T15:00:00`

Safe sender example:

```powershell
node <skill-dir>/scripts/send_cc_notify_safe.js --title-u "\u4f1a\u8bae\u63d0\u9192" --message-u "\u4e94\u5206\u949f\u540e\u5f00\u4f1a" --schedule --trigger-at "2026-04-18T15:00:00"
```

Equivalent raw notifier call:

```powershell
node <project-dir>/send-notify.js --schedule --file <project-dir>/.cc-notify-payload.json
```

Example payload:

```json
{"title":"Meeting Reminder","message":"Team standup in 5 minutes","triggerAt":"2026-04-18T15:00:00"}
```

## Recurring reminder

Payload requirements:

- Include `title`, `message`, and `intervalMinutes`
- `intervalMinutes` must be a positive integer
- Optional `startAt` and `endAt` use local China time in ISO 8601 form
- If omitted, `startAt` defaults to now and `endAt` defaults to `23:59:59` on the start date

Safe sender example:

```powershell
node <skill-dir>/scripts/send_cc_notify_safe.js --title-u "\u559d\u6c34\u63d0\u9192" --message-u "\u8d77\u8eab\u559d\u6c34" --repeat --interval-minutes 30 --start-at "2026-04-18T09:00:00" --end-at "2026-04-18T18:00:00"
```

## Time interpretation

- Treat a bare hour as the nearest upcoming occurrence within 24 hours.
- Respect explicit qualifiers like morning, afternoon, evening, `AM`, or `PM`, including their Chinese equivalents.
- Relative phrases like "in 5 minutes", including Chinese equivalents, should be converted from the current local time.
- Always report back with the resolved absolute local datetime when the user could be ambiguous.

## List reminders

```powershell
node <project-dir>/send-notify.js --list
```

Present results clearly with id, title, message, and trigger time. Add `--json` for machine-readable output.

## Delete reminders

```powershell
node <project-dir>/send-notify.js --delete <id>
```

Deletion flow:

1. Always list reminders first.
2. If exactly one clear match exists, confirm intent from context and delete it.
3. If multiple reminders could match, stop and ask the user which one to delete.
4. If nothing matches, tell the user and show the current list.

## Service behavior

- Each card has a Settings button: Current card sound can stop or resume its buzzer without dismissing it.
- New notification default sound is saved locally in `settings.json` and applies to future instant and scheduled reminders across service restarts.
- The notifier keeps beeping until the user dismisses it or turns off its sound (unless `silent: true` or the saved default is muted).
- Up to seven notifications stack in the foreground, oldest at the bottom. Later notifications wait in FIFO order without beeping and fill vacancies when a foreground card is dismissed.
- Unacknowledged foreground and queued notifications persist across service restarts in `<project-dir>/notifications.json`.
- `send-notify.js` auto-launches the Electron service if needed (health check on `127.0.0.1:17329`).
- Scheduled reminders persist across restarts in `<project-dir>/schedules.json`.

## Implementation notes for Codex

- Prefer PowerShell here because this machine runs Codex in Windows PowerShell.
- Never embed raw Chinese text inside a PowerShell here-string that feeds `python -`, `node -e`, JSON, or another generated script. This exact pattern can silently turn Chinese into `????` before the target program receives it.
- For completion notifications with Chinese text, the default command should be the safe sender with `\uXXXX` escapes.
- The safe sender prints the payload readback before dispatch and refuses payloads containing `????` or the Unicode replacement character.
- If you need to write the payload file yourself, use a BOM-free approach such as the bundled safe sender or `[System.IO.File]::WriteAllText(..., [System.Text.UTF8Encoding]::new($false))`.
- Do not use `Set-Content -Encoding utf8` or `Out-File -Encoding utf8` for notifier JSON on this machine unless you have explicitly verified they produce UTF-8 without BOM.
- The same rule applies to **inline `python -`, `node -e`, here-string, or heredoc commands launched from PowerShell**: even if the target runtime writes the final file, raw Chinese literals inside the inline script body may already be converted to `?` before the runtime receives them. Prefer ASCII-only script bodies and express non-ASCII payload text via explicit `\uXXXX` escapes.
- Notification copy hygiene:
  - Do not send placeholder-like text such as `????`, `TBD`, mixed debug fragments, or half-translated notes inside the visible notification.
  - Keep the final notification title/message short, direct, and cleanly formatted.
  - Before dispatch, read back the payload file and confirm the exact user-facing text is acceptable as-is.
- If the user asks for a reminder at a future time and there is any ambiguity, clarify with an absolute date and time in Asia/Shanghai before scheduling.
