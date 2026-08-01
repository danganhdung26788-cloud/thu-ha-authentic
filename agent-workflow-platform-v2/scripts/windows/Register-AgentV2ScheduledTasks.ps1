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

$nodePath = (Get-Command node.exe -ErrorAction Stop).Source
$entrypoint = Join-Path $ProjectRoot 'dist\src\apps\host-adapter\main.js'
if (-not (Test-Path $entrypoint)) { throw "Missing compiled host adapter: $entrypoint" }

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
  $envFile = Join-Path $ProjectRoot "runtime\host-adapter.$role.env"
  if (-not (Test-Path $envFile)) { throw "Missing host adapter configuration: $envFile" }

  $arguments = "--env-file=`"$envFile`" `"$entrypoint`""
  $action = New-ScheduledTaskAction `
    -Execute $nodePath `
    -Argument $arguments `
    -WorkingDirectory $ProjectRoot
  $task = New-ScheduledTask -Action $action -Trigger $trigger -Principal $principal -Settings $settings

  if ($PSCmdlet.ShouldProcess($taskName, 'Register or update direct Node Scheduled Task')) {
    Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    Register-ScheduledTask -TaskName $taskName -InputObject $task -Force | Out-Null
    Start-ScheduledTask -TaskName $taskName
    Write-Host "Registered and started $taskName with direct node.exe lifecycle"
  }
}
