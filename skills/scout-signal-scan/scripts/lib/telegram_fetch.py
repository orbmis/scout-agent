#!/usr/bin/env python3
"""
telegram_fetch.py — folded into scout-signal-scan from the former
telegram-sync/group_activity.py. Fetches recent messages from specified
Telegram groups/channels and prints them as a JSON array to stdout.

Differences from the original:
- JSON to stdout only (no CSV; the collector consumes stdout)
- Adds message_datetime_iso for a clean created_at downstream
- Guards against interactive login: if the session is not already
  authorized, it exits cleanly rather than prompting (safe for cron)
- Session path is explicit (--session) so no dependency on cwd

Runtime dependencies: telethon, python-dotenv. Install into the venv
referenced by telegram-channels.json (see references/SETUP.md).

Credentials (read from environment, typically sourced from
~/.config/social-scan/.env by the orchestrator):
  TELEGRAM_API_ID, TELEGRAM_API_HASH
Session file path comes from --session (no default to cwd).
"""
import argparse
import asyncio
import datetime as dt
import json
import os
import sys
from typing import Any, Dict, List

try:
    from telethon import TelegramClient
except ImportError:
    print("telethon not installed in this interpreter", file=sys.stderr)
    print("[]")
    raise SystemExit(0)

# python-dotenv is optional; the orchestrator usually sources .env already
try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Fetch recent Telegram group messages as JSON.")
    p.add_argument("--group", action="append", required=True,
                   help="Group/channel identifier. Repeat for multiple.")
    p.add_argument("--hours", type=int, default=24, help="Hours back to scan (default 24).")
    p.add_argument("--timezone", default="UTC", help="IANA timezone for date/time fields (default UTC).")
    p.add_argument("--session", required=True,
                   help="Path to the Telethon session file (without .session suffix).")
    p.add_argument("--verbose", action="store_true")
    return p.parse_args()


def normalize_group_identifier(raw: str) -> Any:
    v = raw.strip()
    if v.startswith("@"):
        v = v[1:]
    if v.lstrip("-").isdigit():
        return int(v)
    return v


def ensure_timezone(tz_name: str) -> dt.tzinfo:
    from zoneinfo import ZoneInfo
    return ZoneInfo(tz_name)


async def fetch(api_id: int, api_hash: str, session_path: str,
                groups: List[str], since_utc: dt.datetime, until_utc: dt.datetime,
                verbose: bool) -> List[Dict[str, Any]]:
    rows: List[Dict[str, Any]] = []

    def vprint(m: str) -> None:
        if verbose:
            print(f"[verbose] {m}", file=sys.stderr)

    client = TelegramClient(session_path, api_id, api_hash)
    await client.connect()
    try:
        # Critical for cron: never trigger interactive login
        if not await client.is_user_authorized():
            print("telegram session not authorized; run interactive login once "
                  "(see SETUP.md). Skipping.", file=sys.stderr)
            return []

        vprint(f"Scanning {len(groups)} group(s)...")
        for idx, group_raw in enumerate(groups, start=1):
            group_ref = normalize_group_identifier(group_raw)
            try:
                entity = await client.get_entity(group_ref)
            except Exception as exc:  # noqa: BLE001
                print(f"Failed to resolve group '{group_raw}': {exc}", file=sys.stderr)
                continue

            title = getattr(entity, "title", None) or getattr(entity, "username", None) or group_raw
            count = 0
            async for msg in client.iter_messages(entity):
                if msg.date is None:
                    continue
                msg_utc = msg.date.astimezone(dt.timezone.utc)
                if msg_utc < since_utc:
                    break
                if msg_utc >= until_utc:
                    continue

                sender_name = ""
                sender_username = ""
                if msg.sender is not None:
                    first = getattr(msg.sender, "first_name", "") or ""
                    last = getattr(msg.sender, "last_name", "") or ""
                    sender_name = f"{first} {last}".strip()
                    sender_username = getattr(msg.sender, "username", "") or ""

                rows.append({
                    "group_input": group_raw,
                    "group_title": title,
                    "group_id": getattr(entity, "id", ""),
                    "message_id": msg.id,
                    "message_datetime_utc": msg_utc,
                    "message_text": (msg.message or "").replace("\n", " ").strip(),
                    "sender_name": sender_name,
                    "sender_username": sender_username,
                    "outgoing": bool(msg.out),
                })
                count += 1
            vprint(f"[{idx}/{len(groups)}] {count} message(s) from {title}")
    finally:
        await client.disconnect()

    rows.sort(key=lambda r: (str(r["group_title"]).lower(), r["message_datetime_utc"]))
    return rows


def main() -> int:
    args = parse_args()
    if args.hours <= 0:
        print("--hours must be positive", file=sys.stderr)
        print("[]")
        return 0

    tz = ensure_timezone(args.timezone)
    until_utc = dt.datetime.now(dt.timezone.utc)
    since_utc = until_utc - dt.timedelta(hours=args.hours)

    api_id = os.getenv("TELEGRAM_API_ID")
    api_hash = os.getenv("TELEGRAM_API_HASH")
    missing = [k for k, v in {"TELEGRAM_API_ID": api_id, "TELEGRAM_API_HASH": api_hash}.items() if not v]
    if missing:
        print(f"Missing env vars: {', '.join(missing)}", file=sys.stderr)
        print("[]")
        return 0

    try:
        rows = asyncio.run(fetch(
            api_id=int(api_id), api_hash=api_hash, session_path=args.session,
            groups=args.group, since_utc=since_utc, until_utc=until_utc,
            verbose=args.verbose,
        ))
    except Exception as exc:  # noqa: BLE001
        print(f"telegram fetch failed: {exc}", file=sys.stderr)
        print("[]")
        return 0

    export_rows: List[Dict[str, Any]] = []
    for row in rows:
        utc_dt = row["message_datetime_utc"]
        local_dt = utc_dt.astimezone(tz)
        export_rows.append({
            "date": local_dt.strftime("%Y-%m-%d"),
            "time": local_dt.strftime("%H:%M:%S"),
            "timezone": args.timezone,
            "message_datetime_iso": utc_dt.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "group_input": row["group_input"],
            "group_title": row["group_title"],
            "group_id": row["group_id"],
            "message_id": row["message_id"],
            "sender_name": row["sender_name"],
            "sender_username": f"@{row['sender_username']}" if row["sender_username"] else "",
            "outgoing": row["outgoing"],
            "message_text": row["message_text"],
        })

    print(json.dumps(export_rows, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
