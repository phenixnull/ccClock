#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Send ccClock notifications without shell-encoding mojibake.

For non-ASCII text, pass ASCII-only unicode escapes through --title-u/--message-u:

    python send_cc_notify_safe.py --title-u "MSVD \u5b8c\u6210" --message-u "CIDEr 123.45"

The script decodes those escapes locally, writes a BOM-free UTF-8 JSON payload,
verifies that common mojibake placeholders are absent, then calls send-notify.js.
"""

from __future__ import annotations

import argparse
import codecs
import json
import os
import subprocess
import sys
from pathlib import Path


# Default: the ccClock repo root (two levels above this script).
# Override with CC_NOTIFY_PROJECT_DIR env var or --project-dir argument.
DEFAULT_PROJECT_DIR = Path(
    os.environ.get("CC_NOTIFY_PROJECT_DIR")
    or Path(__file__).resolve().parents[2]
)
DEFAULT_PAYLOAD = DEFAULT_PROJECT_DIR / ".cc-notify-payload.json"
DEFAULT_NOTIFIER = DEFAULT_PROJECT_DIR / "send-notify.js"


def _decode_unicode_escapes(value: str) -> str:
    return codecs.decode(value, "unicode_escape")


def _has_bad_placeholder(text: str) -> bool:
    return "????" in text or "\ufffd" in text


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser()
    parser.add_argument("--title", default="")
    parser.add_argument("--message", default="")
    parser.add_argument("--title-u", default="", help="ASCII-only unicode-escaped title.")
    parser.add_argument("--message-u", default="", help="ASCII-only unicode-escaped message.")
    parser.add_argument("--project-dir", default=str(DEFAULT_PROJECT_DIR))
    parser.add_argument("--payload-path", default="")
    parser.add_argument("--notifier-path", default="")
    parser.add_argument("--schedule", action="store_true", help="Schedule a one-time reminder.")
    parser.add_argument("--repeat", "--recurring", action="store_true", help="Schedule a recurring reminder.")
    parser.add_argument("--trigger-at", default="", help="Local ISO datetime for --schedule.")
    parser.add_argument("--interval-minutes", type=int, default=0, help="Positive integer interval for --repeat.")
    parser.add_argument("--start-at", default="", help="Optional local ISO start datetime for --repeat.")
    parser.add_argument("--end-at", default="", help="Optional local ISO end datetime for --repeat.")
    parser.add_argument("--dry-run", action="store_true")
    return parser


def main() -> int:
    args = build_parser().parse_args()
    title = _decode_unicode_escapes(args.title_u) if args.title_u else args.title
    message = _decode_unicode_escapes(args.message_u) if args.message_u else args.message

    if not title.strip() or not message.strip():
        print("[ERROR] title and message are required", file=sys.stderr)
        return 2
    if args.schedule and args.repeat:
        print("[ERROR] use either --schedule or --repeat, not both", file=sys.stderr)
        return 2
    if _has_bad_placeholder(title) or _has_bad_placeholder(message):
        print("[ERROR] notification text contains mojibake placeholder", file=sys.stderr)
        print(json.dumps({"title": title, "message": message}, ensure_ascii=False), file=sys.stderr)
        return 3

    payload = {"title": title, "message": message}
    if args.schedule:
        if not args.trigger_at.strip():
            print("[ERROR] --trigger-at is required with --schedule", file=sys.stderr)
            return 2
        payload["triggerAt"] = args.trigger_at
    elif args.repeat:
        if args.interval_minutes <= 0:
            print("[ERROR] --interval-minutes must be positive with --repeat", file=sys.stderr)
            return 2
        payload["intervalMinutes"] = args.interval_minutes
        if args.start_at.strip():
            payload["startAt"] = args.start_at
        if args.end_at.strip():
            payload["endAt"] = args.end_at

    project_dir = Path(args.project_dir)
    payload_path = Path(args.payload_path) if args.payload_path else project_dir / ".cc-notify-payload.json"
    notifier_path = Path(args.notifier_path) if args.notifier_path else project_dir / "send-notify.js"
    if not notifier_path.exists():
        print(f"[ERROR] notifier script not found: {notifier_path}", file=sys.stderr)
        return 5

    payload_path.parent.mkdir(parents=True, exist_ok=True)
    payload_path.write_text(json.dumps(payload, ensure_ascii=True), encoding="utf-8")

    readback = json.loads(payload_path.read_text(encoding="utf-8"))
    if readback != payload or _has_bad_placeholder(readback["title"]) or _has_bad_placeholder(readback["message"]):
        print("[ERROR] payload readback failed notification hygiene check", file=sys.stderr)
        print(payload_path.read_text(encoding="utf-8"), file=sys.stderr)
        return 4

    print(json.dumps(readback, ensure_ascii=False))
    if args.dry_run:
        return 0

    command = ["node", str(notifier_path)]
    if args.schedule:
        command.append("--schedule")
    elif args.repeat:
        command.append("--repeat")
    command.extend(["--file", str(payload_path)])

    result = subprocess.run(
        command,
        check=False,
        text=True,
        capture_output=True,
    )
    if result.stdout:
        print(result.stdout, end="")
    if result.stderr:
        print(result.stderr, end="", file=sys.stderr)
    return int(result.returncode)


if __name__ == "__main__":
    raise SystemExit(main())
