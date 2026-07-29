"""Read-only TalkFlow Routes V2 runner with a single RUN_LOG write target."""
from __future__ import annotations

import argparse
import json
import os
import sys
import uuid
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from typing import Any, Callable, Iterable, Mapping, Sequence
from zoneinfo import ZoneInfo

TALKFLOW_SPREADSHEET_ID = "1l2P0qqojyEKXAiL4cOTwRgJ_1oV5WJQgIQ3mW9zDc48"
OPS_SPREADSHEET_ID = "1a4_5bzNDbXiHdr2Nj76QHm6LY85wCKqI7RWTt-O6G18"
CONTROL_SPREADSHEET_ID = "1PjdF0aP8Ar7Nvp7BkX8jcHrjsoGOoMboZQLow_z_lzs"

WORK_ITEMS_RANGE = "WORK_ITEMS!A1:AT2000"
MD_SYNC_STATUS_RANGE = "MD_SYNC_STATUS!A1:K1000"
SYNC_JOBS_RANGE = "SYNC_JOBS!A1:Z1000"
BACKUP_LOGS_RANGE = "BACKUP_LOGS!A1:Z1000"
ERROR_LOGS_RANGE = "ERROR_LOGS!A1:Z1000"
RUN_LOG_RANGE = "RUN_LOG!A:J"

ROUTE_DUE_CHECK = "RT-DUE-CHECK-01"
ROUTE_FILE_SYNC = "RT-FILE-SYNC-01"
ROUTE_OPS_HEALTH = "RT-OPS-HEALTH-01"
ROUTE_IDS = (ROUTE_DUE_CHECK, ROUTE_FILE_SYNC, ROUTE_OPS_HEALTH)

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
MD_SYNC_STATUS_HEADERS = (
    "HS_CODE", "MD_FILE_ID", "MD_FILE_URL", "LAST_SYNC_AT", "LAST_SCANNED_AT",
    "LAST_FILE_MODIFIED_AT", "NEW_FILE_COUNT", "CHANGED_FILE_COUNT",
    "CHANGED_FILE_IDS", "SYNC_STATUS", "NOTE",
)
SYNC_JOBS_HEADERS = (
    "sync_job_id", "source_id", "direction", "trigger_type", "started_by",
    "started_at", "completed_at", "read_count", "write_count", "skip_count",
    "error_count", "status", "result_summary",
)
BACKUP_LOGS_HEADERS = (
    "backup_id", "backup_type", "environment", "source_ids_json",
    "drive_folder_id", "backup_file_ids_json", "started_at", "completed_at",
    "status", "checksum", "retention_until", "created_by",
)
ERROR_LOGS_HEADERS = (
    "error_id", "error_code", "service", "operation", "message",
    "stack_summary", "context_json", "severity", "correlation_id",
    "occurred_at", "resolved_by", "resolved_at", "status",
)
RUN_LOG_HEADERS = (
    "RUN_ID", "ROUTE_ID", "STARTED_AT", "FINISHED_AT", "STATUS", "ITEMS_READ",
    "OUTPUT_ID", "ERROR", "VERIFIED_AT", "NOTES",
)

LOCAL_TZ = ZoneInfo("Asia/Ho_Chi_Minh")
TERMINAL_WORK_STATUSES = {
    "COMPLETE", "COMPLETED", "DONE", "CANCELLED", "CANCELED", "HUY", "ĐÃ_HỦY",
}
SYNC_ATTENTION_STATUSES = {
    "NEEDS_SYNC", "NEED_SYNC", "SYNC_REQUIRED", "PENDING", "OUT_OF_SYNC",
    "CHANGES_DETECTED", "CHANGED", "DIRTY", "STALE", "FAILED", "FAIL", "ERROR",
}
FAILED_STATUSES = {"FAILED", "FAIL", "ERROR"}
RESOLVED_STATUSES = {"RESOLVED", "CLOSED", "DONE"}


class ContractError(RuntimeError):
    """Raised when a locked sheet contract is not satisfied."""


@dataclass(frozen=True)
class RouteResult:
    status: str
    items_read: int
    summary: dict[str, Any]


def now_local() -> datetime:
    return datetime.now(LOCAL_TZ)


