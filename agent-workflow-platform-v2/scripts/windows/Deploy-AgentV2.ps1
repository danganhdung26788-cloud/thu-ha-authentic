[CmdletBinding()]
param(
  [Parameter(Mandatory = $false)]
  [string]$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path,

  [Parameter(Mandatory = $false)]
  [string]$WorkspaceRoot = '',

  [switch]$InfrastructureOnly,
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

function Read-EnvValues([string]$Path) {
  $values = @{}
  Get-Content -Path $Path | ForEach-Object {
    $line = $_.Trim()
    if (-not $line -or $line.StartsWith('#')) { return }
    $separator = $line.IndexOf('=')
    if ($separator -gt 0) {
      $values[$line.Substring(0, $separator)] = $line.Substring($separator + 1)
    }
  }
  return $values
}

Assert-Command 'node'
Assert-Command 'npm'
Assert-Command 'docker'
Assert-Command 'git'

$nodeMajor = [int]((& node --version).TrimStart('v').Split('.')[0])
if ($nodeMajor -lt 22) { throw "Node.js 22+ is required. Current: $(& node --version)" }
& docker info *> $null
if ($LASTEXITCODE -ne 0) { throw 'Docker Desktop engine is not running.' }

$envPath = Join-Path $ProjectRoot '.env'
if (-not (Test-Path $envPath)) {
  & (Join-Path $PSScriptRoot 'New-AgentV2Configuration.ps1') -ProjectRoot $ProjectRoot -WorkspaceRoot $WorkspaceRoot
}
$envValues = Read-EnvValues $envPath

if ($InfrastructureOnly -and $EnterShadow) {
  throw '-EnterShadow is not allowed with -InfrastructureOnly.'
}
if (-not $InfrastructureOnly) {
  foreach ($required in @('OPENAI_API_KEY', 'OPENAI_MANAGER_MODEL', 'OPENAI_SPECIALIST_MODEL')) {
    if (-not $envValues[$required]) {
      throw "$required is empty. Configure approved OpenAI credentials/models or use -InfrastructureOnly."
    }
  }
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

if ($InfrastructureOnly) {
  Write-Host 'Workflow AI V2 infrastructure deployment PASS; AI task execution remains intentionally inactive.'
} else {
  Write-Host 'Workflow AI V2 isolated runtime deployment PASS.'
}
Write-Host 'V1 remains unchanged. Cutover state remains V1_ONLY unless -EnterShadow was supplied.'
Write-Host 'Gemini remains disabled and has no API cost.'
