[CmdletBinding()]
param(
  [Parameter(Mandatory = $false)]
  [string]$BridgeRoot = '',

  [Parameter(Mandatory = $false)]
  [string]$TunnelClientPath = '',

  [Parameter(Mandatory = $false)]
  [switch]$StopBridge
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

function Resolve-TunnelClient([string]$Candidate) {
  if (-not [string]::IsNullOrWhiteSpace($Candidate)) {
    return (Resolve-Path -LiteralPath $Candidate).Path
  }
  foreach ($name in @('tunnel-client.exe', 'tunnel-client')) {
    $command = Get-Command $name -ErrorAction SilentlyContinue
    if ($null -ne $command) { return $command.Source }
  }
  throw 'tunnel-client is unavailable. Pass -TunnelClientPath to verify the running process before stopping it.'
}

$runtimeDirectory = Join-Path $BridgeRoot 'runtime\secure-mcp-tunnel'
$pidPath = Join-Path $runtimeDirectory 'tunnel.pid'
$healthUrlFile = Join-Path $runtimeDirectory 'health.url'

if (-not (Test-Path -LiteralPath $pidPath)) {
  Write-Host 'SECURE_MCP_TUNNEL_RUNNING=false'
} else {
  $tunnelPid = 0
  if (-not [int]::TryParse((Get-Content -Raw -LiteralPath $pidPath).Trim(), [ref]$tunnelPid)) {
    throw 'Secure MCP Tunnel PID file is invalid.'
  }
  $process = Get-CimInstance Win32_Process -Filter "ProcessId=$tunnelPid" -ErrorAction SilentlyContinue
  if ($null -eq $process) {
    Remove-Item -LiteralPath $pidPath, $healthUrlFile -Force -ErrorAction SilentlyContinue
    Write-Host 'SECURE_MCP_TUNNEL_RUNNING=false'
  } else {
    $expectedPath = Resolve-TunnelClient -Candidate $TunnelClientPath
    $actualPath = [string]$process.ExecutablePath
    if ([string]::IsNullOrWhiteSpace($actualPath) -or
        -not [string]::Equals($actualPath, $expectedPath, [System.StringComparison]::OrdinalIgnoreCase) -or
        [string]$process.CommandLine -notmatch '(?i)(^|\s)run(\s|$)') {
      throw "PID $tunnelPid does not match the approved tunnel-client run process. No process was stopped."
    }
    Stop-Process -Id $tunnelPid -Force -ErrorAction Stop
    Remove-Item -LiteralPath $pidPath, $healthUrlFile -Force -ErrorAction SilentlyContinue
    Write-Host 'SECURE_MCP_TUNNEL_STOPPED=true'
  }
}

if ($StopBridge) {
  & (Join-Path $ScriptDirectory 'Stop-Bridge.ps1') -BridgeRoot $BridgeRoot
}

Write-Host 'DATA_DELETED=false'
Write-Host 'PROFILE_DELETED=false'
Write-Host 'CREDENTIAL_DELETED=false'
