[CmdletBinding(SupportsShouldProcess)]
param(
    [ValidateSet("Plan", "Apply", "Rollback")]
    [string]$Mode = "Plan",
    [string]$Container = "hermes-gateway",
    [string]$DataRoot = "D:\HermesAgent\data",
    [string]$BackupPath = ""
)

$ErrorActionPreference = "Stop"
$legacyTasks = @(
    @{ Name = "TaskflowDailyBriefMorning"; Replacement = "HermesTaskChecklistMorning" },
    @{ Name = "TaskflowDailyBriefMidday"; Replacement = "HermesTaskChecklistMidday" }
)
$runner = Join-Path $DataRoot "tha-integrations\integrations\hermes\run_task_checklist_digest.ps1"
$backupRoot = Join-Path $DataRoot "backups\issue39-task-only-schedules"

function Assert-TaskOnlyMode {
    $envFile = Join-Path $DataRoot ".env"
    if (-not (Test-Path -LiteralPath $envFile -PathType Leaf)) {
        throw "Runtime env file not found: $envFile"
    }
    $envText = Get-Content -LiteralPath $envFile -Raw
    if ($envText -notmatch "(?im)^TASK_ONLY_MODE=(true|yes|1)\s*$") {
        throw "TASK_ONLY_MODE=true is required before schedule cutover"
    }
}

function Restore-LegacySchedules {
    param([Parameter(Mandatory)][string]$From)
    foreach ($item in $legacyTasks) {
        $xmlPath = Join-Path $From "$($item.Name).xml"
        if (-not (Test-Path -LiteralPath $xmlPath -PathType Leaf)) {
            throw "Schedule backup is incomplete: $xmlPath"
        }
        $xml = Get-Content -LiteralPath $xmlPath -Raw
        Register-ScheduledTask -TaskName $item.Name -Xml $xml -Force | Out-Null
        $replacement = Get-ScheduledTask -TaskName $item.Replacement -ErrorAction SilentlyContinue
        if ($replacement) {
            Unregister-ScheduledTask -TaskName $item.Replacement -Confirm:$false
        }
    }
    foreach ($item in $legacyTasks) {
        $legacy = Get-ScheduledTask -TaskName $item.Name -ErrorAction Stop
        if (-not $legacy.Settings.Enabled) {
            throw "Rollback verification failed for $($item.Name)"
        }
    }
}

if ($Mode -eq "Plan") {
    $plan = foreach ($item in $legacyTasks) {
        $legacy = Get-ScheduledTask -TaskName $item.Name -ErrorAction SilentlyContinue
        [pscustomobject]@{
            LegacyTask = $item.Name
            LegacyExists = [bool]$legacy
            LegacyEnabled = if ($legacy) { [bool]$legacy.Settings.Enabled } else { $false }
            ReplacementTask = $item.Replacement
            Action = "Register task-only replacement, verify, then disable legacy"
        }
    }
    $plan | ConvertTo-Json -Depth 4
    return
}

if ($Mode -eq "Rollback") {
    if (-not $BackupPath) {
        throw "BackupPath is required for rollback"
    }
    $resolvedBackup = (Resolve-Path -LiteralPath $BackupPath).Path
    if ($PSCmdlet.ShouldProcess($resolvedBackup, "Restore legacy brief schedules")) {
        Restore-LegacySchedules -From $resolvedBackup
    }
    Write-Output "TASK_ONLY_SCHEDULE_ROLLBACK=PASS"
    return
}

Assert-TaskOnlyMode
if (-not (Test-Path -LiteralPath $runner -PathType Leaf)) {
    throw "Task-only runner not found: $runner"
}
foreach ($item in $legacyTasks) {
    if (-not (Get-ScheduledTask -TaskName $item.Name -ErrorAction SilentlyContinue)) {
        throw "Legacy schedule not found: $($item.Name)"
    }
    if (Get-ScheduledTask -TaskName $item.Replacement -ErrorAction SilentlyContinue) {
        throw "Replacement schedule already exists: $($item.Replacement)"
    }
}

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$currentBackup = Join-Path $backupRoot $stamp
if ($PSCmdlet.ShouldProcess($currentBackup, "Backup and replace legacy brief schedules")) {
    New-Item -ItemType Directory -Path $currentBackup -Force | Out-Null
    foreach ($item in $legacyTasks) {
        Export-ScheduledTask -TaskName $item.Name |
            Set-Content -LiteralPath (Join-Path $currentBackup "$($item.Name).xml") `
                -Encoding UTF8
    }
    try {
        foreach ($item in $legacyTasks) {
            $legacy = Get-ScheduledTask -TaskName $item.Name -ErrorAction Stop
            $arguments = (
                "-NoProfile -NonInteractive -WindowStyle Hidden " +
                "-ExecutionPolicy Bypass -File `"$runner`" -Container `"$Container`" " +
                "-DataRoot `"$DataRoot`""
            )
            $action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $arguments
            Register-ScheduledTask `
                -TaskName $item.Replacement `
                -Action $action `
                -Trigger $legacy.Triggers `
                -Settings $legacy.Settings `
                -Principal $legacy.Principal `
                -Force | Out-Null
            $created = Get-ScheduledTask -TaskName $item.Replacement -ErrorAction Stop
            if (
                -not $created.Settings.Enabled -or
                $created.Actions.Arguments -notlike "*run_task_checklist_digest.ps1*"
            ) {
                throw "Replacement verification failed: $($item.Replacement)"
            }
        }
        foreach ($item in $legacyTasks) {
            Disable-ScheduledTask -TaskName $item.Name | Out-Null
        }
        foreach ($item in $legacyTasks) {
            $legacy = Get-ScheduledTask -TaskName $item.Name -ErrorAction Stop
            if ($legacy.Settings.Enabled) {
                throw "Legacy schedule is still enabled: $($item.Name)"
            }
        }
    }
    catch {
        Restore-LegacySchedules -From $currentBackup
        throw
    }
}
Write-Output "TASK_ONLY_SCHEDULE_APPLY=PASS"
Write-Output "TASK_ONLY_SCHEDULE_BACKUP=$currentBackup"
