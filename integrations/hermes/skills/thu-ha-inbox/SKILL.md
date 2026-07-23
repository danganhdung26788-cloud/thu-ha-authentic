---
name: thu-ha-inbox
description: Điều hành Fanpage Thu Hà Authentic trong Telegram: xem tin khách, sửa văn phong của bản nháp, gửi thủ công, giữ lại hoặc chuyển Thu Hà xử lý; có audit và không tạo Telegram poller thứ hai.
version: 1.0.0
author: Thu Hà Authentic
platforms: [linux]
metadata:
  hermes:
    tags: [telegram, messenger, fanpage, inbox, operator, cosmetics]
    category: business
    requires_toolsets: [terminal, skills]
---

# Điều hành Fanpage Thu Hà trong Telegram

## Mục tiêu

Topic này là bảng điều hành trực tiếp cho Fanpage. Tin khách mới được Meta webhook đưa vào `FANPAGE_QUEUE`, Hermes soạn bản nháp bằng dữ liệu gốc POS, rồi hệ thống đẩy thẻ điều hành vào topic này.

Mặc định dùng chế độ **duyệt trước khi gửi**. Không gửi khách chỉ vì đã tạo nháp.

## Nguyên tắc an toàn

- Không tạo bot hoặc Telegram polling process mới.
- Chỉ gửi khách khi **Đặng Anh Dũng** hoặc **Nông Thu Hà** ra lệnh rõ: `Gửi`.
- Mỗi ticket chỉ được gửi một lần; trạng thái `SENT` không được gửi lại.
- Không sửa tên sản phẩm, giá, tồn kho hoặc dữ kiện khi người điều hành chỉ yêu cầu đổi văn phong.
- Một lần sửa câu trong inbox chỉ tác động ticket hiện tại.
- Chỉ cập nhật skill lâu dài khi người điều hành nói rõ `hãy chuẩn hóa`, `ghi thành quy tắc`, hoặc ý tương đương.
- Không hiện token, App Secret, Page token hoặc dữ liệu xác thực.

## Thẻ điều hành

Mỗi tin có mã dạng `FP-<số dòng>`, ví dụ `FP-36`. Luôn giữ mã này trong câu trả lời để tránh thao tác nhầm khách.

Khi có thẻ mới, trình bày ngắn:

```text
🔔 FP-36 — khách mới
Khách: <tin nhắn>
Hermes dự kiến: <bản nháp>
Sản phẩm: <PRODUCT_KEY hoặc NONE>

Lệnh nhanh: Gửi | Viết ngắn hơn | Dùng câu này: ... | Chuyển Thu Hà
```

## Lệnh tự nhiên

### Xem tin đang chờ

Khi người điều hành nói `xem tin mới`, `mở inbox`, `có khách nào đang chờ`:

```bash
cd /opt/data/tha-integrations
python -m integrations.hermes.telegram_fanpage_control \
  --format json list --limit 10
```

Tóm tắt từng ticket, ưu tiên ticket mới nhất.

### Mở một ticket

Với `mở FP-36` hoặc khi người điều hành reply vào thẻ `FP-36`:

```bash
cd /opt/data/tha-integrations
python -m integrations.hermes.telegram_fanpage_control \
  --format json show --row 36
```

Nếu không nêu ticket, dùng ticket gần nhất trong topic; khi chưa xác định chắc, hỏi đúng một câu để chọn ticket.

### Sửa văn phong một lần

Các câu như:

- `viết ngắn hơn`
- `mềm hơn`
- `tự nhiên hơn`
- `xưng chị em`
- `chốt sản phẩm ngay, đừng hỏi lại`

là sửa **ticket hiện tại**, không cập nhật skill lâu dài.

Ghi yêu cầu nguyên văn vào `/tmp/tha-control-instruction.txt`, rồi chạy:

```bash
cd /opt/data/tha-integrations
python -m integrations.hermes.telegram_fanpage_control \
  --operator DANG_ANH_DUNG \
  --format json rewrite \
  --row <ROW> \
  --instruction-file /tmp/tha-control-instruction.txt
```

Sau khi thành công, trả lại đúng bản nháp mới và mã ticket. Không tự gửi.

### Dùng nguyên câu người điều hành soạn

Khi người điều hành nói `Dùng câu này: ...`, ghi phần sau dấu hai chấm vào `/tmp/tha-control-draft.txt`, rồi chạy:

```bash
cd /opt/data/tha-integrations
python -m integrations.hermes.telegram_fanpage_control \
  --operator DANG_ANH_DUNG \
  --format json set-draft \
  --row <ROW> \
  --draft-file /tmp/tha-control-draft.txt
```

Xác nhận ngắn: `Đã thay bản nháp FP-<ROW>. Chưa gửi khách.`

### Gửi khách

Chỉ khi lệnh rõ `Gửi`, `gửi câu này`, `duyệt gửi` và đã xác định đúng ticket:

```bash
cd /opt/data/tha-integrations
python -m integrations.hermes.telegram_fanpage_control \
  --operator DANG_ANH_DUNG \
  --format json send --row <ROW>
```

Sau khi kết quả `status=SENT`, xác nhận:

```text
Đã gửi FP-<ROW> cho khách.
```

Không chạy lại lệnh gửi với ticket đã `SENT`.

### Chuyển Thu Hà

Khi người điều hành nói `chuyển Thu Hà`, `để người xử lý`, hoặc yêu cầu handoff:

```bash
cd /opt/data/tha-integrations
python -m integrations.hermes.telegram_fanpage_control \
  --operator DANG_ANH_DUNG \
  --format json handoff \
  --row <ROW> \
  --reason "Cần Thu Hà xử lý trực tiếp"
```

Thao tác này không tự gửi nội dung cho khách.

### Giữ lại

Khi người điều hành nói `giữ lại`, `chưa gửi`, `để xem thêm`:

```bash
cd /opt/data/tha-integrations
python -m integrations.hermes.telegram_fanpage_control \
  --operator DANG_ANH_DUNG \
  --format json hold \
  --row <ROW> \
  --reason "Người điều hành yêu cầu giữ lại"
```

### Chuẩn hóa thành skill lâu dài

Khi người điều hành nói rõ `hãy chuẩn hóa`, `ghi thành quy tắc`, `lần sau luôn trả lời như vậy`:

1. Không tự gửi ticket hiện tại.
2. Dùng quy trình snapshot → `skill_view` → `skill_manage patch` → verify của skill `thu-ha-training`.
3. Quy tắc văn phong ghi vào `thu-ha-cosmetics/references/tone-and-dialogue.md`.
4. Quy tắc chốt sản phẩm hoặc quy trình bán hàng ghi vào `references/sales-flow.md`.
5. Sau verify PASS, xác nhận ngắn: `Đã chuẩn hóa skill và áp dụng từ lượt tư vấn tiếp theo.`

Không đưa lịch sử sửa câu vào prompt khách hàng.

## Xử lý lỗi

- Không đọc được queue: báo `Chưa đọc được FANPAGE_QUEUE; không có câu nào được gửi.`
- Sửa nháp lỗi: giữ nguyên bản cũ và báo ngắn.
- Meta gửi lỗi: trạng thái phải là `SEND_FAILED`; không nói đã gửi.
- Ticket đã gửi: báo `Ticket này đã SENT, không gửi lại.`
