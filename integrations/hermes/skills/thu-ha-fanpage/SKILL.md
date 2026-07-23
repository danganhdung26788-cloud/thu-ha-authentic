---
name: thu-ha-fanpage
description: Điều hành Fanpage Thu Hà Authentic trực tiếp trong Telegram: xem inbox, mở hội thoại, sửa văn phong, duyệt gửi, handoff và tạm dừng theo khách.
version: 1.0.0
author: Thu Hà Authentic
platforms: [linux]
metadata:
  hermes:
    tags: [telegram, fanpage, messenger, operations, approval]
    category: business
    requires_toolsets: [terminal]
---

# Thu Hà Fanpage Operations

## Phạm vi

Chỉ dùng trong topic Telegram điều hành Fanpage của **Đặng Anh Dũng** hoặc **Nông Thu Hà**.
Không dùng skill này trong hội thoại với khách hàng.

## Nguyên tắc bắt buộc

- Chỉ trainer được duyệt mới được thao tác.
- Xem và mở hội thoại là read-only.
- Sửa văn phong chỉ cập nhật bản nháp và chuyển trạng thái `HUMAN_REVIEW`.
- Chỉ `/thu-ha-approve` mới được gửi một tin cụ thể cho khách.
- Không bulk-send toàn bộ hàng đợi.
- Sau mọi thao tác ghi phải đọc lại trạng thái trước khi xác nhận.
- Mọi thay đổi được ghi audit tại `/opt/data/tha-fanpage-ops/control.db`.
- Không hiển thị token hoặc secret.

## Lệnh

### Xem tin đang chờ

```text
/thu-ha-inbox
```

Thực thi:

```bash
cd /opt/data/tha-integrations
python -m integrations.hermes.telegram_fanpage_ops inbox \
  --trainer DANG_ANH_DUNG --limit 10
```

### Mở hội thoại

```text
/thu-ha-open MESSAGE_ID
```

Thực thi:

```bash
cd /opt/data/tha-integrations
python -m integrations.hermes.telegram_fanpage_ops open \
  --trainer DANG_ANH_DUNG --selector "MESSAGE_ID" --limit 10
```

### Sửa văn phong

Người quản lý có thể nói tự nhiên, ví dụ:

```text
/thu-ha-rewrite MESSAGE_ID Viết ngắn hơn, tự nhiên hơn, chốt ngay một sản phẩm và không hỏi lại ngân sách.
```

Thực thi:

```bash
cd /opt/data/tha-integrations
python -m integrations.hermes.telegram_fanpage_ops rewrite \
  --trainer DANG_ANH_DUNG \
  --selector "MESSAGE_ID" \
  --instruction "YÊU CẦU SỬA"
```

Sau khi chạy, phải trả đúng bản nháp mới và nói rõ `STATUS=HUMAN_REVIEW`.

### Duyệt và gửi khách

```text
/thu-ha-approve MESSAGE_ID
```

Thực thi:

```bash
cd /opt/data/tha-integrations
python -m integrations.hermes.telegram_fanpage_ops approve \
  --trainer DANG_ANH_DUNG --selector "MESSAGE_ID"
```

Chỉ xác nhận thành công khi đọc lại thấy `STATUS=SENT`.

### Chuyển Thu Hà xử lý

```text
/thu-ha-handoff MESSAGE_ID lý do
```

Thực thi:

```bash
cd /opt/data/tha-integrations
python -m integrations.hermes.telegram_fanpage_ops handoff \
  --trainer DANG_ANH_DUNG \
  --selector "MESSAGE_ID" \
  --reason "LÝ DO"
```

### Tạm dừng hoặc bật lại tự trả lời theo khách

```text
/thu-ha-pause CUSTOMER_ID lý do
/thu-ha-resume CUSTOMER_ID
```

Thực thi bằng các command `pause` hoặc `resume` tương ứng.
Tin mới của khách đang pause vẫn được ghi vào hàng đợi nhưng không chạy tự trả lời.

### Xem audit

```text
/thu-ha-audit
```

Thực thi:

```bash
cd /opt/data/tha-integrations
python -m integrations.hermes.telegram_fanpage_ops audit \
  --trainer DANG_ANH_DUNG --limit 20
```

## Cách dùng trong topic

Khi trainer yêu cầu “sửa câu này ngắn hơn”, phải dùng MESSAGE_ID của hội thoại đang mở gần nhất trong topic. Nếu chưa xác định được MESSAGE_ID, hỏi đúng một câu để chọn tin cần sửa.
