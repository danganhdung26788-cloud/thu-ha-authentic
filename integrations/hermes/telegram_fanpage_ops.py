"""Telegram-operated control plane for Thu Ha Authentic Messenger.

The controller is intentionally explicit: operators inspect a conversation, ask Hermes
for a rewritten draft, then approve one exact queue row before it is sent. Every write
is audited locally. No command bulk-sends the queue.
"""
from __future__ import annotations

import argparse
import json
import os
import sqlite3
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from integrations.hermes.fanpage_draft_processor import rows_to_dicts
from integrations.hermes.meta_outbound_sender import MetaClient

FAST_INDEX_ID = os.getenv(
    "THA_HERMES_FAST_INDEX_ID",
    "1ZACaor_QW1sQX35S-_PpqjcyX02iiSQPImYCHhaUIf0",
).strip()
PAGE_ID = os.getenv("THA_META_PAGE_ID", "108621404211232").strip()
PAGE_ACCESS_TOKEN = os.getenv("META_PAGE_ACCESS_TOKEN", "").strip()
GRAPH_VERSION = os.getenv("META_GRAPH_API_VERSION", "v25.0").strip()
HERMES_BIN = os.getenv("THA_HERMES_BIN", "/opt/hermes/bin/hermes").strip()
STATE_DB = Path(os.getenv(
    "THA_FANPAGE_OPS_DB", "/opt/data/tha-fanpage-ops/control.db"
))
APPROVED_TRAINERS = {
    value.strip().upper()
    for value in os.getenv(
        "THA_APPROVED_TRAINERS", "DANG_ANH_DUNG,NONG_THU_HA"
    ).split(",")
    if value.strip()
}


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class OpsStore:
    def __init__(self, path: Path = STATE_DB) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        self.conn = sqlite3.connect(path)
        self.conn.execute(
            """CREATE TABLE IF NOT EXISTS audit (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                at TEXT NOT NULL,
                trainer TEXT NOT NULL,
                action TEXT NOT NULL,
                message_id TEXT,
                customer_id TEXT,
                before_json TEXT,
                after_json TEXT,
                note TEXT
            )"""
        )
        self.conn.execute(
            """CREATE TABLE IF NOT EXISTS paused_customers (
                customer_id TEXT PRIMARY KEY,
                paused_at TEXT NOT NULL,
                trainer TEXT NOT NULL,
                reason TEXT
            )"""
        )
        self.conn.commit()

    def audit(
        self,
        trainer: str,
        action: str,
        row: dict[str, str] | None = None,
        before: dict[str, Any] | None = None,
        after: dict[str, Any] | None = None,
        note: str = "",
    ) -> None:
        row = row or {}
        self.conn.execute(
            "INSERT INTO audit(at,trainer,action,message_id,customer_id,before_json,after_json,note) VALUES(?,?,?,?,?,?,?,?)",
            (
                now_iso(), trainer, action,
                row.get("MESSAGE_ID", ""), row.get("CUSTOMER_ID", ""),
                json.dumps(before or {}, ensure_ascii=False),
                json.dumps(after or {}, ensure_ascii=False), note[:1000],
            ),
        )
        self.conn.commit()

    def pause(self, customer_id: str, trainer: str, reason: str) -> None:
        self.conn.execute(
            "INSERT OR REPLACE INTO paused_customers VALUES(?,?,?,?)",
            (customer_id, now_iso(), trainer, reason[:500]),
        )
        self.conn.commit()

    def resume(self, customer_id: str) -> None:
        self.conn.execute(
            "DELETE FROM paused_customers WHERE customer_id=?", (customer_id,)
        )
        self.conn.commit()

    def is_paused(self, customer_id: str) -> bool:
        return self.conn.execute(
            "SELECT 1 FROM paused_customers WHERE customer_id=?", (customer_id,)
        ).fetchone() is not None


