"""Direct Telegram dispatcher for Thu Hà Authentic.

Reads TELEGRAM_QUEUE, sends to configured Telegram topics, persists dedupe state,
updates queue status, and appends HERMES_CONTROL_DB/RUN_LOG.
"""
from __future__ import annotations

import logging
import os
import sqlite3
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

import requests
from google.auth import default as google_auth_default
from googleapiclient.discovery import build

LOGGER = logging.getLogger("tha_telegram_dispatcher")
QUEUE_COLUMNS = [
    "EVENT_ID", "CHAT_ID", "MESSAGE_TYPE", "PRIORITY", "MESSAGE_TEXT",
    "ACTION_URL", "SOURCE_ID", "STATUS", "CREATED_AT", "SENT_AT", "ERROR",
]


def now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


@dataclass(frozen=True)
class Settings:
    bot_token: str
    fast_index_id: str
    control_db_id: str
    digest_thread_id: int
    alert_thread_id: int
    state_db: Path
    dry_run: bool
    max_batch: int

    @classmethod
    def from_env(cls) -> "Settings":
        token = os.getenv("TELEGRAM_BOT_TOKEN", "").strip()
        if not token:
            raise RuntimeError("TELEGRAM_BOT_TOKEN is required")
        return cls(
            bot_token=token,
            fast_index_id=os.getenv(
                "THA_HERMES_FAST_INDEX_ID",
                "1ZACaor_QW1sQX35S-_PpqjcyX02iiSQPImYCHhaUIf0",
            ),
            control_db_id=os.getenv(
                "HERMES_CONTROL_DB_ID",
                "1PjdF0aP8Ar7Nvp7BkX8jcHrjsoGOoMboZQLow_z_lzs",
            ),
            digest_thread_id=int(os.getenv("TELEGRAM_DIGEST_THREAD_ID", "4592")),
            alert_thread_id=int(os.getenv("TELEGRAM_ALERT_THREAD_ID", "4578")),
            state_db=Path(os.getenv(
                "THA_TELEGRAM_STATE_DB", "/opt/data/tha-telegram/state.db"
            )),
            dry_run=os.getenv("THA_TELEGRAM_DRY_RUN", "true").lower() == "true",
            max_batch=max(1, min(int(os.getenv("THA_TELEGRAM_MAX_BATCH", "20")), 100)),
        )


def choose_thread(message_type: str, settings: Settings) -> int:
    return (
        settings.alert_thread_id
        if (message_type or "").strip().upper() == "ALERT"
        else settings.digest_thread_id
    )


def redact(text: str) -> str:
    hidden = text or ""
    for key in (
        "TELEGRAM_BOT_TOKEN", "META_PAGE_ACCESS_TOKEN",
        "META_VERIFY_TOKEN", "META_APP_SECRET",
    ):
        value = os.getenv(key, "")
        if value:
            hidden = hidden.replace(value, "[REDACTED]")
    return hidden


