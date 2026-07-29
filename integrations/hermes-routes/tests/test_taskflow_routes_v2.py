from __future__ import annotations

import importlib.util
import sys
import unittest
from datetime import date, datetime
from pathlib import Path
from unittest.mock import patch

MODULE_PATH = Path(__file__).parents[1] / "src" / "taskflow_routes_v2.py"
SPEC = importlib.util.spec_from_file_location("taskflow_routes_v2", MODULE_PATH)
routes = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = routes
assert SPEC.loader is not None
SPEC.loader.exec_module(routes)


def sheet(headers, *rows):
    return [list(headers), *[list(row) for row in rows]]


def row_for(headers, **values):
    return [values.get(header, "") for header in headers]


class FakeGateway:
    def __init__(self, values_by_key):
        self.values_by_key = values_by_key
        self.read_calls = []
        self.appended = []

    def read_values(self, spreadsheet_id, range_name):
        self.read_calls.append((spreadsheet_id, range_name))
        return self.values_by_key[(spreadsheet_id, range_name)]

    def append_and_verify_run_log(self, row):
        self.appended.append(list(row))
        return list(row)


class FakeExecute:
    def __init__(self, result):
        self.result = result

    def execute(self):
        return self.result


class FakeValuesApi:
    def __init__(self):
        self.append_kwargs = None
        self.get_kwargs = None

    def append(self, **kwargs):
        self.append_kwargs = kwargs
        return FakeExecute({"updates": {"updatedRange": "RUN_LOG!A12:J12"}})

    def get(self, **kwargs):
        self.get_kwargs = kwargs
        return FakeExecute(
            {"values": [["RUN-X", routes.ROUTE_DUE_CHECK, "", "", "PASS", 1, "", "", "", "ok"]]}
        )


class FakeService:
    def __init__(self, values_api):
        self.values_api = values_api

    def spreadsheets(self):
        return self

    def values(self):
        return self.values_api


