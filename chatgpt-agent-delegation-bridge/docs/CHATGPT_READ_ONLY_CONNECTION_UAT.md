# CWC-P5 ChatGPT read-only connection UAT

CWC-P5 proves that the real ChatGPT web product can discover and call the Secure MCP Tunnel-backed delegation bridge without exposing mutation tools.

## Product availability gate

Current OpenAI product behavior must be treated as an external gate:

- Full MCP, including write/modify actions, is available in beta for Business and Enterprise/Edu workspaces on ChatGPT web.
- Pro can connect custom MCP apps with read/fetch permissions in developer mode.
- Plus, Go and Free do not currently provide this custom MCP developer connection path.
- MCP apps are web-only and are not available on mobile.
- A local MCP server cannot be connected directly; CWC-P4 Secure MCP Tunnel must be ready.

Do not create a second chat interface, backend Manager, browser automation, or unofficial connection path to bypass these limits.

## Preconditions

```text
CWC_P3_WINDOWS_READ_ONLY_UAT=PASS
CWC_P4_SECURE_MCP_TUNNEL_READ_ONLY_UAT=PASS
TUNNEL_LEFT_RUNNING=true
LOCAL_WRITE=false
EXECUTE_LOCAL_OPERATIONS_PUBLISHED=false
CHATGPT_WEB=true
```

The tunnel must be associated with the target ChatGPT workspace and the operator must have the required tunnel and developer-mode permissions.

## Expected read-only tool set

The app must expose exactly the intended read-only capabilities for this stage:

```text
delegation_health
ask_codex
inspect_local_runtime
```

The following tools must not be visible:

```text
execute_codex
prepare_local_operations
execute_local_operations
```

The bridge publishes tools from actual server and workspace policy. A disabled capability is hidden rather than merely returning an error after ChatGPT has discovered it.

## ChatGPT web steps

### Business

Only a workspace admin or owner can enable developer mode and create the custom app. Use Workspace settings -> Apps -> Create and choose Tunnel as the connection type.

### Enterprise/Edu

An admin or owner grants developer-mode access through workspace permissions/RBAC. The authorized user enables developer mode in Settings -> Apps -> Advanced Settings, then creates or tests the custom app and chooses Tunnel.

### Pro

Enable developer mode in ChatGPT web and connect the tunnel-backed custom MCP app in read/fetch mode. P5 must remain read-only.

### Current Plus account

Record `BLOCKED` evidence. Do not claim that the bridge is connected and do not continue to write UAT.

## Read-only UAT prompts

Run in one ChatGPT web conversation with the custom app selected.

1. Health and architecture:

```text
Use delegation_health. Report only the structured architecture and published capabilities. Do not call another tool.
```

2. Codex proposal:

```text
Ask Codex to inspect the delegation bridge architecture and return a read-only implementation review. Do not apply any change.
```

3. Local inspection:

```text
Inspect the allowlisted local runtime for system information only. Do not modify files, processes, services, Scheduled Tasks, Docker, or Git state.
```

4. Negative write discovery:

Confirm in the app tool list that `execute_local_operations` is absent. Do not attempt to manufacture a raw MCP call.

## Required delegation_health invariants

```text
architecture.chatgptPrimaryBrain=true
architecture.backendManagerAgent=false
architecture.automaticBackendRouting=false
architecture.separateChatUi=false
architecture.v2RuntimeDependency=false
architecture.specialistAiMayMutateUserWorkspace=false
targets.localExecutor.readAvailable=true
targets.localExecutor.writeAvailable=false
targets.localExecutor.publishedMode=READ_ONLY
```

## Evidence document

After the real ChatGPT call, create an evidence JSON matching:

```text
test/fixtures/cwc-p5-pass.json
```

Store only the SHA-256 of the tunnel ID. Never store the raw tunnel ID, runtime API key, bearer token, OAuth token, password or private key.

Validate it with:

```powershell
node .\scripts\validate-cwc-p5-evidence.mjs <evidence.json> --require-pass
```

The validator rejects:

- plans that are not eligible for read-only custom MCP;
- non-web client surfaces;
- missing tunnel/app/developer-mode proof;
- missing required read-only tools;
- any published mutation tool;
- broken ChatGPT-primary invariants;
- local write availability;
- raw tunnel IDs or credential-like fields.

## Current blocked receipt

Until the account/workspace supports the custom MCP connection and a real tunnel is ready, use the blocked fixture as the status model:

```text
test/fixtures/cwc-p5-blocked-plus.json
```

A valid BLOCKED receipt is not a PASS. `--require-pass` deliberately returns a nonzero exit code.

## P5 PASS meaning

P5 PASS proves:

- ChatGPT web discovered the tunnel-backed app;
- the real published tool snapshot is read-only;
- ChatGPT called the live bridge through Secure MCP Tunnel;
- the bridge returned the expected ChatGPT-primary architecture;
- Codex and local inspection can be invoked without exposing write actions.

P5 PASS does not authorize local write, production deployment, autostart, publishing to other users, paid-provider fallback or broader workspace access.

## P6 handoff

CWC-P6 may start only after P5 PASS on a plan/workspace that supports write/modify custom MCP actions. The read-only app snapshot must not be silently converted into a write app. Create a separate controlled write configuration and review its changed tool set before UAT.

## Current status

```text
CWC_P5_TECHNICAL_PACKAGE=READY
CURRENT_ACCOUNT_PLAN=PLUS
CURRENT_RUNTIME_STATUS=BLOCKED_PLAN_AND_TUNNEL_INPUTS
CONNECTED_TO_CHATGPT=false
LOCAL_WRITE=false
NEXT_ACTION=OBTAIN_ELIGIBLE_WORKSPACE_AND_COMPLETE_P3_P4_RUNTIME_GATES
```
