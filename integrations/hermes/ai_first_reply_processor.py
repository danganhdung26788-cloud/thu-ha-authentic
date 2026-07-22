"""Hermes-first Messenger conversation orchestrator for Thu Ha Authentic.

Hermes reasons over the customer thread before any catalog lookup. Product data is
retrieved only when Hermes explicitly requests verified price, stock, usage, or a
recommendation. Generic words and product attributes never select a catalog row.
"""
from __future__ import annotations

import json
import os
import re
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
MAX_CONTEXT_TURNS = max(4, min(int(os.getenv("THA_AI_FIRST_CONTEXT_TURNS", "10")), 20))

_ALLOWED_ACTIONS = {"TALK", "LOOKUP", "RECOMMEND", "HANDOFF"}
_ALLOWED_LOOKUPS = {"NONE", "PRICE", "STOCK", "USAGE"}
_GENERIC_REFERENCE_TOKENS = {
    "san", "pham", "loai", "cai", "nay", "do", "no", "em", "shop", "chi",
    "gia", "cach", "dung", "con", "hang", "kiem", "dau", "ngua", "mun",
    "kem", "sua", "nuoc", "gel", "serum", "lotion", "chong", "nang", "da",
    "va", "cho", "ml", "sp", "vua", "noi", "gioi", "thieu", "tren", "lai",
}
_SEARCH_STOPWORDS = _GENERIC_REFERENCE_TOKENS | {
    "tu", "van", "giup", "minh", "kha", "hay", "bi", "nen", "uu", "tien",
    "phu", "hop", "can", "muon", "hoi", "nhe", "nhi", "voi", "mot", "chut",
}


@dataclass(frozen=True)
class ConversationPlan:
    action: str
    lookup_type: str
    product_refs: tuple[str, ...]
    search_query: str
    reply: str
    intent: str
    need_human: bool
    confidence: float


def _clamp_confidence(value: object) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return 0.5
    return max(0.0, min(number, 1.0))


def extract_json_object(value: str) -> dict[str, object]:
    """Extract one JSON object from plain text or a fenced Hermes response."""
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
        raise ValueError("Hermes did not return a JSON object")
    payload = json.loads(text[start : end + 1])
    if not isinstance(payload, dict):
        raise ValueError("Hermes plan must be a JSON object")
    return payload


def parse_plan(payload: dict[str, object]) -> ConversationPlan:
    action = str(payload.get("action", "TALK")).strip().upper()
    if action not in _ALLOWED_ACTIONS:
        action = "TALK"
    lookup_type = str(payload.get("lookup_type", "NONE")).strip().upper()
    if lookup_type not in _ALLOWED_LOOKUPS:
        lookup_type = "NONE"
    raw_refs = payload.get("product_refs", [])
    refs: list[str] = []
    if isinstance(raw_refs, (list, tuple)):
        for item in raw_refs:
            value = str(item).strip()
            if value and value not in refs:
                refs.append(value)
    return ConversationPlan(
        action=action,
        lookup_type=lookup_type,
        product_refs=tuple(refs[:4]),
        search_query=str(payload.get("search_query", "")).strip(),
        reply=str(payload.get("reply", "")).strip(),
        intent=str(payload.get("intent", "NATURAL_CONVERSATION")).strip().upper()
        or "NATURAL_CONVERSATION",
        need_human=bool(payload.get("need_human", False)),
        confidence=_clamp_confidence(payload.get("confidence", 0.7)),
    )


