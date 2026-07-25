$ErrorActionPreference = 'Stop'

$WorkerDir = Split-Path -Parent $PSScriptRoot
$RuntimeDir = Join-Path $WorkerDir 'runtime'
$DispatcherTask = 'Hermes-AI-Gateway-Dispatcher'
$ApprovalTask = 'Hermes-AI-Gateway-Approval-Processor'

$RepoDir = Resolve-Path (Join-Path $WorkerDir '..\..')
$Branch = (git -C $RepoDir rev-parse --abbrev-ref HEAD).Trim()
$Commit = (git -C $RepoDir rev-parse HEAD).Trim()

$AllNodeProcesses = @(Get-CimInstance Win32_Process |
    Where-Object { $_.Name -eq 'node.exe' })

# The launcher intentionally starts Node with relative script paths after setting
# WScript.Shell.CurrentDirectory. Therefore do not require the repository path
# to appear in CommandLine.
$WrapperProcesses = @($AllNodeProcesses |
    Where-Object {
        $_.CommandLine -like '*run-with-log-rotation.js*'
    })

$WorkerProcesses = @($AllNodeProcesses |
    Where-Object {
        $_.CommandLine -like '*src\worker.js*' -or
        $_.CommandLine -like '*src/worker.js*'
    })

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
$LastLog = if (Test-Path $DispatcherLog) {
    @(Get-Content $DispatcherLog -Tail 20)
}
else {
    @()
}

function Write-Diagnostics {
    Write-Host 'SCHEDULED TASKS:' -ForegroundColor Yellow
    $TaskResults | Format-Table -AutoSize

    Write-Host 'ALL NODE PROCESSES:' -ForegroundColor Yellow
    $AllNodeProcesses |
        Select-Object ProcessId, ParentProcessId, Name, CommandLine |
        Format-List

    Write-Host 'LAST WORKER LOG:' -ForegroundColor Yellow
    if ($LastLog.Count -gt 0) {
        $LastLog
    }
    else {
        Write-Host "Worker log not found or empty: $DispatcherLog"
    }
}

if ($WrapperProcesses.Count -ne 1) {
    Write-Diagnostics
    throw "Expected exactly one Hermes log-rotation wrapper process, found $($WrapperProcesses.Count)"
}

if ($WorkerProcesses.Count -ne 1) {
    Write-Diagnostics
    throw "Expected exactly one Hermes dispatcher worker process, found $($WorkerProcesses.Count)"
}

if (-not (Test-Path $DispatcherLog)) {
    Write-Diagnostics
    throw "Dispatcher log not found: $DispatcherLog"
}

if ($LastLog -match 'UNEXPECTED_ERROR|SCHEMA_CONTRACT_MISMATCH|BLOCKED_CONNECTOR|launcher_error') {
    Write-Diagnostics
    throw 'Recent dispatcher log contains a blocking error'
}

$DispatcherTaskResult = @($TaskResults |
    Where-Object { $_.TaskName -eq $DispatcherTask })[0]

if ($DispatcherTaskResult.LastTaskResult -ne 0 -and $DispatcherTaskResult.State -ne 'Running') {
    Write-Diagnostics
    throw "Dispatcher Scheduled Task result is not healthy: $($DispatcherTaskResult.LastTaskResult)"
}

$TaskResults | Format-Table -AutoSize
Write-Host 'WRAPPER PROCESS:'
$WrapperProcesses | Select-Object ProcessId, ParentProcessId, Name, CommandLine | Format-List
Write-Host 'WORKER PROCESS:'
$WorkerProcesses | Select-Object ProcessId, ParentProcessId, Name, CommandLine | Format-List
Write-Host "BRANCH : $Branch"
Write-Host "COMMIT : $Commit"
Write-Host 'LAST LOG:'
$LastLog
Write-Host 'HERMES_G0_4_RUNTIME_HEALTH_PASS' -ForegroundColor Green
