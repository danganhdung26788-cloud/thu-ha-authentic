from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]

class BackgroundTaskContractTests(unittest.TestCase):
    def test_runner_file(self):
        text = (ROOT / "run_telegram_dispatcher.ps1").read_text(encoding="utf-8")
        self.assertIn("GOOGLE_APPLICATION_CREDENTIALS", text)
        self.assertIn("HermesThuHaTelegramDispatcher", text)

    def test_installer_file(self):
        text = (ROOT / "install_telegram_scheduled_task.ps1").read_text(encoding="utf-8")
        self.assertIn("MultipleInstances IgnoreNew", text)
        self.assertIn("LogonType Interactive", text)

    def test_rollback_file(self):
        text = (ROOT / "uninstall_telegram_scheduled_task.ps1").read_text(encoding="utf-8")
        self.assertIn("Unregister-ScheduledTask", text)

if __name__ == "__main__":
    unittest.main()
