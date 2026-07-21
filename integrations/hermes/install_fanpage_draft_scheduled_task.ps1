#Requires -RunAsAdministrator

param(
    [string]$TaskName = "Hermes-ThuHa-Fanpage-Draft-Processor",
    [ValidateRange(1, 60)]
    [int]$IntervalMinutes = 5
)

$ErrorActionPreference = "Stop"
$runnerPath = Join-Path $PSScriptRoot "run_fanpage_draft_background.ps1"

if (-not (Test-Path $runnerPath)) {
    throw "Runner not found: $runnerPath"
}

$currentIdentity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$runnerPath`""
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $arguments

$firstRun = (Get-Date).AddMinutes(1)
$repeatTrigger = New-ScheduledTaskTrigger `
    -Once `
    -At $firstRun `
    -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes) `
    -RepetitionDuration (New-TimeSpan -Days 3650)
$logonTrigger = New-ScheduledTaskTrigger -AtLogOn -User $currentIdentity

$principal = New-ScheduledTaskPrincipal `
    -UserId $currentIdentity `
    -LogonType Interactive `
    -RunLevel Highest

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 5)

$description = "Thu Ha Authentic Fanpage draft processor. Runs every $IntervalMinutes minutes while the Windows user is logged on. It creates reviewable drafts only and never sends Facebook messages."

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger @($repeatTrigger, $logonTrigger) `
    -Principal $principal `
    -Settings $settings `
    -Description $description `
    -Force | Out-Null

Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 2

$task = Get-ScheduledTask -TaskName $TaskName
$info = Get-ScheduledTaskInfo -TaskName $TaskName

Write-Host "PASS: Fanpage draft scheduled task installed"
Write-Host "TASK_NAME=$TaskName"
Write-Host "RUN_AS=$currentIdentity"
Write-Host "INTERVAL_MINUTES=$IntervalMinutes"
Write-Host "STATE=$($task.State)"
Write-Host "LAST_RUN_TIME=$($info.LastRunTime)"
Write-Host "LAST_TASK_RESULT=$($info.LastTaskResult)"
Write-Host "MODE=DRAFT_ONLY"
Write-Host "AUTO_SEND=FALSE"
Write-Host "RUNNER=$runnerPath"
