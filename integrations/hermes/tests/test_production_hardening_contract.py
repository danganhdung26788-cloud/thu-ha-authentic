from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]


class ProductionHardeningContractTests(unittest.TestCase):
    def read(self, name: str) -> str:
        return (ROOT / name).read_text(encoding="utf-8")

    def test_fanpage_background_runner_is_locked_and_uses_ai_first_pipeline(self):
        text = self.read("run_fanpage_draft_background.ps1")
        self.assertIn("Global\HermesThuHaFanpageDraftProcessor", text)
        self.assertIn("THA_AI_FIRST_DRY_RUN=false", text)
        self.assertIn("ai_first_reply_processor", text)
        self.assertIn("meta_outbound_sender", text)
        self.assertNotIn("python -m integrations.hermes.safe_context_processor", text)
        self.assertNotIn("python -m integrations.hermes.natural_reply_processor", text)
        self.assertNotIn("graph.facebook.com", text)

    def test_meta_bridge_runs_realtime_pipeline_with_scheduled_fallback(self):
        text = self.read("meta_messenger_bridge.py")
        self.assertIn("def run_realtime_pipeline", text)
        self.assertIn("PIPELINE_LOCK", text)
        self.assertIn("ai_first_reply_processor", text)
        self.assertIn("processor.process_new_messages", text)
        self.assertIn("sender.send_ready_messages", text)
        self.assertIn("Scheduled Task will retry queued messages", text)
        self.assertIn("REALTIME_NATURAL_AUTO_REPLY", text)
        self.assertIn('"reasoning_mode": "HERMES_AI_FIRST"', text)
        self.assertIn('"factual_lookup": "ON_DEMAND"', text)
        self.assertNotIn("safe_context_processor", text)
        self.assertNotIn("META_PAGE_ACCESS_TOKEN=", text)

    def test_ai_first_processor_reasons_before_catalog_lookup(self):
        text = self.read("ai_first_reply_processor.py")
        self.assertIn("def build_plan_prompt", text)
        self.assertIn("def call_plan", text)
        self.assertIn("def resolve_product_refs", text)
        self.assertIn("def retrieve_recommendation_candidates", text)
        self.assertIn("def build_lookup_reply_prompt", text)
        self.assertIn("Suy luan theo mach hoi thoai truoc", text)
        self.assertIn("KHONG co nghia la tim mot san pham moi", text)
        self.assertIn("Generic words and product attributes never select a catalog row", text)
        self.assertIn('repo.update_status(row_number, "PROCESSING")', text)
        self.assertNotIn("quick_product_reply(", text)

    def test_legacy_natural_processor_remains_available_but_is_not_runtime_entrypoint(self):
        text = self.read("natural_reply_processor.py")
        self.assertIn('"PRODUCT_KEY"', text)
        self.assertIn("call_hermes", text)
        runner = self.read("run_fanpage_draft_background.ps1")
        bridge = self.read("meta_messenger_bridge.py")
        self.assertNotIn("natural_reply_processor\n", runner)
        self.assertNotIn('"integrations.hermes.natural_reply_processor"', bridge)

    def test_realtime_installer_restarts_bridge_and_keeps_fallback(self):
        text = self.read("install_realtime_fanpage_reply.ps1")
        self.assertIn("install_natural_cosmetics_agent.ps1", text)
        self.assertIn("docker restart $MetaContainerName", text)
        self.assertIn("REALTIME_NATURAL_AUTO_REPLY", text)
        self.assertIn("Hermes-ThuHa-Fanpage-Draft-Processor", text)
        self.assertIn("SCHEDULED_FALLBACK", text)
        self.assertIn("HERMES_AI_FIRST", text)
        self.assertIn("ON_DEMAND", text)
        self.assertNotIn("META_PAGE_ACCESS_TOKEN", text)

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

    def test_windows_powershell_native_stderr_is_captured_without_false_failure(self):
        for name in (
            "install_natural_cosmetics_agent.ps1",
            "run_fanpage_draft_background.ps1",
            "configure_natural_meta_reply.ps1",
        ):
            text = self.read(name)
            self.assertIn("function Invoke-NativeCapture", text)
            self.assertIn("$ErrorActionPreference = 'Continue'", text)
            self.assertIn("ExitCode = $exitCode", text)
        configure = self.read("configure_natural_meta_reply.ps1")
        self.assertIn("[switch]$UseExistingToken", configure)
        self.assertIn("USING_EXISTING_", configure)

    def test_meta_activation_can_reuse_container_token_without_printing_it(self):
        text = self.read("configure_natural_meta_reply.ps1")
        self.assertIn("RUNNING_CONTAINER_ENV", text)
        self.assertIn("RUNNING_CONTAINER_DATA_ENV", text)
        self.assertIn("META_PAGE_ACCESS_TOKEN_NOT_FOUND_IN_LOCAL_ENV_CONTAINER_ENV_OR_DATA_ENV", text)
        self.assertIn(". /opt/data/.env", text)
        self.assertIn("TOKEN_SOURCE=$tokenSource", text)
        self.assertNotIn("Write-Host $plainToken", text)

    def test_meta_activation_parses_exported_or_quoted_env_values(self):
        text = self.read("configure_natural_meta_reply.ps1")
        self.assertIn("(?:export\\s+)?", text)
        self.assertIn("Normalize-EnvLine", text)
        self.assertIn("$candidate.Substring(1, $candidate.Length - 2)", text)

    def test_meta_activation_syncs_current_sender_before_verification(self):
        text = self.read("configure_natural_meta_reply.ps1")
        self.assertIn("$sourceSender = Join-Path $PSScriptRoot 'meta_outbound_sender.py'", text)
        self.assertIn("Copy-Item -Path $sourceSender -Destination $targetSender -Force", text)
        self.assertIn("META_OUTBOUND_SENDER_SYNCED=TRUE", text)
        sender = self.read("meta_outbound_sender.py")
        self.assertIn('PAGE_ID = os.getenv("THA_META_PAGE_ID", "108621404211232").strip()', sender)

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
