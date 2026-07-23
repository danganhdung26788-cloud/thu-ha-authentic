from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from integrations.hermes import telegram_skill_learning as learning


class TelegramSkillLearningTests(unittest.TestCase):
    def make_skill(self, root: Path) -> Path:
        skill = root / "skills" / "thu-ha-cosmetics"
        references = skill / "references"
        references.mkdir(parents=True)
        (skill / "SKILL.md").write_text(
            "---\nname: thu-ha-cosmetics\n---\n# Advisor\n",
            encoding="utf-8",
        )
        (references / "sales-flow.md").write_text(
            "# Sales\n- Chốt một sản phẩm phù hợp.\n",
            encoding="utf-8",
        )
        (references / "tone-and-dialogue.md").write_text(
            "# Tone\n- Trả lời ngắn.\n",
            encoding="utf-8",
        )
        (references / "safety-and-handoff.md").write_text(
            "# Safety\n- Chuyển người thật khi có nguy cơ.\n",
            encoding="utf-8",
        )
        return skill

    def test_snapshot_skill_patch_verify_writes_audit_without_runtime_memory(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            skill = self.make_skill(base)
            root = base / "training" / "skill-learning"
            transaction = learning.snapshot(
                "DANG_ANH_DUNG",
                "Khách cần được chốt sản phẩm nhanh.",
                root=root,
                skill_root=skill,
            )
            sales = skill / "references" / "sales-flow.md"
            sales.write_text(
                "# Sales\n- Khi nhu cầu đã rõ, chốt một sản phẩm có tên và giá; chỉ tư vấn sâu khi khách hỏi tiếp.\n",
                encoding="utf-8",
            )
            active = learning.verify(
                str(transaction["transaction_id"]),
                "DANG_ANH_DUNG",
                root=root,
                skill_root=skill,
            )
            self.assertEqual(active["status"], "ACTIVE")
            self.assertIn("references/sales-flow.md", active["changed_files"])
            self.assertFalse((base / "memories" / "THA_TRAINING_ACTIVE.md").exists())
            audit = (root / "audit.jsonl").read_text(encoding="utf-8")
            self.assertIn('"action": "SNAPSHOT"', audit)
            self.assertIn('"action": "APPLY_SKILL"', audit)

    def test_dynamic_price_is_rejected_and_pending_snapshot_can_be_aborted(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            skill = self.make_skill(base)
            root = base / "training" / "skill-learning"
            original = (skill / "references" / "sales-flow.md").read_text(encoding="utf-8")
            transaction = learning.snapshot(
                "NONG_THU_HA",
                "Test unsafe dynamic data.",
                root=root,
                skill_root=skill,
            )
            (skill / "references" / "sales-flow.md").write_text(
                "# Sales\n- Sản phẩm A có giá 170.000 đ và tồn kho 10.\n",
                encoding="utf-8",
            )
            with self.assertRaises(ValueError):
                learning.verify(
                    str(transaction["transaction_id"]),
                    "NONG_THU_HA",
                    root=root,
                    skill_root=skill,
                )
            aborted = learning.abort_pending(
                str(transaction["transaction_id"]),
                "NONG_THU_HA",
                root=root,
                skill_root=skill,
            )
            self.assertEqual(aborted["status"], "ABORTED")
            restored = (skill / "references" / "sales-flow.md").read_text(encoding="utf-8")
            self.assertEqual(restored, original)

    def test_rollback_latest_restores_skill_before_active_change(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            skill = self.make_skill(base)
            root = base / "training" / "skill-learning"
            tone = skill / "references" / "tone-and-dialogue.md"
            original = tone.read_text(encoding="utf-8")
            transaction = learning.snapshot(
                "DANG_ANH_DUNG",
                "Rút gọn giọng tư vấn.",
                root=root,
                skill_root=skill,
            )
            tone.write_text("# Tone\n- Trả lời một đoạn ngắn, không hỏi lặp.\n", encoding="utf-8")
            learning.verify(
                str(transaction["transaction_id"]),
                "DANG_ANH_DUNG",
                root=root,
                skill_root=skill,
            )
            rolled_back = learning.rollback_latest(
                "DANG_ANH_DUNG",
                root=root,
                skill_root=skill,
            )
            self.assertEqual(rolled_back["status"], "ROLLED_BACK")
            self.assertEqual(tone.read_text(encoding="utf-8"), original)

    def test_unknown_trainer_is_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            skill = self.make_skill(base)
            with self.assertRaises(ValueError):
                learning.snapshot(
                    "UNKNOWN",
                    "Test",
                    root=base / "training",
                    skill_root=skill,
                )


if __name__ == "__main__":
    unittest.main()
