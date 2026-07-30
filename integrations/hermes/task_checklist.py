"""Task-only Hermes digest and owner-scoped Telegram callback processing.

All TaskFlow writes are followed by read-back verification. Callback mutations
are deduplicated through HERMES_ACTION_QUEUE and audited in ACTIVITY_LOG.
"""
from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import os
import re
import threading
import uuid
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from typing import Any, Iterable, Mapping, Protocol, Sequence

import requests

TASKFLOW_SPREADSHEET_ID = os.getenv(
    "TASKFLOW_SPREADSHEET_ID",
    "1l2P0qqojyEKXAiL4cOTwRgJ_1oV5WJQgIQ3mW9zDc48",
).strip()
TELEGRAM_OWNER_USERNAME = "danganhdung"

WORK_ITEMS_HEADERS = (
    "WORK_ID", "CLIENT_REQUEST_ID", "TITLE", "DESCRIPTION", "CATEGORY",
    "REQUESTING_UNIT", "OWNER_EMAIL", "ASSIGNEE_NAME", "COLLABORATORS",
    "RECEIVED_DATE", "DUE_DATE", "PRIORITY", "STATUS", "PHASE",
    "PROGRESS_PERCENT", "OUTPUT_EXPECTED", "RESULT_SUMMARY", "LIMITATIONS",
    "NEXT_ACTION", "FOLDER_ID", "FOLDER_URL", "CURRENT_DOCUMENT_URL",
    "CREATED_BY", "CREATED_AT", "UPDATED_BY", "UPDATED_AT", "COMPLETED_AT",
    "ACTIVE", "RELATED_HS", "START_DATE", "WAITING_FOR", "WAITING_CONTENT",
    "WAITING_SINCE", "WAITING_DUE_DATE", "RESULT_FILE_URL", "SOURCE", "NOTE",
    "REPORTABLE", "WORK_KIND", "DOSSIER_MODE", "START_AT", "END_AT",
    "CALENDAR_EVENT_ID", "CALENDAR_EVENT_URL", "APPROVAL_STATUS",
    "APPROVAL_LEVEL",
)
SUBTASK_HEADERS = (
    "SUBTASK_ID", "WORK_ID", "TITLE", "ASSIGNEE", "DUE_DATE", "STATUS",
    "RESULT", "CREATED_BY", "CREATED_AT", "UPDATED_AT", "ACTIVE",
    "SORT_ORDER", "NOTE",
)
ACTION_QUEUE_HEADERS = (
    "ACTION_ID", "CLIENT_REQUEST_ID", "CHAT_ID", "THREAD_ID", "WORK_ID",
    "ACTION_TYPE", "ARGUMENTS_JSON", "STATUS", "REQUESTED_AT", "STARTED_AT",
    "COMPLETED_AT", "RESULT_JSON", "ERROR_MESSAGE", "DEDUPE_KEY", "SOURCE",
    "ACTIVE", "UPDATED_AT", "PROCESSOR_VERSION",
)
ACTIVITY_HEADERS = (
    "LOG_ID", "WORK_ID", "ACTION", "DETAILS_JSON", "ACTOR_EMAIL",
    "CREATED_AT", "EVENT_TYPE", "OLD_VALUE", "NEW_VALUE", "NOTE", "SOURCE",
)

TERMINAL_PARENT_STATUSES = {
    "COMPLETED", "CANCELLED", "CANCELED", "MERGED", "NOT_DONE",
    "KHONG_THUC_HIEN", "HOAN_THANH", "DA_HOAN_THANH", "HOP_NHAT",
}
COMPLETED_PARENT_STATUSES = {"COMPLETED", "HOAN_THANH", "DA_HOAN_THANH"}
TERMINAL_SUBTASK_STATUSES = {
    "HOAN_THANH", "DA_HOAN_THANH", "COMPLETED", "CANCELLED", "CANCELED",
    "KHONG_THUC_HIEN", "HOP_NHAT", "MERGED",
}
WAITING_STATUSES = {"WAITING", "CHO", "DANG_CHO", "CHO_XU_LY"}
KNOWN_OPEN_STATUSES = {
    "NEW", "TODO", "PENDING", "IN_PROGRESS", "DOING", "DANG_LAM",
    "DANG_THUC_HIEN", "CHUA_THUC_HIEN", *WAITING_STATUSES,
}
ACTION_CODES = {
    "c": "COMPLETE",
    "w": "START",
    "h": "WAIT",
    "p": "POSTPONE",
    "n": "NOT_DONE",
    "t": "TRANSFER",
    "d": "DETAIL",
}
ACTION_BUTTONS = (
    ("✅ Hoàn thành", "c"),
    ("🔄 Đang làm", "w"),
    ("⏸ Chờ", "h"),
    ("📅 Lùi hạn", "p"),
    ("🚫 Không thực hiện", "n"),
    ("↪️ Chuyển việc", "t"),
    ("ℹ️ Chi tiết", "d"),
)
PROCESSOR_VERSION = "issue-39-v1"
CONTINUE_MARKER = "CONTINUE_AFTER_PARENT=TRUE"
CALLBACK_LOCK = threading.Lock()


class ContractError(RuntimeError):
    """Raised when a live sheet or read-back violates the locked contract."""


def now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def normalize_status(value: Any) -> str:
    text = str(value or "").strip().upper()
    return re.sub(r"[\s-]+", "_", text)


