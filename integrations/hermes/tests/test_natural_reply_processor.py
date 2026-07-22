from __future__ import annotations

import subprocess
import unittest
from unittest.mock import patch

from integrations.hermes import natural_reply_processor as processor


PRODUCT_HEADERS = [
    "product_id", "sku", "product_name", "status", "public_visible",
    "sale_price", "current_stock", "stock_status", "usage",
]
PRODUCT_ROW = [
    "p1", "ABC", "Serum ABC", "đang bán", "TRUE",
    "250000", "5", "Còn hàng", "Thoa 2–3 giọt sau bước làm sạch.",
]


class FakeRepository:
    def __init__(self, *, followup: bool = False, generic: bool = False) -> None:
        self.followup = followup
        self.generic = generic
        self.updated = []
        self.statuses = []

    def read(self, range_name: str):
        if range_name.startswith("FANPAGE_QUEUE"):
            headers = [
                "MESSAGE_ID", "CUSTOMER_ID", "CUSTOMER_NAME", "MESSAGE_TEXT",
                "INTENT", "PRODUCT_KEY", "DRAFT_REPLY", "CONFIDENCE",
                "NEED_HUMAN", "STATUS", "CREATED_AT", "REPLIED_AT", "ERROR",
            ]
            if self.followup:
                return [
                    headers,
                    [
                        "m0", "c1", "", "Shop tư vấn Serum ABC giúp chị",
                        "PRODUCT_CONSULTATION", "p1",
                        "Dạ, Serum ABC phù hợp với nhu cầu của chị ạ.",
                        "0.82", "FALSE", "SENT", "2026-07-22T03:00:00+00:00", "", "",
                    ],
                    [
                        "m1", "c1", "", "giá cả như nào vậy e?",
                        "", "", "", "", "", "NEW", "2026-07-22T03:01:00+00:00", "", "",
                    ],
                ]
            message = (
                "Da dầu bí tắc tư vấn giúp chị"
                if self.generic
                else "Serum ABC có phù hợp da dầu không?"
            )
            return [
                headers,
                ["m1", "c1", "", message, "", "", "", "", "", "NEW", "", "", ""],
            ]
        if range_name.startswith("FAQ_COMPACT"):
            return [[
                "INTENT_ID", "QUESTION", "TRIGGERS", "ANSWER_SHORT",
                "ANSWER_FULL", "NEED_HUMAN", "ACTIVE",
            ]]
        if range_name.startswith("PRODUCTS_HOT"):
            return [PRODUCT_HEADERS, PRODUCT_ROW]
        if range_name.startswith("REPLY_POLICY"):
            return [["KEY", "VALUE"]]
        raise AssertionError(range_name)

    def update_status(self, row_number, status, error=""):
        self.statuses.append((row_number, status, error))

    def update_reply(self, row_number, decision):
        self.updated.append((row_number, decision))


class NaturalReplyProcessorTests(unittest.TestCase):
    def product(self):
        return dict(zip(PRODUCT_HEADERS, PRODUCT_ROW))

    def test_requires_human_for_safety_message(self):
        self.assertTrue(processor.requires_human("Em dùng bị sưng và khó thở"))
        self.assertFalse(processor.requires_human("Shop mở cửa mấy giờ?"))

    def test_call_hermes_returns_clean_text(self):
        completed = subprocess.CompletedProcess(
            args=["hermes"], returncode=0,
            stdout="```text\nDạ shop còn hàng chị nhé.\n```", stderr="",
        )
        with patch.object(processor.subprocess, "run", return_value=completed) as run:
            reply = processor.call_hermes("prompt")
        self.assertEqual(reply, "Dạ shop còn hàng chị nhé.")
        self.assertIn("-z", run.call_args.args[0])

    def test_call_hermes_raises_on_failure(self):
        completed = subprocess.CompletedProcess(
            args=["hermes"], returncode=1, stdout="", stderr="provider unavailable",
        )
        with patch.object(processor.subprocess, "run", return_value=completed):
            with self.assertRaises(RuntimeError):
                processor.call_hermes("prompt")

    def test_recent_context_preserves_product_key(self):
        rows = [
            {
                "CUSTOMER_ID": "c1",
                "MESSAGE_TEXT": "Shop tư vấn Serum ABC",
                "PRODUCT_KEY": "p1",
                "DRAFT_REPLY": "Dạ, Serum ABC phù hợp ạ.",
                "STATUS": "SENT",
            },
            {"CUSTOMER_ID": "c1", "MESSAGE_TEXT": "giá bao nhiêu?", "STATUS": "NEW"},
        ]
        context = processor.recent_context(rows, 1, "c1")
        self.assertEqual(context[-1]["PRODUCT_KEY"], "p1")

    def test_followup_price_reuses_active_product(self):
        context = [{"PRODUCT_KEY": "p1", "DRAFT_REPLY": "Dạ Serum ABC phù hợp ạ."}]
        products = processor.select_products(
            "giá cả như nào vậy e?", [self.product()], context=context
        )
        self.assertEqual(products[0]["product_id"], "p1")
        intent, reply = processor.quick_product_reply(
            "giá cả như nào vậy e?", products[0]
        )
        self.assertEqual(intent, "PRODUCT_PRICE")
        self.assertIn("250.000 đ", reply)
        self.assertIn("Serum ABC", reply)

    def test_prompt_marks_active_product_and_continuity_rule(self):
        with patch.object(processor, "read_text", return_value="memory"):
            prompt = processor.build_prompt(
                "giá bao nhiêu?",
                [{"MESSAGE_TEXT": "Em hỏi Serum ABC", "PRODUCT_KEY": "p1"}],
                None,
                [self.product()],
                [],
            )
        self.assertIn('"active_product"', prompt)
        self.assertIn("Serum ABC", prompt)
        self.assertIn("Không hỏi lại tên sản phẩm", prompt)
        self.assertIn("/thu-ha-cosmetics", prompt)

    def test_processes_product_consultation_with_hermes(self):
        repo = FakeRepository()
        with patch.object(processor, "DRY_RUN", False), patch.object(
            processor,
            "call_hermes",
            return_value="Dạ Serum ABC có kết cấu nhẹ, chị nên thử từ lượng nhỏ ạ.",
        ):
            eligible, processed, fallbacks = processor.process_new_messages(repo)
        self.assertEqual((eligible, processed, fallbacks), (1, 1, 0))
        self.assertEqual(repo.statuses[0][1], "PROCESSING")
        row_number, decision = repo.updated[0]
        self.assertEqual(row_number, 2)
        self.assertEqual(decision.status, "DRAFT_READY")
        self.assertEqual(decision.product_key, "p1")
        self.assertFalse(decision.need_human)

    def test_simple_followup_bypasses_model_for_speed(self):
        repo = FakeRepository(followup=True)
        with patch.object(processor, "DRY_RUN", False), patch.object(
            processor, "call_hermes"
        ) as call_hermes:
            eligible, processed, fallbacks = processor.process_new_messages(repo)
        self.assertEqual((eligible, processed, fallbacks), (1, 1, 0))
        call_hermes.assert_not_called()
        row_number, decision = repo.updated[0]
        self.assertEqual(row_number, 3)
        self.assertEqual(decision.intent, "PRODUCT_PRICE")
        self.assertEqual(decision.product_key, "p1")
        self.assertIn("250.000 đ", decision.reply)

    def test_fallback_marks_for_human_review(self):
        repo = FakeRepository(generic=True)
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
