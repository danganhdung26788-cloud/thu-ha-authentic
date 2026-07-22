"""Conversation-native Messenger processor for Thu Ha Authentic.

Hermes replies naturally first. It may append one hidden THA_TOOL marker only when
verified product facts or recommendation candidates are required. Ordinary chat,
clarifications, and greetings never pass through an action router or confidence gate.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
from dataclasses import dataclass
from typing import Iterable, Sequence

from integrations.hermes.fanpage_draft_processor import rows_to_dicts
from integrations.hermes.natural_reply_processor import (
    FAST_INDEX_ID,
    MEMORY_PATH,
    SKILL_PATH,
    USER_PATH,
    NaturalReplyDecision,
    SheetsRepository,
    call_hermes,
    compact_dict,
    display_price,
    normalize_text,
    product_is_available_for_advice,
    read_text,
    requires_human,
)

DRY_RUN = os.getenv("THA_AI_FIRST_DRY_RUN", "true").lower() == "true"
MAX_ITEMS = max(1, min(int(os.getenv("THA_AI_FIRST_MAX_ITEMS", "10")), 50))
MAX_CONTEXT_TURNS = max(4, min(int(os.getenv("THA_AI_FIRST_CONTEXT_TURNS", "12")), 24))

_TOOL_MARKER_RE = re.compile(r"\[\[THA_TOOL:(\{.*?\})\]\]\s*$", re.S)
_GENERIC_REFERENCE_TOKENS = {
    "san", "pham", "loai", "cai", "nay", "do", "no", "em", "shop", "chi",
    "gia", "cach", "dung", "con", "hang", "kiem", "dau", "ngua", "mun",
    "kem", "sua", "nuoc", "gel", "serum", "lotion", "chong", "nang", "da",
    "va", "cho", "ml", "sp", "vua", "noi", "gioi", "thieu", "tren", "lai",
}
_SEARCH_STOPWORDS = {
    "tu", "van", "giup", "minh", "kha", "hay", "bi", "nen", "uu", "tien",
    "phu", "hop", "can", "muon", "hoi", "nhe", "nhi", "voi", "mot", "chut",
    "san", "pham", "loai", "cai", "nay", "do", "no", "em", "shop", "chi",
    "gia", "cach", "dung", "con", "hang", "kem", "sua", "nuoc", "gel",
    "serum", "lotion", "va", "cho", "ml", "sp", "vua", "noi", "gioi",
    "thieu", "tren", "lai",
}


@dataclass(frozen=True)
class ToolRequest:
    name: str
    lookup_type: str = "NONE"
    product_refs: tuple[str, ...] = ()
    search_query: str = ""


def _clamp_confidence(value: object) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return 0.8
    return max(0.0, min(number, 1.0))


def extract_json_object(value: str) -> dict[str, object]:
    """Compatibility helper for tests and hidden tool payloads."""
    text = (value or "").strip()
    text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text, flags=re.I | re.S).strip()
    try:
        payload = json.loads(text)
        if isinstance(payload, dict):
            return payload
    except json.JSONDecodeError:
        pass
    start = text.find("{")
    end = text.rfind("}")
    if start < 0 or end <= start:
        raise ValueError("No JSON object found")
    payload = json.loads(text[start : end + 1])
    if not isinstance(payload, dict):
        raise ValueError("Tool payload must be a JSON object")
    return payload


def parse_tool_request(payload: dict[str, object]) -> ToolRequest | None:
    name = str(payload.get("name", "")).strip().upper()
    if name not in {"PRODUCT_FACTS", "RECOMMEND_PRODUCTS"}:
        return None
    lookup_type = str(payload.get("lookup_type", "NONE")).strip().upper()
    if lookup_type not in {"NONE", "PRICE", "STOCK", "USAGE"}:
        lookup_type = "NONE"
    raw_refs = payload.get("product_refs", [])
    refs: list[str] = []
    if isinstance(raw_refs, (list, tuple)):
        for item in raw_refs:
            value = str(item).strip()
            if value and value not in refs:
                refs.append(value)
    return ToolRequest(
        name=name,
        lookup_type=lookup_type,
        product_refs=tuple(refs[:4]),
        search_query=str(payload.get("search_query", "")).strip(),
    )


def split_natural_response(raw: str) -> tuple[str, ToolRequest | None]:
    """Return natural text and an optional hidden tool request.

    Malformed markers never force handoff. The natural part remains usable.
    """
    text = (raw or "").strip()
    match = _TOOL_MARKER_RE.search(text)
    if not match:
        return text, None
    natural = text[: match.start()].strip()
    try:
        request = parse_tool_request(json.loads(match.group(1)))
    except (json.JSONDecodeError, TypeError, ValueError):
        request = None
    return natural, request


def is_conversation_reset(message: str) -> bool:
    normalized = normalize_text(message)
    phrases = (
        "test context safe",
        "test hermes ai first",
        "bat dau lai",
        "hoi lai tu dau",
        "tu van lai tu dau",
        "minh bat dau lai",
    )
    return any(phrase in normalized for phrase in phrases)


def _context_item(row: dict[str, str]) -> dict[str, object]:
    confidence_raw = str(row.get("CONFIDENCE", "")).strip()
    try:
        confidence = float(confidence_raw) if confidence_raw else None
    except ValueError:
        confidence = None
    reliable = (
        str(row.get("NEED_HUMAN", "")).strip().upper() != "TRUE"
        and str(row.get("INTENT", "")).strip().upper()
        not in {"HUMAN_HANDOFF", "CONTEXT_UNRESOLVED"}
        and (confidence is None or confidence >= 0.55)
    )
    return {
        "customer": str(row.get("MESSAGE_TEXT", "")).strip(),
        "assistant": str(row.get("DRAFT_REPLY", "")).strip(),
        "intent": str(row.get("INTENT", "")).strip(),
        "product_key": str(row.get("PRODUCT_KEY", "")).strip(),
        "reliable": reliable,
        "created_at": str(row.get("CREATED_AT", "")).strip(),
    }


def conversation_context(
    queue_rows: list[dict[str, str]],
    current_index: int,
    customer_id: str,
    current_message: str,
    limit: int = MAX_CONTEXT_TURNS,
) -> list[dict[str, object]]:
    if is_conversation_reset(current_message):
        return []
    prior = [
        row
        for row in queue_rows[:current_index]
        if str(row.get("CUSTOMER_ID", "")).strip() == customer_id
    ]
    reset_at = 0
    for index, row in enumerate(prior):
        if is_conversation_reset(str(row.get("MESSAGE_TEXT", ""))):
            reset_at = index
    return [_context_item(row) for row in prior[reset_at:]][-limit:]


def build_conversation_prompt(
    message: str,
    context: list[dict[str, object]],
) -> str:
    memory = read_text(MEMORY_PATH, 4500)
    user_profile = read_text(USER_PATH, 2200)
    return f"""/thu-ha-cosmetics
