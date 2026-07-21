"""Create reviewable Facebook Messenger reply drafts for Thu Hà Authentic.

This processor never sends a message to Meta. It only updates FANPAGE_QUEUE
from NEW to DRAFT_READY after applying deterministic FAQ/product rules.
"""
from __future__ import annotations

import os
import re
import unicodedata
from dataclasses import dataclass
from difflib import SequenceMatcher
from typing import Iterable


FAST_INDEX_ID = os.getenv(
    "THA_HERMES_FAST_INDEX_ID",
    "1ZACaor_QW1sQX35S-_PpqjcyX02iiSQPImYCHhaUIf0",
)
DRY_RUN = os.getenv("THA_FANPAGE_DRAFT_DRY_RUN", "true").lower() == "true"
MAX_ITEMS = max(1, min(int(os.getenv("THA_FANPAGE_DRAFT_MAX_ITEMS", "20")), 100))


@dataclass(frozen=True)
class DraftDecision:
    intent: str
    product_key: str
    draft_reply: str
    confidence: float
    need_human: bool
    status: str = "DRAFT_READY"


def normalize_text(value: str) -> str:
    value = unicodedata.normalize("NFD", value or "")
    value = "".join(ch for ch in value if unicodedata.category(ch) != "Mn")
    value = value.replace("đ", "d").replace("Đ", "d")
    value = value.lower()
    value = re.sub(r"[^a-z0-9]+", " ", value)
    return re.sub(r"\s+", " ", value).strip()


def split_triggers(value: str) -> list[str]:
    return [normalize_text(item) for item in (value or "").split("|") if normalize_text(item)]


def match_faq(
    message_text: str, faq_rows: Iterable[dict[str, str]]
) -> tuple[dict[str, str] | None, float]:
    normalized = normalize_text(message_text)
    best = None
    best_score = 0.0
    for row in faq_rows:
        if str(row.get("ACTIVE", "")).upper() != "TRUE":
            continue
        for trigger in split_triggers(row.get("TRIGGERS", "")):
            if trigger and trigger in normalized:
                score = min(0.98, 0.82 + min(len(trigger), 32) / 200)
                if score > best_score:
                    best = row
                    best_score = score
    return best, best_score


def meaningful_tokens(value: str) -> set[str]:
    stop = {
        "co", "con", "hang", "khong", "gia", "bao", "nhieu", "shop", "san",
        "pham", "nay", "cho", "minh", "chi", "em", "anh", "la", "va", "loai",
    }
    return {t for t in normalize_text(value).split() if len(t) >= 3 and t not in stop}


def score_product(message_text: str, product: dict[str, str]) -> float:
    normalized = normalize_text(message_text)
    identifiers = [
        normalize_text(product.get("product_id", "")),
        normalize_text(product.get("sku", "")),
        normalize_text(product.get("barcode_value", "")),
    ]
    if any(identifier and identifier in normalized for identifier in identifiers):
        return 1.0

    message_tokens = meaningful_tokens(message_text)
    product_name = product.get("product_name", "")
    product_tokens = meaningful_tokens(product_name)
    if not message_tokens or not product_tokens:
        return 0.0
    overlap = len(message_tokens & product_tokens) / max(1, len(message_tokens))
    sequence = SequenceMatcher(
        None, normalize_text(message_text), normalize_text(product_name)
    ).ratio()
    return round(max(overlap, sequence * 0.75), 4)


def match_product(
    message_text: str, products: Iterable[dict[str, str]]
) -> tuple[dict[str, str] | None, float]:
    best = None
    best_score = 0.0
    for product in products:
        if str(product.get("status", "")).strip().lower() != "đang bán":
            continue
        if str(product.get("public_visible", "")).upper() != "TRUE":
            continue
        score = score_product(message_text, product)
        if score > best_score:
            best = product
            best_score = score
    if best_score < 0.45:
        return None, best_score
    return best, best_score


def parse_bool(value: str) -> bool:
    return str(value or "").strip().upper() == "TRUE"


def format_price(value: str) -> str:
    value = str(value or "").strip()
    return f"{value} đ" if value else "chưa cập nhật"


