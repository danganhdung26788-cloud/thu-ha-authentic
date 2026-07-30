"""Issue #39 bridge for the existing python-telegram-bot getUpdates loop.

The host adapter delegates matching callback queries and pending text replies
here. This module never starts a second bot and never registers a webhook.
"""
from __future__ import annotations

import json
import os
import secrets
import sqlite3
import threading
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Mapping

from integrations.hermes.task_checklist import (
    CONTINUE_MARKER,
    SheetsTaskRepository,
    TaskRepository,
    TERMINAL_SUBTASK_STATUSES,
    VN_TZ,
    normalize_status,
    parse_date,
    process_callback,
    today_vn,
)

DEFAULT_STATE_PATH = "/opt/data/tha-telegram/task-checklist-interactions.db"
STATE_PREFIXES = ("ht:", "htp:", "htt:", "htc:", "htk:")


def _now(moment: datetime | None = None) -> datetime:
    value = moment or datetime.now(timezone.utc)
    if value.tzinfo is None:
        raise ValueError("moment must be timezone-aware")
    return value.astimezone(VN_TZ)


def _timeout_seconds() -> int:
    return max(30, int(os.getenv("HERMES_TASK_INTERACTION_TIMEOUT_SECONDS", "300")))


def _markup(rows: list[list[tuple[str, str]]]) -> Any:
    raw = {
        "inline_keyboard": [
            [{"text": text, "callback_data": data} for text, data in row]
            for row in rows
        ]
    }
    try:
        from telegram import InlineKeyboardButton, InlineKeyboardMarkup

        return InlineKeyboardMarkup([
            [InlineKeyboardButton(text, callback_data=data) for text, data in row]
            for row in rows
        ])
    except ImportError:
        return raw


