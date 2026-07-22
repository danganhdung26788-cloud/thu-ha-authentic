"""Direct Meta Messenger webhook adapter for Thu Hà Authentic.

Verified text messages are written to FANPAGE_QUEUE. The bridge then starts the
safe context guard, natural-reply processor and Meta sender immediately in a
serialized background worker. The Windows Scheduled Task remains a fallback.
"""
from __future__ import annotations

import hashlib
import hmac
import importlib
import json
import logging
import os
import sqlite3
import threading
from datetime import datetime, timezone
from pathlib import Path

from fastapi import BackgroundTasks, FastAPI, Header, HTTPException, Query, Request, Response
from google.auth import default as google_auth_default
from googleapiclient.discovery import build

LOGGER = logging.getLogger("tha_meta_messenger_bridge")
app = FastAPI(title="Thu Hà Authentic Meta Messenger Bridge", version="1.2.0")


def now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def verify_signature(raw_body: bytes, signature_header: str | None, app_secret: str) -> bool:
    if not signature_header or not signature_header.startswith("sha256="):
        return False
    expected = hmac.new(app_secret.encode("utf-8"), raw_body, hashlib.sha256).hexdigest()
    provided = signature_header.split("=", 1)[1]
    return hmac.compare_digest(expected, provided)


def allowed_sender(sender_id: str) -> bool:
    if os.getenv("META_ALLOWLIST_ENABLED", "true").lower() != "true":
        return True
    allowed = {
        value.strip()
        for value in os.getenv("META_ALLOWED_SENDER_IDS", "").split(",")
        if value.strip()
    }
    return bool(allowed) and sender_id in allowed


