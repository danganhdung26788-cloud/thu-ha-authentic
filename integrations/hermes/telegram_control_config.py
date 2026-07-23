"""Configure and discover the Hermes DM topic used for Fanpage control."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

import yaml

DEFAULT_CONFIG = Path("/opt/data/config.yaml")
DEFAULT_CHAT_ID = "865426291"
DEFAULT_TOPIC_NAME = "Điều hành Fanpage Thu Hà"
DEFAULT_SKILL = "thu-ha-inbox"


def load_config(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    return data if isinstance(data, dict) else {}


def save_config(path: Path, config: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        yaml.safe_dump(config, allow_unicode=True, sort_keys=False),
        encoding="utf-8",
    )


def telegram_extra(config: dict[str, Any]) -> dict[str, Any]:
    platforms = config.setdefault("platforms", {})
    telegram = platforms.setdefault("telegram", {})
    return telegram.setdefault("extra", {})


def ensure_topic(
    config: dict[str, Any],
    *,
    chat_id: str,
    topic_name: str,
    skill: str,
) -> dict[str, Any]:
    extra = telegram_extra(config)
    entries = extra.setdefault("dm_topics", [])
    if not isinstance(entries, list):
        raise ValueError("platforms.telegram.extra.dm_topics must be a list")

    chat_entry: dict[str, Any] | None = None
    for entry in entries:
        if isinstance(entry, dict) and str(entry.get("chat_id", "")) == str(chat_id):
            chat_entry = entry
            break
    if chat_entry is None:
        chat_entry = {"chat_id": int(chat_id) if str(chat_id).isdigit() else str(chat_id), "topics": []}
        entries.append(chat_entry)

    topics = chat_entry.setdefault("topics", [])
    if not isinstance(topics, list):
        raise ValueError("dm_topics[].topics must be a list")

    topic: dict[str, Any] | None = None
    for candidate in topics:
        if isinstance(candidate, dict) and candidate.get("name") == topic_name:
            topic = candidate
            break
    if topic is None:
        topic = {"name": topic_name, "icon_color": 7322096}
        topics.append(topic)
    topic["skill"] = skill
    return topic


def find_topic(
    config: dict[str, Any], *, chat_id: str, topic_name: str
) -> dict[str, Any] | None:
    entries = (
        config.get("platforms", {})
        .get("telegram", {})
        .get("extra", {})
        .get("dm_topics", [])
    )
    if not isinstance(entries, list):
        return None
    for entry in entries:
        if not isinstance(entry, dict) or str(entry.get("chat_id", "")) != str(chat_id):
            continue
        topics = entry.get("topics", [])
        if not isinstance(topics, list):
            continue
        for topic in topics:
            if isinstance(topic, dict) and topic.get("name") == topic_name:
                return topic
    return None


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", default=str(DEFAULT_CONFIG))
    parser.add_argument("--chat-id", default=DEFAULT_CHAT_ID)
    parser.add_argument("--topic-name", default=DEFAULT_TOPIC_NAME)
    parser.add_argument("--skill", default=DEFAULT_SKILL)
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("ensure")
    sub.add_parser("target")
    sub.add_parser("show")
    return parser


def main() -> int:
    args = build_parser().parse_args()
    path = Path(args.config)
    config = load_config(path)
    if args.command == "ensure":
        topic = ensure_topic(
            config,
            chat_id=args.chat_id,
            topic_name=args.topic_name,
            skill=args.skill,
        )
        save_config(path, config)
        print(json.dumps(topic, ensure_ascii=False))
        return 0

    topic = find_topic(config, chat_id=args.chat_id, topic_name=args.topic_name)
    if topic is None:
        raise SystemExit("CONTROL_TOPIC_NOT_FOUND")
    if args.command == "show":
        print(json.dumps(topic, ensure_ascii=False))
        return 0
    thread_id = str(topic.get("thread_id", "")).strip()
    if not thread_id:
        raise SystemExit("CONTROL_TOPIC_THREAD_ID_PENDING")
    print(f"telegram:{args.chat_id}:{thread_id}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