def parse_date(value: Any) -> date | None:
    text = str(value or "").strip()
    if not text:
        return None
    for fmt in ("%d/%m/%Y", "%Y-%m-%d", "%d/%m/%Y %H:%M", "%Y-%m-%dT%H:%M:%S"):
        try:
            return datetime.strptime(text[:19], fmt).date()
        except ValueError:
            continue
    return None


def rows_as_dicts(
    values: Sequence[Sequence[Any]],
    expected: Sequence[str],
    sheet_name: str,
) -> list[dict[str, str]]:
    if not values:
        raise ContractError(f"{sheet_name} is empty")
    actual = tuple(str(value).strip() for value in values[0])
    if actual != tuple(expected):
        raise ContractError(f"{sheet_name} header mismatch")
    output: list[dict[str, str]] = []
    for row_number, row in enumerate(values[1:], start=2):
        padded = [str(value) for value in row] + [""] * (len(expected) - len(row))
        if not any(value.strip() for value in padded[: len(expected)]):
            continue
        record = dict(zip(expected, padded[: len(expected)]))
        record["_ROW_NUMBER"] = str(row_number)
        output.append(record)
    return output


@dataclass(frozen=True)
class ConsistencyIssue:
    code: str
    work_id: str
    detail: str


@dataclass(frozen=True)
class Digest:
    groups: Mapping[str, tuple[dict[str, str], ...]]
    consistency: tuple[ConsistencyIssue, ...]


class TaskRepository(Protocol):
    def read_work_items(self) -> list[dict[str, str]]: ...
    def read_subtasks(self) -> list[dict[str, str]]: ...
    def read_actions(self) -> list[dict[str, str]]: ...
    def read_activity(self) -> list[dict[str, str]]: ...
    def update_work(self, row_number: int, fields: Mapping[str, str]) -> None: ...
    def update_subtask(self, row_number: int, fields: Mapping[str, str]) -> None: ...
    def update_action(self, row_number: int, fields: Mapping[str, str]) -> None: ...
    def append_work(self, fields: Mapping[str, str]) -> dict[str, str]: ...
    def append_action(self, fields: Mapping[str, str]) -> dict[str, str]: ...
    def append_activity(self, fields: Mapping[str, str]) -> dict[str, str]: ...


class SheetsTaskRepository:
    """Google Sheets adapter with exact headers and read-back on every write."""

    SHEETS = {
        "WORK_ITEMS": WORK_ITEMS_HEADERS,
        "SUBTASKS": SUBTASK_HEADERS,
        "HERMES_ACTION_QUEUE": ACTION_QUEUE_HEADERS,
        "ACTIVITY_LOG": ACTIVITY_HEADERS,
    }

    def __init__(self, spreadsheet_id: str = TASKFLOW_SPREADSHEET_ID, service: Any | None = None):
        if service is None:
            from google.auth import default as google_auth_default
            from googleapiclient.discovery import build

            credentials, _ = google_auth_default(
                scopes=["https://www.googleapis.com/auth/spreadsheets"]
            )
            service = build("sheets", "v4", credentials=credentials, cache_discovery=False)
        self.service = service
        self.spreadsheet_id = spreadsheet_id

    def _read(self, sheet: str) -> list[dict[str, str]]:
        headers = self.SHEETS[sheet]
        result = self.service.spreadsheets().values().get(
            spreadsheetId=self.spreadsheet_id,
            range=f"{sheet}!A1:{self._column(len(headers))}3000",
        ).execute()
        return rows_as_dicts(result.get("values", []), headers, sheet)

    @staticmethod
    def _column(number: int) -> str:
        output = ""
        while number:
            number, remainder = divmod(number - 1, 26)
            output = chr(65 + remainder) + output
        return output

    def _update(self, sheet: str, row_number: int, fields: Mapping[str, str]) -> None:
        headers = self.SHEETS[sheet]
        unsupported = set(fields) - set(headers)
        if unsupported:
            raise ContractError(f"Unsupported {sheet} fields: {sorted(unsupported)}")
        data = [
            {
                "range": f"{sheet}!{self._column(headers.index(key) + 1)}{row_number}",
                "values": [[value]],
            }
            for key, value in fields.items()
        ]
        if data:
            self.service.spreadsheets().values().batchUpdate(
                spreadsheetId=self.spreadsheet_id,
                body={"valueInputOption": "RAW", "data": data},
            ).execute()
        record = next(
            (row for row in self._read(sheet) if int(row["_ROW_NUMBER"]) == row_number),
            None,
        )
        if record is None or any(str(record.get(key, "")).strip() != str(value).strip() for key, value in fields.items()):
            raise ContractError(f"{sheet} read-back mismatch at row {row_number}")

    def _append(self, sheet: str, fields: Mapping[str, str], key: str) -> dict[str, str]:
        headers = self.SHEETS[sheet]
        unsupported = set(fields) - set(headers)
        if unsupported:
            raise ContractError(f"Unsupported {sheet} fields: {sorted(unsupported)}")
        self.service.spreadsheets().values().append(
            spreadsheetId=self.spreadsheet_id,
            range=f"{sheet}!A:{self._column(len(headers))}",
            valueInputOption="RAW",
            insertDataOption="INSERT_ROWS",
            body={"values": [[fields.get(header, "") for header in headers]]},
        ).execute()
        matches = [row for row in self._read(sheet) if row.get(key) == fields.get(key)]
        if len(matches) != 1:
            raise ContractError(f"{sheet} append read-back mismatch for {key}")
        record = matches[0]
        if any(str(record.get(name, "")).strip() != str(value).strip() for name, value in fields.items()):
            raise ContractError(f"{sheet} appended values do not match read-back")
        return record

    def read_work_items(self) -> list[dict[str, str]]:
        return self._read("WORK_ITEMS")

    def read_subtasks(self) -> list[dict[str, str]]:
        return self._read("SUBTASKS")

    def read_actions(self) -> list[dict[str, str]]:
        return self._read("HERMES_ACTION_QUEUE")

    def read_activity(self) -> list[dict[str, str]]:
        return self._read("ACTIVITY_LOG")

    def update_work(self, row_number: int, fields: Mapping[str, str]) -> None:
        self._update("WORK_ITEMS", row_number, fields)

    def update_subtask(self, row_number: int, fields: Mapping[str, str]) -> None:
        self._update("SUBTASKS", row_number, fields)

    def update_action(self, row_number: int, fields: Mapping[str, str]) -> None:
        self._update("HERMES_ACTION_QUEUE", row_number, fields)

    def append_work(self, fields: Mapping[str, str]) -> dict[str, str]:
        return self._append("WORK_ITEMS", fields, "WORK_ID")

    def append_action(self, fields: Mapping[str, str]) -> dict[str, str]:
        return self._append("HERMES_ACTION_QUEUE", fields, "ACTION_ID")

    def append_activity(self, fields: Mapping[str, str]) -> dict[str, str]:
        return self._append("ACTIVITY_LOG", fields, "LOG_ID")


