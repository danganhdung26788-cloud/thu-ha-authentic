[CmdletBinding()]
param(
  [Parameter(Mandatory = $false)]
  [string]$ProjectRoot = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$ScriptDirectory = if (-not [string]::IsNullOrWhiteSpace($PSScriptRoot)) {
  $PSScriptRoot
} else {
  Split-Path -Parent $MyInvocation.MyCommand.Path
}
if ([string]::IsNullOrWhiteSpace($ProjectRoot)) {
  $ProjectRoot = (Resolve-Path (Join-Path $ScriptDirectory '..\..')).Path
} else {
  $ProjectRoot = (Resolve-Path $ProjectRoot).Path
}

function Write-Utf8NoBom([string]$Path, [string]$Content) {
  $encoding = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($Path, $Content, $encoding)
}

function Escape-VbsString([string]$Value) {
  return $Value.Replace('"', '""')
}

function New-Shortcut(
  [string]$Path,
  [string]$Target,
  [string]$Arguments,
  [string]$WorkingDirectory,
  [string]$Description
) {
  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($Path)
  $shortcut.TargetPath = $Target
  $shortcut.Arguments = $Arguments
  $shortcut.WorkingDirectory = $WorkingDirectory
  $shortcut.Description = $Description
  $shortcut.IconLocation = "$env:SystemRoot\System32\shell32.dll,220"
  $shortcut.Save()
}

$launcherDirectory = Join-Path $ProjectRoot 'runtime\launcher'
New-Item -ItemType Directory -Force -Path $launcherDirectory | Out-Null
$startScript = Join-Path $ProjectRoot 'scripts\windows\Start-WorkflowV2ChatApp.ps1'
if (-not (Test-Path $startScript)) { throw "Missing chat startup script: $startScript" }

$escapedScript = Escape-VbsString $startScript
$escapedProject = Escape-VbsString $ProjectRoot
$openVbs = Join-Path $launcherDirectory 'Open-WorkflowAI.vbs'
$backgroundVbs = Join-Path $launcherDirectory 'Start-WorkflowAI-Background.vbs'
$openContent = @"
Option Explicit
Dim shell, command
Set shell = CreateObject("WScript.Shell")
command = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""$escapedScript"" -ProjectRoot ""$escapedProject"""
shell.Run command, 0, False
"@
$backgroundContent = @"
Option Explicit
Dim shell, command
Set shell = CreateObject("WScript.Shell")
command = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""$escapedScript"" -ProjectRoot ""$escapedProject"" -NoBrowser"
shell.Run command, 0, False
"@
Write-Utf8NoBom -Path $openVbs -Content $openContent
Write-Utf8NoBom -Path $backgroundVbs -Content $backgroundContent

$wscript = Join-Path $env:SystemRoot 'System32\wscript.exe'
if (-not (Test-Path $wscript)) { throw "wscript.exe is unavailable: $wscript" }
$desktop = [Environment]::GetFolderPath('Desktop')
$programs = [Environment]::GetFolderPath('Programs')
$desktopShortcut = Join-Path $desktop 'Workflow AI.lnk'
$startMenuShortcut = Join-Path $programs 'Workflow AI.lnk'
$arguments = '"{0}"' -f $openVbs
New-Shortcut -Path $desktopShortcut -Target $wscript -Arguments $arguments -WorkingDirectory $ProjectRoot -Description 'Mở Workflow AI bằng giao diện chat'
New-Shortcut -Path $startMenuShortcut -Target $wscript -Arguments $arguments -WorkingDirectory $ProjectRoot -Description 'Mở Workflow AI bằng giao diện chat'

$taskName = 'Hermes-V2-ChatApp'
$taskAction = New-ScheduledTaskAction -Execute $wscript -Argument ('"{0}"' -f $backgroundVbs) -WorkingDirectory $ProjectRoot
$taskTrigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$taskSettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 20)
$taskPrincipal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $taskName -Action $taskAction -Trigger $taskTrigger -Settings $taskSettings -Principal $taskPrincipal -Description 'Khởi động nền Workflow AI V2 và kiểm tra readiness khi đăng nhập.' -Force | Out-Null
Start-ScheduledTask -TaskName $taskName

Write-Host "Workflow AI shortcut installed: $desktopShortcut"
Write-Host "Workflow AI Start Menu shortcut installed: $startMenuShortcut"
Write-Host "Hidden logon startup registered: $taskName"
