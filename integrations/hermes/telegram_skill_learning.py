"""Audit, snapshot, verify, and roll back Hermes skill learning from Telegram.

This module never injects training history into customer prompts. The Telegram
training skill uses Hermes' native skill_manage tool to patch thu-ha-cosmetics;
this helper only provides safety, versioning, audit, and rollback around that patch.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
from datetime import datetime, timezone
from pathlib import Path

from integrations.hermes.cosmetics_training_store import normalize_trainer

TRAINING_ROOT = Path(
    os.getenv(
        "THA_SKILL_LEARNING_PATH",
        "/opt/data/training/thu-ha-cosmetics/skill-learning",
    )
)
SKILL_ROOT = Path(
    os.getenv(
        "THA_COSMETICS_SKILL_PATH",
        "/opt/data/skills/thu-ha-cosmetics",
    )
)

_TEXT_SUFFIXES = {".md", ".txt", ".yaml", ".yml", ".json"}
_REQUIRED_FILES = {
    "SKILL.md",
    "references/sales-flow.md",
    "references/tone-and-dialogue.md",
    "references/safety-and-handoff.md",
}
_CURRENCY_RE = re.compile(
    r"(?:\b\d{1,3}(?:[.,]\d{3})+\b|\b\d+(?:[.,]\d+)?\s*(?:k|nghìn|ngàn|triệu|đ|vnd)\b)",
    re.I,
)
_STOCK_VALUE_RE = re.compile(
    r"(?:tồn kho|còn hàng|số lượng|stock)\s*(?:là|=|:)?\s*\d+",
    re.I,
)
_EMAIL_RE = re.compile(r"\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b", re.I)
_PHONE_RE = re.compile(r"(?<!\d)(?:\+?84|0)\d{8,10}(?!\d)")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _atomic_write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(content, encoding="utf-8")
    temporary.replace(path)


def _dirs(root: Path = TRAINING_ROOT) -> dict[str, Path]:
    result = {
        "pending": root / "pending",
        "active": root / "active",
        "rolled_back": root / "rolled_back",
        "versions": root / "versions",
    }
    for directory in result.values():
        directory.mkdir(parents=True, exist_ok=True)
    root.mkdir(parents=True, exist_ok=True)
    return result


def _version_number(value: str) -> int:
    match = re.fullmatch(r"skill-v(\d+)", value or "")
    return int(match.group(1)) if match else 0


def _next_version(root: Path = TRAINING_ROOT) -> str:
    maximum = 0
    directories = _dirs(root)
    for state in ("pending", "active", "rolled_back"):
        for path in directories[state].glob("*.json"):
            try:
                payload = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, UnicodeError, json.JSONDecodeError):
                continue
            maximum = max(maximum, _version_number(str(payload.get("version", ""))))
    return f"skill-v{maximum + 1:04d}"


def _iter_text_files(root: Path) -> list[Path]:
    return sorted(
        path
        for path in root.rglob("*")
        if path.is_file() and path.suffix.casefold() in _TEXT_SUFFIXES
    )


def _file_hash(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _tree_hashes(root: Path) -> dict[str, str]:
    return {
        path.relative_to(root).as_posix(): _file_hash(path)
        for path in _iter_text_files(root)
    }


def _copy_skill(source: Path, target: Path) -> None:
    if target.exists():
        shutil.rmtree(target)
    shutil.copytree(source, target)


def _read_reason(reason: str, reason_file: str) -> str:
    value = reason.strip()
    if reason_file:
        value = Path(reason_file).read_text(encoding="utf-8").strip()
    value = re.sub(r"\s+", " ", value)
    if not value:
        raise ValueError("Training reason must not be empty")
    return value[:1200]


def _manifest_path(transaction_id: str, root: Path = TRAINING_ROOT) -> Path:
    directories = _dirs(root)
    for key in ("pending", "active", "rolled_back"):
        candidate = directories[key] / f"{transaction_id}.json"
        if candidate.exists():
            return candidate
    raise ValueError(f"Training transaction was not found: {transaction_id}")


def _load_manifest(transaction_id: str, root: Path = TRAINING_ROOT) -> tuple[Path, dict[str, object]]:
    path = _manifest_path(transaction_id, root)
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError("Invalid training manifest")
    return path, payload


def _append_audit(payload: dict[str, object], root: Path = TRAINING_ROOT) -> None:
    root.mkdir(parents=True, exist_ok=True)
    with (root / "audit.jsonl").open("a", encoding="utf-8") as audit:
        audit.write(json.dumps(payload, ensure_ascii=False) + "\n")


def snapshot(
    trainer: str,
    reason: str,
    *,
    root: Path = TRAINING_ROOT,
    skill_root: Path = SKILL_ROOT,
) -> dict[str, object]:
    trainer_name = normalize_trainer(trainer)
    if not (skill_root / "SKILL.md").is_file():
        raise ValueError(f"Skill was not found: {skill_root}")
    version = _next_version(root)
    created_at = _now()
    digest = hashlib.sha256(
        f"{version}|{trainer_name}|{reason}|{created_at}".encode("utf-8")
    ).hexdigest()[:12]
    transaction_id = f"{version}-{digest}"
    directories = _dirs(root)
    version_root = directories["versions"] / transaction_id
    _copy_skill(skill_root, version_root / "before")
    manifest: dict[str, object] = {
        "transaction_id": transaction_id,
        "version": version,
        "status": "SNAPSHOT",
        "trainer": trainer_name,
        "reason": reason,
        "created_at": created_at,
        "verified_at": "",
        "rolled_back_at": "",
        "before_hashes": _tree_hashes(skill_root),
        "after_hashes": {},
        "changed_files": [],
    }
    target = directories["pending"] / f"{transaction_id}.json"
    _atomic_write(target, json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    _append_audit({"action": "SNAPSHOT", **manifest}, root)
    return manifest


def _changed_text(before: Path, after: Path, changed_files: list[str]) -> str:
    chunks: list[str] = []
    for relative in changed_files:
        current = after / relative
        if not current.is_file() or current.suffix.casefold() not in _TEXT_SUFFIXES:
            continue
        old = before / relative
        old_text = old.read_text(encoding="utf-8") if old.is_file() else ""
        new_text = current.read_text(encoding="utf-8")
        if new_text != old_text:
            chunks.append(new_text)
    return "\n".join(chunks)


def _validate_skill(skill_root: Path, changed_text: str) -> None:
    for relative in _REQUIRED_FILES:
        if not (skill_root / relative).is_file():
            raise ValueError(f"Required skill file is missing: {relative}")
    skill_text = (skill_root / "SKILL.md").read_text(encoding="utf-8")
    if "name: thu-ha-cosmetics" not in skill_text:
        raise ValueError("Training changed the target skill identity")
    files = _iter_text_files(skill_root)
    total = 0
    for path in files:
        size = path.stat().st_size
        total += size
        if size > 30_000:
            raise ValueError(f"Skill file is too large: {path.name}")
    if total > 90_000:
        raise ValueError("Skill is too large; consolidate existing rules before adding more")
    if _CURRENCY_RE.search(changed_text) or _STOCK_VALUE_RE.search(changed_text):
        raise ValueError("Do not store live price, stock, or promotion values in a skill")
    if _EMAIL_RE.search(changed_text) or _PHONE_RE.search(changed_text):
        raise ValueError("Do not store customer personal data in a shared skill")


def verify(
    transaction_id: str,
    trainer: str,
    *,
    root: Path = TRAINING_ROOT,
    skill_root: Path = SKILL_ROOT,
) -> dict[str, object]:
    trainer_name = normalize_trainer(trainer)
    manifest_path, manifest = _load_manifest(transaction_id, root)
    if manifest.get("status") != "SNAPSHOT":
        raise ValueError("Only a pending snapshot can be verified")
    if manifest.get("trainer") != trainer_name:
        raise ValueError("Trainer does not match the snapshot owner")
    version_root = _dirs(root)["versions"] / transaction_id
    before = version_root / "before"
    before_hashes = dict(manifest.get("before_hashes", {}))
    after_hashes = _tree_hashes(skill_root)
    all_files = set(before_hashes) | set(after_hashes)
    changed_files = sorted(
        name for name in all_files if before_hashes.get(name) != after_hashes.get(name)
    )
    if not changed_files:
        raise ValueError("skill_manage did not change the Thu Ha cosmetics skill")
    changed_text = _changed_text(before, skill_root, changed_files)
    _validate_skill(skill_root, changed_text)
    _copy_skill(skill_root, version_root / "after")
    manifest.update(
        {
            "status": "ACTIVE",
            "verified_at": _now(),
            "after_hashes": after_hashes,
            "changed_files": changed_files,
        }
    )
    active_path = _dirs(root)["active"] / manifest_path.name
    _atomic_write(active_path, json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    manifest_path.unlink()
    _append_audit({"action": "APPLY_SKILL", **manifest}, root)
    return manifest


def abort_pending(
    transaction_id: str,
    trainer: str,
    *,
    root: Path = TRAINING_ROOT,
    skill_root: Path = SKILL_ROOT,
) -> dict[str, object]:
    trainer_name = normalize_trainer(trainer)
    manifest_path, manifest = _load_manifest(transaction_id, root)
    if manifest.get("status") != "SNAPSHOT":
        raise ValueError("Only a pending snapshot can be aborted")
    if manifest.get("trainer") != trainer_name:
        raise ValueError("Trainer does not match the snapshot owner")
    before = _dirs(root)["versions"] / transaction_id / "before"
    if not before.is_dir():
        raise ValueError("Abort snapshot is missing")
    _copy_skill(before, skill_root)
    manifest.update(
        {
            "status": "ABORTED",
            "rolled_back_at": _now(),
            "rolled_back_by": trainer_name,
        }
    )
    target = _dirs(root)["rolled_back"] / manifest_path.name
    _atomic_write(target, json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    manifest_path.unlink()
    _append_audit({"action": "ABORT_SKILL", **manifest}, root)
    return manifest


def _active_manifests(root: Path = TRAINING_ROOT) -> list[tuple[Path, dict[str, object]]]:
    results: list[tuple[Path, dict[str, object]]] = []
    for path in _dirs(root)["active"].glob("*.json"):
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, json.JSONDecodeError):
            continue
        results.append((path, payload))
    results.sort(key=lambda item: _version_number(str(item[1].get("version", ""))), reverse=True)
    return results


def rollback_latest(
    trainer: str,
    *,
    root: Path = TRAINING_ROOT,
    skill_root: Path = SKILL_ROOT,
) -> dict[str, object]:
    trainer_name = normalize_trainer(trainer)
    active = _active_manifests(root)
    if not active:
        raise ValueError("No active skill training transaction to roll back")
    manifest_path, manifest = active[0]
    transaction_id = str(manifest["transaction_id"])
    before = _dirs(root)["versions"] / transaction_id / "before"
    if not before.is_dir():
        raise ValueError("Rollback snapshot is missing")
    _copy_skill(before, skill_root)
    manifest.update(
        {
            "status": "ROLLED_BACK",
            "rolled_back_at": _now(),
            "rolled_back_by": trainer_name,
        }
    )
    target = _dirs(root)["rolled_back"] / manifest_path.name
    _atomic_write(target, json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    manifest_path.unlink()
    _append_audit({"action": "ROLLBACK_SKILL", **manifest}, root)
    return manifest


def list_transactions(root: Path = TRAINING_ROOT) -> list[dict[str, object]]:
    items: list[dict[str, object]] = []
    directories = _dirs(root)
    for state in ("pending", "active", "rolled_back"):
        for path in directories[state].glob("*.json"):
            try:
                payload = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, UnicodeError, json.JSONDecodeError):
                continue
            items.append(payload)
    return sorted(
        items,
        key=lambda item: _version_number(str(item.get("version", ""))),
        reverse=True,
    )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="action", required=True)

    snapshot_parser = subparsers.add_parser("snapshot")
    snapshot_parser.add_argument("--trainer", required=True)
    snapshot_parser.add_argument("--reason", default="")
    snapshot_parser.add_argument("--reason-file", default="")

    verify_parser = subparsers.add_parser("verify")
    verify_parser.add_argument("--trainer", required=True)
    verify_parser.add_argument("--transaction-id", required=True)

    abort_parser = subparsers.add_parser("abort")
    abort_parser.add_argument("--trainer", required=True)
    abort_parser.add_argument("--transaction-id", required=True)

    rollback_parser = subparsers.add_parser("rollback")
    rollback_parser.add_argument("--trainer", required=True)

    subparsers.add_parser("list")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.action == "snapshot":
        reason = _read_reason(args.reason, args.reason_file)
        result = snapshot(args.trainer, reason)
        print(
            "PASS SKILL_LEARNING_SNAPSHOT "
            f"transaction_id={result['transaction_id']} version={result['version']}"
        )
        return 0
    if args.action == "verify":
        result = verify(args.transaction_id, args.trainer)
        print(
            "PASS SKILL_LEARNING_ACTIVE "
            f"transaction_id={result['transaction_id']} "
            f"changed_files={','.join(result['changed_files'])}"
        )
        return 0
    if args.action == "abort":
        result = abort_pending(args.transaction_id, args.trainer)
        print(
            "PASS SKILL_LEARNING_ABORTED "
            f"transaction_id={result['transaction_id']}"
        )
        return 0
    if args.action == "rollback":
        result = rollback_latest(args.trainer)
        print(
            "PASS SKILL_LEARNING_ROLLED_BACK "
            f"transaction_id={result['transaction_id']}"
        )
        return 0
    print(json.dumps(list_transactions(), ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
