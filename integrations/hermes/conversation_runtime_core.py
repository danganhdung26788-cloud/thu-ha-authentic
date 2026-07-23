"""Fast, grounded Messenger advisor for Thu Ha Authentic.

Ordinary social conversation remains natural. Product consultation is different:
when the customer asks the shop to recommend, choose, quote, or check a product,
the processor must query PRODUCTS_HOT and attach PRODUCT_KEY before a reply can be
sent. Approved Telegram training lessons are loaded on every turn from a separate,
versioned active-memory file.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Sequence

from integrations.hermes.fanpage_draft_processor import rows_to_dicts
from integrations.hermes.natural_reply_processor import (
    FAST_INDEX_ID,
    MEMORY_PATH,
    USER_PATH,
    NaturalReplyDecision,
    SheetsRepository,
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
HERMES_HOME = os.getenv("HERMES_HOME", "/opt/data").strip() or "/opt/data"
HERMES_BIN = os.getenv("THA_HERMES_BIN", "hermes").strip() or "hermes"
HERMES_TIMEOUT = max(20, min(int(os.getenv("THA_HERMES_REPLY_TIMEOUT_SECONDS", "120")), 600))
ACTIVE_TRAINING_MEMORY_PATH = Path(
    os.getenv("THA_ACTIVE_TRAINING_MEMORY_PATH", "/opt/data/memories/THA_TRAINING_ACTIVE.md")
)

_TOOL_MARKER_RE = re.compile(r"\[\[THA_TOOL:(\{.*?\})\]\]\s*$", re.S)
_LIP_TERMS = {"son", "lip", "lipstick", "rouge", "tint"}
_SEARCH_STOPWORDS = {
    "tu", "van", "giup", "minh", "kha", "hay", "bi", "nen", "uu", "tien",
    "phu", "hop", "can", "muon", "hoi", "nhe", "nhi", "voi", "mot", "chut",
    "san", "pham", "loai", "cai", "nay", "do", "no", "em", "shop", "chi",
    "anh", "gia", "cach", "dung", "con", "hang", "va", "cho", "ml", "sp",
    "vua", "noi", "gioi", "thieu", "tren", "lai", "tam", "khoang", "nghin",
    "ngan", "trieu", "bao", "nhieu", "cung", "duoc", "cu", "lay",
}
_GENERIC_REFERENCE_TOKENS = _SEARCH_STOPWORDS | {
    "kem", "sua", "nuoc", "gel", "serum", "lotion", "chong", "nang", "da",
    "mat", "mask",
}
_PRODUCT_CUES = (
    "tu van", "tham khao", "muon mua", "can mua", "gioi thieu", "chon giup",
    "chon cho", "chot cho", "chot luon", "lay bua", "cu lay", "gui anh",
    "gui chi", "mau nao", "loai nao", "co loai", "co mau", "bao nhieu cung duoc",
    "muc gia", "gia luon", "kho du lieu", "tu van mo", "lay san pham",
)
_FACT_PRICE = ("gia bao nhieu", "bao nhieu tien", "gia hien tai", "gia cua", "muc gia")
_FACT_STOCK = ("con hang", "het hang", "ton kho", "con khong")
_FACT_USAGE = ("cach dung", "dung nhu nao", "su dung nhu nao", "dung the nao")
_PRODUCT_FAMILIES = {
    "mask": ("mat na", "mask"),
    "lip": ("son moi", "son", "lip", "lipstick", "rouge", "tint"),
    "sunscreen": ("kem chong nang", "chong nang", "sunscreen"),
    "cleanser": ("sua rua mat", "gel rua mat", "cleanser"),
    "moisturizer": ("kem duong", "duong am", "moisturizer"),
    "serum": ("serum", "tinh chat"),
    "toner": ("toner", "nuoc hoa hong"),
    "makeup_remover": ("tay trang", "micellar"),
}


@dataclass(frozen=True)
class ToolRequest:
    name: str
    lookup_type: str = "NONE"
    product_refs: tuple[str, ...] = ()
    search_query: str = ""


def extract_json_object(value: str) -> dict[str, object]:
    text = (value or "").strip()
    text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text, flags=re.I | re.S).strip()
    try:
        payload = json.loads(text)
        if isinstance(payload, dict):
            return payload
    except json.JSONDecodeError:
        pass
    start, end = text.find("{"), text.rfind("}")
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
    refs: list[str] = []
    raw_refs = payload.get("product_refs", [])
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
    return any(
        phrase in normalized
        for phrase in (
            "test context safe", "test hermes ai first", "bat dau lai",
            "hoi lai tu dau", "tu van lai tu dau", "minh bat dau lai",
        )
    )


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
        row for row in queue_rows[:current_index]
        if str(row.get("CUSTOMER_ID", "")).strip() == customer_id
    ]
    reset_at = 0
    for index, row in enumerate(prior):
        if is_conversation_reset(str(row.get("MESSAGE_TEXT", ""))):
            reset_at = index
    return [_context_item(row) for row in prior[reset_at:]][-limit:]


def read_active_training_memory(limit: int = 6500) -> str:
    return read_text(ACTIVE_TRAINING_MEMORY_PATH, limit)


def build_conversation_prompt(message: str, context: list[dict[str, object]]) -> str:
    memory = read_text(MEMORY_PATH, 4500)
    user_profile = read_text(USER_PATH, 2200)
    active_training = read_active_training_memory()
    return f"""/thu-ha-cosmetics