class InteractionStore:
    """SQLite-backed state, durable across polling process restarts."""

    def __init__(self, path: str | os.PathLike[str] | None = None):
        self.path = str(path or os.getenv("HERMES_TASK_STATE_DB", DEFAULT_STATE_PATH))
        Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()
        with self._connect() as connection:
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS interactions (
                    token TEXT PRIMARY KEY,
                    user_id TEXT NOT NULL,
                    chat_id TEXT NOT NULL,
                    thread_id TEXT NOT NULL,
                    work_id TEXT NOT NULL,
                    action TEXT NOT NULL,
                    stage TEXT NOT NULL,
                    payload_json TEXT NOT NULL,
                    expires_at TEXT NOT NULL,
                    result_json TEXT NOT NULL DEFAULT '',
                    updated_at TEXT NOT NULL
                )
                """
            )

    @contextmanager
    def _connect(self):
        connection = sqlite3.connect(self.path, timeout=10)
        connection.row_factory = sqlite3.Row
        try:
            yield connection
            connection.commit()
        finally:
            connection.close()

    def create(
        self, *, user_id: str, chat_id: str, thread_id: str,
        work_id: str, action: str, payload: Mapping[str, Any] | None = None,
        moment: datetime | None = None,
    ) -> dict[str, Any]:
        now = _now(moment)
        token = secrets.token_urlsafe(8)
        row = {
            "token": token,
            "user_id": user_id,
            "chat_id": chat_id,
            "thread_id": thread_id,
            "work_id": work_id,
            "action": action,
            "stage": "SELECT",
            "payload_json": json.dumps(dict(payload or {}), ensure_ascii=False),
            "expires_at": (now + timedelta(seconds=_timeout_seconds())).isoformat(),
            "result_json": "",
            "updated_at": now.isoformat(),
        }
        with self.lock, self._connect() as connection:
            connection.execute(
                """
                INSERT INTO interactions
                (token,user_id,chat_id,thread_id,work_id,action,stage,payload_json,
                 expires_at,result_json,updated_at)
                VALUES (:token,:user_id,:chat_id,:thread_id,:work_id,:action,:stage,
                        :payload_json,:expires_at,:result_json,:updated_at)
                """,
                row,
            )
        return self.get(token, moment=moment)

    def get(self, token: str, *, moment: datetime | None = None) -> dict[str, Any]:
        with self._connect() as connection:
            found = connection.execute(
                "SELECT * FROM interactions WHERE token=?", (token,),
            ).fetchone()
        if found is None:
            raise ValueError("Phiên thao tác không tồn tại")
        row = dict(found)
        row["payload"] = json.loads(row.pop("payload_json") or "{}")
        row["result"] = json.loads(row.pop("result_json") or "{}")
        if (
            row["stage"] not in {"COMPLETE", "CANCELLED", "EXPIRED"}
            and datetime.fromisoformat(row["expires_at"]) <= _now(moment)
        ):
            self.update(token, stage="EXPIRED", moment=moment)
            row["stage"] = "EXPIRED"
        return row

    def update(
        self, token: str, *, stage: str | None = None,
        payload: Mapping[str, Any] | None = None,
        result: Mapping[str, Any] | None = None,
        moment: datetime | None = None,
    ) -> dict[str, Any]:
        now = _now(moment)
        fields: dict[str, Any] = {"updated_at": now.isoformat(), "token": token}
        assignments = ["updated_at=:updated_at"]
        if stage is not None:
            fields["stage"] = stage
            assignments.append("stage=:stage")
        if payload is not None:
            fields["payload_json"] = json.dumps(dict(payload), ensure_ascii=False)
            assignments.append("payload_json=:payload_json")
        if result is not None:
            fields["result_json"] = json.dumps(dict(result), ensure_ascii=False)
            assignments.append("result_json=:result_json")
        with self.lock, self._connect() as connection:
            connection.execute(
                f"UPDATE interactions SET {','.join(assignments)} WHERE token=:token",
                fields,
            )
        return self.get(token, moment=moment)

    def pending(
        self, *, user_id: str, chat_id: str, moment: datetime | None = None,
    ) -> dict[str, Any] | None:
        with self._connect() as connection:
            rows = connection.execute(
                """
                SELECT token FROM interactions
                WHERE user_id=? AND chat_id=?
                  AND stage IN ('AWAITING_DATE','AWAITING_ASSIGNEE')
                ORDER BY updated_at DESC
                """,
                (user_id, chat_id),
            ).fetchall()
        for row in rows:
            session = self.get(row["token"], moment=moment)
            if session["stage"] not in {"EXPIRED", "CANCELLED"}:
                return session
        return None


def _identity_from_query(query: Any) -> tuple[str, str, str, str]:
    user = query.from_user
    message = query.message
    return (
        str(user.id),
        str(message.chat.id),
        str(getattr(message, "message_thread_id", "") or ""),
        str(getattr(user, "username", "") or ""),
    )


def _authorize(user_id: str, chat_id: str) -> None:
    if user_id != os.getenv("HERMES_TASK_OWNER_USER_ID", "").strip():
        raise PermissionError("Sai Telegram numeric owner ID")
    if chat_id != os.getenv("HERMES_TASK_CHAT_ID", "").strip():
        raise PermissionError("Sai Telegram chat ID")


async def _edit(query: Any, text: str, rows: list[list[tuple[str, str]]]) -> None:
    await query.edit_message_text(text=text, reply_markup=_markup(rows))


def _confirm_rows(token: str) -> list[list[tuple[str, str]]]:
    return [[("✅ Xác nhận", f"htc:{token}:y"), ("Hủy", f"htc:{token}:n")]]


def _child_selection_text(session: Mapping[str, Any]) -> str:
    selected = set(session["payload"].get("continue_subtasks", []))
    lines = [f"Nhiệm vụ con của {session['work_id']}:"]
    for item in session["payload"].get("children", []):
        disposition = "TIẾP TỤC ĐỘC LẬP" if item["id"] in selected else "ĐÓNG THEO CHA"
        lines.append(
            f"{'☑️' if item['id'] in selected else '⬜'} "
            f"{item['id']} — {item['title']} [{item['status'] or 'CHƯA CHỌN'}] "
            f"→ {disposition}"
        )
    return "\n".join(lines)[:3900]


def _child_selection_rows(session: Mapping[str, Any]) -> list[list[tuple[str, str]]]:
    selected = set(session["payload"].get("continue_subtasks", []))
    rows = [
        [(
            ("☑️ " if item["id"] in selected else "⬜ ") + item["id"],
            f"htk:{session['token']}:i{index}",
        )]
        for index, item in enumerate(session["payload"].get("children", []))
    ]
    rows.extend([
        [("✅ Xác nhận", f"htk:{session['token']}:y")],
        [("Hủy", f"htk:{session['token']}:n")],
    ])
    return rows


async def handle_callback_query(
    query: Any,
    context: Any,
    *,
    repo: TaskRepository | None = None,
    store: InteractionStore | None = None,
    moment: datetime | None = None,
) -> bool:
    """Handle Issue #39 callbacks inside the existing polling adapter."""
    data = str(query.data or "")
    if not data.startswith(STATE_PREFIXES):
        return False
    user_id, chat_id, thread_id, username = _identity_from_query(query)
    try:
        _authorize(user_id, chat_id)
    except PermissionError:
        await query.answer("Không được phép.", show_alert=True)
        return True
    repository = repo or SheetsTaskRepository()
    sessions = store or InteractionStore()
    await query.answer()

    if data.startswith("ht:"):
        _, code, work_id = data.split(":", 2)
        if code == "p":
            matches = [
                row for row in repository.read_work_items()
                if row.get("WORK_ID", "").strip() == work_id
            ] + [
                row for row in repository.read_subtasks()
                if row.get("SUBTASK_ID", "").strip() == work_id
            ]
            if len(matches) != 1:
                raise ValueError("Không thể lùi hạn cho nhiệm vụ không duy nhất")
            current_due = parse_date(matches[0].get("DUE_DATE", ""))
            base_due = max(current_due or today_vn(moment), today_vn(moment))
            session = sessions.create(
                user_id=user_id, chat_id=chat_id, thread_id=thread_id,
                work_id=work_id, action="p",
                payload={"base_due": base_due.isoformat()}, moment=moment,
            )
            token = session["token"]
            await _edit(query, f"Lùi hạn {work_id}:", [
                [("+1 ngày", f"htp:{token}:1"), ("+3 ngày", f"htp:{token}:3")],
                [("+7 ngày", f"htp:{token}:7"), ("Chọn ngày khác", f"htp:{token}:o")],
                [("Hủy", f"htp:{token}:x")],
            ])
            return True
        if code == "t":
            assignees = repository.read_assignees()
            if not assignees:
                await _edit(
                    query,
                    "Chưa có danh sách người phụ trách sử dụng được; "
                    "không thể Chuyển việc.",
                    [],
                )
                return True
            session = sessions.create(
                user_id=user_id, chat_id=chat_id, thread_id=thread_id,
                work_id=work_id, action="t", payload={"assignees": assignees},
                moment=moment,
            )
            token = session["token"]
            rows = [
                [(name, f"htt:{token}:{index}")]
                for index, name in enumerate(assignees[:20])
            ]
            rows.extend([
                [("Nhập tên khác", f"htt:{token}:o")],
                [("Hủy", f"htt:{token}:x")],
            ])
            await _edit(query, f"Chọn người phụ trách hợp lệ cho {work_id}:", rows)
            return True
        if code == "c":
            parents = [
                row for row in repository.read_work_items()
                if row.get("WORK_ID", "").strip() == work_id
            ]
            open_children = [
                row for row in repository.read_subtasks()
                if row.get("WORK_ID", "").strip() == work_id
                and normalize_status(row.get("STATUS")) not in TERMINAL_SUBTASK_STATUSES
            ]
            if len(parents) == 1 and open_children:
                payload = {
                    "children": [
                        {
                            "id": row.get("SUBTASK_ID", "").strip(),
                            "title": row.get("TITLE", "").strip(),
                            "status": row.get("STATUS", "").strip(),
                        }
                        for row in open_children
                    ],
                    "continue_subtasks": [
                        row.get("SUBTASK_ID", "").strip()
                        for row in open_children
                        if CONTINUE_MARKER in row.get("NOTE", "").upper()
                    ],
                }
                session = sessions.create(
                    user_id=user_id, chat_id=chat_id, thread_id=thread_id,
                    work_id=work_id, action="c", payload=payload, moment=moment,
                )
                await _edit(
                    query,
                    _child_selection_text(session),
                    [
                        [("Đóng toàn bộ", f"htk:{session['token']}:a")],
                        [("Chọn việc tiếp tục", f"htk:{session['token']}:s")],
                        [("Hủy", f"htk:{session['token']}:n")],
                    ],
                )
                return True
        if code == "n":
            open_children = [
                row for row in repository.read_subtasks()
                if row.get("WORK_ID", "").strip() == work_id
                and normalize_status(row.get("STATUS")) not in TERMINAL_SUBTASK_STATUSES
            ]
            session = sessions.create(
                user_id=user_id, chat_id=chat_id, thread_id=thread_id,
                work_id=work_id, action="n",
                payload={
                    "open_child_count": len(open_children),
                    "continue_subtasks": [],
                },
                moment=moment,
            )
            await _edit(
                query,
                f"Xác nhận Không thực hiện {work_id}? "
                f"{len(open_children)} nhiệm vụ con đang mở sẽ đóng theo cha.",
                _confirm_rows(session["token"]),
            )
            sessions.update(session["token"], stage="CONFIRM", moment=moment)
            return True
        result = process_callback(
            repository, callback_id=str(query.id), user_id=user_id,
            username=username, chat_id=chat_id, thread_id=thread_id, data=data,
        )
        status = "Đã xử lý trước đó." if result["idempotent"] else (
            "TaskFlow đã cập nhật; read-back action và audit đều khớp."
        )
        await _edit(query, status, [])
        return True

    prefix, token, choice = data.split(":", 2)
    session = sessions.get(token, moment=moment)
    if session["user_id"] != user_id or session["chat_id"] != chat_id:
        await query.answer("Phiên thao tác không thuộc người dùng này.", show_alert=True)
        return True
    if session["stage"] == "EXPIRED":
        await _edit(query, "Phiên thao tác đã hết hạn.", [])
        return True
    if session["stage"] == "COMPLETE":
        await _edit(query, "Thao tác này đã hoàn tất trước đó.", [])
        return True
    if choice in {"x", "n"}:
        sessions.update(token, stage="CANCELLED", moment=moment)
        await _edit(query, "Đã hủy thao tác.", [])
        return True

    if prefix == "htp":
        if choice == "o":
            sessions.update(token, stage="AWAITING_DATE", moment=moment)
            await _edit(
                query,
                "Nhập ngày theo DD/MM/YYYY hoặc YYYY-MM-DD. Gõ “hủy” để dừng.",
                [[("Hủy", f"htc:{token}:n")]],
            )
            return True
        days = int(choice)
        base_due = parse_date(session["payload"].get("base_due")) or today_vn(moment)
        due = max(base_due, today_vn(moment)) + timedelta(days=days)
        payload = dict(session["payload"])
        payload["due_date"] = due.strftime("%d/%m/%Y")
        sessions.update(token, stage="CONFIRM", payload=payload, moment=moment)
        await _edit(
            query,
            f"Xác nhận lùi hạn {session['work_id']} đến {payload['due_date']}?",
            _confirm_rows(token),
        )
        return True

    if prefix == "htt":
        if choice == "o":
            sessions.update(token, stage="AWAITING_ASSIGNEE", moment=moment)
            await _edit(
                query,
                "Nhập chính xác tên người có trong danh sách TaskFlow. Gõ “hủy” để dừng.",
                [[("Hủy", f"htc:{token}:n")]],
            )
            return True
        assignees = session["payload"].get("assignees", [])
        if not choice.isdigit() or int(choice) >= len(assignees):
            raise ValueError("Lựa chọn người phụ trách không hợp lệ")
        payload = dict(session["payload"])
        payload["assignee"] = assignees[int(choice)]
        sessions.update(token, stage="CONFIRM", payload=payload, moment=moment)
        await _edit(
            query,
            f"Xác nhận chuyển {session['work_id']} cho {payload['assignee']}?",
            _confirm_rows(token),
        )
        return True

    if prefix == "htk":
        payload = dict(session["payload"])
        if choice == "a":
            payload["continue_subtasks"] = []
            session = sessions.update(
                token, stage="CONFIRM", payload=payload, moment=moment,
            )
            await _edit(
                query,
                _child_selection_text(session) + "\n\nXác nhận đóng toàn bộ?",
                [[("✅ Xác nhận", f"htk:{token}:y"), ("Hủy", f"htk:{token}:n")]],
            )
            return True
        if choice == "s":
            session = sessions.update(
                token, stage="SELECT_CHILDREN", payload=payload, moment=moment,
            )
            await _edit(
                query, _child_selection_text(session), _child_selection_rows(session),
            )
            return True
        if choice.startswith("i") and choice[1:].isdigit():
            children = payload.get("children", [])
            index = int(choice[1:])
            if index >= len(children):
                raise ValueError("Lựa chọn nhiệm vụ con không hợp lệ")
            selected = set(payload.get("continue_subtasks", []))
            child_id = children[index]["id"]
            if child_id in selected:
                selected.remove(child_id)
            else:
                selected.add(child_id)
            payload["continue_subtasks"] = sorted(selected)
            session = sessions.update(
                token, stage="SELECT_CHILDREN", payload=payload, moment=moment,
            )
            await _edit(
                query, _child_selection_text(session), _child_selection_rows(session),
            )
            return True
        if choice == "y":
            if session["stage"] not in {"CONFIRM", "SELECT_CHILDREN"}:
                raise ValueError("Checklist nhiệm vụ con chưa sẵn sàng xác nhận")
            result = process_callback(
                repository, callback_id=f"interaction:{token}", user_id=user_id,
                username=username, chat_id=chat_id, thread_id=thread_id,
                data=f"ht:c:{session['work_id']}",
                arguments={
                    "continue_subtasks": payload.get("continue_subtasks", []),
                },
            )
            sessions.update(token, stage="COMPLETE", result=result, moment=moment)
            await _edit(query, "TaskFlow đã cập nhật và read-back khớp.", [])
            return True

    if prefix == "htc" and choice == "y":
        session = sessions.get(token, moment=moment)
        if session["stage"] != "CONFIRM":
            raise ValueError("Thao tác chưa ở bước xác nhận")
        arguments = {
            key: value for key, value in session["payload"].items()
            if key in {"due_date", "assignee", "continue_subtasks"}
        }
        result = process_callback(
            repository, callback_id=f"interaction:{token}", user_id=user_id,
            username=username, chat_id=chat_id, thread_id=thread_id,
            data=f"ht:{session['action']}:{session['work_id']}",
            arguments=arguments,
        )
        sessions.update(token, stage="COMPLETE", result=result, moment=moment)
        await _edit(
            query,
            "TaskFlow đã cập nhật và read-back khớp."
            if not result["idempotent"] else "Thao tác đã được xử lý trước đó.",
            [],
        )
        return True
    raise ValueError("Callback checklist không hợp lệ")