def iso_local(value: datetime) -> str:
    if value.tzinfo is None:
        value = value.replace(tzinfo=LOCAL_TZ)
    return value.astimezone(LOCAL_TZ).isoformat(timespec="seconds")


def _text(value: Any) -> str:
    return "" if value is None else str(value).strip()


def _normalized(value: Any) -> str:
    return _text(value).upper().replace("-", "_").replace(" ", "_")


def _truthy(value: Any) -> bool:
    return value is True or _normalized(value) in {"TRUE", "1", "YES", "Y"}


def _integer(value: Any) -> int:
    try:
        return int(float(_text(value) or "0"))
    except ValueError:
        return 0


def _parse_date(value: Any) -> date | None:
    text = _text(value)
    if not text:
        return None
    iso_candidate = text.replace("Z", "+00:00")
    try:
        return datetime.fromisoformat(iso_candidate).date()
    except ValueError:
        pass
    for pattern in ("%d/%m/%Y", "%d-%m-%Y", "%Y/%m/%d", "%m/%d/%Y"):
        try:
            return datetime.strptime(text, pattern).date()
        except ValueError:
            continue
    return None


def _parse_datetime(value: Any) -> datetime | None:
    text = _text(value)
    if not text:
        return None
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
        return parsed.replace(tzinfo=LOCAL_TZ) if parsed.tzinfo is None else parsed
    except ValueError:
        parsed_date = _parse_date(text)
        if parsed_date:
            return datetime.combine(parsed_date, datetime.min.time(), LOCAL_TZ)
    return None


def _is_explicit_uat_error(row: Mapping[str, Any]) -> bool:
    """Return True only for a valid JSON object with exact Boolean ``uat: true``.

    The check is intentionally fail-closed: invalid JSON, non-object JSON, or a
    string value such as ``"true"`` remains production-visible.
    """

    context_text = _text(row.get("context_json"))
    if not context_text:
        return False
    try:
        context = json.loads(context_text)
    except (TypeError, ValueError, json.JSONDecodeError):
        return False
    return isinstance(context, dict) and context.get("uat") is True


def validate_header(actual: Sequence[Any], expected: Sequence[str], label: str) -> None:
    normalized_actual = tuple(_text(value) for value in actual)
    if normalized_actual != tuple(expected):
        raise ContractError(
            f"{label} header mismatch: expected {len(expected)} locked columns, "
            f"received {len(normalized_actual)}"
        )


def rows_as_dicts(
    values: Sequence[Sequence[Any]], expected_headers: Sequence[str], label: str
) -> list[dict[str, Any]]:
    if not values:
        raise ContractError(f"{label} is empty and has no header")
    validate_header(values[0], expected_headers, label)
    records: list[dict[str, Any]] = []
    for source_row in values[1:]:
        if not any(_text(value) for value in source_row):
            continue
        padded = list(source_row[: len(expected_headers)])
        padded.extend([""] * (len(expected_headers) - len(padded)))
        records.append(dict(zip(expected_headers, padded)))
    return records


def evaluate_due_check(values: Sequence[Sequence[Any]], today: date | None = None) -> RouteResult:
    records = rows_as_dicts(values, WORK_ITEMS_HEADERS, "WORK_ITEMS")
    effective_today = today or now_local().date()
    overdue: list[str] = []
    due_today: list[str] = []
    due_soon: list[str] = []
    for row in records:
        if not _truthy(row["ACTIVE"]):
            continue
        status = _normalized(row["STATUS"])
        if status in TERMINAL_WORK_STATUSES:
            continue
        due_value = (
            row["WAITING_DUE_DATE"]
            if status == "WAITING" and _text(row["WAITING_DUE_DATE"])
            else row["DUE_DATE"]
        )
        due_date = _parse_date(due_value)
        if due_date is None:
            continue
        work_id = _text(row["WORK_ID"]) or "(missing WORK_ID)"
        if due_date < effective_today:
            overdue.append(work_id)
        elif due_date == effective_today:
            due_today.append(work_id)
        elif due_date <= effective_today + timedelta(days=7):
            due_soon.append(work_id)
    warning_count = len(overdue) + len(due_today) + len(due_soon)
    summary = {
        "records_read": len(records),
        "warning_tasks": warning_count,
        "overdue": len(overdue),
        "due_today": len(due_today),
        "due_within_7_days": len(due_soon),
        "work_ids": (overdue + due_today + due_soon)[:20],
    }
    return RouteResult(
        "PASS_WITH_WARNING" if warning_count else "PASS", len(records), summary
    )


