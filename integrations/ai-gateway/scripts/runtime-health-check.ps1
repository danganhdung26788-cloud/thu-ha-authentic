$ErrorActionPreference = 'Stop'

$WorkerDir = Split-Path -Parent $PSScriptRoot
$RuntimeDir = Join-Path $WorkerDir 'runtime'
$DispatcherTask = 'Hermes-AI-Gateway-Dispatcher'
$ApprovalTask = 'Hermes-AI-Gateway-Approval-Processor'

$RepoDir = Resolve-Path (Join-Path $WorkerDir '..\..')
$Branch = (git -C $RepoDir rev-parse --abbrev-ref HEAD).Trim()
$Commit = (git -C $RepoDir rev-parse HEAD).Trim()

$DispatcherProcesses = Get-CimInstance Win32_Process |
    Where-Object {
        $_.Name -eq 'node.exe' -and
        $_.CommandLine -like '*integrations\ai-gateway*worker.js*'
    }

if ($DispatcherProcesses.Count -ne 1) {
    throw "Expected exactly one Hermes dispatcher process, found $($DispatcherProcesses.Count)"
}

$TaskResults = foreach ($taskName in @($DispatcherTask, $ApprovalTask)) {
    $task = Get-ScheduledTask -TaskName $taskName -ErrorAction Stop
    $info = Get-ScheduledTaskInfo -TaskName $taskName
    [PSCustomObject]@{
        TaskName = $taskName
        State = $task.State
        LastTaskResult = $info.LastTaskResult
        LastRunTime = $info.LastRunTime
    }
}

$DispatcherLog = Join-Path $RuntimeDir 'worker.log'
if (-not (Test-Path $DispatcherLog)) {
    throw "Dispatcher log not found: $DispatcherLog"
}

$LastLog = Get-Content $DispatcherLog -Tail 20
if ($LastLog -match 'UNEXPECTED_ERROR|SCHEMA_CONTRACT_MISMATCH|BLOCKED_CONNECTOR') {
    throw 'Recent dispatcher log contains a blocking error'
}

$TaskResults | Format-Table -AutoSize
$DispatcherProcesses | Select-Object ProcessId, Name, CommandLine | Format-List
Write-Host "BRANCH : $Branch"
Write-Host "COMMIT : $Commit"
Write-Host 'LAST LOG:'
$LastLog
Write-Host 'HERMES_G0_4_RUNTIME_HEALTH_PASS' -ForegroundColor Green
