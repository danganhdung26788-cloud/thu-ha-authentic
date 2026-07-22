"""Deterministic context guard for Thu Hà Authentic Messenger.

This processor runs before the natural Hermes processor. It handles only:
- follow-up questions that refer to products already mentioned in the same customer thread;
- customer corrections/disputes after a wrong or misunderstood answer.

It never searches the whole catalog from generic words such as "sản phẩm này".
If context cannot be resolved safely, it asks for human review instead of guessing.
"""
from __future__ import annotations

import os
import re
from typing import Iterable

from integrations.hermes.fanpage_draft_processor import rows_to_dicts
from integrations.hermes.natural_reply_processor import (
    FAST_INDEX_ID,
    NaturalReplyDecision,
    SheetsRepository,
    display_price,
    normalize_text,
    product_is_available_for_advice,
)

DRY_RUN = os.getenv("THA_CONTEXT_GUARD_DRY_RUN", "true").lower() == "true"
MAX_ITEMS = max(1, min(int(os.getenv("THA_CONTEXT_GUARD_MAX_ITEMS", "20")), 50))

GENERIC_PRODUCT_WORDS = {
    "san", "pham", "loai", "cai", "nay", "do", "em", "shop", "chi",
    "dung", "dich", "kem", "sua", "nuoc", "gel", "serum", "lotion",
    "chong", "nang", "duong", "da", "va", "cho", "ml", "sp", "hang",
    "chinh", "hang", "moi", "vua", "gioi", "thieu", "tren", "noi",
}


def is_context_followup(message: str) -> bool:
    normalized = normalize_text(message)
    phrases = (
        "gia", "bao nhieu", "nhieu tien", "con hang", "het hang", "ton kho",
        "cach dung", "dung nhu nao", "dung the nao", "loai nay", "san pham nay",
        "cai nay", "em vua noi", "em vua gioi thieu", "san pham em vua gioi thieu",
        "o tren", "truoc do", "dang noi ve", "vay e", "vay em", "the con",
    )
    if any(phrase in normalized for phrase in phrases):
        return True
    tokens = normalized.split()
    return len(tokens) <= 9 and any(word in tokens for word in ("nay", "do", "no", "vay"))


def is_correction_or_dispute(message: str) -> bool:
    normalized = normalize_text(message)
    phrases = (
        "tra loi sai", "sai roi", "khong dung", "tra loi khong dung",
        "em dang noi ve cai nay", "truoc do em tu van", "truoc do e tu van",
        "truoc do em dang tu van", "em tu van sai", "noi sai", "nham san pham",
        "khong phai san pham nay", "em co nho khong", "dang noi ve cai gi",
    )
    return any(phrase in normalized for phrase in phrases)


def correction_handoff_reply(message: str) -> str | None:
    if not is_correction_or_dispute(message):
        return None
    return (
        "Dạ em xin lỗi, em đã hiểu sai mạch hội thoại và không nên tiếp tục đoán sản phẩm. "
        "Em tạm dừng trả lời tự động ở cuộc trò chuyện này và chuyển Thu Hà kiểm tra lại ngay ạ."
    )


def _split_product_keys(value: str) -> list[str]:
    return [part.strip() for part in re.split(r"[,;|\s]+", value or "") if part.strip()]


def _product_index(product_rows: Iterable[dict[str, str]]) -> dict[str, dict[str, str]]:
    by_key: dict[str, dict[str, str]] = {}
    for product in product_rows:
        if not product_is_available_for_advice(product):
            continue
        for field in ("product_id", "sku", "barcode_value"):
            key = str(product.get(field, "")).strip()
            if key:
                by_key[key.casefold()] = product
    return by_key


def _distinctive_tokens(value: str) -> set[str]:
    return {
        token
        for token in normalize_text(value).split()
        if len(token) >= 3 and token not in GENERIC_PRODUCT_WORDS
    }


