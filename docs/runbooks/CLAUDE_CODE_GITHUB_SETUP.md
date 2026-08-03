# Runbook — Activate ChatGPT → Claude Code through GitHub

- **Route:** `CHATGPT_TO_CLAUDE_CODE_V1`
- **Repository:** `danganhdung26788-cloud/thu-ha-authentic`
- **Owner:** `danganhdung`
- **Approval:** owner required
- **Secret values in this document:** none

## 1. What is already implemented in code

After the implementation PR is merged, the repository contains:

- `.github/workflows/claude-code.yml`
- `.github/ISSUE_TEMPLATE/claude-code-task.yml`
- `CLAUDE.md`
- `docs/ADR-004-chatgpt-to-claude-code-github.md`

This is not sufficient to activate Claude. The Claude GitHub App and authentication secret are external prerequisites.

## 2. Owner setup

### Install the Claude GitHub App

Install the official Claude GitHub App only for:

```text
danganhdung26788-cloud/thu-ha-authentic
```

Do not grant access to all repositories unless the owner intentionally approves that larger scope.

### Create the Claude Code OAuth token

On the owner's trusted machine:

```powershell
claude setup-token
```

Copy the generated value directly into GitHub Actions Secrets. Do not paste it into ChatGPT, Claude chat, an Issue, Pull Request, file, terminal transcript, screenshot, or documentation.

### Store the GitHub Actions secret

Repository:

```text
Settings
→ Secrets and variables
→ Actions
→ New repository secret
```

Create:

```text
Name: CLAUDE_CODE_OAUTH_TOKEN
Value: <owner-generated token>
```

Alternative authentication methods require a separate reviewed change. Do not commit an Anthropic API key into the workflow.

## 3. First sandbox test

Create a low-risk Issue using the `Claude Code task` template.

Example final comment:

```text
@claude Implement this Issue exactly within scope. Do not merge or deploy. Run the required checks and report branch, commit, changed files, tests, risks, and the PR creation link.
```

Expected:

1. Workflow `Claude Code` starts.
2. Only the owner account can trigger it.
3. Claude posts progress in the Issue.
4. Claude creates a branch prefixed `claude/`.
5. Claude commits the bounded code change.
6. Claude reports test evidence.
7. Claude returns a PR creation link when it does not open a PR automatically.
8. ChatGPT or the owner creates/reviews the Pull Request.
9. Existing CI runs.
10. No merge or deploy occurs automatically.

## 4. ChatGPT acceptance checklist

ChatGPT checks:

- Issue scope and acceptance criteria;
- branch starts with `claude/`;
- changed files are within scope;
- no secret or credential appears;
- no unrelated or destructive changes;
- tests/check/build evidence is present;
- GitHub CI state;
- Claude completion state;
- risks and warnings;
- merge/deploy remain unexecuted.

ChatGPT concludes one of:

```text
ACCEPT_READY_FOR_OWNER_MERGE
REQUEST_CHANGES
BLOCKED_NEEDS_OWNER_DECISION
REJECT_OUT_OF_SCOPE
```

## 5. Failure handling

### Workflow does not start

Check:

- implementation PR has been merged;
- the event contains literal `@claude`;
- `github.actor` is exactly `danganhdung26788-cloud`;
- Claude GitHub App is installed on the repository;
- `CLAUDE_CODE_OAUTH_TOKEN` exists;
- GitHub Actions is enabled.

Do not paste the secret into logs while troubleshooting.

### Authentication fails

- generate a new token with `claude setup-token`;
- replace the GitHub Actions secret;
- revoke the old token where supported;
- rerun only after confirming the workflow did not expose secret material.

### Claude changes too much

- do not merge;
- ask Claude in the Issue or PR to reduce scope;
- inspect the diff;
- close the PR or abandon the branch if necessary;
- preserve evidence.

### Tests fail

- keep the PR unmerged;
- comment `@claude` with the failing check context;
- require a new commit and fresh CI;
- never weaken a test solely to obtain PASS.

## 6. Disable and rollback

Immediate disable options:

1. Disable the `Claude Code` workflow in GitHub Actions.
2. Remove or rotate `CLAUDE_CODE_OAUTH_TOKEN`.
3. Restrict or uninstall the Claude GitHub App.
4. Revert the enabling Pull Request.

Do not delete Issues, branches, commits, PRs, Action logs, or review evidence merely to make the system look clean.

## 7. Production rules

```text
AUTO_MERGE=false
AUTO_DEPLOY=false
OWNER_APPROVAL_REQUIRED=true
SECRET_IN_REPO=false
EXTERNAL_ACTOR_TRIGGER=false
OTHER_AI=false
```
