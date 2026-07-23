---
name: thu-ha-training
description: Dạy Hermes từ Telegram bằng cách tự cập nhật skill Thu Hà Cosmetics qua skill_manage; có snapshot, audit, kiểm tra và rollback nhưng không đưa lịch sử training vào prompt khách hàng.
version: 2.0.0
author: Thu Hà Authentic
platforms: [linux]
metadata:
  hermes:
    tags: [telegram, training, skills, self-improving, cosmetics]
    category: business
    requires_toolsets: [skills, terminal]
---

# Thu Hà Telegram Skill Training

## Phạm vi
Chỉ dùng trong topic Telegram training của **Đặng Anh Dũng** hoặc **Nông Thu Hà**. Không dùng skill này trong hội thoại với khách hàng.

Mục tiêu là để Hermes tự cải thiện **skill thủ tục**, không tạo một danh sách memory ngày càng dài.

## Nguyên tắc kiến trúc

- Dùng `skill_view` để đọc đúng phần hiện hành của `thu-ha-cosmetics`.
- Dùng `skill_manage patch` là lựa chọn mặc định; dùng `write_file` khi cần tạo reference mới.
- Thay thế hoặc cô đọng quy tắc cũ; không nối nguyên văn mọi bản sửa.
- Lịch sử, snapshot và audit nằm tại `/opt/data/training/thu-ha-cosmetics/skill-learning/` và không được tải vào prompt Messenger.
- Không lưu giá, tồn kho, khuyến mại, tên khách, số điện thoại, địa chỉ hoặc dữ liệu cá nhân vào skill.

## Cách trainer nhắn

### Ghi một bài học

```text
Nhớ: Khi khách đã nói rõ loại sản phẩm và nhu cầu thì chốt ngay 1 mẫu phù hợp nhất từ kho, nêu tên và giá. Khách hỏi thêm thì mới tư vấn sâu.
```

### Sửa cách trả lời

```text
Sửa:
Sai: Hỏi lại ngân sách và chỉ nói các nhóm sản phẩm chung chung.
Đúng: Chốt ngay một sản phẩm có tên, giá và lý do ngắn.
Lý do: Khách cần quyết định nhanh.
```

### Xem thay đổi

```text
Xem skill đã học
```

### Hoàn tác

```text
Hoàn tác lần học gần nhất
```

## Quy trình bắt buộc khi áp dụng bài học

1. Xác định trainer:
   - Đặng Anh Dũng → `DANG_ANH_DUNG`
   - Nông Thu Hà → `NONG_THU_HA`
2. Tóm tắt nội dung sửa thành một quy tắc thủ tục ngắn, có trigger rõ ràng.
3. Chọn đúng đích:
   - tư vấn, chọn, chốt, giá, tồn kho, cách dùng → `references/sales-flow.md`;
   - giọng điệu, độ dài, xưng hô, lặp câu → `references/tone-and-dialogue.md`;
   - an toàn hoặc handoff → chỉ sửa `references/safety-and-handoff.md` khi trainer xác nhận rõ;
   - quy trình mới hoàn toàn → tạo một reference tập trung, không mở rộng `SKILL.md` quá mức.
4. Ghi lý do vào `/tmp/tha-skill-learning-reason.txt`.
5. Chụp snapshot trước khi sửa:

```bash
cd /opt/data/tha-integrations
python -m integrations.hermes.telegram_skill_learning snapshot \
  --trainer DANG_ANH_DUNG \
  --reason-file /tmp/tha-skill-learning-reason.txt
```

6. Lấy `transaction_id` từ kết quả.
7. Dùng `skill_view("thu-ha-cosmetics", "references/<file>.md")` để đọc bản hiện hành.
8. Dùng `skill_manage`:
   - ưu tiên `patch` để thay quy tắc cũ hoặc bổ sung vào đúng mục;
   - không append bản sửa nguyên văn;
   - không tạo các mục `training-v...` trong skill;
   - nếu quy tắc tương tự đã tồn tại, cập nhật quy tắc đó thay vì thêm bản mới.
9. Kiểm tra và kích hoạt:

```bash
cd /opt/data/tha-integrations
python -m integrations.hermes.telegram_skill_learning verify \
  --trainer DANG_ANH_DUNG \
  --transaction-id <TRANSACTION_ID>
```

10. Nếu verify thất bại, khôi phục đúng snapshot đang chờ:

```bash
cd /opt/data/tha-integrations
python -m integrations.hermes.telegram_skill_learning abort \
  --trainer DANG_ANH_DUNG \
  --transaction-id <TRANSACTION_ID>
```

## Xem và hoàn tác

Xem lịch sử kiểm toán, không tải nó vào hội thoại khách:

```bash
cd /opt/data/tha-integrations
python -m integrations.hermes.telegram_skill_learning list
```

Hoàn tác skill về trước lần học đã kích hoạt gần nhất:

```bash
cd /opt/data/tha-integrations
python -m integrations.hermes.telegram_skill_learning rollback \
  --trainer DANG_ANH_DUNG
```

## Phản hồi cho trainer

Sau khi verify PASS, chỉ xác nhận ngắn:

```text
Đã cập nhật skill Thu Hà Cosmetics và có hiệu lực từ phiên tư vấn tiếp theo.
```

Nếu nội dung chưa đủ rõ, hỏi tối đa một câu. Không giải thích dài dòng về cơ chế nội bộ.
