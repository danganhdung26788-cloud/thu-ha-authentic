[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('hermes', 'codex')]
  [string]$Role,

  [Parameter(Mandatory = $false)]
  [string]$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$ProjectRoot = (Resolve-Path $ProjectRoot).Path
$envFile = Join-Path $ProjectRoot "runtime\host-adapter.$Role.env"
$entrypoint = Join-Path $ProjectRoot 'dist\src\apps\host-adapter\main.js'
$logDir = Join-Path $ProjectRoot 'runtime\logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

if (-not (Test-Path $envFile)) { throw "Missing host adapter configuration: $envFile" }
if (-not (Test-Path $entrypoint)) { throw "Missing compiled host adapter: $entrypoint" }

Get-Content -Path $envFile | ForEach-Object {
  $line = $_.Trim()
  if (-not $line -or $line.StartsWith('#')) { return }
  $separator = $line.IndexOf('=')
  if ($separator -lt 1) { throw "Invalid environment line in ${envFile}: $line" }
  $name = $line.Substring(0, $separator)
  $value = $line.Substring($separator + 1)
  [Environment]::SetEnvironmentVariable($name, $value, 'Process')
}

$stdout = Join-Path $logDir "$Role.stdout.log"
$stderr = Join-Path $logDir "$Role.stderr.log"
Set-Location $ProjectRoot
& node $entrypoint 1>> $stdout 2>> $stderr
exit $LASTEXITCODE
