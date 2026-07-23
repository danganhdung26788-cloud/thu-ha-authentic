"""Operator control plane for Thu Ha Authentic Messenger from Telegram.

The module works on the existing FANPAGE_QUEUE and uses the existing Hermes and
Meta credentials. It never starts a Telegram poller. Notifications are delivered
through ``hermes send`` to one configured Telegram topic.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib
import json
import os
import subprocess
import tempfile
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

from integrations.hermes.fanpage_draft_processor import rows_to_dicts

FAST_INDEX_ID = os.getenv(
    "THA_HERMES_FAST_INDEX_ID",
    "1ZACaor_QW1sQX35S-_PpqjcyX02iiSQPImYCHhaUIf0",
).strip()
ENV_PATH = Path(os.getenv("THA_RUNTIME_ENV_PATH", "/opt/data/.env"))
AUDIT_PATH = Path(
    os.getenv(
        "THA_TELEGRAM_CONTROL_AUDIT",
        "/opt/data/training/thu-ha-cosmetics/fanpage-control/audit.jsonl",
    )
)
PENDING_STATUSES = {"NEW", "DRAFT_READY", "SEND_FAILED", "HOLD", "HUMAN_HANDOFF"}


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def load_env_file(path: Path = ENV_PATH) -> None:
    try:
        lines = path.read_text(encoding="utf-8-sig").splitlines()
    except (OSError, UnicodeError):
        return
    for raw in lines:
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[7:].strip()
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
            value = value[1:-1]
        if key and key not in os.environ:
            os.environ[key] = value


@dataclass(frozen=True)
class QueueItem:
    row_number: int
    message_id: str
    customer_id: str
    customer_name: str
    message_text: str
    intent: str
    product_key: str
    draft_reply: str
    confidence: str
    need_human: str
    status: str
    created_at: str
    replied_at: str
    error: str

    @property
    def ticket(self) -> str:
        return f"FP-{self.row_number}"


class SheetsRepository:
    def __init__(self, spreadsheet_id: str = FAST_INDEX_ID, service: Any | None = None) -> None:
        if service is None:
            from google.auth import default as google_auth_default
            from googleapiclient.discovery import build

            credentials, _ = google_auth_default(
                scopes=["https://www.googleapis.com/auth/spreadsheets"]
            )
            service = build("sheets", "v4", credentials=credentials, cache_discovery=False)
        self.service = service
        self.spreadsheet_id = spreadsheet_id

    def read_items(self) -> list[QueueItem]:
        result = self.service.spreadsheets().values().get(
            spreadsheetId=self.spreadsheet_id,
            range="FANPAGE_QUEUE!A1:M3000",
        ).execute()
        rows = rows_to_dicts(result.get("values", []))
        return [self._item(index, row) for index, row in enumerate(rows, start=2)]

    @staticmethod
    def _item(row_number: int, row: dict[str, str]) -> QueueItem:
        return QueueItem(
            row_number=row_number,
            message_id=str(row.get("MESSAGE_ID", "")).strip(),
            customer_id=str(row.get("CUSTOMER_ID", "")).strip(),
            customer_name=str(row.get("CUSTOMER_NAME", "")).strip(),
            message_text=str(row.get("MESSAGE_TEXT", "")).strip(),
            intent=str(row.get("INTENT", "")).strip(),
            product_key=str(row.get("PRODUCT_KEY", "")).strip(),
            draft_reply=str(row.get("DRAFT_REPLY", "")).strip(),
            confidence=str(row.get("CONFIDENCE", "")).strip(),
            need_human=str(row.get("NEED_HUMAN", "")).strip(),
            status=str(row.get("STATUS", "")).strip().upper(),
            created_at=str(row.get("CREATED_AT", "")).strip(),
            replied_at=str(row.get("REPLIED_AT", "")).strip(),
            error=str(row.get("ERROR", "")).strip(),
        )

    def update_fields(self, row_number: int, fields: dict[str, str]) -> None:
        columns = {
            "draft_reply": "G",
            "confidence": "H",
            "need_human": "I",
            "status": "J",
            "replied_at": "L",
            "error": "M",
        }
        data = []
        for key, value in fields.items():
            if key not in columns:
                raise ValueError(f"Unsupported queue field: {key}")
            data.append(
                {
                    "range": f"FANPAGE_QUEUE!{columns[key]}{row_number}",
                    "values": [[value]],
                }
            )
        self.service.spreadsheets().values().batchUpdate(
            spreadsheetId=self.spreadsheet_id,
            body={"valueInputOption": "RAW", "data": data},
        ).execute()


def find_item(
    repo: SheetsRepository,
    *,
    row_number: int | None = None,
    message_id: str = "",
    latest: bool = False,
) -> QueueItem:
    items = repo.read_items()
    if row_number is not None:
        for item in items:
            if item.row_number == row_number:
                return item
        raise LookupError(f"Queue row not found: {row_number}")
    if message_id:
        for item in items:
            if item.message_id == message_id:
                return item
        raise LookupError("Message ID not found")
    if latest:
        pending = [item for item in items if item.status in PENDING_STATUSES]
        if pending:
            return pending[-1]
        if items:
            return items[-1]
    raise LookupError("No queue item selected")


def list_items(repo: SheetsRepository, limit: int = 10) -> list[QueueItem]:
    pending = [item for item in repo.read_items() if item.status in PENDING_STATUSES]
    return pending[-max(1, min(limit, 30)) :]


def format_item(item: QueueItem, *, notification: bool = False) -> str:
    header = "🔔 Tin mới từ Fanpage" if notification else "📥 Điều hành Fanpage"
    customer = item.customer_name or item.customer_id or "Khách hàng"
    draft = item.draft_reply or "(Hermes chưa tạo được bản nháp)"
    lines = [
        header,
        f"TICKET={item.ticket}",
        f"KHÁCH={customer}",
        f"TRẠNG_THÁI={item.status}",
        "",
        f"Khách: {item.message_text}",
        "",
        f"Hermes dự kiến: {draft}",
        "",
        f"PRODUCT_KEY={item.product_key or 'NONE'}",
        f"INTENT={item.intent or 'UNCLASSIFIED'}",
    ]
    if notification:
        lines.extend(
            [
                "",
                "Trả lời tự nhiên trong topic:",
                "• Gửi",
                "• Viết ngắn hơn / mềm hơn / đổi cách xưng hô",
                "• Dùng câu này: <nội dung>",
                "• Chuyển Thu Hà",
                "• Hãy chuẩn hóa cách này",
            ]
        )
    return "\n".join(lines)[:3900]


def append_audit(operation: str, item: QueueItem, operator: str, detail: str = "") -> None:
    AUDIT_PATH.parent.mkdir(parents=True, exist_ok=True)
    record = {
        "timestamp": now_iso(),
        "operation": operation,
        "ticket": item.ticket,
        "row_number": item.row_number,
        "message_id": item.message_id,
        "operator": operator,
        "detail": detail[:500],
        "draft_sha256": hashlib.sha256(item.draft_reply.encode("utf-8")).hexdigest(),
    }
    with AUDIT_PATH.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(record, ensure_ascii=False) + "\n")


def _hermes_bin() -> str:
    return os.getenv("THA_HERMES_BIN", "hermes").strip() or "hermes"


def rewrite_draft(item: QueueItem, instruction: str) -> str:
    instruction = (instruction or "").strip()
    if not instruction:
        raise ValueError("Rewrite instruction is empty")
    prompt = f"""Bạn đang sửa đúng một câu trả lời Fanpage của Thu Hà Authentic.