Bạn là nhân viên tư vấn trực tuyến của Fanpage Thu Hà Authentic.
Hãy nói chuyện như một người bán hàng tử tế, tự nhiên, hiểu ngữ cảnh và ngắn gọn.

TIN NHẮN HIỆN TẠI:
{message}

HỘI THOẠI GẦN NHẤT:
{json.dumps(context, ensure_ascii=False, indent=2)}

BỘ NHỚ:
{memory}

HỒ SƠ TRAINING:
{user_profile}

NGUYÊN TẮC:
- Trả lời trực tiếp bằng tiếng Việt tự nhiên. Không xuất phân tích, nhãn, JSON hay giải thích nội bộ.
- Câu chào, cảm ơn, câu hỏi xã giao hoặc câu hỏi bình thường phải trả lời ngay như người thật.
- Không chuyển Thu Hà chỉ vì thiếu ngữ cảnh, không chắc chắn hoặc không hiểu trọn vẹn.
  Khi cần, hãy hỏi lại một câu ngắn, tự nhiên.
- Tự nối mạch các đại từ như “nó”, “loại đó”, “sản phẩm em vừa nói” theo hội thoại.
- Không tự đổi sang sản phẩm khác chỉ vì cùng có thuộc tính như “kiềm dầu”, “mụn”, “dưỡng ẩm”.
- Chỉ chuyển người thật khi khách yêu cầu gặp người thật hoặc có tình huống an toàn nghiêm trọng.
- Không chẩn đoán bệnh, không phóng đại công dụng.

