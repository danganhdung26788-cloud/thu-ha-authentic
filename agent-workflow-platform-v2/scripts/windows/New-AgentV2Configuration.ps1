[CmdletBinding()]
param(
  [Parameter(Mandatory = $false)]
  [string]$ProjectRoot = '',

  [Parameter(Mandatory = $false)]
  [string]$WorkspaceRoot = ''
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

function New-RandomSecret([int]$Bytes = 48) {
  $buffer = New-Object byte[] $Bytes
  $generator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try {
    $generator.GetBytes($buffer)
  } finally {
    if ($null -ne $generator) { $generator.Dispose() }
  }
  return [Convert]::ToBase64String($buffer).TrimEnd('=').Replace('+', '-').Replace('/', '_')
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

if ([string]::IsNullOrWhiteSpace($WorkspaceRoot)) { $WorkspaceRoot = $ProjectRoot }
$WorkspaceRoot = [System.IO.Path]::GetFullPath($WorkspaceRoot)
$envTemplate = Join-Path $ProjectRoot '.env.example'
$envFile = Join-Path $ProjectRoot '.env'
$runtimeDir = Join-Path $ProjectRoot 'runtime'
$attachmentDir = Join-Path $runtimeDir 'chat-attachments'
New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null
New-Item -ItemType Directory -Force -Path $attachmentDir | Out-Null
New-Item -ItemType Directory -Force -Path $WorkspaceRoot | Out-Null

if (-not (Test-Path $envTemplate)) { throw "Missing template: $envTemplate" }
if (Test-Path $envFile) { throw "Refusing to overwrite existing configuration: $envFile" }

$postgresPassword = New-RandomSecret 48
$minioAccessKey = 'agentv2-' + (New-RandomSecret 12).Substring(0, 16)
$minioSecretKey = New-RandomSecret 48
$apiToken = New-RandomSecret 48
$adapterToken = New-RandomSecret 48

$content = Get-Content -Raw -Path $envTemplate
$content = Set-EnvValue $content 'POSTGRES_PASSWORD' $postgresPassword
$content = Set-EnvValue $content 'DATABASE_URL' "postgresql://agent_v2:$postgresPassword@postgres:5432/agent_v2"
$content = Set-EnvValue $content 'MINIO_ACCESS_KEY' $minioAccessKey
$content = Set-EnvValue $content 'MINIO_SECRET_KEY' $minioSecretKey
$content = Set-EnvValue $content 'API_AUTH_TOKEN' $apiToken
$content = Set-EnvValue $content 'ADAPTER_AUTH_TOKEN' $adapterToken
$content = Set-EnvValue $content 'HERMES_ADAPTER_URL' 'http://host.docker.internal:3201'
$content = Set-EnvValue $content 'CODEX_ADAPTER_URL' 'http://host.docker.internal:3202'
$content = Set-EnvValue $content 'CLAUDE_ADAPTER_URL' ''
$content = Set-EnvValue $content 'MODEL_PROVIDER' 'ollama'
$content = Set-EnvValue $content 'MODEL_BASE_URL' 'http://ollama:11434/v1'
$content = Set-EnvValue $content 'MODEL_API_KEY' 'ollama-local'
$content = Set-EnvValue $content 'MANAGER_MODEL' 'qwen3:4b'
$content = Set-EnvValue $content 'SPECIALIST_MODEL' 'qwen3:4b'
$content = Set-EnvValue $content 'MODEL_USE_RESPONSES' 'false'
$content = Set-EnvValue $content 'OLLAMA_MODEL' 'qwen3:4b'
$content = Set-EnvValue $content 'OPENAI_API_KEY' ''
$content = Set-EnvValue $content 'OPENAI_MANAGER_MODEL' ''
$content = Set-EnvValue $content 'OPENAI_SPECIALIST_MODEL' ''
$content = Set-EnvValue $content 'DEFAULT_OWNER_ID' 'danganhdung'
$content = Set-EnvValue $content 'DEFAULT_WORKSPACE_ID' 'workflow-v2-sandbox'
$content = Set-EnvValue $content 'CHAT_ATTACHMENT_ROOT' '/workspace/chat-attachments'
$content = Set-EnvValue $content 'CHAT_ATTACHMENT_SCOPE_ROOT' 'runtime/chat-attachments'
$content = Set-EnvValue $content 'RUNTIME_GIT_COMMIT' 'unknown'
$content = Set-EnvValue $content 'GOOGLE_API_KEY' ''
$content = Set-EnvValue $content 'GEMINI_MODEL' ''
$content = Set-EnvValue $content 'CANVA_ADAPTER_URL' ''
$content = Set-EnvValue $content 'CANVA_ACCESS_TOKEN' ''
Write-Utf8NoBom -Path $envFile -Content $content

$workspaceTemplate = Join-Path $runtimeDir 'workspaces.example.json'
$workspaceFile = Join-Path $runtimeDir 'workspaces.json'
if (-not (Test-Path $workspaceFile)) {
  $workspaceJson = Get-Content -Raw -Path $workspaceTemplate | ConvertFrom-Json
  $workspaceJson.workspaces[0].root = $WorkspaceRoot.Replace('\', '/')
  $workspaceJson.workspaces[0].readRoots = @($WorkspaceRoot.Replace('\', '/'))
  $workspaceJson.workspaces[0].writeRoots = @($WorkspaceRoot.Replace('\', '/'))
  Write-Utf8NoBom -Path $workspaceFile -Content ($workspaceJson | ConvertTo-Json -Depth 10)
}

foreach ($role in @('hermes', 'codex')) {
  $template = Join-Path $runtimeDir "host-adapter.$role.env.example"
  $target = Join-Path $runtimeDir "host-adapter.$role.env"
  if (-not (Test-Path $target)) {
    $hostContent = Get-Content -Raw -Path $template
    $hostContent = Set-EnvValue $hostContent 'HOST_ADAPTER_TOKEN' $adapterToken
    $hostContent = Set-EnvValue $hostContent 'HOST_ADAPTER_REGISTRY_PATH' ($workspaceFile.Replace('\', '/'))
    $hostContent = Set-EnvValue $hostContent 'HOST_ADAPTER_RECEIPT_ROOT' ((Join-Path $runtimeDir 'receipts').Replace('\', '/'))
    Write-Utf8NoBom -Path $target -Content $hostContent
  }
}

Write-Host "Created secure V2 configuration at $envFile"
Write-Host 'Local Ollama Manager is configured; OpenAI and Gemini API billing remain disabled.'
Write-Host "Workspace registry: $workspaceFile"
Write-Host "Chat attachment directory: $attachmentDir"
