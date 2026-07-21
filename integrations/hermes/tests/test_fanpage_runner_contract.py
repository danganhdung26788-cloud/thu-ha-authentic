from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]


class FanpageRunnerContractTests(unittest.TestCase):
    def test_runner_exports_pythonpath_without_literal_backslashes(self):
        text = (ROOT / "run_fanpage_draft_processor.ps1").read_text(encoding="utf-8")
        self.assertIn('export PYTHONPATH="$ROOT:$ROOT/.vendor"', text)
        self.assertNotIn('export PYTHONPATH=\\"', text)

    def test_runner_exports_google_credentials_without_literal_backslashes(self):
        text = (ROOT / "run_fanpage_draft_processor.ps1").read_text(encoding="utf-8")
        self.assertIn('export GOOGLE_APPLICATION_CREDENTIALS="$CREDENTIALS"', text)
        self.assertNotIn('export GOOGLE_APPLICATION_CREDENTIALS=\\"', text)


if __name__ == "__main__":
    unittest.main()
