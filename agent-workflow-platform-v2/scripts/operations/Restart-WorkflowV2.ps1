[CmdletBinding()]
param(
  [Parameter(Mandatory = $false)]
  [string]$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$ProjectRoot = (Resolve-Path $ProjectRoot).Path
Set-Location $ProjectRoot
& docker compose --env-file .env -f compose.yml restart api worker
if ($LASTEXITCODE -ne 0) { throw 'Restarting API/worker failed.' }
foreach ($taskName in @('Hermes-V2-Hermes-HostAdapter', 'Hermes-V2-Codex-HostAdapter')) {
  $task = Get-ScheduledTask -TaskName $taskName -ErrorAction Stop
  if ($task.State -eq 'Running') { Stop-ScheduledTask -TaskName $taskName }
  Start-ScheduledTask -TaskName $taskName
}
Start-Sleep -Seconds 5
& (Join-Path $ProjectRoot 'scripts\windows\Test-AgentV2.ps1') -ProjectRoot $ProjectRoot
