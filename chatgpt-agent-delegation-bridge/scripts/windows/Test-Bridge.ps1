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
Set-Location $BridgeRoot

$health = Invoke-RestMethod -Uri 'http://127.0.0.1:3210/health' -TimeoutSec 10
if ($health.ok -ne $true) { throw 'Bridge HTTP health failed.' }

& node.exe --env-file=.env .\scripts\smoke-mcp.mjs
if ($LASTEXITCODE -ne 0) { throw 'Official MCP client smoke test failed.' }

Write-Host 'BRIDGE_HTTP_HEALTH=PASS'
Write-Host 'BRIDGE_MCP_PROTOCOL=PASS'
Write-Host 'CHATGPT_PRIMARY_BRAIN=true'
Write-Host 'BACKEND_MANAGER_AGENT=false'
Write-Host 'V2_RUNTIME_DEPENDENCY=false'
Write-Host 'CONNECTED_TO_CHATGPT=false'
