# Windows read-only UAT

This procedure validates the delegation bridge locally without connecting it to ChatGPT and without enabling local write access.

## Product gate

The current ChatGPT Plus account cannot attach this custom MCP bridge. Completing this UAT does not mean the bridge is connected to the current ChatGPT project.

Do not create another user interface to bypass the plan limitation.

## Safety state

```text
CHATGPT_PRIMARY_BRAIN=true
BACKEND_MANAGER_AGENT=false
AUTOMATIC_BACKEND_ROUTING=false
SPECIALIST_AI_MUTATION=false
CODEX_MODE=READ_ONLY_PROPOSAL
LOCAL_WRITE=false
AUTOSTART=false
CONNECTED_TO_CHATGPT=false
V2_RESUME=false
```

## Install and build

Run only after PR #57 is reviewed and merged:

```powershell
Set-Location "D:\HermesAgent\workspace\thu-ha-authentic\chatgpt-agent-delegation-bridge"
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force
.\scripts\windows\Install-BridgeReadOnly.ps1
```

The script creates local `.env` and `config/workspaces.json` only when missing. It uses locked dependencies, runs TypeScript checks, tests, and build. It does not register a Scheduled Task, enable local write access, or expose a specialist-AI mutation tool.

## Start locally

```powershell
.\scripts\windows\Start-Bridge.ps1
```

Expected:

```text
BRIDGE_READY=true
CONNECTED_TO_CHATGPT=false
```

## MCP protocol test

```powershell
.\scripts\windows\Test-Bridge.ps1
```

Expected:

```text
BRIDGE_HTTP_HEALTH=PASS
BRIDGE_SERVICE_IDENTITY=PASS
BRIDGE_MCP_PROTOCOL=PASS
CHATGPT_PRIMARY_BRAIN=true
BACKEND_MANAGER_AGENT=false
V2_RUNTIME_DEPENDENCY=false
CONNECTED_TO_CHATGPT=false
```

The test uses the official MCP client to initialize the connection, list tools, call `delegation_health`, and verify that no direct Codex mutation tool is exposed.

## Stop

```powershell
.\scripts\windows\Stop-Bridge.ps1
```

Expected:

```text
BRIDGE_STOPPED=true
DATA_DELETED=false
```

## Acceptance

```text
LOCKED_INSTALL=PASS
TYPESCRIPT=PASS
TESTS=PASS
BUILD=PASS
HTTP_HEALTH=PASS
MCP_PROTOCOL=PASS
NO_NEW_UI=PASS
NO_DATABASE=PASS
NO_QUEUE=PASS
NO_BACKEND_MANAGER=PASS
SPECIALIST_AI_MUTATION=FALSE
CODEX_READ_ONLY_PROPOSAL=PASS
LOCAL_WRITE_DEFAULT=BLOCKED
NO_AUTOSTART=PASS
```

Actual ChatGPT integration remains blocked until a supported plan and Secure MCP Tunnel or reviewed HTTPS/OAuth deployment are available.
