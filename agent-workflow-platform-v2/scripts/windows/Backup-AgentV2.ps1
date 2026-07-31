[CmdletBinding()]
param(
  [Parameter(Mandatory = $false)]
  [string]$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path,

  [Parameter(Mandatory = $false)]
  [string]$BackupRoot = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$ProjectRoot = (Resolve-Path $ProjectRoot).Path
if ([string]::IsNullOrWhiteSpace($BackupRoot)) {
  $BackupRoot = Join-Path $ProjectRoot 'runtime\backups'
}
$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backupDir = Join-Path $BackupRoot $timestamp
New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
Set-Location $ProjectRoot

$containerId = (& docker compose --env-file .env -f compose.yml ps -q postgres).Trim()
if (-not $containerId) { throw 'PostgreSQL container is not running.' }
& docker compose --env-file .env -f compose.yml exec -T postgres sh -c 'pg_dump -U agent_v2 -d agent_v2 -Fc -f /tmp/agent_v2.dump'
if ($LASTEXITCODE -ne 0) { throw 'PostgreSQL dump failed.' }
& docker cp "${containerId}:/tmp/agent_v2.dump" (Join-Path $backupDir 'agent_v2.dump')
if ($LASTEXITCODE -ne 0) { throw 'Copying PostgreSQL dump failed.' }
& docker compose --env-file .env -f compose.yml exec -T postgres rm -f /tmp/agent_v2.dump

$minioVolume = (& docker volume ls --format '{{.Name}}' --filter 'name=agent-workflow-platform-v2_minio-data' | Select-Object -First 1).Trim()
if (-not $minioVolume) { throw 'MinIO data volume was not found.' }
$mount = $backupDir.Replace('\', '/')
& docker run --rm -v "${minioVolume}:/data:ro" -v "${mount}:/backup" alpine:3.21 sh -c 'tar -czf /backup/minio-data.tgz -C /data .'
if ($LASTEXITCODE -ne 0) { throw 'MinIO backup failed.' }

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
  gitCommit = (& git rev-parse HEAD).Trim()
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
$manifest | ConvertTo-Json -Depth 10 | Set-Content -Path $manifestPath -Encoding utf8NoBOM

Write-Host "Backup PASS: $backupDir"
Write-Output $backupDir
