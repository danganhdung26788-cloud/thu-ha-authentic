from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]


class TelegramUatContractTests(unittest.TestCase):
    def read(self, name: str) -> str:
        return (ROOT / name).read_text(encoding="utf-8")

    def test_uat_reads_pos_web_app_with_readonly_scope(self):
        catalog = self.read("product_catalog.py")
        uat = self.read("telegram_uat.py")
        self.assertIn("spreadsheets.readonly", catalog)
        self.assertIn("1doVqvBOq0sn7mQ3LgfAuZfvfjW08jIWdvswgYTwiY-s", catalog)
        self.assertIn("Products!A1:AN2000", catalog)
        self.assertIn("POS_WEBAPP_PRODUCTS_SOURCE_OF_TRUTH", uat)
        self.assertIn("send_to_customer: bool = False", uat)
        self.assertIn("queue_writes: int = 0", uat)
        self.assertIn("meta_calls: int = 0", uat)
        self.assertNotIn("meta_outbound_sender", uat)
        self.assertNotIn("update_reply(", uat)
        self.assertNotIn("update_status(", uat)

    def test_messenger_runtime_overlays_products_from_pos_source(self):
        runtime = self.read("conversation_runtime_processor.py")
        self.assertIn("overlay_source_of_truth", runtime)
        self.assertIn("POS_WEBAPP_PRODUCTS_SOURCE_OF_TRUTH", runtime)
        self.assertIn("bảng Products gốc", runtime)

    def test_uat_skill_and_installer_are_fail_closed(self):
        skill = self.read("skills/thu-ha-uat/SKILL.md")
        installer = self.read("install_telegram_uat.ps1")
        self.assertIn("name: thu-ha-uat", skill)
        self.assertIn("/thu-ha-uat", skill)
        self.assertIn("SEND_TO_CUSTOMER=FALSE", skill)
        self.assertIn("THA_REPLY_MODE' -Value 'DRAFT_ONLY", installer)
        self.assertIn("THA_META_AUTO_SEND' -Value 'false", installer)
        self.assertIn("THA_PRODUCT_SOURCE_MODE' -Value 'POS_WEBAPP", installer)
        self.assertIn("UAT_QUEUE_WRITES=0", installer)
        self.assertIn("UAT_META_CALLS=0", installer)
        self.assertNotIn("META_PAGE_ACCESS_TOKEN", installer)
        self.assertNotIn("gateway run", installer)


if __name__ == "__main__":
    unittest.main()
