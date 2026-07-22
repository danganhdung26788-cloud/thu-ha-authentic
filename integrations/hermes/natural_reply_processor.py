"""Generate natural Thu Hà Authentic Messenger replies with Hermes Agent.

The processor reads only relevant FAQ/product/policy rows, recent conversation
context and the native Hermes memory/skill. Simple follow-up questions about the
active product are answered deterministically from current Sheets data to reduce
latency. Complex messages are delegated to Hermes.
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
).strip()
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
    return {
        key: str(row.get(key, "")).strip()
        for key in allowed
        if str(row.get(key, "")).strip()
    }


def token_overlap(query: str, value: str) -> float:
    query_tokens = {t for t in normalize_text(query).split() if len(t) >= 3}
    value_tokens = {t for t in normalize_text(value).split() if len(t) >= 3}
    if not query_tokens or not value_tokens:
        return 0.0
    return len(query_tokens & value_tokens) / len(query_tokens)


def select_policy(
    message: str,
    rows: Iterable[dict[str, str]],
    limit: int = 3,
) -> list[dict[str, str]]:
    ranked: list[tuple[float, dict[str, str]]] = []
    for row in rows:
        searchable = " ".join(str(value) for value in row.values())
        score = token_overlap(message, searchable)
        if score > 0:
            ranked.append((score, row))
    ranked.sort(key=lambda item: item[0], reverse=True)
    return [row for _, row in ranked[:limit]]


def recent_context(
    queue_rows: list[dict[str, str]],
    current_index: int,
    customer_id: str,
    limit: int = 8,
) -> list[dict[str, str]]:
    """Return recent turns for one customer, including product continuity fields."""
    context: list[dict[str, str]] = []
    for row in queue_rows[:current_index]:
        if str(row.get("CUSTOMER_ID", "")).strip() != customer_id:
            continue
        item = compact_dict(
            row,
            (
                "MESSAGE_ID",
                "MESSAGE_TEXT",
                "INTENT",
                "PRODUCT_KEY",
                "DRAFT_REPLY",
                "STATUS",
                "CREATED_AT",
            ),
        )
        if item:
            context.append(item)
    return context[-limit:]


def is_context_followup(message: str) -> bool:
    normalized = normalize_text(message)
    phrases = (
        "gia",
        "bao nhieu",
        "nhieu tien",
        "con hang",
        "het hang",
        "ton kho",
        "cach dung",
        "dung nhu nao",
        "dung the nao",
        "loai nay",
        "san pham nay",
        "cai nay",
        "em vua noi",
        "vay e",
        "vay em",
        "the con",
    )
    if any(phrase in normalized for phrase in phrases):
        return True
    tokens = normalized.split()
    return len(tokens) <= 7 and any(word in tokens for word in ("nay", "do", "no", "vay"))


def product_is_available_for_advice(product: dict[str, str]) -> bool:
    status = str(product.get("status", "")).strip().lower()
    visible = str(product.get("public_visible", "")).strip().upper()
    return status == "đang bán" and visible in ("", "TRUE")


def resolve_context_product(
    context: list[dict[str, str]],
    product_rows: list[dict[str, str]],
) -> dict[str, str] | None:
    """Resolve the latest product by key, then by the previous turn text."""
    by_key: dict[str, dict[str, str]] = {}
    for product in product_rows:
        if not product_is_available_for_advice(product):
            continue
        for key_name in ("product_id", "sku", "barcode_value"):
            key = str(product.get(key_name, "")).strip()
            if key:
                by_key[key.casefold()] = product

    for item in reversed(context):
        product_key = str(item.get("PRODUCT_KEY", "")).strip()
        if product_key:
            product = by_key.get(product_key.casefold())
            if product:
                return product

    for item in reversed(context):
        prior_text = " ".join(
            (
                str(item.get("MESSAGE_TEXT", "")),
                str(item.get("DRAFT_REPLY", "")),
            )
        ).strip()
        if not prior_text:
            continue
        product, _ = match_product(prior_text, product_rows)
        if product and product_is_available_for_advice(product):
            return product
    return None


def select_products(
    message: str,
    rows: list[dict[str, str]],
    context: list[dict[str, str]] | None = None,
    limit: int = 3,
) -> list[dict[str, str]]:
    best, _ = match_product(message, rows)
    selected: list[dict[str, str]] = []
    if best:
        selected.append(best)
    elif context and is_context_followup(message):
        context_product = resolve_context_product(context, rows)
        if context_product:
            selected.append(context_product)

    ranked = sorted(
        ((token_overlap(message, row.get("product_name", "")), row) for row in rows),
        key=lambda item: item[0],
        reverse=True,
    )
    for score, row in ranked:
        if score <= 0 or row in selected:
            continue
        if not product_is_available_for_advice(row):
            continue
        selected.append(row)
        if len(selected) >= limit:
            break
    return selected


def display_price(value: str) -> str:
    raw = str(value or "").strip()
    digits = re.sub(r"\D", "", raw)
    if digits:
        try:
            return f"{int(digits):,}".replace(",", ".") + " đ"
        except ValueError:
            pass
    return f"{raw} đ" if raw else ""


def quick_product_reply(
    message: str,
    product: dict[str, str] | None,
) -> tuple[str, str] | None:
    """Answer simple follow-ups from current product data without a model call."""
    if not product:
        return None
    normalized = normalize_text(message)
    name = str(product.get("product_name", "sản phẩm này")).strip()
    price = display_price(product.get("sale_price", ""))
    stock = str(product.get("stock_status", "")).strip()
    current_stock = str(product.get("current_stock", "")).strip()
    usage = str(product.get("usage", "")).strip()

    if any(phrase in normalized for phrase in ("gia", "bao nhieu", "nhieu tien")):
        if price:
            return "PRODUCT_PRICE", f"Dạ, {name} hiện có giá {price} chị nhé."
        return (
            "PRODUCT_PRICE",
            f"Dạ, giá của {name} chưa được cập nhật rõ trên hệ thống; em chuyển Thu Hà kiểm tra ngay cho chị nhé.",
        )

    if any(phrase in normalized for phrase in ("con hang", "het hang", "ton kho")):
        if stock:
            detail = stock.lower()
            if current_stock.isdigit() and int(current_stock) > 0:
                detail += f" ({current_stock} sản phẩm)"
            return "PRODUCT_STOCK", f"Dạ, {name} hiện {detail} chị nhé."
        return (
            "PRODUCT_STOCK",
            f"Dạ, em chưa thấy trạng thái kho rõ của {name}; em chuyển Thu Hà kiểm tra ngay cho chị nhé.",
        )

    if any(phrase in normalized for phrase in ("cach dung", "dung nhu nao", "dung the nao")):
        if usage:
            return "BASIC_USAGE", f"Dạ, {name}: {usage}"
        return (
            "BASIC_USAGE",
            f"Dạ, em cần Thu Hà kiểm tra hướng dẫn chuẩn của {name} trước khi trả lời chị nhé.",
        )
    return None


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
    if has_product and any(word in normalized for word in ("gia", "bao nhieu", "nhieu tien")):
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
    product_fields = (
        "product_id", "sku", "product_name", "brand", "sale_price",
        "current_stock", "stock_status", "status", "short_description",
        "usage", "ingredients", "product_url",
    )
    grounding = {
        "faq": compact_dict(
            faq or {},
            ("INTENT_ID", "QUESTION", "ANSWER_SHORT", "ANSWER_FULL", "NEED_HUMAN"),
        ),
        "active_product": compact_dict(products[0] if products else {}, product_fields),
        "products": [compact_dict(product, product_fields) for product in products],
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
Hãy nối tiếp đúng mạch hội thoại. Các cách nói “loại này”, “sản phẩm này”, “nó”,
hoặc câu hỏi ngắn như “giá bao nhiêu” phải hiểu là active_product gần nhất khi
active_product đã có. Không hỏi lại tên sản phẩm đã xác định trong ngữ cảnh.
Chỉ dùng giá/tồn kho/chính sách khi dữ liệu trên có giá trị rõ ràng. Nếu thiếu
dữ liệu, hỏi ngắn gọn hoặc nói Thu Hà sẽ kiểm tra thêm. Không nói quá công dụng
và không chẩn đoán bệnh.
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
        price = display_price(product.get("sale_price", ""))
        stock = str(product.get("stock_status", "")).strip()
        details = []
        if price:
            details.append(f"giá {price}")
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

    def update_status(self, row_number: int, status: str, error: str = "") -> None:
        self.service.spreadsheets().values().batchUpdate(
            spreadsheetId=self.spreadsheet_id,
            body={
                "valueInputOption": "RAW",
                "data": [
                    {"range": f"FANPAGE_QUEUE!J{row_number}", "values": [[status]]},
                    {"range": f"FANPAGE_QUEUE!M{row_number}", "values": [[error[:500]]]},
                ],
            },
        ).execute()

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
                    {"range": f"FANPAGE_QUEUE!M{row_number}", "values": [[decision.error]]},
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
        row_number = index + 2
        if not DRY_RUN:
            repo.update_status(row_number, "PROCESSING")

        try:
            message = str(row.get("MESSAGE_TEXT", "")).strip()
            customer_id = str(row.get("CUSTOMER_ID", "")).strip()
            context = recent_context(queue_rows, index, customer_id)
            faq, faq_score = match_faq(message, faq_rows)
            products = select_products(message, product_rows, context=context)
            policies = select_policy(message, policy_rows)
            quick = quick_product_reply(message, products[0] if products else None)
            intent = infer_intent(message, faq is not None, bool(products))
            need_human = requires_human(message) or str((faq or {}).get("NEED_HUMAN", "")).upper() == "TRUE"
            product_key = str(products[0].get("product_id", "")) if products else ""
            confidence = max(0.65, faq_score) if faq else (0.90 if quick else (0.82 if products else 0.68))
            error = ""

            if quick:
                intent, reply = quick
            else:
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
                repo.update_reply(row_number, decision)
            processed += 1
        except Exception as exc:
            if not DRY_RUN:
                repo.update_status(row_number, "NEW", f"REALTIME_RETRY: {str(exc)[:350]}")
            raise

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
