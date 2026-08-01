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
        allowCodexWrite = $false
        allowLocalRead = $true
        allowLocalWrite = $false
      }
    )
  }
  Write-Utf8NoBom -Path $workspacePath -Content ($document | ConvertTo-Json -Depth 8)
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
Write-Host 'LOCAL_WRITE_ENABLED=false'
Write-Host 'CODEX_WRITE_ENABLED=false'
Write-Host 'AUTOSTART_REGISTERED=false'
Write-Host 'CONNECTED_TO_CHATGPT=false'
Write-Host 'Current ChatGPT plan/tunnel gate must be resolved before connection.'
