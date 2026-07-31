"""Compact Telegram checklist UI for the Hermes task-only digest.

This module is presentation-only. It reuses the locked Issue #39 repository,
digest classification and callback keyboard without changing mutation logic.
"""
from __future__ import annotations

import argparse
import json
import os
import re
from datetime import date
from typing import Any, Mapping, Sequence

from integrations.hermes.task_checklist import (
    CONTINUE_MARKER,
    TERMINAL_SUBTASK_STATUSES,
    SheetsTaskRepository,
    TaskRepository,
    TelegramClient,
    build_digest,
    normalize_status,
    today_vn,
)

GROUP_META: dict[str, tuple[str, str]] = {
    "QUÁ HẠN": ("🔴", "Quá hạn"),
    "ĐẾN HẠN HÔM NAY": ("🟠", "Đến hạn hôm nay"),
    "SẮP ĐẾN HẠN": ("🟡", "Sắp đến hạn"),
    "ĐANG CHỜ": ("⏸", "Đang chờ"),
    "CẦN CHỌN TRẠNG THÁI": ("❔", "Cần chọn trạng thái"),
    "CẦN ĐỒNG BỘ DỮ LIỆU": ("🔎", "Cần đồng bộ dữ liệu"),
}

MAX_CARD_LENGTH = 3200
MAX_TITLE_LENGTH = 120
MAX_CHILDREN_PREVIEW = 6


