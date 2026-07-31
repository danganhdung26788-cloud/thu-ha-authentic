from __future__ import annotations

import os
import tempfile
import unittest
from datetime import date, datetime, timezone
from types import SimpleNamespace
from unittest.mock import patch

from integrations.hermes import task_checklist_polling as polling
from integrations.hermes.tests.test_task_checklist import FakeRepo, child, work


class FakeQuery:
    def __init__(self, data: str, *, query_id: str = "q1"):
        self.data = data
        self.id = query_id
        self.from_user = SimpleNamespace(id=42, username="danganhdung")
        self.message = SimpleNamespace(
            chat=SimpleNamespace(id=1), message_thread_id=7,
        )
        self.answers = []
        self.edits = []

    async def answer(self, text="", show_alert=False):
        self.answers.append((text, show_alert))

    async def edit_message_text(self, **kwargs):
        self.edits.append(kwargs)


class FakeMessage:
    def __init__(self, text: str):
        self.text = text
        self.chat = SimpleNamespace(id=1)
        self.replies = []

    async def reply_text(self, text, **kwargs):
        self.replies.append((text, kwargs))


class PollingInteractionTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.env = patch.dict(os.environ, {
            "HERMES_TASK_OWNER_USER_ID": "42",
            "HERMES_TASK_CHAT_ID": "1",
            "HERMES_TASK_INTERACTION_TIMEOUT_SECONDS": "60",
        })
        self.env.start()
        self.temp = tempfile.TemporaryDirectory()
        self.store = polling.InteractionStore(os.path.join(self.temp.name, "state.db"))
        self.repo = FakeRepo([work("CV-1", STATUS="IN_PROGRESS")])
        self.moment = datetime(2026, 7, 30, 3, 0, tzinfo=timezone.utc)

    def tearDown(self):
        self.temp.cleanup()
        self.env.stop()

    async def test_postpone_quick_choice_requires_confirmation_and_is_idempotent(self):
        start = FakeQuery("ht:p:CV-1")
        self.assertTrue(await polling.handle_callback_query(
            start, None, repo=self.repo, store=self.store, moment=self.moment,
        ))
        callback = start.edits[-1]["reply_markup"]
        raw = callback.to_dict() if hasattr(callback, "to_dict") else callback
        token_data = raw["inline_keyboard"][0][0]["callback_data"]
        choice = FakeQuery(token_data)
        await polling.handle_callback_query(
            choice, None, repo=self.repo, store=self.store, moment=self.moment,
        )
        raw_confirm = (
            choice.edits[-1]["reply_markup"].to_dict()
            if hasattr(choice.edits[-1]["reply_markup"], "to_dict")
            else choice.edits[-1]["reply_markup"]
        )
        confirm_data = raw_confirm["inline_keyboard"][0][0]["callback_data"]
        confirm = FakeQuery(confirm_data, query_id="confirm-1")
        with patch(
            "integrations.hermes.task_checklist.today_vn",
            return_value=date(2026, 7, 30),
        ):
            await polling.handle_callback_query(
                confirm, None, repo=self.repo, store=self.store, moment=self.moment,
            )
            writes = self.repo.write_count
            duplicate = FakeQuery(confirm_data, query_id="confirm-2")
            await polling.handle_callback_query(
                duplicate, None, repo=self.repo, store=self.store, moment=self.moment,
            )
        self.assertEqual("31/07/2026", self.repo.works[0]["DUE_DATE"])
        self.assertEqual(writes, self.repo.write_count)
        self.assertEqual(1, len(self.repo.actions))
        self.assertEqual(1, len(self.repo.activities))

    async def test_custom_date_waits_for_text_then_confirmation(self):
        session = self.store.create(
            user_id="42", chat_id="1", thread_id="7",
            work_id="CV-1", action="p", moment=self.moment,
        )
        self.store.update(
            session["token"], stage="AWAITING_DATE", moment=self.moment,
        )
        message = FakeMessage("05/08/2026")
        update = SimpleNamespace(
            effective_message=message,
            effective_user=SimpleNamespace(id=42, username="danganhdung"),
        )
        handled = await polling.maybe_handle_text_message(
            update, None, repo=self.repo, store=self.store, moment=self.moment,
        )
        self.assertTrue(handled)
        self.assertEqual(
            "CONFIRM", self.store.get(session["token"], moment=self.moment)["stage"],
        )
        self.assertEqual("", self.repo.works[0]["DUE_DATE"])

    async def test_transfer_rejects_unknown_name_without_guessing(self):
        session = self.store.create(
            user_id="42", chat_id="1", thread_id="7",
            work_id="CV-1", action="t", moment=self.moment,
        )
        self.store.update(
            session["token"], stage="AWAITING_ASSIGNEE", moment=self.moment,
        )
        message = FakeMessage("Tên gần giống")
        update = SimpleNamespace(
            effective_message=message,
            effective_user=SimpleNamespace(id=42, username="danganhdung"),
        )
        await polling.maybe_handle_text_message(
            update, None, repo=self.repo, store=self.store, moment=self.moment,
        )
        self.assertEqual(
            "AWAITING_ASSIGNEE",
            self.store.get(session["token"], moment=self.moment)["stage"],
        )
        self.assertIn("không khớp", message.replies[-1][0])

    async def test_transfer_valid_selection_requires_confirmation_and_reads_back(self):
        start = FakeQuery("ht:t:CV-1")
        await polling.handle_callback_query(
            start, None, repo=self.repo, store=self.store, moment=self.moment,
        )
        raw = (
            start.edits[-1]["reply_markup"].to_dict()
            if hasattr(start.edits[-1]["reply_markup"], "to_dict")
            else start.edits[-1]["reply_markup"]
        )
        selection = FakeQuery(raw["inline_keyboard"][0][0]["callback_data"])
        await polling.handle_callback_query(
            selection, None, repo=self.repo, store=self.store, moment=self.moment,
        )
        raw_confirm = (
            selection.edits[-1]["reply_markup"].to_dict()
            if hasattr(selection.edits[-1]["reply_markup"], "to_dict")
            else selection.edits[-1]["reply_markup"]
        )
        confirm = FakeQuery(raw_confirm["inline_keyboard"][0][0]["callback_data"])
        await polling.handle_callback_query(
            confirm, None, repo=self.repo, store=self.store, moment=self.moment,
        )
        self.assertEqual("Nguyễn Văn A", self.repo.works[0]["ASSIGNEE_NAME"])
        self.assertIn("read-back", confirm.edits[-1]["text"])

    async def test_cancel_and_timeout_do_not_write_taskflow(self):
        session = self.store.create(
            user_id="42", chat_id="1", thread_id="7",
            work_id="CV-1", action="p", moment=self.moment,
        )
        cancel = FakeQuery(f"htp:{session['token']}:x")
        await polling.handle_callback_query(
            cancel, None, repo=self.repo, store=self.store, moment=self.moment,
        )
        self.assertEqual(0, self.repo.write_count)
        expired = self.store.create(
            user_id="42", chat_id="1", thread_id="7",
            work_id="CV-1", action="p", moment=self.moment,
        )
        late = FakeQuery(f"htp:{expired['token']}:1")
        await polling.handle_callback_query(
            late, None, repo=self.repo, store=self.store,
            moment=datetime(2026, 7, 30, 3, 2, tzinfo=timezone.utc),
        )
        self.assertIn("hết hạn", late.edits[-1]["text"])
        self.assertEqual(0, self.repo.write_count)

    async def test_parent_checklist_detaches_selected_child_and_closes_other(self):
        self.repo = FakeRepo(
            [work("CV-PARENT", STATUS="IN_PROGRESS")],
            [
                child("ST-KEEP", "CV-PARENT", _ROW_NUMBER="2"),
                child("ST-CLOSE", "CV-PARENT", _ROW_NUMBER="3"),
            ],
        )
        start = FakeQuery("ht:c:CV-PARENT")
        await polling.handle_callback_query(
            start, None, repo=self.repo, store=self.store, moment=self.moment,
        )
        self.assertIn("ST-KEEP", start.edits[-1]["text"])
        raw = (
            start.edits[-1]["reply_markup"].to_dict()
            if hasattr(start.edits[-1]["reply_markup"], "to_dict")
            else start.edits[-1]["reply_markup"]
        )
        choose = FakeQuery(raw["inline_keyboard"][1][0]["callback_data"])
        await polling.handle_callback_query(
            choose, None, repo=self.repo, store=self.store, moment=self.moment,
        )
        raw_choose = (
            choose.edits[-1]["reply_markup"].to_dict()
            if hasattr(choose.edits[-1]["reply_markup"], "to_dict")
            else choose.edits[-1]["reply_markup"]
        )
        toggle = FakeQuery(raw_choose["inline_keyboard"][0][0]["callback_data"])
        await polling.handle_callback_query(
            toggle, None, repo=self.repo, store=self.store, moment=self.moment,
        )
        raw_toggle = (
            toggle.edits[-1]["reply_markup"].to_dict()
            if hasattr(toggle.edits[-1]["reply_markup"], "to_dict")
            else toggle.edits[-1]["reply_markup"]
        )
        confirm = FakeQuery(raw_toggle["inline_keyboard"][-2][0]["callback_data"])
        await polling.handle_callback_query(
            confirm, None, repo=self.repo, store=self.store, moment=self.moment,
        )
        keep = next(row for row in self.repo.children if row["SUBTASK_ID"] == "ST-KEEP")
        close = next(row for row in self.repo.children if row["SUBTASK_ID"] == "ST-CLOSE")
        self.assertIn("DETACHED_TO=", keep["NOTE"])
        self.assertEqual("HOAN_THANH", keep["STATUS"])
        self.assertEqual("HOAN_THANH", close["STATUS"])
        self.assertEqual(2, len(self.repo.works))
        self.assertEqual("COMPLETED", self.repo.works[0]["STATUS"])

    async def test_close_all_overrides_preselected_legacy_marker(self):
        self.repo = FakeRepo(
            [work("CV-PARENT", STATUS="IN_PROGRESS")],
            [child(
                "ST-MARKED", "CV-PARENT",
                NOTE="CONTINUE_AFTER_PARENT=TRUE; legacy marker",
            )],
        )
        start = FakeQuery("ht:c:CV-PARENT")
        await polling.handle_callback_query(
            start, None, repo=self.repo, store=self.store, moment=self.moment,
        )
        self.assertIn("☑️", start.edits[-1]["text"])
        self.assertIn("TIẾP TỤC ĐỘC LẬP", start.edits[-1]["text"])
        raw = (
            start.edits[-1]["reply_markup"].to_dict()
            if hasattr(start.edits[-1]["reply_markup"], "to_dict")
            else start.edits[-1]["reply_markup"]
        )
        close_all = FakeQuery(raw["inline_keyboard"][0][0]["callback_data"])
        await polling.handle_callback_query(
            close_all, None, repo=self.repo, store=self.store, moment=self.moment,
        )
        self.assertIn("Xác nhận đóng toàn bộ", close_all.edits[-1]["text"])
        raw_confirm = (
            close_all.edits[-1]["reply_markup"].to_dict()
            if hasattr(close_all.edits[-1]["reply_markup"], "to_dict")
            else close_all.edits[-1]["reply_markup"]
        )
        confirm = FakeQuery(raw_confirm["inline_keyboard"][0][0]["callback_data"])
        await polling.handle_callback_query(
            confirm, None, repo=self.repo, store=self.store, moment=self.moment,
        )
        self.assertEqual(1, len(self.repo.works))
        self.assertEqual("HOAN_THANH", self.repo.children[0]["STATUS"])
        self.assertNotIn("DETACHED_TO=", self.repo.children[0]["NOTE"])

    async def test_preselected_legacy_marker_is_kept_when_user_confirms(self):
        self.repo = FakeRepo(
            [work("CV-PARENT", STATUS="IN_PROGRESS")],
            [child(
                "ST-MARKED", "CV-PARENT",
                NOTE="CONTINUE_AFTER_PARENT=TRUE; legacy marker",
            )],
        )
        start = FakeQuery("ht:c:CV-PARENT")
        await polling.handle_callback_query(
            start, None, repo=self.repo, store=self.store, moment=self.moment,
        )
        raw = (
            start.edits[-1]["reply_markup"].to_dict()
            if hasattr(start.edits[-1]["reply_markup"], "to_dict")
            else start.edits[-1]["reply_markup"]
        )
        select = FakeQuery(raw["inline_keyboard"][1][0]["callback_data"])
        await polling.handle_callback_query(
            select, None, repo=self.repo, store=self.store, moment=self.moment,
        )
        self.assertIn("☑️", select.edits[-1]["text"])
        raw_select = (
            select.edits[-1]["reply_markup"].to_dict()
            if hasattr(select.edits[-1]["reply_markup"], "to_dict")
            else select.edits[-1]["reply_markup"]
        )
        confirm = FakeQuery(raw_select["inline_keyboard"][-2][0]["callback_data"])
        await polling.handle_callback_query(
            confirm, None, repo=self.repo, store=self.store, moment=self.moment,
        )
        self.assertEqual(2, len(self.repo.works))
        self.assertIn("DETACHED_TO=", self.repo.children[0]["NOTE"])

    async def test_not_done_requires_confirmation_before_any_write(self):
        self.repo = FakeRepo(
            [work("CV-PARENT")],
            [child(
                "ST-1", "CV-PARENT",
                NOTE="CONTINUE_AFTER_PARENT=TRUE; must still close",
            )],
        )
        start = FakeQuery("ht:n:CV-PARENT")
        await polling.handle_callback_query(
            start, None, repo=self.repo, store=self.store, moment=self.moment,
        )
        self.assertEqual(0, self.repo.write_count)
        self.assertIn("Xác nhận", start.edits[-1]["text"])
        raw = (
            start.edits[-1]["reply_markup"].to_dict()
            if hasattr(start.edits[-1]["reply_markup"], "to_dict")
            else start.edits[-1]["reply_markup"]
        )
        confirm = FakeQuery(raw["inline_keyboard"][0][0]["callback_data"])
        await polling.handle_callback_query(
            confirm, None, repo=self.repo, store=self.store, moment=self.moment,
        )
        self.assertEqual("NOT_DONE", self.repo.works[0]["STATUS"])
        self.assertEqual(1, len(self.repo.works))
        self.assertNotIn("DETACHED_TO=", self.repo.children[0]["NOTE"])

    async def test_transfer_is_hidden_when_only_system_roster_exists(self):
        self.repo = FakeRepo([work("CV-1")], assignees=[])
        start = FakeQuery("ht:t:CV-1")
        await polling.handle_callback_query(
            start, None, repo=self.repo, store=self.store, moment=self.moment,
        )
        self.assertIn("Chưa có danh sách", start.edits[-1]["text"])
        self.assertEqual(0, self.repo.write_count)


if __name__ == "__main__":
    unittest.main()