Bạn là nhân viên tư vấn trực tuyến của Fanpage Thu Hà Authentic.
Nói ngắn gọn, tự nhiên và không vòng vo.

TIN NHẮN HIỆN TẠI:
{message}

HỘI THOẠI GẦN NHẤT:
{json.dumps(context, ensure_ascii=False, indent=2)}

BỘ NHỚ CHUNG:
{memory}

TRAINING ĐANG CÓ HIỆU LỰC:
{active_training}

HỒ SƠ:
{user_profile}

NGUYÊN TẮC:
- Trả lời trực tiếp bằng tiếng Việt, không xuất phân tích, nhãn hoặc JSON.
- Tự nối mạch “nó”, “loại đó”, “sản phẩm em vừa nói”.
- Không chuyển người thật chỉ vì thiếu ngữ cảnh.
- Khi khách cần sản phẩm, giá, tồn kho hoặc cách dùng, phải dùng THA_TOOL; không được giả vờ đã tra kho.
- Khi nhu cầu đã đủ rõ, chốt nhanh một sản phẩm; không hỏi đi hỏi lại ngân sách hoặc bắt khách chọn nhóm chung chung.
- Sau khi đã chốt sản phẩm, chỉ tư vấn sâu thêm khi khách hỏi tiếp.
- Không chẩn đoán bệnh, không phóng đại công dụng.

THA_TOOL:
1. Giá, tồn kho hoặc cách dùng sản phẩm đã xác định:
   [[THA_TOOL:{{"name":"PRODUCT_FACTS","lookup_type":"PRICE|STOCK|USAGE","product_refs":["tên hoặc mã sản phẩm"]}}]]
2. Tìm sản phẩm phù hợp:
   [[THA_TOOL:{{"name":"RECOMMEND_PRODUCTS","lookup_type":"NONE","product_refs":[],"search_query":"đầy đủ loại hàng, nhu cầu và ngân sách"}}]]