def _sync_status_needs_attention(value: Any) -> bool:
    status = _normalized(value)
    return status in SYNC_ATTENTION_STATUSES or (
        bool(status) and any(token in status for token in ("NEED_SYNC", "REQUIRED", "OUT_OF_SYNC"))
    )


def evaluate_file_sync(values: Sequence[Sequence[Any]]) -> RouteResult:
    records = rows_as_dicts(values, MD_SYNC_STATUS_HEADERS, "MD_SYNC_STATUS")
    attention_codes: list[str] = []
    total_new = 0
    total_changed = 0
    for row in records:
        new_count = _integer(row["NEW_FILE_COUNT"])
        changed_count = _integer(row["CHANGED_FILE_COUNT"])
        total_new += max(new_count, 0)
        total_changed += max(changed_count, 0)
        needs_attention = (
            new_count > 0
            or changed_count > 0
            or bool(_text(row["CHANGED_FILE_IDS"]))
            or _sync_status_needs_attention(row["SYNC_STATUS"])
        )
        if needs_attention:
            attention_codes.append(_text(row["HS_CODE"]) or "(missing HS_CODE)")
    summary = {
        "records_read": len(records),
        "changed_dossiers": len(attention_codes),
        "new_files": total_new,
        "changed_files": total_changed,
        "hs_codes": attention_codes[:20],
    }
    return RouteResult(
        "PASS_WITH_WARNING" if attention_codes else "PASS", len(records), summary
    )


def _latest(records: Sequence[Mapping[str, Any]], fields: Iterable[str]) -> Mapping[str, Any] | None:
    dated: list[tuple[datetime, Mapping[str, Any]]] = []
    for row in records:
        parsed = next(
            (
                candidate
                for field in fields
                if (candidate := _parse_datetime(row.get(field))) is not None
            ),
            None,
        )
        if parsed:
            dated.append((parsed, row))
    return max(dated, key=lambda item: item[0])[1] if dated else None


def evaluate_ops_health(
    sync_values: Sequence[Sequence[Any]],
    backup_values: Sequence[Sequence[Any]],
    error_values: Sequence[Sequence[Any]],
    *,
    current_time: datetime | None = None,
    stale_hours: int = 48,
) -> RouteResult:
    sync_records = rows_as_dicts(sync_values, SYNC_JOBS_HEADERS, "SYNC_JOBS")
    backup_records = rows_as_dicts(backup_values, BACKUP_LOGS_HEADERS, "BACKUP_LOGS")
    error_records = rows_as_dicts(error_values, ERROR_LOGS_HEADERS, "ERROR_LOGS")
    production_error_records = [
        row for row in error_records if not _is_explicit_uat_error(row)
    ]
    excluded_uat_error_records = len(error_records) - len(production_error_records)
    items_read = len(sync_records) + len(backup_records) + len(error_records)
    failures: list[str] = []
    warnings: list[str] = []

    for row in production_error_records:
        severity = _normalized(row["severity"])
        status = _normalized(row["status"])
        resolved = bool(_text(row["resolved_at"]) or _text(row["resolved_by"])) or status in RESOLVED_STATUSES
        if severity in {"HIGH", "CRITICAL"} and not resolved:
            failures.append(f"unresolved_{severity.lower()}_error")

    latest_sync = _latest(sync_records, ("completed_at", "started_at"))
    latest_backup = _latest(backup_records, ("completed_at", "started_at"))
    latest_production_error = _latest(production_error_records, ("occurred_at",))
    if latest_sync and _normalized(latest_sync["status"]) in FAILED_STATUSES:
        failures.append("latest_sync_failed")
    if latest_backup and _normalized(latest_backup["status"]) in FAILED_STATUSES:
        failures.append("latest_backup_failed")

    reference_time = current_time or now_local()
    if reference_time.tzinfo is None:
        reference_time = reference_time.replace(tzinfo=LOCAL_TZ)
    stale_before = reference_time - timedelta(hours=stale_hours)
    for label, records, latest_row, fields in (
        ("sync", sync_records, latest_sync, ("completed_at", "started_at")),
        ("backup", backup_records, latest_backup, ("completed_at", "started_at")),
        (
            "error",
            production_error_records,
            latest_production_error,
            ("occurred_at",),
        ),
    ):
        if not records:
            if label == "error" and excluded_uat_error_records:
                continue
            warnings.append(f"{label}_tab_empty")
            continue
        latest_time = next(
            (_parse_datetime(latest_row.get(field)) for field in fields if latest_row and latest_row.get(field)),
            None,
        )
        if latest_time and latest_time.astimezone(LOCAL_TZ) < stale_before.astimezone(LOCAL_TZ):
            warnings.append(f"{label}_data_stale")
        elif latest_time is None:
            warnings.append(f"{label}_latest_timestamp_invalid")

    if failures:
        status = "FAIL"
    elif warnings:
        status = "PASS_WITH_WARNING"
    else:
        status = "PASS"
    return RouteResult(
        status,
        items_read,
        {
            "records_read": items_read,
            "sync_records": len(sync_records),
            "backup_records": len(backup_records),
            "error_records": len(error_records),
            "production_error_records": len(production_error_records),
            "excluded_uat_error_records": excluded_uat_error_records,
            "failures": sorted(set(failures)),
            "warnings": sorted(set(warnings)),
        },
    )