class TalkFlowRoutesV2Tests(unittest.TestCase):
    def test_01_work_items_header_contract(self):
        expected = (
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
        self.assertEqual(routes.WORK_ITEMS_HEADERS, expected)
        routes.validate_header(
            list(expected), routes.WORK_ITEMS_HEADERS, "WORK_ITEMS"
        )
        with self.assertRaises(routes.ContractError):
            routes.validate_header(["WORK_ID"], routes.WORK_ITEMS_HEADERS, "WORK_ITEMS")

    def test_02_md_sync_status_header_contract(self):
        expected = (
            "HS_CODE", "MD_FILE_ID", "MD_FILE_URL", "LAST_SYNC_AT",
            "LAST_SCANNED_AT", "LAST_FILE_MODIFIED_AT", "NEW_FILE_COUNT",
            "CHANGED_FILE_COUNT", "CHANGED_FILE_IDS", "SYNC_STATUS", "NOTE",
        )
        self.assertEqual(routes.MD_SYNC_STATUS_HEADERS, expected)
        routes.validate_header(
            list(expected),
            routes.MD_SYNC_STATUS_HEADERS,
            "MD_SYNC_STATUS",
        )

    def test_03_sync_jobs_header_contract(self):
        expected = (
            "sync_job_id", "source_id", "direction", "trigger_type", "started_by",
            "started_at", "completed_at", "read_count", "write_count", "skip_count",
            "error_count", "status", "result_summary",
        )
        self.assertEqual(routes.SYNC_JOBS_HEADERS, expected)
        routes.validate_header(
            list(expected), routes.SYNC_JOBS_HEADERS, "SYNC_JOBS"
        )

    def test_04_backup_logs_header_contract(self):
        expected = (
            "backup_id", "backup_type", "environment", "source_ids_json",
            "drive_folder_id", "backup_file_ids_json", "started_at", "completed_at",
            "status", "checksum", "retention_until", "created_by",
        )
        self.assertEqual(routes.BACKUP_LOGS_HEADERS, expected)
        routes.validate_header(
            list(expected), routes.BACKUP_LOGS_HEADERS, "BACKUP_LOGS"
        )

    def test_05_error_logs_header_contract(self):
        expected = (
            "error_id", "error_code", "service", "operation", "message",
            "stack_summary", "context_json", "severity", "correlation_id",
            "occurred_at", "resolved_by", "resolved_at", "status",
        )
        self.assertEqual(routes.ERROR_LOGS_HEADERS, expected)
        routes.validate_header(
            list(expected), routes.ERROR_LOGS_HEADERS, "ERROR_LOGS"
        )

    def test_06_run_log_header_contract(self):
        expected = (
            "RUN_ID", "ROUTE_ID", "STARTED_AT", "FINISHED_AT", "STATUS",
            "ITEMS_READ", "OUTPUT_ID", "ERROR", "VERIFIED_AT", "NOTES",
        )
        self.assertEqual(routes.RUN_LOG_HEADERS, expected)
        routes.validate_header(
            list(expected), routes.RUN_LOG_HEADERS, "RUN_LOG"
        )

    def test_07_completed_and_cancelled_tasks_are_excluded(self):
        values = sheet(
            routes.WORK_ITEMS_HEADERS,
            row_for(
                routes.WORK_ITEMS_HEADERS,
                WORK_ID="DONE-1",
                ACTIVE="TRUE",
                STATUS="COMPLETED",
                DUE_DATE="2026-07-20",
            ),
            row_for(
                routes.WORK_ITEMS_HEADERS,
                WORK_ID="CANCEL-1",
                ACTIVE=True,
                STATUS="CANCELLED",
                DUE_DATE="2026-07-20",
            ),
        )
        result = routes.evaluate_due_check(values, date(2026, 7, 25))
        self.assertEqual(result.summary["warning_tasks"], 0)

    def test_08_waiting_due_date_overrides_due_date(self):
        values = sheet(
            routes.WORK_ITEMS_HEADERS,
            row_for(
                routes.WORK_ITEMS_HEADERS,
                WORK_ID="WAIT-1",
                ACTIVE="TRUE",
                STATUS="WAITING",
                DUE_DATE="2026-07-20",
                WAITING_DUE_DATE="2026-07-30",
            ),
        )
        result = routes.evaluate_due_check(values, date(2026, 7, 25))
        self.assertEqual(result.summary["overdue"], 0)
        self.assertEqual(result.summary["due_within_7_days"], 1)

    def test_09_new_and_changed_files_are_detected(self):
        values = sheet(
            routes.MD_SYNC_STATUS_HEADERS,
            row_for(
                routes.MD_SYNC_STATUS_HEADERS,
                HS_CODE="HS-1",
                NEW_FILE_COUNT="2",
                CHANGED_FILE_COUNT="1",
                SYNC_STATUS="SYNCED",
            ),
            row_for(
                routes.MD_SYNC_STATUS_HEADERS,
                HS_CODE="HS-2",
                CHANGED_FILE_IDS="file-9",
                SYNC_STATUS="SYNCED",
            ),
            row_for(
                routes.MD_SYNC_STATUS_HEADERS,
                HS_CODE="HS-3",
                SYNC_STATUS="OUT_OF_SYNC",
            ),
        )
        result = routes.evaluate_file_sync(values)
        self.assertEqual(result.summary["changed_dossiers"], 3)
        self.assertEqual(result.summary["new_files"], 2)
        self.assertEqual(result.summary["changed_files"], 1)

    def test_10_ops_empty_is_pass_with_warning(self):
        result = routes.evaluate_ops_health(
            sheet(routes.SYNC_JOBS_HEADERS),
            sheet(routes.BACKUP_LOGS_HEADERS),
            sheet(routes.ERROR_LOGS_HEADERS),
            current_time=datetime(2026, 7, 25, tzinfo=routes.LOCAL_TZ),
        )
        self.assertEqual(result.status, "PASS_WITH_WARNING")
        self.assertEqual(result.items_read, 0)
        self.assertIn("sync_tab_empty", result.summary["warnings"])

    def test_11_ops_unresolved_high_is_fail(self):
        result = routes.evaluate_ops_health(
            sheet(routes.SYNC_JOBS_HEADERS),
            sheet(routes.BACKUP_LOGS_HEADERS),
            sheet(
                routes.ERROR_LOGS_HEADERS,
                row_for(
                    routes.ERROR_LOGS_HEADERS,
                    error_id="ERR-1",
                    severity="HIGH",
                    occurred_at="2026-07-25T07:00:00+07:00",
                    status="OPEN",
                ),
            ),
            current_time=datetime(2026, 7, 25, 8, 0, tzinfo=routes.LOCAL_TZ),
        )
        self.assertEqual(result.status, "FAIL")
        self.assertIn("unresolved_high_error", result.summary["failures"])

    def test_12_explicit_uat_high_error_is_excluded_from_production_health(self):
        result = routes.evaluate_ops_health(
            sheet(routes.SYNC_JOBS_HEADERS),
            sheet(routes.BACKUP_LOGS_HEADERS),
            sheet(
                routes.ERROR_LOGS_HEADERS,
                row_for(
                    routes.ERROR_LOGS_HEADERS,
                    error_id="UAT-ERR-1",
                    context_json='{"uat":true,"excludeDocuments":true}',
                    severity="HIGH",
                    occurred_at="2026-07-25T07:00:00+07:00",
                    status="OPEN",
                ),
            ),
            current_time=datetime(2026, 7, 25, 8, 0, tzinfo=routes.LOCAL_TZ),
        )
        self.assertEqual(result.status, "PASS_WITH_WARNING")
        self.assertEqual(result.items_read, 1)
        self.assertEqual(result.summary["error_records"], 1)
        self.assertEqual(result.summary["production_error_records"], 0)
        self.assertEqual(result.summary["excluded_uat_error_records"], 1)
        self.assertNotIn("unresolved_high_error", result.summary["failures"])
        self.assertNotIn("error_tab_empty", result.summary["warnings"])

    def test_13_uat_string_true_is_fail_closed(self):
        result = routes.evaluate_ops_health(
            sheet(routes.SYNC_JOBS_HEADERS),
            sheet(routes.BACKUP_LOGS_HEADERS),
            sheet(
                routes.ERROR_LOGS_HEADERS,
                row_for(
                    routes.ERROR_LOGS_HEADERS,
                    error_id="ERR-STRING-UAT",
                    context_json='{"uat":"true"}',
                    severity="HIGH",
                    occurred_at="2026-07-25T07:00:00+07:00",
                    status="OPEN",
                ),
            ),
            current_time=datetime(2026, 7, 25, 8, 0, tzinfo=routes.LOCAL_TZ),
        )
        self.assertEqual(result.status, "FAIL")
        self.assertEqual(result.summary["excluded_uat_error_records"], 0)
        self.assertIn("unresolved_high_error", result.summary["failures"])

    def test_14_invalid_context_json_is_fail_closed(self):
        result = routes.evaluate_ops_health(
            sheet(routes.SYNC_JOBS_HEADERS),
            sheet(routes.BACKUP_LOGS_HEADERS),
            sheet(
                routes.ERROR_LOGS_HEADERS,
                row_for(
                    routes.ERROR_LOGS_HEADERS,
                    error_id="ERR-BAD-JSON",
                    context_json='{not-json',
                    severity="CRITICAL",
                    occurred_at="2026-07-25T07:00:00+07:00",
                    status="OPEN",
                ),
            ),
            current_time=datetime(2026, 7, 25, 8, 0, tzinfo=routes.LOCAL_TZ),
        )
        self.assertEqual(result.status, "FAIL")
        self.assertEqual(result.summary["excluded_uat_error_records"], 0)
        self.assertIn("unresolved_critical_error", result.summary["failures"])

    def test_15_uat_rows_do_not_hide_production_failure(self):
        result = routes.evaluate_ops_health(
            sheet(routes.SYNC_JOBS_HEADERS),
            sheet(routes.BACKUP_LOGS_HEADERS),
            sheet(
                routes.ERROR_LOGS_HEADERS,
                row_for(
                    routes.ERROR_LOGS_HEADERS,
                    error_id="UAT-ERR",
                    context_json='{"uat":true}',
                    severity="HIGH",
                    occurred_at="2026-07-25T07:00:00+07:00",
                    status="OPEN",
                ),
                row_for(
                    routes.ERROR_LOGS_HEADERS,
                    error_id="PROD-ERR",
                    context_json='{"uat":false}',
                    severity="HIGH",
                    occurred_at="2026-07-25T07:30:00+07:00",
                    status="OPEN",
                ),
            ),
            current_time=datetime(2026, 7, 25, 8, 0, tzinfo=routes.LOCAL_TZ),
        )
        self.assertEqual(result.status, "FAIL")
        self.assertEqual(result.summary["excluded_uat_error_records"], 1)
        self.assertEqual(result.summary["production_error_records"], 1)
        self.assertIn("unresolved_high_error", result.summary["failures"])

    def test_16_run_log_append_has_exactly_ten_columns(self):
        api = FakeValuesApi()
        gateway = routes.SheetsGateway(FakeService(api))
        row = ["RUN-X", routes.ROUTE_DUE_CHECK, "", "", "PASS", 1, "", "", "", "ok"]
        gateway.append_and_verify_run_log(row)
        self.assertEqual(len(api.append_kwargs["body"]["values"][0]), 10)
        self.assertEqual(api.append_kwargs["spreadsheetId"], routes.CONTROL_SPREADSHEET_ID)
        self.assertEqual(api.append_kwargs["range"], routes.RUN_LOG_RANGE)

    def test_17_run_log_read_back_verifies_written_row(self):
        api = FakeValuesApi()
        gateway = routes.SheetsGateway(FakeService(api))
        row = ["RUN-X", routes.ROUTE_DUE_CHECK, "", "", "PASS", 1, "", "", "", "ok"]
        verified = gateway.append_and_verify_run_log(row)
        self.assertEqual(verified[0], "RUN-X")
        self.assertEqual(api.get_kwargs["range"], "RUN_LOG!A12:J12")
        api.get = lambda **kwargs: FakeExecute(
            {"values": [["OTHER", routes.ROUTE_DUE_CHECK, "", "", "PASS"]]}
        )
        with self.assertRaises(routes.ContractError):
            gateway.append_and_verify_run_log(row)

    def test_18_runner_has_no_telegram_dependency_or_call(self):
        source = MODULE_PATH.read_text(encoding="utf-8").lower()
        self.assertNotIn("telegram", source)
        self.assertNotIn("sendmessage", source)

    def test_19_runner_never_writes_source_databases(self):
        values = sheet(
            routes.WORK_ITEMS_HEADERS,
            row_for(
                routes.WORK_ITEMS_HEADERS,
                WORK_ID="W-1",
                ACTIVE="TRUE",
                STATUS="OPEN",
                DUE_DATE="2026-07-25",
            ),
        )
        gateway = FakeGateway(
            {(routes.TALKFLOW_SPREADSHEET_ID, routes.WORK_ITEMS_RANGE): values}
        )
        fixed = datetime(2026, 7, 25, 8, 0, tzinfo=routes.LOCAL_TZ)
        with patch.object(routes.uuid, "uuid4") as uuid4:
            uuid4.return_value.hex = "abcdef123456"
            payload, exit_code = routes.execute_route(
                routes.ROUTE_DUE_CHECK, gateway, clock=lambda: fixed
            )
        self.assertEqual(exit_code, 0)
        self.assertTrue(payload["verified"])
        self.assertEqual(
            gateway.read_calls,
            [(routes.TALKFLOW_SPREADSHEET_ID, routes.WORK_ITEMS_RANGE)],
        )
        self.assertEqual(len(gateway.appended), 1)
        self.assertEqual(len(gateway.appended[0]), 10)


if __name__ == "__main__":
    unittest.main()