"""


def _runtime_env() -> dict[str, str]:
    env = os.environ.copy()
    env.setdefault("HERMES_HOME", HERMES_HOME)
    env.setdefault(
        "GOOGLE_APPLICATION_CREDENTIALS",
        "/opt/data/google/application_default_credentials.json",
    )
    required = "/opt/data/tha-integrations:/opt/data/tha-integrations/.vendor"
    existing = env.get("PYTHONPATH", "")
    if required not in existing:
        env["PYTHONPATH"] = required if not existing else f"{required}:{existing}"
    return env


def invoke_hermes(prompt: str) -> str:
    completed = subprocess.run(
        [HERMES_BIN, "-z", prompt],
        capture_output=True,
        text=True,
        timeout=HERMES_TIMEOUT,
        check=False,
        env=_runtime_env(),
        cwd=HERMES_HOME if Path(HERMES_HOME).exists() else None,
    )
    if completed.returncode != 0:
        detail = (completed.stderr or completed.stdout or "unknown error").strip()
        raise RuntimeError(f"Hermes exited {completed.returncode}: {detail[:500]}")
    reply = (completed.stdout or "").strip()
    reply = re.sub(r"^```(?:text|markdown)?\s*|\s*```$", "", reply, flags=re.I | re.S).strip()
    if not reply:
        raise RuntimeError("Hermes returned an empty reply")
    return reply[:3000]


def call_conversation(message: str, context: list[dict[str, object]]) -> tuple[str, ToolRequest | None]:
    return split_natural_response(invoke_hermes(build_conversation_prompt(message, context)))


def _distinctive_tokens(value: str) -> set[str]:
    return {
        token for token in normalize_text(value).split()
        if len(token) >= 3 and token not in _GENERIC_REFERENCE_TOKENS
    }


def _available_products(rows: Iterable[dict[str, str]]) -> list[dict[str, str]]:
    return [row for row in rows if product_is_available_for_advice(row)]


def _recommendable_products(rows: Iterable[dict[str, str]]) -> list[dict[str, str]]:
    selected: list[dict[str, str]] = []
    for row in _available_products(rows):
        stock_status = normalize_text(str(row.get("stock_status", "")))
        current_stock = re.sub(r"\D", "", str(row.get("current_stock", "")))
        if "het hang" in stock_status:
            continue
        if current_stock and int(current_stock) <= 0:
            continue
        selected.append(row)
    return selected


def resolve_product_refs(
    refs: Sequence[str], product_rows: list[dict[str, str]], limit: int = 4
) -> list[dict[str, str]]:
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


def _parse_money_number(raw: str, multiplier: int = 1) -> int | None:
    value = raw.strip().replace(" ", "")
    if multiplier == 1 and re.fullmatch(r"\d{1,3}(?:[.,]\d{3})+", value):
        return int(re.sub(r"\D", "", value))
    try:
        return int(float(value.replace(",", ".")) * multiplier)
    except ValueError:
        return None


def extract_budget_vnd(text: str) -> tuple[int | None, str]:
    original = (text or "").lower()
    mode = "TARGET"
    if re.search(r"\b(dưới|duoi|không quá|khong qua|tối đa|toi da)\b", original):
        mode = "MAX"
    elif re.search(r"\b(trên|tren|ít nhất|it nhat|tối thiểu|toi thieu)\b", original):
        mode = "MIN"
    patterns = (
        (r"(\d+(?:[.,]\d+)?)\s*(?:triệu|trieu)\b", 1_000_000),
        (r"(\d+(?:[.,]\d+)?)\s*(?:nghìn|nghin|ngàn|ngan|k)\b", 1_000),
        (r"\b(\d{4,9})\s*(?:đ|d|vnd)?\b", 1),
        (r"\b(\d{1,3}(?:[.,]\d{3})+)\s*(?:đ|d|vnd)?\b", 1),
    )
    for pattern, multiplier in patterns:
        match = re.search(pattern, original)
        if match:
            return _parse_money_number(match.group(1), multiplier), mode
    return None, mode


def _sale_price_number(product: dict[str, str]) -> int | None:
    digits = re.sub(r"\D", "", str(product.get("sale_price", "")))
    return int(digits) if digits else None


def _family_for_text(value: str) -> str:
    normalized = normalize_text(value)
    for family, phrases in _PRODUCT_FAMILIES.items():
        if any(phrase in normalized for phrase in phrases):
            return family
    return ""


def _expanded_query_tokens(value: str) -> set[str]:
    normalized = normalize_text(value)
    tokens = {
        token for token in normalized.split()
        if len(token) >= 3 and token not in _SEARCH_STOPWORDS and not token.isdigit()
    }
    if _LIP_TERMS & set(normalized.split()) or "son" in normalized.split():
        tokens.update(_LIP_TERMS)
    if "sang" in normalized:
        tokens.update({"sang", "brightening", "whitening"})
    if "kho" in normalized or "thieu am" in normalized:
        tokens.update({"kho", "am", "cap", "duong"})
    if "phuc hoi" in normalized:
        tokens.update({"phuc", "hoi", "repair"})
    return tokens


def retrieve_recommendation_candidates(
    search_query: str, product_rows: list[dict[str, str]], limit: int = 6
) -> list[dict[str, str]]:
    query_tokens = _expanded_query_tokens(search_query)
    if not query_tokens:
        return []
    required_family = _family_for_text(search_query)
    budget, budget_mode = extract_budget_vnd(search_query)
    ranked: list[tuple[float, dict[str, str]]] = []
    for product in _recommendable_products(product_rows):
        name = str(product.get("product_name", ""))
        weighted_text = " ".join(
            (
                name,
                str(product.get("skin_type", "")),
                str(product.get("main_usage", "")),
                str(product.get("short_description", "")),
                str(product.get("detail_description", "")),
                str(product.get("category_id", "")),
            )
        )
        if required_family and _family_for_text(weighted_text) != required_family:
            continue
        product_tokens = set(normalize_text(weighted_text).split())
        shared = query_tokens & product_tokens
        if _LIP_TERMS & query_tokens and not (_LIP_TERMS & product_tokens):
            continue
        if not shared:
            continue
        price = _sale_price_number(product)
        price_score = 0.0
        if budget:
            if price is None:
                continue
            if budget_mode == "MAX" and price > budget:
                continue
            if budget_mode == "MIN" and price < budget:
                continue
            if budget_mode == "TARGET" and not (int(budget * 0.65) <= price <= int(budget * 1.35)):
                continue
            price_score = max(0.0, 1.0 - abs(price - budget) / max(1, budget))
        name_tokens = set(normalize_text(name).split())
        name_bonus = len(shared & name_tokens) * 0.25
        stock_digits = re.sub(r"\D", "", str(product.get("current_stock", "")))
        stock_bonus = min(int(stock_digits), 10) / 100.0 if stock_digits else 0.0
        semantic_score = len(shared) / max(1, len(query_tokens))
        ranked.append((semantic_score * 2.0 + price_score + name_bonus + stock_bonus, product))
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
    return f"""/thu-ha-cosmetics
