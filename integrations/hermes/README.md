# Hermes direct integration — Thu Hà Authentic

Gói này loại n8n khỏi đường vận hành. n8n chỉ còn là tài liệu tham khảo logic cũ.

## Phạm vi

- `telegram_dispatcher.py`: đọc `TELEGRAM_QUEUE`, gửi Telegram theo topic, chống gửi lặp bằng SQLite, cập nhật hàng đợi và append `RUN_LOG`.
- `meta_messenger_bridge.py`: xác minh webhook Meta GET/POST, kiểm tra `X-Hub-Signature-256`, chống trùng `message.mid`, bỏ qua echo/delivery/read và ghi tin nhắn văn bản vào `FANPAGE_QUEUE`.
- Chế độ phản hồi giữ nguyên `DRAFT_ONLY`; adapter Meta chưa tự gửi câu trả lời AI.
- Không ghi database bán hàng nguồn.
- Không lưu secret trong Git.

## Đích Telegram tạm thời

- User/Chat ID: `8654262919` — Dũng Đặng.
- Digest: thread `4592`.
- Cảnh báo: thread `4578`.
- Đây là ủy quyền tạm, không phải định danh của Nông Thu Hà.
- Phải thu hồi sau khi Thu Hà đăng ký Telegram và smoke test bàn giao PASS.

## Cài trong Hermes

Sao chép thư mục này vào `/opt/data/integrations/thu-ha-authentic` hoặc mount read-only từ workspace.

```bash
python -m pip install -r requirements.txt
```

Secret chỉ đặt trong `/opt/data/.env`.

## Smoke test Telegram

1. Giữ `THA_TELEGRAM_DRY_RUN=true`.
2. Chạy `python telegram_dispatcher.py`.
3. Xác nhận hai bản ghi test chuyển thành `READY_TO_SEND`.
4. Đặt `THA_TELEGRAM_DRY_RUN=false`.
5. Chạy lại một lần.
6. Xác nhận digest đến thread `4592`, alert đến thread `4578`, queue thành `SENT`, `RUN_LOG` có route `RT-THA-TELEGRAM-NOTIFY-01`.
7. Chỉ sau đó mới chuyển route từ `PREPARED_NOT_ACTIVE` sang `ACTIVE_TEMPORARY`.

## Meta bridge

```bash
uvicorn meta_messenger_bridge:app --host 0.0.0.0 --port 8788
```

Reverse proxy chỉ công khai `/webhook/meta-messenger`.

Adapter giai đoạn đầu chỉ ghi `FANPAGE_QUEUE`, phù hợp UAT an toàn.

## Kiểm thử

```bash
python -m unittest integrations.hermes.tests.test_integration
```

## Điều kiện nghiệm thu

- Telegram dry-run PASS.
- Digest và alert đến đúng topic.
- Dedupe còn hiệu lực sau restart.
- Meta GET đúng token trả challenge/200; sai token trả 403.
- Meta POST sai chữ ký trả 403.
- Một `message.mid` chỉ được nhập một lần.
- Log không chứa token, Authorization header hoặc sender ID đầy đủ.
- n8n không nằm trong runtime path.
