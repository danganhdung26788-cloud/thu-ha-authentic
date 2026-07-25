# Phase 5.1 — TalkFlow Routes V2

Runner Python độc lập cho ba route:

- `RT-DUE-CHECK-01`
- `RT-FILE-SYNC-01`
- `RT-OPS-HEALTH-01`

Runner chỉ đọc các range nguồn đã khóa. API ghi duy nhất được triển khai là append
`HERMES_CONTROL_DB/RUN_LOG!A:J`; ngay sau append, runner đọc lại chính
`updatedRange` và xác minh `RUN_ID`, `ROUTE_ID`, `STATUS`.

## Hợp đồng dữ liệu

| Route | Spreadsheet | Range nguồn |
|---|---|---|
| `RT-DUE-CHECK-01` | `1l2P0qqojyEKXAiL4cOTwRgJ_1oV5WJQgIQ3mW9zDc48` | `WORK_ITEMS!A1:AT2000` |
| `RT-FILE-SYNC-01` | `1l2P0qqojyEKXAiL4cOTwRgJ_1oV5WJQgIQ3mW9zDc48` | `MD_SYNC_STATUS!A1:K1000` |
| `RT-OPS-HEALTH-01` | `1a4_5bzNDbXiHdr2Nj76QHm6LY85wCKqI7RWTt-O6G18` | `SYNC_JOBS!A1:Z1000`, `BACKUP_LOGS!A1:Z1000`, `ERROR_LOGS!A1:Z1000` |

Đích audit cố định:
`1PjdF0aP8Ar7Nvp7BkX8jcHrjsoGOoMboZQLow_z_lzs` / `RUN_LOG!A:J`.

Với OPS Health, `ITEMS_READ` là tổng số bản ghi dữ liệu (không tính header) đọc
được từ cả ba tab. Tab trống, timestamp không hợp lệ, hoặc dữ liệu cũ hơn ngưỡng
đều tạo `PASS_WITH_WARNING`. Ngưỡng mặc định là 48 giờ.

## Cài phụ thuộc và cấu hình

```powershell
python -m pip install -r integrations/hermes-routes/requirements.txt
$env:GOOGLE_APPLICATION_CREDENTIALS = "C:\secure\google-credentials.json"
$env:HERMES_OPS_STALE_HOURS = "48" # tùy chọn
```

Credential phải có quyền đọc TalkFlow DB và OPS DB, cùng quyền append/read-back
`HERMES_CONTROL_DB/RUN_LOG`. Không đặt credential trong repository.

## Lệnh chạy

```powershell
python integrations/hermes-routes/src/taskflow_routes_v2.py self-test
python integrations/hermes-routes/src/taskflow_routes_v2.py run --route RT-DUE-CHECK-01
python integrations/hermes-routes/src/taskflow_routes_v2.py run --route RT-FILE-SYNC-01
python integrations/hermes-routes/src/taskflow_routes_v2.py run --route RT-OPS-HEALTH-01
```

Fresh smoke test (đọc live và append một dòng có nhãn `SMOKE_TEST`):

```powershell
python integrations/hermes-routes/src/taskflow_routes_v2.py smoke --route RT-DUE-CHECK-01
python integrations/hermes-routes/src/taskflow_routes_v2.py smoke --route RT-FILE-SYNC-01
python integrations/hermes-routes/src/taskflow_routes_v2.py smoke --route RT-OPS-HEALTH-01
```

## Unit test

```powershell
python -m unittest discover -s integrations/hermes-routes/tests -p "test_*.py" -v
```

`windows/install_taskflow_routes_v2.ps1` đăng ký idempotent ba Scheduled Task
hằng ngày lúc 07:30, 08:00 và 09:00, chạy ẩn với `MultipleInstances=IgnoreNew`.
Không chạy installer trước khi unit test và smoke test được phê duyệt.

## Trạng thái legacy tách biệt

```text
RT-DUE-CHECK-01:
Existing business logic found in taskflow_daily_brief.py,
but no current proof of RUN_LOG integration.

RT-FILE-SYNC-01:
No runtime runner found.

RT-OPS-HEALTH-01:
Existing taskflow_health_worker.py checks Telegram/dispatcher/disk,
not the declared OPS_DB route. It must not be reused as route proof.

Current TaskflowHealthWorker failure:
Telegram token missing after 2026-07-25 12:57 local time.
This is a separate legacy-worker issue and is out of scope for Route V2.
```
