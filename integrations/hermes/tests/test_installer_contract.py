from pathlib import Path
import unittest


class InstallerContractTests(unittest.TestCase):
    def test_installer_uses_lf_script_files_not_multiline_lc(self):
        script = Path("integrations/hermes/install_and_dry_run.ps1").read_text(encoding="utf-8")
        self.assertIn("Write-LfFile", script)
        self.assertIn("bootstrap_install.sh", script)
        self.assertIn("telegram_dry_run.sh", script)
        self.assertNotIn("/bin/sh -lc", script)

    def test_installer_requires_mounted_google_credentials(self):
        script = Path("integrations/hermes/install_and_dry_run.ps1").read_text(encoding="utf-8")
        self.assertIn("application_default_credentials.json", script)
        self.assertIn("GOOGLE_APPLICATION_CREDENTIALS", script)
        self.assertIn("WAITING_FOR_GOOGLE_CREDENTIALS", script)

    def test_google_setup_helper_never_prints_credential_contents(self):
        helper = Path("integrations/hermes/setup_google_credentials.ps1").read_text(encoding="utf-8")
        self.assertIn("CredentialJson", helper)
        self.assertIn("OAuthClientJson", helper)
        self.assertIn("The credential contents were not printed.", helper)
        self.assertNotIn("Write-Host $json", helper)


if __name__ == "__main__":
    unittest.main()
