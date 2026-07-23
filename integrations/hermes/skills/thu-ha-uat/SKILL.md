---
name: thu-ha-uat
description: Kiểm thử nội bộ trợ lý Thu Hà Authentic trên Telegram bằng dữ liệu gốc POS Web App; chỉ đọc, không ghi hàng đợi và không gửi Messenger.
version: 1.0.0
author: Thu Hà Authentic
platforms: [linux]
metadata:
  hermes:
    tags: [telegram, uat, cosmetics, products, read-only]
    category: business
    requires_toolsets: [terminal]
---

# Thu Hà Telegram UAT

## Mục tiêu

Dùng trong topic Telegram nội bộ của **Đặng Anh Dũng** hoặc **Nông Thu Hà** để thử đúng luồng tư vấn sản phẩm trước khi bật auto-send.

Skill này:

- đọc trực tiếp bảng `Products` của Web App/POS Thu Hà Authentic;
- dùng cùng lõi chọn sản phẩm và skill `thu-ha-cosmetics` như Messenger;
- trả bản nháp tự nhiên kèm `PRODUCT_KEY`, tồn kho và nguồn dữ liệu;
- không ghi `FANPAGE_QUEUE`;
- không gọi Meta API;
- không gửi bất kỳ nội dung nào cho khách.

## Phân biệt với training

- `/thu-ha-uat`: thử hội thoại và dữ liệu thật, không học.
- `/thu-ha-training`: sửa cách làm và cập nhật skill.

Nếu trainer gửi nội dung dạng `Sai/Đúng/Lý do` trong UAT, nhắc chuyển sang `/thu-ha-training`.

## Quy trình cho mỗi tin nhắn thử nghiệm

1. Hiểu tin nhắn hiện tại như một tin nhắn khách hàng.
2. Ghi nguyên văn tin nhắn vào `/tmp/tha-uat-message.txt`.
3. Tạo `/tmp/tha-uat-context.json` từ tối đa 12 lượt UAT gần nhất trong topic. Mỗi phần tử dùng dạng:

```json
{
  "customer": "tin khách",
  "assistant": "bản nháp trước",
  "intent": "PRODUCT_CONSULTATION",
  "product_key": "P000181",
  "reliable": true
}
```

Khi chưa có lượt trước, ghi `[]`.

4. Chạy đúng lệnh:

```bash
cd /opt/data/tha-integrations
python -m integrations.hermes.telegram_uat \
  --message-file /tmp/tha-uat-message.txt \
  --context-file /tmp/tha-uat-context.json \
  --format json
```

5. Không tự sửa, rút gọn hoặc thay thế dữ liệu JSON trả về.
6. Trả lời trainer theo mẫu:

```text
<reply tự nhiên lấy nguyên từ trường reply>

🧪 UAT nội bộ — không gửi khách
PRODUCT_KEY=<product_key hoặc NONE>
SOURCE=POS_WEBAPP_PRODUCTS_SOURCE_OF_TRUTH
INTENT=<intent>
STOCK=<current_stock> | <stock_status>
SEND_TO_CUSTOMER=FALSE
```

Nếu có `image_url`, thêm liên kết ảnh ở dòng cuối.

## Điều kiện đạt

Khi khách đã nêu rõ nhu cầu sản phẩm:

- phải có tên sản phẩm thật trong `reply`;
- phải có giá thật trong `reply`;
- phải có `PRODUCT_KEY`;
- `SOURCE` phải là `POS_WEBAPP_PRODUCTS_SOURCE_OF_TRUTH`;
- không hỏi lại ngân sách khi khách nói “bao nhiêu cũng được”;
- `SEND_TO_CUSTOMER` luôn là `FALSE`.

## Lỗi dữ liệu

Nếu lệnh lỗi hoặc nguồn gốc không đọc được, nói ngắn:

```text
UAT chưa đọc được dữ liệu gốc của Web App. Không có nội dung nào được gửi cho khách.
```

Không được bịa tên, giá, tồn kho hoặc mã sản phẩm.
