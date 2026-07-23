from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from integrations.hermes import meta_messenger_bridge as bridge
from integrations.hermes import telegram_control_config as config
from integrations.hermes import telegram_fanpage_control as control


class FakeRepository:
    def __init__(self, item: control.QueueItem) -> None:
        self.item = item
        self.updates: list[tuple[int, dict[str, str]]] = []

    def read_items(self) -> list[control.QueueItem]:
        return [self.item]

    def update_fields(self, row_number: int, fields: dict[str, str]) -> None:
        self.updates.append((row_number, fields))
        values = self.item.__dict__ | fields
        self.item = control.QueueItem(**values)


def make_item(status: str = "DRAFT_READY") -> control.QueueItem:
    return control.QueueItem(
        row_number=36,
        message_id="m_test",
        customer_id="psid_test",
        customer_name="",
        message_text="Chị muốn mua mặt nạ giấy cho da khô",
        intent="PRODUCT_CONSULTATION",
        product_key="P000137",
        draft_reply="Dạ, em chốt cho chị sản phẩm phù hợp, giá 440.000đ ạ.",
        confidence="0.94",
        need_human="FALSE",
        status=status,
        created_at="2026-07-23T00:00:00+00:00",
        replied_at="",
        error="",
    )


class TelegramFanpageControlTests(unittest.TestCase):
    def test_notification_card_contains_ticket_and_operator_commands(self) -> None:
        text = control.format_item(make_item(), notification=True)
        self.assertIn("TICKET=FP-36", text)
        self.assertIn("Gửi", text)
        self.assertIn("Viết ngắn hơn", text)
        self.assertIn("PRODUCT_KEY=P000137", text)

    def test_list_items_returns_only_pending(self) -> None:
        pending = make_item("DRAFT_READY")
        sent = control.QueueItem(**(make_item("SENT").__dict__ | {"row_number": 37}))

        class Repo:
            def read_items(self):
                return [pending, sent]

        self.assertEqual([pending], control.list_items(Repo()))

    def test_save_draft_updates_only_current_unsent_ticket(self) -> None:
        repo = FakeRepository(make_item())
        with tempfile.TemporaryDirectory() as directory:
            with patch.object(control, "AUDIT_PATH", Path(directory) / "audit.jsonl"):
                updated = control.save_draft(
                    repo,
                    repo.item,
                    "Dạ, em chốt nhanh một mẫu phù hợp cho chị ạ.",
                    operator="DANG_ANH_DUNG",
                    operation="SET_DRAFT",
                )
        self.assertEqual("DRAFT_READY", updated.status)
        self.assertEqual("1.00", updated.confidence)
        self.assertEqual("FALSE", updated.need_human)
        self.assertEqual(1, len(repo.updates))

    def test_sent_ticket_cannot_be_overwritten_or_sent_again(self) -> None:
        item = make_item("SENT")
        repo = FakeRepository(item)
        with self.assertRaises(RuntimeError):
            control.save_draft(
                repo,
                item,
                "new draft",
                operator="DANG_ANH_DUNG",
                operation="SET_DRAFT",
            )
        with self.assertRaises(RuntimeError):
            control.send_item(repo, item, operator="DANG_ANH_DUNG")
        self.assertEqual([], repo.updates)

    def test_handoff_never_sends_customer_message(self) -> None:
        repo = FakeRepository(make_item())
        with tempfile.TemporaryDirectory() as directory:
            with patch.object(control, "AUDIT_PATH", Path(directory) / "audit.jsonl"):
                updated = control.handoff_item(
                    repo,
                    repo.item,
                    "Cần Thu Hà xử lý",
                    "DANG_ANH_DUNG",
                )
        self.assertEqual("HUMAN_HANDOFF", updated.status)
        self.assertEqual("TRUE", updated.need_human)

    def test_config_ensure_is_idempotent_and_binds_skill(self) -> None:
        payload: dict = {}
        topic = config.ensure_topic(
            payload,
            chat_id="865426291",
            topic_name="Điều hành Fanpage Thu Hà",
            skill="thu-ha-inbox",
        )
        topic["thread_id"] = 42
        second = config.ensure_topic(
            payload,
            chat_id="865426291",
            topic_name="Điều hành Fanpage Thu Hà",
            skill="thu-ha-inbox",
        )
        self.assertIs(topic, second)
        self.assertEqual("thu-ha-inbox", second["skill"])
        entries = payload["platforms"]["telegram"]["extra"]["dm_topics"]
        self.assertEqual(1, len(entries))
        self.assertEqual(1, len(entries[0]["topics"]))

    def test_approval_mode_blocks_realtime_auto_sender(self) -> None:
        with patch.dict(os.environ, {"THA_TELEGRAM_CONTROL_MODE": "APPROVAL_REQUIRED"}, clear=False):
            self.assertTrue(bridge.telegram_approval_mode())

    def test_control_module_does_not_start_telegram_poller(self) -> None:
        source = Path(control.__file__).read_text(encoding="utf-8")
        self.assertNotIn("getUpdates", source)
        self.assertNotIn("run_polling", source)
        self.assertIn('"send", "--to"', source)


if __name__ == "__main__":
    unittest.main()
