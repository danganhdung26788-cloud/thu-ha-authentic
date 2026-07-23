#Requires -RunAsAdministrator

param(
    [string]$GatewayContainer = 'hermes-gateway',
    [string]$DataRoot = 'D:\HermesAgent\data',
    [string]$TelegramChatId = '8654262919',
    [string]$TopicName = 'Rà soát đoạn chat fanpage'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$SourceIntegrations = Join-Path $RepoRoot 'integrations'
$SourceSkill = Join-Path $PSScriptRoot 'skills\thu-ha-chat-review'
$DestinationRoot = Join-Path $DataRoot 'tha-integrations'
$DestinationIntegrations = Join-Path $DestinationRoot 'integrations'
$SkillDestination = Join-Path (Join-Path $DataRoot 'skills') 'thu-ha-chat-review'
$ConfigPath = Join-Path $DataRoot 'config.yaml'

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

foreach ($required in @($SourceIntegrations, $SourceSkill, $ConfigPath)) {
    if (-not (Test-Path $required)) { throw "Required path missing: $required" }
}
Assert-Running $GatewayContainer
$HermesBin = Resolve-Command $GatewayContainer 'hermes'
$PythonBin = Resolve-Command $GatewayContainer 'python'

# Read-only installer: do not alter Fanpage reply mode, auto-send, Meta sidecar or outbound behavior.
New-Item -ItemType Directory -Force -Path $DestinationRoot | Out-Null
if (Test-Path $DestinationIntegrations) { Remove-Item $DestinationIntegrations -Recurse -Force }
Copy-Item -LiteralPath $SourceIntegrations -Destination $DestinationRoot -Recurse -Force
New-Item -ItemType Directory -Force -Path (Split-Path $SkillDestination -Parent) | Out-Null
if (Test-Path $SkillDestination) { Remove-Item $SkillDestination -Recurse -Force }
Copy-Item -LiteralPath $SourceSkill -Destination $SkillDestination -Recurse -Force

docker exec `
  -e HERMES_HOME=/opt/data `
  -e PYTHONPATH=/opt/data/tha-integrations:/opt/data/tha-integrations/.vendor `
  $GatewayContainer `
  $PythonBin -m py_compile `
  /opt/data/tha-integrations/integrations/hermes/telegram_fanpage_review.py
if ($LASTEXITCODE -ne 0) { throw 'Fanpage review compile check failed.' }

# Bind the existing Telegram topic to the dedicated review skill.
docker exec `
  -e HERMES_HOME=/opt/data `
  -e PYTHONPATH=/opt/data/tha-integrations:/opt/data/tha-integrations/.vendor `
  $GatewayContainer `
  $PythonBin -m integrations.hermes.telegram_control_config `
  --config /opt/data/config.yaml `
  --chat-id $TelegramChatId `
  --topic-name $TopicName `
  --skill thu-ha-chat-review `
  ensure | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Could not bind Telegram review topic.' }

docker restart $GatewayContainer | Out-Null
Start-Sleep -Seconds 8

$skills = docker exec -e HERMES_HOME=/opt/data $GatewayContainer $HermesBin skills list | Out-String
if ($LASTEXITCODE -ne 0 -or $skills -notmatch 'thu-ha-chat-review') {
    throw 'Hermes did not discover thu-ha-chat-review.'
}

docker exec `
  -e HERMES_HOME=/opt/data `
  -e PYTHONPATH=/opt/data/tha-integrations:/opt/data/tha-integrations/.vendor `
  $GatewayContainer `
  $PythonBin -m unittest -v `
  integrations.hermes.tests.test_telegram_fanpage_review
if ($LASTEXITCODE -ne 0) { throw 'Fanpage review unit tests failed.' }

# Live read-only smoke against today's FANPAGE_QUEUE. No row is changed.
$smoke = docker exec `
  -e HERMES_HOME=/opt/data `
  -e PYTHONPATH=/opt/data/tha-integrations:/opt/data/tha-integrations/.vendor `
  $GatewayContainer `
  $PythonBin -m integrations.hermes.telegram_fanpage_review `
  review --today --limit 1 | Out-String
if ($LASTEXITCODE -ne 0 -or $smoke -notmatch 'ĐOẠN CHAT FANPAGE|Không tìm thấy') {
    throw 'Fanpage review live read-only smoke failed.'
}

Write-Host 'PASS: Fanpage chat review source installed' -ForegroundColor Green
Write-Host "TOPIC=$TopicName"
Write-Host 'SKILL=thu-ha-chat-review'
Write-Host 'SOURCE=FANPAGE_QUEUE'
Write-Host 'PRIMARY_LEARNING_FLOW=thu-ha-uat'
Write-Host 'MODE=READ_ONLY_REVIEW'
Write-Host 'LIVE_FANPAGE_BEHAVIOR=UNCHANGED'
Write-Host 'META_OUTBOUND_CHANGE=NONE'
