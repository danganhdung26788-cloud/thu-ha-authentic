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
Set-Location $ProjectRoot

$runtimeDirectory = Join-Path $ProjectRoot 'runtime'
$logDirectory = Join-Path $runtimeDirectory 'logs'
$diagnosticDirectory = Join-Path $runtimeDirectory 'diagnostics'
New-Item -ItemType Directory -Force -Path $logDirectory | Out-Null
New-Item -ItemType Directory -Force -Path $diagnosticDirectory | Out-Null

function Read-EnvValue([string]$Path, [string]$Name) {
  foreach ($line in Get-Content -LiteralPath $Path) {
    $trimmed = $line.Trim()
    if (-not $trimmed -or $trimmed.StartsWith('#')) { continue }
    $separator = $trimmed.IndexOf('=')
    if ($separator -le 0) { continue }
    if ($trimmed.Substring(0, $separator) -eq $Name) {
      return $trimmed.Substring($separator + 1)
    }
  }
  return ''
}

function Protect-Text([string]$Text) {
  $protected = $Text
  $protected = [Regex]::Replace(
    $protected,
    '(?im)^(\s*(?:OPENAI_API_KEY|GOOGLE_API_KEY|API_AUTH_TOKEN|ADAPTER_AUTH_TOKEN|HOST_ADAPTER_TOKEN|MINIO_SECRET_KEY|POSTGRES_PASSWORD|CANVA_ACCESS_TOKEN|MODEL_API_KEY)\s*=).+$',
    '$1[REDACTED]'
  )
  $protected = [Regex]::Replace(
    $protected,
    '(?i)Bearer\s+[A-Za-z0-9._~+/=-]+',
    'Bearer [REDACTED]'
  )
  $protected = [Regex]::Replace(
    $protected,
    '(?i)(postgres(?:ql)?|redis|mysql|mongodb(?:\+srv)?):\/\/([^:\s/@]+):([^@\s/]+)@',
    '$1://$2:[REDACTED]@'
  )
  return $protected
}

function Get-LogTail([string]$Path) {
  if (-not (Test-Path $Path)) { return "MISSING: $Path" }
  try {
    return (Get-Content -LiteralPath $Path -Tail 120 -ErrorAction Stop | Out-String).Trim()
  } catch {
    return "READ_FAILED: $Path - $($_.Exception.Message)"
  }
}