def consistency_check(
    work_items: Sequence[dict[str, str]],
    subtasks: Sequence[dict[str, str]],
) -> list[ConsistencyIssue]:
    issues: list[ConsistencyIssue] = []
    by_id: dict[str, list[dict[str, str]]] = {}
    for work in work_items:
        work_id = work.get("WORK_ID", "").strip()
        if work_id:
            by_id.setdefault(work_id, []).append(work)
    for work_id, records in by_id.items():
        if len(records) > 1:
            issues.append(ConsistencyIssue("DUPLICATE_WORK_ID", work_id, f"{len(records)} bản ghi"))

    children: dict[str, list[dict[str, str]]] = {}
    for child in subtasks:
        children.setdefault(child.get("WORK_ID", "").strip(), []).append(child)

    for work in work_items:
        work_id = work.get("WORK_ID", "").strip()
        status = normalize_status(work.get("STATUS"))
        own_children = children.get(work_id, [])
        open_children = [
            child for child in own_children
            if normalize_status(child.get("STATUS")) not in TERMINAL_SUBTASK_STATUSES
        ]
        if status in TERMINAL_PARENT_STATUSES and open_children:
            ids = ",".join(child.get("SUBTASK_ID", "") for child in open_children)
            issues.append(ConsistencyIssue("TERMINAL_PARENT_OPEN_CHILD", work_id, ids))
        if own_children and not open_children and status not in TERMINAL_PARENT_STATUSES:
            issues.append(ConsistencyIssue("ALL_CHILDREN_TERMINAL_PARENT_OPEN", work_id, "all children terminal"))
        if status in COMPLETED_PARENT_STATUSES and not work.get("COMPLETED_AT", "").strip():
            issues.append(ConsistencyIssue("COMPLETED_MISSING_COMPLETED_AT", work_id, "COMPLETED_AT trống"))
        if status in COMPLETED_PARENT_STATUSES and work.get("NEXT_ACTION", "").strip():
            issues.append(ConsistencyIssue("COMPLETED_HAS_NEXT_ACTION", work_id, "NEXT_ACTION còn dữ liệu"))
        if status in TERMINAL_PARENT_STATUSES:
            for child in own_children:
                due = parse_date(child.get("DUE_DATE"))
                continued = CONTINUE_MARKER in child.get("NOTE", "").upper()
                if (
                    due and due < date.today()
                    and normalize_status(child.get("STATUS")) not in TERMINAL_SUBTASK_STATUSES
                    and not continued
                ):
                    issues.append(
                        ConsistencyIssue(
                            "OVERDUE_CHILD_TERMINAL_PARENT",
                            work_id,
                            child.get("SUBTASK_ID", ""),
                        )
                    )
    unique: list[ConsistencyIssue] = []
    seen: set[tuple[str, str, str]] = set()
    for issue in issues:
        key = (issue.code, issue.work_id, issue.detail)
        if key not in seen:
            unique.append(issue)
            seen.add(key)
    return unique


def _work_has_sync_issue(work_id: str, issues: Iterable[ConsistencyIssue]) -> bool:
    return any(issue.work_id == work_id for issue in issues)


