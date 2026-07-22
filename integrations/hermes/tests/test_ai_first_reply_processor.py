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


class AiFirstReplyProcessorTests(unittest.TestCase):
    def test_extract_json_from_fence(self):
        payload = processor.extract_json_object(
            '```json\n{"action":"LOOKUP","lookup_type":"USAGE"}\n```'
        )
        self.assertEqual(payload["action"], "LOOKUP")

    def test_parse_plan_keeps_exact_product_reference(self):
        plan = processor.parse_plan(
            {
                "action": "LOOKUP",
                "lookup_type": "USAGE",
                "product_refs": ["KCN Eucerin Kiềm Dầu & Ngừa Mụn 50ml"],
                "intent": "BASIC_USAGE",
                "confidence": 0.94,
            }
        )
        self.assertEqual(plan.action, "LOOKUP")
        self.assertEqual(plan.product_refs[0], "KCN Eucerin Kiềm Dầu & Ngừa Mụn 50ml")

    def test_generic_attribute_never_resolves_catalog_product(self):
        selected = processor.resolve_product_refs(["kiềm dầu"], PRODUCTS)
        self.assertEqual(selected, [])

    def test_exact_context_reference_resolves_only_eucerin(self):
        selected = processor.resolve_product_refs(
            ["KCN Eucerin Kiềm Dầu & Ngừa Mụn 50ml"], PRODUCTS
        )
        self.assertEqual([item["product_id"] for item in selected], ["P000137"])
        self.assertNotIn("P000555", [item["product_id"] for item in selected])

    def test_new_consultation_resets_corrupted_old_context(self):
        rows = [
            {
                "CUSTOMER_ID": "C1",
                "MESSAGE_TEXT": "lại kiềm dầu đi",
                "DRAFT_REPLY": "KCN Beplain Sunmuse Vật Lý kiềm dầu",
            },
            {
                "CUSTOMER_ID": "C1",
                "MESSAGE_TEXT": "TEST CONTEXT SAFE 009 Da chị dầu, shop tư vấn giúp chị",
                "DRAFT_REPLY": "KCN Eucerin Kiềm Dầu & Ngừa Mụn 50ml phù hợp hơn.",
                "INTENT": "PRODUCT_CONSULTATION",
                "CONFIDENCE": "0.82",
                "NEED_HUMAN": "FALSE",
            },
            {
                "CUSTOMER_ID": "C1",
                "MESSAGE_TEXT": "cách dùng như nào em nhỉ",
            },
        ]
        context = processor.conversation_context(rows, 2, "C1", rows[2]["MESSAGE_TEXT"])
        self.assertEqual(len(context), 1)
        self.assertIn("Eucerin", str(context[0]["assistant"]))
        self.assertNotIn("Beplain", str(context))

    def test_plan_prompt_explicitly_forbids_attribute_catalog_switch(self):
        prompt = processor.build_plan_prompt(
            "lại kiềm dầu đi",
            [{"customer": "cách dùng như nào", "assistant": "KCN Eucerin..."}],
        )
        self.assertIn("KHONG co nghia la tim mot san pham moi", prompt)
        self.assertIn("Suy luan theo mach hoi thoai truoc", prompt)

    def test_recommendation_candidates_use_need_not_generic_product_name(self):
        selected = processor.retrieve_recommendation_candidates(
            "da dầu mụn đầu đen lỗ chân lông bít tắc", PRODUCTS
        )
        ids = [item["product_id"] for item in selected]
        self.assertIn("P000329", ids)

    def test_lookup_process_uses_hermes_plan_then_verified_data(self):
        queue = [
            [
                "MESSAGE_ID", "CUSTOMER_ID", "CUSTOMER_NAME", "MESSAGE_TEXT",
                "INTENT", "PRODUCT_KEY", "DRAFT_REPLY", "CONFIDENCE",
                "NEED_HUMAN", "STATUS", "CREATED_AT", "REPLIED_AT", "ERROR",
            ],
            [
                "m1", "C1", "", "TEST CONTEXT SAFE 009 Da chị dầu, tư vấn giúp chị",
                "PRODUCT_CONSULTATION", "P000137", "KCN Eucerin phù hợp.", "0.82",
                "FALSE", "SENT", "2026-07-22T00:00:00+00:00", "", "",
            ],
            [
                "m2", "C1", "", "cách dùng như nào e nhỉ", "UNCLASSIFIED", "",
                "", "", "FALSE", "NEW", "2026-07-22T00:01:00+00:00", "", "",
            ],
        ]
        product_header = list(PRODUCTS[0].keys())
        product_values = [product_header] + [
            [str(product.get(key, "")) for key in product_header] for product in PRODUCTS
        ]
        repo = FakeRepo(queue, product_values)
        plan = processor.ConversationPlan(
            action="LOOKUP",
            lookup_type="USAGE",
            product_refs=("KCN Eucerin Kiềm Dầu & Ngừa Mụn 50ml",),
            search_query="",
            reply="",
            intent="BASIC_USAGE",
            need_human=False,
            confidence=0.95,
        )
        with (
            patch.object(processor, "DRY_RUN", False),
            patch.object(processor, "call_plan", return_value=plan),
            patch.object(
                processor,
                "compose_lookup_reply",
                return_value=("Dạ, chị thoa ở bước cuối buổi sáng ạ.", ""),
            ),
        ):
            eligible, processed, fallbacks = processor.process_new_messages(repo)
        self.assertEqual((eligible, processed, fallbacks), (1, 1, 0))
        decision = repo.updated[0][1]
        self.assertEqual(decision.product_key, "P000137")
        self.assertNotIn("P000555", decision.product_key)
        self.assertIn("bước cuối", decision.reply)


if __name__ == "__main__":
    unittest.main()
