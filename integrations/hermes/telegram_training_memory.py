"""Versioned active-memory store for Thu Ha Authentic Telegram training."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path

from integrations.hermes.cosmetics_training_store import normalize_trainer

TRAINING_ROOT = Path(
    os.getenv("THA_COSMETICS_TRAINING_PATH", "/opt/data/training/thu-ha-cosmetics")
)
ACTIVE_MEMORY_PATH = Path(
    os.getenv("THA_ACTIVE_TRAINING_MEMORY_PATH", "/opt/data/memories/THA_TRAINING_ACTIVE.md")
)


@dataclass(frozen=True)
class ActiveLesson:
    lesson_id: str
    version: str
    status: str
    trainer: str
    created_at: str
    trigger: str
    rule: str
    bad_example: str
    good_example: str
    reason: str
    previous_version: str


def _atomic_write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(content, encoding="utf-8")
    temporary.replace(path)


def _directories(root: Path) -> dict[str, Path]:
    result = {
        "active": root / "active",
        "rolled_back": root / "rolled_back",
        "versions": root / "versions",
    }
    for directory in result.values():
        directory.mkdir(parents=True, exist_ok=True)
    root.mkdir(parents=True, exist_ok=True)
    return result


def _version_number(value: str) -> int:
    match = re.fullmatch(r"training-v(\d+)", value or "")
    return int(match.group(1)) if match else 0


def next_version(root: Path = TRAINING_ROOT) -> tuple[str, str]:
    directories = _directories(root)
    maximum = 0
    previous = ""
    for directory in (directories["active"], directories["rolled_back"]):
        for path in directory.glob("*.json"):
            try:
                payload = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, UnicodeError, json.JSONDecodeError):
                continue
            version = str(payload.get("version", ""))
            number = _version_number(version)
            if number > maximum:
                maximum = number
                previous = version
    return f"training-v{maximum + 1:04d}", previous


def _reject_dynamic_facts(rule: str) -> None:
    normalized = rule.casefold()
    has_number = bool(re.search(r"\d", rule))
    dynamic_words = ("giá", "gia", "tồn kho", "ton kho", "còn hàng", "con hang", "khuyến mại", "khuyen mai")
    if has_number and any(word in normalized for word in dynamic_words):
        raise ValueError("Do not store price, stock, or promotion values in active memory")


def _clean(value: object, limit: int) -> str:
    text = re.sub(r"\s+", " ", str(value or "")).strip()
    return text[:limit]


def _load_active_lessons(root: Path) -> list[ActiveLesson]:
    active = _directories(root)["active"]
    lessons: list[ActiveLesson] = []
    for path in active.glob("*.json"):
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
            lessons.append(ActiveLesson(**payload))
        except (OSError, UnicodeError, json.JSONDecodeError, TypeError):
            continue
    return sorted(lessons, key=lambda item: _version_number(item.version), reverse=True)


def render_active_memory(
    root: Path = TRAINING_ROOT,
    memory_path: Path = ACTIVE_MEMORY_PATH,
) -> str:
    lessons = _load_active_lessons(root)
    lines = [
        "# Thu Hà Authentic — Telegram training đang có hiệu lực",
        "",
        "Chỉ các bài học do Nông Thu Hà hoặc Đặng Anh Dũng ghi nhận mới xuất hiện tại đây.",
        "Giá, tồn kho và khuyến mại không được lưu trong memory; phải tra kho ở thời điểm trả lời.",
        "",
    ]
    if not lessons:
        lines.append("Chưa có bài training đang hoạt động.")
    for lesson in lessons:
        lines.extend(
            [
                f"## {lesson.version} — {lesson.lesson_id}",
                f"- Khi áp dụng: {lesson.trigger}",
                f"- Quy tắc: {lesson.rule}",
            ]
        )
        if lesson.bad_example:
            lines.append(f"- Tránh: {lesson.bad_example}")
        if lesson.good_example:
            lines.append(f"- Mẫu đúng: {lesson.good_example}")
        if lesson.reason:
            lines.append(f"- Lý do: {lesson.reason}")
        lines.extend([f"- Người training: {lesson.trainer}", ""])
    content = "\n".join(lines).rstrip() + "\n"
    _atomic_write(memory_path, content)
    return content


def apply_lesson(
    payload: dict[str, object],
    trainer: str,
    root: Path = TRAINING_ROOT,
    memory_path: Path = ACTIVE_MEMORY_PATH,
) -> ActiveLesson:
    trainer_name = normalize_trainer(trainer)
    trigger = _clean(payload.get("trigger", ""), 800)
    rule = _clean(payload.get("rule", ""), 2000)
    bad_example = _clean(payload.get("bad_example", ""), 1200)
    good_example = _clean(payload.get("good_example", ""), 1200)
    reason = _clean(payload.get("reason", ""), 800)
    if not trigger:
        raise ValueError("Training trigger must not be empty")
    if not rule:
        raise ValueError("Training rule must not be empty")
    _reject_dynamic_facts(rule)

    directories = _directories(root)
    version, previous = next_version(root)
    created_at = datetime.now(timezone.utc).isoformat()
    digest = hashlib.sha256(
        "|".join((version, trainer_name, trigger, rule, created_at)).encode("utf-8")
    ).hexdigest()[:16]
    lesson = ActiveLesson(
        lesson_id=f"tha-memory-{digest}",
        version=version,
        status="ACTIVE",
        trainer=trainer_name,
        created_at=created_at,
        trigger=trigger,
        rule=rule,
        bad_example=bad_example,
        good_example=good_example,
        reason=reason,
        previous_version=previous,
    )

    if memory_path.exists():
        snapshot = directories["versions"] / f"{version}-before.md"
        shutil.copy2(memory_path, snapshot)
    target = directories["active"] / f"{version}-{lesson.lesson_id}.json"
    _atomic_write(target, json.dumps(asdict(lesson), ensure_ascii=False, indent=2) + "\n")
    with (root / "audit.jsonl").open("a", encoding="utf-8") as audit:
        audit.write(json.dumps({"action": "APPLY", **asdict(lesson)}, ensure_ascii=False) + "\n")
    render_active_memory(root, memory_path)
    return lesson


def rollback_latest(
    trainer: str,
    root: Path = TRAINING_ROOT,
    memory_path: Path = ACTIVE_MEMORY_PATH,
) -> ActiveLesson:
    trainer_name = normalize_trainer(trainer)
    lessons = _load_active_lessons(root)
    if not lessons:
        raise ValueError("No active training lesson to roll back")
    latest = lessons[0]
    directories = _directories(root)
    source = next(directories["active"].glob(f"{latest.version}-{latest.lesson_id}.json"), None)
    if source is None:
        raise ValueError("Active training file was not found")
    payload = asdict(latest)
    payload["status"] = "ROLLED_BACK"
    target = directories["rolled_back"] / source.name
    _atomic_write(target, json.dumps(payload, ensure_ascii=False, indent=2) + "\n")
    source.unlink()
    with (root / "audit.jsonl").open("a", encoding="utf-8") as audit:
        audit.write(
            json.dumps(
                {
                    "action": "ROLLBACK",
                    "version": latest.version,
                    "lesson_id": latest.lesson_id,
                    "trainer": trainer_name,
                    "created_at": datetime.now(timezone.utc).isoformat(),
                },
                ensure_ascii=False,
            )
            + "\n"
        )
    render_active_memory(root, memory_path)
    return latest


def _payload_from_args(args: argparse.Namespace) -> dict[str, object]:
    if args.payload_file:
        payload = json.loads(Path(args.payload_file).read_text(encoding="utf-8"))
    elif args.payload_json:
        payload = json.loads(args.payload_json)
    else:
        payload = json.load(os.sys.stdin)
    if not isinstance(payload, dict):
        raise ValueError("Training payload must be a JSON object")
    return payload


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="action", required=True)

    apply_parser = subparsers.add_parser("apply")
    apply_parser.add_argument("--trainer", required=True)
    apply_parser.add_argument("--payload-file")
    apply_parser.add_argument("--payload-json")

    rollback_parser = subparsers.add_parser("rollback")
    rollback_parser.add_argument("--trainer", required=True)

    subparsers.add_parser("list")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.action == "apply":
        lesson = apply_lesson(_payload_from_args(args), args.trainer)
        print(
            "PASS TELEGRAM_TRAINING_APPLIED "
            f"version={lesson.version} lesson_id={lesson.lesson_id} status={lesson.status}"
        )
        return 0
    if args.action == "rollback":
        lesson = rollback_latest(args.trainer)
        print(
            "PASS TELEGRAM_TRAINING_ROLLED_BACK "
            f"version={lesson.version} lesson_id={lesson.lesson_id}"
        )
        return 0
    lessons = _load_active_lessons(TRAINING_ROOT)
    print(json.dumps([asdict(item) for item in lessons], ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
