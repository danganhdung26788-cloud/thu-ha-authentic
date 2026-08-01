import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const ROOT = new URL('../', import.meta.url);

async function source(path: string): Promise<string> {
  return readFile(new URL(path, ROOT), 'utf8');
}

test('secure tunnel UAT remains outbound-only, read-only, and secret-safe', async () => {
  const script = await source('scripts/windows/Invoke-SecureMcpTunnelReadOnlyUat.ps1');
  assert.match(script, /sample_mcp_remote_no_auth/);
  assert.match(script, /http:\/\/127\.0\.0\.1:3210\/mcp/);
  assert.match(script, /\/healthz/);
  assert.match(script, /\/readyz/);
  assert.match(script, /outboundOnly\s*=\s*\$true/);
  assert.match(script, /inboundFirewallPortRequired\s*=\s*\$false/);
  assert.match(script, /controlPlaneApiKeyPersisted\s*=\s*\$false/);
  assert.match(script, /localWrite\s*=\s*\$false/);
  assert.match(script, /connectedToChatgpt\s*=\s*\$false/);
  assert.doesNotMatch(script, /Set-Content[\s\S]*CONTROL_PLANE_API_KEY/iu);
  assert.doesNotMatch(script, /New-NetFirewallRule|netsh\s+advfirewall/iu);
  assert.doesNotMatch(script, /Register-ScheduledTask|schtasks(?:\.exe)?\s+\/Create/iu);
});

test('secure tunnel UAT recreates and verifies the isolated profile for the requested tunnel', async () => {
  const script = await source('scripts/windows/Invoke-SecureMcpTunnelReadOnlyUat.ps1');
  assert.match(script, /Remove-Item\s+-LiteralPath\s+\$profilePath/);
  assert.match(script, /Generated tunnel profile is not bound to the requested tunnel ID/);
  assert.match(script, /Generated tunnel profile is not bound to the local MCP bridge URL/);
  assert.match(script, /profileRecreated\s*=\s*\$profileRecreated/);
  assert.match(script, /tunnelIdSha256\s*=\s*\$tunnelIdHash/);
  assert.doesNotMatch(script, /tunnelId\s*=\s*\$TunnelId/);
});

test('secure tunnel stop command verifies process identity before termination', async () => {
  const script = await source('scripts/windows/Stop-SecureMcpTunnel.ps1');
  assert.match(script, /ExecutablePath/);
  assert.match(script, /CommandLine/);
  assert.match(script, /does not match the approved tunnel-client run process/);
  assert.match(script, /DATA_DELETED=false/);
  assert.match(script, /PROFILE_DELETED=false/);
  assert.match(script, /CREDENTIAL_DELETED=false/);
});

test('secure tunnel runbook preserves the ChatGPT-primary boundary', async () => {
  const runbook = await source('docs/SECURE_MCP_TUNNEL_READ_ONLY_UAT.md');
  assert.match(runbook, /CHATGPT_PRIMARY_BRAIN=true/);
  assert.match(runbook, /BACKEND_MANAGER_AGENT=false/);
  assert.match(runbook, /SEPARATE_CHAT_UI=false/);
  assert.match(runbook, /LOCAL_WRITE=false/);
  assert.match(runbook, /CONNECTED_TO_CHATGPT=false/);
  assert.match(runbook, /does not prove that the tunnel is visible in ChatGPT/iu);
});