def is_conversation_reset(message: str) -> bool:
    normalized = normalize_text(message)
    phrases = (
        "test context safe",
        "bat dau lai",
        "hoi lai tu dau",
        "tu van lai tu dau",
        "shop tu van giup",
        "tu van giup chi",
        "tu van giup em",
        "chao shop",
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
        and str(row.get("INTENT", "")).strip().upper() not in {"HUMAN_HANDOFF", "CONTEXT_UNRESOLVED"}
        and (confidence is None or confidence >= 0.65)
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
    """Return one customer thread, reset at the latest explicit new consultation."""
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


def build_plan_prompt(message: str, context: list[dict[str, object]]) -> str:
    memory = read_text(MEMORY_PATH, 3500)
    user_profile = read_text(USER_PATH, 1800)
    return f"""/thu-ha-cosmetics
Ban la Hermes, tu van vien hoi thoai cua Fanpage Thu Ha Authentic.
Nhiem vu luc nay chi la DOC MACH HOI THOAI VA LAP KE HOACH TRA LOI. Chua tra catalog.

TIN NHAN HIEN TAI:
{message}

HOI THOAI GAN NHAT (moi dong gom loi khach va cau shop da tra):
{json.dumps(context, ensure_ascii=False, indent=2)}

BO NHO NGAN:
{memory}

HO SO NGUOI TRAINING:
{user_profile}

Tra ve DUY NHAT mot JSON hop le theo schema:
{{
  "action": "TALK|LOOKUP|RECOMMEND|HANDOFF",
  "lookup_type": "NONE|PRICE|STOCK|USAGE",
  "product_refs": ["ten day du hoac ma san pham da xuat hien trong hoi thoai"],
  "search_query": "nhu cau da/san pham can tim, chi dung khi action=RECOMMEND",
  "reply": "cau tra loi tu nhien, chi dung khi action=TALK hoac HANDOFF",
  "intent": "nhan y dinh ngan gon",
  "need_human": false,
  "confidence": 0.0
}}

QUY TAC BAT BUOC:
1. Suy luan theo mach hoi thoai truoc, khong tim san pham tu mot tinh tu hay tu chung chung.
2. "san pham em dang noi", "loai do", "cai do" tro den san pham cu the gan nhat ma shop vua noi.
3. "lai kiem dau di" trong mach dang hoi cach dung nghia la quay lai san pham kiem dau da noi truoc do; KHONG co nghia la tim mot san pham moi co chu kiem dau.
4. Neu khach hoi gia, ton kho hoac cach dung cua san pham da xac dinh: action=LOOKUP va product_refs phai la ten day du/ma da co trong hoi thoai.
5. Neu khach dang mo dau mot nhu cau tu van moi: action=RECOMMEND, search_query mo ta dung nhu cau; khong tu chen ten san pham chua tra du lieu.
6. Cau giao tiep thong thuong khong can du lieu: action=TALK va viet reply tu nhien.
7. Khong tin tuyet doi cau shop cu co reliable=false. Neu khach bao tra loi sai/nham, action=HANDOFF, xin loi ngan gon va khong lap lai san pham sai.
8. Product_refs khong duoc chi la "kiem dau", "san pham nay", "loai nay" hoac mot thuoc tinh chung.
9. Khong chuan doan benh, khong phong dai cong dung.
"""


def call_plan(message: str, context: list[dict[str, object]]) -> ConversationPlan:
    raw = call_hermes(build_plan_prompt(message, context))
    return parse_plan(extract_json_object(raw))


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
    """Resolve only explicit Hermes references; never use generic attributes."""
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


def build_lookup_reply_prompt(
    message: str,
    context: list[dict[str, object]],
    plan: ConversationPlan,
    products: list[dict[str, str]],
) -> str:
    facts = [_product_facts(product) for product in products]
    return f"""/thu-ha-cosmetics
Ban da doc mach hoi thoai va xac dinh can tra du lieu {plan.lookup_type}.
Hay viet DUY NHAT cau tra loi gui khach, tieng Viet tu nhien, ngan gon.

TIN NHAN HIEN TAI:
{message}

NGU CANH:
{json.dumps(context, ensure_ascii=False, indent=2)}

DU LIEU DA XAC MINH:
{json.dumps(facts, ensure_ascii=False, indent=2)}

Chi dung du lieu da xac minh. Khong dua them san pham khac. Khong hoi lai ten san pham
neu san pham da duoc xac dinh. Neu lookup_type=USAGE, tra dung cach dung phu hop trong
du lieu; neu du lieu chua du, noi Thu Ha se kiem tra, khong tu sang tac. Khong tu dong
moi tao don neu khach chi hoi thong tin.
"""


def deterministic_lookup_fallback(
    lookup_type: str,
    products: list[dict[str, str]],
) -> str:
    if lookup_type == "PRICE":
        lines = [
            f"• {str(product.get('product_name', 'Sản phẩm')).strip()}: "
            f"{display_price(product.get('sale_price', '')) or 'chưa cập nhật giá'}"
            for product in products
        ]
        return "Dạ, giá hiện tại là:\n" + "\n".join(lines)
    if lookup_type == "STOCK":
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
    return f"Dạ, em cần Thu Hà kiểm tra cách dùng chuẩn của {name} rồi báo chị ngay ạ."


def compose_lookup_reply(
    message: str,
    context: list[dict[str, object]],
    plan: ConversationPlan,
    products: list[dict[str, str]],
) -> tuple[str, str]:
    try:
        reply = call_hermes(build_lookup_reply_prompt(message, context, plan, products))
        return reply, ""
    except Exception as exc:  # noqa: BLE001 - fallback must keep the live queue moving
        return deterministic_lookup_fallback(plan.lookup_type, products), f"LOOKUP_COMPOSE_FALLBACK: {str(exc)[:300]}"


def build_recommendation_prompt(
    message: str,
    context: list[dict[str, object]],
    search_query: str,
    candidates: list[dict[str, str]],
) -> str:
    facts = [_product_facts(product) for product in candidates]
    return f"""/thu-ha-cosmetics
Hermes da xac dinh khach can tu van theo nhu cau: {search_query}
Hay chon toi da 2 san pham PHU HOP NHAT tu danh sach da tra va soan cau tra loi tu nhien.

TIN NHAN KHACH:
{message}

NGU CANH:
{json.dumps(context, ensure_ascii=False, indent=2)}

CAC SAN PHAM DA TRA:
{json.dumps(facts, ensure_ascii=False, indent=2)}

Tra ve DUY NHAT JSON hop le:
{{
  "reply": "cau tu van ngan gon, giai thich vi sao phu hop va hoi mot cau de hieu them nhu cau",
  "product_ids": ["P..."],
  "intent": "PRODUCT_CONSULTATION",
  "confidence": 0.0
}}
Khong chon san pham ngoai danh sach. Khong bao dam tri mun, khong chuan doan benh.
Khong tu dong noi gia/ton kho neu khach chua hoi, tru khi can lam ro lua chon.
"""


def compose_recommendation(
    message: str,
    context: list[dict[str, object]],
    search_query: str,
    candidates: list[dict[str, str]],
) -> tuple[str, list[dict[str, str]], float]:
    raw = call_hermes(build_recommendation_prompt(message, context, search_query, candidates))
    payload = extract_json_object(raw)
    reply = str(payload.get("reply", "")).strip()
    ids = payload.get("product_ids", [])
    selected = resolve_product_refs(ids if isinstance(ids, list) else [], candidates, limit=2)
    if not reply:
        raise ValueError("Hermes recommendation reply is empty")
    return reply, selected, _clamp_confidence(payload.get("confidence", 0.78))


def handoff_reply(plan: ConversationPlan) -> str:
    if plan.reply:
        return plan.reply
    return "Dạ em xin lỗi, em chưa hiểu đúng mạch trao đổi. Em chuyển Thu Hà xem lại và tư vấn trực tiếp cho chị ngay ạ."


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
        try:
            plan = call_plan(message, context)
            need_human = plan.need_human or requires_human(message)
            error = ""
            products: list[dict[str, str]] = []
            confidence = plan.confidence
            intent = plan.intent

            if plan.action == "LOOKUP":
                products = resolve_product_refs(plan.product_refs, product_rows)
                if not products:
                    reply = (
                        "Dạ em chưa xác định chắc đúng sản phẩm chị đang nhắc tới nên em không đoán. "
                        "Chị nhắc giúp em đúng tên trên chai hoặc gửi ảnh, em kiểm tra ngay ạ."
                    )
                    intent = "CONTEXT_CLARIFICATION"
                    need_human = True
                    confidence = min(confidence, 0.35)
                else:
                    reply, error = compose_lookup_reply(message, context, plan, products)
                    if error:
                        fallbacks += 1
            elif plan.action == "RECOMMEND":
                candidates = retrieve_recommendation_candidates(plan.search_query, product_rows)
                if not candidates:
                    reply = (
                        "Dạ em đã hiểu nhu cầu của chị nhưng chưa lọc được sản phẩm đủ chắc chắn từ dữ liệu hiện tại. "
                        "Em chuyển Thu Hà kiểm tra và tư vấn đúng sản phẩm cho chị ạ."
                    )
                    intent = "HUMAN_HANDOFF"
                    need_human = True
                    confidence = min(confidence, 0.35)
                else:
                    reply, products, confidence = compose_recommendation(
                        message, context, plan.search_query, candidates
                    )
                    intent = "PRODUCT_CONSULTATION"
            elif plan.action == "HANDOFF":
                reply = handoff_reply(plan)
                intent = "HUMAN_HANDOFF"
                need_human = True
            else:
                reply = plan.reply or "Dạ chị nói thêm giúp em một chút để em hiểu đúng ý mình nhé."

            product_key = ",".join(
                str(product.get("product_id", "")).strip()
                for product in products
                if str(product.get("product_id", "")).strip()
            )
            decision = NaturalReplyDecision(
                intent=intent,
                product_key=product_key,
                reply=reply,
                confidence=confidence,
                need_human=need_human,
                error=error,
            )
        except Exception as exc:  # noqa: BLE001 - fail closed without retry loops
            fallbacks += 1
            decision = NaturalReplyDecision(
                intent="HUMAN_HANDOFF",
                product_key="",
                reply=(
                    "Dạ em đang chưa đọc đúng mạch trao đổi nên không muốn trả lời đoán. "
                    "Em chuyển Thu Hà kiểm tra và phản hồi trực tiếp cho chị ngay ạ."
                ),
                confidence=0.0,
                need_human=True,
                error=f"AI_FIRST_FALLBACK: {str(exc)[:350]}",
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
        "PASS Hermes AI-first processor "
        f"eligible={eligible} processed={processed} fallbacks={fallbacks} dry_run={DRY_RUN}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
