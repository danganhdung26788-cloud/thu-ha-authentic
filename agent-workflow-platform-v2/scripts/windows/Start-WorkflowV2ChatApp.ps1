[CmdletBinding()]
param(
  [Parameter(Mandatory = $false)]
  [string]$ProjectRoot = '',

  [switch]$NoBrowser
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
$diagnosticDirectory = Join-Path $runtimeDirectory 'diagnostics'
$logDirectory = Join-Path $runtimeDirectory 'logs'
New-Item -ItemType Directory -Force -Path $diagnosticDirectory | Out-Null
New-Item -ItemType Directory -Force -Path $logDirectory | Out-Null
$launcherLog = Join-Path $logDirectory 'chat-launcher.log'

function Write-LauncherLog([string]$Message) {
  $line = '[{0}] {1}' -f (Get-Date).ToString('o'), $Message
  Add-Content -LiteralPath $launcherLog -Value $line -Encoding UTF8
}

function Protect-DiagnosticText([string]$Text) {
  $protected = $Text
  $protected = [Regex]::Replace($protected, '(?im)^(\s*(?:OPENAI_API_KEY|GOOGLE_API_KEY|API_AUTH_TOKEN|ADAPTER_AUTH_TOKEN|HOST_ADAPTER_TOKEN|MINIO_SECRET_KEY|POSTGRES_PASSWORD|CANVA_ACCESS_TOKEN|MODEL_API_KEY)\s*=).+$', '$1[REDACTED]')
  $protected = [Regex]::Replace($protected, '(?i)Bearer\s+[A-Za-z0-9._~+/=-]+', 'Bearer [REDACTED]')
  $protected = [Regex]::Replace($protected, '(?i)(postgres(?:ql)?|redis|mysql|mongodb(?:\+srv)?):\/\/([^:\s/@]+):([^@\s/]+)@', '$1://$2:[REDACTED]@')
  $protected = [Regex]::Replace($protected, '(?s)-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----.*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----', '[PRIVATE_KEY_REDACTED]')
  return $protected
}

function Get-CommandOutput([scriptblock]$Operation) {
  try {
    return (& $Operation 2>&1 | Out-String).Trim()
  } catch {
    return ('Collection failed: ' + $_.Exception.Message)
  }
}

function Write-StartupDiagnostic([System.Exception]$Failure) {
  $commit = Get-CommandOutput { & git.exe rev-parse HEAD }
  $tasks = Get-CommandOutput {
    foreach ($name in @('Hermes-V2-Hermes-HostAdapter', 'Hermes-V2-Codex-HostAdapter', 'Hermes-V2-ChatApp')) {
      $task = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
      if ($null -eq $task) {
        [PSCustomObject]@{ TaskName = $name; State = 'MISSING'; LastTaskResult = $null }
      } else {
        $info = Get-ScheduledTaskInfo -TaskName $name
        [PSCustomObject]@{ TaskName = $name; State = $task.State; LastTaskResult = $info.LastTaskResult }
      }
    }
  }
  $ports = Get-CommandOutput {
    Get-NetTCPConnection -State Listen -LocalPort 3100,3201,3202 -ErrorAction SilentlyContinue |
      Select-Object LocalAddress, LocalPort, OwningProcess |
      Format-Table -AutoSize
  }
  $compose = Get-CommandOutput { & docker.exe compose --env-file .env -f compose.yml ps }
  $logs = Get-CommandOutput { & docker.exe compose --env-file .env -f compose.yml logs --tail 80 api worker ollama }
  $report = @"
WORKFLOW AI V2 — STARTUP DIAGNOSTIC

Thời gian: $((Get-Date).ToString('o'))
Runtime commit: $commit
Cutover phase: V1_ONLY
Lỗi: $($Failure.Message)

Scheduled Tasks:
$tasks

Cổng cục bộ:
$ports

Docker Compose:
$compose

Log gần nhất:
$logs

Bí mật đã được tự động che trước khi hiển thị.

Yêu cầu hỗ trợ:
Hãy phân tích nguyên nhân, phản biện các giả định và hướng dẫn cách xử lý an toàn. Không yêu cầu tôi gửi API key, token hoặc mật khẩu.
"@
  $safeReport = Protect-DiagnosticText $report
  $diagnosticPath = Join-Path $diagnosticDirectory 'startup-latest.txt'
  $encoding = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($diagnosticPath, $safeReport, $encoding)
  return $diagnosticPath
}

function Test-DockerReady {
  & docker.exe info *> $null
  return $LASTEXITCODE -eq 0
}

function Start-DockerDesktopIfNeeded {
  if (Test-DockerReady) { return }
  $candidates = @(
    (Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'Docker\Docker\Docker Desktop.exe')
  )
  $executable = $candidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
  if (-not $executable) { throw 'Docker Desktop is not installed or cannot be found.' }
  Start-Process -FilePath $executable | Out-Null
  $deadline = (Get-Date).AddMinutes(4)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 5
    if (Test-DockerReady) { return }
  }
  throw 'Docker Desktop did not become ready within four minutes.'
}

function Start-AdapterTask([string]$TaskName) {
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($null -eq $task) { throw "Required Scheduled Task is missing: $TaskName" }
  if ($task.State -ne 'Running') {
    Start-ScheduledTask -TaskName $TaskName
  }
}

function Wait-ChatReady {
  $deadline = (Get-Date).AddMinutes(12)
  $lastError = 'No readiness response received.'
  while ((Get-Date) -lt $deadline) {
    try {
      $status = Invoke-RestMethod -Uri 'http://127.0.0.1:3100/ready' -TimeoutSec 10
      if ($status.ready -eq $true -and $status.model -eq $true) { return }
      $lastError = ($status | ConvertTo-Json -Compress)
    } catch {
      $lastError = $_.Exception.Message
    }
    Start-Sleep -Seconds 5
  }
  throw "Workflow AI readiness timed out. Last status: $lastError"
}

try {
  Write-LauncherLog 'Starting Workflow AI chat launcher.'
  if (-not (Get-Command docker.exe -ErrorAction SilentlyContinue)) { throw 'docker.exe is unavailable.' }
  if (-not (Get-Command git.exe -ErrorAction SilentlyContinue)) { throw 'git.exe is unavailable.' }
  if (-not (Test-Path '.env')) { throw 'Local .env configuration is missing.' }

  Start-DockerDesktopIfNeeded
  Write-LauncherLog 'Docker Desktop is ready.'
  & docker.exe compose --env-file .env -f compose.yml up -d
  if ($LASTEXITCODE -ne 0) { throw 'Docker Compose startup failed.' }
  Start-AdapterTask 'Hermes-V2-Hermes-HostAdapter'
  Start-AdapterTask 'Hermes-V2-Codex-HostAdapter'
  Wait-ChatReady
  Write-LauncherLog 'Workflow AI chat readiness PASS.'
  if (-not $NoBrowser) {
    Start-Process 'http://127.0.0.1:3100/app' | Out-Null
  }
} catch {
  Write-LauncherLog ('Startup failed: ' + $_.Exception.Message)
  $diagnostic = Write-StartupDiagnostic $_.Exception
  if (-not $NoBrowser) {
    Start-Process -FilePath 'notepad.exe' -ArgumentList ('"{0}"' -f $diagnostic) | Out-Null
  }
  throw
}
