from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from integrations.hermes import telegram_training_memory as training


class TelegramTrainingMemoryTests(unittest.TestCase):
    def test_apply_lesson_writes_active_memory_and_audit(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "training"
            memory = Path(temporary) / "memories" / "THA_TRAINING_ACTIVE.md"
            lesson = training.apply_lesson(
                {
                    "trigger": "Khách yêu cầu shop tư vấn một sản phẩm cụ thể.",
                    "rule": "Chốt ngay một sản phẩm từ kho, nêu tên và giá; chỉ tư vấn sâu khi khách hỏi tiếp.",
                    "bad_example": "Hỏi lại ngân sách nhiều lần.",
                    "good_example": "Em chốt cho anh sản phẩm A, giá hiện tại là X.",
                    "reason": "Giúp khách quyết định nhanh.",
                },
                "DANG_ANH_DUNG",
                root,
                memory,
            )
            self.assertEqual(lesson.version, "training-v0001")
            self.assertEqual(lesson.status, "ACTIVE")
            self.assertTrue((root / "active").glob("*.json"))
            rendered = memory.read_text(encoding="utf-8")
            self.assertIn("training-v0001", rendered)
            self.assertIn("Chốt ngay một sản phẩm", rendered)
            audit = (root / "audit.jsonl").read_text(encoding="utf-8")
            self.assertIn('"action": "APPLY"', audit)

    def test_next_lesson_is_versioned_and_rollback_removes_latest(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "training"
            memory = Path(temporary) / "memory.md"
            first = training.apply_lesson(
                {"trigger": "Tình huống 1", "rule": "Quy tắc 1"},
                "NONG_THU_HA",
                root,
                memory,
            )
            second = training.apply_lesson(
                {"trigger": "Tình huống 2", "rule": "Quy tắc 2"},
                "DANG_ANH_DUNG",
                root,
                memory,
            )
            self.assertEqual(first.version, "training-v0001")
            self.assertEqual(second.version, "training-v0002")
            rolled_back = training.rollback_latest(
                "DANG_ANH_DUNG", root, memory
            )
            self.assertEqual(rolled_back.version, "training-v0002")
            rendered = memory.read_text(encoding="utf-8")
            self.assertIn("Quy tắc 1", rendered)
            self.assertNotIn("Quy tắc 2", rendered)
            rolled_files = list((root / "rolled_back").glob("*.json"))
            self.assertEqual(len(rolled_files), 1)
            payload = json.loads(rolled_files[0].read_text(encoding="utf-8"))
            self.assertEqual(payload["status"], "ROLLED_BACK")

    def test_unknown_trainer_is_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            with self.assertRaises(ValueError):
                training.apply_lesson(
                    {"trigger": "Test", "rule": "Test"},
                    "UNKNOWN",
                    Path(temporary) / "training",
                    Path(temporary) / "memory.md",
                )

    def test_dynamic_price_or_stock_values_are_not_saved_to_memory(self):
        with tempfile.TemporaryDirectory() as temporary:
            with self.assertRaises(ValueError):
                training.apply_lesson(
                    {
                        "trigger": "Khách hỏi giá",
                        "rule": "Sản phẩm A có giá 170000 đồng và tồn kho 10.",
                    },
                    "DANG_ANH_DUNG",
                    Path(temporary) / "training",
                    Path(temporary) / "memory.md",
                )


if __name__ == "__main__":
    unittest.main()