class SheetsGateway:
    """Google Sheets gateway whose only write method is locked to RUN_LOG."""

    def __init__(self, service: Any | None = None) -> None:
        if service is None:
            from google.auth import default as google_auth_default
            from googleapiclient.discovery import build

            credentials, _ = google_auth_default(
                scopes=["https://www.googleapis.com/auth/spreadsheets"]
            )
            service = build("sheets", "v4", credentials=credentials, cache_discovery=False)
        self.service = service

    def read_values(self, spreadsheet_id: str, range_name: str) -> list[list[Any]]:
        result = (
            self.service.spreadsheets()
            .values()
            .get(
                spreadsheetId=spreadsheet_id,
                range=range_name,
                valueRenderOption="FORMATTED_VALUE",
                dateTimeRenderOption="FORMATTED_STRING",
            )
            .execute()
        )
        return result.get("values", [])

    def append_and_verify_run_log(self, row: Sequence[Any]) -> list[Any]:
        if len(row) != len(RUN_LOG_HEADERS):
            raise ContractError("RUN_LOG append must contain exactly 10 columns")
        response = (
            self.service.spreadsheets()
            .values()
            .append(
                spreadsheetId=CONTROL_SPREADSHEET_ID,
                range=RUN_LOG_RANGE,
                valueInputOption="RAW",
                insertDataOption="INSERT_ROWS",
                body={"values": [list(row)]},
            )
            .execute()
        )
        updated_range = response.get("updates", {}).get("updatedRange")
        if not updated_range:
            raise ContractError("RUN_LOG append response did not identify updatedRange")
        read_back = self.read_values(CONTROL_SPREADSHEET_ID, updated_range)
        if len(read_back) != 1:
            raise ContractError("RUN_LOG read-back did not return exactly one row")
        verified = list(read_back[0])
        if len(verified) < len(RUN_LOG_HEADERS):
            verified.extend([""] * (len(RUN_LOG_HEADERS) - len(verified)))
        for index, label in ((0, "RUN_ID"), (1, "ROUTE_ID"), (4, "STATUS")):
            if _text(verified[index]) != _text(row[index]):
                raise ContractError(f"RUN_LOG read-back verification failed for {label}")
        return verified


