# Integration Runbook — Gemini, NotebookLM and Canva

## 1. Purpose

Use the user's paid Google AI and Canva capabilities without weakening Workflow V2 governance.

```text
Gemini    = conditional AI executor
NotebookLM= source-grounded research workspace
Canva     = design and export executor after content approval
```

OpenAI Agents SDK remains the central orchestrator. PostgreSQL audit remains authoritative.

## 2. Gemini

### Runtime

- SDK: `@google/genai` pinned to `2.13.0` in `package-lock.json`.
- API version default: `v1`.
- Required external secrets:
  - `GOOGLE_API_KEY`
  - `GEMINI_MODEL`
- Registry status remains `TESTING` until a bounded live contract test passes.

### Allowed tools

- `gemini.analyze`
- `gemini.multimodal`
- `gemini.cross-check`

Gemini receives owner, workspace, read scope, objective and instructions. It does not receive a blanket Drive scan or write permission.

### Activation gate

1. Create an API key outside Git.
2. Set a Google API budget and alert.
3. Configure an approved model ID.
4. Run one read-only contract task in Sandbox.
5. Verify output, cost, audit and evidence.
6. Promote registry status from `TESTING` to `ACTIVE` through the Agent Registry API.

A Google AI Pro subscription is a user-product entitlement; it is not used as an API credential and does not by itself authorize API billing.

## 3. NotebookLM

NotebookLM is intentionally implemented as `SOURCE_PACKAGE_ONLY`.

V2 automatically produces:

- notebook title;
- objective and research prompt;
- ordered source manifest from registered `READ_SCOPE`;
- required return fields;
- privacy and source restrictions.

A human or supported Google UI workflow creates the notebook and returns:

- notebook URL;
- grounded answer;
- citations;
- generated artifacts;
- reviewer identity.

The reviewed result is registered back using `notebooklm.register-result`.

### Rules

- Private by default.
- No source outside registered scope.
- No public share without Approval Gate.
- NotebookLM output is not official data until reviewed and registered.
- NotebookLM cannot execute shell, write production data or call other agents.

## 4. Canva

Canva is connected through a separately deployed OAuth/Connect API or MCP adapter URL.

### Allowed tools

- `canva.asset.upload`
- `canva.design.create`
- `canva.template.autofill`
- `canva.design.export`
- `canva.design.publish`

The first four are bounded draft/output operations. `canva.design.publish` is always `DEEP_INTERVENTION` and requires approval.

### Activation gate

1. Enable MFA on the Canva account.
2. Create a supported Canva integration or adapter.
3. Keep OAuth credentials outside Git.
4. Configure `CANVA_ADAPTER_URL` and adapter token.
5. Contract-test asset upload, design draft and export in Sandbox.
6. Verify that approved facts, figures and wording are unchanged.
7. Promote the Canva registry entry from `TESTING` to `ACTIVE`.

Canva Pro does not provide a private Enterprise-only Connect API integration. The adapter must use a supported public integration, OAuth workflow, remote MCP or another Canva-supported connection mode.

## 5. Routing examples

```text
Analyze a long Google-source document set
-> GEMINI / gemini.analyze

Create a closed-source NQ57 research notebook
-> NOTEBOOKLM / notebooklm.prepare-source-package

Cross-check an OpenAI draft using another provider
-> GEMINI / gemini.cross-check

Turn approved report content into an infographic draft
-> CANVA / canva.design.create

Autofill an approved brand template
-> CANVA / canva.template.autofill

Publish or share outside the system
-> CANVA / canva.design.publish
-> WAITING_APPROVAL
```

## 6. Verified code gate

The multi-provider integration passed the complete repository gate on GitHub Actions run `30655132020`:

- locked dependency install;
- TypeScript strict check;
- migrations 001–009;
- unit and integration tests;
- application build;
- Docker Compose validation;
- runtime image build;
- production dependency audit.

This proves the code contract and container image build. It does not prove live Google/Canva credentials or external adapter execution.

## 7. Production acceptance

No integration is declared live only because its code exists.

Required evidence:

- registry status;
- adapter health;
- bounded task execution;
- audit row;
- cost record where applicable;
- read-back of outputs;
- no owner/workspace crossing;
- no secret in logs or evidence;
- rollback or token revocation procedure.
