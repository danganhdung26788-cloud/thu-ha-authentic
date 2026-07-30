from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from integrations.hermes.patch_telegram_polling_adapter import (
    CALLBACK_BEGIN,
    TEXT_BEGIN,
    patch_adapter,
    rollback_adapter,
)


FIXTURE = """class Adapter:
    async def callback(self, query, context):
        data = query.data
        # --- Model picker callbacks ---
        return

    async def _handle_text_message(self, update, context):
        msg = update.effective_message
        if not self._should_process_message(msg):
            return
"""


class AdapterPatchTests(unittest.TestCase):
    def test_patch_is_idempotent_and_rollback_restores_exact_source(self):
        with tempfile.TemporaryDirectory() as directory:
            adapter = Path(directory) / "adapter.py"
            adapter.write_text(FIXTURE, encoding="utf-8")
            self.assertTrue(patch_adapter(adapter))
            patched = adapter.read_text(encoding="utf-8")
            self.assertIn(CALLBACK_BEGIN, patched)
            self.assertIn(TEXT_BEGIN, patched)
            self.assertIn("handle_callback_query(query, context)", patched)
            self.assertIn("maybe_handle_text_message(update, context)", patched)
            self.assertFalse(patch_adapter(adapter))
            rollback_adapter(adapter)
            self.assertEqual(FIXTURE, adapter.read_text(encoding="utf-8"))

    def test_changed_adapter_anchor_fails_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            adapter = Path(directory) / "adapter.py"
            adapter.write_text("class Adapter: pass\n", encoding="utf-8")
            with self.assertRaises(RuntimeError):
                patch_adapter(adapter)


if __name__ == "__main__":
    unittest.main()
