[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
param(
  [Parameter(Mandatory = $true)]
  [string]$BackupDirectory,

  [Parameter(Mandatory = $false)]
  [string]$ProjectRoot = '',

  [Parameter(Mandatory = $true)]
  [switch]$ConfirmRestore
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if (-not $ConfirmRestore) { throw 'Restore requires -ConfirmRestore and owner approval.' }

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
$BackupDirectory = (Resolve-Path $BackupDirectory).Path
$manifestPath = Join-Path $BackupDirectory 'manifest.json'
$databaseDump = Join-Path $BackupDirectory 'agent_v2.dump'
$minioArchive = Join-Path $BackupDirectory 'minio-data.tgz'
$attachmentArchive = Join-Path $BackupDirectory 'chat-attachments.zip'
foreach ($required in @($manifestPath, $databaseDump, $minioArchive, $attachmentArchive)) {
  if (-not (Test-Path $required)) { throw "Missing restore artifact: $required" }
}

$manifest = Get-Content -Raw -Path $manifestPath | ConvertFrom-Json
foreach ($file in $manifest.files) {
  $path = Join-Path $BackupDirectory $file.name
  if (-not (Test-Path $path)) { throw "Backup file missing: $($file.name)" }
  $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $path).Hash.ToLowerInvariant()
  if ($hash -ne $file.sha256) { throw "Backup checksum mismatch: $($file.name)" }
}
if ($manifest.includesChatAttachments -ne $true) {
  throw 'Backup manifest does not confirm chat attachment coverage.'
}

if (-not $PSCmdlet.ShouldProcess($ProjectRoot, "Restore Workflow AI V2 from $BackupDirectory")) { return }
Set-Location $ProjectRoot
$servicesStopped = $false
$minioStopped = $false

try {
  & docker.exe compose --env-file .env -f compose.yml stop api worker
  if ($LASTEXITCODE -ne 0) { throw 'Failed to stop API/worker before restore.' }
  $servicesStopped = $true

  $postgresId = (& docker.exe compose --env-file .env -f compose.yml ps -q postgres).Trim()
  if (-not $postgresId) { throw 'PostgreSQL container is not running.' }
  & docker.exe cp $databaseDump "${postgresId}:/tmp/agent_v2.dump"
  if ($LASTEXITCODE -ne 0) { throw 'Copying database dump into container failed.' }
  & docker.exe compose --env-file .env -f compose.yml exec -T postgres sh -c 'dropdb -U agent_v2 --if-exists agent_v2 && createdb -U agent_v2 agent_v2 && pg_restore -U agent_v2 -d agent_v2 --clean --if-exists /tmp/agent_v2.dump'
  if ($LASTEXITCODE -ne 0) { throw 'PostgreSQL restore failed.' }
  & docker.exe compose --env-file .env -f compose.yml exec -T postgres rm -f /tmp/agent_v2.dump

  & docker.exe compose --env-file .env -f compose.yml stop minio
  if ($LASTEXITCODE -ne 0) { throw 'Failed to stop MinIO before restore.' }
  $minioStopped = $true
  $minioVolume = (& docker.exe volume ls --format '{{.Name}}' --filter 'name=agent-workflow-platform-v2_minio-data' | Select-Object -First 1).Trim()
  if (-not $minioVolume) { throw 'MinIO data volume was not found.' }
  $mount = $BackupDirectory.Replace('\', '/')
  & docker.exe run --rm -v "${minioVolume}:/data" -v "${mount}:/backup:ro" alpine:3.21 sh -c 'rm -rf /data/* /data/.[!.]* /data/..?* 2>/dev/null || true; tar -xzf /backup/minio-data.tgz -C /data'
  if ($LASTEXITCODE -ne 0) { throw 'MinIO restore failed.' }

  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $attachmentDirectory = Join-Path $ProjectRoot 'runtime\chat-attachments'
  New-Item -ItemType Directory -Force -Path $attachmentDirectory | Out-Null
  Get-ChildItem -LiteralPath $attachmentDirectory -Force | Remove-Item -Recurse -Force
  [System.IO.Compression.ZipFile]::ExtractToDirectory($attachmentArchive, $attachmentDirectory)
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
Write-Host 'Restore PASS. Chat attachments, PostgreSQL and MinIO are consistent. V1 remains unchanged.'