def build_digest(
    work_items: Sequence[dict[str, str]],
    subtasks: Sequence[dict[str, str]],
    *,
    today: date | None = None,
    soon_days: int = 3,
) -> Digest:
    today = today or date.today()
    issues = consistency_check(work_items, subtasks)
    groups: dict[str, list[dict[str, str]]] = {
        "QUÁ HẠN": [],
        "ĐẾN HẠN HÔM NAY": [],
        "SẮP ĐẾN HẠN": [],
        "ĐANG CHỜ": [],
        "CẦN CHỌN TRẠNG THÁI": [],
        "CẦN ĐỒNG BỘ DỮ LIỆU": [],
    }
    for work in work_items:
        work_id = work.get("WORK_ID", "").strip()
        if not work_id:
            continue
        status = normalize_status(work.get("STATUS"))
        if _work_has_sync_issue(work_id, issues):
            groups["CẦN ĐỒNG BỘ DỮ LIỆU"].append(work)
            continue
        if status in TERMINAL_PARENT_STATUSES:
            continue
        if status in WAITING_STATUSES:
            groups["ĐANG CHỜ"].append(work)
            continue
        if not status or status not in KNOWN_OPEN_STATUSES:
            groups["CẦN CHỌN TRẠNG THÁI"].append(work)
            continue
        due = parse_date(work.get("DUE_DATE"))
        if due is None:
            continue
        if due < today:
            groups["QUÁ HẠN"].append(work)
        elif due == today:
            groups["ĐẾN HẠN HÔM NAY"].append(work)
        elif due <= today + timedelta(days=soon_days):
            groups["SẮP ĐẾN HẠN"].append(work)

    parent_by_id = {
        row.get("WORK_ID", "").strip(): row
        for row in work_items
        if row.get("WORK_ID", "").strip()
    }
    for child in subtasks:
        parent_id = child.get("WORK_ID", "").strip()
        if not child.get("SUBTASK_ID", "").strip() or not parent_id:
            continue
        parent = parent_by_id.get(parent_id)
        if not parent or _work_has_sync_issue(parent_id, issues):
            continue
        parent_terminal = normalize_status(parent.get("STATUS")) in TERMINAL_PARENT_STATUSES
        continued = CONTINUE_MARKER in child.get("NOTE", "").upper()
        status = normalize_status(child.get("STATUS"))
        if status in TERMINAL_SUBTASK_STATUSES or (parent_terminal and not continued):
            continue
        record = {
            "WORK_ID": child.get("SUBTASK_ID", "").strip(),
            "PARENT_WORK_ID": parent_id,
            "TITLE": child.get("TITLE", ""),
            "STATUS": child.get("STATUS", ""),
            "DUE_DATE": child.get("DUE_DATE", ""),
            "NEXT_ACTION": child.get("NOTE", ""),
            "_TASK_KIND": "SUBTASK",
        }
        if status in WAITING_STATUSES:
            groups["ĐANG CHỜ"].append(record)
            continue
        if not status or status not in KNOWN_OPEN_STATUSES:
            groups["CẦN CHỌN TRẠNG THÁI"].append(record)
            continue
        due = parse_date(child.get("DUE_DATE"))
        if due is None:
            continue
        if due < today:
            groups["QUÁ HẠN"].append(record)
        elif due == today:
            groups["ĐẾN HẠN HÔM NAY"].append(record)
        elif due <= today + timedelta(days=soon_days):
            groups["SẮP ĐẾN HẠN"].append(record)
    deduped_groups: dict[str, tuple[dict[str, str], ...]] = {}
    for name, records in groups.items():
        seen_ids: set[str] = set()
        unique_records: list[dict[str, str]] = []
        for record in records:
            task_id = record.get("WORK_ID", "").strip()
            if task_id and task_id not in seen_ids:
                seen_ids.add(task_id)
                unique_records.append(record)
        deduped_groups[name] = tuple(unique_records)
    return Digest(
        groups=deduped_groups,
        consistency=tuple(issues),
    )


def callback_keyboard(work_id: str) -> dict[str, list[list[dict[str, str]]]]:
    rows: list[list[dict[str, str]]] = []
    for index in range(0, len(ACTION_BUTTONS), 2):
        row = [
            {"text": label, "callback_data": f"ht:{code}:{work_id}"}
            for label, code in ACTION_BUTTONS[index:index + 2]
        ]
        rows.append(row)
    if any(len(button["callback_data"].encode("utf-8")) > 64 for row in rows for button in row):
        raise ContractError("Telegram callback_data exceeds 64 bytes")
    return {"inline_keyboard": rows}


def format_task(work: Mapping[str, str], group: str) -> str:
    lines = [
        f"📌 {group}",
        f"{work.get('WORK_ID', '').strip()} — {work.get('TITLE', '').strip()}",
        f"Trạng thái: {work.get('STATUS', '').strip() or 'CHƯA CHỌN'}",
    ]
    if work.get("DUE_DATE", "").strip():
        lines.append(f"Hạn: {work['DUE_DATE'].strip()}")
    if work.get("NEXT_ACTION", "").strip():
        lines.append(f"Tiếp theo: {work['NEXT_ACTION'].strip()}")
    return "\n".join(lines)[:3900]


class TelegramClient:
    def __init__(self, token: str):
        if not token:
            raise RuntimeError("TELEGRAM_BOT_TOKEN is required")
        self.token = token

    def _call(self, method: str, payload: Mapping[str, Any]) -> dict[str, Any]:
        response = requests.post(
            f"https://api.telegram.org/bot{self.token}/{method}",
            json=dict(payload),
            timeout=20,
        )
        response.raise_for_status()
        body = response.json()
        if not body.get("ok"):
            raise RuntimeError(body.get("description", f"Telegram {method} failed"))
        return body

    def send_task(
        self, *, chat_id: str, thread_id: str, text: str, work_id: str,
    ) -> str:
        payload: dict[str, Any] = {
            "chat_id": chat_id,
            "text": text,
            "reply_markup": callback_keyboard(work_id),
            "disable_web_page_preview": True,
        }
        if thread_id:
            payload["message_thread_id"] = int(thread_id)
        return str(self._call("sendMessage", payload)["result"]["message_id"])

    def answer_callback(self, callback_id: str, text: str, *, alert: bool = False) -> None:
        self._call(
            "answerCallbackQuery",
            {
                "callback_query_id": callback_id,
                "text": text[:200],
                "show_alert": alert,
            },
        )


