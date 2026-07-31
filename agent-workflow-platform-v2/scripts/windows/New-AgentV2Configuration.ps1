[CmdletBinding()]
param(
  [Parameter(Mandatory = $false)]
  [string]$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path,

  [Parameter(Mandatory = $false)]
  [string]$WorkspaceRoot = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function New-RandomSecret([int]$Bytes = 48) {
  $buffer = New-Object byte[] $Bytes
  [System.Security.Cryptography.RandomNumberGenerator]::Fill($buffer)
  return [Convert]::ToBase64String($buffer).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

function Set-EnvValue([string]$Content, [string]$Name, [string]$Value) {
  $escaped = [Regex]::Escape($Name)
  if ($Content -match "(?m)^$escaped=") {
    return [Regex]::Replace($Content, "(?m)^$escaped=.*$", "$Name=$Value")
  }
  return $Content.TrimEnd() + "`r`n$Name=$Value`r`n"
}

$ProjectRoot = (Resolve-Path $ProjectRoot).Path
if ([string]::IsNullOrWhiteSpace($WorkspaceRoot)) { $WorkspaceRoot = $ProjectRoot }
$WorkspaceRoot = [System.IO.Path]::GetFullPath($WorkspaceRoot)
$envTemplate = Join-Path $ProjectRoot '.env.example'
$envFile = Join-Path $ProjectRoot '.env'
$runtimeDir = Join-Path $ProjectRoot 'runtime'
New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null
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
$content = Set-EnvValue $content 'GOOGLE_API_KEY' ''
$content = Set-EnvValue $content 'GEMINI_MODEL' ''
$content = Set-EnvValue $content 'CANVA_ADAPTER_URL' ''
$content = Set-EnvValue $content 'CANVA_ACCESS_TOKEN' ''
$content | Set-Content -Path $envFile -Encoding utf8NoBOM

$workspaceTemplate = Join-Path $runtimeDir 'workspaces.example.json'
$workspaceFile = Join-Path $runtimeDir 'workspaces.json'
if (-not (Test-Path $workspaceFile)) {
  $workspaceJson = Get-Content -Raw -Path $workspaceTemplate | ConvertFrom-Json
  $workspaceJson.workspaces[0].root = $WorkspaceRoot.Replace('\', '/')
  $workspaceJson.workspaces[0].readRoots = @($WorkspaceRoot.Replace('\', '/'))
  $workspaceJson.workspaces[0].writeRoots = @($WorkspaceRoot.Replace('\', '/'))
  $workspaceJson | ConvertTo-Json -Depth 10 | Set-Content -Path $workspaceFile -Encoding utf8NoBOM
}

foreach ($role in @('hermes', 'codex')) {
  $template = Join-Path $runtimeDir "host-adapter.$role.env.example"
  $target = Join-Path $runtimeDir "host-adapter.$role.env"
  if (-not (Test-Path $target)) {
    $hostContent = Get-Content -Raw -Path $template
    $hostContent = Set-EnvValue $hostContent 'HOST_ADAPTER_TOKEN' $adapterToken
    $hostContent = Set-EnvValue $hostContent 'HOST_ADAPTER_REGISTRY_PATH' ($workspaceFile.Replace('\', '/'))
    $hostContent = Set-EnvValue $hostContent 'HOST_ADAPTER_RECEIPT_ROOT' ((Join-Path $runtimeDir 'receipts').Replace('\', '/'))
    $hostContent | Set-Content -Path $target -Encoding utf8NoBOM
  }
}

Write-Host "Created secure V2 configuration at $envFile"
Write-Host 'Gemini API remains disabled and will not incur API cost.'
Write-Host "Workspace registry: $workspaceFile"
