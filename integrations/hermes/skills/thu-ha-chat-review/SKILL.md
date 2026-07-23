---
name: thu-ha-chat-review
description: Đọc lại đoạn chat Fanpage Thu Hà Authentic ngay trong Telegram để rà soát, góp ý và bổ sung bài học vào luồng thu-ha-uat; nguồn đọc là FANPAGE_QUEUE, không phải lịch sử Telegram.
version: 1.0.0
author: Thu Hà Authentic
platforms: [linux]
metadata:
  hermes:
    tags: [telegram, fanpage, messenger, review, learning]
    category: business
    requires_toolsets: [terminal, skills]
---

# Rà soát đoạn chat Fanpage

## Mục tiêu

Topic này là **nguồn học bổ sung** cho luồng chính `thu-ha-uat`.

- Hermes vẫn trò chuyện với khách trên Fanpage theo runtime hiện tại.
- Topic này chỉ đọc lại đoạn chat để phân tích và nhận góp ý.
- Không chuyển Fanpage sang chế độ chờ duyệt.
- Không gửi, sửa hoặc xóa tin nhắn khách hàng.
- Không tìm câu trả lời trong lịch sử phiên Telegram khi người điều hành yêu cầu xem chat Fanpage.

## Nguồn bắt buộc

Mọi yêu cầu có ý nghĩa như:

- `lấy đoạn chat gần nhất hôm nay`
- `xem lại chat với Đặng Dũng`
- `đọc cuộc trò chuyện Fanpage mới nhất`
- `xem Hermes vừa trả lời khách thế nào`

phải đọc `FANPAGE_QUEUE` bằng lệnh dưới đây. Không dùng `Searching past sessions`.

## Đọc đoạn chat gần nhất trong hôm nay

```bash
cd /opt/data/tha-integrations
python -m integrations.hermes.telegram_fanpage_review review \
  --today --limit 40
```

## Tìm theo tên, ID hoặc nội dung đã xuất hiện

Ví dụ người điều hành nói `xem lại chat với Đặng Dũng`:

```bash
cd /opt/data/tha-integrations
python -m integrations.hermes.telegram_fanpage_review review \
  --today --selector "Đặng Dũng" --limit 40
```

`--selector` được đối chiếu không phân biệt hoa thường và dấu tiếng Việt với:

- `CUSTOMER_ID`
- `CUSTOMER_NAME`
- nội dung khách nhắn
- nội dung Hermes đã trả lời
- `MESSAGE_ID`

Nếu tên khách chưa được Meta ghi vào `CUSTOMER_NAME`, Hermes vẫn có thể tìm theo tên xuất hiện trong nội dung đặt hàng. Khi không có kết quả, phải đề nghị người điều hành cung cấp `CUSTOMER_ID`, một câu khách đã nhắn hoặc ngày cần tìm; không được quay sang lịch sử Telegram.

## Ngày cụ thể

```bash
cd /opt/data/tha-integrations
python -m integrations.hermes.telegram_fanpage_review review \
  --date 2026-07-23 --selector "Đặng Dũng" --limit 40
```

## Cách trả kết quả

1. Hiển thị nguyên mạch theo thời gian:
   - `Khách: ...`
   - `Hermes: ...`
2. Sau transcript, chờ người điều hành góp ý.
3. Không tự thay đổi skill chỉ vì đã đọc đoạn chat.
4. Khi người điều hành nói rõ `ghi nhớ`, `hãy chuẩn hóa`, `lần sau làm như vậy`:
   - rút ra quy tắc ngắn, không lưu số điện thoại, địa chỉ hoặc dữ liệu cá nhân;
   - chuyển quy tắc đã xác nhận vào quy trình hiện hữu `/thu-ha-training`;
   - giữ `thu-ha-uat` là luồng học chính;
   - ghi nguồn là `FANPAGE_CHAT_REVIEW_TELEGRAM`.
5. Nếu góp ý mâu thuẫn quy tắc hiện có, nêu mâu thuẫn và hỏi người điều hành chọn; không tự ghi đè.

## Phạm vi cấm

- Không gọi Meta outbound.
- Không cập nhật `FANPAGE_QUEUE`.
- Không đổi `THA_REPLY_MODE` hoặc `THA_META_AUTO_SEND`.
- Không tạo Telegram poller thứ hai.
- Không hiển thị token/secret.
- Không lưu nguyên văn dữ liệu cá nhân vào skill học tập.
