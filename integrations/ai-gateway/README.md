# Hermes AI Gateway Dispatcher G0.4

Worker Node.js 20 điều phối tác vụ owner-scoped từ AI Gateway Control DB sang Hermes qua OpenAI-compatible API.

## Năng lực G0.4

- Chỉ claim đúng owner `danganhdung`, workspace `10_CA_NHAN/danganhdung` và `PRIMARY_AI = Hermes|AI-HERMES`.
- Đọc đúng manifest theo `MANIFEST_ID`; không tìm kiếm toàn Google Drive.
- Claim bằng lock token, retry có kiểm soát và phục hồi lock stale.
- Idempotency: không tạo execution thành công thứ hai cho cùng task đã SUCCESS.
- Đồng bộ trạng thái `TASKS` với `DISPATCH_QUEUE`.
- Ghi đúng schema live của `EXECUTIONS` và `AUDIT_EVENTS`.
- Tạo `HANDOFFS` khi Hermes trả `HANDOFF_REQUIRED: CHATGPT`.
- Tạo `APPROVALS` và chuyển `WAITING_APPROVAL` khi task yêu cầu phê duyệt.
- Ghi heartbeat vào `RUNTIME_CHECKS`.
- Dry-run chỉ đọc tuyệt đối.
- Log rotation có giới hạn dung lượng và số bản giữ lại.

## Cài đặt

```powershell
cd D:\HermesAgent\workspace\thu-ha-authentic\integrations\ai-gateway
npm install
Copy-Item .env.example .env
```

Không commit `.env`, service-account key, API key, `node_modules` hoặc `runtime`.

## Kiểm thử

```powershell
npm.cmd run check
npm.cmd test
npm.cmd run dry-run
```

## Chạy một chu kỳ

```powershell
npm.cmd run once
```

## Chạy liên tục

```powershell
npm.cmd start
```

Scheduled Task trên Windows nên gọi launcher `src/run-with-log-rotation.js` ở chế độ ẩn thay vì redirect log không giới hạn.

## Heartbeat

Worker upsert bản ghi `CHK-HERMES-HEARTBEAT` trong `RUNTIME_CHECKS`, gồm version, commit, queue depth và lỗi gần nhất.

## Recovery

Các hàng `CLAIMED` hoặc `RUNNING` quá `AI_GATEWAY_STALE_LOCK_MS` được đưa về `RETRY_WAIT`, xóa lock token và ghi audit `STALE_LOCK_RECOVERED`.

## Handoff

Hermes yêu cầu chuyển ChatGPT bằng dòng:

```text
HANDOFF_REQUIRED: CHATGPT
```

Worker tạo bản ghi `HANDOFFS` với owner, workspace, manifest ID, phạm vi đọc/ghi, uncertainty và acceptance criteria.

## Approval

Task có `APPROVAL_REQUIRED = TRUE` không được đánh dấu hoàn tất. Worker tạo bản ghi `APPROVALS` trạng thái `PENDING` và chuyển queue/task sang `WAITING_APPROVAL`.

## Dashboard

Tab `DASHBOARD` trong AI Gateway Control DB hiển thị pending, running, completed, waiting approval, handoff, failed/blocked, success rate và heartbeat cuối.

## An toàn

- Không quét toàn Drive.
- Không tự xóa dữ liệu.
- Không claim nhiệm vụ ChatGPT.
- Mọi ghi dữ liệu đều có audit hoặc execution tương ứng.
- Sau triển khai phải chạy smoke test và đọc lại các bảng live.
