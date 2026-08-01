[CmdletBinding(SupportsShouldProcess)]
param(
  [Parameter(Mandatory = $false)]
  [string]$ProjectRoot = '',

  [Parameter(Mandatory = $false)]
  [string]$TaskPrefix = 'Hermes-V2-'
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

$runner = Join-Path $ProjectRoot 'scripts\windows\Run-HostAdapter.ps1'
if (-not (Test-Path $runner)) { throw "Missing runner: $runner" }

$currentIdentity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -RestartCount 5 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit (New-TimeSpan -Days 7)
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $currentIdentity
$principal = New-ScheduledTaskPrincipal -UserId $currentIdentity -LogonType Interactive -RunLevel Limited

foreach ($role in @('hermes', 'codex')) {
  $taskName = "$TaskPrefix$($role.Substring(0,1).ToUpper())$($role.Substring(1))-HostAdapter"
  $arguments = "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$runner`" -Role $role -ProjectRoot `"$ProjectRoot`""
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $arguments -WorkingDirectory $ProjectRoot
  $task = New-ScheduledTask -Action $action -Trigger $trigger -Principal $principal -Settings $settings
  if ($PSCmdlet.ShouldProcess($taskName, 'Register or update Scheduled Task')) {
    Register-ScheduledTask -TaskName $taskName -InputObject $task -Force | Out-Null
    Start-ScheduledTask -TaskName $taskName
    Write-Host "Registered and started $taskName"
  }
}