def execute_route(
    route_id: str,
    gateway: SheetsGateway,
    *,
    smoke_test: bool = False,
    clock: Callable[[], datetime] = now_local,
) -> tuple[dict[str, Any], int]:
    started = clock()
    run_id = (
        f"RUN-{started.strftime('%Y%m%d-%H%M%S')}-{route_id}-"
        f"{uuid.uuid4().hex[:6].upper()}"
    )
    error = ""
    try:
        if route_id == ROUTE_DUE_CHECK:
            result = evaluate_due_check(
                gateway.read_values(TALKFLOW_SPREADSHEET_ID, WORK_ITEMS_RANGE),
                started.date(),
            )
        elif route_id == ROUTE_FILE_SYNC:
            result = evaluate_file_sync(
                gateway.read_values(TALKFLOW_SPREADSHEET_ID, MD_SYNC_STATUS_RANGE)
            )
        elif route_id == ROUTE_OPS_HEALTH:
            stale_hours = int(os.getenv("HERMES_OPS_STALE_HOURS", "48"))
            result = evaluate_ops_health(
                gateway.read_values(OPS_SPREADSHEET_ID, SYNC_JOBS_RANGE),
                gateway.read_values(OPS_SPREADSHEET_ID, BACKUP_LOGS_RANGE),
                gateway.read_values(OPS_SPREADSHEET_ID, ERROR_LOGS_RANGE),
                current_time=started,
                stale_hours=stale_hours,
            )
        else:
            raise ValueError(f"Unsupported route: {route_id}")
    except Exception as exc:
        error = f"{type(exc).__name__}: {exc}"[:500]
        result = RouteResult("FAIL", 0, {"failure": "source_read_or_evaluation_failed"})

    finished = clock()
    notes_prefix = "SMOKE_TEST; " if smoke_test else ""
    notes = notes_prefix + json.dumps(
        result.summary, ensure_ascii=False, separators=(",", ":")
    )
    row = [
        run_id,
        route_id,
        iso_local(started),
        iso_local(finished),
        result.status,
        int(result.items_read),
        "",
        error,
        iso_local(clock()),
        notes[:5000],
    ]
    gateway.append_and_verify_run_log(row)
    payload = {
        "run_id": run_id,
        "route_id": route_id,
        "status": result.status,
        "items_read": result.items_read,
        "verified": True,
        "smoke_test": smoke_test,
        "summary": result.summary,
    }
    if error:
        payload["error"] = error
    return payload, 0 if result.status != "FAIL" else 1


def self_test() -> dict[str, Any]:
    contracts = (
        (WORK_ITEMS_HEADERS, 46, "WORK_ITEMS"),
        (MD_SYNC_STATUS_HEADERS, 11, "MD_SYNC_STATUS"),
        (SYNC_JOBS_HEADERS, 13, "SYNC_JOBS"),
        (BACKUP_LOGS_HEADERS, 12, "BACKUP_LOGS"),
        (ERROR_LOGS_HEADERS, 13, "ERROR_LOGS"),
        (RUN_LOG_HEADERS, 10, "RUN_LOG"),
    )
    for headers, expected_count, label in contracts:
        if len(headers) != expected_count or len(set(headers)) != expected_count:
            raise ContractError(f"{label} self-test contract failed")
    if set(ROUTE_IDS) != {
        ROUTE_DUE_CHECK, ROUTE_FILE_SYNC, ROUTE_OPS_HEALTH
    }:
        raise ContractError("Route ID self-test failed")
    return {
        "status": "PASS",
        "contracts_checked": len(contracts),
        "routes_checked": len(ROUTE_IDS),
        "write_target": f"{CONTROL_SPREADSHEET_ID}/{RUN_LOG_RANGE}",
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    for command in ("run", "smoke"):
        command_parser = subparsers.add_parser(command)
        command_parser.add_argument("--route", choices=ROUTE_IDS, required=True)
    subparsers.add_parser("self-test")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.command == "self-test":
        print(json.dumps(self_test(), ensure_ascii=False))
        return 0
    try:
        payload, exit_code = execute_route(
            args.route, SheetsGateway(), smoke_test=args.command == "smoke"
        )
    except Exception as exc:
        print(
            json.dumps(
                {
                    "route_id": args.route,
                    "status": "FAIL",
                    "audit_verified": False,
                    "error": f"{type(exc).__name__}: {exc}",
                },
                ensure_ascii=False,
            ),
            file=sys.stderr,
        )
        return 2
    print(json.dumps(payload, ensure_ascii=False))
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