def explicit_product_mentions(
    text: str,
    product_rows: list[dict[str, str]],
    limit: int = 3,
) -> list[dict[str, str]]:
    """Find products explicitly named in prior assistant text, conservatively."""
    normalized = normalize_text(text)
    text_tokens = _distinctive_tokens(text)
    ranked: list[tuple[float, dict[str, str]]] = []
    for product in product_rows:
        if not product_is_available_for_advice(product):
            continue
        identifiers = [
            str(product.get("product_id", "")).strip(),
            str(product.get("sku", "")).strip(),
            str(product.get("barcode_value", "")).strip(),
        ]
        if any(identifier and identifier.casefold() in text.casefold() for identifier in identifiers):
            ranked.append((10.0, product))
            continue
        name = str(product.get("product_name", "")).strip()
        name_normalized = normalize_text(name)
        if name_normalized and name_normalized in normalized:
            ranked.append((9.0, product))
            continue
        name_tokens = _distinctive_tokens(name)
        shared = text_tokens & name_tokens
        if len(shared) < 3:
            continue
        coverage = len(shared) / max(1, len(name_tokens))
        if coverage < 0.38:
            continue
        ranked.append((coverage + len(shared) / 100.0, product))

    ranked.sort(key=lambda item: item[0], reverse=True)
    selected: list[dict[str, str]] = []
    seen: set[str] = set()
    for _, product in ranked:
        key = str(product.get("product_id", "")).strip()
        if not key or key in seen:
            continue
        seen.add(key)
        selected.append(product)
        if len(selected) >= limit:
            break
    return selected


def _row_is_trusted_context(row: dict[str, str]) -> bool:
    if str(row.get("NEED_HUMAN", "")).strip().upper() == "TRUE":
        return False
    try:
        confidence = float(str(row.get("CONFIDENCE", "0")).strip() or "0")
    except ValueError:
        confidence = 0.0
    if confidence and confidence < 0.65:
        return False
    if is_correction_or_dispute(str(row.get("MESSAGE_TEXT", ""))):
        return False
    return True


def resolve_context_products(
    context: list[dict[str, str]],
    product_rows: list[dict[str, str]],
    limit: int = 3,
) -> list[dict[str, str]]:
    """Resolve products from the latest trusted recommendation turn only."""
    by_key = _product_index(product_rows)
    anchor: dict[str, str] | None = None
    for row in reversed(context):
        if not _row_is_trusted_context(row):
            continue
        keys = _split_product_keys(str(row.get("PRODUCT_KEY", "")))
        mentions = explicit_product_mentions(
            " ".join((str(row.get("MESSAGE_TEXT", "")), str(row.get("DRAFT_REPLY", "")))),
            product_rows,
            limit=limit,
        )
        if keys or mentions:
            anchor = row
            break
    if not anchor:
        return []

    selected: list[dict[str, str]] = []
    seen: set[str] = set()
    for key in _split_product_keys(str(anchor.get("PRODUCT_KEY", ""))):
        product = by_key.get(key.casefold())
        product_id = str((product or {}).get("product_id", "")).strip()
        if product and product_id and product_id not in seen:
            seen.add(product_id)
            selected.append(product)

    anchor_text = " ".join(
        (str(anchor.get("MESSAGE_TEXT", "")), str(anchor.get("DRAFT_REPLY", "")))
    )
    for product in explicit_product_mentions(anchor_text, product_rows, limit=limit):
        product_id = str(product.get("product_id", "")).strip()
        if product_id and product_id not in seen:
            seen.add(product_id)
            selected.append(product)
        if len(selected) >= limit:
            break
    return selected[:limit]


def _followup_kind(message: str, context: list[dict[str, str]]) -> str:
    normalized = normalize_text(message)
    if any(phrase in normalized for phrase in ("gia", "bao nhieu", "nhieu tien")):
        return "PRICE"
    if any(phrase in normalized for phrase in ("con hang", "het hang", "ton kho")):
        return "STOCK"
    if any(phrase in normalized for phrase in ("cach dung", "dung nhu nao", "dung the nao")):
        return "USAGE"
    if context:
        previous = normalize_text(str(context[-1].get("MESSAGE_TEXT", "")))
        if any(phrase in previous for phrase in ("gia", "bao nhieu", "nhieu tien")):
            return "PRICE"
        if any(phrase in previous for phrase in ("con hang", "het hang", "ton kho")):
            return "STOCK"
        if any(phrase in previous for phrase in ("cach dung", "dung nhu nao", "dung the nao")):
            return "USAGE"
    return "REFERENCE"


