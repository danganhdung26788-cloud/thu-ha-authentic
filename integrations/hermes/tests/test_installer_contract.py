from pathlib import Path
import unittest


class InstallerContractTests(unittest.TestCase):
    def test_installer_uses_lf_script_files_not_multiline_lc(self):
        script = Path("integrations/hermes/install_and_dry_run.ps1").read_text(encoding="utf-8")
        self.assertIn("Write-LfFile", script)
        self.assertIn("bootstrap_install.sh", script)
        self.assertIn("telegram_dry_run.sh", script)
        self.assertNotIn("/bin/sh -lc", script)


if __name__ == "__main__":
    unittest.main()
