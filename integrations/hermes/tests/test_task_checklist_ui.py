from __future__ import annotations

import unittest
from datetime import date

from integrations.hermes import task_checklist_ui as ui


class FakeRepo:
    def __init__(self, work_items, subtasks, assignees=None):
        self.work_items = list(work_items)
        self.subtasks = list(subtasks)
        self.assignees = list(assignees or ["Đặng Anh Dũng"])

    def read_work_items(self):
        return list(self.work_items)

    def read_subtasks(self):
        return list(self.subtasks)

    def read_assignees(self):
        return list(self.assignees)


class FakeTelegram:
    def __init__(self):
        self.plain_messages = []
        self.tasks = []

    def _call(self, method, payload):
        self.plain_messages.append((method, dict(payload)))
        return {"result": {"message_id": 100 + len(self.plain_messages)}}

    def send_task(
        self,
        *,
        chat_id,
        thread_id,
        text,
        work_id,
        sync_required=False,
        allow_transfer=True,
    ):
        self.tasks.append({
            "chat_id": chat_id,
            "thread_id": thread_id,
            "text": text,
            "work_id": work_id,
            "sync_required": sync_required,
            "allow_transfer": allow_transfer,
        })
        return str(200 + len(self.tasks))


class ChecklistUiTests(unittest.TestCase):
    def test_parent_and_child_are_grouped_into_one_card(self):
        repo = FakeRepo(
            work_items=[{
                "WORK_ID": "CV-01",
                "TITLE": "Nhiệm vụ cha",
                "STATUS": "IN_PROGRESS",
                "DUE_DATE": "30/07/2026",
                "NEXT_ACTION": "Mô tả rất dài không được đưa vào thẻ chính",
            }],
            subtasks=[{
                "SUBTASK_ID": "ST-01",
                "WORK_ID": "CV-01",
                "TITLE": "Việc con cần xử lý",
                "STATUS": "IN_PROGRESS",
                "DUE_DATE": "30/07/2026",
                "NOTE": "Nội dung dài của child không được lặp",
            }],
        )
        telegram = FakeTelegram()

        sent = ui.send_checklist_digest(
            repo,
            telegram,
            chat_id="8654262919",
            today=date(2026, 7, 31),
        )

        self.assertEqual(sent, 1)
        self.assertEqual(len(telegram.plain_messages), 1)
        self.assertEqual(len(telegram.tasks), 1)
        card = telegram.tasks[0]["text"]
        self.assertEqual(telegram.tasks[0]["work_id"], "CV-01")
        self.assertIn("☐ CV-01 — Nhiệm vụ cha", card)
        self.assertIn("Việc con đang mở: 1", card)
        self.assertIn("☐ ST-01 — Việc con cần xử lý", card)
        self.assertNotIn("Mô tả rất dài", card)
        self.assertNotIn("Nội dung dài của child", card)
        self.assertNotIn("🌤", card)
        self.assertIn("\n", card)

    def test_child_is_standalone_when_parent_is_not_in_digest(self):
        repo = FakeRepo(
            work_items=[{
                "WORK_ID": "CV-02",
                "TITLE": "Nhiệm vụ cha chưa có hạn",
                "STATUS": "IN_PROGRESS",
                "DUE_DATE": "",
            }],
            subtasks=[{
                "SUBTASK_ID": "ST-02",
                "WORK_ID": "CV-02",
                "TITLE": "Việc con quá hạn",
                "STATUS": "IN_PROGRESS",
                "DUE_DATE": "29/07/2026",
                "NOTE": "",
            }],
        )
        telegram = FakeTelegram()

        sent = ui.send_checklist_digest(
            repo,
            telegram,
            chat_id="8654262919",
            today=date(2026, 7, 31),
        )

        self.assertEqual(sent, 1)
        self.assertEqual(telegram.tasks[0]["work_id"], "ST-02")
        self.assertIn("Thuộc nhiệm vụ: CV-02", telegram.tasks[0]["text"])
        self.assertIn("Nhiệm vụ cha chưa có hạn", telegram.tasks[0]["text"])

    def test_summary_counts_visible_cards_only(self):
        repo = FakeRepo(
            work_items=[{
                "WORK_ID": "CV-03",
                "TITLE": "Cha",
                "STATUS": "IN_PROGRESS",
                "DUE_DATE": "30/07/2026",
            }],
            subtasks=[{
                "SUBTASK_ID": "ST-03",
                "WORK_ID": "CV-03",
                "TITLE": "Con",
                "STATUS": "IN_PROGRESS",
                "DUE_DATE": "30/07/2026",
                "NOTE": "",
            }],
        )
        telegram = FakeTelegram()

        ui.send_checklist_digest(
            repo,
            telegram,
            chat_id="8654262919",
            today=date(2026, 7, 31),
        )

        summary = telegram.plain_messages[0][1]["text"]
        self.assertIn("📋 VIỆC CẦN XỬ LÝ — 31/07/2026", summary)
        self.assertIn("🔴 Quá hạn: 1", summary)
        self.assertNotIn("🌤", summary)

    def test_no_message_when_there_is_no_actionable_task(self):
        repo = FakeRepo(
            work_items=[{
                "WORK_ID": "CV-04",
                "TITLE": "Đã xong",
                "STATUS": "COMPLETED",
                "COMPLETED_AT": "2026-07-30T10:00:00+07:00",
                "NEXT_ACTION": "",
            }],
            subtasks=[],
        )
        telegram = FakeTelegram()

        sent = ui.send_checklist_digest(
            repo,
            telegram,
            chat_id="8654262919",
            today=date(2026, 7, 31),
        )

        self.assertEqual(sent, 0)
        self.assertEqual(telegram.plain_messages, [])
        self.assertEqual(telegram.tasks, [])


if __name__ == "__main__":
    unittest.main()
