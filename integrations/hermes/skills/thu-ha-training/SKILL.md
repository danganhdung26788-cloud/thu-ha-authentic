---
name: thu-ha-training
description: Ghi nhận trực tiếp bài học tư vấn Thu Hà Authentic từ Telegram, áp dụng ngay vào active memory có phiên bản và rollback.
version: 1.0.0
author: Thu Hà Authentic
platforms: [linux]
metadata:
  hermes:
    tags: [telegram, training, memory, cosmetics, customer-service]
    category: business
    requires_toolsets: [terminal]
---

# Thu Hà Telegram Training

## Khi sử dụng
Chỉ dùng trong topic Telegram dành riêng cho training của **Đặng Anh Dũng** hoặc **Nông Thu Hà**.
Không dùng skill này trong hội thoại với khách hàng.
Mở chế độ training trong topic bằng lệnh **`/thu-ha-training`**.

## Mục tiêu
Biến bản sửa của người quản lý thành quy tắc đang có hiệu lực ngay từ lượt tư vấn tiếp theo, không phải sửa code cho từng lỗi.

## Cách trainer nhắn

### 1. Ghi nhớ một quy tắc
Ví dụ:

```text
Nhớ: Khi khách đã nói rõ loại sản phẩm và nhu cầu thì chốt ngay 1 mẫu phù hợp nhất từ kho, nêu tên và giá. Chỉ tư vấn sâu thêm khi khách hỏi tiếp.
```

### 2. Sửa một kiểu trả lời sai
Ví dụ:

```text
Sửa:
Sai: Shop hỏi đi hỏi lại ngân sách và chỉ nói các nhóm sản phẩm chung chung.
Đúng: Chốt ngay 1 sản phẩm có tên, giá và lý do ngắn.
Lý do: Khách cần quyết định nhanh.
```

### 3. Hoàn tác bài học gần nhất

```text
Hoàn tác training gần nhất
```

### 4. Xem các bài học đang hoạt động

```text
Xem training đang hoạt động
```

## Quy trình bắt buộc

1. Xác định trainer từ ngữ cảnh Telegram admin:
   - Đặng Anh Dũng → `DANG_ANH_DUNG`
   - Nông Thu Hà → `NONG_THU_HA`
2. Tóm tắt bài học thành JSON với các trường:
   - `trigger`: tình huống áp dụng.
   - `rule`: quy tắc ngắn, rõ, dùng lặp lại.
   - `bad_example`: câu hoặc hành vi cần tránh, có thể để trống.
   - `good_example`: mẫu đúng, có thể để trống.
   - `reason`: lý do, có thể để trống.
3. Không lưu tên, số điện thoại, địa chỉ hoặc dữ liệu cá nhân của khách.
4. Không lưu giá, tồn kho, số lượng hàng hoặc khuyến mại vào memory. Các dữ liệu này luôn phải tra từ Google Sheets.
5. Ghi payload vào một tệp JSON tạm thời bằng công cụ ghi tệp, sau đó chạy:

```bash
cd /opt/data/tha-integrations
python -m integrations.hermes.telegram_training_memory apply \
  --trainer DANG_ANH_DUNG \
  --payload-file /tmp/tha-training-payload.json
```

6. Khi trainer yêu cầu hoàn tác, chạy:

```bash
cd /opt/data/tha-integrations
python -m integrations.hermes.telegram_training_memory rollback \
  --trainer DANG_ANH_DUNG
```

7. Khi trainer yêu cầu xem danh sách, chạy:

```bash
cd /opt/data/tha-integrations
python -m integrations.hermes.telegram_training_memory list
```

## Phản hồi sau khi lưu
Chỉ xác nhận ngắn gọn theo mẫu:

```text
Đã lưu training-v0001 và có hiệu lực từ lượt tư vấn tiếp theo.
```

Nếu dữ liệu training chưa rõ, chỉ hỏi tối đa một câu để làm rõ.
Không giải thích dài dòng về cơ chế nội bộ.

## Bảo vệ hệ thống
- Chỉ chấp nhận trainer đã được phê duyệt.
- Không ghi trực tiếp vào Google Sheets sản phẩm.
- Mỗi bản ghi phải có version, audit và khả năng rollback.
- Không tự suy diễn một câu nói của khách thành quy tắc chung.
