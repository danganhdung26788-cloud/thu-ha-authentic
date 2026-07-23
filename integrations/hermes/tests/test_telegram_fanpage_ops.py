from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from integrations.hermes.telegram_fanpage_ops import OpsStore, render_inbox, require_trainer


class TelegramFanpageOpsTests(unittest.TestCase):
    def test_pause_resume_and_audit(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            store = OpsStore(Path(tmp) / "ops.db")
            self.assertFalse(store.is_paused("customer-1"))
            store.pause("customer-1", "DANG_ANH_DUNG", "manual review")
            self.assertTrue(store.is_paused("customer-1"))
            store.audit(
                "DANG_ANH_DUNG",
                "PAUSE",
                {"MESSAGE_ID": "m1", "CUSTOMER_ID": "customer-1"},
                note="manual review",
            )
            count = store.conn.execute("SELECT COUNT(*) FROM audit").fetchone()[0]
            self.assertEqual(count, 1)
            store.resume("customer-1")
            self.assertFalse(store.is_paused("customer-1"))

    def test_only_approved_trainers_can_operate(self) -> None:
        self.assertEqual(require_trainer("dang_anh_dung"), "DANG_ANH_DUNG")
        with self.assertRaises(PermissionError):
            require_trainer("UNKNOWN")

    def test_inbox_renders_exact_identifiers(self) -> None:
        text = render_inbox([{
            "MESSAGE_ID": "m1",
            "CUSTOMER_ID": "c1",
            "STATUS": "DRAFT_READY",
            "MESSAGE_TEXT": "Chào shop",
            "DRAFT_REPLY": "Dạ em chào chị ạ.",
        }])
        self.assertIn("MESSAGE_ID=m1", text)
        self.assertIn("CUSTOMER_ID=c1", text)
        self.assertIn("STATUS=DRAFT_READY", text)


if __name__ == "__main__":
    unittest.main()