Trả lời đúng dữ liệu đã xác minh dưới đây. Chỉ trả lời nội dung gửi khách, ngắn gọn.
TIN NHẮN: {message}
HỘI THOẠI: {json.dumps(context, ensure_ascii=False)}
DỮ LIỆU: {json.dumps(facts, ensure_ascii=False)}
Không thêm sản phẩm ngoài dữ liệu. Không hỏi lại điều khách đã trả lời.
"""


def compose_grounded_reply(
    message: str,
    context: list[dict[str, object]],
    request: ToolRequest,
    products: list[dict[str, str]],
) -> str:
    return invoke_hermes(build_grounded_prompt(message, context, request, products)).strip()


def _customer_query(message: str, context: Sequence[dict[str, object]]) -> str:
    parts = [
        str(item.get("customer", "")).strip()
        for item in context[-6:]
        if item.get("reliable", True) and str(item.get("customer", "")).strip()
    ]
    parts.append(message.strip())
    return " ".join(parts)


def _active_product_refs(context: Sequence[dict[str, object]]) -> tuple[str, ...]:
    refs: list[str] = []
    for item in reversed(context):
        for value in str(item.get("product_key", "")).split(","):
            key = value.strip()
            if key and key not in refs:
                refs.append(key)
        if refs:
            break
    return tuple(refs[:4])


def _consultation_requested(message: str, context: Sequence[dict[str, object]]) -> bool:
    normalized = normalize_text(message)
    if normalized in {"chao", "xin chao", "hello", "hi", "cam on", "ok"}:
        return False
    if any(cue in normalized for cue in _PRODUCT_CUES):
        return True
    combined = normalize_text(_customer_query(message, context))
    followup = any(
        phrase in normalized
        for phrase in ("loai sang da", "loai cap am", "loai phuc hoi", "lay mot loai", "chot mot loai")
    )
    return followup and bool(_family_for_text(combined))


def infer_forced_request(
    message: str, context: Sequence[dict[str, object]]
) -> ToolRequest | None:
    normalized = normalize_text(message)
    refs = _active_product_refs(context)
    if refs:
        if any(phrase in normalized for phrase in _FACT_PRICE):
            return ToolRequest("PRODUCT_FACTS", "PRICE", refs)
        if any(phrase in normalized for phrase in _FACT_STOCK):
            return ToolRequest("PRODUCT_FACTS", "STOCK", refs)
        if any(phrase in normalized for phrase in _FACT_USAGE):
            return ToolRequest("PRODUCT_FACTS", "USAGE", refs)
    if _consultation_requested(message, context):
        return ToolRequest("RECOMMEND_PRODUCTS", "NONE", (), _customer_query(message, context))
    return None


def _pronoun(message: str, context: Sequence[dict[str, object]]) -> str:
    combined = normalize_text(_customer_query(message, context))
    if re.search(r"\b(anh|a)\b", combined):
        return "anh"
    return "chị"


def _clean_reason(product: dict[str, str]) -> str:
    reason = (
        str(product.get("short_description", "")).strip()
        or str(product.get("main_usage", "")).strip()
        or "phù hợp với nhu cầu mình vừa nêu"
    )
    reason = re.sub(r"\s+", " ", reason).strip(" .")
    if len(reason) > 155:
        reason = reason[:152].rsplit(" ", 1)[0] + "…"
    return reason


def fast_product_choice_reply(
    product: dict[str, str], message: str, context: Sequence[dict[str, object]]
) -> str:
    name = str(product.get("product_name", "sản phẩm")).strip()
    price = display_price(product.get("sale_price", "")) or "chưa cập nhật giá"
    pronoun = _pronoun(message, context)
    reason = _clean_reason(product)
    return f"Dạ, em chốt cho {pronoun} {name}, giá {price} ạ. {reason}; hiện shop còn hàng."


def deterministic_fact_fallback(request: ToolRequest, products: list[dict[str, str]]) -> str:
    if request.lookup_type == "PRICE":
        product = products[0]
        return (
            f"Dạ, {str(product.get('product_name', 'sản phẩm')).strip()} hiện có giá "
            f"{display_price(product.get('sale_price', '')) or 'chưa cập nhật giá'} ạ."
        )
    if request.lookup_type == "STOCK":
        product = products[0]
        status = str(product.get("stock_status", "")).strip() or "chưa rõ tồn kho"
        return f"Dạ, {str(product.get('product_name', 'sản phẩm')).strip()} hiện {status.lower()} ạ."
    product = products[0]
    name = str(product.get("product_name", "sản phẩm")).strip()
    usage = str(product.get("usage", "")).strip() or str(product.get("main_usage", "")).strip()
    usage = re.sub(r"\s+", " ", usage).strip()
    if len(usage) > 350:
        usage = usage[:347].rsplit(" ", 1)[0] + "…"
    return f"Dạ, với {name}: {usage or 'em chưa có hướng dẫn dùng đủ rõ, để em kiểm tra lại ạ.'}"


def _query_label(message: str) -> str:
    normalized = normalize_text(message)
    family = _family_for_text(normalized)
    return {
        "mask": "mặt nạ",
        "lip": "son môi",
        "sunscreen": "kem chống nắng",
        "cleanser": "sữa rửa mặt",
        "moisturizer": "kem dưỡng",
        "serum": "serum",
        "toner": "toner",
        "makeup_remover": "sản phẩm tẩy trang",
    }.get(family, "sản phẩm")


def no_matching_product_reply(message: str, query: str = "") -> str:
    combined = f"{message} {query}".strip()
    budget, _ = extract_budget_vnd(combined)
    label = _query_label(combined)
    if budget:
        return (
            f"Dạ, em vừa kiểm tra danh mục đang bán nhưng chưa thấy {label} phù hợp quanh "
            f"{display_price(str(budget))} ạ. Em không muốn giới thiệu sai sản phẩm khác."
        )
    return f"Dạ, em vừa kiểm tra danh mục đang bán nhưng chưa thấy {label} phù hợp ạ."


def natural_failure_fallback(
    message: str,
    product_rows: list[dict[str, str]] | None = None,
    context: Sequence[dict[str, object]] = (),
) -> str:
    normalized = normalize_text(message)
    if any(normalized == phrase or normalized.startswith(phrase + " ") for phrase in ("xin chao", "chao", "hello", "hi", "chao shop")):
        return "Dạ em chào chị ạ 😊 Chị đang quan tâm sản phẩm nào để em hỗ trợ?"
    if any(phrase in normalized for phrase in ("cam on", "thank", "ok em", "ok shop")):
        return "Dạ không có gì ạ 😊 Chị cần thêm thông tin gì cứ nhắn em nhé."
    if product_rows is not None:
        query = _customer_query(message, context)
        candidates = retrieve_recommendation_candidates(query, product_rows, limit=1)
        if candidates:
            return fast_product_choice_reply(candidates[0], message, context)
        if _consultation_requested(message, context) or extract_budget_vnd(query)[0]:
            return no_matching_product_reply(message, query)
    return "Dạ hệ thống tư vấn đang gặp lỗi kết nối tạm thời nên em chưa thể kiểm tra chính xác câu này ạ."


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
        request: ToolRequest | None = infer_forced_request(message, context)
        need_human = requires_human(message)
        confidence = 0.86
        reply = ""
        try:
            if request is None:
                natural_reply, request = call_conversation(message, context)
                reply = natural_reply.strip()
            if request is not None:
                if request.name == "PRODUCT_FACTS":
                    refs = request.product_refs or _active_product_refs(context)
                    products = resolve_product_refs(refs, product_rows)
                    if products:
                        reply = deterministic_fact_fallback(request, products)
                        confidence = 0.94
                    else:
                        reply = "Dạ em chưa xác định được đúng sản phẩm mình đang nhắc tới ạ."
                        confidence = 0.62
                else:
                    combined_query = " ".join(
                        part for part in (request.search_query, _customer_query(message, context)) if part
                    )
                    products = retrieve_recommendation_candidates(combined_query, product_rows, limit=1)
                    if products:
                        reply = fast_product_choice_reply(products[0], message, context)
                        confidence = 0.94
                    else:
                        reply = no_matching_product_reply(message, combined_query)
                        confidence = 0.72
            if not reply:
                reply = natural_failure_fallback(message, product_rows, context)
                confidence = 0.58
        except (RuntimeError, subprocess.TimeoutExpired, OSError, ValueError) as exc:
            reply = natural_failure_fallback(message, product_rows, context)
            error = f"HERMES_NATURAL_FALLBACK: {str(exc)[:300]}"
            fallbacks += 1
            confidence = 0.55
        product_key = ",".join(
            str(product.get("product_id", "")).strip()
            for product in products
            if str(product.get("product_id", "")).strip()
        )
        if request is not None and request.name == "RECOMMEND_PRODUCTS" and products and not product_key:
            raise RuntimeError("Grounded recommendation cannot be sent without PRODUCT_KEY")
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
        "PASS Hermes fast-grounded conversation runtime "
        f"eligible={eligible} processed={processed} fallbacks={fallbacks} dry_run={DRY_RUN}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
