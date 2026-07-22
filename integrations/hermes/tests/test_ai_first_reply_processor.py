from __future__ import annotations

import unittest
from unittest.mock import patch

from integrations.hermes import ai_first_reply_processor as processor


PRODUCTS = [
    {
        "product_id": "P000137",
        "sku": "THA-000137",
        "product_name": "KCN Eucerin Kiềm Dầu & Ngừa Mụn 50ml",
        "sale_price": "440.000",
        "stock_status": "Tồn thấp",
        "skin_type": "Da dầu, da hỗn hợp thiên dầu, da mụn",
        "main_usage": "Chống nắng SPF50+, hỗ trợ kiểm soát dầu, giảm bóng nhờn",
        "usage": "Thoa lượng vừa đủ ở bước cuối chu trình buổi sáng, trước khi ra nắng.",
        "public_visible": "TRUE",
        "status": "Đang bán",
    },
    {
        "product_id": "P000329",
        "sku": "THA-000329",
        "product_name": "Dung Dịch Làm Mềm Mụn Đầu Đen Jumiso Blackhead Melting Softener 150ml",
        "sale_price": "275.000",
        "stock_status": "Tồn thấp",
        "skin_type": "Da dầu, da có mụn đầu đen và lỗ chân lông dễ bít tắc",
        "main_usage": "Làm mềm mụn đầu đen và hỗ trợ làm sạch lỗ chân lông",
        "public_visible": "TRUE",
        "status": "Đang bán",
    },
    {
        "product_id": "P000555",
        "sku": "THA-000555",
        "product_name": "KCN Beplain Sunmuse Vật Lý kiềm dầu SPF 50+ 50ML Xanh Lá",
        "sale_price": "290.000",
        "stock_status": "Tồn thấp",
        "skin_type": "Da dầu",
        "main_usage": "Chống nắng, kiềm dầu",
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


class ConversationNativeProcessorTests(unittest.TestCase):
    def product_values(self):
        header = list(PRODUCTS[0].keys())
        return [header] + [
            [str(product.get(key, "")) for key in header] for product in PRODUCTS
        ]

    def test_greeting_does_not_reset_or_require_tool(self):
        self.assertFalse(processor.is_conversation_reset("xin chào"))
        text, request = processor.split_natural_response(
            "Dạ em chào chị ạ 😊 Chị cần em hỗ trợ gì hôm nay?"
        )
        self.assertIn("chào chị", text)
        self.assertIsNone(request)

    def test_tool_marker_is_optional_and_hidden(self):
        raw = (
            "Dạ để em kiểm tra đúng giá cho chị nhé.\n"
            '[[THA_TOOL:{"name":"PRODUCT_FACTS","lookup_type":"PRICE",'
            '"product_refs":["KCN Eucerin Kiềm Dầu & Ngừa Mụn 50ml"]}]]'
        )
        text, request = processor.split_natural_response(raw)
        self.assertNotIn("THA_TOOL", text)
        self.assertEqual(request.name, "PRODUCT_FACTS")
        self.assertEqual(request.lookup_type, "PRICE")

    def test_malformed_tool_marker_keeps_natural_text(self):
        text, request = processor.split_natural_response(
            "Dạ chị nói thêm giúp em nhé.\n[[THA_TOOL:{không hợp lệ}]]"
        )
        self.assertEqual(text, "Dạ chị nói thêm giúp em nhé.")
        self.assertIsNone(request)

    def test_generic_attribute_never_resolves_catalog_product(self):
        selected = processor.resolve_product_refs(["kiềm dầu"], PRODUCTS)
        self.assertEqual(selected, [])

    def test_exact_reference_resolves_eucerin_only(self):
        selected = processor.resolve_product_refs(
            ["KCN Eucerin Kiềm Dầu & Ngừa Mụn 50ml"], PRODUCTS
        )
        self.assertEqual([item["product_id"] for item in selected], ["P000137"])

    def test_prompt_forbids_handoff_for_normal_uncertainty(self):
        prompt = processor.build_conversation_prompt("xin chào", [])
        self.assertIn("Không chuyển Thu Hà chỉ vì thiếu ngữ cảnh", prompt)
        self.assertIn("Câu chào", prompt)
        self.assertIn("Không dùng THA_TOOL cho câu chào", prompt)

    def test_plain_greeting_processes_as_natural_conversation(self):
        queue = [
            [
                "MESSAGE_ID", "CUSTOMER_ID", "CUSTOMER_NAME", "MESSAGE_TEXT",
                "INTENT", "PRODUCT_KEY", "DRAFT_REPLY", "CONFIDENCE",
                "NEED_HUMAN", "STATUS", "CREATED_AT", "REPLIED_AT", "ERROR",
            ],
            [
                "m1", "C1", "", "xin chào", "UNCLASSIFIED", "", "", "",
                "FALSE", "NEW", "2026-07-22T00:00:00+00:00", "", "",
            ],
        ]
        repo = FakeRepo(queue, self.product_values())
        with (
            patch.object(processor, "DRY_RUN", False),
            patch.object(
                processor,
                "call_conversation",
                return_value=("Dạ em chào chị ạ 😊 Chị cần em hỗ trợ gì?", None),
            ),
        ):
            eligible, processed, fallbacks = processor.process_new_messages(repo)
        self.assertEqual((eligible, processed, fallbacks), (1, 1, 0))
        decision = repo.updated[0][1]
        self.assertEqual(decision.intent, "NATURAL_CONVERSATION")
        self.assertFalse(decision.need_human)
        self.assertNotIn("chuyển Thu Hà", decision.reply)

    def test_normal_clarification_does_not_force_handoff(self):
        queue = [
            [
                "MESSAGE_ID", "CUSTOMER_ID", "CUSTOMER_NAME", "MESSAGE_TEXT",
                "INTENT", "PRODUCT_KEY", "DRAFT_REPLY", "CONFIDENCE",
                "NEED_HUMAN", "STATUS", "CREATED_AT", "REPLIED_AT", "ERROR",
            ],
            [
                "m1", "C1", "", "đây chỉ là một câu hỏi bình thường thôi",
                "UNCLASSIFIED", "", "", "", "FALSE", "NEW",
                "2026-07-22T00:00:00+00:00", "", "",
            ],
        ]
        repo = FakeRepo(queue, self.product_values())
        with (
            patch.object(processor, "DRY_RUN", False),
            patch.object(
                processor,
                "call_conversation",
                return_value=("Dạ vâng ạ, chị cứ hỏi tự nhiên nhé 😊", None),
            ),
        ):
            processor.process_new_messages(repo)
        decision = repo.updated[0][1]
        self.assertFalse(decision.need_human)
        self.assertIn("cứ hỏi tự nhiên", decision.reply)

    def test_verified_lookup_occurs_only_after_hermes_requests_it(self):
        queue = [
            [
                "MESSAGE_ID", "CUSTOMER_ID", "CUSTOMER_NAME", "MESSAGE_TEXT",
                "INTENT", "PRODUCT_KEY", "DRAFT_REPLY", "CONFIDENCE",
                "NEED_HUMAN", "STATUS", "CREATED_AT", "REPLIED_AT", "ERROR",
            ],
            [
                "m1", "C1", "", "KCN Eucerin dùng như nào?", "UNCLASSIFIED",
                "", "", "", "FALSE", "NEW", "2026-07-22T00:00:00+00:00", "", "",
            ],
        ]
        repo = FakeRepo(queue, self.product_values())
        request = processor.ToolRequest(
            name="PRODUCT_FACTS",
            lookup_type="USAGE",
            product_refs=("KCN Eucerin Kiềm Dầu & Ngừa Mụn 50ml",),
        )
        with (
            patch.object(processor, "DRY_RUN", False),
            patch.object(
                processor,
                "call_conversation",
                return_value=("Dạ để em kiểm tra đúng cách dùng nhé.", request),
            ),
            patch.object(
                processor,
                "compose_grounded_reply",
                return_value="Dạ chị thoa ở bước cuối chu trình buổi sáng ạ.",
            ),
        ):
            eligible, processed, fallbacks = processor.process_new_messages(repo)
        self.assertEqual((eligible, processed, fallbacks), (1, 1, 0))
        decision = repo.updated[0][1]
        self.assertEqual(decision.product_key, "P000137")
        self.assertIn("bước cuối", decision.reply)

    def test_hermes_failure_greeting_fallback_is_not_handoff(self):
        self.assertIn("chào chị", processor.natural_failure_fallback("xin chào"))
        self.assertNotIn("chuyển Thu Hà", processor.natural_failure_fallback("xin chào"))


if __name__ == "__main__":
    unittest.main()
