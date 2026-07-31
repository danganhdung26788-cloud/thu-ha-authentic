# Security Policy — Agent Workflow Platform V2

## Supported status

V2 is under active construction on `v2/agents-sdk-platform`. It is not authorized for production credentials or production writes until the release gate is explicitly approved.

## Secret handling

Never commit:

- `.env` files;
- API keys, tokens or passwords;
- OAuth refresh/access tokens;
- private keys or credential JSON;
- webhook, session or signing secrets;
- raw production database exports.

Only secret names and external secret-reference locations may appear in documentation.

## Mandatory execution controls

- Every run has owner, workspace, read scope and write scope.
- Missing scope is a denial, not a fallback.
- Shell/file actions use a sandbox or bounded executor adapter.
- Production, credentials, permissions, history rewrite, irreversible deletion, deep OS changes and significant cost require approval.
- Every mutation requires target-system read-back.
- V1 sources remain read-only during shadow mode.

## Logging and tracing

- Sensitive trace content is disabled by default.
- Logs must be structured and redact secrets and personal data.
- SDK tracing is diagnostic only; application audit is authoritative.
- Serialized run state must not carry credentials.

## Dependency policy

- Runtime and critical dependencies are pinned through a committed lockfile.
- Dependency changes use dedicated PRs and CI.
- `npm audit fix --force` is forbidden.
- High or critical production dependency vulnerabilities block release unless a documented risk acceptance exists.

## Reporting

Record security findings in a private channel or private issue. Do not publish credentials, exploit details against live systems or sensitive infrastructure identifiers in the public repository.