async def maybe_handle_text_message(
    update: Any,
    context: Any,
    *,
    repo: TaskRepository | None = None,
    store: InteractionStore | None = None,
    moment: datetime | None = None,
) -> bool:
    """Consume only text belonging to a pending checklist interaction."""
    message = update.effective_message
    if not message or not getattr(message, "text", None):
        return False
    user = update.effective_user
    user_id, chat_id = str(user.id), str(message.chat.id)
    try:
        _authorize(user_id, chat_id)
    except PermissionError:
        return False
    sessions = store or InteractionStore()
    session = sessions.pending(user_id=user_id, chat_id=chat_id, moment=moment)
    if not session:
        return False
    text = message.text.strip()
    if text.casefold() in {"hủy", "huy", "/cancel"}:
        sessions.update(session["token"], stage="CANCELLED", moment=moment)
        await message.reply_text("Đã hủy thao tác checklist.")
        return True
    repository = repo or SheetsTaskRepository()
    payload = dict(session["payload"])
    if session["stage"] == "AWAITING_DATE":
        parsed = parse_date(text)
        if parsed is None or parsed <= today_vn(moment):
            await message.reply_text("Ngày phải đúng định dạng và sau ngày hiện tại.")
            return True
        payload["due_date"] = parsed.strftime("%d/%m/%Y")
        prompt = f"Xác nhận lùi hạn {session['work_id']} đến {payload['due_date']}?"
    else:
        valid = repository.read_assignees()
        exact = next((name for name in valid if name.casefold() == text.casefold()), None)
        if exact is None:
            await message.reply_text("Tên không khớp danh sách người phụ trách đang hoạt động.")
            return True
        payload["assignee"] = exact
        prompt = f"Xác nhận chuyển {session['work_id']} cho {exact}?"
    sessions.update(
        session["token"], stage="CONFIRM", payload=payload, moment=moment,
    )
    await message.reply_text(prompt, reply_markup=_markup(_confirm_rows(session["token"])))
    return True
