from __future__ import annotations

import os
import unittest
from copy import deepcopy
from datetime import date, datetime, timezone
from pathlib import Path
from unittest.mock import patch

from integrations.hermes import task_checklist as checklist


def work(work_id: str, **values: str) -> dict[str, str]:
    row = {key: "" for key in checklist.WORK_ITEMS_HEADERS}
    row.update(
        {
            "WORK_ID": work_id,
            "TITLE": f"Nhiệm vụ {work_id}",
            "STATUS": "IN_PROGRESS",
            "ACTIVE": "TRUE",
            "_ROW_NUMBER": str(values.pop("_ROW_NUMBER", "2")),
        }
    )
    row.update(values)
    return row


def child(subtask_id: str, work_id: str, **values: str) -> dict[str, str]:
    row = {key: "" for key in checklist.SUBTASK_HEADERS}
    row.update(
        {
            "SUBTASK_ID": subtask_id,
            "WORK_ID": work_id,
            "TITLE": f"Việc con {subtask_id}",
            "STATUS": "DANG_THUC_HIEN",
            "ACTIVE": "TRUE",
            "_ROW_NUMBER": str(values.pop("_ROW_NUMBER", "2")),
        }
    )
    row.update(values)
    return row


class FakeRepo:
    """Sheets-like UAT fake: row numbers, batch mutation and read-after-write."""
    def __init__(self, works=None, children=None, assignees=None):
        self.works = deepcopy(works or [])
        self.children = deepcopy(children or [])
        self.actions: list[dict[str, str]] = []
        self.activities: list[dict[str, str]] = []
        self.write_count = 0
        self.assignees = list(assignees or ["Nguyễn Văn A", "Trần Thị B"])
        self.fail_plan_after: int | None = None
        self.fail_compensation = False
        self.plan_snapshots = {}

    def read_work_items(self):
        return deepcopy(self.works)

    def read_subtasks(self):
        return deepcopy(self.children)

    def read_actions(self):
        return deepcopy(self.actions)

    def read_activity(self):
        return deepcopy(self.activities)

    def read_assignees(self):
        return list(self.assignees)

    @staticmethod
    def _update(records, row_number, fields):
        target = next(row for row in records if int(row["_ROW_NUMBER"]) == row_number)
        target.update(fields)

    def update_work(self, row_number, fields):
        self.write_count += 1
        self._update(self.works, row_number, fields)

    def update_subtask(self, row_number, fields):
        self.write_count += 1
        self._update(self.children, row_number, fields)

    def update_action(self, row_number, fields):
        self.write_count += 1
        self._update(self.actions, row_number, fields)

    def append_work(self, fields):
        self.write_count += 1
        row = work(fields["WORK_ID"], _ROW_NUMBER=str(len(self.works) + 2))
        row.update(fields)
        self.works.append(row)
        return deepcopy(row)

    def append_action(self, fields):
        self.write_count += 1
        row = {key: "" for key in checklist.ACTION_QUEUE_HEADERS}
        row.update(fields)
        row["_ROW_NUMBER"] = str(len(self.actions) + 2)
        self.actions.append(row)
        return deepcopy(row)

    def append_activity(self, fields):
        self.write_count += 1
        row = {key: "" for key in checklist.ACTIVITY_HEADERS}
        row.update(fields)
        row["_ROW_NUMBER"] = str(len(self.activities) + 2)
        self.activities.append(row)
        return deepcopy(row)

    def apply_mutation_plan(self, plan):
        snapshots = (deepcopy(self.works), deepcopy(self.children))
        self.plan_snapshots[id(plan)] = snapshots
        applied = 0
        try:
            for mutation in plan.mutations:
                if self.fail_plan_after is not None and applied >= self.fail_plan_after:
                    raise RuntimeError("injected partial batch failure")
                if mutation.sheet == "WORK_ITEMS" and mutation.is_new:
                    row = work(
                        mutation.key_value, _ROW_NUMBER=str(mutation.row_number),
                    )
                    row.update(mutation.after)
                    self.works.append(row)
                elif mutation.sheet == "WORK_ITEMS":
                    self._update(self.works, mutation.row_number, mutation.after)
                else:
                    self._update(self.children, mutation.row_number, mutation.after)
                self.write_count += 1
                applied += 1
        except Exception as exc:
            try:
                self.compensate_mutation_plan(plan)
            except Exception as rollback_exc:
                raise checklist.NeedsReconciliationError(str(rollback_exc)) from exc
            raise checklist.MutationRolledBackError(str(exc)) from exc

    def compensate_mutation_plan(self, plan):
        if self.fail_compensation:
            raise RuntimeError("injected compensation failure")
        snapshots = self.plan_snapshots.get(id(plan))
        if snapshots is None:
            # Compensation after post-mutation audit/action failure.
            for mutation in reversed(plan.mutations):
                if mutation.is_new:
                    self.works = [
                        row for row in self.works
                        if row.get(mutation.key_field) != mutation.key_value
                    ]
                elif mutation.sheet == "WORK_ITEMS":
                    self._update(self.works, mutation.row_number, mutation.before)
                else:
                    self._update(self.children, mutation.row_number, mutation.before)
            return
        self.works, self.children = deepcopy(snapshots)


