from pathlib import Path
import unittest


ROUTES_ROOT = Path(__file__).parents[1]
INSTALLER_PATH = ROUTES_ROOT / "windows" / "install_taskflow_routes_v2.ps1"


class InstallerContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.source = INSTALLER_PATH.read_text(encoding="utf-8")

    def test_default_python_is_repository_virtual_environment(self):
        self.assertIn(
            '$PythonExecutable = Join-Path $routesRoot ".venv\\Scripts\\python.exe"',
            self.source,
        )
        self.assertNotIn('[string]$PythonExecutable = "python"', self.source)

    def test_prerequisites_are_checked_before_task_registration(self):
        checks = (
            'Test-Path -LiteralPath $runner -PathType Leaf',
            'Test-Path -LiteralPath $PythonExecutable -PathType Leaf',
            '[string]::IsNullOrWhiteSpace($credentialsPath)',
            'Test-Path -LiteralPath $credentialsPath -PathType Leaf',
        )
        registration_index = self.source.index("Register-ScheduledTask")
        for check in checks:
            with self.subTest(check=check):
                self.assertIn(check, self.source)
                self.assertLess(self.source.index(check), registration_index)
        self.assertGreaterEqual(self.source[:registration_index].count("throw "), 4)

    def test_python_override_is_validated_and_forwarded(self):
        validation_index = self.source.index(
            "Test-Path -LiteralPath $PythonExecutable -PathType Leaf"
        )
        forwarding_index = self.source.index(
            '-PythonExecutable `"$PythonExecutable`"'
        )
        self.assertLess(validation_index, forwarding_index)

    def test_task_names_schedules_and_safety_settings_are_preserved(self):
        for expected in (
            'Name = "Hermes-Route-Ops-Health"; Route = "RT-OPS-HEALTH-01"; At = "07:30"',
            'Name = "Hermes-Route-Due-Check"; Route = "RT-DUE-CHECK-01"; At = "08:00"',
            'Name = "Hermes-Route-File-Sync"; Route = "RT-FILE-SYNC-01"; At = "09:00"',
            "-WindowStyle Hidden",
            "-MultipleInstances IgnoreNew",
            "-Force",
        ):
            with self.subTest(expected=expected):
                self.assertIn(expected, self.source)

    def test_installer_does_not_embed_credentials(self):
        self.assertIn("$env:GOOGLE_APPLICATION_CREDENTIALS", self.source)
        self.assertNotIn("service_account", self.source)
        self.assertNotIn("private_key", self.source)
        self.assertNotIn("client_email", self.source)


if __name__ == "__main__":
    unittest.main()
