"""Read-only Telegram UAT for the Thu Ha Authentic production advisor.

The command uses the same deterministic product-selection and native Hermes skill
logic as Messenger, but reads products directly from the POS Web App source of
truth. It never writes FANPAGE_QUEUE and never calls Meta APIs.
"""
from __future__ import annotations

import argparse
import json
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Sequence

from integrations.hermes import conversation_runtime_processor as runtime
from integrations.hermes.fanpage_draft_processor import rows_to_dicts
from integrations.hermes.product_catalog import (
    POS_PRODUCTS_RANGE,
    POS_SPREADSHEET_ID,
    ReadOnlyProductCatalog,
)


@dataclass(frozen=True)
class UatResult:
    status: str
    mode: str
    source: str
    source_spreadsheet_id: str
    source_range: str
    source_row_count: int
    intent: str
    product_key: str
    product_name: str
    sale_price: str
    current_stock: str
    stock_status: str
    image_url: str
    reply: str
    need_human: bool
    confidence: float
    send_to_customer: bool = False
    queue_writes: int = 0
    meta_calls: int = 0


def _read_products() -> list[dict[str, str]]:
    values = ReadOnlyProductCatalog().read_product_values()
    rows = rows_to_dicts(values)
    if not rows:
        raise RuntimeError("POS Web App Products returned no product rows")
    return rows


def _clean_context(raw: object) -> list[dict[str, object]]:
    if not isinstance(raw, list):
        return []
    result: list[dict[str, object]] = []
    for item in raw[-12:]:
        if not isinstance(item, dict):
            continue
        result.append(
            {
                "customer": str(item.get("customer", "")).strip(),
                "assistant": str(item.get("assistant", "")).strip(),
                "intent": str(item.get("intent", "")).strip(),
                "product_key": str(item.get("product_key", "")).strip(),
                "reliable": bool(item.get("reliable", True)),
                "created_at": str(item.get("created_at", "")).strip(),
            }
        )
    return result


def advise(
    message: str,
    context: Sequence[dict[str, object]] = (),
    *,
    product_rows: list[dict[str, str]] | None = None,
) -> UatResult:
    message = (message or "").strip()
    if not message:
        raise ValueError("UAT message must not be empty")
    products_all = product_rows if product_rows is not None else _read_products()
    safe_context = _clean_context(list(context))
    request = runtime.infer_forced_request(message, safe_context)
    selected: list[dict[str, str]] = []
    reply = ""
    confidence = 0.86

    if request is None:
        natural_reply, request = runtime.call_conversation(message, safe_context)
        reply = natural_reply.strip()

    if request is not None:
        if request.name == "PRODUCT_FACTS":
            refs = request.product_refs or runtime._active_product_refs(safe_context)
            selected = runtime.resolve_product_refs(refs, products_all)
            if selected:
                reply = runtime.deterministic_fact_fallback(request, selected)
                confidence = 0.94
            else:
                reply = "Dạ em chưa xác định được đúng sản phẩm mình đang nhắc tới ạ."
                confidence = 0.62
        else:
            combined_query = " ".join(
                part
                for part in (
                    request.search_query,
                    runtime._customer_query(message, safe_context),
                )
                if part
            )
            selected = runtime.retrieve_recommendation_candidates(
                combined_query,
                products_all,
                limit=1,
            )
            if selected:
                reply = runtime.fast_product_choice_reply(
                    selected[0],
                    message,
                    safe_context,
                )
                confidence = 0.94
            else:
                reply = runtime.no_matching_product_reply(message, combined_query)
                confidence = 0.72

    if not reply:
        reply = runtime.natural_failure_fallback(message, products_all, safe_context)
        confidence = 0.58

    product = selected[0] if selected else {}
    product_key = str(product.get("product_id", "")).strip()
    if request is not None and request.name == "RECOMMEND_PRODUCTS" and selected and not product_key:
        raise RuntimeError("UAT grounded recommendation has no PRODUCT_KEY")

    return UatResult(
        status="PASS",
        mode="READ_ONLY_TELEGRAM_UAT",
        source="POS_WEBAPP_PRODUCTS_SOURCE_OF_TRUTH",
        source_spreadsheet_id=POS_SPREADSHEET_ID,
        source_range=POS_PRODUCTS_RANGE,
        source_row_count=len(products_all),
        intent=runtime._intent_for_request(request),
        product_key=product_key,
        product_name=str(product.get("product_name", "")).strip(),
        sale_price=runtime.display_price(product.get("sale_price", "")),
        current_stock=str(product.get("current_stock", "")).strip(),
        stock_status=str(product.get("stock_status", "")).strip(),
        image_url=str(product.get("image_url", "")).strip(),
        reply=reply[:1800],
        need_human=runtime.requires_human(message),
        confidence=confidence,
    )


def format_text(result: UatResult) -> str:
    lines = [
        result.reply,
        "",
        "🧪 UAT nội bộ — không gửi khách",
        f"PRODUCT_KEY={result.product_key or 'NONE'}",
        f"SOURCE={result.source}",
        f"SOURCE_RANGE={result.source_range}",
        f"INTENT={result.intent}",
        f"STOCK={result.current_stock or 'UNKNOWN'} | {result.stock_status or 'UNKNOWN'}",
        "SEND_TO_CUSTOMER=FALSE",
        "QUEUE_WRITES=0",
        "META_CALLS=0",
    ]
    if result.image_url:
        lines.append(f"IMAGE={result.image_url}")
    return "\n".join(lines)


def _read_message(args: argparse.Namespace) -> str:
    if args.message_file:
        return Path(args.message_file).read_text(encoding="utf-8").strip()
    return (args.message or "").strip()


def _read_context(args: argparse.Namespace) -> list[dict[str, object]]:
    raw = ""
    if args.context_file:
        raw = Path(args.context_file).read_text(encoding="utf-8")
    elif args.context_json:
        raw = args.context_json
    if not raw.strip():
        return []
    return _clean_context(json.loads(raw))


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Read-only Thu Ha Telegram UAT")
    parser.add_argument("--message", default="")
    parser.add_argument("--message-file", default="")
    parser.add_argument("--context-json", default="")
    parser.add_argument("--context-file", default="")
    parser.add_argument("--format", choices=("json", "text"), default="text")
    return parser


def main() -> int:
    args = build_parser().parse_args()
    result = advise(_read_message(args), _read_context(args))
    if args.format == "json":
        print(json.dumps(asdict(result), ensure_ascii=False, indent=2))
    else:
        print(format_text(result))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