CHỈ KHI CẦN DỮ LIỆU CHÍNH XÁC:
1. Giá, tồn kho hoặc cách dùng của sản phẩm đã xác định:
   Viết một câu tự nhiên ngắn nếu cần, rồi thêm đúng một dòng cuối:
   [[THA_TOOL:{{"name":"PRODUCT_FACTS","lookup_type":"PRICE|STOCK|USAGE","product_refs":["tên đầy đủ hoặc mã sản phẩm đã có trong hội thoại"]}}]]
2. Cần tìm sản phẩm phù hợp với nhu cầu mới:
   Thêm đúng một dòng cuối:
   [[THA_TOOL:{{"name":"RECOMMEND_PRODUCTS","lookup_type":"NONE","product_refs":[],"search_query":"mô tả nhu cầu da cụ thể"}}]]

Không dùng THA_TOOL cho câu chào, trò chuyện xã giao, câu hỏi làm rõ hoặc khi có thể trả lời tự nhiên mà không cần số liệu.
"""


def call_conversation(
    message: str,
    context: list[dict[str, object]],
) -> tuple[str, ToolRequest | None]:
    raw = call_hermes(build_conversation_prompt(message, context))
    return split_natural_response(raw)


def _distinctive_tokens(value: str) -> set[str]:
    return {
        token
        for token in normalize_text(value).split()
        if len(token) >= 3 and token not in _GENERIC_REFERENCE_TOKENS
    }


def _available_products(rows: Iterable[dict[str, str]]) -> list[dict[str, str]]:
    return [row for row in rows if product_is_available_for_advice(row)]


def resolve_product_refs(
    refs: Sequence[str],
    product_rows: list[dict[str, str]],
    limit: int = 4,
) -> list[dict[str, str]]:
    """Resolve only explicit names/ids supplied by Hermes."""
    products = _available_products(product_rows)
    by_key: dict[str, dict[str, str]] = {}
    for product in products:
        for field in ("product_id", "sku", "barcode_value"):
            key = str(product.get(field, "")).strip()
            if key:
                by_key[key.casefold()] = product

    selected: list[dict[str, str]] = []
    seen: set[str] = set()
    for raw_ref in refs:
        ref = str(raw_ref).strip()
        if not ref:
            continue
        exact = by_key.get(ref.casefold())
        candidates: list[tuple[float, dict[str, str]]] = []
        if exact:
            candidates.append((100.0, exact))
        else:
            ref_normalized = normalize_text(ref)
            ref_tokens = _distinctive_tokens(ref)
            if len(ref_tokens) < 2:
                continue
            for product in products:
                name = str(product.get("product_name", "")).strip()
                name_normalized = normalize_text(name)
                name_tokens = _distinctive_tokens(name)
                if ref_normalized == name_normalized:
                    score = 99.0
                elif ref_normalized in name_normalized or name_normalized in ref_normalized:
                    score = 95.0
                else:
                    shared = ref_tokens & name_tokens
                    coverage = len(shared) / max(1, len(ref_tokens))
                    if len(shared) < 2 or coverage < 0.60:
                        continue
                    score = coverage + len(shared) / 100.0
                candidates.append((score, product))
        if not candidates:
            continue
        candidates.sort(key=lambda item: item[0], reverse=True)
        product = candidates[0][1]
        product_id = str(product.get("product_id", "")).strip()
        if product_id and product_id not in seen:
            seen.add(product_id)
            selected.append(product)
        if len(selected) >= limit:
            break
    return selected


def retrieve_recommendation_candidates(
    search_query: str,
    product_rows: list[dict[str, str]],
    limit: int = 6,
) -> list[dict[str, str]]:
    query_tokens = {
        token
        for token in normalize_text(search_query).split()
        if len(token) >= 3 and token not in _SEARCH_STOPWORDS
    }
    if not query_tokens:
        return []
    ranked: list[tuple[float, dict[str, str]]] = []
    for product in _available_products(product_rows):
        weighted_text = " ".join(
            (
                str(product.get("product_name", "")),
                str(product.get("skin_type", "")),
                str(product.get("main_usage", "")),
                str(product.get("short_description", "")),
                str(product.get("detail_description", "")),
            )
        )
        product_tokens = set(normalize_text(weighted_text).split())
        shared = query_tokens & product_tokens
        if not shared:
            continue
        score = len(shared) / len(query_tokens)
        if len(shared) == 1 and len(query_tokens) >= 3:
            continue
        ranked.append((score + len(shared) / 100.0, product))
    ranked.sort(key=lambda item: item[0], reverse=True)
    return [product for _, product in ranked[:limit]]


def _product_facts(product: dict[str, str]) -> dict[str, str]:
    return compact_dict(
        product,
        (
            "product_id", "sku", "product_name", "sale_price", "current_stock",
            "stock_status", "skin_type", "main_usage", "usage", "short_description",
            "detail_description", "status", "public_visible", "allow_online_order",
        ),
    )


def build_grounded_prompt(
    message: str,
    context: list[dict[str, object]],
    request: ToolRequest,
    products: list[dict[str, str]],
) -> str:
    facts = [_product_facts(product) for product in products]
    task = (
        f"Trả lời đúng dữ liệu {request.lookup_type} của sản phẩm khách đang hỏi."
        if request.name == "PRODUCT_FACTS"
        else "Chọn tối đa 2 sản phẩm phù hợp nhất và tư vấn tự nhiên."
    )
    return f"""/thu-ha-cosmetics