class DedupeStore:
    def __init__(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        self.conn = sqlite3.connect(path, check_same_thread=False)
        self.lock = threading.Lock()
        self.conn.execute(
            """CREATE TABLE IF NOT EXISTS message_ids (
                message_id TEXT PRIMARY KEY,
                received_at TEXT NOT NULL
            )"""
        )
        self.conn.commit()

    def seen(self, message_id: str) -> bool:
        with self.lock:
            return self.conn.execute(
                "SELECT 1 FROM message_ids WHERE message_id = ?", (message_id,)
            ).fetchone() is not None

    def mark(self, message_id: str) -> None:
        with self.lock:
            self.conn.execute(
                "INSERT OR IGNORE INTO message_ids VALUES (?, ?)",
                (message_id, now_iso()),
            )
            self.conn.commit()


class QueueWriter:
    def __init__(self, spreadsheet_id: str) -> None:
        credentials, _ = google_auth_default(
            scopes=["https://www.googleapis.com/auth/spreadsheets"]
        )
        self.service = build(
            "sheets", "v4", credentials=credentials, cache_discovery=False
        )
        self.spreadsheet_id = spreadsheet_id

    def append_fanpage_message(
        self, *, message_id: str, sender_id: str, message_text: str
    ) -> None:
        self.service.spreadsheets().values().append(
            spreadsheetId=self.spreadsheet_id,
            range="FANPAGE_QUEUE!A:M",
            valueInputOption="RAW",
            insertDataOption="INSERT_ROWS",
            body={"values": [[
                message_id,
                sender_id,
                "",
                message_text,
                "UNCLASSIFIED",
                "",
                "",
                "",
                "FALSE",
                "NEW",
                now_iso(),
                "",
                "",
            ]]},
        ).execute()


FAST_INDEX_ID = os.getenv(
    "THA_HERMES_FAST_INDEX_ID",
    "1ZACaor_QW1sQX35S-_PpqjcyX02iiSQPImYCHhaUIf0",
).strip()
STATE_DB = Path(os.getenv(
    "META_DEDUPE_DB", "/opt/data/meta-messenger/state/dedupe.db"
))
ENV_PATH = Path(os.getenv("THA_RUNTIME_ENV_PATH", "/opt/data/.env"))
DEDUPE = DedupeStore(STATE_DB)
PIPELINE_LOCK = threading.Lock()


def load_runtime_env(path: Path = ENV_PATH) -> dict[str, str]:
    """Load current persistent runtime settings without printing secret values."""
    loaded: dict[str, str] = {}
    try:
        lines = path.read_text(encoding="utf-8-sig").splitlines()
    except (FileNotFoundError, OSError, UnicodeError):
        return loaded
    for raw_line in lines:
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[7:].strip()
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
            value = value[1:-1]
        if key:
            loaded[key] = value
            os.environ[key] = value
    return loaded


def run_realtime_pipeline() -> None:
    """Guard context, generate remaining replies, then send; task is retry path."""
    with PIPELINE_LOCK:
        load_runtime_env()
        os.environ["THA_CONTEXT_GUARD_DRY_RUN"] = "false"
        os.environ["THA_NATURAL_REPLY_DRY_RUN"] = "false"

        guard = importlib.import_module(
            "integrations.hermes.safe_context_processor"
        )
        guard = importlib.reload(guard)
        guard_repo = guard.SheetsRepository(guard.FAST_INDEX_ID)
        guard_eligible, guard_processed = guard.process_new_messages(guard_repo)
        LOGGER.info(
            "Realtime context guard eligible=%s processed=%s",
            guard_eligible,
            guard_processed,
        )

        processor = importlib.import_module(
            "integrations.hermes.natural_reply_processor"
        )
        processor = importlib.reload(processor)
        processor_repo = processor.SheetsRepository(processor.FAST_INDEX_ID)
        eligible, processed, fallbacks = processor.process_new_messages(processor_repo)
        LOGGER.info(
            "Realtime natural reply eligible=%s processed=%s fallbacks=%s",
            eligible,
            processed,
            fallbacks,
        )
        if guard_processed + processed == 0:
            return

        sender = importlib.import_module("integrations.hermes.meta_outbound_sender")
        sender = importlib.reload(sender)
        if sender.REPLY_MODE != "NATURAL_AUTO_REPLY" or not sender.AUTO_SEND:
            LOGGER.info(
                "Realtime sender skipped mode=%s auto_send=%s",
                sender.REPLY_MODE,
                sender.AUTO_SEND,
            )
            return
        if not sender.PAGE_ACCESS_TOKEN:
            raise RuntimeError("Realtime sender has no Meta Page Access Token")

        client = sender.MetaClient(
            sender.PAGE_ID,
            sender.PAGE_ACCESS_TOKEN,
            graph_version=sender.GRAPH_VERSION,
        )
        sender_repo = sender.SheetsRepository(sender.FAST_INDEX_ID)
        cutoff = sender.parse_timestamp(sender.AUTO_SEND_SINCE)
        send_eligible, sent, failed = sender.send_ready_messages(
            sender_repo,
            client,
            cutoff=cutoff,
        )
        LOGGER.info(
            "Realtime Meta sender eligible=%s sent=%s failed=%s",
            send_eligible,
            sent,
            failed,
        )
        if failed:
            raise RuntimeError(f"Realtime Meta sender failed={failed}")


def ingest_message(message_id: str, sender_id: str, message_text: str) -> None:
    if DEDUPE.seen(message_id):
        return
    QueueWriter(FAST_INDEX_ID).append_fanpage_message(
        message_id=message_id,
        sender_id=sender_id,
        message_text=message_text,
    )
    DEDUPE.mark(message_id)
    try:
        run_realtime_pipeline()
    except Exception:
        LOGGER.exception(
            "Realtime pipeline failed; Scheduled Task will retry queued messages"
        )


@app.get("/webhook/meta-messenger")
def verify_webhook(
    hub_mode: str = Query(alias="hub.mode"),
    hub_verify_token: str = Query(alias="hub.verify_token"),
    hub_challenge: str = Query(alias="hub.challenge"),
) -> Response:
    expected = os.getenv("META_VERIFY_TOKEN", "")
    if (
        not expected
        or hub_mode != "subscribe"
        or not hmac.compare_digest(hub_verify_token, expected)
    ):
        raise HTTPException(status_code=403, detail="verification failed")
    return Response(content=hub_challenge, media_type="text/plain", status_code=200)


@app.post("/webhook/meta-messenger")
async def receive_webhook(
    request: Request,
    background_tasks: BackgroundTasks,
    x_hub_signature_256: str | None = Header(default=None),
) -> dict[str, bool]:
    raw_body = await request.body()
    app_secret = os.getenv("META_APP_SECRET", "")
    if not app_secret or not verify_signature(raw_body, x_hub_signature_256, app_secret):
        raise HTTPException(status_code=403, detail="invalid signature")
    try:
        payload = json.loads(raw_body)
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=400, detail="invalid json") from exc

    for entry in payload.get("entry", []):
        for event in entry.get("messaging", []):
            if "delivery" in event or "read" in event:
                continue
            message = event.get("message") or {}
            if not message or message.get("is_echo"):
                continue
            message_id = str(message.get("mid", "")).strip()
            message_text = str(message.get("text", "")).strip()
            sender_id = str((event.get("sender") or {}).get("id", "")).strip()
            if not message_id or not sender_id or not message_text:
                continue
            if not allowed_sender(sender_id):
                continue
            if DEDUPE.seen(message_id):
                continue
            background_tasks.add_task(
                ingest_message, message_id, sender_id, message_text
            )

    return {"ok": True}


@app.get("/health")
def health() -> dict[str, str]:
    runtime = load_runtime_env()
    active = (
        runtime.get("THA_REPLY_MODE", os.getenv("THA_REPLY_MODE", "DRAFT_ONLY")).upper()
        == "NATURAL_AUTO_REPLY"
        and runtime.get("THA_META_AUTO_SEND", os.getenv("THA_META_AUTO_SEND", "false")).lower()
        == "true"
    )
    return {
        "status": "ok",
        "mode": "REALTIME_NATURAL_AUTO_REPLY" if active else "DRAFT_ONLY_INGEST",
        "scheduled_fallback": "enabled",
        "context_guard": "enabled",
        "fanpage_queue_id": FAST_INDEX_ID,
    }
