from __future__ import annotations

import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class TaskOnlyScheduleContractTests(unittest.TestCase):
    def test_schedule_cutover_has_plan_backup_apply_and_rollback(self):
        text = (ROOT / "configure_task_only_schedules.ps1").read_text(encoding="utf-8")
        self.assertIn('[ValidateSet("Plan", "Apply", "Rollback")]', text)
        for legacy in (
            "Hermes-Operations-Daily-Command-Center",
            "TaskflowDailyBriefMorning",
            "TaskflowDailyBriefMidday",
            "Hermes-Operations-Conditional-Close",
            "TaskflowDailyBriefAfternoon",
            "TaskflowDailyBriefEvening",
            "TaskflowDailyBriefEveningReview",
        ):
            self.assertIn(legacy, text)
        for replacement in (
            "HermesTaskChecklistCommandCenter",
            "HermesTaskChecklistMidday",
            "HermesTaskChecklistAfternoonClose",
            "HermesTaskChecklistEveningReview",
        ):
            self.assertIn(replacement, text)
        self.assertIn("Export-ScheduledTask", text)
        self.assertIn("Disable-ScheduledTask", text)
        self.assertIn("Restore-LegacySchedules", text)
        self.assertIn("manifest.json", text)
        self.assertIn("TASK_ONLY_MODE", text)

    def test_schedule_cutover_is_single_pipeline_and_idempotent(self):
        text = (ROOT / "configure_task_only_schedules.ps1").read_text(encoding="utf-8")
        self.assertIn("one task-only replacement", text)
        self.assertIn("Test-AlreadyApplied", text)
        self.assertIn("TASK_ONLY_SCHEDULE_APPLY=IDEMPOTENT_PASS", text)
        self.assertIn("Partial cutover detected", text)
        self.assertIn("run_task_checklist_digest.ps1", text)
        self.assertNotIn("taskflow_daily_brief.py", text)

    def test_task_only_runner_cannot_fall_back_to_legacy_brief(self):
        text = (ROOT / "run_task_checklist_digest.ps1").read_text(encoding="utf-8")
        self.assertIn("TASK_ONLY_MODE=true is required", text)
        self.assertIn("integrations.hermes.task_checklist_ui digest --send", text)
        self.assertIn("/opt/hermes/.venv/bin/python3", text)
        self.assertNotIn("taskflow_daily_brief.py", text)
        self.assertNotIn("weather", text.lower())
        self.assertNotIn("news", text.lower())

    def test_installer_compiles_before_restart_and_rolls_back_on_failures(self):
        text = (ROOT / "install_task_checklist_polling.ps1").read_text(encoding="utf-8")
        compile_at = text.index("Compile patched adapter and modules before restart")
        restart_at = text.index("Restart verified Hermes gateway")
        self.assertLess(compile_at, restart_at)
        self.assertIn("--rollback", text)
        self.assertIn("Wait-HermesHealth", text)
        self.assertIn("old adapter restored", text)
        for name in (
            "HERMES_TASK_OWNER_USER_ID",
            "HERMES_TASK_CHAT_ID",
            "TASKFLOW_SPREADSHEET_ID",
        ):
            self.assertIn(name, text)

    def test_env_example_enables_task_only_mode_without_real_secrets(self):
        text = (ROOT / ".env.example").read_text(encoding="utf-8")
        self.assertIn("TASK_ONLY_MODE=true", text)
        self.assertNotIn("HERMES_TASK_BOT_TOKEN", text)
        self.assertNotIn("HERMES_TASK_CALLBACK_SECRET", text)


if __name__ == "__main__":
    unittest.main()
