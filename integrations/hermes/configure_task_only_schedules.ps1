[CmdletBinding(SupportsShouldProcess)]
param(
    [ValidateSet("Plan", "Apply", "Rollback")]
    [string]$Mode = "Plan",
    [string]$Container = "hermes-gateway",
    [string]$DataRoot = "D:\HermesAgent\data",
    [string]$BackupPath = ""
)

$ErrorActionPreference = "Stop"

# One replacement is created for each logical delivery window. Every known legacy
# producer for that window is backed up and disabled so Telegram receives one
# task-only checklist instead of parallel legacy/OPS messages.
$scheduleGroups = @(
    @{
        LogicalName = "COMMAND_CENTER"
        Candidates = @(
            "Hermes-Operations-Daily-Command-Center",
            "TaskflowDailyBriefMorning"
        )
        Replacement = "HermesTaskChecklistCommandCenter"
    },
    @{
        LogicalName = "MIDDAY"
        Candidates = @(
            "TaskflowDailyBriefMidday"
        )
        Replacement = "HermesTaskChecklistMidday"
    },
    @{
        LogicalName = "AFTERNOON_CLOSE"
        Candidates = @(
            "Hermes-Operations-Conditional-Close",
            "TaskflowDailyBriefAfternoon"
        )
        Replacement = "HermesTaskChecklistAfternoonClose"
    },
    @{
        LogicalName = "EVENING_REVIEW"
        Candidates = @(
            "TaskflowDailyBriefEvening",
            "TaskflowDailyBriefEveningReview"
        )
        Replacement = "HermesTaskChecklistEveningReview"
    }
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

function Get-ExistingCandidates {
    param([Parameter(Mandatory)][hashtable]$Group)

    $found = @()
    foreach ($name in $Group.Candidates) {
        $task = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
        if ($task) {
            $found += $task
        }
    }
    return @($found)
}

function Resolve-ScheduleGroups {
    $resolved = @()
    foreach ($group in $scheduleGroups) {
        $existing = @(Get-ExistingCandidates -Group $group)
        if ($existing.Count -eq 0) {
            throw "No production schedule found for logical window $($group.LogicalName). Candidates: $($group.Candidates -join ', ')"
        }
        $enabled = @($existing | Where-Object { $_.Settings.Enabled })
        $source = if ($enabled.Count -gt 0) { $enabled[0] } else { $existing[0] }
        $resolved += [pscustomobject]@{
            LogicalName = $group.LogicalName
            Replacement = $group.Replacement
            Existing = $existing
            Source = $source
        }
    }
    return @($resolved)
}

function Test-ReplacementTask {
    param(
        [Parameter(Mandatory)][string]$TaskName,
        [switch]$AllowMissing
    )

    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if (-not $task) {
        if ($AllowMissing) {
            return $false
        }
        throw "Replacement schedule not found: $TaskName"
    }
    if (-not $task.Settings.Enabled) {
        throw "Replacement schedule is disabled: $TaskName"
    }
    if ($task.Actions.Arguments -notlike "*run_task_checklist_digest.ps1*") {
        throw "Replacement schedule does not use the task-only runner: $TaskName"
    }
    return $true
}

function Test-AlreadyApplied {
    param([Parameter(Mandatory)][object[]]$Resolved)

    foreach ($item in $Resolved) {
        if (-not (Test-ReplacementTask -TaskName $item.Replacement -AllowMissing)) {
            return $false
        }
        foreach ($legacy in $item.Existing) {
            $current = Get-ScheduledTask -TaskName $legacy.TaskName -ErrorAction Stop
            if ($current.Settings.Enabled) {
                return $false
            }
        }
    }
    return $true
}

function Restore-LegacySchedules {
    param([Parameter(Mandatory)][string]$From)

    $manifestPath = Join-Path $From "manifest.json"
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
        throw "Schedule backup manifest is missing: $manifestPath"
    }
    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    if (-not $manifest.Tasks -or -not $manifest.Replacements) {
        throw "Schedule backup manifest is incomplete: $manifestPath"
    }

    foreach ($entry in $manifest.Tasks) {
        $xmlPath = Join-Path $From $entry.XmlFile
        if (-not (Test-Path -LiteralPath $xmlPath -PathType Leaf)) {
            throw "Schedule backup is incomplete: $xmlPath"
        }
        $xml = Get-Content -LiteralPath $xmlPath -Raw
        Register-ScheduledTask -TaskName $entry.TaskName -Xml $xml -Force | Out-Null
    }
    foreach ($replacementName in $manifest.Replacements) {
        $replacement = Get-ScheduledTask -TaskName $replacementName -ErrorAction SilentlyContinue
        if ($replacement) {
            Unregister-ScheduledTask -TaskName $replacementName -Confirm:$false
        }
    }
    foreach ($entry in $manifest.Tasks) {
        $restored = Get-ScheduledTask -TaskName $entry.TaskName -ErrorAction Stop
        if ([bool]$restored.Settings.Enabled -ne [bool]$entry.WasEnabled) {
            throw "Rollback verification failed for $($entry.TaskName)"
        }
    }
}

