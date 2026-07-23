#Requires -RunAsAdministrator

param(
    [string]$GatewayContainer = 'hermes-gateway',
    [string]$MetaContainer = 'hermes-tha-meta',
    [string]$DataRoot = 'D:\HermesAgent\data',
    [int]$HostPort = 8788
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$SourceIntegrations = Join-Path $RepoRoot 'integrations'
$SourceSkill = Join-Path $PSScriptRoot 'skills\thu-ha-fanpage'
$DestinationRoot = Join-Path $DataRoot 'tha-integrations'
$DestinationIntegrations = Join-Path $DestinationRoot 'integrations'
$SkillDestination = Join-Path (Join-Path $DataRoot 'skills') 'thu-ha-fanpage'
$EnvPath = Join-Path $DataRoot '.env'
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Set-EnvValue {
    param([string]$Path, [string]$Key, [string]$Value)
    $lines = if (Test-Path $Path) { [System.IO.File]::ReadAllLines($Path) } else { @() }
    $updated = $false
    for ($i = 0; $i -lt $lines.Count; $i++) {
        if ($lines[$i] -match ('^(?:export\s+)?' + [regex]::Escape($Key) + '=')) {
            $lines[$i] = "$Key=$Value"
            $updated = $true
        }
    }
    if (-not $updated) { $lines += "$Key=$Value" }
    [System.IO.File]::WriteAllLines($Path, $lines, $Utf8NoBom)
}

function Assert-Running {
    param([string]$Container)
    $running = docker inspect -f '{{.State.Running}}' $Container 2>$null
    if ($LASTEXITCODE -ne 0 -or ($running | Out-String).Trim().ToLowerInvariant() -ne 'true') {
        throw "Container is not running: $Container"
    }
}

function Resolve-Command {
    param([string]$Container, [string]$Command)
    $result = docker exec $Container /bin/sh -c "command -v $Command"
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace(($result | Out-String).Trim())) {
        throw "Cannot resolve $Command in $Container"
    }
    return ($result | Out-String).Trim()
}

foreach ($required in @($SourceIntegrations, $SourceSkill, $EnvPath)) {
    if (-not (Test-Path $required)) { throw "Required path missing: $required" }
}
Assert-Running $GatewayContainer
Assert-Running $MetaContainer

$HermesBin = Resolve-Command $GatewayContainer 'hermes'
$PythonBin = Resolve-Command $GatewayContainer 'python'

# Fail closed while installing the operator control plane.
Set-EnvValue $EnvPath 'THA_REPLY_MODE' 'DRAFT_ONLY'
Set-EnvValue $EnvPath 'THA_META_AUTO_SEND' 'false'
Set-EnvValue $EnvPath 'THA_HERMES_BIN' $HermesBin
Set-EnvValue $EnvPath 'THA_PYTHON_BIN' $PythonBin
Set-EnvValue $EnvPath 'THA_APPROVED_TRAINERS' 'DANG_ANH_DUNG,NONG_THU_HA'
Set-EnvValue $EnvPath 'THA_FANPAGE_OPS_DB' '/opt/data/tha-fanpage-ops/control.db'

New-Item -ItemType Directory -Force -Path $DestinationRoot | Out-Null
if (Test-Path $DestinationIntegrations) { Remove-Item $DestinationIntegrations -Recurse -Force }
Copy-Item -LiteralPath $SourceIntegrations -Destination $DestinationRoot -Recurse -Force
New-Item -ItemType Directory -Force -Path (Split-Path $SkillDestination -Parent) | Out-Null
if (Test-Path $SkillDestination) { Remove-Item $SkillDestination -Recurse -Force }
Copy-Item -LiteralPath $SourceSkill -Destination $SkillDestination -Recurse -Force

# Compile the new runtime before replacing the sidecar.
docker exec `
  -e HERMES_HOME=/opt/data `
  -e PYTHONPATH=/opt/data/tha-integrations:/opt/data/tha-integrations/.vendor `
  $GatewayContainer `
  $PythonBin -m py_compile `
  /opt/data/tha-integrations/integrations/hermes/telegram_fanpage_ops.py `
  /opt/data/tha-integrations/integrations/hermes/meta_messenger_bridge_ops.py
if ($LASTEXITCODE -ne 0) { throw 'Fanpage operations compile check failed.' }

