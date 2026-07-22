# Chính sách training Hermes Thu Hà Authentic

## Người được duyệt
- Nông Thu Hà.
- Đặng Anh Dũng.

## Dữ liệu training hợp lệ
- Câu Hermes đã trả lời.
- Câu người thật sửa.
- Lý do sửa ngắn gọn.
- Tình huống hoặc sản phẩm liên quan.
- Người sửa và thời gian.

## Vòng đời
1. Ghi nhận bản sửa vào `training/thu-ha-cosmetics/pending/`.
2. Người có quyền duyệt chuyển sang `approved/`.
3. Tạo snapshot trong `versions/` trước khi cập nhật skill hoặc bộ nhớ.
4. Chỉ đưa bài học cô đọng, dùng lặp lại vào `MEMORY.md`.
5. Quy trình, ví dụ dài và kiến thức nghiệp vụ nằm trong skill.
6. Giá, tồn kho và chính sách biến động vẫn nằm trong Google Sheets, không đưa vào memory.

## Không tự học trực tiếp
Hermes không tự biến một câu khách nói thành sự thật, không tự sửa dữ liệu nguồn và không ghi thông tin cá nhân của khách vào bộ nhớ chung.

## Rollback
Mỗi lần áp dụng training cần lưu:
- `version`.
- `trainer`.
- `created_at`.
- `reason`.
- `previous_version`.
- Bản sao tệp trước thay đổi.
