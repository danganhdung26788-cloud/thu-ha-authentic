[CmdletBinding()]
param(
  [Parameter(Mandatory = $false)]
  [string]$ProjectRoot = '',

  [switch]$RemoveScheduledTasks
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

$taskNames = @('Hermes-V2-Hermes-HostAdapter', 'Hermes-V2-Codex-HostAdapter')
foreach ($taskName in $taskNames) {
  $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  if ($task) {
    Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if ($RemoveScheduledTasks) {
      Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    }
  }
}
Set-Location $ProjectRoot
& docker.exe compose --env-file .env -f compose.yml down
if ($LASTEXITCODE -ne 0) { throw 'Docker Compose shutdown failed.' }
Write-Host 'Workflow AI V2 stopped without deleting volumes or V1.'