class SheetsRepository:
    def __init__(self, spreadsheet_id: str = FAST_INDEX_ID) -> None:
        from google.auth import default as google_auth_default
        from googleapiclient.discovery import build

        credentials, _ = google_auth_default(
            scopes=["https://www.googleapis.com/auth/spreadsheets"]
        )
        self.service = build("sheets", "v4", credentials=credentials, cache_discovery=False)
        self.spreadsheet_id = spreadsheet_id

    def rows(self) -> list[dict[str, str]]:
        result = self.service.spreadsheets().values().get(
            spreadsheetId=self.spreadsheet_id,
            range="FANPAGE_QUEUE!A1:M3000",
        ).execute()
        return rows_to_dicts(result.get("values", []))

    def find(self, selector: str) -> tuple[int, dict[str, str]]:
        selector = selector.strip()
        rows = self.rows()
        matches: list[tuple[int, dict[str, str]]] = []
        for row_number, row in enumerate(rows, start=2):
            if selector in {
                str(row.get("MESSAGE_ID", "")).strip(),
                str(row.get("CUSTOMER_ID", "")).strip(),
            }:
                matches.append((row_number, row))
        if not matches:
            raise ValueError(f"Không tìm thấy hội thoại hoặc tin nhắn: {selector}")
        return matches[-1]

    def update_row(self, row_number: int, values: dict[str, str]) -> None:
        columns = {
            "INTENT": "E", "PRODUCT_KEY": "F", "DRAFT_REPLY": "G",
            "CONFIDENCE": "H", "NEED_HUMAN": "I", "STATUS": "J",
            "REPLIED_AT": "L", "ERROR": "M",
        }
        data = []
        for key, value in values.items():
            if key not in columns:
                raise ValueError(f"Unsupported queue field: {key}")
            data.append({
                "range": f"FANPAGE_QUEUE!{columns[key]}{row_number}",
                "values": [[value]],
            })
        self.service.spreadsheets().values().batchUpdate(
            spreadsheetId=self.spreadsheet_id,
            body={"valueInputOption": "RAW", "data": data},
        ).execute()


def require_trainer(value: str) -> str:
    trainer = value.strip().upper()
    if trainer not in APPROVED_TRAINERS:
        raise PermissionError("Trainer không được phép điều hành Fanpage")
    return trainer


def latest_inbox(repo: SheetsRepository, limit: int = 10) -> list[dict[str, str]]:
    rows = repo.rows()
    actionable = [
        row for row in rows
        if str(row.get("STATUS", "")).upper() in {
            "NEW", "DRAFT_READY", "SEND_FAILED", "HUMAN_REVIEW"
        }
    ]
    return actionable[-max(1, min(limit, 30)):][::-1]


def conversation_context(repo: SheetsRepository, customer_id: str, limit: int = 8) -> list[dict[str, str]]:
    rows = [row for row in repo.rows() if row.get("CUSTOMER_ID", "") == customer_id]
    return rows[-max(1, min(limit, 20)):]


def rewrite_draft(row: dict[str, str], context: list[dict[str, str]], instruction: str) -> str:
    prompt = f"""/thu-ha-cosmetics
Bạn đang sửa một bản trả lời Fanpage theo yêu cầu trực tiếp của quản lý.
Chỉ trả về câu trả lời cuối cùng bằng tiếng Việt, không giải thích, không nhãn, không JSON.
Không bịa tên, giá, tồn kho hay công dụng. Giữ nguyên dữ kiện sản phẩm đã có trong bản nháp.

TIN KHÁCH:
{row.get('MESSAGE_TEXT', '')}

BẢN NHÁP HIỆN TẠI:
{row.get('DRAFT_REPLY', '')}

YÊU CẦU SỬA VĂN PHONG:
{instruction}

NGỮ CẢNH GẦN NHẤT:
{json.dumps(context, ensure_ascii=False, indent=2)}
"""
    result = subprocess.run(
        [HERMES_BIN, "-z", prompt],
        capture_output=True, text=True, timeout=120, check=False,
    )
    text = result.stdout.strip()
    if result.returncode != 0 or not text:
        raise RuntimeError((result.stderr or "Hermes rewrite failed")[:1000])
    return text[:2000]


