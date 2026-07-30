"""Task-only Hermes digest and owner-scoped Telegram callback processing.

All TaskFlow writes are followed by read-back verification. Callback mutations
are deduplicated through HERMES_ACTION_QUEUE and audited in ACTIVITY_LOG.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import threading
import uuid
from copy import deepcopy
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from typing import Any, Iterable, Mapping, Protocol, Sequence
from zoneinfo import ZoneInfo

import requests

TASKFLOW_SPREADSHEET_ID = os.getenv(
    "TASKFLOW_SPREADSHEET_ID",
    "1l2P0qqojyEKXAiL4cOTwRgJ_1oV5WJQgIQ3mW9zDc48",
).strip()
VN_TZ = ZoneInfo("Asia/Ho_Chi_Minh")

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
USERS_HEADERS = ("EMAIL", "FULL_NAME", "ROLE", "UNIT", "ACTIVE", "CREATED_AT")

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
    "s": "SAFE_SYNC",
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
PROCESSOR_VERSION = "issue-39-v2-polling"
CONTINUE_MARKER = "CONTINUE_AFTER_PARENT=TRUE"
CALLBACK_LOCK = threading.Lock()


class ContractError(RuntimeError):
    """Raised when a live sheet or read-back violates the locked contract."""


class MutationRolledBackError(ContractError):
    """Raised when a failed parent mutation was fully compensated."""


class NeedsReconciliationError(ContractError):
    """Raised when mutation compensation could not be proven by read-back."""


def now_iso() -> str:
    return datetime.now(VN_TZ).isoformat(timespec="seconds")


def today_vn(moment: datetime | None = None) -> date:
    current = moment or datetime.now(timezone.utc)
    if current.tzinfo is None:
        raise ValueError("moment must be timezone-aware")
    return current.astimezone(VN_TZ).date()


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


def usable_assignee(name: Any) -> bool:
    display = str(name or "").strip().casefold()
    if display in {"quản trị hệ thống", "system administrator", "admin", "administrator"}:
        return False
    normalized = normalize_status(name)
    return bool(normalized) and normalized not in {
        "QUAN_TRI_HE_THONG", "SYSTEM_ADMINISTRATOR", "ADMIN", "ADMINISTRATOR",
    }


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


@dataclass(frozen=True)
class CellMutation:
    sheet: str
    row_number: int
    key_field: str
    key_value: str
    before: Mapping[str, str]
    after: Mapping[str, str]
    is_new: bool = False


@dataclass(frozen=True)
class ParentMutationPlan:
    parent_id: str
    mutations: tuple[CellMutation, ...]
    closed_subtasks: tuple[str, ...]
    detached_work_ids: tuple[str, ...]


class TaskRepository(Protocol):
    def read_work_items(self) -> list[dict[str, str]]: ...
    def read_subtasks(self) -> list[dict[str, str]]: ...
    def read_actions(self) -> list[dict[str, str]]: ...
    def read_activity(self) -> list[dict[str, str]]: ...
    def read_assignees(self) -> list[str]: ...
    def update_work(self, row_number: int, fields: Mapping[str, str]) -> None: ...
    def update_subtask(self, row_number: int, fields: Mapping[str, str]) -> None: ...
    def update_action(self, row_number: int, fields: Mapping[str, str]) -> None: ...
    def append_work(self, fields: Mapping[str, str]) -> dict[str, str]: ...
    def append_action(self, fields: Mapping[str, str]) -> dict[str, str]: ...
    def append_activity(self, fields: Mapping[str, str]) -> dict[str, str]: ...
    def apply_mutation_plan(self, plan: ParentMutationPlan) -> None: ...
    def compensate_mutation_plan(self, plan: ParentMutationPlan) -> None: ...


class SheetsTaskRepository:
    """Google Sheets adapter with exact headers and read-back on every write."""

    SHEETS = {
        "WORK_ITEMS": WORK_ITEMS_HEADERS,
        "SUBTASKS": SUBTASK_HEADERS,
        "HERMES_ACTION_QUEUE": ACTION_QUEUE_HEADERS,
        "ACTIVITY_LOG": ACTIVITY_HEADERS,
        "USERS": USERS_HEADERS,
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

    def read_assignees(self) -> list[str]:
        return sorted({
            row.get("FULL_NAME", "").strip()
            for row in self._read("USERS")
            if usable_assignee(row.get("FULL_NAME"))
            and normalize_status(row.get("ACTIVE")) in {"TRUE", "YES", "1", "ACTIVE"}
        })

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

    def _mutation_data(
        self, mutation: CellMutation, values: Mapping[str, str],
    ) -> list[dict[str, Any]]:
        headers = self.SHEETS[mutation.sheet]
        return [
            {
                "range": (
                    f"{mutation.sheet}!"
                    f"{self._column(headers.index(key) + 1)}{mutation.row_number}"
                ),
                "values": [[value]],
            }
            for key, value in values.items()
        ]

    def _verify_plan(self, plan: ParentMutationPlan, *, after: bool) -> None:
        cache: dict[str, list[dict[str, str]]] = {}
        for mutation in plan.mutations:
            if mutation.sheet not in cache:
                cache[mutation.sheet] = self._read(mutation.sheet)
            if mutation.is_new:
                matches = [
                    row for row in cache[mutation.sheet]
                    if row.get(mutation.key_field, "").strip() == mutation.key_value
                ]
                if not after and matches:
                    raise ContractError(
                        f"{mutation.sheet} key already exists: {mutation.key_value}"
                    )
                if not after:
                    continue
                if len(matches) != 1:
                    raise ContractError(
                        f"{mutation.sheet} append read-back expected one "
                        f"{mutation.key_field}={mutation.key_value}; found {len(matches)}"
                    )
                if any(
                    str(matches[0].get(key, "")).strip() != str(value).strip()
                    for key, value in mutation.after.items()
                ):
                    raise ContractError(
                        f"{mutation.sheet} appended record read-back mismatch"
                    )
                continue
            matches = [
                row for row in cache[mutation.sheet]
                if int(row["_ROW_NUMBER"]) == mutation.row_number
            ]
            if not matches:
                raise ContractError(
                    f"{mutation.sheet} row {mutation.row_number} missing during read-back"
                )
            expected = mutation.after if after else mutation.before
            if any(
                str(matches[0].get(key, "")).strip() != str(value).strip()
                for key, value in expected.items()
            ):
                raise ContractError(
                    f"{mutation.sheet} row {mutation.row_number} mutation read-back mismatch"
                )

    def apply_mutation_plan(self, plan: ParentMutationPlan) -> None:
        self._verify_plan(plan, after=False)
        appended = [item for item in plan.mutations if item.is_new]
        existing = [item for item in plan.mutations if not item.is_new]
        try:
            for mutation in appended:
                if mutation.sheet != "WORK_ITEMS":
                    raise ContractError(
                        f"Append mutation is unsupported for {mutation.sheet}"
                    )
                # INSERT_ROWS lets Sheets choose and reserve the destination row.
                # No row number from the earlier snapshot is ever used for new work.
                self.append_work(mutation.after)
            data = [
                item
                for mutation in existing
                for item in self._mutation_data(mutation, mutation.after)
            ]
            if data:
                self.service.spreadsheets().values().batchUpdate(
                    spreadsheetId=self.spreadsheet_id,
                    body={"valueInputOption": "RAW", "data": data},
                ).execute()
            self._verify_plan(plan, after=True)
        except Exception as exc:
            try:
                self.compensate_mutation_plan(plan)
            except Exception as rollback_exc:
                raise NeedsReconciliationError(
                    f"Parent mutation failed and compensation is unverified: {rollback_exc}"
                ) from exc
            raise MutationRolledBackError(
                f"Parent mutation failed and was compensated: {exc}"
            ) from exc

    def compensate_mutation_plan(self, plan: ParentMutationPlan) -> None:
        cache = {
            sheet: self._read(sheet)
            for sheet in {mutation.sheet for mutation in plan.mutations}
        }
        reversible: list[tuple[CellMutation, Mapping[str, str]]] = []
        for mutation in reversed(plan.mutations):
            if mutation.is_new:
                matches = [
                    row for row in cache[mutation.sheet]
                    if row.get(mutation.key_field, "").strip() == mutation.key_value
                ]
                if not matches:
                    continue
                if len(matches) != 1:
                    raise ContractError(
                        "Refusing compensation because appended key is not unique"
                    )
                current = matches[0]
                if any(
                    str(current.get(key, "")).strip() != str(value).strip()
                    for key, value in mutation.after.items()
                ):
                    raise ContractError(
                        "Refusing compensation because appended work changed concurrently"
                    )
                actual = CellMutation(
                    mutation.sheet,
                    int(current["_ROW_NUMBER"]),
                    mutation.key_field,
                    mutation.key_value,
                    mutation.before,
                    mutation.after,
                    True,
                )
                reversible.append(
                    (actual, {key: "" for key in mutation.after})
                )
                continue
            current = next(
                (
                    row for row in cache[mutation.sheet]
                    if int(row["_ROW_NUMBER"]) == mutation.row_number
                ),
                None,
            )
            if current is None:
                raise ContractError("Existing mutation row disappeared")
            current_values = {
                key: current.get(key, "").strip() for key in mutation.after
            }
            after_values = {
                key: str(value).strip() for key, value in mutation.after.items()
            }
            before_values = {
                key: str(mutation.before.get(key, "")).strip()
                for key in mutation.after
            }
            if current_values == before_values:
                continue
            if current_values != after_values:
                raise ContractError(
                    "Refusing compensation because a row changed concurrently"
                )
            reversible.append((mutation, mutation.before))
        data = [
            item
            for mutation, values in reversible
            for item in self._mutation_data(mutation, values)
        ]
        if data:
            self.service.spreadsheets().values().batchUpdate(
                spreadsheetId=self.spreadsheet_id,
                body={"valueInputOption": "RAW", "data": data},
            ).execute()
        existing_plan = ParentMutationPlan(
            plan.parent_id,
            tuple(item for item in plan.mutations if not item.is_new),
            plan.closed_subtasks,
            plan.detached_work_ids,
        )
        self._verify_plan(existing_plan, after=False)
        for mutation in (item for item in plan.mutations if item.is_new):
            if any(
                row.get(mutation.key_field, "").strip() == mutation.key_value
                for row in self._read(mutation.sheet)
            ):
                raise ContractError("New row compensation read-back mismatch")


def consistency_check(
    work_items: Sequence[dict[str, str]],
    subtasks: Sequence[dict[str, str]],
    *,
    today: date | None = None,
) -> list[ConsistencyIssue]:
    effective_today = today or today_vn()
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
                    due and due < effective_today
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
    today = today or today_vn()
    issues = consistency_check(work_items, subtasks, today=today)
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
            sync_record = dict(work)
            sync_record["_SYNC_REQUIRED"] = "TRUE"
            groups["CẦN ĐỒNG BỘ DỮ LIỆU"].append(sync_record)
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


def callback_keyboard(
    work_id: str, *, sync_required: bool = False, allow_transfer: bool = True,
) -> dict[str, list[list[dict[str, str]]]]:
    if sync_required:
        return {
            "inline_keyboard": [[
                {"text": "ℹ️ Chi tiết", "callback_data": f"ht:d:{work_id}"},
                {"text": "🔎 Kiểm tra đồng bộ", "callback_data": f"ht:s:{work_id}"},
            ]]
        }
    rows: list[list[dict[str, str]]] = []
    buttons = [
        item for item in ACTION_BUTTONS
        if allow_transfer or item[1] != "t"
    ]
    for index in range(0, len(buttons), 2):
        row = [
            {"text": label, "callback_data": f"ht:{code}:{work_id}"}
            for label, code in buttons[index:index + 2]
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
        sync_required: bool = False, allow_transfer: bool = True,
    ) -> str:
        payload: dict[str, Any] = {
            "chat_id": chat_id,
            "text": text,
            "reply_markup": callback_keyboard(
                work_id,
                sync_required=sync_required,
                allow_transfer=allow_transfer,
            ),
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
    allow_transfer = bool(repo.read_assignees())
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
                sync_required=group == "CẦN ĐỒNG BỘ DỮ LIỆU",
                allow_transfer=allow_transfer,
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
    return f"CV-CONT-{datetime.now(VN_TZ).strftime('%Y%m%d')}-{suffix}"


def _plan_parent_terminal(
    repo: TaskRepository,
    parent: dict[str, str],
    *,
    action: str,
    arguments: Mapping[str, Any],
    dedupe_key: str,
    timestamp: str,
) -> ParentMutationPlan:
    works = repo.read_work_items()
    children = [
        row for row in repo.read_subtasks()
        if row.get("WORK_ID", "").strip() == parent["WORK_ID"]
    ]
    explicit_continue = {
        str(value).strip()
        for value in arguments.get("continue_subtasks", [])
        if str(value).strip()
    }
    has_explicit_selection = "continue_subtasks" in arguments
    mutations: list[CellMutation] = []
    detached: list[str] = []
    closed: list[str] = []
    child_terminal = "HOAN_THANH" if action == "COMPLETE" else "KHONG_THUC_HIEN"
    for child in children:
        if normalize_status(child.get("STATUS")) in TERMINAL_SUBTASK_STATUSES:
            continue
        if has_explicit_selection:
            should_continue = child.get("SUBTASK_ID", "") in explicit_continue
        else:
            should_continue = (
                action == "COMPLETE"
                and CONTINUE_MARKER in child.get("NOTE", "").upper()
            )
        if should_continue:
            new_id = _detached_work_id(child["SUBTASK_ID"], dedupe_key)
            if any(row.get("WORK_ID") == new_id for row in works):
                raise ContractError(f"Detached WORK_ID already exists: {new_id}")
            new_fields = {
                "WORK_ID": new_id,
                "TITLE": child.get("TITLE", ""),
                "DESCRIPTION": (
                    f"Tách từ {child.get('SUBTASK_ID')} "
                    f"khi đóng {parent.get('WORK_ID')}"
                ),
                "DUE_DATE": child.get("DUE_DATE", ""),
                "STATUS": "IN_PROGRESS",
                "PROGRESS_PERCENT": "0",
                "NEXT_ACTION": child.get("NOTE", "").replace(CONTINUE_MARKER, "").strip(" ;"),
                "CREATED_BY": "HERMES",
                "CREATED_AT": timestamp,
                "UPDATED_BY": "HERMES",
                "UPDATED_AT": timestamp,
                "ACTIVE": "TRUE",
                "SOURCE": "HERMES_PARENT_CLOSE",
                "NOTE": (
                    f"DETACHED_FROM={child.get('SUBTASK_ID')};"
                    f"PARENT={parent.get('WORK_ID')}"
                ),
                "REPORTABLE": "TRUE",
                "WORK_KIND": "TASK",
            }
            mutations.append(CellMutation(
                # Row zero is an explicit sentinel: apply uses Sheets append
                # semantics and must never address a predicted row.
                "WORK_ITEMS", 0, "WORK_ID", new_id, {}, new_fields, True,
            ))
            child_fields = {
                "STATUS": "HOAN_THANH",
                "RESULT": f"Đã tách thành nhiệm vụ độc lập {new_id}",
                "UPDATED_AT": timestamp,
                "NOTE": f"DETACHED_TO={new_id}; {child.get('NOTE', '')}".strip(),
            }
            mutations.append(CellMutation(
                "SUBTASKS", int(child["_ROW_NUMBER"]), "SUBTASK_ID",
                child["SUBTASK_ID"],
                {key: child.get(key, "") for key in child_fields},
                child_fields,
            ))
            detached.append(new_id)
            continue
        child_fields = {
            "STATUS": child_terminal,
            "RESULT": f"Hermes đóng theo nhiệm vụ cha {parent['WORK_ID']}",
            "UPDATED_AT": timestamp,
            "NOTE": f"PARENT_TERMINAL_ACTION={action}; {child.get('NOTE', '')}".strip(),
        }
        mutations.append(CellMutation(
            "SUBTASKS", int(child["_ROW_NUMBER"]), "SUBTASK_ID",
            child["SUBTASK_ID"],
            {key: child.get(key, "") for key in child_fields},
            child_fields,
        ))
        closed.append(child.get("SUBTASK_ID", ""))

    parent_status = "COMPLETED" if action == "COMPLETE" else "NOT_DONE"
    parent_fields = {
        "STATUS": parent_status,
        "PROGRESS_PERCENT": "100",
        "NEXT_ACTION": "",
        "UPDATED_BY": "HERMES",
        "UPDATED_AT": timestamp,
        "COMPLETED_AT": timestamp,
    }
    mutations.append(CellMutation(
        "WORK_ITEMS", int(parent["_ROW_NUMBER"]), "WORK_ID", parent["WORK_ID"],
        {key: parent.get(key, "") for key in parent_fields},
        parent_fields,
    ))
    return ParentMutationPlan(
        parent["WORK_ID"], tuple(mutations), tuple(closed), tuple(detached),
    )


def _apply_parent_terminal(
    repo: TaskRepository,
    parent: dict[str, str],
    *,
    action: str,
    arguments: Mapping[str, Any],
    dedupe_key: str,
    timestamp: str,
) -> dict[str, Any]:
    plan = _plan_parent_terminal(
        repo, parent, action=action, arguments=arguments,
        dedupe_key=dedupe_key, timestamp=timestamp,
    )
    repo.apply_mutation_plan(plan)
    return {
        "closed_subtasks": list(plan.closed_subtasks),
        "detached_work_ids": list(plan.detached_work_ids),
        "status": "COMPLETED" if action == "COMPLETE" else "NOT_DONE",
        "_mutation_plan": plan,
    }


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
    plan = ParentMutationPlan(
        work["WORK_ID"],
        (CellMutation(
            "WORK_ITEMS", int(work["_ROW_NUMBER"]), "WORK_ID", work["WORK_ID"],
            {key: work.get(key, "") for key in fields}, fields,
        ),),
        (), (),
    )
    repo.apply_mutation_plan(plan)
    return {"status": fields["STATUS"], "_mutation_plan": plan}


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
        valid = repo.read_assignees()
        exact = next((name for name in valid if name.casefold() == assignee.casefold()), None)
        if exact is None:
            raise ValueError("TRANSFER assignee is not an active TaskFlow user")
        assignee = exact
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
    plan = ParentMutationPlan(
        child["WORK_ID"],
        (CellMutation(
            "SUBTASKS", int(child["_ROW_NUMBER"]), "SUBTASK_ID",
            child["SUBTASK_ID"],
            {key: child.get(key, "") for key in fields}, fields,
        ),),
        (), (),
    )
    repo.apply_mutation_plan(plan)
    result = {"status": fields.get("STATUS", child.get("STATUS", ""))}
    if "DUE_DATE" in fields:
        result["due_date"] = fields["DUE_DATE"]
    if "ASSIGNEE" in fields:
        result["assignee"] = fields["ASSIGNEE"]
    result["_mutation_plan"] = plan
    return result


def _action_has_complete_evidence(
    repo: TaskRepository,
    action_row: Mapping[str, str],
) -> bool:
    if normalize_status(action_row.get("STATUS")) != "COMPLETED":
        return False
    result_json = action_row.get("RESULT_JSON", "").strip()
    action_id = action_row.get("ACTION_ID", "").strip()
    if not result_json or not action_id:
        return False
    return any(
        row.get("NOTE", "").strip() == f"ACTION_ID={action_id}"
        and row.get("DETAILS_JSON", "").strip() == result_json
        for row in repo.read_activity()
    )


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
    user_id: str,
    username: str,
    chat_id: str,
    thread_id: str,
    data: str,
    arguments: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    expected_user = os.getenv("HERMES_TASK_OWNER_USER_ID", "").strip()
    expected_chat = os.getenv("HERMES_TASK_CHAT_ID", "").strip()
    if not expected_user or not expected_chat:
        raise PermissionError("Numeric Telegram owner/chat authorization is not configured")
    if str(user_id).strip() != expected_user:
        raise PermissionError("Telegram numeric user ID is not allowed")
    if str(chat_id).strip() != expected_chat:
        raise PermissionError("Telegram chat ID is not allowed")
    match = re.fullmatch(r"ht:([cwhpntds]):([A-Za-z0-9_-]{1,48})", data.strip())
    if not match:
        raise ValueError("Invalid callback data")
    action = ACTION_CODES[match.group(1)]
    work_id = match.group(2)
    arguments = dict(arguments or {})
    works = [
        row for row in repo.read_work_items()
        if row.get("WORK_ID", "").strip() == work_id
    ]
    children = [
        row for row in repo.read_subtasks()
        if row.get("SUBTASK_ID", "").strip() == work_id
    ]
    if action not in {"DETAIL", "SAFE_SYNC"} and len(works) + len(children) != 1:
        raise ContractError(
            f"Mutation blocked for ambiguous task {work_id}: "
            f"work={len(works)} subtask={len(children)}"
        )
    if action in {"DETAIL", "SAFE_SYNC"}:
        if not works and not children:
            raise ContractError(f"Task {work_id} not found")
        task_kind = "WORK" if works else "SUBTASK"
        work = (works or children)[0]
    else:
        task_kind, work = ("WORK", works[0]) if works else ("SUBTASK", children[0])
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
    complete_same_action = [
        row for row in same_action if _action_has_complete_evidence(repo, row)
    ]
    can_reuse = (
        _state_already_applied(task_kind, work, action, arguments)
        or action in {"DETAIL", "SAFE_SYNC"}
        or (action in {"POSTPONE", "TRANSFER"} and not arguments)
    )
    if complete_same_action and can_reuse:
        result = complete_same_action[-1].get("RESULT_JSON", "").strip()
        return {
            "idempotent": True,
            "action_id": complete_same_action[-1].get("ACTION_ID", ""),
            "result": json.loads(result) if result else {},
        }
    already_applied = _state_already_applied(task_kind, work, action, arguments)
    if already_applied and any(
        normalize_status(row.get("STATUS")) in {"FAILED", "NEEDS_RECONCILIATION"}
        for row in same_action
    ):
        raise NeedsReconciliationError(
            "Task state exists without complete action/audit evidence"
        )
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
    mutation_plan: ParentMutationPlan | None = None
    if already_applied:
        result = {"status": work.get("STATUS", ""), "noop": True}
    elif action in {"DETAIL", "SAFE_SYNC"}:
        records = works + children
        issues = consistency_check(
            repo.read_work_items(), repo.read_subtasks(), today=today_vn(),
        )
        result = {
            "work_id": work_id,
            "matches": [
                {
                    "kind": "WORK" if "WORK_ID" in row and "SUBTASK_ID" not in row else "SUBTASK",
                    "title": row.get("TITLE", ""),
                    "status": row.get("STATUS", ""),
                    "due_date": row.get("DUE_DATE", ""),
                }
                for row in records
            ],
            "consistency_issues": [
                {"code": issue.code, "detail": issue.detail}
                for issue in issues if issue.work_id == work_id
            ],
            "status": "SAFE_SYNC_REVIEW" if action == "SAFE_SYNC" else old_status,
        }
    elif task_kind == "SUBTASK":
        result = _apply_subtask_action(repo, work, action, arguments, timestamp)
    elif action in {"POSTPONE", "TRANSFER"} and not arguments:
        result = {
            "status": "NEEDS_INPUT",
            "required": "due_date" if action == "POSTPONE" else "assignee",
        }
    elif action == "POSTPONE":
        due_date = str(arguments.get("due_date", "")).strip()
        parsed_due = parse_date(due_date)
        if parsed_due is None or parsed_due <= today_vn():
            raise ValueError("POSTPONE requires a future due_date")
        fields = {
            "DUE_DATE": due_date, "UPDATED_BY": "HERMES", "UPDATED_AT": timestamp,
        }
        mutation_plan = ParentMutationPlan(
            work_id,
            (CellMutation(
                "WORK_ITEMS", int(work["_ROW_NUMBER"]), "WORK_ID", work_id,
                {key: work.get(key, "") for key in fields}, fields,
            ),),
            (), (),
        )
        repo.apply_mutation_plan(mutation_plan)
        result = {"status": work.get("STATUS", ""), "due_date": due_date}
    elif action == "TRANSFER":
        assignee = str(arguments.get("assignee", "")).strip()
        if not assignee:
            raise ValueError("TRANSFER requires assignee")
        valid = repo.read_assignees()
        exact = next((name for name in valid if name.casefold() == assignee.casefold()), None)
        if exact is None:
            raise ValueError("TRANSFER assignee is not an active TaskFlow user")
        assignee = exact
        fields = {
            "ASSIGNEE_NAME": assignee,
            "UPDATED_BY": "HERMES",
            "UPDATED_AT": timestamp,
        }
        mutation_plan = ParentMutationPlan(
            work_id,
            (CellMutation(
                "WORK_ITEMS", int(work["_ROW_NUMBER"]), "WORK_ID", work_id,
                {key: work.get(key, "") for key in fields}, fields,
            ),),
            (), (),
        )
        repo.apply_mutation_plan(mutation_plan)
        result = {"status": work.get("STATUS", ""), "assignee": assignee}
    elif action in {"COMPLETE", "NOT_DONE"}:
        result = _apply_parent_terminal(
            repo,
            work,
            action=action,
            arguments=arguments,
            dedupe_key=dedupe_key,
            timestamp=timestamp,
        )
        mutation_plan = result.pop("_mutation_plan")
    else:
        result = _apply_simple_action(repo, work, action, timestamp)
        mutation_plan = result.pop("_mutation_plan")

    if task_kind == "SUBTASK" and "_mutation_plan" in result:
        mutation_plan = result.pop("_mutation_plan")

    audit_side_effect = False
    try:
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
                    "ACTOR_EMAIL": (
                        f"telegram:{user_id}"
                        + (f" (@{username})" if username.strip() else "")
                    ),
                    "CREATED_AT": completed,
                    "EVENT_TYPE": "HERMES_TASK_CALLBACK",
                    "OLD_VALUE": old_status,
                    "NEW_VALUE": str(result.get("status", "")),
                    "NOTE": f"ACTION_ID={action_id}",
                    "SOURCE": "HERMES_TELEGRAM",
                }
            )
            audit_side_effect = True
        else:
            audit_side_effect = True
        activity = [row for row in repo.read_activity() if row.get("LOG_ID") == log_id]
        if len(activity) != 1 or activity[0].get("DETAILS_JSON", "").strip() != result_json:
            raise ContractError("Activity audit read-back mismatch")
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
        if (
            len(verified) != 1
            or verified[0].get("RESULT_JSON", "").strip() != result_json
            or verified[0].get("STATUS") not in {"COMPLETED", "NEEDS_INPUT"}
        ):
            raise ContractError("Action queue read-back mismatch")
    except Exception as exc:
        if mutation_plan is not None:
            try:
                repo.compensate_mutation_plan(mutation_plan)
            except Exception as rollback_exc:
                raise NeedsReconciliationError(
                    f"Post-mutation record failed and compensation is unverified: {rollback_exc}"
                ) from exc
            if audit_side_effect:
                raise NeedsReconciliationError(
                    "Task mutation was compensated but audit/action completion "
                    "requires reconciliation"
                ) from exc
            raise MutationRolledBackError(
                f"Post-mutation record failed and mutation plan was compensated: {exc}"
            ) from exc
        raise
    return {"idempotent": False, "action_id": action_id, "result": result}


def process_callback(
    repo: TaskRepository,
    *,
    callback_id: str,
    user_id: str,
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
                user_id=user_id,
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
                            "STATUS": (
                                "NEEDS_RECONCILIATION"
                                if isinstance(exc, NeedsReconciliationError)
                                else "FAILED"
                            ),
                            "ERROR_MESSAGE": str(exc)[:500],
                            "UPDATED_AT": timestamp,
                        },
                    )
            raise


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
    if normalize_status(os.getenv("TASK_ONLY_MODE")) not in {"TRUE", "YES", "1"}:
        raise RuntimeError("TASK_ONLY_MODE=true is required before sending a digest")
    sent = send_digest(
        repo,
        TelegramClient(os.getenv("TELEGRAM_BOT_TOKEN", "").strip()),
        chat_id=args.chat_id,
        thread_id=args.thread_id,
    )
    print(json.dumps({"sent": sent}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
