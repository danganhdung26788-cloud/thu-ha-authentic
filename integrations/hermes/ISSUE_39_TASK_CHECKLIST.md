# Hermes task checklist — Issue #39

## Phạm vi

Runner `integrations.hermes.task_checklist` chỉ đọc và phát sáu nhóm nhiệm vụ:
`QUÁ HẠN`, `ĐẾN HẠN HÔM NAY`, `SẮP ĐẾN HẠN`, `ĐANG CHỜ`,
`CẦN CHỌN TRẠNG THÁI`, `CẦN ĐỒNG BỘ DỮ LIỆU`. Module không đọc nguồn
thời tiết, tin tức hay nội dung tổng hợp.

Mỗi card dùng Telegram `callback_data` thật cho bảy nút. Endpoint callback là
`POST /webhook/telegram-task-checklist` trên sidecar FastAPI hiện có.

## Biến môi trường

Không ghi secret thật vào Git.

| Biến | Bắt buộc | Mục đích |
|---|---:|---|
| `GOOGLE_APPLICATION_CREDENTIALS` | Có | Service account/ADC có quyền TaskFlow cần thiết |
| `TASKFLOW_SPREADSHEET_ID` | Có | TaskFlow DB; có default theo hợp đồng Issue #39 |
| `HERMES_TASK_BOT_TOKEN` | Khi gửi thật | Bot riêng cho checklist/callback |
| `HERMES_TASK_CHAT_ID` | Khi gửi thật | Chat nhận checklist |
| `HERMES_TASK_THREAD_ID` | Không | Topic nhận checklist |
| `HERMES_TASK_CALLBACK_SECRET` | Có | Secret token của Telegram webhook |

Owner callback bị khóa cứng ở username `danganhdung`. Không có cấu hình mở rộng
đa người dùng trong Issue #39.

## Deploy sau khi PR được duyệt

1. Backup `D:\HermesAgent\data\tha-integrations` và file cấu hình runtime.
2. Checkout commit đã duyệt; chạy full test và secret scan.
3. Chạy `integrations\hermes\install_and_dry_run.ps1`. Script sao chép package
   vào data volume và chạy test/dry-run.
4. Cấu hình các biến trên trong `/opt/data/.env`.
5. Khởi động lại sidecar FastAPI hiện có.
6. Cho reverse proxy công khai đúng path
   `/webhook/telegram-task-checklist`, không mở thêm endpoint nội bộ.
7. Đăng ký webhook của **bot checklist riêng** trỏ tới
   `https://<host>/webhook/telegram-task-checklist` với
   `secret_token=HERMES_TASK_CALLBACK_SECRET`. Không dùng bot mà Hermes gateway
   hiện đang polling: Telegram webhook sẽ xung đột với `getUpdates`. Không ghi
   URL/token thật vào log.
8. Chạy consistency và migration plan chỉ-đọc trước:

   ```powershell
   python -m integrations.hermes.task_checklist consistency
   python -m integrations.hermes.task_checklist migration-plan
   ```

9. Chỉ sau khi review plan, phát checklist:

   ```powershell
   python -m integrations.hermes.task_checklist digest --send
   ```

Không tự sửa dữ liệu `CV-2026-0006`, bản ghi trùng hoặc quan hệ cha–con đang
thiếu căn cứ nghiệp vụ. `migration-plan` không có chế độ apply.

## Smoke test Telegram

1. Unit smoke không ghi production:

   ```powershell
   python -m unittest -v integrations.hermes.tests.test_task_checklist.TaskChecklistTests.test_webhook_secret_and_owner_callback_smoke_without_live_writes
   ```

2. Chạy `migration-plan` và `digest` không có `--send`; cả hai chỉ đọc TaskFlow.
3. Trên môi trường UAT/fake data, gửi một card cho owner `danganhdung`.
4. Bấm `Đang làm`; xác nhận đúng một dòng `HERMES_ACTION_QUEUE`, đúng một dòng
   `ACTIVITY_LOG`, `WORK_ITEMS.STATUS=IN_PROGRESS`, và response chỉ báo thành
   công sau read-back.
5. Bấm lại cùng nút; xác nhận không có update/audit thứ hai.
6. Đóng cha có một child gắn `CONTINUE_AFTER_PARENT=TRUE`; xác nhận child cũ
   terminal, một `WORK_ID` độc lập mới được tạo, parent có `COMPLETED_AT`,
   `PROGRESS_PERCENT=100`, `NEXT_ACTION` trống.
7. `Lùi hạn` và `Chuyển việc` chỉ trả `NEEDS_INPUT` khi chưa có ngày/người nhận;
   hệ thống không tự đoán nghiệp vụ.

## Rollback

1. Dừng phát checklist và bỏ Telegram webhook.
2. Khôi phục package `tha-integrations` từ backup của commit trước.
3. Khởi động lại sidecar; xác minh `/health`.
4. Không xóa hàng audit/action đã tạo. Nếu cần hoàn tác dữ liệu TaskFlow, dùng
   `OLD_VALUE`, `DETAILS_JSON`, `ACTION_ID` để lập change set riêng, review thủ
   công rồi mới áp dụng.
5. Chạy lại full regression của commit rollback.

Rollback code không tự đảo ngược dữ liệu nghiệp vụ vì có thể ghi đè cập nhật hợp
lệ xảy ra sau callback.