def send_digest(
    repo: TaskRepository,
    telegram: TelegramClient,
    *,
    chat_id: str,
    thread_id: str = "",
    today: date | None = None,
) -> int:
    digest = build_digest(repo.read_work_items(), repo.read_subtasks(), today=today)
    sent = 0
    seen: set[str] = set()
    for group, records in digest.groups.items():
        for work in records:
            work_id = work.get("WORK_ID", "").strip()
            if not work_id or work_id in seen:
                continue
            telegram.send_task(
                chat_id=chat_id,
                thread_id=thread_id,
                text=format_task(work, group),
                work_id=work_id,
            )
            seen.add(work_id)
            sent += 1
    return sent


def _find_work(repo: TaskRepository, work_id: str) -> dict[str, str]:
    matches = [row for row in repo.read_work_items() if row.get("WORK_ID", "").strip() == work_id]
    if len(matches) != 1:
        raise ContractError(f"Expected one WORK_ITEMS record for {work_id}; found {len(matches)}")
    return matches[0]


def _find_task(repo: TaskRepository, task_id: str) -> tuple[str, dict[str, str]]:
    works = [
        row for row in repo.read_work_items()
        if row.get("WORK_ID", "").strip() == task_id
    ]
    children = [
        row for row in repo.read_subtasks()
        if row.get("SUBTASK_ID", "").strip() == task_id
    ]
    if len(works) + len(children) != 1:
        raise ContractError(
            f"Expected one TaskFlow task for {task_id}; "
            f"found work={len(works)} subtask={len(children)}"
        )
    return ("WORK", works[0]) if works else ("SUBTASK", children[0])


