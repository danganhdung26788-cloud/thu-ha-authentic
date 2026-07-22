from __future__ import annotations

import unittest

from integrations.hermes import safe_context_processor as processor


PRODUCTS = [
    {
        "product_id": "P000137",
        "sku": "THA-000137",
        "product_name": "KCN Eucerin Kiềm Dầu & Ngừa Mụn 50ml",
        "sale_price": "440.000",
        "stock_status": "Tồn thấp",
        "public_visible": "TRUE",
        "status": "Đang bán",
    },
    {
        "product_id": "P000329",
        "sku": "THA-000329",
        "product_name": "Dung Dịch Làm Mềm Mụn Đầu Đen Jumiso Blackhead Melting Softener 150ml",
        "sale_price": "275.000",
        "stock_status": "Tồn thấp",
        "public_visible": "TRUE",
        "status": "Đang bán",
    },
    {
        "product_id": "P000018",
        "sku": "THA-000018",
        "product_name": "ETIAXIL Xịt Ngăn Mùi Hôi Chân 100ml",
        "sale_price": "230.000",
        "stock_status": "Tồn thấp",
        "public_visible": "TRUE",
        "status": "Đang bán",
    },
]


class ContextSafetyRegressionTests(unittest.TestCase):
    def test_generic_followup_never_matches_random_catalog_product(self):
        context = [
            {
                "MESSAGE_TEXT": "Da chị dầu và hay mụn ẩn",
                "PRODUCT_KEY": "P000137,P000329",
                "DRAFT_REPLY": "Shop gợi ý KCN Eucerin và Jumiso Blackhead Melting Softener.",
                "CONFIDENCE": "0.82",
                "NEED_HUMAN": "FALSE",
            }
        ]
        selected = processor.resolve_context_products(context, PRODUCTS)
        self.assertEqual(
            [item["product_id"] for item in selected],
            ["P000137", "P000329"],
        )
        self.assertNotIn("P000018", [item["product_id"] for item in selected])

    def test_context_product_keys_support_multiple_products(self):
        context = [
            {
                "PRODUCT_KEY": "P000137,P000329",
                "CONFIDENCE": "0.90",
                "NEED_HUMAN": "FALSE",
            }
        ]
        selected = processor.resolve_context_products(context, PRODUCTS)
        self.assertEqual(
            [item["product_id"] for item in selected],
            ["P000137", "P000329"],
        )

    def test_price_followup_lists_all_recent_recommendations(self):
        quick = processor.quick_products_reply(
            "giá cả như nào vậy em?", [PRODUCTS[0], PRODUCTS[1]]
        )
        self.assertIsNotNone(quick)
        intent, reply = quick
        self.assertEqual(intent, "PRODUCT_PRICE")
        self.assertIn("440.000 đ", reply)
        self.assertIn("275.000 đ", reply)
        self.assertNotIn("ETIAXIL", reply)

    def test_correction_message_stops_automation_and_does_not_repeat(self):
        reply = processor.correction_handoff_reply("trả lời sai rồi, trước đó em tư vấn gì?")
        self.assertIsNotNone(reply)
        self.assertIn("xin lỗi", reply.lower())
        self.assertIn("Thu Hà", reply)
        self.assertTrue(processor.is_correction_or_dispute("trả lời sai rồi"))

    def test_generic_product_words_are_not_explicit_product_match(self):
        selected = processor.explicit_product_mentions("sản phẩm này", PRODUCTS)
        self.assertEqual(selected, [])

    def test_low_confidence_corrupted_key_is_ignored(self):
        context = [
            {
                "MESSAGE_TEXT": "sản phẩm em vừa giới thiệu",
                "PRODUCT_KEY": "P000018",
                "DRAFT_REPLY": "ETIAXIL",
                "CONFIDENCE": "0.55",
                "NEED_HUMAN": "TRUE",
            },
            {
                "MESSAGE_TEXT": "Da chị dầu và hay mụn ẩn",
                "PRODUCT_KEY": "P000137",
                "DRAFT_REPLY": "Shop gợi ý KCN Eucerin và Jumiso Blackhead Melting Softener.",
                "CONFIDENCE": "0.82",
                "NEED_HUMAN": "FALSE",
            },
        ]
        selected = processor.resolve_context_products(list(reversed(context)), PRODUCTS)
        ids = [item["product_id"] for item in selected]
        self.assertIn("P000137", ids)
        self.assertIn("P000329", ids)
        self.assertNotIn("P000018", ids)


if __name__ == "__main__":
    unittest.main()
