"""Generate natural Thu Hà Authentic Messenger reply drafts with Hermes Agent.

The processor reads only relevant FAQ/product/policy rows, recent conversation context,
and the native Hermes memory/skill. It writes reviewable drafts to FANPAGE_QUEUE.
Sending to Meta is handled separately and remains disabled until explicitly activated.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import unicodedata
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Sequence

from integrations.hermes.fanpage_draft_processor import (
    match_faq,
    match_product,
    rows_to_dicts,
)

FAST_INDEX_ID = os.getenv(
    "THA_HERMES_FAST_INDEX_ID",
    "1ZACaor_QW1sQX35S-_PpqjcyX02iiSQPImYCHhaUIf0",
)
DRY_RUN = os.getenv("THA_NATURAL_REPLY_DRY_RUN", "true").lower() == "true"
MAX_ITEMS = max(1, min(int(os.getenv("THA_NATURAL_REPLY_MAX_ITEMS", "10")), 50))
HERMES_TIMEOUT = max(20, min(int(os.getenv("THA_HERMES_REPLY_TIMEOUT_SECONDS", "120")), 600))
HERMES_BIN = os.getenv("THA_HERMES_BIN", "hermes")
MEMORY_PATH = Path(os.getenv("THA_MEMORY_PATH", "/opt/data/memories/MEMORY.md"))
USER_PATH = Path(os.getenv("THA_USER_PATH", "/opt/data/memories/USER.md"))
SKILL_PATH = Path(
    os.getenv(
        "THA_COSMETICS_SKILL_PATH",
        "/opt/data/skills/thu-ha-cosmetics/SKILL.md",
    )
)


@dataclass(frozen=True)
class NaturalReplyDecision:
    intent: str
    product_key: str
    reply: str
    confidence: float
    need_human: bool
    status: str = "DRAFT_READY"
    error: str = ""


def normalize_text(value: str) -> str:
    value = unicodedata.normalize("NFD", value or "")
    value = "".join(ch for ch in value if unicodedata.category(ch) != "Mn")
    value = value.replace("đ", "d").replace("Đ", "d").lower()
    value = re.sub(r"[^a-z0-9]+", " ", value)
    return re.sub(r"\s+", " ", value).strip()


def read_text(path: Path, limit: int = 12000) -> str:
    try:
        return path.read_text(encoding="utf-8")[:limit]
    except (FileNotFoundError, OSError, UnicodeError):
        return ""


def compact_dict(row: dict[str, str], allowed: Sequence[str]) -> dict[str, str]:
    return {key: str(row.get(key, "")).strip() for key in allowed if str(row.get(key, "")).strip()}


def token_overlap(query: str, value: str) -> float:
    query_tokens = {t for t in normalize_text(query).split() if len(t) >= 3}
    value_tokens = {t for t in normalize_text(value).split() if len(t) >= 3}
    if not query_tokens or not value_tokens:
        return 0.0
    return len(query_tokens & value_tokens) / len(query_tokens)


def select_policy(message: str, rows: Iterable[dict[str, str]], limit: int = 3) -> list[dict[str, str]]:
    ranked: list[tuple[float, dict[str, str]]] = []
    for row in rows:
        searchable = " ".join(str(value) for value in row.values())
        score = token_overlap(message, searchable)
        if score > 0:
            ranked.append((score, row))
    ranked.sort(key=lambda item: item[0], reverse=True)
    return [row for _, row in ranked[:limit]]


def select_products(message: str, rows: list[dict[str, str]], limit: int = 3) -> list[dict[str, str]]:
    best, _ = match_product(message, rows)
    selected: list[dict[str, str]] = []
    if best:
        selected.append(best)
    ranked = sorted(
        ((token_overlap(message, row.get("product_name", "")), row) for row in rows),
        key=lambda item: item[0],
        reverse=True,
    )
    for score, row in ranked:
        if score <= 0 or row in selected:
            continue
        if str(row.get("status", "")).strip().lower() != "đang bán":
            continue
        selected.append(row)
        if len(selected) >= limit:
            break
    return selected


def recent_context(
    queue_rows: list[dict[str, str]],
    current_index: int,
    customer_id: str,
    limit: int = 6,
) -> list[dict[str, str]]:
    context: list[dict[str, str]] = []
    for row in queue_rows[:current_index]:
        if str(row.get("CUSTOMER_ID", "")) != customer_id:
            continue
        item = compact_dict(row, ("MESSAGE_TEXT", "DRAFT_REPLY", "STATUS", "CREATED_AT"))
        if item:
            context.append(item)
    return context[-limit:]


def requires_human(message: str) -> bool:
    normalized = normalize_text(message)
    triggers = (
        "di ung", "kich ung", "sung", "kho tho", "phong rop", "bong rat",
        "chay dich", "mun viem nang", "mang thai", "cho con bu", "khieu nai",
        "hoan tien", "doi tra", "giam gia rieng", "gap nhan vien", "gap thu ha",
    )
    return any(trigger in normalized for trigger in triggers)


def infer_intent(message: str, has_faq: bool, has_product: bool) -> str:
    normalized = normalize_text(message)
    if has_faq:
        return "FAQ"
    if has_product and any(word in normalized for word in ("gia", "bao nhieu")):
        return "PRODUCT_PRICE"
    if has_product and any(word in normalized for word in ("con hang", "het hang", "ton kho")):
        return "PRODUCT_STOCK"
    if has_product:
        return "PRODUCT_CONSULTATION"
    if any(word in normalized for word in ("da dau", "da kho", "mun", "tham", "lao hoa", "tu van")):
        return "PRODUCT_CONSULTATION"
    return "NATURAL_CONVERSATION"


def build_prompt(
    message: str,
    context: list[dict[str, str]],
    faq: dict[str, str] | None,
    products: list[dict[str, str]],
    policies: list[dict[str, str]],
) -> str:
    grounding = {
        "faq": compact_dict(
            faq or {},
            ("INTENT_ID", "QUESTION", "ANSWER_SHORT", "ANSWER_FULL", "NEED_HUMAN"),
        ),
        "products": [
            compact_dict(
                product,
                (
                    "product_id", "sku", "product_name", "brand", "sale_price",
                    "current_stock", "stock_status", "status", "short_description",
                    "usage", "ingredients", "product_url",
                ),
            )
            for product in products
        ],
        "policies": policies,
    }
    memory = read_text(MEMORY_PATH, 5000)
    user_profile = read_text(USER_PATH, 3000)
    skill_exists = SKILL_PATH.exists()

    return f"""/thu-ha-cosmetics
