from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from integrations.hermes.cosmetics_training_store import (
    find_message,
    normalize_trainer,
    record_correction,
)


class CosmeticsTrainingStoreTests(unittest.TestCase):
    def setUp(self):
        self.row = {
            "MESSAGE_ID": "m-001",
            "MESSAGE_TEXT": "Da dầu nên dùng gì?",
            "DRAFT_REPLY": "Chị dùng sản phẩm A nhé.",
            "INTENT": "PRODUCT_CONSULTATION",
            "PRODUCT_KEY": "p-001",
        }

    def test_normalize_approved_trainers(self):
        self.assertEqual(normalize_trainer("NONG_THU_HA"), "Nông Thu Hà")
        self.assertEqual(normalize_trainer("Đặng Anh Dũng"), "Đặng Anh Dũng")
        with self.assertRaises(ValueError):
            normalize_trainer("OTHER")

    def test_find_message_requires_unique_row(self):
        self.assertEqual(find_message([self.row], "m-001"), self.row)
        with self.assertRaises(ValueError):
            find_message([], "missing")

    def test_record_correction_is_versioned_and_audited(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            first = record_correction(
                row=self.row,
                corrected_reply="Dạ, da chị có đang bị mụn viêm hay chủ yếu đổ dầu ạ?",
                reason="Cần hỏi thêm trước khi tư vấn",
                trainer="NONG_THU_HA",
                root=root,
            )
            second = record_correction(
                row=self.row,
                corrected_reply="Dạ, chị đang muốn ưu tiên giảm dầu hay giảm mụn ạ?",
                reason="Rút ngắn câu hỏi",
                trainer="DANG_ANH_DUNG",
                root=root,
            )

            self.assertEqual(first.version, "training-v0001")
            self.assertEqual(second.version, "training-v0002")
            self.assertEqual(second.previous_version, "training-v0001")
            pending = list((root / "pending").glob("*.json"))
            self.assertEqual(len(pending), 2)
            payload = json.loads(pending[0].read_text(encoding="utf-8"))
            self.assertEqual(payload["status"], "PENDING")
            audit_lines = (root / "audit.jsonl").read_text(encoding="utf-8").splitlines()
            self.assertEqual(len(audit_lines), 2)

    def test_empty_correction_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(ValueError):
                record_correction(
                    row=self.row,
                    corrected_reply=" ",
                    reason="reason",
                    trainer="NONG_THU_HA",
                    root=Path(directory),
                )


if __name__ == "__main__":
    unittest.main()
