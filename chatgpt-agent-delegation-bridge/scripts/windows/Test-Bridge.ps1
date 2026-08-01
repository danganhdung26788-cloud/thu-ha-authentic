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

function Read-EnvValue([string]$Path, [string]$Name, [string]$DefaultValue) {
  foreach ($line in Get-Content -LiteralPath $Path) {
    $trimmed = $line.Trim()
    if (-not $trimmed -or $trimmed.StartsWith('#')) { continue }
    $separator = $trimmed.IndexOf('=')
    if ($separator -le 0) { continue }
    if ($trimmed.Substring(0, $separator) -eq $Name) {
      return $trimmed.Substring($separator + 1)
    }
  }
  return $DefaultValue
}

$bind = Read-EnvValue '.env' 'MCP_BIND' '127.0.0.1'
$port = [int](Read-EnvValue '.env' 'MCP_PORT' '3210')
$authMode = Read-EnvValue '.env' 'MCP_AUTH_MODE' 'none'
$authToken = Read-EnvValue '.env' 'MCP_AUTH_TOKEN' ''
$healthHost = if ($bind -eq '0.0.0.0' -or $bind -eq 'localhost') { '127.0.0.1' } else { $bind }
$healthUri = "http://${healthHost}:$port/health"
$headers = @{}
if ($authMode -eq 'bearer') {
  if ([string]::IsNullOrWhiteSpace($authToken)) { throw 'MCP_AUTH_TOKEN is missing.' }
  $headers['Authorization'] = "Bearer $authToken"
}

$health = Invoke-RestMethod -Uri $healthUri -Headers $headers -TimeoutSec 10
if ($health.ok -ne $true -or $health.bridge -ne 'chatgpt-primary-delegation') {
  throw 'Bridge HTTP identity or health check failed.'
}

& node.exe --env-file=.env .\scripts\smoke-mcp.mjs
if ($LASTEXITCODE -ne 0) { throw 'Official MCP client smoke test failed.' }

Write-Host 'BRIDGE_HTTP_HEALTH=PASS'
Write-Host 'BRIDGE_SERVICE_IDENTITY=PASS'
Write-Host 'BRIDGE_MCP_PROTOCOL=PASS'
Write-Host 'CHATGPT_PRIMARY_BRAIN=true'
Write-Host 'BACKEND_MANAGER_AGENT=false'
Write-Host 'V2_RUNTIME_DEPENDENCY=false'
Write-Host 'CONNECTED_TO_CHATGPT=false'
