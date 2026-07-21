#Requires -RunAsAdministrator

param(
    [string]$TaskName = "Hermes-ThuHa-Telegram-Dispatcher"
)

$ErrorActionPreference = "Stop"
$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue

if ($null -eq $task) {
    Write-Host "NO_CHANGE: scheduled task does not exist"
    exit 0
}

Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
Write-Host "PASS: scheduled task removed"
Write-Host "TASK_NAME=$TaskName"