Bạn đang tiếp tục đúng cuộc trò chuyện với khách của Thu Hà Authentic.
{task}

TIN NHẮN HIỆN TẠI:
{message}

HỘI THOẠI:
{json.dumps(context, ensure_ascii=False, indent=2)}

DỮ LIỆU ĐÃ XÁC MINH:
{json.dumps(facts, ensure_ascii=False, indent=2)}

Viết duy nhất nội dung gửi khách bằng tiếng Việt tự nhiên, ngắn gọn.
Không xuất JSON, THA_TOOL, mã nội bộ hoặc phân tích.
Không thêm sản phẩm ngoài dữ liệu trên. Không tự đổi sản phẩm.
Nếu dữ liệu chưa đủ, hỏi lại tự nhiên; không tự động chuyển Thu Hà.
Không mời tạo đơn nếu khách chỉ hỏi thông tin.
"""


def compose_grounded_reply(
    message: str,
    context: list[dict[str, object]],
    request: ToolRequest,
    products: list[dict[str, str]],
) -> str:
    return call_hermes(build_grounded_prompt(message, context, request, products)).strip()


def deterministic_fact_fallback(request: ToolRequest, products: list[dict[str, str]]) -> str:
    if request.lookup_type == "PRICE":
        lines = [
            f"• {str(product.get('product_name', 'Sản phẩm')).strip()}: "
            f"{display_price(product.get('sale_price', '')) or 'chưa cập nhật giá'}"
            for product in products
        ]
        return "Dạ, giá hiện tại là:\n" + "\n".join(lines)
    if request.lookup_type == "STOCK":
        lines = [
            f"• {str(product.get('product_name', 'Sản phẩm')).strip()}: "
            f"{str(product.get('stock_status', '')).strip() or 'chưa rõ tồn kho'}"
            for product in products
        ]
        return "Dạ, tình trạng kho hiện tại là:\n" + "\n".join(lines)
    product = products[0]
    name = str(product.get("product_name", "sản phẩm")).strip()
    usage = str(product.get("usage", "")).strip() or str(product.get("main_usage", "")).strip()
    if usage:
        return f"Dạ, với {name}: {usage}"
    return f"Dạ, chị cho em ít phút kiểm tra lại cách dùng chuẩn của {name} nhé."


def natural_failure_fallback(message: str) -> str:
    normalized = normalize_text(message)
    if any(
        normalized == phrase or normalized.startswith(phrase + " ")
        for phrase in ("xin chao", "chao", "hello", "hi", "chao shop")
    ):
        return "Dạ em chào chị ạ 😊 Chị đang quan tâm sản phẩm hay vấn đề da nào để em hỗ trợ?"
    if any(phrase in normalized for phrase in ("cam on", "thank", "ok em", "ok shop")):
        return "Dạ không có gì ạ 😊 Chị cần thêm thông tin gì cứ nhắn em nhé."
    return "Dạ chị nói thêm giúp em một chút về điều chị đang cần, em tư vấn tiếp cho đúng ý mình ạ."


def _intent_for_request(request: ToolRequest | None) -> str:
    if request is None:
        return "NATURAL_CONVERSATION"
    if request.name == "RECOMMEND_PRODUCTS":
        return "PRODUCT_CONSULTATION"
    return {
        "PRICE": "PRODUCT_PRICE",
        "STOCK": "PRODUCT_STOCK",
        "USAGE": "BASIC_USAGE",
    }.get(request.lookup_type, "PRODUCT_INFORMATION")


def process_new_messages(repo: SheetsRepository) -> tuple[int, int, int]:
    queue_rows = rows_to_dicts(repo.read("FANPAGE_QUEUE!A1:M2000"))
    product_rows = rows_to_dicts(repo.read("PRODUCTS_HOT!A1:X1000"))
    eligible = processed = fallbacks = 0

    for index, row in enumerate(queue_rows):
        if str(row.get("STATUS", "")).strip().upper() != "NEW":
            continue
        eligible += 1
        row_number = index + 2
        if not DRY_RUN:
            repo.update_status(row_number, "PROCESSING")

        message = str(row.get("MESSAGE_TEXT", "")).strip()
        customer_id = str(row.get("CUSTOMER_ID", "")).strip()
        context = conversation_context(queue_rows, index, customer_id, message)
        error = ""
        products: list[dict[str, str]] = []
        request: ToolRequest | None = None
        need_human = requires_human(message)
        confidence = 0.86

        try:
            natural_reply, request = call_conversation(message, context)
            reply = natural_reply.strip()
            if request is not None:
                if request.name == "PRODUCT_FACTS":
                    products = resolve_product_refs(request.product_refs, product_rows)
                    if products:
                        try:
                            reply = compose_grounded_reply(
                                message, context, request, products
                            )
                        except (RuntimeError, subprocess.TimeoutExpired, OSError) as exc:
                            reply = deterministic_fact_fallback(request, products)
                            error = f"GROUNDED_COMPOSE_FALLBACK: {str(exc)[:300]}"
                            fallbacks += 1
                            confidence = 0.65
                    elif not reply:
                        reply = (
                            "Dạ chị nhắc giúp em đúng tên sản phẩm trên chai hoặc gửi ảnh nhé, "
                            "em kiểm tra giá/cách dùng cho chính xác ạ."
                        )
                        confidence = 0.62
                else:
                    products = retrieve_recommendation_candidates(
                        request.search_query, product_rows
                    )
                    if products:
                        try:
                            reply = compose_grounded_reply(
                                message, context, request, products
                            )
                        except (RuntimeError, subprocess.TimeoutExpired, OSError) as exc:
                            reply = natural_reply.strip() or (
                                "Dạ chị cho em biết thêm sản phẩm chị đang dùng và mức độ dầu/mụn "
                                "hiện tại nhé, em lọc lựa chọn phù hợp hơn ạ."
                            )
                            error = f"RECOMMEND_COMPOSE_FALLBACK: {str(exc)[:300]}"
                            fallbacks += 1
                            confidence = 0.60
                    elif not reply:
                        reply = (
                            "Dạ chị cho em biết thêm sản phẩm đang dùng và tình trạng da cụ thể "
                            "một chút nhé, em tư vấn sát hơn ạ."
                        )
                        confidence = 0.62
            if not reply:
                reply = natural_failure_fallback(message)
                confidence = 0.58
        except (RuntimeError, subprocess.TimeoutExpired, OSError, ValueError) as exc:
            reply = natural_failure_fallback(message)
            error = f"HERMES_NATURAL_FALLBACK: {str(exc)[:300]}"
            fallbacks += 1
            confidence = 0.55

        product_key = ",".join(
            str(product.get("product_id", "")).strip()
            for product in products
            if str(product.get("product_id", "")).strip()
        )
        decision = NaturalReplyDecision(
            intent=_intent_for_request(request),
            product_key=product_key,
            reply=reply[:1800],
            confidence=confidence,
            need_human=need_human,
            error=error,
        )
        if not DRY_RUN:
            repo.update_reply(row_number, decision)
        processed += 1
        if processed >= MAX_ITEMS:
            break

    return eligible, processed, fallbacks


def main() -> int:
    repo = SheetsRepository(FAST_INDEX_ID)
    eligible, processed, fallbacks = process_new_messages(repo)
    print(
        "PASS Hermes conversation-native processor "
        f"eligible={eligible} processed={processed} "
        f"fallbacks={fallbacks} dry_run={DRY_RUN}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