def quick_products_reply(
    message: str,
    products: list[dict[str, str]],
    context: list[dict[str, str]] | None = None,
) -> tuple[str, str] | None:
    if not products:
        return None
    kind = _followup_kind(message, context or [])
    if kind == "PRICE":
        lines = []
        for product in products:
            name = str(product.get("product_name", "sản phẩm")).strip()
            price = display_price(product.get("sale_price", ""))
            lines.append(f"• {name}: {price or 'chưa có giá rõ trên hệ thống'}")
        return "PRODUCT_PRICE", "Dạ, giá các sản phẩm em vừa gợi ý là:\n" + "\n".join(lines)
    if kind == "STOCK":
        lines = []
        for product in products:
            name = str(product.get("product_name", "sản phẩm")).strip()
            stock = str(product.get("stock_status", "")).strip() or "chưa rõ tồn kho"
            lines.append(f"• {name}: {stock}")
        return "PRODUCT_STOCK", "Dạ, tình trạng kho hiện tại là:\n" + "\n".join(lines)
    if kind == "USAGE":
        if len(products) != 1:
            names = ", ".join(str(item.get("product_name", "")).strip() for item in products)
            return "BASIC_USAGE", f"Dạ, trước đó em có nhắc {names}. Chị muốn hỏi cách dùng sản phẩm nào ạ?"
        product = products[0]
        name = str(product.get("product_name", "sản phẩm")).strip()
        usage = str(product.get("usage", "")).strip() or str(product.get("main_usage", "")).strip()
        if usage:
            return "BASIC_USAGE", f"Dạ, {name}: {usage}"
        return "BASIC_USAGE", f"Dạ, em chuyển Thu Hà kiểm tra cách dùng chuẩn của {name} trước khi trả lời chị nhé."
    names = "\n".join(
        f"• {str(product.get('product_name', '')).strip()}" for product in products
    )
    return (
        "CONTEXT_REFERENCE",
        "Dạ, trước đó em vừa gợi ý các sản phẩm sau:\n"
        + names
        + "\nChị muốn hỏi giá, tồn kho hay cách dùng của sản phẩm nào ạ?",
    )


def _recent_customer_rows(
    queue_rows: list[dict[str, str]],
    current_index: int,
    customer_id: str,
    limit: int = 10,
) -> list[dict[str, str]]:
    rows = [
        row
        for row in queue_rows[:current_index]
        if str(row.get("CUSTOMER_ID", "")).strip() == customer_id
    ]
    return rows[-limit:]


def process_new_messages(repo: SheetsRepository) -> tuple[int, int]:
    queue_rows = rows_to_dicts(repo.read("FANPAGE_QUEUE!A1:M2000"))
    product_rows = rows_to_dicts(repo.read("PRODUCTS_HOT!A1:X1000"))
    eligible = processed = 0

    for index, row in enumerate(queue_rows):
        if str(row.get("STATUS", "")).strip().upper() != "NEW":
            continue
        message = str(row.get("MESSAGE_TEXT", "")).strip()
        correction_reply = correction_handoff_reply(message)
        followup = is_context_followup(message)
        if not correction_reply and not followup:
            continue
        eligible += 1
        customer_id = str(row.get("CUSTOMER_ID", "")).strip()
        context = _recent_customer_rows(queue_rows, index, customer_id)

        if correction_reply:
            decision = NaturalReplyDecision(
                intent="HUMAN_HANDOFF",
                product_key="",
                reply=correction_reply,
                confidence=1.0,
                need_human=True,
            )
        else:
            products = resolve_context_products(context, product_rows)
            quick = quick_products_reply(message, products, context=context)
            if quick:
                intent, reply = quick
                decision = NaturalReplyDecision(
                    intent=intent,
                    product_key=",".join(
                        str(product.get("product_id", "")).strip() for product in products
                    ),
                    reply=reply,
                    confidence=0.98,
                    need_human=False,
                )
            else:
                decision = NaturalReplyDecision(
                    intent="CONTEXT_UNRESOLVED",
                    product_key="",
                    reply=(
                        "Dạ em chưa xác định chắc sản phẩm chị đang nhắc tới nên em không đoán. "
                        "Em chuyển Thu Hà xem lại mạch hội thoại và báo chị ngay ạ."
                    ),
                    confidence=0.0,
                    need_human=True,
                )

        if not DRY_RUN:
            repo.update_reply(index + 2, decision)
        processed += 1
        if processed >= MAX_ITEMS:
            break
    return eligible, processed


def main() -> int:
    repo = SheetsRepository(FAST_INDEX_ID)
    eligible, processed = process_new_messages(repo)
    print(
        "PASS safe context processor "
        f"eligible={eligible} processed={processed} dry_run={DRY_RUN}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