def _dedupe_key(
    work_id: str,
    action: str,
    arguments: Mapping[str, Any],
    history_token: str = "",
) -> str:
    canonical = json.dumps(arguments, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    material = f"{canonical}|{history_token}"
    suffix = hashlib.sha256(material.encode("utf-8")).hexdigest()[:12]
    return f"HERMES_TASK:{work_id}:{action}:{suffix}"


def _detached_work_id(subtask_id: str, dedupe_key: str) -> str:
    suffix = hashlib.sha256(f"{subtask_id}:{dedupe_key}".encode("utf-8")).hexdigest()[:8].upper()
    return f"CV-CONT-{datetime.now().strftime('%Y%m%d')}-{suffix}"


def _detach_child(
    repo: TaskRepository,
    child: dict[str, str],
    parent: dict[str, str],
    dedupe_key: str,
    timestamp: str,
) -> str:
    new_id = _detached_work_id(child["SUBTASK_ID"], dedupe_key)
    existing = [row for row in repo.read_work_items() if row.get("WORK_ID") == new_id]
    if not existing:
        repo.append_work(
            {
                "WORK_ID": new_id,
                "TITLE": child.get("TITLE", ""),
                "DESCRIPTION": f"Tách từ {child.get('SUBTASK_ID')} khi đóng {parent.get('WORK_ID')}",
                "DUE_DATE": child.get("DUE_DATE", ""),
                "STATUS": "IN_PROGRESS",
                "PROGRESS_PERCENT": "0",
                "NEXT_ACTION": child.get("NOTE", "").replace(CONTINUE_MARKER, "").strip(),
                "CREATED_BY": "HERMES",
                "CREATED_AT": timestamp,
                "UPDATED_BY": "HERMES",
                "UPDATED_AT": timestamp,
                "ACTIVE": "TRUE",
                "SOURCE": "HERMES_PARENT_CLOSE",
                "NOTE": f"DETACHED_FROM={child.get('SUBTASK_ID')};PARENT={parent.get('WORK_ID')}",
                "REPORTABLE": "TRUE",
                "WORK_KIND": "TASK",
            }
        )
    repo.update_subtask(
        int(child["_ROW_NUMBER"]),
        {
            "STATUS": "HOAN_THANH",
            "RESULT": f"Đã tách thành nhiệm vụ độc lập {new_id}",
            "UPDATED_AT": timestamp,
            "NOTE": f"DETACHED_TO={new_id}; {child.get('NOTE', '')}".strip(),
        },
    )
    return new_id


def _apply_parent_terminal(
    repo: TaskRepository,
    parent: dict[str, str],
    *,
    action: str,
    arguments: Mapping[str, Any],
    dedupe_key: str,
    timestamp: str,
) -> dict[str, Any]:
    children = [
        row for row in repo.read_subtasks()
        if row.get("WORK_ID", "").strip() == parent["WORK_ID"]
    ]
    explicit_continue = {
        str(value).strip()
        for value in arguments.get("continue_subtasks", [])
        if str(value).strip()
    }
    detached: list[str] = []
    closed: list[str] = []
    child_terminal = "HOAN_THANH" if action == "COMPLETE" else "KHONG_THUC_HIEN"
    for child in children:
        if normalize_status(child.get("STATUS")) in TERMINAL_SUBTASK_STATUSES:
            continue
        should_continue = (
            child.get("SUBTASK_ID", "") in explicit_continue
            or CONTINUE_MARKER in child.get("NOTE", "").upper()
        )
        if should_continue:
            detached.append(_detach_child(repo, child, parent, dedupe_key, timestamp))
            continue
        repo.update_subtask(
            int(child["_ROW_NUMBER"]),
            {
                "STATUS": child_terminal,
                "RESULT": f"Hermes đóng theo nhiệm vụ cha {parent['WORK_ID']}",
                "UPDATED_AT": timestamp,
                "NOTE": f"PARENT_TERMINAL_ACTION={action}; {child.get('NOTE', '')}".strip(),
            },
        )
        closed.append(child.get("SUBTASK_ID", ""))

    parent_status = "COMPLETED" if action == "COMPLETE" else "NOT_DONE"
    fields = {
        "STATUS": parent_status,
        "PROGRESS_PERCENT": "100",
        "NEXT_ACTION": "",
        "UPDATED_BY": "HERMES",
        "UPDATED_AT": timestamp,
        "COMPLETED_AT": timestamp,
    }
    repo.update_work(int(parent["_ROW_NUMBER"]), fields)
    read_back = _find_work(repo, parent["WORK_ID"])
    if any(read_back.get(key, "").strip() != value for key, value in fields.items()):
        raise ContractError("Parent read-back mismatch")
    return {"closed_subtasks": closed, "detached_work_ids": detached, "status": parent_status}


def _apply_simple_action(
    repo: TaskRepository,
    work: dict[str, str],
    action: str,
    timestamp: str,
) -> dict[str, Any]:
    mapping = {
        "START": {"STATUS": "IN_PROGRESS"},
        "WAIT": {"STATUS": "WAITING"},
    }
    fields = mapping[action] | {"UPDATED_BY": "HERMES", "UPDATED_AT": timestamp}
    repo.update_work(int(work["_ROW_NUMBER"]), fields)
    read_back = _find_work(repo, work["WORK_ID"])
    if any(read_back.get(key, "").strip() != value for key, value in fields.items()):
        raise ContractError("TaskFlow read-back mismatch")
    return {"status": fields["STATUS"]}


def _apply_subtask_action(
    repo: TaskRepository,
    child: dict[str, str],
    action: str,
    arguments: Mapping[str, Any],
    timestamp: str,
) -> dict[str, Any]:
    if action == "DETAIL":
        return {
            "work_id": child.get("SUBTASK_ID", ""),
            "parent_work_id": child.get("WORK_ID", ""),
            "title": child.get("TITLE", ""),
            "status": child.get("STATUS", ""),
            "due_date": child.get("DUE_DATE", ""),
            "next_action": child.get("NOTE", ""),
        }
    if action in {"POSTPONE", "TRANSFER"} and not arguments:
        return {
            "status": "NEEDS_INPUT",
            "required": "due_date" if action == "POSTPONE" else "assignee",
        }
    fields: dict[str, str]
    if action == "POSTPONE":
        due_date = str(arguments.get("due_date", "")).strip()
        if parse_date(due_date) is None:
            raise ValueError("POSTPONE requires a valid due_date")
        fields = {"DUE_DATE": due_date}
    elif action == "TRANSFER":
        assignee = str(arguments.get("assignee", "")).strip()
        if not assignee:
            raise ValueError("TRANSFER requires assignee")
        fields = {"ASSIGNEE": assignee}
    elif action == "COMPLETE":
        fields = {"STATUS": "HOAN_THANH", "RESULT": "Hermes hoàn thành từ Telegram"}
    elif action == "NOT_DONE":
        fields = {"STATUS": "KHONG_THUC_HIEN", "RESULT": "Hermes đóng từ Telegram"}
    elif action == "START":
        fields = {"STATUS": "DANG_THUC_HIEN"}
    elif action == "WAIT":
        fields = {"STATUS": "DANG_CHO"}
    else:
        raise ValueError(f"Unsupported subtask action: {action}")
    fields["UPDATED_AT"] = timestamp
    repo.update_subtask(int(child["_ROW_NUMBER"]), fields)
    verified = [
        row for row in repo.read_subtasks()
        if row.get("SUBTASK_ID") == child.get("SUBTASK_ID")
    ]
    if len(verified) != 1 or any(
        verified[0].get(key, "").strip() != value for key, value in fields.items()
    ):
        raise ContractError("Subtask read-back mismatch")
    result = {"status": verified[0].get("STATUS", "")}
    if "DUE_DATE" in fields:
        result["due_date"] = fields["DUE_DATE"]
    if "ASSIGNEE" in fields:
        result["assignee"] = fields["ASSIGNEE"]
    return result


def _state_already_applied(
    task_kind: str,
    task: Mapping[str, str],
    action: str,
    arguments: Mapping[str, Any],
) -> bool:
    status = normalize_status(task.get("STATUS"))
    if action == "START":
        return status == ("IN_PROGRESS" if task_kind == "WORK" else "DANG_THUC_HIEN")
    if action == "WAIT":
        return status == ("WAITING" if task_kind == "WORK" else "DANG_CHO")
    if action == "COMPLETE":
        allowed = COMPLETED_PARENT_STATUSES if task_kind == "WORK" else {
            "COMPLETED", "HOAN_THANH", "DA_HOAN_THANH",
        }
        return status in allowed
    if action == "NOT_DONE":
        return status in {"NOT_DONE", "KHONG_THUC_HIEN", "CANCELLED", "CANCELED"}
    if action == "POSTPONE" and arguments.get("due_date"):
        return task.get("DUE_DATE", "").strip() == str(arguments["due_date"]).strip()
    if action == "TRANSFER" and arguments.get("assignee"):
        field = "ASSIGNEE_NAME" if task_kind == "WORK" else "ASSIGNEE"
        return task.get(field, "").strip() == str(arguments["assignee"]).strip()
    return False


def _process_callback(
    repo: TaskRepository,
    *,
    callback_id: str,
    username: str,
    chat_id: str,
    thread_id: str,
    data: str,
    arguments: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    if username.strip().lower() != TELEGRAM_OWNER_USERNAME:
        raise PermissionError("Callback owner is not allowed")
    match = re.fullmatch(r"ht:([cwhpntd]):([A-Za-z0-9_-]{1,48})", data.strip())
    if not match:
        raise ValueError("Invalid callback data")
    action = ACTION_CODES[match.group(1)]
    work_id = match.group(2)
    arguments = dict(arguments or {})
    task_kind, work = _find_task(repo, work_id)
    action_history = [
        row for row in repo.read_actions()
        if row.get("WORK_ID") == work_id
    ]
    canonical_args = json.dumps(arguments, ensure_ascii=False, sort_keys=True)
    same_action = [
        row for row in action_history
        if row.get("ACTION_TYPE") == action
        and row.get("ARGUMENTS_JSON", "").strip() == canonical_args
    ]
    can_reuse = (
        _state_already_applied(task_kind, work, action, arguments)
        or action == "DETAIL"
        or (action in {"POSTPONE", "TRANSFER"} and not arguments)
    )
    if same_action and can_reuse:
        result = same_action[-1].get("RESULT_JSON", "").strip()
        return {
            "idempotent": True,
            "action_id": same_action[-1].get("ACTION_ID", ""),
            "result": json.loads(result) if result else {},
        }
    if _state_already_applied(task_kind, work, action, arguments):
        return {
            "idempotent": True,
            "action_id": "",
            "result": {"status": work.get("STATUS", "")},
        }
    history_token = action_history[-1].get("ACTION_ID", "") if action_history else ""
    dedupe_key = _dedupe_key(work_id, action, arguments, history_token)

    timestamp = now_iso()
    action_id = f"HA-{uuid.uuid4().hex[:20].upper()}"
    queued = repo.append_action(
        {
            "ACTION_ID": action_id,
            "CLIENT_REQUEST_ID": callback_id,
            "CHAT_ID": chat_id,
            "THREAD_ID": thread_id,
            "WORK_ID": work_id,
            "ACTION_TYPE": action,
            "ARGUMENTS_JSON": json.dumps(arguments, ensure_ascii=False, sort_keys=True),
            "STATUS": "PROCESSING",
            "REQUESTED_AT": timestamp,
            "STARTED_AT": timestamp,
            "DEDUPE_KEY": dedupe_key,
            "SOURCE": "TELEGRAM_CALLBACK",
            "ACTIVE": "TRUE",
            "UPDATED_AT": timestamp,
            "PROCESSOR_VERSION": PROCESSOR_VERSION,
        }
    )
    old_status = work.get("STATUS", "")
    if task_kind == "SUBTASK":
        result = _apply_subtask_action(repo, work, action, arguments, timestamp)
    elif action == "DETAIL":
        result: dict[str, Any] = {
            "work_id": work_id,
            "title": work.get("TITLE", ""),
            "status": old_status,
            "due_date": work.get("DUE_DATE", ""),
            "next_action": work.get("NEXT_ACTION", ""),
        }
    elif action in {"POSTPONE", "TRANSFER"} and not arguments:
        result = {
            "status": "NEEDS_INPUT",
            "required": "due_date" if action == "POSTPONE" else "assignee",
        }
    elif action == "POSTPONE":
        due_date = str(arguments.get("due_date", "")).strip()
        if parse_date(due_date) is None:
            raise ValueError("POSTPONE requires a valid due_date")
        repo.update_work(
            int(work["_ROW_NUMBER"]),
            {"DUE_DATE": due_date, "UPDATED_BY": "HERMES", "UPDATED_AT": timestamp},
        )
        read_back = _find_work(repo, work_id)
        if read_back.get("DUE_DATE", "").strip() != due_date:
            raise ContractError("Due-date read-back mismatch")
        result = {"status": read_back.get("STATUS", ""), "due_date": due_date}
    elif action == "TRANSFER":
        assignee = str(arguments.get("assignee", "")).strip()
        if not assignee:
            raise ValueError("TRANSFER requires assignee")
        repo.update_work(
            int(work["_ROW_NUMBER"]),
            {"ASSIGNEE_NAME": assignee, "UPDATED_BY": "HERMES", "UPDATED_AT": timestamp},
        )
        read_back = _find_work(repo, work_id)
        if read_back.get("ASSIGNEE_NAME", "").strip() != assignee:
            raise ContractError("Assignee read-back mismatch")
        result = {"status": read_back.get("STATUS", ""), "assignee": assignee}
    elif action in {"COMPLETE", "NOT_DONE"}:
        result = _apply_parent_terminal(
            repo,
            work,
            action=action,
            arguments=arguments,
            dedupe_key=dedupe_key,
            timestamp=timestamp,
        )
    else:
        result = _apply_simple_action(repo, work, action, timestamp)

    completed = now_iso()
    result_json = json.dumps(result, ensure_ascii=False, sort_keys=True)
    log_id = f"HL-{hashlib.sha256(dedupe_key.encode()).hexdigest()[:20].upper()}"
    if not any(row.get("LOG_ID") == log_id for row in repo.read_activity()):
        repo.append_activity(
            {
                "LOG_ID": log_id,
                "WORK_ID": work_id,
                "ACTION": action,
                "DETAILS_JSON": result_json,
                "ACTOR_EMAIL": TELEGRAM_OWNER_USERNAME,
                "CREATED_AT": completed,
                "EVENT_TYPE": "HERMES_TASK_CALLBACK",
                "OLD_VALUE": old_status,
                "NEW_VALUE": str(result.get("status", "")),
                "NOTE": f"ACTION_ID={action_id}",
                "SOURCE": "HERMES_TELEGRAM",
            }
        )
    repo.update_action(
        int(queued["_ROW_NUMBER"]),
        {
            "STATUS": "COMPLETED" if result.get("status") != "NEEDS_INPUT" else "NEEDS_INPUT",
            "COMPLETED_AT": completed if result.get("status") != "NEEDS_INPUT" else "",
            "RESULT_JSON": result_json,
            "ERROR_MESSAGE": "",
            "UPDATED_AT": completed,
        },
    )
    verified = [
        row for row in repo.read_actions()
        if row.get("ACTION_ID") == action_id
    ]
    if len(verified) != 1 or verified[0].get("RESULT_JSON", "").strip() != result_json:
        raise ContractError("Action queue read-back mismatch")
    return {"idempotent": False, "action_id": action_id, "result": result}


def process_callback(
    repo: TaskRepository,
    *,
    callback_id: str,
    username: str,
    chat_id: str,
    thread_id: str,
    data: str,
    arguments: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """Serialize callbacks in the single Hermes sidecar and process idempotently."""
    with CALLBACK_LOCK:
        try:
            return _process_callback(
                repo,
                callback_id=callback_id,
                username=username,
                chat_id=chat_id,
                thread_id=thread_id,
                data=data,
                arguments=arguments,
            )
        except Exception as exc:
            timestamp = now_iso()
            for row in repo.read_actions():
                if (
                    row.get("CLIENT_REQUEST_ID") == callback_id
                    and normalize_status(row.get("STATUS")) == "PROCESSING"
                ):
                    repo.update_action(
                        int(row["_ROW_NUMBER"]),
                        {
                            "STATUS": "FAILED",
                            "ERROR_MESSAGE": str(exc)[:500],
                            "UPDATED_AT": timestamp,
                        },
                    )
            raise


def verify_webhook_secret(provided: str) -> None:
    expected = os.getenv("HERMES_TASK_CALLBACK_SECRET", "").strip()
    if not expected or not provided or not hmac.compare_digest(expected, provided):
        raise PermissionError("Invalid Telegram webhook secret")


def handle_telegram_update(
    payload: Mapping[str, Any],
    *,
    secret_header: str,
    repo: TaskRepository | None = None,
    telegram: TelegramClient | None = None,
) -> dict[str, Any]:
    verify_webhook_secret(secret_header)
    callback = payload.get("callback_query") or {}
    if not callback:
        return {"ok": True, "ignored": True}
    user = callback.get("from") or {}
    message = callback.get("message") or {}
    chat = message.get("chat") or {}
    result = process_callback(
        repo or SheetsTaskRepository(),
        callback_id=str(callback.get("id", "")),
        username=str(user.get("username", "")),
        chat_id=str(chat.get("id", "")),
        thread_id=str(message.get("message_thread_id", "")),
        data=str(callback.get("data", "")),
    )
    client = telegram or TelegramClient(
        os.getenv("HERMES_TASK_BOT_TOKEN", "").strip()
    )
    callback_text = (
        "Đã xử lý trước đó."
        if result["idempotent"]
        else "Cần bổ sung thông tin."
        if result["result"].get("status") == "NEEDS_INPUT"
        else "TaskFlow đã cập nhật và read-back khớp."
    )
    client.answer_callback(str(callback.get("id", "")), callback_text)
    return {"ok": True, **result}


def migration_plan(repo: TaskRepository) -> dict[str, Any]:
    work = repo.read_work_items()
    subtasks = repo.read_subtasks()
    issues = consistency_check(work, subtasks)
    focus = {"CV-2026-0006", "CV-2026-0013", "CV-2026-0014"}
    return {
        "mode": "DRY_RUN_READ_ONLY",
        "automatic_data_changes": False,
        "issues": [
            {"code": item.code, "work_id": item.work_id, "detail": item.detail}
            for item in issues if item.work_id in focus
        ],
        "note": "Không tự sửa dữ liệu production khi chưa đủ căn cứ nghiệp vụ.",
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("consistency")
    sub.add_parser("migration-plan")
    digest_parser = sub.add_parser("digest")
    digest_parser.add_argument("--send", action="store_true")
    digest_parser.add_argument("--chat-id", default=os.getenv("HERMES_TASK_CHAT_ID", ""))
    digest_parser.add_argument("--thread-id", default=os.getenv("HERMES_TASK_THREAD_ID", ""))
    args = parser.parse_args()
    repo = SheetsTaskRepository()
    if args.command == "migration-plan":
        print(json.dumps(migration_plan(repo), ensure_ascii=False, indent=2))
        return 0
    digest = build_digest(repo.read_work_items(), repo.read_subtasks())
    if args.command == "consistency":
        print(json.dumps([issue.__dict__ for issue in digest.consistency], ensure_ascii=False, indent=2))
        return 0
    if not args.send:
        print(json.dumps(
            {name: [row.get("WORK_ID") for row in rows] for name, rows in digest.groups.items()},
            ensure_ascii=False,
            indent=2,
        ))
        return 0
    if not args.chat_id:
        raise RuntimeError("HERMES_TASK_CHAT_ID or --chat-id is required with --send")
    sent = send_digest(
        repo,
        TelegramClient(os.getenv("HERMES_TASK_BOT_TOKEN", "").strip()),
        chat_id=args.chat_id,
        thread_id=args.thread_id,
    )
    print(json.dumps({"sent": sent}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
