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

$reportDirectory = Join-Path $ProjectRoot 'runtime\benchmark'
New-Item -ItemType Directory -Force -Path $reportDirectory | Out-Null

Write-Host 'Running 100-case Vietnamese local Manager routing benchmark...'
& docker.exe compose --env-file .env -f compose.yml exec -T worker node dist/src/benchmark/run-routing-benchmark.js
if ($LASTEXITCODE -ne 0) {
  throw 'Local Manager routing benchmark failed. Shadow and normal UAT remain blocked.'
}

$containerId = (& docker.exe compose --env-file .env -f compose.yml ps -q worker).Trim()
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($containerId)) {
  throw 'Unable to resolve the worker container for benchmark report export.'
}
& docker.exe cp "${containerId}:/app/runtime/benchmark/." $reportDirectory
if ($LASTEXITCODE -ne 0) {
  throw 'Benchmark passed but its report could not be exported from the worker container.'
}

$latest = Get-ChildItem -LiteralPath $reportDirectory -Filter 'routing-*.json' -File |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 1
if ($null -eq $latest) { throw 'No routing benchmark report was exported.' }
$report = Get-Content -Raw -LiteralPath $latest.FullName | ConvertFrom-Json
if ($report.summary.schemaRate -ne 1) { throw 'Routing schema acceptance is below 100%.' }
if ($report.summary.routeAccuracy -lt 0.95) { throw 'Routing accuracy is below 95%.' }
if ($report.summary.approvalRecall -ne 1) { throw 'Critical approval recall is below 100%.' }
if ($report.summary.clarificationRecall -ne 1) { throw 'Clarification recall is below 100%.' }
if ($report.summary.toolsValidRate -ne 1) { throw 'Registered tool validity is below 100%.' }

Write-Host 'Local Manager routing benchmark PASS.'
Write-Host ($report.summary | ConvertTo-Json -Compress)
Write-Host "Benchmark report: $($latest.FullName)"
