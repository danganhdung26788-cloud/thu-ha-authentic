# ADR-001: Greenfield parallel replacement using OpenAI Agents SDK

- Status: Accepted
- Date: 2026-07-31
- Owner: danganhdung

## Context

V1 has proven operational capabilities: owner-scoped routing, queue processing, approvals, audit, heartbeat, retry/recovery and executor separation. However, much of the AI routing remains encoded in documents and manual operator steps. The owner has approved broad autonomous execution for non-critical experimental work and wants a production-grade replacement rather than an incremental proof of concept.

## Decision

Build V2 as a separate system and migrate by adapters. V1 remains unchanged as the rollback source until V2 cutover and soak are complete.

V2 uses OpenAI Agents SDK for agent orchestration, structured outputs, sessions, resumable state, tool approvals and tracing. Operational governance remains application-owned: owner/workspace isolation, durable queue, policy, official audit, evidence, retry and rollback are not delegated to model behavior.

## Consequences

### Positive

- Clean contracts and data model.
- Routing rules become executable and testable.
- Manual PowerShell relay can be replaced by controlled executor tools.
- V1 can continue serving while V2 is built and compared.
- Cutover and rollback are explicit.

### Negative

- Temporary duplication of infrastructure and maintenance.
- Adapters are required for Codex, Hermes, Claude and legacy sources.
- A migration period is required before V1 deletion.
- Agents SDK version and serialized run state must be versioned together.

## Non-negotiable controls

- Node.js 22+ runtime.
- Exact Agents SDK version pin and committed lockfile before release.
- Secrets external to Git.
- Docker sandbox for shell/file execution on Windows.
- Tool and path allowlists.
- Owner/workspace/scope checks at the tool boundary.
- Deep-intervention policy and resumable approval state.
- Official audit stored independently from SDK tracing.
- No V1 write during shadow mode.
- Decommission only after seven-day soak and owner sign-off.

## Cutover strategy

```text
FOUNDATION
→ PLATFORM BASELINE
→ EXECUTOR ADAPTERS
→ SHADOW MODE
→ DUAL RUN
→ CUTOVER
→ 7-DAY SOAK
→ ROLLBACK WINDOW
→ V1 DECOMMISSION
```