class FakeTelegram:
    def __init__(self):
        self.sent = []
        self.answers = []

    def send_task(self, **payload):
        self.sent.append(payload)
        return str(len(self.sent))

    def answer_callback(self, callback_id, text, alert=False):
        self.answers.append((callback_id, text, alert))


class TaskChecklistTests(unittest.TestCase):
    def setUp(self):
        self.env = patch.dict(
            os.environ,
            {"HERMES_TASK_OWNER_USER_ID": "42", "HERMES_TASK_CHAT_ID": "1"},
        )
        self.env.start()

    def tearDown(self):
        self.env.stop()

    def test_sheet_parser_ignores_fully_blank_formatted_rows(self):
        values = [
            list(checklist.SUBTASK_HEADERS),
            [],
            [""] * len(checklist.SUBTASK_HEADERS),
            ["ST-1", "CV-1", "Có dữ liệu"],
        ]
        rows = checklist.rows_as_dicts(
            values, checklist.SUBTASK_HEADERS, "SUBTASKS",
        )
        self.assertEqual(["ST-1"], [row["SUBTASK_ID"] for row in rows])

    def test_digest_only_has_six_task_groups(self):
        digest = checklist.build_digest([], [], today=date(2026, 7, 30))
        self.assertEqual(
            list(digest.groups),
            [
                "QUÁ HẠN", "ĐẾN HẠN HÔM NAY", "SẮP ĐẾN HẠN",
                "ĐANG CHỜ", "CẦN CHỌN TRẠNG THÁI", "CẦN ĐỒNG BỘ DỮ LIỆU",
            ],
        )
        source = Path(checklist.__file__).read_text(encoding="utf-8").lower()
        self.assertNotIn("weather_api", source)
        self.assertNotIn("news_api", source)

    def test_inline_keyboard_has_all_real_callback_buttons(self):
        keyboard = checklist.callback_keyboard("CV-2026-0013")["inline_keyboard"]
        buttons = [button for row in keyboard for button in row]
        self.assertEqual(7, len(buttons))
        self.assertEqual(
            {"c", "w", "h", "p", "n", "t", "d"},
            {button["callback_data"].split(":")[1] for button in buttons},
        )
        self.assertTrue(all("callback_data" in button for button in buttons))

    def test_sync_keyboard_has_only_detail_and_safe_sync(self):
        rows = checklist.callback_keyboard(
            "CV-2026-0013", sync_required=True,
        )["inline_keyboard"]
        self.assertEqual(
            {"d", "s"},
            {button["callback_data"].split(":")[1] for row in rows for button in row},
        )

    def test_issue_39_consistency_fixture_is_detected_and_not_overdue(self):
        works = [
            work(
                "CV-2026-0013", STATUS="COMPLETED", DUE_DATE="28/07/2026",
                COMPLETED_AT="28/07/2026 08:20", NEXT_ACTION="Không còn việc tiếp theo.",
                _ROW_NUMBER="2",
            ),
            work("CV-2026-0013", STATUS="COMPLETED", _ROW_NUMBER="3"),
            work("CV-2026-0014", STATUS="COMPLETED", _ROW_NUMBER="4"),
            work("CV-2026-0014", STATUS="COMPLETED", _ROW_NUMBER="5"),
            work("CV-2026-0006", STATUS="COMPLETED", _ROW_NUMBER="6"),
        ]
        children = [
            child(f"ST-CV0013-0{number}", "CV-2026-0013", DUE_DATE="28/07/2026", _ROW_NUMBER=str(number + 1))
            for number in (1, 3, 4, 5)
        ] + [child("ST-CV0006-03", "CV-2026-0006", _ROW_NUMBER="20")]
        digest = checklist.build_digest(works, children, today=date(2026, 7, 30))
        codes = {(issue.code, issue.work_id) for issue in digest.consistency}
        self.assertIn(("DUPLICATE_WORK_ID", "CV-2026-0013"), codes)
        self.assertIn(("DUPLICATE_WORK_ID", "CV-2026-0014"), codes)
        self.assertIn(("TERMINAL_PARENT_OPEN_CHILD", "CV-2026-0006"), codes)
        self.assertFalse(digest.groups["QUÁ HẠN"])
        self.assertTrue(digest.groups["CẦN ĐỒNG BỘ DỮ LIỆU"])

    def test_completed_invariants_are_reported(self):
        issues = checklist.consistency_check(
            [work("CV-1", STATUS="COMPLETED", COMPLETED_AT="", NEXT_ACTION="Gửi báo cáo")],
            [],
        )
        self.assertEqual(
            {"COMPLETED_MISSING_COMPLETED_AT", "COMPLETED_HAS_NEXT_ACTION"},
            {issue.code for issue in issues},
        )

    def test_all_terminal_children_with_open_parent_is_reported(self):
        issues = checklist.consistency_check(
            [work("CV-1", STATUS="IN_PROGRESS")],
            [child("ST-1", "CV-1", STATUS="HOAN_THANH")],
        )
        self.assertIn("ALL_CHILDREN_TERMINAL_PARENT_OPEN", {issue.code for issue in issues})

    def test_callback_rejects_non_owner_without_writes(self):
        repo = FakeRepo([work("CV-1")])
        with self.assertRaises(PermissionError):
            checklist.process_callback(
                repo, callback_id="cb-1", user_id="99", username="danganhdung", chat_id="1",
                thread_id="", data="ht:w:CV-1",
            )
        self.assertEqual(0, repo.write_count)

    def test_correct_username_with_wrong_numeric_id_is_rejected(self):
        repo = FakeRepo([work("CV-1")])
        with self.assertRaises(PermissionError):
            checklist.process_callback(
                repo, callback_id="cb-owner", user_id="999",
                username="danganhdung", chat_id="1", thread_id="",
                data="ht:w:CV-1",
            )
        self.assertEqual(0, repo.write_count)

    def test_wrong_chat_id_is_rejected(self):
        repo = FakeRepo([work("CV-1")])
        with self.assertRaises(PermissionError):
            checklist.process_callback(
                repo, callback_id="cb-chat", user_id="42",
                username="danganhdung", chat_id="999", thread_id="",
                data="ht:w:CV-1",
            )
        self.assertEqual(0, repo.write_count)

    def test_callback_duplicate_is_idempotent_without_duplicate_audit_or_update(self):
        repo = FakeRepo([work("CV-1", STATUS="NEW")])
        first = checklist.process_callback(
            repo, callback_id="cb-1", user_id="42", username="danganhdung", chat_id="1",
            thread_id="", data="ht:w:CV-1",
        )
        count_after_first = repo.write_count
        second = checklist.process_callback(
            repo, callback_id="cb-2", user_id="42", username="danganhdung", chat_id="1",
            thread_id="", data="ht:w:CV-1",
        )
        self.assertFalse(first["idempotent"])
        self.assertTrue(second["idempotent"])
        self.assertEqual(count_after_first, repo.write_count)
        self.assertEqual(1, len(repo.actions))
        self.assertEqual(1, len(repo.activities))

    def test_same_action_can_run_again_after_an_intervening_state_change(self):
        repo = FakeRepo([work("CV-1", STATUS="NEW")])
        for callback_id, data in (
            ("cb-wait-1", "ht:h:CV-1"),
            ("cb-start", "ht:w:CV-1"),
            ("cb-wait-2", "ht:h:CV-1"),
        ):
            result = checklist.process_callback(
                repo, callback_id=callback_id, user_id="42", username="danganhdung",
                chat_id="1", thread_id="", data=data,
            )
            self.assertFalse(result["idempotent"])
        self.assertEqual("WAITING", repo.works[0]["STATUS"])
        self.assertEqual(3, len(repo.actions))
        self.assertEqual(3, len(repo.activities))

    def test_parent_completion_closes_children_and_sets_required_parent_fields(self):
        repo = FakeRepo(
            [work("CV-2026-0013", NEXT_ACTION="Việc tiếp", _ROW_NUMBER="2")],
            [
                child("ST-CV0013-01", "CV-2026-0013", _ROW_NUMBER="2"),
                child("ST-CV0013-03", "CV-2026-0013", _ROW_NUMBER="3"),
                child("ST-CV0013-04", "CV-2026-0013", _ROW_NUMBER="4"),
                child("ST-CV0013-05", "CV-2026-0013", _ROW_NUMBER="5"),
            ],
        )
        result = checklist.process_callback(
            repo, callback_id="cb-complete", user_id="42", username="danganhdung",
            chat_id="1", thread_id="", data="ht:c:CV-2026-0013",
        )
        parent = repo.works[0]
        self.assertEqual("COMPLETED", parent["STATUS"])
        self.assertEqual("100", parent["PROGRESS_PERCENT"])
        self.assertEqual("", parent["NEXT_ACTION"])
        self.assertTrue(parent["COMPLETED_AT"])
        self.assertTrue(all(item["STATUS"] == "HOAN_THANH" for item in repo.children))
        self.assertEqual(4, len(result["result"]["closed_subtasks"]))

    def test_selected_child_continues_as_new_independent_work(self):
        repo = FakeRepo(
            [work("CV-2026-0013", _ROW_NUMBER="2")],
            [
                child(
                    "ST-CV0013-05", "CV-2026-0013",
                    NOTE="CONTINUE_AFTER_PARENT=TRUE; tiếp tục hướng dẫn",
                    _ROW_NUMBER="2",
                )
            ],
        )
        result = checklist.process_callback(
            repo, callback_id="cb-continue", user_id="42", username="danganhdung",
            chat_id="1", thread_id="", data="ht:c:CV-2026-0013",
        )
        detached = result["result"]["detached_work_ids"]
        self.assertEqual(1, len(detached))
        self.assertTrue(detached[0].startswith("CV-CONT-"))
        self.assertEqual(detached[0], repo.works[1]["WORK_ID"])
        self.assertIn(f"DETACHED_TO={detached[0]}", repo.children[0]["NOTE"])

    def test_partial_child_failure_is_compensated_and_never_reports_success(self):
        parent = work("CV-1", STATUS="IN_PROGRESS", NEXT_ACTION="Tiếp tục")
        children = [
            child("ST-1", "CV-1", _ROW_NUMBER="2"),
            child("ST-2", "CV-1", _ROW_NUMBER="3"),
        ]
        repo = FakeRepo([parent], children)
        repo.fail_plan_after = 1
        with self.assertRaises(checklist.MutationRolledBackError):
            checklist.process_callback(
                repo, callback_id="cb-partial", user_id="42",
                username="danganhdung", chat_id="1", thread_id="",
                data="ht:c:CV-1",
            )
        self.assertEqual("IN_PROGRESS", repo.works[0]["STATUS"])
        self.assertEqual(
            ["DANG_THUC_HIEN", "DANG_THUC_HIEN"],
            [item["STATUS"] for item in repo.children],
        )
        self.assertEqual("FAILED", repo.actions[0]["STATUS"])
        self.assertFalse(repo.activities)

    def test_failed_compensation_marks_action_for_reconciliation(self):
        repo = FakeRepo(
            [work("CV-1")],
            [child("ST-1", "CV-1")],
        )
        repo.fail_plan_after = 1
        repo.fail_compensation = True
        with self.assertRaises(checklist.NeedsReconciliationError):
            checklist.process_callback(
                repo, callback_id="cb-reconcile", user_id="42",
                username="danganhdung", chat_id="1", thread_id="",
                data="ht:c:CV-1",
            )
        self.assertEqual("NEEDS_RECONCILIATION", repo.actions[0]["STATUS"])

    def test_duplicate_work_id_cannot_mutate_but_can_be_safely_inspected(self):
        repo = FakeRepo([
            work("CV-DUP", _ROW_NUMBER="2"),
            work("CV-DUP", _ROW_NUMBER="3"),
        ])
        with self.assertRaises(checklist.ContractError):
            checklist.process_callback(
                repo, callback_id="cb-mut", user_id="42",
                username="danganhdung", chat_id="1", thread_id="",
                data="ht:w:CV-DUP",
            )
        self.assertFalse(repo.actions)
        result = checklist.process_callback(
            repo, callback_id="cb-sync", user_id="42",
            username="display-only", chat_id="1", thread_id="",
            data="ht:s:CV-DUP",
        )
        self.assertEqual(2, len(result["result"]["matches"]))
        self.assertEqual("SAFE_SYNC_REVIEW", result["result"]["status"])

    def test_vietnam_date_boundary_uses_zoneinfo(self):
        self.assertEqual(
            date(2026, 7, 29),
            checklist.today_vn(datetime(2026, 7, 29, 16, 30, tzinfo=timezone.utc)),
        )
        self.assertEqual(
            date(2026, 7, 30),
            checklist.today_vn(datetime(2026, 7, 29, 17, 30, tzinfo=timezone.utc)),
        )
        self.assertEqual(
            date(2026, 7, 31),
            checklist.today_vn(datetime(2026, 7, 30, 17, 30, tzinfo=timezone.utc)),
        )

    def test_postpone_and_transfer_require_input_instead_of_guessing(self):
        for data in ("ht:p:CV-1", "ht:t:CV-1"):
            repo = FakeRepo([work("CV-1")])
            result = checklist.process_callback(
                repo, callback_id=data, user_id="42", username="danganhdung", chat_id="1",
                thread_id="", data=data,
            )
            self.assertEqual("NEEDS_INPUT", result["result"]["status"])
            self.assertEqual("IN_PROGRESS", repo.works[0]["STATUS"])

    def test_readback_mismatch_prevents_success(self):
        class BrokenRepo(FakeRepo):
            def update_work(self, row_number, fields):
                self.write_count += 1

        repo = BrokenRepo([work("CV-1")])
        with self.assertRaises(checklist.ContractError):
            checklist.process_callback(
                repo, callback_id="cb", user_id="42", username="danganhdung", chat_id="1",
                thread_id="", data="ht:h:CV-1",
            )
        self.assertFalse(repo.activities)
        self.assertEqual("FAILED", repo.actions[0]["STATUS"])

    def test_send_digest_emits_task_cards_with_callbacks(self):
        repo = FakeRepo(
            [work("CV-1", DUE_DATE="30/07/2026", STATUS="IN_PROGRESS")],
            [],
        )
        telegram = FakeTelegram()
        sent = checklist.send_digest(
            repo, telegram, chat_id="123", thread_id="7", today=date(2026, 7, 30),
        )
        self.assertEqual(1, sent)
        self.assertEqual("CV-1", telegram.sent[0]["work_id"])

    def test_open_child_is_listed_but_terminal_parent_child_is_suppressed(self):
        open_digest = checklist.build_digest(
            [work("CV-1", STATUS="IN_PROGRESS")],
            [child("ST-1", "CV-1", STATUS="DANG_THUC_HIEN", DUE_DATE="29/07/2026")],
            today=date(2026, 7, 30),
        )
        self.assertEqual("ST-1", open_digest.groups["QUÁ HẠN"][0]["WORK_ID"])
        terminal_digest = checklist.build_digest(
            [work("CV-1", STATUS="COMPLETED", COMPLETED_AT="30/07/2026")],
            [child("ST-1", "CV-1", STATUS="DANG_THUC_HIEN", DUE_DATE="29/07/2026")],
            today=date(2026, 7, 30),
        )
        self.assertFalse(terminal_digest.groups["QUÁ HẠN"])

    def test_subtask_callback_updates_existing_schema_and_reads_back(self):
        repo = FakeRepo(
            [work("CV-1", STATUS="IN_PROGRESS")],
            [child("ST-1", "CV-1", STATUS="DANG_THUC_HIEN")],
        )
        result = checklist.process_callback(
            repo, callback_id="cb-child", user_id="42", username="danganhdung",
            chat_id="1", thread_id="", data="ht:c:ST-1",
        )
        self.assertEqual("HOAN_THANH", result["result"]["status"])
        self.assertEqual("HOAN_THANH", repo.children[0]["STATUS"])


if __name__ == "__main__":
    unittest.main()
