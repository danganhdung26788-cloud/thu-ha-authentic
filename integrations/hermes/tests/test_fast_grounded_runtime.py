from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from integrations.hermes import conversation_runtime_processor as processor


PRODUCTS = [
    {
        "product_id": "P-MASK-1",
        "sku": "MASK-1",
        "barcode_value": "MASK-1",
        "product_name": "Mặt Nạ Banobagi Stem Cell Dưỡng Sáng Và Cấp Ẩm Cho Da 30g",
        "sale_price": "170.000",
        "current_stock": "10",
        "stock_status": "Tồn",
        "skin_type": "Da khô nhẹ, da thiếu ẩm, da xỉn màu",
        "main_usage": "Cấp ẩm, dưỡng sáng và làm mềm da.",
        "short_description": "Mặt nạ giấy dưỡng sáng, cấp ẩm và giúp da rạng rỡ hơn.",
        "public_visible": "TRUE",
        "allow_online_order": "FALSE",
        "status": "Đang bán",
    },
    {
        "product_id": "P-MASK-2",
        "sku": "MASK-2",
        "barcode_value": "MASK-2",
        "product_name": "Mặt nạ đất sét làm sạch dầu",
        "sale_price": "295.000",
        "current_stock": "2",
        "stock_status": "Tồn thấp",
        "skin_type": "Da dầu, da lỗ chân lông to",
        "main_usage": "Hút dầu và làm sạch lỗ chân lông.",
        "short_description": "Mặt nạ đất sét cho da dầu.",
        "public_visible": "TRUE",
        "allow_online_order": "FALSE",
        "status": "Đang bán",
    },
]


class FakeRepo:
    def __init__(self, queue_values, product_values):
        self.queue_values = queue_values
        self.product_values = product_values
        self.updated = []
        self.statuses = []

    def read(self, range_name):
        if range_name.startswith("FANPAGE_QUEUE"):
            return self.queue_values
        if range_name.startswith("PRODUCTS_HOT"):
            return self.product_values
        return []

    def update_status(self, row_number, status, error=""):
        self.statuses.append((row_number, status, error))

    def update_reply(self, row_number, decision):
        self.updated.append((row_number, decision))


def product_values(products=PRODUCTS):
    header = list(products[0].keys())
    return [header] + [[str(product.get(key, "")) for key in header] for product in products]


def queue_header():
    return [
        "MESSAGE_ID", "CUSTOMER_ID", "CUSTOMER_NAME", "MESSAGE_TEXT",
        "INTENT", "PRODUCT_KEY", "DRAFT_REPLY", "CONFIDENCE",
        "NEED_HUMAN", "STATUS", "CREATED_AT", "REPLIED_AT", "ERROR",
    ]


class FastGroundedRuntimeTests(unittest.TestCase):
    def test_followup_without_budget_forces_one_grounded_product(self):
        queue = [
            queue_header(),
            [
                "m1", "C1", "", "chị muốn mua mặt nạ dưỡng da, da chị hơi khô",
                "NATURAL_CONVERSATION", "", "Dạ chị thích loại nào ạ?", "0.86",
                "FALSE", "SENT", "2026-07-22T09:41:00+00:00", "", "",
            ],
            [
                "m2", "C1", "", "tư vấn anh loại giấy đi, cho anh tham khảo mức giá luôn",
                "NATURAL_CONVERSATION", "", "Anh cho em xin ngân sách ạ?", "0.86",
                "FALSE", "SENT", "2026-07-22T09:42:00+00:00", "", "",
            ],
            [
                "m3", "C1", "", "bao nhiêu cũng được, em cứ gửi anh tham khảo",
                "UNCLASSIFIED", "", "", "", "FALSE", "NEW",
                "2026-07-22T09:43:00+00:00", "", "",
            ],
        ]
        repo = FakeRepo(queue, product_values())
        with (
            patch.object(processor, "DRY_RUN", False),
            patch.object(
                processor,
                "call_conversation",
                side_effect=AssertionError("forced product lookup must skip generic model reply"),
            ),
        ):
            result = processor.process_new_messages(repo)
        self.assertEqual(result, (1, 1, 0))
        decision = repo.updated[0][1]
        self.assertEqual(decision.intent, "PRODUCT_CONSULTATION")
        self.assertEqual(decision.product_key, "P-MASK-1")
        self.assertIn("Mặt Nạ Banobagi", decision.reply)
        self.assertIn("170.000", decision.reply)
        self.assertNotIn("ngân sách", decision.reply.casefold())
        self.assertNotIn("?", decision.reply)

    def test_customer_says_choose_any_one_and_gets_product_not_generic_group(self):
        context = [
            {
                "customer": "chị muốn mua mặt nạ giấy cho da khô và sáng da",
                "assistant": "",
                "intent": "NATURAL_CONVERSATION",
                "product_key": "",
                "reliable": True,
            }
        ]
        request = processor.infer_forced_request("cứ lấy bừa 1 loại đi", context)
        self.assertIsNotNone(request)
        self.assertEqual(request.name, "RECOMMEND_PRODUCTS")
        selected = processor.retrieve_recommendation_candidates(request.search_query, PRODUCTS, limit=1)
        self.assertEqual([item["product_id"] for item in selected], ["P-MASK-1"])
        reply = processor.fast_product_choice_reply(selected[0], "cứ lấy bừa 1 loại đi", context)
        self.assertIn("Mặt Nạ Banobagi", reply)
        self.assertIn("170.000", reply)

    def test_usage_followup_reuses_product_key(self):
        queue = [
            queue_header(),
            [
                "m1", "C1", "", "em chốt mặt nạ này nhé",
                "PRODUCT_CONSULTATION", "P-MASK-1",
                "Dạ em chốt Mặt Nạ Banobagi giá 170.000 đ ạ.", "0.94",
                "FALSE", "SENT", "2026-07-22T09:41:00+00:00", "", "",
            ],
            [
                "m2", "C1", "", "cách dùng loại em vừa giới thiệu như nào?",
                "UNCLASSIFIED", "", "", "", "FALSE", "NEW",
                "2026-07-22T09:42:00+00:00", "", "",
            ],
        ]
        repo = FakeRepo(queue, product_values())
        with patch.object(processor, "DRY_RUN", False):
            result = processor.process_new_messages(repo)
        self.assertEqual(result, (1, 1, 0))
        decision = repo.updated[0][1]
        self.assertEqual(decision.intent, "BASIC_USAGE")
        self.assertEqual(decision.product_key, "P-MASK-1")
        self.assertIn("Mặt Nạ Banobagi", decision.reply)
        self.assertIn("Cấp ẩm", decision.reply)

    def test_active_telegram_training_memory_is_injected_each_turn(self):
        with tempfile.TemporaryDirectory() as temporary:
            memory_path = Path(temporary) / "THA_TRAINING_ACTIVE.md"
            memory_path.write_text(
                "Quy tắc: Chốt ngay một sản phẩm có tên và giá.\n",
                encoding="utf-8",
            )
            with patch.object(processor, "ACTIVE_TRAINING_MEMORY_PATH", memory_path):
                prompt = processor.build_conversation_prompt("tư vấn mặt nạ", [])
        self.assertIn("TRAINING ĐANG CÓ HIỆU LỰC", prompt)
        self.assertIn("Chốt ngay một sản phẩm có tên và giá", prompt)


if __name__ == "__main__":
    unittest.main()
