[CmdletBinding()]
param(
  [Parameter(Mandatory = $false)]
  [string]$ProjectRoot = '',

  [Parameter(Mandatory = $false)]
  [string]$WorkspaceRoot = '',

  [switch]$InfrastructureOnly,
  [switch]$SkipCodexLoginCheck,
  [switch]$SkipRoutingBenchmark,
  [switch]$ConfigureFirewall,
  [switch]$EnterShadow
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

function Set-EnvValue([string]$Content, [string]$Name, [string]$Value) {
  $escaped = [Regex]::Escape($Name)
  if ($Content -match "(?m)^$escaped=") {
    return [Regex]::Replace($Content, "(?m)^$escaped=.*$", "$Name=$Value")
  }
  return $Content.TrimEnd() + "`r`n$Name=$Value`r`n"
}

function Write-Utf8NoBom([string]$Path, [string]$Content) {
  $encoding = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($Path, $Content, $encoding)
}

Assert-Command 'node.exe'
Assert-Command 'npm.cmd'
Assert-Command 'docker.exe'
Assert-Command 'git.exe'

$nodeMajor = [int]((& node.exe --version).TrimStart('v').Split('.')[0])
if ($nodeMajor -lt 22) { throw "Node.js 22+ is required. Current: $(& node.exe --version)" }
& docker.exe info *> $null
if ($LASTEXITCODE -ne 0) { throw 'Docker Desktop engine is not running.' }

$envPath = Join-Path $ProjectRoot '.env'
if (-not (Test-Path $envPath)) {
  & (Join-Path $ScriptDirectory 'New-AgentV2Configuration.ps1') -ProjectRoot $ProjectRoot -WorkspaceRoot $WorkspaceRoot
}

$gitCommit = (& git.exe rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($gitCommit)) {
  throw 'Unable to resolve the current Git commit.'
}
$envContent = Get-Content -Raw -LiteralPath $envPath
$envContent = Set-EnvValue $envContent 'RUNTIME_GIT_COMMIT' $gitCommit
Write-Utf8NoBom -Path $envPath -Content $envContent
$envValues = Read-EnvValues $envPath

if ($InfrastructureOnly -and $EnterShadow) {
  throw '-EnterShadow is not allowed with -InfrastructureOnly.'
}
foreach ($required in @('MODEL_PROVIDER', 'MODEL_BASE_URL', 'MANAGER_MODEL', 'SPECIALIST_MODEL')) {
  if (-not $envValues[$required]) {
    throw "$required is empty. Local Manager configuration is incomplete."
  }
}
if ($envValues['MODEL_PROVIDER'] -eq 'openai' -and -not $envValues['OPENAI_API_KEY']) {
  throw 'OPENAI_API_KEY is required only when MODEL_PROVIDER=openai. The default local Ollama provider does not require it.'
}
if ($envValues['MODEL_PROVIDER'] -ne 'ollama' -and $envValues['MODEL_PROVIDER'] -ne 'openai') {
  throw "Unsupported MODEL_PROVIDER: $($envValues['MODEL_PROVIDER'])"
}

$attachmentDirectory = Join-Path $ProjectRoot 'runtime\chat-attachments'
New-Item -ItemType Directory -Force -Path $attachmentDirectory | Out-Null

Write-Host 'Installing locked dependencies...'
& npm.cmd ci --ignore-scripts
if ($LASTEXITCODE -ne 0) { throw 'npm ci failed.' }

Write-Host 'Running type check, tests and build...'
& npm.cmd run check
if ($LASTEXITCODE -ne 0) { throw 'Type check failed.' }
& npm.cmd test
if ($LASTEXITCODE -ne 0) { throw 'Tests failed.' }
& npm.cmd run build
if ($LASTEXITCODE -ne 0) { throw 'Build failed.' }

if (-not $SkipCodexLoginCheck) {
  Write-Host 'Checking Codex CLI availability...'
  Assert-Command 'npx.cmd'
  & npx.cmd --no-install codex --version
  if ($LASTEXITCODE -ne 0) {
    throw 'Codex CLI is unavailable. Complete Codex sign-in before deployment.'
  }
}

if ($ConfigureFirewall) {
  & (Join-Path $ScriptDirectory 'Register-AgentV2FirewallRules.ps1') -ApproveFirewallChange -Confirm:$false
}

Write-Host 'Starting isolated V2 control plane and local Manager model...'
& docker.exe compose --env-file .env -f compose.yml up -d --build
if ($LASTEXITCODE -ne 0) { throw 'Docker Compose deployment failed.' }

& (Join-Path $ScriptDirectory 'Register-AgentV2ScheduledTasks.ps1') -ProjectRoot $ProjectRoot
& (Join-Path $ScriptDirectory 'Install-WorkflowV2ChatApp.ps1') -ProjectRoot $ProjectRoot
Start-Sleep -Seconds 8
& (Join-Path $ScriptDirectory 'Test-AgentV2.ps1') -ProjectRoot $ProjectRoot

if (-not $InfrastructureOnly -and -not $SkipRoutingBenchmark) {
  & (Join-Path $ScriptDirectory 'Test-LocalManagerRouting.ps1') -ProjectRoot $ProjectRoot
}

if ($EnterShadow) {
  & (Join-Path $ScriptDirectory 'Start-AgentV2Shadow.ps1') -ProjectRoot $ProjectRoot
}

if ($InfrastructureOnly) {
  Write-Host 'Workflow AI V2 compatibility deployment PASS. Local model is installed, but routing UAT and Shadow remain blocked.'
} elseif ($SkipRoutingBenchmark) {
  Write-Host 'Workflow AI V2 runtime started, but routing benchmark was explicitly skipped. Normal UAT and Shadow remain blocked.'
} else {
  Write-Host 'Workflow AI V2 chat-first isolated runtime and local Manager benchmark PASS.'
}
Write-Host 'Normal use: open the Workflow AI shortcut and type one chat message.'
Write-Host 'V1 remains unchanged. Cutover state remains V1_ONLY unless -EnterShadow was explicitly supplied.'
Write-Host 'OpenAI and Gemini API billing remain disabled by default.'
