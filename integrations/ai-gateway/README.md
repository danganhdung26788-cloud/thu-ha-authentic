# Hermes AI Gateway Dispatcher G0.3

Worker nhẹ chạy trực tiếp bằng Node.js 20, chưa Docker hóa.

## Chức năng

- Đọc `DISPATCH_QUEUE` từ Google Sheets.
- Chỉ nhận tác vụ đúng owner `danganhdung` và workspace `10_CA_NHAN/danganhdung`.
- Claim bằng `LOCK_TOKEN`, tăng số lần thử, ghi `AUDIT_EVENTS`.
- Gọi Hermes qua webhook.
- Chuyển trạng thái `COMPLETED`, `WAITING_APPROVAL`, `RETRY_WAIT`, `BLOCKED_CONNECTOR` hoặc `FAILED_FINALIZATION`.
- Không quét Google Drive và không tự xóa dữ liệu.

## Cài đặt

```powershell
cd D:\HermesAgent\workspace\thu-ha-authentic\integrations\ai-gateway
npm install
Copy-Item .env.example .env
```

Nạp biến môi trường từ `.env` bằng cơ chế runtime hiện có hoặc đặt trực tiếp trong Scheduled Task.

Google service account phải có quyền chỉnh sửa Spreadsheet `AI_GATEWAY_CONTROL_DB_DANGANHDUNG`.

## Kiểm thử

```powershell
npm test
npm run dry-run
```

## Chạy một vòng

```powershell
npm run once
```

## Chạy liên tục

```powershell
npm start
```

Không bật chạy liên tục trước khi cấu hình `GOOGLE_APPLICATION_CREDENTIALS` và `HERMES_DISPATCH_WEBHOOK_URL`.
