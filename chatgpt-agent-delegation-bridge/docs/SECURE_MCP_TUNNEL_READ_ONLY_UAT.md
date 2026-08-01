# CWC-P4 Secure MCP Tunnel read-only UAT

This runbook prepares and validates an outbound-only OpenAI Secure MCP Tunnel from the registered Windows host to the local ChatGPT-primary delegation bridge.

## Architecture boundary

```text
ChatGPT or another supported OpenAI product
  -> OpenAI-hosted tunnel endpoint
  <- outbound HTTPS poll/response path
Windows tunnel-client
  -> http://127.0.0.1:3210/mcp
ChatGPT delegation bridge
```

The private MCP bridge remains loopback-only. The tunnel does not require an inbound firewall port and does not make the local MCP server publicly reachable.

## Prerequisites outside this repository

1. A tunnel must exist in OpenAI Platform tunnel settings.
2. The operator needs Tunnels Read + Use to run `tunnel-client`.
3. The tunnel creator or editor needs Tunnels Read + Manage.
4. A runtime API key must be created for `tunnel-client`.
5. The tunnel must be associated with the intended Platform organization and, for ChatGPT discovery, the intended ChatGPT workspace.
6. ChatGPT developer-mode permission is separate from Platform tunnel permission.
7. Use the current supported `tunnel-client` binary from Platform tunnel settings or the official latest public release. Do not hard-code an old release download URL.

Do not store the runtime API key in Git, Google Drive, `.env`, a profile file, a receipt, or a chat message.

## Read-only safety state

```text
CHATGPT_PRIMARY_BRAIN=true
BACKEND_MANAGER_AGENT=false
SEPARATE_CHAT_UI=false
LOCAL_MCP_BIND=127.0.0.1
LOCAL_MCP_URL=http://127.0.0.1:3210/mcp
TUNNEL_DIRECTION=OUTBOUND_ONLY
INBOUND_FIREWALL_PORT_REQUIRED=false
CODEX_MODE=READ_ONLY_PROPOSAL
LOCAL_WRITE=false
CONNECTED_TO_CHATGPT=false
```

## One-command P4 UAT

In the current PowerShell process, provide the runtime key without writing it to disk:

```powershell
$env:CONTROL_PLANE_API_KEY = '<runtime-key-from-platform>'
```

Then run:

```powershell
Set-Location "D:\HermesAgent\workspace\thu-ha-authentic\chatgpt-agent-delegation-bridge"
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force
.\scripts\windows\Invoke-SecureMcpTunnelReadOnlyUat.ps1 `
  -TunnelId 'tunnel_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' `
  -TunnelClientPath 'C:\approved-tools\tunnel-client.exe'
```

The command performs:

```text
CWC-P3 local read-only UAT with bridge left running
-> resolve an approved tunnel-client binary
-> create an isolated named profile when missing
-> bind the main MCP channel to http://127.0.0.1:3210/mcp
-> tunnel-client doctor --explain
-> tunnel-client run with loopback-only health surfaces
-> /healthz and /readyz verification
-> redacted receipt
-> safe stop of tunnel-client and local bridge
```

The profile uses the official `sample_mcp_remote_no_auth` starter because the MCP server is a local HTTP endpoint inside the same Windows trust boundary. The bridge remains unauthenticated only on loopback; the tunnel control plane uses the separate runtime API key.

## Keep the tunnel running for CWC-P5

Use `-KeepRunning` only when the next step is immediate ChatGPT app discovery:

```powershell
.\scripts\windows\Invoke-SecureMcpTunnelReadOnlyUat.ps1 `
  -TunnelId 'tunnel_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' `
  -TunnelClientPath 'C:\approved-tools\tunnel-client.exe' `
  -KeepRunning
```

The tunnel client must remain healthy for connector discovery and each MCP call. Its loopback admin UI URL is recorded in the receipt.

To stop the verified tunnel process and local bridge:

```powershell
.\scripts\windows\Stop-SecureMcpTunnel.ps1 `
  -TunnelClientPath 'C:\approved-tools\tunnel-client.exe' `
  -StopBridge
```

The stop command validates the PID, executable path, and `run` command before terminating anything.

## Receipt

The UAT writes:

```text
runtime/secure-mcp-tunnel/cwc-p4-secure-mcp-tunnel-read-only-uat-latest.json
```

The receipt contains only:

- status and timestamp;
- SHA-256 of the tunnel ID, not the tunnel ID itself;
- profile name and tunnel-client version;
- local loopback MCP URL;
- outbound-only and readiness flags;
- confirmation that the runtime API key was not persisted;
- local-write and ChatGPT-connection state;
- redacted error text when applicable.

## Expected PASS state

```text
CWC_P4_SECURE_MCP_TUNNEL_READ_ONLY_UAT=PASS
OUTBOUND_ONLY=true
INBOUND_FIREWALL_PORT_REQUIRED=false
CONTROL_PLANE_API_KEY_PERSISTED=false
LOCAL_WRITE=false
CONNECTED_TO_CHATGPT=false
```

A P4 PASS proves that `tunnel-client` reached the OpenAI tunnel control plane, reached the local MCP bridge, and became ready. It does not prove that the tunnel is visible in ChatGPT or that the current ChatGPT workspace is allowed to create a developer-mode app.

## CWC-P5 handoff

Only after P4 PASS:

1. Keep `tunnel-client run` healthy.
2. In ChatGPT web, open the developer-mode app creation surface.
3. Choose Tunnel as the connection type.
4. Select the associated tunnel or enter the valid tunnel ID.
5. Confirm that the app discovers `delegation_health` and the other tools allowed by the current read-only server configuration.
6. Call `delegation_health` and verify:
   - `chatgptPrimaryBrain=true`;
   - `backendManagerAgent=false`;
   - `separateChatUi=false`;
   - `specialistAiMayMutateUserWorkspace=false`;
   - local write remains disabled.

Do not activate write roots or write actions during CWC-P5.

## Failure interpretation

- `tunnel-client doctor` fails: fix tunnel ID, runtime key, profile, organization/workspace association, or local MCP reachability.
- `/healthz` passes but `/readyz` fails: the process is alive but control-plane polling or downstream MCP readiness is not complete.
- Tunnel is ready but absent in ChatGPT: verify ChatGPT workspace association, Tunnels Read + Use, and ChatGPT developer-mode permission.
- Connector discovery fails: keep `tunnel-client run` active and rerun `doctor --explain`.

## Status after technical package merge

```text
CWC_P4_TECHNICAL_PACKAGE=READY
TUNNEL_ID=REQUIRED_EXTERNAL_INPUT
RUNTIME_API_KEY=REQUIRED_EXTERNAL_SECRET
PLATFORM_PERMISSION=REQUIRED_EXTERNAL_PERMISSION
CHATGPT_DEVELOPER_MODE=SEPARATE_P5_GATE
RUNTIME_UAT=NOT_RUN
```
