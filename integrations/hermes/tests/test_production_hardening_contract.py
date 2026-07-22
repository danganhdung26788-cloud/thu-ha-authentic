from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]


class ProductionHardeningContractTests(unittest.TestCase):
    def read(self, name: str) -> str:
        return (ROOT / name).read_text(encoding="utf-8")

    def test_fanpage_background_runner_is_locked_and_uses_natural_pipeline(self):
        text = self.read("run_fanpage_draft_background.ps1")
        self.assertIn("Global\\HermesThuHaFanpageDraftProcessor", text)
        self.assertIn("THA_NATURAL_REPLY_DRY_RUN=false", text)
        self.assertIn("natural_reply_processor", text)
        self.assertIn("meta_outbound_sender", text)
        self.assertNotIn("graph.facebook.com", text)

    def test_meta_sender_is_explicitly_gated_and_deduplicated_by_status(self):
        text = self.read("meta_outbound_sender.py")
        self.assertIn('REPLY_MODE != "NATURAL_AUTO_REPLY"', text)
        self.assertIn("not AUTO_SEND", text)
        self.assertIn('STATUS", "")).strip().upper() != "DRAFT_READY"', text)
        self.assertIn('repo.set_status(row_number, "SENDING")', text)
        self.assertIn("THA_META_AUTO_SEND_SINCE", text)

    def test_fanpage_scheduled_task_ignores_overlap(self):
        text = self.read("install_fanpage_draft_scheduled_task.ps1")
        self.assertIn("Hermes-ThuHa-Fanpage-Draft-Processor", text)
        self.assertIn("MultipleInstances IgnoreNew", text)
        self.assertIn("LogonType Interactive", text)
        self.assertIn("AUTO_SEND=FALSE", text)

    def test_named_tunnel_uses_token_file_not_cli_token(self):
        text = self.read("install_meta_named_tunnel.ps1")
        self.assertIn("--token-file /run/secrets/tunnel-token", text)
        self.assertIn(":/run/secrets/tunnel-token:ro", text)
        self.assertIn("TOKEN_PRINTED=FALSE", text)
        self.assertNotIn("--token $", text)

    def test_named_tunnel_cutover_requires_public_health(self):
        text = self.read("cutover_meta_named_tunnel.ps1")
        self.assertIn("/health", text)
        self.assertIn("DRAFT_ONLY_INGEST", text)
        self.assertIn("docker rm -f $QuickContainerName", text)
        self.assertIn("webhook/meta-messenger", text)

    def test_rollbacks_exist(self):
        self.assertIn(
            "Unregister-ScheduledTask",
            self.read("uninstall_fanpage_draft_scheduled_task.ps1"),
        )
        self.assertIn(
            "TOKEN_FILE_PRESERVED=TRUE",
            self.read("uninstall_meta_named_tunnel.ps1"),
        )


if __name__ == "__main__":
    unittest.main()