def render_inbox(rows: list[dict[str, str]]) -> str:
    if not rows:
        return "Không có tin nhắn nào đang chờ xử lý."
    blocks = []
    for row in rows:
        blocks.append(
            "\n".join([
                f"MESSAGE_ID={row.get('MESSAGE_ID','')}",
                f"CUSTOMER_ID={row.get('CUSTOMER_ID','')}",
                f"STATUS={row.get('STATUS','')}",
                f"KHÁCH: {row.get('MESSAGE_TEXT','')}",
                f"NHÁP: {row.get('DRAFT_REPLY','') or '(chưa có)' }",
            ])
        )
    return "\n\n---\n\n".join(blocks)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=[
        "inbox", "open", "rewrite", "approve", "handoff", "pause", "resume", "audit"
    ])
    parser.add_argument("--trainer", required=True)
    parser.add_argument("--selector", default="")
    parser.add_argument("--instruction", default="")
    parser.add_argument("--reason", default="")
    parser.add_argument("--limit", type=int, default=10)
    args = parser.parse_args()

    trainer = require_trainer(args.trainer)
    repo = SheetsRepository()
    store = OpsStore()

    if args.command == "inbox":
        print(render_inbox(latest_inbox(repo, args.limit)))
        return 0

    if args.command == "audit":
        rows = store.conn.execute(
            "SELECT at,trainer,action,message_id,customer_id,note FROM audit ORDER BY id DESC LIMIT ?",
            (max(1, min(args.limit, 50)),),
        ).fetchall()
        for item in rows:
            print(" | ".join(str(value or "") for value in item))
        return 0

    if not args.selector:
        raise ValueError("Thiếu --selector MESSAGE_ID hoặc CUSTOMER_ID")

    row_number, row = repo.find(args.selector)
    customer_id = row.get("CUSTOMER_ID", "")

    if args.command == "open":
        print(render_inbox(conversation_context(repo, customer_id, args.limit)))
        return 0

    if args.command == "rewrite":
        if not args.instruction.strip():
            raise ValueError("Thiếu yêu cầu sửa văn phong")
        before = {"draft": row.get("DRAFT_REPLY", ""), "status": row.get("STATUS", "")}
        revised = rewrite_draft(row, conversation_context(repo, customer_id), args.instruction)
        repo.update_row(row_number, {
            "DRAFT_REPLY": revised,
            "STATUS": "HUMAN_REVIEW",
            "ERROR": "",
        })
        after_row = repo.find(row.get("MESSAGE_ID", ""))[1]
        store.audit(trainer, "REWRITE", row, before, {
            "draft": after_row.get("DRAFT_REPLY", ""),
            "status": after_row.get("STATUS", ""),
        }, args.instruction)
        print(f"Đã sửa nháp và chờ duyệt.\nMESSAGE_ID={row.get('MESSAGE_ID','')}\nNHÁP MỚI: {revised}")
        return 0

    if args.command == "approve":
        if row.get("STATUS", "").upper() not in {"HUMAN_REVIEW", "DRAFT_READY", "SEND_FAILED"}:
            raise ValueError(f"Không thể duyệt từ trạng thái {row.get('STATUS','')}")
        if not row.get("DRAFT_REPLY", "").strip():
            raise ValueError("Bản nháp đang trống")
        if not PAGE_ACCESS_TOKEN:
            raise RuntimeError("Thiếu META_PAGE_ACCESS_TOKEN")
        before = {"status": row.get("STATUS", ""), "draft": row.get("DRAFT_REPLY", "")}
        repo.update_row(row_number, {"STATUS": "SENDING", "ERROR": ""})
        client = MetaClient(PAGE_ID, PAGE_ACCESS_TOKEN, graph_version=GRAPH_VERSION)
        try:
            payload = client.send_text(customer_id, row.get("DRAFT_REPLY", ""))
            repo.update_row(row_number, {
                "STATUS": "SENT", "REPLIED_AT": now_iso(), "ERROR": ""
            })
        except Exception as exc:
            repo.update_row(row_number, {"STATUS": "SEND_FAILED", "ERROR": str(exc)[:500]})
            store.audit(trainer, "APPROVE_SEND_FAILED", row, before, {"error": str(exc)}, args.reason)
            raise
        after_row = repo.find(row.get("MESSAGE_ID", ""))[1]
        store.audit(trainer, "APPROVE_AND_SEND", row, before, {
            "status": after_row.get("STATUS", ""),
            "replied_at": after_row.get("REPLIED_AT", ""),
            "meta_message_id": payload.get("message_id", ""),
        }, args.reason)
        print(f"Đã duyệt và gửi khách. MESSAGE_ID={row.get('MESSAGE_ID','')} STATUS=SENT")
        return 0

    if args.command == "handoff":
        before = {"status": row.get("STATUS", ""), "need_human": row.get("NEED_HUMAN", "")}
        repo.update_row(row_number, {
            "NEED_HUMAN": "TRUE", "STATUS": "HUMAN_REVIEW",
            "ERROR": args.reason[:500],
        })
        store.pause(customer_id, trainer, args.reason or "Human handoff")
        store.audit(trainer, "HANDOFF", row, before, {
            "status": "HUMAN_REVIEW", "need_human": "TRUE", "paused": True,
        }, args.reason)
        print(f"Đã chuyển Thu Hà xử lý và tạm dừng tự trả lời CUSTOMER_ID={customer_id}")
        return 0

    if args.command == "pause":
        store.pause(customer_id, trainer, args.reason)
        store.audit(trainer, "PAUSE", row, note=args.reason)
        print(f"Đã tạm dừng tự trả lời CUSTOMER_ID={customer_id}")
        return 0

    if args.command == "resume":
        store.resume(customer_id)
        store.audit(trainer, "RESUME", row, note=args.reason)
        print(f"Đã bật lại tự trả lời CUSTOMER_ID={customer_id}")
        return 0

    raise AssertionError("Unhandled command")


if __name__ == "__main__":
    raise SystemExit(main())