function Test-AdapterHealth([int]$Port, [string]$Token) {
  try {
    $headers = @{ Authorization = "Bearer $Token" }
    $health = Invoke-RestMethod `
      -Uri "http://127.0.0.1:$Port/health" `
      -Headers $headers `
      -TimeoutSec 3
    return $health.ok -eq $true
  } catch {
    return $false
  }
}

function Wait-AdapterHealth([int]$Port, [string]$Token, [int]$Seconds) {
  $deadline = (Get-Date).AddSeconds($Seconds)
  do {
    if (Test-AdapterHealth -Port $Port -Token $Token) { return $true }
    Start-Sleep -Seconds 1
  } while ((Get-Date) -lt $deadline)
  return $false
}

function Get-TaskSnapshot([string]$TaskName) {
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  $info = Get-ScheduledTaskInfo -TaskName $TaskName -ErrorAction SilentlyContinue
  $result = if ($null -ne $info) { [int64]$info.LastTaskResult } else { $null }
  return [PSCustomObject]@{
    TaskName = $TaskName
    State = if ($null -ne $task) { [string]$task.State } else { 'MISSING' }
    LastTaskResult = $result
    LastTaskResultHex = if ($null -ne $result) { '0x{0:X8}' -f ([uint32]$result) } else { '' }
    LastRunTime = if ($null -ne $info) { $info.LastRunTime } else { $null }
  }
}

function Write-AdapterDiagnostic(
  [string]$Role,
  [int]$Port,
  [string]$TaskName,
  [string]$Reason,
  [string]$ProcessStdout,
  [string]$ProcessStderr,
  [string]$AdapterStdout,
  [string]$AdapterStderr
) {
  $taskSnapshot = Get-TaskSnapshot -TaskName $TaskName
  $listeners = @(
    Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue |
      Select-Object LocalAddress, LocalPort, OwningProcess
  )
  $report = @"
WORKFLOW AI V2 - HOST ADAPTER DIAGNOSTIC

Timestamp: $((Get-Date).ToString('o'))
Role: $Role
Port: $Port
Reason: $Reason
Cutover phase: V1_ONLY

Scheduled Task:
$($taskSnapshot | Format-List | Out-String)
Listeners:
$($listeners | Format-Table -AutoSize | Out-String)
Process stdout:
$(Get-LogTail -Path $ProcessStdout)

Process stderr:
$(Get-LogTail -Path $ProcessStderr)

Adapter stdout:
$(Get-LogTail -Path $AdapterStdout)

Adapter stderr:
$(Get-LogTail -Path $AdapterStderr)

Secrets were automatically redacted.

Support request:
Analyze the root cause and provide a safe fix. Do not request API keys, tokens, or passwords.
"@
  $path = Join-Path $diagnosticDirectory 'host-adapters-latest.txt'
  $safe = Protect-Text -Text $report
  $encoding = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($path, $safe, $encoding)
  return $path
}

$nodePath = (Get-Command node.exe -ErrorAction Stop).Source
$entrypoint = Join-Path $ProjectRoot 'dist\src\apps\host-adapter\main.js'
if (-not (Test-Path $entrypoint)) {
  throw "Compiled host adapter is missing: $entrypoint"
}

$roles = @(
  [PSCustomObject]@{ Name = 'hermes'; Port = 3201 },
  [PSCustomObject]@{ Name = 'codex'; Port = 3202 }
)

foreach ($roleConfig in $roles) {
  $role = [string]$roleConfig.Name
  $port = [int]$roleConfig.Port
  $title = $role.Substring(0, 1).ToUpperInvariant() + $role.Substring(1)
  $taskName = "Hermes-V2-$title-HostAdapter"
  $envFile = Join-Path $runtimeDirectory "host-adapter.$role.env"
  if (-not (Test-Path $envFile)) { throw "Adapter env file is missing: $envFile" }
  $token = Read-EnvValue -Path $envFile -Name 'HOST_ADAPTER_TOKEN'
  if ([string]::IsNullOrWhiteSpace($token)) { throw "HOST_ADAPTER_TOKEN is missing for $role" }

  if (Test-AdapterHealth -Port $port -Token $token) {
    Write-Host "$($role.ToUpperInvariant())_ADAPTER=ALREADY_READY"
    continue
  }

  $scheduledTask = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  if ($null -ne $scheduledTask) {
    try {
      Start-ScheduledTask -TaskName $taskName -ErrorAction Stop
      if (Wait-AdapterHealth -Port $port -Token $token -Seconds 10) {
        Write-Host "$($role.ToUpperInvariant())_ADAPTER=SCHEDULED_TASK_READY"
        continue
      }
    } catch {
      # Direct self-heal below provides logs and does not require task re-registration.
    }
  }

  $listeners = @(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue)
  if ($listeners.Count -gt 0) {
    $diagnostic = Write-AdapterDiagnostic `
      -Role $role `
      -Port $port `
      -TaskName $taskName `
      -Reason 'Port is occupied but authenticated health failed.' `
      -ProcessStdout (Join-Path $logDirectory "$role.process.stdout.log") `
      -ProcessStderr (Join-Path $logDirectory "$role.process.stderr.log") `
      -AdapterStdout (Join-Path $logDirectory "$role.stdout.log") `
      -AdapterStderr (Join-Path $logDirectory "$role.stderr.log")
    throw "Port $port is occupied by a non-ready process. Diagnostic: $diagnostic"
  }

  $processStdout = Join-Path $logDirectory "$role.process.stdout.log"
  $processStderr = Join-Path $logDirectory "$role.process.stderr.log"
  $adapterStdout = Join-Path $logDirectory "$role.stdout.log"
  $adapterStderr = Join-Path $logDirectory "$role.stderr.log"
  Remove-Item -LiteralPath $processStdout -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $processStderr -Force -ErrorAction SilentlyContinue

  $arguments = "--env-file=`"$envFile`" `"$entrypoint`""
  $process = Start-Process `
    -FilePath $nodePath `
    -ArgumentList $arguments `
    -WorkingDirectory $ProjectRoot `
    -WindowStyle Hidden `
    -RedirectStandardOutput $processStdout `
    -RedirectStandardError $processStderr `
    -PassThru

  $pidPath = Join-Path $runtimeDirectory "$role.host-adapter.pid"
  [System.IO.File]::WriteAllText($pidPath, [string]$process.Id)

  if (-not (Wait-AdapterHealth -Port $port -Token $token -Seconds 30)) {
    $reason = if ($process.HasExited) {
      "Direct adapter process exited with code $($process.ExitCode)."
    } else {
      'Direct adapter process did not become healthy within 30 seconds.'
    }
    $diagnostic = Write-AdapterDiagnostic `
      -Role $role `
      -Port $port `
      -TaskName $taskName `
      -Reason $reason `
      -ProcessStdout $processStdout `
      -ProcessStderr $processStderr `
      -AdapterStdout $adapterStdout `
      -AdapterStderr $adapterStderr
    throw "$role adapter failed to start. Diagnostic: $diagnostic"
  }

  Write-Host "$($role.ToUpperInvariant())_ADAPTER=DIRECT_SELF_HEAL_READY"
}

Write-Host 'HOST_ADAPTERS_READY=true'
