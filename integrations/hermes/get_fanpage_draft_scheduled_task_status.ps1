param(
    [string]$TaskName = "Hermes-ThuHa-Fanpage-Draft-Processor",
    [string]$DataRoot = "D:\HermesAgent\data",
    [int]$TailLines = 40
)

$ErrorActionPreference = "Stop"
$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
$info = Get-ScheduledTaskInfo -TaskName $TaskName
$logPath = Join-Path (Join-Path $DataRoot "tha-fanpage-draft") "host-draft-processor.log"

Write-Host "TASK_NAME=$TaskName"
Write-Host "STATE=$($task.State)"
Write-Host "LAST_RUN_TIME=$($info.LastRunTime)"
Write-Host "NEXT_RUN_TIME=$($info.NextRunTime)"
Write-Host "LAST_TASK_RESULT=$($info.LastTaskResult)"
Write-Host "MISSED_RUNS=$($info.NumberOfMissedRuns)"
Write-Host "MODE=DRAFT_ONLY"
Write-Host "AUTO_SEND=FALSE"
Write-Host "LOG_PATH=$logPath"

if (Test-Path $logPath) {
    Write-Host "--- LOG TAIL ---"
    Get-Content -Path $logPath -Tail $TailLines
}
else {
    Write-Host "LOG_NOT_CREATED_YET"
}
