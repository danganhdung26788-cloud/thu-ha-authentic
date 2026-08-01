[CmdletBinding()]
param(
  [Parameter(Mandatory = $false)]
  [string]$ProjectRoot = '',

  [Parameter(Mandatory = $false)]
  [string]$BackupRoot = ''
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
if ([string]::IsNullOrWhiteSpace($BackupRoot)) {
  $BackupRoot = Join-Path $ProjectRoot 'runtime\backups'
}

function Write-Utf8NoBom([string]$Path, [string]$Content) {
  $encoding = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($Path, $Content, $encoding)
}

$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backupDir = Join-Path $BackupRoot $timestamp
New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
Set-Location $ProjectRoot
$servicesStopped = $false
$minioStopped = $false

try {
  & docker.exe compose --env-file .env -f compose.yml stop api worker
  if ($LASTEXITCODE -ne 0) { throw 'Failed to stop API/worker for a consistent backup.' }
  $servicesStopped = $true

  $containerId = (& docker.exe compose --env-file .env -f compose.yml ps -q postgres).Trim()
  if (-not $containerId) { throw 'PostgreSQL container is not running.' }
  & docker.exe compose --env-file .env -f compose.yml exec -T postgres sh -c 'pg_dump -U agent_v2 -d agent_v2 -Fc -f /tmp/agent_v2.dump'
  if ($LASTEXITCODE -ne 0) { throw 'PostgreSQL dump failed.' }
  & docker.exe cp "${containerId}:/tmp/agent_v2.dump" (Join-Path $backupDir 'agent_v2.dump')
  if ($LASTEXITCODE -ne 0) { throw 'Copying PostgreSQL dump failed.' }
  & docker.exe compose --env-file .env -f compose.yml exec -T postgres rm -f /tmp/agent_v2.dump

  & docker.exe compose --env-file .env -f compose.yml stop minio
  if ($LASTEXITCODE -ne 0) { throw 'Failed to stop MinIO for a consistent backup.' }
  $minioStopped = $true
  $minioVolume = (& docker.exe volume ls --format '{{.Name}}' --filter 'name=agent-workflow-platform-v2_minio-data' | Select-Object -First 1).Trim()
  if (-not $minioVolume) { throw 'MinIO data volume was not found.' }
  $mount = $backupDir.Replace('\', '/')
  & docker.exe run --rm -v "${minioVolume}:/data:ro" -v "${mount}:/backup" alpine:3.21 sh -c 'tar -czf /backup/minio-data.tgz -C /data .'
  if ($LASTEXITCODE -ne 0) { throw 'MinIO backup failed.' }

  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $attachmentDirectory = Join-Path $ProjectRoot 'runtime\chat-attachments'
  New-Item -ItemType Directory -Force -Path $attachmentDirectory | Out-Null
  $attachmentArchive = Join-Path $backupDir 'chat-attachments.zip'
  [System.IO.Compression.ZipFile]::CreateFromDirectory(
    $attachmentDirectory,
    $attachmentArchive,
    [System.IO.Compression.CompressionLevel]::Optimal,
    $false
  )

  $ollamaModels = (& docker.exe compose --env-file .env -f compose.yml exec -T ollama ollama list 2>&1 | Out-String)
  Write-Utf8NoBom -Path (Join-Path $backupDir 'ollama-models.txt') -Content $ollamaModels

  $configFiles = @('.env', 'runtime\workspaces.json', 'runtime\host-adapter.hermes.env', 'runtime\host-adapter.codex.env')
  foreach ($relative in $configFiles) {
    $source = Join-Path $ProjectRoot $relative
    if (Test-Path $source) {
      $targetName = $relative.Replace('\', '__').Replace('/', '__')
      Copy-Item -LiteralPath $source -Destination (Join-Path $backupDir $targetName) -Force
    }
  }

  $manifest = [ordered]@{
    createdAt = (Get-Date).ToUniversalTime().ToString('o')
    projectRoot = $ProjectRoot
    gitCommit = (& git.exe rev-parse HEAD).Trim()
    cutoverPhase = 'V1_ONLY'
    includesChatAttachments = $true
    includesOllamaModelMetadata = $true
    files = @()
  }
  Get-ChildItem -File -Path $backupDir | ForEach-Object {
    $manifest.files += [ordered]@{
      name = $_.Name
      length = $_.Length
      sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $_.FullName).Hash.ToLowerInvariant()
    }
  }
  $manifestPath = Join-Path $backupDir 'manifest.json'
  Write-Utf8NoBom -Path $manifestPath -Content ($manifest | ConvertTo-Json -Depth 10)
} finally {
  if ($minioStopped) {
    & docker.exe compose --env-file .env -f compose.yml up -d minio | Out-Null
  }
  if ($servicesStopped) {
    & docker.exe compose --env-file .env -f compose.yml up -d api worker | Out-Null
  }
}

Start-Sleep -Seconds 8
& (Join-Path $ScriptDirectory 'Test-AgentV2.ps1') -ProjectRoot $ProjectRoot
Write-Host "Backup PASS: $backupDir"
Write-Output $backupDir
