from __future__ import annotations

import unittest
from unittest.mock import patch

from integrations.hermes import conversation_runtime_processor as processor


PRODUCTS = [
    {
        "product_id": "P-LIP-1",
        "sku": "LIP-1",
        "product_name": "Son môi Rouge Velvet 500",
        "sale_price": "490.000",
        "current_stock": "3",
        "stock_status": "Tồn",
        "main_usage": "Son môi lì",
        "short_description": "Son môi màu đỏ đất",
        "public_visible": "TRUE",
        "status": "Đang bán",
    },
    {
        "product_id": "P-LIP-2",
        "sku": "LIP-2",
        "product_name": "Lip Tint Coral",
        "sale_price": "250.000",
        "current_stock": "4",
        "stock_status": "Tồn",
        "main_usage": "Son tint cho môi",
        "short_description": "Màu cam san hô",
        "public_visible": "TRUE",
        "status": "Đang bán",
    },
    {
        "product_id": "P-COTTON",
        "sku": "COTTON",
        "product_name": "Bông tẩy trang",
        "sale_price": "38.000",
        "current_stock": "5",
        "stock_status": "Tồn",
        "main_usage": "Làm sạch",
        "public_visible": "TRUE",
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


class ConversationRuntimeProcessorTests(unittest.TestCase):
    def product_values(self, products=PRODUCTS):
        header = list(products[0].keys())
        return [header] + [
            [str(product.get(key, "")) for key in header] for product in products
        ]

    def test_runtime_env_always_sets_persistent_hermes_home(self):
        with patch.dict(processor.os.environ, {}, clear=True):
            env = processor._runtime_env()
        self.assertEqual(env["HERMES_HOME"], "/opt/data")
        self.assertIn("/opt/data/tha-integrations", env["PYTHONPATH"])

    def test_budget_parser_understands_500_thousand(self):
        amount, mode = processor.extract_budget_vnd("son môi tầm 500 nghìn")
        self.assertEqual(amount, 500000)
        self.assertEqual(mode, "TARGET")

    def test_recommendation_filters_product_type_and_price(self):
        selected = processor.retrieve_recommendation_candidates(
            "son môi đẹp tầm 500 nghìn", PRODUCTS
        )
        self.assertEqual([item["product_id"] for item in selected], ["P-LIP-1"])
        self.assertNotIn("P-COTTON", [item["product_id"] for item in selected])

    def test_no_lip_product_returns_honest_no_match(self):
        no_lips = [PRODUCTS[2]]
        selected = processor.retrieve_recommendation_candidates(
            "son môi tầm 500 nghìn", no_lips
        )
        self.assertEqual(selected, [])
        reply = processor.no_matching_product_reply(
            "bên em có son môi tầm 500 nghìn không?"
        )
        self.assertIn("chưa thấy son môi phù hợp", reply)
        self.assertIn("500.000 đ", reply)
        self.assertNotIn("nói thêm giúp em", reply)

    def test_emergency_fallback_never_repeats_generic_clarification(self):
        reply = processor.natural_failure_fallback(
            "bên em có son môi tầm 500 nghìn không?", [PRODUCTS[2]]
        )
        self.assertIn("chưa thấy son môi phù hợp", reply)
        self.assertNotIn("nói thêm giúp em", reply)

    def test_process_uses_grounded_recommendation_requested_by_hermes(self):
        queue = [
            [
                "MESSAGE_ID", "CUSTOMER_ID", "CUSTOMER_NAME", "MESSAGE_TEXT",
                "INTENT", "PRODUCT_KEY", "DRAFT_REPLY", "CONFIDENCE",
                "NEED_HUMAN", "STATUS", "CREATED_AT", "REPLIED_AT", "ERROR",
            ],
            [
                "m1", "C1", "", "son môi tầm 500 nghìn", "UNCLASSIFIED",
                "", "", "", "FALSE", "NEW", "2026-07-22T00:00:00+00:00", "", "",
            ],
        ]
        repo = FakeRepo(queue, self.product_values())
        request = processor.ToolRequest(
            name="RECOMMEND_PRODUCTS",
            search_query="son môi khoảng 500 nghìn",
        )
        with (
            patch.object(processor, "DRY_RUN", False),
            patch.object(
                processor,
                "call_conversation",
                return_value=("Dạ để em kiểm tra mẫu phù hợp nhé.", request),
            ),
            patch.object(
                processor,
                "compose_grounded_reply",
                return_value="Dạ chị tham khảo Son môi Rouge Velvet 500 giá 490.000đ ạ.",
            ),
        ):
            eligible, processed, fallbacks = processor.process_new_messages(repo)
        self.assertEqual((eligible, processed, fallbacks), (1, 1, 0))
        decision = repo.updated[0][1]
        self.assertEqual(decision.product_key, "P-LIP-1")
        self.assertIn("490.000", decision.reply)

    def test_process_runtime_failure_uses_grounded_no_match(self):
        queue = [
            [
                "MESSAGE_ID", "CUSTOMER_ID", "CUSTOMER_NAME", "MESSAGE_TEXT",
                "INTENT", "PRODUCT_KEY", "DRAFT_REPLY", "CONFIDENCE",
                "NEED_HUMAN", "STATUS", "CREATED_AT", "REPLIED_AT", "ERROR",
            ],
            [
                "m1", "C1", "", "son môi tầm 500 nghìn", "UNCLASSIFIED",
                "", "", "", "FALSE", "NEW", "2026-07-22T00:00:00+00:00", "", "",
            ],
        ]
        repo = FakeRepo(queue, self.product_values([PRODUCTS[2]]))
        with (
            patch.object(processor, "DRY_RUN", False),
            patch.object(
                processor,
                "call_conversation",
                side_effect=RuntimeError("Hermes runtime unavailable"),
            ),
        ):
            eligible, processed, fallbacks = processor.process_new_messages(repo)
        self.assertEqual((eligible, processed, fallbacks), (1, 1, 1))
        decision = repo.updated[0][1]
        self.assertIn("chưa thấy son môi phù hợp", decision.reply)
        self.assertIn("HERMES_NATURAL_FALLBACK", decision.error)


if __name__ == "__main__":
    unittest.main()