if ($Mode -eq "Plan") {
    $plan = foreach ($group in $scheduleGroups) {
        $existing = @(Get-ExistingCandidates -Group $group)
        $replacement = Get-ScheduledTask -TaskName $group.Replacement -ErrorAction SilentlyContinue
        [pscustomobject]@{
            LogicalName = $group.LogicalName
            LegacyCandidates = @($group.Candidates)
            ExistingLegacyTasks = @($existing | ForEach-Object { $_.TaskName })
            EnabledLegacyTasks = @($existing | Where-Object { $_.Settings.Enabled } | ForEach-Object { $_.TaskName })
            ReplacementTask = $group.Replacement
            ReplacementExists = [bool]$replacement
            Action = "Backup every existing producer, register one task-only replacement, verify it, then disable all legacy producers"
        }
    }
    $plan | ConvertTo-Json -Depth 6
    return
}

if ($Mode -eq "Rollback") {
    if (-not $BackupPath) {
        throw "BackupPath is required for rollback"
    }
    $resolvedBackup = (Resolve-Path -LiteralPath $BackupPath).Path
    if ($PSCmdlet.ShouldProcess($resolvedBackup, "Restore all legacy brief schedules")) {
        Restore-LegacySchedules -From $resolvedBackup
    }
    Write-Output "TASK_ONLY_SCHEDULE_ROLLBACK=PASS"
    return
}

Assert-TaskOnlyMode
if (-not (Test-Path -LiteralPath $runner -PathType Leaf)) {
    throw "Task-only runner not found: $runner"
}

$resolvedGroups = @(Resolve-ScheduleGroups)
if (Test-AlreadyApplied -Resolved $resolvedGroups) {
    Write-Output "TASK_ONLY_SCHEDULE_APPLY=IDEMPOTENT_PASS"
    return
}
foreach ($item in $resolvedGroups) {
    if (Get-ScheduledTask -TaskName $item.Replacement -ErrorAction SilentlyContinue) {
        throw "Partial cutover detected; replacement already exists: $($item.Replacement). Roll back or reconcile before Apply."
    }
}

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$currentBackup = Join-Path $backupRoot $stamp
if ($PSCmdlet.ShouldProcess($currentBackup, "Backup and replace every production brief schedule")) {
    New-Item -ItemType Directory -Path $currentBackup -Force | Out-Null
    $taskManifest = @()
    foreach ($item in $resolvedGroups) {
        foreach ($task in $item.Existing) {
            $safeName = ($task.TaskName -replace '[^A-Za-z0-9._-]', '_')
            $xmlFile = "$safeName.xml"
            Export-ScheduledTask -TaskName $task.TaskName |
                Set-Content -LiteralPath (Join-Path $currentBackup $xmlFile) -Encoding UTF8
            $taskManifest += [pscustomobject]@{
                LogicalName = $item.LogicalName
                TaskName = $task.TaskName
                XmlFile = $xmlFile
                WasEnabled = [bool]$task.Settings.Enabled
            }
        }
    }
    $manifest = [pscustomobject]@{
        SchemaVersion = "2.0"
        CreatedAt = (Get-Date).ToString("o")
        Runner = $runner
        Tasks = $taskManifest
        Replacements = @($resolvedGroups | ForEach-Object { $_.Replacement })
    }
    $manifest | ConvertTo-Json -Depth 8 |
        Set-Content -LiteralPath (Join-Path $currentBackup "manifest.json") -Encoding UTF8

    try {
        foreach ($item in $resolvedGroups) {
            $source = Get-ScheduledTask -TaskName $item.Source.TaskName -ErrorAction Stop
            $arguments = (
                "-NoProfile -NonInteractive -WindowStyle Hidden " +
                "-ExecutionPolicy Bypass -File `"$runner`" -Container `"$Container`" " +
                "-DataRoot `"$DataRoot`""
            )
            $action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $arguments
            Register-ScheduledTask `
                -TaskName $item.Replacement `
                -Action $action `
                -Trigger $source.Triggers `
                -Settings $source.Settings `
                -Principal $source.Principal `
                -Force | Out-Null
            [void](Test-ReplacementTask -TaskName $item.Replacement)
        }

        foreach ($item in $resolvedGroups) {
            foreach ($legacy in $item.Existing) {
                Disable-ScheduledTask -TaskName $legacy.TaskName | Out-Null
            }
        }
        foreach ($item in $resolvedGroups) {
            foreach ($legacy in $item.Existing) {
                $current = Get-ScheduledTask -TaskName $legacy.TaskName -ErrorAction Stop
                if ($current.Settings.Enabled) {
                    throw "Legacy schedule is still enabled: $($legacy.TaskName)"
                }
            }
            [void](Test-ReplacementTask -TaskName $item.Replacement)
        }
    }
    catch {
        Restore-LegacySchedules -From $currentBackup
        throw
    }
}

Write-Output "TASK_ONLY_SCHEDULE_APPLY=PASS"
Write-Output "TASK_ONLY_SCHEDULE_BACKUP=$currentBackup"
