from __future__ import annotations

import unittest

from integrations.hermes.fanpage_draft_processor import decide_draft, match_product, normalize_text


FAQ_ROWS = [
    {
        "INTENT_ID": "FAQ-LOCATION",
        "TRIGGERS": "địa chỉ|shop ở đâu",
        "ANSWER_SHORT": "Shop ở Cao Bằng.",
        "NEED_HUMAN": "FALSE",
        "ACTIVE": "TRUE",
    },
    {
        "INTENT_ID": "FAQ-RETURN",
        "TRIGGERS": "đổi trả|trả hàng",
        "ANSWER_SHORT": "Thu Hà sẽ kiểm tra thêm.",
        "NEED_HUMAN": "TRUE",
        "ACTIVE": "TRUE",
    },
]

PRODUCTS = [
    {
        "product_id": "P000003",
        "sku": "THA-000003",
        "barcode_value": "THA-000003",
        "product_name": "Dove Tẩy Tế Bào Chết Dưỡng Ẩm Toàn Thân 298g",
        "sale_price": "190.000",
        "current_stock": "0",
        "stock_status": "Hết hàng",
        "public_visible": "TRUE",
        "status": "Đang bán",
    },
    {
        "product_id": "P000002",
        "sku": "THA-000002",
        "barcode_value": "THA-000002",
        "product_name": "Bông tẩy trang tròn SenaDemar 225 pcs",
        "sale_price": "75.000",
        "current_stock": "4",
        "stock_status": "Ổn",
        "public_visible": "TRUE",
        "status": "Đang bán",
    },
]


class FanpageDraftProcessorTests(unittest.TestCase):
    def test_normalize_vietnamese(self) -> None:
        self.assertEqual(normalize_text("Địa chỉ Shop?"), "dia chi shop")

    def test_faq_match(self) -> None:
        decision = decide_draft("Shop ở đâu vậy?", FAQ_ROWS, PRODUCTS)
        self.assertEqual(decision.intent, "FAQ-LOCATION")
        self.assertFalse(decision.need_human)
        self.assertEqual(decision.status, "DRAFT_READY")

    def test_return_request_escalates(self) -> None:
        decision = decide_draft("Mình cần đổi trả", FAQ_ROWS, PRODUCTS)
        self.assertEqual(decision.intent, "FAQ-RETURN")
        self.assertTrue(decision.need_human)

    def test_product_out_of_stock(self) -> None:
        decision = decide_draft("THA-000003 còn hàng không?", FAQ_ROWS, PRODUCTS)
        self.assertEqual(decision.product_key, "P000003")
        self.assertEqual(decision.intent, "PRODUCT_STOCK")
        self.assertTrue(decision.need_human)
        self.assertIn("hết hàng", decision.draft_reply.lower())

    def test_product_available(self) -> None:
        product, score = match_product("Bông tẩy trang SenaDemar còn không?", PRODUCTS)
        self.assertIsNotNone(product)
        self.assertGreaterEqual(score, 0.45)
        decision = decide_draft("Bông tẩy trang SenaDemar còn không?", FAQ_ROWS, PRODUCTS)
        self.assertEqual(decision.product_key, "P000002")
        self.assertFalse(decision.need_human)

    def test_generic_fallback_needs_human(self) -> None:
        decision = decide_draft("TEST HERMES", FAQ_ROWS, PRODUCTS)
        self.assertEqual(decision.intent, "UNCLASSIFIED")
        self.assertTrue(decision.need_human)
        self.assertEqual(decision.confidence, 0.30)


if __name__ == "__main__":
    unittest.main()
