[CmdletBinding()]
param(
  [Parameter(Mandatory = $false)]
  [string]$BridgeRoot = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$ScriptDirectory = if (-not [string]::IsNullOrWhiteSpace($PSScriptRoot)) {
  $PSScriptRoot
} else {
  Split-Path -Parent $MyInvocation.MyCommand.Path
}
if ([string]::IsNullOrWhiteSpace($BridgeRoot)) {
  $BridgeRoot = (Resolve-Path (Join-Path $ScriptDirectory '..\..')).Path
} else {
  $BridgeRoot = (Resolve-Path $BridgeRoot).Path
}

$pidPath = Join-Path $BridgeRoot 'runtime\bridge.pid'
if (-not (Test-Path $pidPath)) {
  Write-Host 'BRIDGE_RUNNING=false'
  return
}

$bridgePid = 0
if (-not [int]::TryParse((Get-Content -Raw -LiteralPath $pidPath).Trim(), [ref]$bridgePid)) {
  throw 'Bridge PID file is invalid.'
}
$process = Get-CimInstance Win32_Process -Filter "ProcessId=$bridgePid" -ErrorAction SilentlyContinue
if ($null -eq $process) {
  Remove-Item -LiteralPath $pidPath -Force
  Write-Host 'BRIDGE_RUNNING=false'
  return
}
if ($process.Name -ne 'node.exe' -or $process.CommandLine -notmatch 'dist[\\/]src[\\/]index\.js') {
  throw "PID $bridgePid does not match the delegation bridge process. No process was stopped."
}

Stop-Process -Id $bridgePid -Force
Remove-Item -LiteralPath $pidPath -Force -ErrorAction SilentlyContinue
Write-Host 'BRIDGE_STOPPED=true'
Write-Host 'DATA_DELETED=false'
