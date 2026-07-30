# Hermes task checklist — Issue #39

## Kiến trúc một bot Hermes

Checklist dùng chính `TELEGRAM_BOT_TOKEN` và vòng `getUpdates` đang chạy trong
`hermes-gateway`. Không có bot thứ hai và không đăng ký webhook.

Adapter Telegram hiện tại tiếp tục sở hữu polling. Bản vá có anchor fail-closed
chỉ chuyển tiếp:

- `callback_query` có prefix `ht:`, `htp:`, `htt:`, `htc:` sang
  `task_checklist_polling.handle_callback_query`;
- tin nhắn của owner/chat được xác thực sang
  `maybe_handle_text_message` khi đang có phiên Lùi hạn/Chuyển việc chờ nhập.

Các message và callback khác vẫn theo pipeline Hermes hiện có. State tương tác
được giữ trong SQLite để có timeout, cancel và idempotency qua restart.

Digest chỉ có sáu nhóm nhiệm vụ: `QUÁ HẠN`, `ĐẾN HẠN HÔM NAY`,
`SẮP ĐẾN HẠN`, `ĐANG CHỜ`, `CẦN CHỌN TRẠNG THÁI`,
`CẦN ĐỒNG BỘ DỮ LIỆU`; không đọc thời tiết, tin tức hay nội dung tổng hợp.
Nhóm đồng bộ chỉ có `Chi tiết` và `Kiểm tra đồng bộ`; callback mutation bị chặn
nếu `WORK_ID` không duy nhất.

## Biến môi trường

Không ghi secret thật vào Git.

| Biến | Bắt buộc | Mục đích |
|---|---:|---|
| `GOOGLE_APPLICATION_CREDENTIALS` | Có | ADC/service account có quyền sheet UAT/TaskFlow đã duyệt |
| `TASKFLOW_SPREADSHEET_ID` | Có | Spreadsheet runtime |
| `TELEGRAM_BOT_TOKEN` | Có | Chính bot Hermes hiện đang polling |
| `HERMES_TASK_OWNER_USER_ID` | Có | Numeric Telegram user ID duy nhất được thao tác |
| `HERMES_TASK_CHAT_ID` | Có | Numeric chat ID duy nhất được thao tác |
| `HERMES_TASK_THREAD_ID` | Không | Topic nhận digest |
| `HERMES_TASK_INTERACTION_TIMEOUT_SECONDS` | Không | Timeout state machine, mặc định 300 giây |
| `HERMES_TASK_STATE_DB` | Không | SQLite state, mặc định dưới `/opt/data/tha-telegram` |
| `TASKFLOW_UAT_SPREADSHEET_ID` | UAT thật | Spreadsheet UAT riêng, phải khác production |

Username chỉ dùng để hiển thị trong audit. Quyền dựa hoàn toàn vào
`callback_query.from.id` và `message.chat.id`.

## Deploy sau khi PR được duyệt

PR này không deploy.

1. Backup `D:\HermesAgent\data\tha-integrations`, `/opt/data/.env` và adapter
   `/opt/hermes/plugins/platforms/telegram/adapter.py`.
2. Checkout đúng commit đã duyệt; chạy full test, compile, diff-check và
   gitleaks.
3. Cấu hình các biến bắt buộc trong `/opt/data/.env`.
4. Chạy dry-run PowerShell:

   ```powershell
   .\integrations\hermes\install_task_checklist_polling.ps1 -WhatIf
   ```

5. Chạy installer không restart, kiểm tra diff adapter chỉ có hai delegation
   block được đánh dấu `ISSUE39_TASK_*`.
6. Chạy compile trong container. Khi owner phê duyệt, chạy lại với `-Restart`.
7. Xác minh gateway vẫn dùng `getUpdates`; `getWebhookInfo.url` phải rỗng.
8. Chạy consistency/migration plan chỉ đọc:

   ```powershell
   python -m integrations.hermes.task_checklist consistency
   python -m integrations.hermes.task_checklist migration-plan
   ```

9. Chỉ sau khi duyệt dữ liệu mới chạy `digest --send`.

Installer tạo backup `.issue39.bak`, idempotent, và dừng nếu anchor adapter đã
thay đổi. Không tự sửa các lỗi dữ liệu production.

## Smoke test Telegram UAT

Unit/contract test dùng fake adapter mô phỏng write + read-back Google Sheets,
bao gồm callback lặp và lỗi sau khi đã ghi một child. Không ghi production.

Smoke callback thật chỉ chạy sau khi code được duyệt:

1. Tạo spreadsheet UAT riêng với bốn tab/header đúng hợp đồng và `USERS`.
2. Đặt `TASKFLOW_UAT_SPREADSHEET_ID`; xác minh giá trị khác
   `TASKFLOW_SPREADSHEET_ID`, rồi tạm trỏ runtime smoke vào ID UAT.
3. Dùng chính bot Hermes trong chat/topic UAT được allowlist, không webhook.
4. Gửi card UAT và kiểm tra:
   - Lùi hạn: +1/+3/+7, chọn ngày khác, xác nhận, hủy, timeout;
   - Chuyển việc: chọn người ACTIVE hoặc nhập tên khớp chính xác, xác nhận/hủy;
   - bấm xác nhận lặp không tạo action/audit/update thứ hai;
   - mỗi success chỉ xuất hiện sau khi task, action và audit read-back khớp;
   - duplicate `WORK_ID` không có nút mutation và callback giả mạo bị từ chối.
5. Đóng cha với một child tiếp tục; xác nhận batch plan, ID mới, child terminal,
   parent 100%, `COMPLETED_AT`, `NEXT_ACTION` trống.
6. Lưu bằng chứng đã che token/secret: callback ID, action ID, audit ID và
   snapshot read-back UAT.

Không chạy smoke thật ở PR này vì chưa được phép deploy/restart và chưa có bot,
chat cùng spreadsheet UAT được cấp.

## Rollback

1. Dừng phát digest; không xóa audit/action.
2. Chạy:

   ```powershell
   .\integrations\hermes\rollback_task_checklist_polling.ps1 -WhatIf
   .\integrations\hermes\rollback_task_checklist_polling.ps1 -Restart
   ```

3. Script khôi phục đúng backup adapter trước Issue #39 rồi restart gateway.
4. Xác minh polling/message pipeline cũ và health.
5. Khôi phục package `tha-integrations` từ backup nếu cần.

Rollback code không tự đảo dữ liệu nghiệp vụ đã được xác nhận. Nếu mutation cha
lỗi giữa chừng, processor bù trừ theo snapshot; nếu không chứng minh được
rollback, action được đánh dấu `NEEDS_RECONCILIATION` và không báo thành công.
