param(
    [string]$ContainerName = 'hermes-gateway',
    [string]$DataRoot = 'D:\HermesAgent\data'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$paths = [ordered]@{
    MEMORY = Join-Path $DataRoot 'memories\MEMORY.md'
    USER = Join-Path $DataRoot 'memories\USER.md'
    SKILL = Join-Path $DataRoot 'skills\thu-ha-cosmetics\SKILL.md'
    TRAINING = Join-Path $DataRoot 'training\thu-ha-cosmetics'
    INTEGRATION = Join-Path $DataRoot 'tha-integrations\integrations\hermes\natural_reply_processor.py'
}

foreach ($entry in $paths.GetEnumerator()) {
    Write-Host ("{0}_PRESENT={1}" -f $entry.Key, (Test-Path $entry.Value).ToString().ToUpperInvariant())
    Write-Host ("{0}_PATH={1}" -f $entry.Key, $entry.Value)
}

$running = docker inspect -f '{{.State.Running}}' $ContainerName 2>$null
Write-Host ("CONTAINER_RUNNING=" + (($running | Out-String).Trim().ToUpperInvariant()))
if ($LASTEXITCODE -ne 0 -or ($running | Out-String).Trim().ToLowerInvariant() -ne 'true') {
    exit 1
}

$checkCommand = @'
set -eu
if [ -f /opt/data/.env ]; then
  set -a
  . /opt/data/.env
  set +a
fi
export HERMES_HOME=/opt/data
export PYTHONPATH=/opt/data/tha-integrations:/opt/data/tha-integrations/.vendor
printf 'THA_REPLY_MODE=%s\n' "${THA_REPLY_MODE:-DRAFT_ONLY}"
printf 'THA_META_AUTO_SEND=%s\n' "${THA_META_AUTO_SEND:-false}"
if [ -n "${META_PAGE_ACCESS_TOKEN:-}" ]; then echo META_PAGE_ACCESS_TOKEN=PRESENT; else echo META_PAGE_ACCESS_TOKEN=MISSING; fi
if command -v hermes >/dev/null 2>&1; then echo HERMES_CLI=PRESENT; else echo HERMES_CLI=MISSING; exit 1; fi
hermes skills list | grep -i 'thu-ha-cosmetics'
'@ -replace "`r`n", "`n"

docker exec $ContainerName /bin/sh -c $checkCommand
if ($LASTEXITCODE -ne 0) {
    throw 'Natural cosmetics agent status check failed.'
}

$task = Get-ScheduledTask -TaskName 'Hermes-ThuHa-Fanpage-Draft-Processor' -ErrorAction SilentlyContinue
if ($null -eq $task) {
    Write-Host 'SCHEDULED_TASK=MISSING'
} else {
    $info = Get-ScheduledTaskInfo -TaskName $task.TaskName
    Write-Host "SCHEDULED_TASK=$($task.State)"
    Write-Host "LAST_TASK_RESULT=$($info.LastTaskResult)"
    Write-Host "LAST_RUN_TIME=$($info.LastRunTime)"
}

$logPath = Join-Path $DataRoot 'tha-fanpage-draft\host-draft-processor.log'
if (Test-Path $logPath) {
    Write-Host '--- LOG TAIL ---'
    Get-Content $logPath -Tail 15
}
