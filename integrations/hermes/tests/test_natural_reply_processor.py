from __future__ import annotations

import subprocess
import unittest
from unittest.mock import patch

from integrations.hermes import natural_reply_processor as processor


class FakeRepository:
    def __init__(self) -> None:
        self.updated = []

    def read(self, range_name: str):
        if range_name.startswith("FANPAGE_QUEUE"):
            return [
                [
                    "MESSAGE_ID", "CUSTOMER_ID", "CUSTOMER_NAME", "MESSAGE_TEXT",
                    "INTENT", "PRODUCT_KEY", "DRAFT_REPLY", "CONFIDENCE",
                    "NEED_HUMAN", "STATUS", "CREATED_AT", "REPLIED_AT", "ERROR",
                ],
                ["m1", "c1", "", "Serum ABC giá bao nhiêu?", "", "", "", "", "", "NEW", "", "", ""],
            ]
        if range_name.startswith("FAQ_COMPACT"):
            return [["INTENT_ID", "QUESTION", "TRIGGERS", "ANSWER_SHORT", "ANSWER_FULL", "NEED_HUMAN", "ACTIVE"]]
        if range_name.startswith("PRODUCTS_HOT"):
            return [
                ["product_id", "sku", "product_name", "status", "public_visible", "sale_price", "current_stock", "stock_status"],
                ["p1", "ABC", "Serum ABC", "đang bán", "TRUE", "250000", "5", "Còn hàng"],
            ]
        if range_name.startswith("REPLY_POLICY"):
            return [["KEY", "VALUE"]]
        raise AssertionError(range_name)

    def update_reply(self, row_number, decision):
        self.updated.append((row_number, decision))


class NaturalReplyProcessorTests(unittest.TestCase):
    def test_requires_human_for_safety_message(self):
        self.assertTrue(processor.requires_human("Em dùng bị sưng và khó thở"))
        self.assertFalse(processor.requires_human("Shop mở cửa mấy giờ?"))

    def test_call_hermes_returns_clean_text(self):
        completed = subprocess.CompletedProcess(
            args=["hermes"], returncode=0, stdout="```text\nDạ shop còn hàng chị nhé.\n```", stderr=""
        )
        with patch.object(processor.subprocess, "run", return_value=completed) as run:
            reply = processor.call_hermes("prompt")
        self.assertEqual(reply, "Dạ shop còn hàng chị nhé.")
        self.assertIn("-z", run.call_args.args[0])

    def test_call_hermes_raises_on_failure(self):
        completed = subprocess.CompletedProcess(
            args=["hermes"], returncode=1, stdout="", stderr="provider unavailable"
        )
        with patch.object(processor.subprocess, "run", return_value=completed):
            with self.assertRaises(RuntimeError):
                processor.call_hermes("prompt")

    def test_prompt_contains_only_filtered_grounding(self):
        with patch.object(processor, "read_text", return_value="memory"), patch.object(
            processor.SKILL_PATH, "exists", return_value=True
        ):
            prompt = processor.build_prompt(
                "Serum ABC còn hàng không?",
                [{"MESSAGE_TEXT": "Em hỏi serum ABC"}],
                None,
                [{"product_id": "p1", "product_name": "Serum ABC", "sale_price": "250000"}],
                [],
            )
        self.assertIn("Serum ABC", prompt)
        self.assertIn("memory", prompt)
        self.assertIn("/thu-ha-cosmetics", prompt)

    def test_processes_new_message_with_hermes(self):
        repo = FakeRepository()
        with patch.object(processor, "DRY_RUN", False), patch.object(
            processor, "call_hermes", return_value="Dạ Serum ABC hiện có giá 250.000 đ chị nhé."
        ):
            eligible, processed, fallbacks = processor.process_new_messages(repo)
        self.assertEqual((eligible, processed, fallbacks), (1, 1, 0))
        self.assertEqual(len(repo.updated), 1)
        row_number, decision = repo.updated[0]
        self.assertEqual(row_number, 2)
        self.assertEqual(decision.status, "DRAFT_READY")
        self.assertEqual(decision.product_key, "p1")
        self.assertFalse(decision.need_human)

    def test_fallback_marks_for_human_review(self):
        repo = FakeRepository()
        with patch.object(processor, "DRY_RUN", False), patch.object(
            processor, "call_hermes", side_effect=RuntimeError("offline")
        ):
            _, _, fallbacks = processor.process_new_messages(repo)
        self.assertEqual(fallbacks, 1)
        decision = repo.updated[0][1]
        self.assertTrue(decision.need_human)
        self.assertIn("HERMES_FALLBACK", decision.error)


if __name__ == "__main__":
    unittest.main()