def _compact_space(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()


def _truncate_words(value: Any, limit: int) -> str:
    text = _compact_space(value)
    if len(text) <= limit:
        return text
    cut = text[: max(1, limit - 1)].rstrip()
    if " " in cut:
        cut = cut.rsplit(" ", 1)[0].rstrip()
    return f"{cut}…"


def _task_id(record: Mapping[str, str]) -> str:
    return _compact_space(record.get("WORK_ID"))


def _is_subtask(record: Mapping[str, str]) -> bool:
    return _compact_space(record.get("_TASK_KIND")).upper() == "SUBTASK"


def _is_open_child(record: Mapping[str, str]) -> bool:
    status = normalize_status(record.get("STATUS"))
    return status not in TERMINAL_SUBTASK_STATUSES


def _children_by_parent(
    subtasks: Sequence[Mapping[str, str]],
) -> dict[str, list[Mapping[str, str]]]:
    grouped: dict[str, list[Mapping[str, str]]] = {}
    for child in subtasks:
        parent_id = _compact_space(child.get("WORK_ID"))
        child_id = _compact_space(child.get("SUBTASK_ID"))
        if not parent_id or not child_id or not _is_open_child(child):
            continue
        grouped.setdefault(parent_id, []).append(child)
    return grouped


def _parent_titles(
    work_items: Sequence[Mapping[str, str]],
) -> dict[str, str]:
    return {
        _compact_space(row.get("WORK_ID")): _compact_space(row.get("TITLE"))
        for row in work_items
        if _compact_space(row.get("WORK_ID"))
    }


def _format_parent_card(
    work: Mapping[str, str],
    group: str,
    children: Sequence[Mapping[str, str]],
) -> str:
    icon, label = GROUP_META.get(group, ("📋", group.title()))
    work_id = _task_id(work)
    title = _truncate_words(work.get("TITLE"), MAX_TITLE_LENGTH)
    status = _compact_space(work.get("STATUS")) or "CHƯA CHỌN"
    lines = [
        f"☐ {work_id} — {title}",
        f"{icon} {label}",
        f"Trạng thái: {status}",
    ]
    due = _compact_space(work.get("DUE_DATE"))
    if due:
        lines.append(f"Hạn: {due}")
    if children:
        lines.append(f"Việc con đang mở: {len(children)}")
        for child in children[:MAX_CHILDREN_PREVIEW]:
            child_id = _compact_space(child.get("SUBTASK_ID"))
            child_title = _truncate_words(child.get("TITLE"), 92)
            lines.append(f"  ☐ {child_id} — {child_title}")
        remaining = len(children) - MAX_CHILDREN_PREVIEW
        if remaining > 0:
            lines.append(f"  … còn {remaining} việc con")
    return _truncate_words("\n".join(lines), MAX_CARD_LENGTH)


def _format_standalone_child_card(
    child: Mapping[str, str],
    group: str,
    parent_title: str,
) -> str:
    icon, label = GROUP_META.get(group, ("📋", group.title()))
    child_id = _task_id(child)
    title = _truncate_words(child.get("TITLE"), MAX_TITLE_LENGTH)
    status = _compact_space(child.get("STATUS")) or "CHƯA CHỌN"
    parent_id = _compact_space(child.get("PARENT_WORK_ID"))
    lines = [
        f"☐ {child_id} — {title}",
        f"{icon} {label}",
        f"Trạng thái: {status}",
    ]
    due = _compact_space(child.get("DUE_DATE"))
    if due:
        lines.append(f"Hạn: {due}")
    if parent_id:
        parent = f"{parent_id} — {_truncate_words(parent_title, 92)}" if parent_title else parent_id
        lines.append(f"Thuộc nhiệm vụ: {parent}")
    return _truncate_words("\n".join(lines), MAX_CARD_LENGTH)


def _visible_records(digest: Any) -> tuple[dict[str, list[Mapping[str, str]]], set[str]]:
    parent_ids = {
        _task_id(record)
        for records in digest.groups.values()
        for record in records
        if not _is_subtask(record) and _task_id(record)
    }
    visible: dict[str, list[Mapping[str, str]]] = {}
    for group, records in digest.groups.items():
        selected: list[Mapping[str, str]] = []
        for record in records:
            if _is_subtask(record):
                parent_id = _compact_space(record.get("PARENT_WORK_ID"))
                if parent_id in parent_ids:
                    continue
            selected.append(record)
        visible[group] = selected
    return visible, parent_ids


def _summary_text(visible: Mapping[str, Sequence[Mapping[str, str]]], today: date) -> str:
    lines = [f"📋 VIỆC CẦN XỬ LÝ — {today.strftime('%d/%m/%Y')}"]
    for group, records in visible.items():
        count = len(records)
        if count:
            icon, label = GROUP_META.get(group, ("📋", group.title()))
            lines.append(f"{icon} {label}: {count}")
    lines.extend(["", "Xử lý từng thẻ bên dưới."])
    return "\n".join(lines)


def _send_plain_message(
    telegram: TelegramClient,
    *,
    chat_id: str,
    thread_id: str,
    text: str,
) -> str:
    payload: dict[str, Any] = {
        "chat_id": chat_id,
        "text": text,
        "disable_web_page_preview": True,
    }
    if thread_id:
        payload["message_thread_id"] = int(thread_id)
    return str(telegram._call("sendMessage", payload)["result"]["message_id"])


def send_checklist_digest(
    repo: TaskRepository,
    telegram: TelegramClient,
    *,
    chat_id: str,
    thread_id: str = "",
    today: date | None = None,
) -> int:
    effective_today = today or today_vn()
    work_items = repo.read_work_items()
    subtasks = repo.read_subtasks()
    digest = build_digest(work_items, subtasks, today=effective_today)
    visible, parent_ids = _visible_records(digest)
    total_cards = sum(len(records) for records in visible.values())
    if total_cards == 0:
        return 0

    _send_plain_message(
        telegram,
        chat_id=chat_id,
        thread_id=thread_id,
        text=_summary_text(visible, effective_today),
    )

    allow_transfer = bool(repo.read_assignees())
    open_children = _children_by_parent(subtasks)
    parent_titles = _parent_titles(work_items)
    sent = 0
    seen: set[str] = set()
    for group, records in visible.items():
        for record in records:
            work_id = _task_id(record)
            if not work_id or work_id in seen:
                continue
            if _is_subtask(record):
                parent_id = _compact_space(record.get("PARENT_WORK_ID"))
                text = _format_standalone_child_card(
                    record,
                    group,
                    parent_titles.get(parent_id, ""),
                )
            else:
                text = _format_parent_card(
                    record,
                    group,
                    open_children.get(work_id, ()),
                )
            telegram.send_task(
                chat_id=chat_id,
                thread_id=thread_id,
                text=text,
                work_id=work_id,
                sync_required=group == "CẦN ĐỒNG BỘ DỮ LIỆU",
                allow_transfer=allow_transfer,
            )
            seen.add(work_id)
            sent += 1
    return sent


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    digest_parser = sub.add_parser("digest")
    digest_parser.add_argument("--send", action="store_true")
    digest_parser.add_argument("--chat-id", default=os.getenv("HERMES_TASK_CHAT_ID", ""))
    digest_parser.add_argument("--thread-id", default=os.getenv("HERMES_TASK_THREAD_ID", ""))
    args = parser.parse_args()

    repo = SheetsTaskRepository()
    work_items = repo.read_work_items()
    subtasks = repo.read_subtasks()
    digest = build_digest(work_items, subtasks)
    visible, _ = _visible_records(digest)
    if not args.send:
        print(json.dumps(
            {group: [_task_id(row) for row in rows] for group, rows in visible.items()},
            ensure_ascii=False,
            indent=2,
        ))
        return 0
    if not args.chat_id:
        raise RuntimeError("HERMES_TASK_CHAT_ID or --chat-id is required with --send")
    if normalize_status(os.getenv("TASK_ONLY_MODE")) not in {"TRUE", "YES", "1"}:
        raise RuntimeError("TASK_ONLY_MODE=true is required before sending a digest")
    sent = send_checklist_digest(
        repo,
        TelegramClient(os.getenv("TELEGRAM_BOT_TOKEN", "").strip()),
        chat_id=args.chat_id,
        thread_id=args.thread_id,
    )
    print(json.dumps({"sent": sent, "ui": "compact-parent-child"}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
