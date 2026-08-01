# Windows read-only UAT

This procedure validates the delegation bridge locally without connecting it to ChatGPT and without enabling local write access.

## Product gate

Do not assume that this bridge is connected to the current ChatGPT account merely because local UAT passes.

- Full custom MCP write/modify support requires an eligible ChatGPT Business or Enterprise/Edu workspace.
- Pro custom MCP developer access is limited to read/fetch.
- Availability of a custom MCP connection on the current Plus account must be verified in the live ChatGPT web UI.
- Custom MCP apps are web-only at present.
- ChatGPT cannot connect directly to localhost; a supported Secure MCP Tunnel or reviewed remote HTTPS deployment is required.

Do not create another chat interface to bypass product-plan or connection limitations.

## Safety state

```text
CHATGPT_PRIMARY_BRAIN=true
BACKEND_MANAGER_AGENT=false
AUTOMATIC_BACKEND_ROUTING=false
SEPARATE_CHAT_UI=false
SPECIALIST_AI_MUTATION=false
CODEX_MODE=READ_ONLY_PROPOSAL
LOCAL_WRITE=false
AUTOSTART=false
CONNECTED_TO_CHATGPT=false
V2_RESUME=false
```

## One-command UAT

Run after the bridge code is present on the Windows machine:

```powershell
Set-Location "D:\HermesAgent\workspace\thu-ha-authentic\chatgpt-agent-delegation-bridge"
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force
.\scripts\windows\Invoke-BridgeReadOnlyUat.ps1
```

The entrypoint performs the complete bounded sequence:

```text
locked install
-> TypeScript check
-> unit/security/MCP tests
-> build
-> local bridge start
-> HTTP identity check
-> official MCP client initialize/list/call
-> architecture invariant verification
-> receipt write
-> safe stop
```

It creates `runtime/cwc-p3-read-only-uat-latest.json`. By default the bridge is stopped after PASS. Use `-KeepRunning` only when a later local inspection step is planned:

```powershell
.\scripts\windows\Invoke-BridgeReadOnlyUat.ps1 -KeepRunning
```

## Expected output

```text
CWC_P3_READ_ONLY_UAT=PASS
CHATGPT_PRIMARY_BRAIN=true
BACKEND_MANAGER_AGENT=false
SEPARATE_CHAT_UI=false
CODEX_MODE=READ_ONLY_PROPOSAL
LOCAL_WRITE=false
CONNECTED_TO_CHATGPT=false
```

## What the UAT proves

- exact locked dependencies install correctly;
- strict TypeScript check, tests and build pass on the Windows host;
- bridge HTTP identity is correct;
- official MCP client can initialize, list tools and call `delegation_health`;
- no direct Codex mutation tool is exposed;
- no replacement UI, database, queue or backend Manager is started;
- local write remains blocked;
- no autostart is registered;
- a machine-readable receipt is produced.

## What the UAT does not prove

- it does not connect the bridge to ChatGPT;
- it does not enable Secure MCP Tunnel or remote HTTPS;
- it does not enable local write roots, scripts or actions;
- it does not authorize production deployment;
- it does not prove current-plan eligibility in ChatGPT UI.

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
RECEIPT_WRITTEN=PASS
```

Actual ChatGPT integration remains a separate gate requiring supported account/workspace capability and a secure remote connection path.