# Restart the single Telegram gateway so the slash skill is discovered.
docker restart $GatewayContainer | Out-Null
Start-Sleep -Seconds 8

$skillText = docker exec -e HERMES_HOME=/opt/data $GatewayContainer $HermesBin skills list | Out-String
if ($LASTEXITCODE -ne 0 -or $skillText -notmatch 'thu-ha-fanpage') {
    throw 'Hermes did not discover thu-ha-fanpage skill.'
}

# Replace only the Uvicorn sidecar; do not start a second Hermes gateway or Telegram poller.
docker rm -f $MetaContainer | Out-Null
$volumeArg = "${DataRoot}:/opt/data"
$portArg = "127.0.0.1:${HostPort}:8788"
$containerCommand = @'
set -eu
export HERMES_HOME=/opt/data
export HOME=/opt/data/home
export GOOGLE_APPLICATION_CREDENTIALS=/opt/data/google/application_default_credentials.json
export PYTHONPATH=/opt/data/tha-integrations:/opt/data/tha-integrations/.vendor
exec "$THA_PYTHON_BIN" -m uvicorn integrations.hermes.meta_messenger_bridge_ops:app --host 0.0.0.0 --port 8788
'@ -replace "`r`n", "`n"

docker run -d `
    --name $MetaContainer `
    --restart unless-stopped `
    --user '10000:10000' `
    --entrypoint /bin/sh `
    -p $portArg `
    --env-file $EnvPath `
    -e 'HERMES_HOME=/opt/data' `
    -e 'HOME=/opt/data/home' `
    -e "THA_HERMES_BIN=$HermesBin" `
    -e "THA_PYTHON_BIN=$PythonBin" `
    -v $volumeArg `
    nousresearch/hermes-agent:latest `
    -c $containerCommand | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Could not recreate pause-aware Meta sidecar.' }

$health = $null
for ($attempt = 1; $attempt -le 30; $attempt++) {
    Start-Sleep -Seconds 2
    try {
        $health = Invoke-RestMethod -Uri "http://127.0.0.1:${HostPort}/health" -TimeoutSec 5
        if ($health.status -eq 'ok') { break }
    }
    catch { $health = $null }
}
if (-not $health -or $health.status -ne 'ok' -or $health.mode -ne 'DRAFT_ONLY_INGEST') {
    docker logs --tail 100 $MetaContainer
    throw 'Pause-aware Meta sidecar health verification failed.'
}

# Read-only smoke: inbox command must execute without sending or changing status.
docker exec `
  -e HERMES_HOME=/opt/data `
  -e PYTHONPATH=/opt/data/tha-integrations:/opt/data/tha-integrations/.vendor `
  $GatewayContainer `
  $PythonBin -m integrations.hermes.telegram_fanpage_ops inbox `
  --trainer DANG_ANH_DUNG --limit 1 | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Telegram Fanpage inbox smoke failed.' }

$startedAt = (docker inspect -f '{{.State.StartedAt}}' $MetaContainer | Out-String).Trim()
$logs = docker logs --since $startedAt $MetaContainer 2>&1 | Out-String
if ($logs -match '(?i)terminated by other getUpdates request|Hermes Gateway Starting|\[Telegram\].*getUpdates') {
    throw 'Duplicate Telegram polling or Hermes gateway activity detected in Meta sidecar.'
}

Write-Host 'PASS: Telegram Fanpage operations control plane installed' -ForegroundColor Green
Write-Host 'FANPAGE_TOPIC=DIEU_HANH_FANPAGE_THU_HA'
Write-Host 'FANPAGE_SKILL=/thu-ha-fanpage'
Write-Host 'COMMANDS=/thu-ha-inbox,/thu-ha-open,/thu-ha-rewrite,/thu-ha-approve,/thu-ha-handoff,/thu-ha-pause,/thu-ha-resume,/thu-ha-audit'
Write-Host 'WRITE_CONTROL=EXPLICIT_APPROVAL_ONLY'
Write-Host 'AUDIT_DB=/opt/data/tha-fanpage-ops/control.db'
Write-Host 'PAUSE_SCOPE=PER_CUSTOMER'
Write-Host 'META_SIDECAR_ONLY=TRUE'
Write-Host 'DUPLICATE_TELEGRAM_POLLING=NONE'
Write-Host 'MODE=DRAFT_ONLY_INGEST'
Write-Host 'AUTO_SEND=DISABLED_FOR_OPERATOR_UAT'