Tin khách:
{item.message_text}

Bản nháp hiện tại:
{item.draft_reply}

Yêu cầu của người điều hành:
{instruction}

Ràng buộc bắt buộc:
- Chỉ trả về câu trả lời mới để gửi khách, không giải thích.
- Giữ nguyên sự thật, tên sản phẩm, giá, tồn kho và PRODUCT_KEY đã có.
- Không tự thêm sản phẩm, giá, khuyến mại hoặc cam kết chưa có dữ liệu.
- Văn phong tự nhiên, lịch sự, ngắn gọn; không hỏi lại điều khách đã nói rõ.
- Tối đa 1.800 ký tự.
PRODUCT_KEY={item.product_key or 'NONE'}
"""
    result = subprocess.run(
        [_hermes_bin(), "-z", prompt],
        capture_output=True,
        text=True,
        timeout=120,
        check=False,
    )
    rewritten = result.stdout.strip()
    if result.returncode != 0 or not rewritten:
        error = result.stderr.strip() or f"exit={result.returncode}"
        raise RuntimeError(f"Hermes rewrite failed: {error[:500]}")
    if len(rewritten) > 1800:
        raise RuntimeError("Hermes rewrite exceeded 1800 characters")
    return rewritten


def save_draft(
    repo: SheetsRepository,
    item: QueueItem,
    draft: str,
    *,
    operator: str,
    operation: str,
) -> QueueItem:
    draft = (draft or "").strip()
    if not draft:
        raise ValueError("Draft reply is empty")
    if item.status == "SENT":
        raise RuntimeError("Message was already sent; refusing to overwrite it")
    repo.update_fields(
        item.row_number,
        {
            "draft_reply": draft[:1800],
            "confidence": "1.00",
            "need_human": "FALSE",
            "status": "DRAFT_READY",
            "error": "",
        },
    )
    updated = find_item(repo, row_number=item.row_number)
    append_audit(operation, updated, operator)
    return updated


def send_item(repo: SheetsRepository, item: QueueItem, *, operator: str) -> QueueItem:
    if item.status == "SENT":
        raise RuntimeError("Message was already sent")
    if not item.customer_id or not item.draft_reply:
        raise RuntimeError("Customer ID or draft reply is missing")
    load_env_file()
    sender = importlib.import_module("integrations.hermes.meta_outbound_sender")
    sender = importlib.reload(sender)
    if not sender.PAGE_ACCESS_TOKEN:
        raise RuntimeError("Meta Page Access Token is unavailable")
    client = sender.MetaClient(sender.PAGE_ID, sender.PAGE_ACCESS_TOKEN, sender.GRAPH_VERSION)
    repo.update_fields(item.row_number, {"status": "SENDING", "error": ""})
    try:
        client.send_text(item.customer_id, item.draft_reply)
    except Exception as exc:
        repo.update_fields(
            item.row_number,
            {"status": "SEND_FAILED", "error": str(exc)[:500]},
        )
        raise
    repo.update_fields(
        item.row_number,
        {"status": "SENT", "replied_at": now_iso(), "error": ""},
    )
    updated = find_item(repo, row_number=item.row_number)
    append_audit("SEND", updated, operator)
    return updated


def handoff_item(repo: SheetsRepository, item: QueueItem, reason: str, operator: str) -> QueueItem:
    reason = (reason or "Cần Thu Hà xử lý trực tiếp").strip()
    if item.status == "SENT":
        raise RuntimeError("Message was already sent")
    repo.update_fields(
        item.row_number,
        {
            "need_human": "TRUE",
            "status": "HUMAN_HANDOFF",
            "error": f"OPERATOR_HANDOFF: {reason}"[:500],
        },
    )
    updated = find_item(repo, row_number=item.row_number)
    append_audit("HANDOFF", updated, operator, reason)
    return updated


def hold_item(repo: SheetsRepository, item: QueueItem, reason: str, operator: str) -> QueueItem:
    if item.status == "SENT":
        raise RuntimeError("Message was already sent")
    repo.update_fields(
        item.row_number,
        {"status": "HOLD", "error": f"OPERATOR_HOLD: {reason}"[:500]},
    )
    updated = find_item(repo, row_number=item.row_number)
    append_audit("HOLD", updated, operator, reason)
    return updated


def telegram_target() -> str:
    return os.getenv("THA_TELEGRAM_CONTROL_TARGET", "").strip()


def notify_item(item: QueueItem) -> bool:
    target = telegram_target()
    if not target:
        return False
    text = format_item(item, notification=True)
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", suffix=".txt", delete=False) as handle:
        handle.write(text)
        temp_path = handle.name
    try:
        result = subprocess.run(
            [_hermes_bin(), "send", "--to", target, "--file", temp_path],
            capture_output=True,
            text=True,
            timeout=60,
            check=False,
        )
    finally:
        Path(temp_path).unlink(missing_ok=True)
    if result.returncode != 0:
        raise RuntimeError((result.stderr or result.stdout or "Telegram delivery failed")[:500])
    return True


def _selected(args: argparse.Namespace, repo: SheetsRepository) -> QueueItem:
    row_number = args.row if getattr(args, "row", 0) else None
    return find_item(
        repo,
        row_number=row_number,
        message_id=getattr(args, "message_id", ""),
        latest=getattr(args, "latest", False) or (row_number is None and not getattr(args, "message_id", "")),
    )


def _item_payload(item: QueueItem) -> dict[str, Any]:
    return asdict(item) | {"ticket": item.ticket}


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--operator", default=os.getenv("THA_CONTROL_OPERATOR", "DANG_ANH_DUNG"))
    parser.add_argument("--format", choices=("json", "text"), default="text")
    sub = parser.add_subparsers(dest="command", required=True)

    listing = sub.add_parser("list")
    listing.add_argument("--limit", type=int, default=10)

    for name in ("show", "notify", "send", "handoff", "hold", "rewrite", "set-draft"):
        command = sub.add_parser(name)
        command.add_argument("--row", type=int, default=0)
        command.add_argument("--message-id", default="")
        command.add_argument("--latest", action="store_true")
        if name in {"handoff", "hold"}:
            command.add_argument("--reason", default="")
        if name == "rewrite":
            command.add_argument("--instruction", default="")
            command.add_argument("--instruction-file", default="")
        if name == "set-draft":
            command.add_argument("--draft", default="")
            command.add_argument("--draft-file", default="")
    return parser


def _file_or_value(path: str, value: str) -> str:
    if path:
        return Path(path).read_text(encoding="utf-8").strip()
    return (value or "").strip()


def main() -> int:
    load_env_file()
    args = build_parser().parse_args()
    repo = SheetsRepository()
    result: Any

    if args.command == "list":
        items = list_items(repo, args.limit)
        result = [_item_payload(item) for item in items]
        if args.format == "text":
            print("\n\n".join(format_item(item) for item in items) or "Không có tin đang chờ.")
            return 0
    else:
        item = _selected(args, repo)
        if args.command == "show":
            result = _item_payload(item)
        elif args.command == "notify":
            delivered = notify_item(item)
            result = _item_payload(item) | {"telegram_delivered": delivered}
        elif args.command == "rewrite":
            instruction = _file_or_value(args.instruction_file, args.instruction)
            draft = rewrite_draft(item, instruction)
            result = _item_payload(
                save_draft(repo, item, draft, operator=args.operator, operation="REWRITE")
            )
        elif args.command == "set-draft":
            draft = _file_or_value(args.draft_file, args.draft)
            result = _item_payload(
                save_draft(repo, item, draft, operator=args.operator, operation="SET_DRAFT")
            )
        elif args.command == "send":
            result = _item_payload(send_item(repo, item, operator=args.operator))
        elif args.command == "handoff":
            result = _item_payload(handoff_item(repo, item, args.reason, args.operator))
        elif args.command == "hold":
            result = _item_payload(hold_item(repo, item, args.reason, args.operator))
        else:
            raise RuntimeError(f"Unsupported command: {args.command}")

    if args.format == "json":
        print(json.dumps(result, ensure_ascii=False, indent=2))
    elif isinstance(result, dict):
        print(format_item(QueueItem(**{key: result[key] for key in QueueItem.__dataclass_fields__})))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
