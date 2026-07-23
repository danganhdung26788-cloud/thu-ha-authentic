"""Read-only Fanpage conversation review source for Hermes Telegram topics.

This module reconstructs Messenger conversations from the existing FANPAGE_QUEUE.
It does not send messages, change queue state, call Meta outbound APIs, or modify the
primary learning flow. Confirmed coaching can be handed to the existing thu-ha-uat /
thu-ha-training flow by the Telegram skill.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import unicodedata
from dataclasses import asdict, dataclass
from datetime import date, datetime
from typing import Any
from zoneinfo import ZoneInfo

FAST_INDEX_ID = os.getenv(
    "THA_HERMES_FAST_INDEX_ID",
    "1ZACaor_QW1sQX35S-_PpqjcyX02iiSQPImYCHhaUIf0",
).strip()
TIMEZONE = ZoneInfo(os.getenv("THA_BUSINESS_TIMEZONE", "Asia/Ho_Chi_Minh"))
QUEUE_RANGE = "FANPAGE_QUEUE!A1:M5000"


def _rows_to_dicts(values: list[list[Any]]) -> list[dict[str, str]]:
    if not values:
        return []
    headers = [str(value).strip() for value in values[0]]
    result: list[dict[str, str]] = []
    for raw in values[1:]:
        row = {
            header: str(raw[index]).strip() if index < len(raw) else ""
            for index, header in enumerate(headers)
            if header
        }
        if any(row.values()):
            result.append(row)
    return result


def normalize_text(value: str) -> str:
    lowered = (value or "").casefold().replace("đ", "d")
    decomposed = unicodedata.normalize("NFD", lowered)
    plain = "".join(
        char for char in decomposed if unicodedata.category(char) != "Mn"
    )
    return " ".join(re.sub(r"[^a-z0-9]+", " ", plain).split())


def parse_timestamp(value: str) -> datetime | None:
    text = (value or "").strip()
    if not text:
        return None
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=TIMEZONE)
    return parsed.astimezone(TIMEZONE)


@dataclass(frozen=True)
class QueueTurn:
    row_number: int
    message_id: str
    customer_id: str
    customer_name: str
    message_text: str
    draft_reply: str
    status: str
    created_at: str
    replied_at: str
    intent: str
    product_key: str

    @property
    def created_local(self) -> datetime | None:
        return parse_timestamp(self.created_at)

    @property
    def replied_local(self) -> datetime | None:
        return parse_timestamp(self.replied_at)


class SheetsRepository:
    def __init__(self, spreadsheet_id: str = FAST_INDEX_ID, service: Any | None = None) -> None:
        if service is None:
            from google.auth import default as google_auth_default
            from googleapiclient.discovery import build

            credentials, _ = google_auth_default(
                scopes=["https://www.googleapis.com/auth/spreadsheets.readonly"]
            )
            service = build("sheets", "v4", credentials=credentials, cache_discovery=False)
        self.service = service
        self.spreadsheet_id = spreadsheet_id

    def read_turns(self) -> list[QueueTurn]:
        payload = self.service.spreadsheets().values().get(
            spreadsheetId=self.spreadsheet_id,
            range=QUEUE_RANGE,
        ).execute()
        rows = _rows_to_dicts(payload.get("values", []))
        return [
            QueueTurn(
                row_number=index,
                message_id=row.get("MESSAGE_ID", ""),
                customer_id=row.get("CUSTOMER_ID", ""),
                customer_name=row.get("CUSTOMER_NAME", ""),
                message_text=row.get("MESSAGE_TEXT", ""),
                draft_reply=row.get("DRAFT_REPLY", ""),
                status=row.get("STATUS", "").upper(),
                created_at=row.get("CREATED_AT", ""),
                replied_at=row.get("REPLIED_AT", ""),
                intent=row.get("INTENT", ""),
                product_key=row.get("PRODUCT_KEY", ""),
            )
            for index, row in enumerate(rows, start=2)
        ]


def _turn_date(turn: QueueTurn) -> date | None:
    stamp = turn.created_local
    return stamp.date() if stamp else None


def _matches_selector(turn: QueueTurn, selector: str) -> bool:
    needle = normalize_text(selector)
    if not needle:
        return True
    fields = (
        turn.customer_id,
        turn.customer_name,
        turn.message_text,
        turn.draft_reply,
        turn.message_id,
    )
    needle_tokens = needle.split()
    return any(
        all(token in normalize_text(field).split() for token in needle_tokens)
        for field in fields
    )


def select_conversation(
    turns: list[QueueTurn],
    *,
    target_date: date | None = None,
    selector: str = "",
) -> list[QueueTurn]:
    dated = [turn for turn in turns if target_date is None or _turn_date(turn) == target_date]
    if not dated:
        return []

    matched = [turn for turn in dated if _matches_selector(turn, selector)]
    if selector and not matched:
        return []

    minimum = datetime.min.replace(tzinfo=TIMEZONE)
    anchor = max(matched or dated, key=lambda item: item.created_local or minimum)
    if not anchor.customer_id:
        return [anchor]

    conversation = [turn for turn in dated if turn.customer_id == anchor.customer_id]
    conversation.sort(key=lambda item: item.created_local or minimum)
    return conversation


def render_transcript(turns: list[QueueTurn], limit: int = 40) -> str:
    if not turns:
        return "Không tìm thấy đoạn chat Fanpage phù hợp trong khoảng thời gian yêu cầu."

    visible = turns[-max(1, min(limit, 100)) :]
    first = visible[0]
    customer = first.customer_name or first.customer_id or "Khách hàng"
    day = _turn_date(visible[-1])
    lines = [
        f"ĐOẠN CHAT FANPAGE — {customer}",
        f"NGÀY={day.isoformat() if day else 'KHÔNG_RÕ'}",
        f"CUSTOMER_ID={first.customer_id or 'KHÔNG_RÕ'}",
        f"SỐ_LƯỢT={len(visible)}",
        "",
    ]
    for turn in visible:
        created = turn.created_local.strftime("%H:%M:%S") if turn.created_local else "--:--:--"
        lines.append(f"[{created}] Khách: {turn.message_text or '(không có nội dung chữ)'}")
        if turn.draft_reply:
            replied = turn.replied_local.strftime("%H:%M:%S") if turn.replied_local else created
            label = "Hermes" if turn.status == "SENT" else f"Hermes ({turn.status or 'NHÁP'})"
            lines.append(f"[{replied}] {label}: {turn.draft_reply}")
        lines.append("")
    return "\n".join(lines).strip()[:12000]


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--format", choices=("text", "json"), default="text")
    sub = parser.add_subparsers(dest="command", required=True)

    review = sub.add_parser("review")
    review.add_argument("--selector", default="")
    review.add_argument("--date", default="")
    review.add_argument("--today", action="store_true")
    review.add_argument("--limit", type=int, default=40)
    return parser


def _resolve_date(raw: str, today: bool) -> date:
    if raw:
        return date.fromisoformat(raw)
    return datetime.now(TIMEZONE).date()


def main() -> int:
    args = build_parser().parse_args()
    repo = SheetsRepository()
    turns = repo.read_turns()

    if args.command == "review":
        target_date = _resolve_date(args.date, args.today)
        selected = select_conversation(
            turns,
            target_date=target_date,
            selector=args.selector,
        )
        if args.format == "json":
            print(
                json.dumps(
                    {
                        "source": "FANPAGE_QUEUE",
                        "mode": "READ_ONLY_REVIEW",
                        "date": target_date.isoformat(),
                        "selector": args.selector,
                        "turns": [asdict(turn) for turn in selected[-max(1, min(args.limit, 100)) :]],
                    },
                    ensure_ascii=False,
                    indent=2,
                )
            )
        else:
            print(render_transcript(selected, args.limit))
        return 0

    raise RuntimeError(f"Unsupported command: {args.command}")


if __name__ == "__main__":
    raise SystemExit(main())
