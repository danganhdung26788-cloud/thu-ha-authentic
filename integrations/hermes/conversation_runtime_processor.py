"""Native-skill adapter for the fast grounded Thu Ha Messenger runtime.

The proven product-selection core is preserved in conversation_runtime_core.py.
This adapter removes custom training-memory injection and lets Hermes use its own
persistent memory and progressive, on-demand skill system. Telegram corrections
change the thu-ha-cosmetics skill; historical training records never enter each
customer prompt.
"""
from __future__ import annotations

import json

from integrations.hermes import conversation_runtime_core as _core

# Re-export the tested core API so existing callers and tests remain compatible.
for _name in dir(_core):
    if not _name.startswith("__"):
        globals()[_name] = getattr(_core, _name)


def read_active_training_memory(limit: int = 0) -> str:
    """Compatibility shim: training history is never injected into customer prompts."""
    del limit
    return ""


def build_conversation_prompt(message: str, context: list[dict[str, object]]) -> str:
    """Build a lean prompt and delegate learned procedures to Hermes skills."""
    return f"""/thu-ha-cosmetics
Bạn là nhân viên tư vấn trực tuyến của Fanpage Thu Hà Authentic.
Hãy dùng skill Thu Hà Cosmetics đã được cập nhật từ các bản sửa của người quản lý.
Không chèn hoặc đọc lịch sử training thô trong lượt chat này.

TIN NHẮN HIỆN TẠI:
{message}

HỘI THOẠI GẦN NHẤT:
{json.dumps(context, ensure_ascii=False, indent=2)}

NGUYÊN TẮC BẮT BUỘC:
- Trả lời trực tiếp bằng tiếng Việt, ngắn gọn, tự nhiên; không xuất phân tích, nhãn hoặc JSON.
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


_core.read_active_training_memory = read_active_training_memory
_core.build_conversation_prompt = build_conversation_prompt


def _sync_test_and_runtime_overrides() -> None:
    """Copy patched wrapper attributes into the preserved core before execution."""
    excluded = {
        "process_new_messages",
        "main",
        "build_conversation_prompt",
        "read_active_training_memory",
        "_sync_test_and_runtime_overrides",
    }
    for name, value in list(globals().items()):
        if name in excluded or name.startswith("__") or not hasattr(_core, name):
            continue
        if callable(value) or name.isupper():
            setattr(_core, name, value)
    _core.build_conversation_prompt = build_conversation_prompt
    _core.read_active_training_memory = read_active_training_memory


def process_new_messages(repo: SheetsRepository) -> tuple[int, int, int]:
    _sync_test_and_runtime_overrides()
    return _core.process_new_messages(repo)


def main() -> int:
    repo = SheetsRepository(FAST_INDEX_ID)
    eligible, processed, fallbacks = process_new_messages(repo)
    print(
        "PASS Hermes native-skill fast-grounded runtime "
        f"eligible={eligible} processed={processed} "
        f"fallbacks={fallbacks} dry_run={DRY_RUN}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
