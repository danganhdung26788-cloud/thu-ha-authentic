[CmdletBinding()]
param(
  [Parameter(Mandatory = $false)]
  [string]$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path,

  [Parameter(Mandatory = $false)]
  [string]$WorkspaceRoot = '',

  [switch]$SkipCodexLoginCheck,
  [switch]$ConfigureFirewall,
  [switch]$EnterShadow
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$ProjectRoot = (Resolve-Path $ProjectRoot).Path
if ([string]::IsNullOrWhiteSpace($WorkspaceRoot)) { $WorkspaceRoot = $ProjectRoot }
Set-Location $ProjectRoot

function Assert-Command([string]$Name) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "Required command is unavailable: $Name"
  }
}

Assert-Command 'node'
Assert-Command 'npm'
Assert-Command 'docker'
Assert-Command 'git'

$nodeMajor = [int]((& node --version).TrimStart('v').Split('.')[0])
if ($nodeMajor -lt 22) { throw "Node.js 22+ is required. Current: $(& node --version)" }
& docker info *> $null
if ($LASTEXITCODE -ne 0) { throw 'Docker Desktop engine is not running.' }

if (-not (Test-Path (Join-Path $ProjectRoot '.env'))) {
  & (Join-Path $PSScriptRoot 'New-AgentV2Configuration.ps1') -ProjectRoot $ProjectRoot -WorkspaceRoot $WorkspaceRoot
}

Write-Host 'Installing locked dependencies...'
& npm ci --ignore-scripts
if ($LASTEXITCODE -ne 0) { throw 'npm ci failed.' }

Write-Host 'Running type check, tests and build...'
& npm run check
if ($LASTEXITCODE -ne 0) { throw 'Type check failed.' }
& npm test
if ($LASTEXITCODE -ne 0) { throw 'Tests failed.' }
& npm run build
if ($LASTEXITCODE -ne 0) { throw 'Build failed.' }

if (-not $SkipCodexLoginCheck) {
  Write-Host 'Checking Codex CLI availability...'
  & npx --no-install codex --version
  if ($LASTEXITCODE -ne 0) {
    throw 'Codex CLI is unavailable. Complete Codex sign-in before deployment.'
  }
}

if ($ConfigureFirewall) {
  & (Join-Path $PSScriptRoot 'Register-AgentV2FirewallRules.ps1') -ApproveFirewallChange -Confirm:$false
}

Write-Host 'Starting isolated V2 control plane...'
& docker compose --env-file .env -f compose.yml up -d --build
if ($LASTEXITCODE -ne 0) { throw 'Docker Compose deployment failed.' }

& (Join-Path $PSScriptRoot 'Register-AgentV2ScheduledTasks.ps1') -ProjectRoot $ProjectRoot
Start-Sleep -Seconds 5
& (Join-Path $PSScriptRoot 'Test-AgentV2.ps1') -ProjectRoot $ProjectRoot

if ($EnterShadow) {
  & (Join-Path $PSScriptRoot 'Start-AgentV2Shadow.ps1') -ProjectRoot $ProjectRoot
}

Write-Host 'Workflow AI V2 deployment completed in isolated mode.'
Write-Host 'V1 remains unchanged. Cutover state remains V1_ONLY unless -EnterShadow was supplied.'
Write-Host 'Gemini remains disabled and has no API cost.'
