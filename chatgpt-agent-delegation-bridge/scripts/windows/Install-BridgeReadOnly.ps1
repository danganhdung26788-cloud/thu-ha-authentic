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

function Assert-Command([string]$Name) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "Required command is unavailable: $Name"
  }
}

function Write-Utf8NoBom([string]$Path, [string]$Content) {
  $encoding = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($Path, $Content, $encoding)
}

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

function Set-EnvValue([string]$Path, [string]$Name, [string]$Value) {
  $lines = @(Get-Content -LiteralPath $Path)
  $found = $false
  $updated = foreach ($line in $lines) {
    $trimmed = $line.Trim()
    $separator = $trimmed.IndexOf('=')
    if (-not $trimmed.StartsWith('#') -and $separator -gt 0 -and $trimmed.Substring(0, $separator) -eq $Name) {
      $found = $true
      "$Name=$Value"
    } else {
      $line
    }
  }
  if (-not $found) { $updated += "$Name=$Value" }
  Write-Utf8NoBom -Path $Path -Content (($updated -join "`r`n") + "`r`n")
}

Assert-Command 'node.exe'
Assert-Command 'npm.cmd'

$nodeMajor = [int]((& node.exe --version).TrimStart('v').Split('.')[0])
if ($nodeMajor -lt 22) {
  throw "Node.js 22 or newer is required. Current: $(& node.exe --version)"
}

$envPath = Join-Path $BridgeRoot '.env'
if (-not (Test-Path $envPath)) {
  Copy-Item -LiteralPath (Join-Path $BridgeRoot '.env.example') -Destination $envPath
}

$bind = Read-EnvValue -Path $envPath -Name 'MCP_BIND' -DefaultValue '127.0.0.1'
if ($bind -notin @('127.0.0.1', 'localhost')) {
  throw 'Read-only UAT requires MCP_BIND=127.0.0.1 or localhost.'
}
Set-EnvValue -Path $envPath -Name 'LOCAL_EXECUTOR_ENABLED' -Value 'true'
Set-EnvValue -Path $envPath -Name 'CODEX_NETWORK_ACCESS' -Value 'false'
Set-EnvValue -Path $envPath -Name 'SPECIALIST_AGENT_ENABLED' -Value 'false'

$configDirectory = Join-Path $BridgeRoot 'config'
New-Item -ItemType Directory -Force -Path $configDirectory | Out-Null
$workspacePath = Join-Path $configDirectory 'workspaces.json'
if (-not (Test-Path $workspacePath)) {
  $repoRoot = (Resolve-Path (Join-Path $BridgeRoot '..')).Path
  $document = [ordered]@{
    defaultWorkspaceId = 'thu-ha-authentic'
    workspaces = @(
      [ordered]@{
        workspaceId = 'thu-ha-authentic'
        root = $repoRoot
        readRoots = @('.')
        writeRoots = @()
        allowedExecutables = @('git.exe', 'docker.exe', 'powershell.exe', 'pwsh.exe', 'schtasks.exe')
        allowedScripts = @()
        scheduledTaskPrefix = 'SYSTEM-AI-'
        allowCodexRead = $true
        allowLocalRead = $true
        allowLocalWrite = $false
      }
    )
  }
  Write-Utf8NoBom -Path $workspacePath -Content ($document | ConvertTo-Json -Depth 8)
}

$workspaceDocument = Get-Content -Raw -LiteralPath $workspacePath | ConvertFrom-Json
$workspaces = @($workspaceDocument.workspaces)
if ($workspaces.Count -eq 0) { throw 'At least one workspace is required.' }
if (@($workspaces | Where-Object { $_.allowLocalRead -eq $true }).Count -eq 0) {
  throw 'Read-only UAT requires at least one workspace with allowLocalRead=true.'
}
foreach ($workspace in $workspaces) {
  if ($workspace.allowLocalWrite -eq $true) {
    throw "Read-only UAT refuses workspace write permission: $($workspace.workspaceId)"
  }
  if (@($workspace.writeRoots).Count -gt 0) {
    throw "Read-only UAT refuses configured write roots: $($workspace.workspaceId)"
  }
  if (@($workspace.allowedScripts).Count -gt 0) {
    throw "Read-only UAT refuses configured executable scripts: $($workspace.workspaceId)"
  }
}

New-Item -ItemType Directory -Force -Path (Join-Path $BridgeRoot 'runtime') | Out-Null

Write-Host 'Installing exact locked dependencies...'
& npm.cmd ci --ignore-scripts
if ($LASTEXITCODE -ne 0) { throw 'npm ci failed.' }

Write-Host 'Running bridge validation...'
& npm.cmd run check
if ($LASTEXITCODE -ne 0) { throw 'TypeScript check failed.' }
& npm.cmd test
if ($LASTEXITCODE -ne 0) { throw 'Bridge tests failed.' }
& npm.cmd run build
if ($LASTEXITCODE -ne 0) { throw 'Bridge build failed.' }

Write-Host 'BRIDGE_READ_ONLY_INSTALL=PASS'
Write-Host 'CHATGPT_PRIMARY_BRAIN=true'
Write-Host 'BACKEND_MANAGER_AGENT=false'
Write-Host 'SPECIALIST_AI_MUTATION=false'
Write-Host 'LOCAL_INSPECTION_ENABLED=true'
Write-Host 'LOCAL_WRITE_ENABLED=false'
Write-Host 'AUTOSTART_REGISTERED=false'
Write-Host 'CONNECTED_TO_CHATGPT=false'
Write-Host 'Current ChatGPT plan/tunnel gate must be resolved before connection.'
