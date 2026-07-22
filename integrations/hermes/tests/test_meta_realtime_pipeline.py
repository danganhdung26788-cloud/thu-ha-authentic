from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from integrations.hermes import meta_messenger_bridge as bridge


class MetaRealtimePipelineTests(unittest.TestCase):
    def test_load_runtime_env_accepts_export_and_quotes(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / ".env"
            path.write_text(
                "export THA_REPLY_MODE=\"NATURAL_AUTO_REPLY\"\n"
                "THA_META_AUTO_SEND='true'\n",
                encoding="utf-8",
            )
            with patch.dict(os.environ, {}, clear=False):
                loaded = bridge.load_runtime_env(path)
                self.assertEqual(loaded["THA_REPLY_MODE"], "NATURAL_AUTO_REPLY")
                self.assertEqual(loaded["THA_META_AUTO_SEND"], "true")
                self.assertEqual(os.environ["THA_REPLY_MODE"], "NATURAL_AUTO_REPLY")

    def test_ingest_appends_marks_and_runs_realtime_pipeline(self):
        with patch.object(bridge.DEDUPE, "seen", return_value=False), patch.object(
            bridge.DEDUPE, "mark"
        ) as mark, patch.object(bridge, "QueueWriter") as writer, patch.object(
            bridge, "run_realtime_pipeline"
        ) as realtime:
            bridge.ingest_message("mid-1", "psid-1", "Giá sản phẩm này bao nhiêu?")

        writer.return_value.append_fanpage_message.assert_called_once_with(
            message_id="mid-1",
            sender_id="psid-1",
            message_text="Giá sản phẩm này bao nhiêu?",
        )
        mark.assert_called_once_with("mid-1")
        realtime.assert_called_once_with()

    def test_ingest_keeps_queue_for_scheduled_retry_when_realtime_fails(self):
        with patch.object(bridge.DEDUPE, "seen", return_value=False), patch.object(
            bridge.DEDUPE, "mark"
        ) as mark, patch.object(bridge, "QueueWriter") as writer, patch.object(
            bridge, "run_realtime_pipeline", side_effect=RuntimeError("temporary")
        ):
            bridge.ingest_message("mid-2", "psid-2", "Shop tư vấn giúp em")

        writer.return_value.append_fanpage_message.assert_called_once()
        mark.assert_called_once_with("mid-2")


if __name__ == "__main__":
    unittest.main()
