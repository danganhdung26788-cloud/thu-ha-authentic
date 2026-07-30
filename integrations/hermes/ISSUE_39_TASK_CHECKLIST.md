# Hermes task checklist — Issue #39

## Kiến trúc một bot Hermes

Checklist dùng chính `TELEGRAM_BOT_TOKEN` và vòng `getUpdates` đang chạy trong
`hermes-gateway`. Không có bot thứ hai và không đăng ký webhook.

Adapter Telegram hiện tại tiếp tục sở hữu polling. Bản vá có anchor fail-closed
chỉ chuyển tiếp:

- `callback_query` có prefix `ht:`, `htp:`, `htt:`, `htc:`, `htk:` sang
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

Khi hoàn thành cha có child mở, bot hiển thị toàn bộ child, trạng thái hiện tại
và lựa chọn `Đóng toàn bộ` hoặc `Chọn việc tiếp tục`. Child được chọn tiếp tục
chỉ được tách sau bước `Xác nhận`. Marker `CONTINUE_AFTER_PARENT=TRUE` cũ được
preselect rõ ràng; `Đóng toàn bộ` đặt lựa chọn rỗng tường minh và luôn đóng thật
toàn bộ. `Không thực hiện` luôn yêu cầu xác nhận.

Mọi mutation, gồm START/WAIT/POSTPONE/TRANSFER/subtask/parent, đều có snapshot,
read-back và compensation nếu audit/action thất bại. Không có idempotent success
nếu action và audit chưa hoàn chỉnh.
Work tách mới dùng Google Sheets append với `INSERT_ROWS`, không dùng số hàng
suy đoán từ snapshot; read-back bắt buộc tìm đúng một `WORK_ID`.

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
| `TASK_ONLY_MODE` | Có | Phải là `true`; khóa gửi digest ngoài task-only |
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
4. Xem dry-run chuyển lịch, không thay đổi Scheduled Task:

   ```powershell
   .\integrations\hermes\configure_task_only_schedules.ps1 -Mode Plan
   ```

   Plan phải thấy `TaskflowDailyBriefMorning` và
   `TaskflowDailyBriefMidday` đang được thay bởi hai lịch checklist.

5. Chạy installer `-WhatIf`; kiểm tra adapter và kế hoạch lịch:

   ```powershell
   .\integrations\hermes\install_task_checklist_polling.ps1 `
     -ScheduleMode Plan -WhatIf
   ```

6. Khi owner phê duyệt deploy, chạy với `-Restart -ScheduleMode Apply`.
   Installer compile adapter/module trước restart. Compile lỗi thì khôi phục
   `.issue39.bak` và không restart. Health lỗi sau restart thì rollback adapter,
   restart lại và xác minh health cũ.
7. Sau health PASS, installer đăng ký lịch checklist theo trigger cũ rồi vô hiệu
   hóa `TaskflowDailyBriefMorning` và `TaskflowDailyBriefMidday`. Backup XML nằm
   dưới `D:\HermesAgent\data\backups\issue39-task-only-schedules`.
8. Xác minh runtime container nhận đủ numeric owner/chat, spreadsheet ID và
   `TASK_ONLY_MODE=true`; gateway vẫn dùng `getUpdates` và webhook URL rỗng.
9. Chạy consistency/migration plan chỉ đọc:

   ```powershell
   python -m integrations.hermes.task_checklist consistency
   python -m integrations.hermes.task_checklist migration-plan
   ```

10. Chỉ sau khi duyệt dữ liệu mới chạy `digest --send`.

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
     nếu roster chỉ có `Quản trị hệ thống`, nút Chuyển việc phải bị ẩn;
   - bấm xác nhận lặp không tạo action/audit/update thứ hai;
   - mỗi success chỉ xuất hiện sau khi task, action và audit read-back khớp;
   - duplicate `WORK_ID` không có nút mutation và callback giả mạo bị từ chối.
5. Đóng cha qua checklist, chọn một child tiếp tục và một child đóng theo cha;
   xác nhận ID mới, child terminal, parent 100%, `COMPLETED_AT`,
   `NEXT_ACTION` trống. Kiểm tra marker cũ được preselect, `Đóng toàn bộ` không
   tách child, và một hàng được thêm đồng thời không bị ghi đè. Kiểm tra
   `Không thực hiện` không ghi gì trước xác nhận.
6. Lưu bằng chứng đã che token/secret: callback ID, action ID, audit ID và
   snapshot read-back UAT.

Không chạy smoke thật ở PR này vì chưa được phép deploy/restart và chưa có bot,
chat cùng spreadsheet UAT được cấp.

## Rollback

1. Dừng phát digest; không xóa audit/action.
2. Chạy với đúng `TASK_ONLY_SCHEDULE_BACKUP` đã ghi khi deploy:

   ```powershell
   .\integrations\hermes\rollback_task_checklist_polling.ps1 -WhatIf
   .\integrations\hermes\rollback_task_checklist_polling.ps1 `
     -Restart -ScheduleBackupPath <backup-directory>
   ```

3. Script khôi phục adapter và XML của hai lịch cũ, đồng thời gỡ lịch checklist.
4. Xác minh polling/message pipeline cũ và health.
5. Khôi phục package `tha-integrations` từ backup nếu cần.

Rollback code không tự đảo dữ liệu nghiệp vụ đã được xác nhận. Nếu bất kỳ
mutation nào lỗi giữa chừng, processor bù trừ theo snapshot; nếu không chứng
minh được rollback, action được đánh dấu `NEEDS_RECONCILIATION` và không báo
thành công.