Bạn đang trả lời một khách hàng trên Fanpage Thu Hà Authentic.
Hãy trả về duy nhất nội dung tin nhắn gửi khách bằng tiếng Việt, tự nhiên và ngắn gọn.
Không xuất JSON, nhãn nội bộ, phân tích hoặc nguồn dữ liệu.

TIN NHẮN HIỆN TẠI:
{message}

NGỮ CẢNH GẦN NHẤT:
{json.dumps(context, ensure_ascii=False, indent=2)}

DỮ LIỆU LIÊN QUAN ĐÃ LỌC:
{json.dumps(grounding, ensure_ascii=False, indent=2)}

BỘ NHỚ CÔ ĐỌNG:
{memory}

HỒ SƠ NGƯỜI TRAINING:
{user_profile}

Skill native đã cài: {skill_exists}.
Chỉ dùng giá/tồn kho/chính sách khi dữ liệu trên có giá trị rõ ràng. Nếu thiếu dữ liệu, hỏi ngắn gọn hoặc nói Thu Hà sẽ kiểm tra thêm. Không nói quá công dụng và không chẩn đoán bệnh.
"""


def call_hermes(prompt: str) -> str:
    completed = subprocess.run(
        [HERMES_BIN, "-z", prompt],
        capture_output=True,
        text=True,
        timeout=HERMES_TIMEOUT,
        check=False,
        env=os.environ.copy(),
    )
    if completed.returncode != 0:
        detail = (completed.stderr or completed.stdout or "unknown error").strip()
        raise RuntimeError(f"Hermes exited {completed.returncode}: {detail[:500]}")
    reply = (completed.stdout or "").strip()
    reply = re.sub(r"^```(?:text|markdown)?\s*|\s*```$", "", reply, flags=re.I | re.S).strip()
    if not reply:
        raise RuntimeError("Hermes returned an empty reply")
    return reply[:1800]


def fallback_reply(message: str, faq: dict[str, str] | None, products: list[dict[str, str]]) -> str:
    if faq:
        answer = str(faq.get("ANSWER_SHORT", "")).strip() or str(faq.get("ANSWER_FULL", "")).strip()
        if answer:
            return answer
    if products:
        product = products[0]
        name = str(product.get("product_name", "sản phẩm này")).strip()
        price = str(product.get("sale_price", "")).strip()
        stock = str(product.get("stock_status", "")).strip()
        details = []
        if price:
            details.append(f"giá {price} đ")
        if stock:
            details.append(f"tình trạng {stock.lower()}")
        suffix = ", ".join(details)
        if suffix:
            return f"Dạ, {name} hiện có {suffix} chị nhé. Chị muốn em tư vấn thêm cách dùng hay tạo đơn nháp ạ?"
    if requires_human(message):
        return "Dạ, trường hợp này em xin chuyển Thu Hà kiểm tra kỹ hơn để tư vấn chị an toàn và chính xác ạ."
    return "Dạ, chị đang quan tâm sản phẩm hoặc vấn đề da nào nhất để em tư vấn sát hơn ạ?"


class SheetsRepository:
    def __init__(self, spreadsheet_id: str) -> None:
        from google.auth import default as google_auth_default
        from googleapiclient.discovery import build

        credentials, _ = google_auth_default(scopes=["https://www.googleapis.com/auth/spreadsheets"])
        self.service = build("sheets", "v4", credentials=credentials, cache_discovery=False)
        self.spreadsheet_id = spreadsheet_id

    def read(self, range_name: str) -> list[list[str]]:
        result = self.service.spreadsheets().values().get(
            spreadsheetId=self.spreadsheet_id,
            range=range_name,
        ).execute()
        return result.get("values", [])

    def update_reply(self, row_number: int, decision: NaturalReplyDecision) -> None:
        self.service.spreadsheets().values().batchUpdate(
            spreadsheetId=self.spreadsheet_id,
            body={
                "valueInputOption": "RAW",
                "data": [
                    {
                        "range": f"FANPAGE_QUEUE!E{row_number}:J{row_number}",
                        "values": [[
                            decision.intent,
                            decision.product_key,
                            decision.reply,
                            f"{decision.confidence:.2f}",
                            "TRUE" if decision.need_human else "FALSE",
                            decision.status,
                        ]],
                    },
                    {
                        "range": f"FANPAGE_QUEUE!M{row_number}",
                        "values": [[decision.error]],
                    },
                ],
            },
        ).execute()


def process_new_messages(repo: SheetsRepository) -> tuple[int, int, int]:
    queue_values = repo.read("FANPAGE_QUEUE!A1:M2000")
    queue_rows = rows_to_dicts(queue_values)
    faq_rows = rows_to_dicts(repo.read("FAQ_COMPACT!A1:G500"))
    product_rows = rows_to_dicts(repo.read("PRODUCTS_HOT!A1:X1000"))
    policy_rows = rows_to_dicts(repo.read("REPLY_POLICY!A1:Z300"))

    eligible = processed = fallbacks = 0
    for index, row in enumerate(queue_rows):
        if str(row.get("STATUS", "")).strip().upper() != "NEW":
            continue
        eligible += 1
        message = str(row.get("MESSAGE_TEXT", "")).strip()
        customer_id = str(row.get("CUSTOMER_ID", "")).strip()
        faq, faq_score = match_faq(message, faq_rows)
        products = select_products(message, product_rows)
        policies = select_policy(message, policy_rows)
        context = recent_context(queue_rows, index, customer_id)
        intent = infer_intent(message, faq is not None, bool(products))
        need_human = requires_human(message) or str((faq or {}).get("NEED_HUMAN", "")).upper() == "TRUE"
        product_key = str(products[0].get("product_id", "")) if products else ""
        confidence = max(0.65, faq_score) if faq else (0.82 if products else 0.68)
        error = ""

        try:
            reply = call_hermes(build_prompt(message, context, faq, products, policies))
        except (RuntimeError, subprocess.TimeoutExpired, OSError) as exc:
            reply = fallback_reply(message, faq, products)
            error = f"HERMES_FALLBACK: {str(exc)[:350]}"
            confidence = min(confidence, 0.55)
            need_human = True
            fallbacks += 1

        decision = NaturalReplyDecision(
            intent=intent,
            product_key=product_key,
            reply=reply,
            confidence=confidence,
            need_human=need_human,
            error=error,
        )
        if not DRY_RUN:
            repo.update_reply(index + 2, decision)
        processed += 1
        if processed >= MAX_ITEMS:
            break
    return eligible, processed, fallbacks


def main() -> int:
    repo = SheetsRepository(FAST_INDEX_ID)
    eligible, processed, fallbacks = process_new_messages(repo)
    print(
        "PASS natural reply processor "
        f"eligible={eligible} processed={processed} fallbacks={fallbacks} dry_run={DRY_RUN}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