class StateStore:
    def __init__(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        self.conn = sqlite3.connect(path)
        self.conn.execute(
            """CREATE TABLE IF NOT EXISTS sent_events (
                event_id TEXT PRIMARY KEY,
                sent_at TEXT NOT NULL,
                telegram_message_id TEXT
            )"""
        )
        self.conn.commit()

    def already_sent(self, event_id: str) -> bool:
        return self.conn.execute(
            "SELECT 1 FROM sent_events WHERE event_id = ?", (event_id,)
        ).fetchone() is not None

    def mark_sent(self, event_id: str, message_id: str) -> None:
        self.conn.execute(
            "INSERT OR IGNORE INTO sent_events VALUES (?, ?, ?)",
            (event_id, now_iso(), message_id),
        )
        self.conn.commit()


class SheetsClient:
    def __init__(self) -> None:
        credentials, _ = google_auth_default(
            scopes=["https://www.googleapis.com/auth/spreadsheets"]
        )
        self.service = build(
            "sheets", "v4", credentials=credentials, cache_discovery=False
        )

    def read_queue(self, spreadsheet_id: str) -> list[dict[str, str]]:
        result = self.service.spreadsheets().values().get(
            spreadsheetId=spreadsheet_id,
            range="TELEGRAM_QUEUE!A2:K2000",
        ).execute()
        output: list[dict[str, str]] = []
        for row_number, row in enumerate(result.get("values", []), start=2):
            padded = list(row) + [""] * (len(QUEUE_COLUMNS) - len(row))
            item = dict(zip(QUEUE_COLUMNS, padded))
            item["_ROW_NUMBER"] = str(row_number)
            output.append(item)
        return output

    def update_queue_status(
        self,
        spreadsheet_id: str,
        row_number: int,
        status: str,
        sent_at: str = "",
        error: str = "",
    ) -> None:
        data = [{"range": f"TELEGRAM_QUEUE!H{row_number}", "values": [[status]]}]
        if sent_at:
            data.append({"range": f"TELEGRAM_QUEUE!J{row_number}", "values": [[sent_at]]})
        data.append({"range": f"TELEGRAM_QUEUE!K{row_number}", "values": [[error[:500]]]})
        self.service.spreadsheets().values().batchUpdate(
            spreadsheetId=spreadsheet_id,
            body={"valueInputOption": "RAW", "data": data},
        ).execute()

    def append_run_log(
        self,
        spreadsheet_id: str,
        *,
        run_id: str,
        status: str,
        items_read: int,
        error: str = "",
        notes: str = "",
    ) -> None:
        now = now_iso()
        self.service.spreadsheets().values().append(
            spreadsheetId=spreadsheet_id,
            range="RUN_LOG!A:J",
            valueInputOption="RAW",
            insertDataOption="INSERT_ROWS",
            body={"values": [[
                run_id, "RT-THA-TELEGRAM-NOTIFY-01", now, now, status,
                items_read, "", error[:500], now, notes[:1000],
            ]]},
        ).execute()


def send_telegram(
    *, token: str, chat_id: str, thread_id: int, text: str,
    action_url: str = "", timeout_seconds: int = 15,
) -> str:
    payload: dict[str, Any] = {
        "chat_id": chat_id,
        "message_thread_id": thread_id,
        "text": text,
        "disable_web_page_preview": True,
    }
    if action_url:
        payload["reply_markup"] = {
            "inline_keyboard": [[{"text": "Mở nội dung", "url": action_url}]]
        }
    response = requests.post(
        f"https://api.telegram.org/bot{token}/sendMessage",
        json=payload,
        timeout=timeout_seconds,
    )
    response.raise_for_status()
    body = response.json()
    if not body.get("ok"):
        raise RuntimeError(body.get("description", "Telegram rejected request"))
    return str(body["result"]["message_id"])


def eligible(items: Iterable[dict[str, str]]) -> list[dict[str, str]]:
    allowed = {"PENDING", "PENDING_SMOKE_TEST", "RETRY"}
    return [
        item for item in items
        if item.get("EVENT_ID")
        and item.get("STATUS", "").strip().upper() in allowed
    ]


def run_once(settings: Settings | None = None) -> int:
    settings = settings or Settings.from_env()
    sheets = SheetsClient()
    state = StateStore(settings.state_db)
    run_id = f"THA-TG-{datetime.now().strftime('%Y%m%d%H%M%S')}"
    processed = 0
    errors: list[str] = []

    try:
        items = eligible(sheets.read_queue(settings.fast_index_id))[:settings.max_batch]
        for item in items:
            event_id = item["EVENT_ID"].strip()
            row_number = int(item["_ROW_NUMBER"])
            if state.already_sent(event_id):
                sheets.update_queue_status(
                    settings.fast_index_id, row_number, "SENT_DEDUPED", sent_at=now_iso()
                )
                continue
            try:
                if settings.dry_run:
                    LOGGER.info("DRY_RUN event=%s type=%s", event_id, item.get("MESSAGE_TYPE", ""))
                    sheets.update_queue_status(
                        settings.fast_index_id, row_number, "READY_TO_SEND"
                    )
                    continue
                message_id = send_telegram(
                    token=settings.bot_token,
                    chat_id=item["CHAT_ID"].strip(),
                    thread_id=choose_thread(item.get("MESSAGE_TYPE", ""), settings),
                    text=item.get("MESSAGE_TEXT", "").strip(),
                    action_url=item.get("ACTION_URL", "").strip(),
                )
                state.mark_sent(event_id, message_id)
                sheets.update_queue_status(
                    settings.fast_index_id, row_number, "SENT", sent_at=now_iso()
                )
                processed += 1
            except Exception as exc:  # noqa: BLE001
                message = redact(str(exc))
                errors.append(f"{event_id}: {message}")
                sheets.update_queue_status(
                    settings.fast_index_id, row_number, "FAILED", error=message
                )
        status = "PASS" if not errors else "PASS_WITH_WARNING"
        sheets.append_run_log(
            settings.control_db_id,
            run_id=run_id,
            status=status,
            items_read=len(items),
            error="; ".join(errors),
            notes=f"processed={processed}; dry_run={settings.dry_run}",
        )
        return 0 if not errors else 2
    except Exception as exc:  # noqa: BLE001
        message = redact(str(exc))
        LOGGER.exception("Dispatcher failed: %s", message)
        try:
            sheets.append_run_log(
                settings.control_db_id,
                run_id=run_id,
                status="FAIL",
                items_read=processed,
                error=message,
                notes="Telegram dispatcher fatal error",
            )
        except Exception:  # noqa: BLE001
            LOGGER.exception("Could not append RUN_LOG")
        return 1


if __name__ == "__main__":
    logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))
    raise SystemExit(run_once())
