import hashlib
import hmac
import tempfile
import unittest
from pathlib import Path

from integrations.hermes.meta_messenger_bridge import verify_signature
from integrations.hermes.telegram_dispatcher import Settings, StateStore, choose_thread, eligible


class TelegramDispatcherTests(unittest.TestCase):
    def setUp(self):
        self.settings = Settings(
            bot_token="test-value",
            fast_index_id="fast",
            control_db_id="control",
            digest_thread_id=4592,
            alert_thread_id=4578,
            state_db=Path(tempfile.mkdtemp()) / "state.db",
            dry_run=True,
            max_batch=20,
        )

    def test_thread_mapping(self):
        self.assertEqual(choose_thread("ALERT", self.settings), 4578)
        self.assertEqual(choose_thread("DIGEST", self.settings), 4592)
        self.assertEqual(choose_thread("", self.settings), 4592)

    def test_eligible_statuses(self):
        items = [
            {"EVENT_ID": "1", "STATUS": "PENDING"},
            {"EVENT_ID": "2", "STATUS": "PENDING_SMOKE_TEST"},
            {"EVENT_ID": "3", "STATUS": "SENT"},
            {"EVENT_ID": "", "STATUS": "PENDING"},
        ]
        self.assertEqual([item["EVENT_ID"] for item in eligible(items)], ["1", "2"])

    def test_idempotency(self):
        store = StateStore(self.settings.state_db)
        self.assertFalse(store.already_sent("evt-1"))
        store.mark_sent("evt-1", "123")
        self.assertTrue(store.already_sent("evt-1"))


class MetaBridgeTests(unittest.TestCase):
    def test_signature(self):
        key = "abc"
        body = b'{"object":"page"}'
        digest = hmac.new(key.encode(), body, hashlib.sha256).hexdigest()
        self.assertTrue(verify_signature(body, f"sha256={digest}", key))
        self.assertFalse(verify_signature(body, "sha256=bad", key))
        self.assertFalse(verify_signature(body, None, key))


if __name__ == "__main__":
    unittest.main()
