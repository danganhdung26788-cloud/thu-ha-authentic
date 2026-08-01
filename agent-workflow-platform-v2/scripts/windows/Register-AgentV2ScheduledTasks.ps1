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

function Get-PortListeners([int]$Port) {
  return @(
    Get-NetTCPConnection `
      -State Listen `
      -LocalPort $Port `
      -ErrorAction SilentlyContinue |
    Sort-Object OwningProcess -Unique
  )
}

function Stop-StaleAdapterListener(
  [string]$Role,
  [int]$Port,
  [string]$ExpectedEntrypoint,
  [string]$ExpectedEnvFile
) {
  $deadline = (Get-Date).AddSeconds(20)
  do {
    $listeners = @(Get-PortListeners -Port $Port)
    if ($listeners.Count -eq 0) { return }

    foreach ($listener in $listeners) {
      $process = Get-CimInstance Win32_Process `
        -Filter "ProcessId=$($listener.OwningProcess)" `
        -ErrorAction SilentlyContinue
      if ($null -eq $process) { continue }

      $commandLine = [string]$process.CommandLine
      $isNode = [string]::Equals(
        [string]$process.Name,
        'node.exe',
        [System.StringComparison]::OrdinalIgnoreCase
      )
      $hasEntrypoint = $commandLine.IndexOf(
        $ExpectedEntrypoint,
        [System.StringComparison]::OrdinalIgnoreCase
      ) -ge 0
      $hasEnvFile = $commandLine.IndexOf(
        $ExpectedEnvFile,
        [System.StringComparison]::OrdinalIgnoreCase
      ) -ge 0

      if (-not ($isNode -and $hasEntrypoint -and $hasEnvFile)) {
        throw "Port $Port is held by an unrelated process. PID=$($process.ProcessId), Name=$($process.Name). Refusing to terminate it."
      }

      Write-Host "Stopping stale $Role adapter process PID=$($process.ProcessId) on port $Port"
      Stop-Process -Id $process.ProcessId -Force -ErrorAction Stop
    }

    Start-Sleep -Seconds 1
  } while ((Get-Date) -lt $deadline)

  $remaining = @(Get-PortListeners -Port $Port)
  if ($remaining.Count -gt 0) {
    throw "Timed out waiting for stale $Role adapter listener on port $Port to stop."
  }
}

function Wait-AdapterHealth([string]$Role, [int]$Port, [string]$TaskName) {
  $deadline = (Get-Date).AddSeconds(30)
  do {
    try {
      $health = Invoke-RestMethod `
        -Uri "http://127.0.0.1:$Port/health" `
        -TimeoutSec 3
      if ($health.ok -eq $true -or $health.status -eq 'ok') {
        return
      }
    } catch {
      Start-Sleep -Seconds 1
    }
  } while ((Get-Date) -lt $deadline)

  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  $info = Get-ScheduledTaskInfo -TaskName $TaskName -ErrorAction SilentlyContinue
  $state = if ($null -ne $task) { $task.State } else { 'MISSING' }
  $result = if ($null -ne $info) { $info.LastTaskResult } else { 'UNKNOWN' }
  throw "$Role adapter failed health verification on port $Port. TaskState=$state, LastTaskResult=$result"
}

$currentIdentity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -RestartCount 20 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit (New-TimeSpan -Days 7) `
  -MultipleInstances IgnoreNew
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $currentIdentity
$principal = New-ScheduledTaskPrincipal -UserId $currentIdentity -LogonType Interactive -RunLevel Limited

$roles = @(
  @{ Name = 'hermes'; Port = 3201 },
  @{ Name = 'codex'; Port = 3202 }
)

foreach ($roleConfig in $roles) {
  $role = [string]$roleConfig.Name
  $port = [int]$roleConfig.Port
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
    Start-Sleep -Seconds 1
    Stop-StaleAdapterListener `
      -Role $role `
      -Port $port `
      -ExpectedEntrypoint $entrypoint `
      -ExpectedEnvFile $envFile

    Register-ScheduledTask -TaskName $taskName -InputObject $task -Force | Out-Null
    Start-ScheduledTask -TaskName $taskName
    Wait-AdapterHealth -Role $role -Port $port -TaskName $taskName
    Write-Host "Registered, started and health-verified $taskName with direct node.exe lifecycle"
  }
}