def decide_draft(
    message_text: str,
    faq_rows: Iterable[dict[str, str]],
    products: Iterable[dict[str, str]],
) -> DraftDecision:
    faq, faq_score = match_faq(message_text, faq_rows)
    product, product_score = match_product(message_text, products)

    if product is not None:
        stock = str(product.get("current_stock", "")).strip()
        stock_status = str(product.get("stock_status", "")).strip()
        product_name = str(product.get("product_name", "")).strip()
        sale_price = format_price(product.get("sale_price", ""))
        if stock_status.lower() == "hết hàng" or stock == "0":
            reply = (
                f"{product_name} hiện đang hết hàng theo tồn kho của shop. "
                "Thu Hà sẽ kiểm tra thời điểm có hàng lại và phản hồi thêm cho chị."
            )
            return DraftDecision(
                intent="PRODUCT_STOCK",
                product_key=product.get("product_id", ""),
                draft_reply=reply,
                confidence=max(0.78, product_score),
                need_human=True,
            )
        reply = (
            f"{product_name} hiện có giá {sale_price}, "
            f"tình trạng kho: {stock_status or 'còn hàng'}. "
            "Chị xác nhận giúp shop số lượng cần mua để Thu Hà kiểm tra và tạo đơn nháp."
        )
        return DraftDecision(
            intent="PRODUCT_LOOKUP",
            product_key=product.get("product_id", ""),
            draft_reply=reply,
            confidence=max(0.76, product_score),
            need_human=False,
        )

    if faq is not None:
        return DraftDecision(
            intent=faq.get("INTENT_ID", "FAQ"),
            product_key="",
            draft_reply=faq.get("ANSWER_SHORT", "").strip(),
            confidence=faq_score,
            need_human=parse_bool(faq.get("NEED_HUMAN", "")),
        )

    return DraftDecision(
        intent="UNCLASSIFIED",
        product_key="",
        draft_reply=(
            "Shop đã nhận được tin nhắn của chị. "
            "Nội dung hiện chưa đủ dữ liệu để trả lời chính xác; "
            "Thu Hà sẽ kiểm tra và phản hồi thêm."
        ),
        confidence=0.30,
        need_human=True,
    )


def rows_to_dicts(values: list[list[str]]) -> list[dict[str, str]]:
    if not values:
        return []
    headers = values[0]
    return [
        {
            headers[index]: row[index] if index < len(row) else ""
            for index in range(len(headers))
        }
        for row in values[1:]
    ]


class SheetsRepository:
    def __init__(self, spreadsheet_id: str) -> None:
        from google.auth import default as google_auth_default
        from googleapiclient.discovery import build

        credentials, _ = google_auth_default(
            scopes=["https://www.googleapis.com/auth/spreadsheets"]
        )
        self.service = build(
            "sheets", "v4", credentials=credentials, cache_discovery=False
        )
        self.spreadsheet_id = spreadsheet_id

    def read(self, range_name: str) -> list[list[str]]:
        result = self.service.spreadsheets().values().get(
            spreadsheetId=self.spreadsheet_id,
            range=range_name,
        ).execute()
        return result.get("values", [])

    def update_draft(self, row_number: int, decision: DraftDecision) -> None:
        self.service.spreadsheets().values().update(
            spreadsheetId=self.spreadsheet_id,
            range=f"FANPAGE_QUEUE!E{row_number}:J{row_number}",
            valueInputOption="RAW",
            body={"values": [[
                decision.intent,
                decision.product_key,
                decision.draft_reply,
                f"{decision.confidence:.2f}",
                "TRUE" if decision.need_human else "FALSE",
                decision.status,
            ]]},
        ).execute()


def process_new_messages(repo: SheetsRepository) -> tuple[int, int]:
    queue_values = repo.read("FANPAGE_QUEUE!A1:M2000")
    faq_rows = rows_to_dicts(repo.read("FAQ_COMPACT!A1:G500"))
    products = rows_to_dicts(repo.read("PRODUCTS_HOT!A1:X1000"))

    processed = 0
    eligible = 0
    for row_number, row in enumerate(rows_to_dicts(queue_values), start=2):
        if row.get("STATUS", "").strip().upper() != "NEW":
            continue
        eligible += 1
        decision = decide_draft(row.get("MESSAGE_TEXT", ""), faq_rows, products)
        if not DRY_RUN:
            repo.update_draft(row_number, decision)
        processed += 1
        if processed >= MAX_ITEMS:
            break
    return eligible, processed


def main() -> int:
    repo = SheetsRepository(FAST_INDEX_ID)
    eligible, processed = process_new_messages(repo)
    print(
        f"PASS fanpage draft processor eligible={eligible} "
        f"processed={processed} dry_run={DRY_RUN}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
