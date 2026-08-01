[CmdletBinding()]
param(
  [Parameter(Mandatory = $false)]
  [string]$BridgeRoot = '',

  [Parameter(Mandatory = $false)]
  [switch]$KeepRunning
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

function Write-Utf8NoBom([string]$Path, [string]$Content) {
  $encoding = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($Path, $Content, $encoding)
}

function Protect-Text([string]$Text) {
  $safe = $Text
  $safe = [Regex]::Replace($safe, '(?i)Bearer\s+[A-Za-z0-9._~+/=-]+', 'Bearer [REDACTED]')
  $safe = [Regex]::Replace(
    $safe,
    '(?im)^(\s*(?:MCP_AUTH_TOKEN|SPECIALIST_API_KEY)\s*=).+$',
    '$1[REDACTED]'
  )
  return $safe
}

$installScript = Join-Path $ScriptDirectory 'Install-BridgeReadOnly.ps1'
$startScript = Join-Path $ScriptDirectory 'Start-Bridge.ps1'
$testScript = Join-Path $ScriptDirectory 'Test-Bridge.ps1'
$stopScript = Join-Path $ScriptDirectory 'Stop-Bridge.ps1'
$runtimeDirectory = Join-Path $BridgeRoot 'runtime'
$receiptPath = Join-Path $runtimeDirectory 'cwc-p3-read-only-uat-latest.json'
New-Item -ItemType Directory -Force -Path $runtimeDirectory | Out-Null

$started = $false
$passed = $false
$errorMessage = ''
$commit = 'unknown'
$git = Get-Command git.exe -ErrorAction SilentlyContinue
if ($null -ne $git) {
  try {
    $commit = (& $git.Source -C (Resolve-Path (Join-Path $BridgeRoot '..')).Path rev-parse HEAD).Trim()
  } catch {
    $commit = 'unknown'
  }
}

try {
  & $installScript -BridgeRoot $BridgeRoot
  & $startScript -BridgeRoot $BridgeRoot
  $started = $true
  & $testScript -BridgeRoot $BridgeRoot
  $passed = $true
} catch {
  $errorMessage = Protect-Text -Text $_.Exception.Message
} finally {
  if ($started -and (-not $KeepRunning -or -not $passed)) {
    try {
      & $stopScript -BridgeRoot $BridgeRoot
      $started = $false
    } catch {
      if ([string]::IsNullOrWhiteSpace($errorMessage)) {
        $errorMessage = Protect-Text -Text $_.Exception.Message
      }
    }
  }

  $receipt = [ordered]@{
    schemaVersion = '1.0.0'
    phase = 'CWC-P3'
    mode = 'READ_ONLY_WINDOWS_UAT'
    status = if ($passed) { 'PASS' } else { 'FAIL' }
    testedAt = (Get-Date).ToUniversalTime().ToString('o')
    repositoryCommit = $commit
    chatgptPrimaryBrain = $true
    backendManagerAgent = $false
    separateChatUi = $false
    codexMode = 'READ_ONLY_PROPOSAL'
    localWrite = $false
    connectedToChatgpt = $false
    bridgeLeftRunning = $started
    error = $errorMessage
  }
  Write-Utf8NoBom -Path $receiptPath -Content ($receipt | ConvertTo-Json -Depth 6)
}

if (-not $passed) {
  throw "CWC-P3 read-only UAT failed. Receipt: $receiptPath. Error: $errorMessage"
}

Write-Host 'CWC_P3_READ_ONLY_UAT=PASS'
Write-Host "UAT_RECEIPT=$receiptPath"
Write-Host 'CHATGPT_PRIMARY_BRAIN=true'
Write-Host 'BACKEND_MANAGER_AGENT=false'
Write-Host 'SEPARATE_CHAT_UI=false'
Write-Host 'CODEX_MODE=READ_ONLY_PROPOSAL'
Write-Host 'LOCAL_WRITE=false'
Write-Host 'CONNECTED_TO_CHATGPT=false'
Write-Host "BRIDGE_LEFT_RUNNING=$($started.ToString().ToLowerInvariant())"
