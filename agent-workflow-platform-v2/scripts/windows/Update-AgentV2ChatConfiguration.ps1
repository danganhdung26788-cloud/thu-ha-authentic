[CmdletBinding()]
param(
  [Parameter(Mandatory = $false)]
  [string]$ProjectRoot = ''
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

function Read-EnvValues([string]$Path) {
  $values = @{}
  Get-Content -LiteralPath $Path | ForEach-Object {
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

$envPath = Join-Path $ProjectRoot '.env'
if (-not (Test-Path $envPath)) { throw "Local configuration is missing: $envPath" }
$content = Get-Content -Raw -LiteralPath $envPath
$values = Read-EnvValues $envPath

$defaults = [ordered]@{
  MODEL_PROVIDER = 'ollama'
  MODEL_BASE_URL = 'http://ollama:11434/v1'
  MODEL_API_KEY = 'ollama-local'
  MANAGER_MODEL = 'qwen3:4b'
  SPECIALIST_MODEL = 'qwen3:4b'
  MODEL_USE_RESPONSES = 'false'
  MODEL_REQUEST_TIMEOUT_MS = '90000'
  OPENAI_AGENTS_DISABLE_TRACING = '1'
  AGENT_MAX_TURNS = '12'
  DEFAULT_OWNER_ID = 'danganhdung'
  DEFAULT_WORKSPACE_ID = 'workflow-v2-sandbox'
  CHAT_SESSION_TTL_SECONDS = '86400'
  CHAT_ATTACHMENT_ROOT = '/workspace/chat-attachments'
  CHAT_ATTACHMENT_SCOPE_ROOT = 'runtime/chat-attachments'
  CHAT_MAX_ATTACHMENT_BYTES = '26214400'
  CHAT_MAX_DIAGNOSTIC_BYTES = '20480'
  CLAMAV_HOST = 'clamav'
  CLAMAV_PORT = '3310'
  CLAMAV_TIMEOUT_MS = '120000'
  CLAMAV_REQUIRED = 'true'
  OLLAMA_MODEL = 'qwen3:4b'
  OLLAMA_KEEP_ALIVE = '24h'
  RUNTIME_GIT_COMMIT = 'unknown'
}

$changed = @()
foreach ($entry in $defaults.GetEnumerator()) {
  $current = if ($values.ContainsKey($entry.Key)) { [string]$values[$entry.Key] } else { '' }
  if ([string]::IsNullOrWhiteSpace($current)) {
    $content = Set-EnvValue $content $entry.Key ([string]$entry.Value)
    $changed += $entry.Key
  }
}

$attachmentDirectory = Join-Path $ProjectRoot 'runtime\chat-attachments'
$diagnosticDirectory = Join-Path $ProjectRoot 'runtime\diagnostics'
$benchmarkDirectory = Join-Path $ProjectRoot 'runtime\benchmark'
foreach ($directory in @($attachmentDirectory, $diagnosticDirectory, $benchmarkDirectory)) {
  New-Item -ItemType Directory -Force -Path $directory | Out-Null
}

if ($changed.Count -gt 0) {
  $backupPath = Join-Path $ProjectRoot ('runtime\config-before-chat-first-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.env.bak')
  Copy-Item -LiteralPath $envPath -Destination $backupPath -Force
  Write-Utf8NoBom -Path $envPath -Content $content
  Write-Host ('Updated non-secret chat-first settings: ' + ($changed -join ', '))
  Write-Host "Previous configuration backup: $backupPath"
} else {
  Write-Host 'Existing local configuration already contains the required chat-first settings.'
}
Write-Host 'Existing passwords, API keys, tokens, database credentials and adapter credentials were not printed or replaced.'
