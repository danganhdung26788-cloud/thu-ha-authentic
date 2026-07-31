[CmdletBinding()]
param(
  [Parameter(Mandatory = $false)]
  [string]$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$ProjectRoot = (Resolve-Path $ProjectRoot).Path
Set-Location $ProjectRoot

function Read-EnvFile([string]$Path) {
  $values = @{}
  Get-Content -Path $Path | ForEach-Object {
    $line = $_.Trim()
    if (-not $line -or $line.StartsWith('#')) { return }
    $separator = $line.IndexOf('=')
    if ($separator -gt 0) {
      $values[$line.Substring(0, $separator)] = $line.Substring($separator + 1)
    }
  }
  return $values
}

$compose = & docker compose --env-file .env -f compose.yml ps --format json
if ($LASTEXITCODE -ne 0) { throw 'Docker Compose status check failed.' }

$health = Invoke-RestMethod -Uri 'http://127.0.0.1:3100/health' -TimeoutSec 15
if ($health.status -ne 'ok') { throw 'API health check failed.' }
$ready = Invoke-RestMethod -Uri 'http://127.0.0.1:3100/ready' -TimeoutSec 30
if (-not $ready.ready) { throw 'API readiness check failed.' }

foreach ($role in @('hermes', 'codex')) {
  $envPath = Join-Path $ProjectRoot "runtime\host-adapter.$role.env"
  $values = Read-EnvFile $envPath
  $port = [int]$values['HOST_ADAPTER_PORT']
  $token = $values['HOST_ADAPTER_TOKEN']
  $headers = @{ Authorization = "Bearer $token" }
  $adapterHealth = Invoke-RestMethod -Uri "http://127.0.0.1:$port/health" -Headers $headers -TimeoutSec 15
  if (-not $adapterHealth.ok) { throw "$role adapter health check failed." }
  $adapterReady = Invoke-RestMethod -Uri "http://127.0.0.1:$port/ready" -Headers $headers -TimeoutSec 15
  if (-not $adapterReady.ready) { throw "$role adapter readiness check failed." }
}

$expectedTasks = @('Hermes-V2-Hermes-HostAdapter', 'Hermes-V2-Codex-HostAdapter')
foreach ($taskName in $expectedTasks) {
  $task = Get-ScheduledTask -TaskName $taskName -ErrorAction Stop
  if ($task.State -eq 'Disabled') { throw "Scheduled Task is disabled: $taskName" }
}

Write-Host 'Agent Workflow V2 smoke test PASS.'
Write-Host ($ready | ConvertTo-Json -Compress)
