from __future__ import annotations

import unittest
from unittest.mock import patch

from integrations.hermes import product_catalog
from integrations.hermes import telegram_uat


PRODUCTS = [
    {
        "product_id": "P000181",
        "sku": "THA-000181",
        "barcode_value": "THA-000181",
        "product_name": "Mặt Nạ Banobagi Stem Cell Dưỡng Sáng Và Cấp Ẩm Cho Da White & Moisture 30g",
        "sale_price": "170.000",
        "current_stock": "10",
        "stock_status": "Tồn",
        "skin_type": "Da khô nhẹ, da thiếu ẩm, da xỉn màu",
        "main_usage": "Mặt nạ giấy dưỡng sáng, cấp ẩm, làm mềm và giúp da rạng rỡ hơn.",
        "short_description": "Mặt nạ giấy dưỡng sáng, cấp ẩm, làm mềm và giúp da rạng rỡ hơn.",
        "image_url": "https://example.test/p000181.jpg",
        "public_visible": "TRUE",
        "allow_online_order": "FALSE",
        "status": "Đang bán",
    },
    {
        "product_id": "P000178",
        "product_name": "Mặt nạ Beplain Mung Bean Pore Clay Mask 120ml",
        "sale_price": "295.000",
        "current_stock": "2",
        "stock_status": "Tồn thấp",
        "skin_type": "Da dầu, lỗ chân lông to",
        "main_usage": "Mặt nạ đất sét hút dầu.",
        "short_description": "Mặt nạ đất sét làm sạch sâu.",
        "public_visible": "TRUE",
        "status": "Đang bán",
    },
]


def values(products=PRODUCTS):
    header = list(products[0].keys())
    return [header] + [[str(product.get(key, "")) for key in header] for product in products]


class FakeQueueRepo:
    def __init__(self):
        self.read_calls = []
        self.status_writes = []
        self.reply_writes = []

    def read(self, range_name):
        self.read_calls.append(range_name)
        return [["MESSAGE_ID"], ["m1"]]

    def update_status(self, row_number, status, error=""):
        self.status_writes.append((row_number, status, error))

    def update_reply(self, row_number, decision):
        self.reply_writes.append((row_number, decision))


class FakeCatalog:
    def read_product_values(self):
        return values()


class TelegramUatTests(unittest.TestCase):
    def test_catalog_overlay_reads_products_from_pos_and_delegates_queue(self):
        queue = FakeQueueRepo()
        overlay = product_catalog.ProductCatalogOverlayRepository(
            queue,
            catalog_factory=FakeCatalog,
        )
        self.assertEqual(overlay.read("PRODUCTS_HOT!A1:X1000"), values())
        self.assertEqual(overlay.read("FANPAGE_QUEUE!A1:M10"), [["MESSAGE_ID"], ["m1"]])
        overlay.update_status(2, "PROCESSING")
        overlay.update_reply(2, object())
        self.assertEqual(queue.status_writes[0][:2], (2, "PROCESSING"))
        self.assertEqual(len(queue.reply_writes), 1)

    def test_uat_uses_original_product_and_never_writes_or_sends(self):
        result = telegram_uat.advise(
            "Anh muốn mua mặt nạ giấy cho da hơi khô và muốn da sáng hơn, giá bao nhiêu cũng được.",
            product_rows=PRODUCTS,
        )
        self.assertEqual(result.status, "PASS")
        self.assertEqual(result.mode, "READ_ONLY_TELEGRAM_UAT")
        self.assertEqual(result.source, "POS_WEBAPP_PRODUCTS_SOURCE_OF_TRUTH")
        self.assertEqual(result.product_key, "P000181")
        self.assertIn("Mặt Nạ Banobagi", result.reply)
        self.assertIn("170.000", result.reply)
        self.assertEqual(result.current_stock, "10")
        self.assertFalse(result.send_to_customer)
        self.assertEqual(result.queue_writes, 0)
        self.assertEqual(result.meta_calls, 0)

    def test_uat_followup_uses_previous_product_key(self):
        context = [
            {
                "customer": "Anh muốn mặt nạ giấy cho da khô",
                "assistant": "Dạ em chốt Mặt Nạ Banobagi giá 170.000 đ ạ.",
                "intent": "PRODUCT_CONSULTATION",
                "product_key": "P000181",
                "reliable": True,
            }
        ]
        result = telegram_uat.advise(
            "Cách dùng loại em vừa giới thiệu như nào?",
            context,
            product_rows=PRODUCTS,
        )
        self.assertEqual(result.product_key, "P000181")
        self.assertEqual(result.intent, "BASIC_USAGE")
        self.assertIn("Mặt Nạ Banobagi", result.reply)

    def test_cli_product_source_id_is_web_app_pos(self):
        self.assertEqual(
            product_catalog.POS_SPREADSHEET_ID,
            "1doVqvBOq0sn7mQ3LgfAuZfvfjW08jIWdvswgYTwiY-s",
        )


if __name__ == "__main__":
    unittest.main()
