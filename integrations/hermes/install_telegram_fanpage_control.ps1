#Requires -RunAsAdministrator

param(
    [string]$GatewayContainer = 'hermes-gateway',
    [string]$MetaContainer = 'hermes-tha-meta',
    [string]$DataRoot = 'D:\HermesAgent\data',
    [string]$TelegramChatId = '865426291',
    [string]$TopicName = 'Điều hành Fanpage Thu Hà',
    [string]$LocalHealthUrl = 'http://127.0.0.1:8788/health'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$SourceIntegrations = Join-Path $RepoRoot 'integrations'
$SourceSkill = Join-Path $PSScriptRoot 'skills\thu-ha-inbox'
$DestinationRoot = Join-Path $DataRoot 'tha-integrations'
$DestinationIntegrations = Join-Path $DestinationRoot 'integrations'
$SkillDestination = Join-Path (Join-Path $DataRoot 'skills') 'thu-ha-inbox'
$EnvPath = Join-Path $DataRoot '.env'
$ConfigPath = Join-Path $DataRoot 'config.yaml'
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Invoke-NativeCapture {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [Parameter(Mandatory = $true)][string[]]$Arguments
    )
    $previousPreference = $ErrorActionPreference
    $output = @()
    $exitCode = 1
    try {
        $ErrorActionPreference = 'Continue'
        $output = @(& $FilePath @Arguments 2>&1)
        $exitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $previousPreference
    }
    return [pscustomobject]@{ Output = $output; ExitCode = $exitCode }
}

function Resolve-ContainerCommandPath {
    param(
        [Parameter(Mandatory = $true)][string]$Container,
        [Parameter(Mandatory = $true)][string]$Command
    )
    $result = Invoke-NativeCapture -FilePath 'docker' -Arguments @(
        'exec', $Container, '/bin/sh', '-c', "command -v $Command"
    )
    $path = @($result.Output | ForEach-Object { "$($_)".Trim() } | Where-Object { $_ }) |
        Select-Object -First 1
    if ($result.ExitCode -ne 0 -or [string]::IsNullOrWhiteSpace($path)) {
        throw "Could not resolve '$Command' inside '$Container'."
    }
    return $path
}

function Set-EnvValue {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Key,
        [Parameter(Mandatory = $true)][string]$Value
    )
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

foreach ($required in @($SourceIntegrations, $SourceSkill, $EnvPath, $ConfigPath)) {
    if (-not (Test-Path $required)) {
        throw "Required file or directory not found: $required"
    }
}
Assert-Running -Container $GatewayContainer
Assert-Running -Container $MetaContainer

$HermesBin = Resolve-ContainerCommandPath -Container $GatewayContainer -Command 'hermes'
$PythonBin = Resolve-ContainerCommandPath -Container $GatewayContainer -Command 'python'

# Fail closed: all Fanpage replies require Telegram approval after this installation.
Set-EnvValue -Path $EnvPath -Key 'THA_REPLY_MODE' -Value 'DRAFT_ONLY'
Set-EnvValue -Path $EnvPath -Key 'THA_META_AUTO_SEND' -Value 'false'
Set-EnvValue -Path $EnvPath -Key 'THA_TELEGRAM_CONTROL_MODE' -Value 'APPROVAL_REQUIRED'
Set-EnvValue -Path $EnvPath -Key 'THA_CONTROL_OPERATOR' -Value 'DANG_ANH_DUNG'
Set-EnvValue -Path $EnvPath -Key 'HERMES_HOME' -Value '/opt/data'
Set-EnvValue -Path $EnvPath -Key 'THA_HERMES_BIN' -Value $HermesBin
Set-EnvValue -Path $EnvPath -Key 'THA_PYTHON_BIN' -Value $PythonBin

New-Item -ItemType Directory -Force -Path $DestinationRoot | Out-Null
New-Item -ItemType Directory -Force -Path (Split-Path $SkillDestination -Parent) | Out-Null
if (Test-Path $DestinationIntegrations) {
    Remove-Item $DestinationIntegrations -Recurse -Force
}
Copy-Item -LiteralPath $SourceIntegrations -Destination $DestinationRoot -Recurse -Force
if (Test-Path $SkillDestination) {
    Remove-Item $SkillDestination -Recurse -Force
}
Copy-Item -LiteralPath $SourceSkill -Destination $SkillDestination -Recurse -Force

$configBackup = "$ConfigPath.fanpage-control-backup-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
Copy-Item -LiteralPath $ConfigPath -Destination $configBackup -Force

$pythonEnv = @(
    'exec',
    '-e', 'HERMES_HOME=/opt/data',
    '-e', 'PYTHONPATH=/opt/data/tha-integrations:/opt/data/tha-integrations/.vendor',
    $GatewayContainer,
    $PythonBin
)

$yamlCheck = Invoke-NativeCapture -FilePath 'docker' -Arguments ($pythonEnv + @('-c', 'import yaml; print("YAML_OK")'))
if ($yamlCheck.ExitCode -ne 0 -or ($yamlCheck.Output | Out-String) -notmatch 'YAML_OK') {
    Copy-Item -LiteralPath $configBackup -Destination $ConfigPath -Force
    throw 'PyYAML is unavailable in Hermes gateway; config was restored.'
}

$ensure = Invoke-NativeCapture -FilePath 'docker' -Arguments ($pythonEnv + @(
    '-m', 'integrations.hermes.telegram_control_config',
    '--chat-id', $TelegramChatId,
    '--topic-name', $TopicName,
    '--skill', 'thu-ha-inbox',
    'ensure'
))
$ensure.Output | ForEach-Object { Write-Host $_ }
if ($ensure.ExitCode -ne 0) {
    Copy-Item -LiteralPath $configBackup -Destination $ConfigPath -Force
    throw 'Could not add the Telegram Fanpage control topic to config.yaml.'
}

# Restart the one existing Telegram gateway. Hermes creates the configured DM topic
# and writes its thread_id back to config.yaml.
docker restart $GatewayContainer | Out-Null
$target = ''
for ($attempt = 1; $attempt -le 40; $attempt++) {
    Start-Sleep -Seconds 2
    $targetResult = Invoke-NativeCapture -FilePath 'docker' -Arguments ($pythonEnv + @(
        '-m', 'integrations.hermes.telegram_control_config',
        '--chat-id', $TelegramChatId,
        '--topic-name', $TopicName,
        'target'
    ))
    if ($targetResult.ExitCode -eq 0) {
        $candidate = ($targetResult.Output | Out-String).Trim()
        if ($candidate -match '^telegram:[^:]+:\d+$') {
            $target = $candidate
            break
        }
    }
}
if ([string]::IsNullOrWhiteSpace($target)) {
    Copy-Item -LiteralPath $configBackup -Destination $ConfigPath -Force
    docker restart $GatewayContainer | Out-Null
    throw 'Hermes did not create or persist the Telegram control topic thread_id.'
}

Set-EnvValue -Path $EnvPath -Key 'THA_TELEGRAM_CONTROL_TARGET' -Value $target

$testModules = @(
    'integrations.hermes.tests.test_telegram_fanpage_control',
    'integrations.hermes.tests.test_telegram_uat',
    'integrations.hermes.tests.test_fast_grounded_runtime',
    'integrations.hermes.tests.test_conversation_runtime_processor'
)
foreach ($module in $testModules) {
    $test = Invoke-NativeCapture -FilePath 'docker' -Arguments @(
        'exec',
        '-e', 'HERMES_HOME=/opt/data',
        '-e', 'THA_PRODUCT_SOURCE_MODE=FAST_INDEX',
        '-e', 'PYTHONPATH=/opt/data/tha-integrations:/opt/data/tha-integrations/.vendor',
        $GatewayContainer,
        $PythonBin,
        '-m', 'unittest', '-v', $module
    )
    $test.Output | ForEach-Object { Write-Host $_ }
    if ($test.ExitCode -ne 0) {
        throw "Telegram Fanpage control/runtime test failed: $module"
    }
}

$skillCheck = Invoke-NativeCapture -FilePath 'docker' -Arguments @(
    'exec', '-e', 'HERMES_HOME=/opt/data', $GatewayContainer, $HermesBin, 'skills', 'list'
)
$skillText = $skillCheck.Output | Out-String
if ($skillCheck.ExitCode -ne 0 -or $skillText -notmatch 'thu-ha-inbox') {
    throw 'The thu-ha-inbox skill was not discovered.'
}

# Restart only the Uvicorn Meta sidecar so it loads approval mode and Telegram target.
docker restart $MetaContainer | Out-Null
$health = $null
for ($attempt = 1; $attempt -le 30; $attempt++) {
    Start-Sleep -Seconds 2
    try {
        $health = Invoke-RestMethod -Uri $LocalHealthUrl -Method Get -TimeoutSec 5
        if ($health.status -eq 'ok') { break }
    }
    catch {
        $health = $null
    }
}
if (-not $health -or $health.status -ne 'ok') {
    docker logs --tail 100 $MetaContainer
    throw 'Meta sidecar health check failed after Telegram Fanpage control installation.'
}
if ($health.mode -ne 'TELEGRAM_APPROVAL_REQUIRED') {
    throw "Expected TELEGRAM_APPROVAL_REQUIRED, got: $($health.mode)"
}
if ($health.telegram_control -ne 'enabled') {
    throw 'Meta sidecar did not load the Telegram control target.'
}

# Confirm queue access without modifying any customer row.
$queueCheck = Invoke-NativeCapture -FilePath 'docker' -Arguments @(
    'exec',
    '-e', 'HERMES_HOME=/opt/data',
    '-e', 'PYTHONPATH=/opt/data/tha-integrations:/opt/data/tha-integrations/.vendor',
    $GatewayContainer,
    $PythonBin,
    '-m', 'integrations.hermes.telegram_fanpage_control',
    '--format', 'json',
    'list', '--limit', '1'
)
if ($queueCheck.ExitCode -ne 0) {
    throw "FANPAGE_QUEUE control smoke failed: $($queueCheck.Output | Out-String)"
}

# Send one internal connection notice to the new topic. No customer is contacted.
$noticeHostPath = Join-Path $DataRoot 'tha-fanpage-control-ready.txt'
$noticeContainerPath = '/opt/data/tha-fanpage-control-ready.txt'
[System.IO.File]::WriteAllText(
    $noticeHostPath,
    "✅ Điều hành Fanpage Thu Hà đã kết nối.`n`nTin khách mới sẽ hiện tại đây. Hermes chỉ gửi khách khi sếp ra lệnh Gửi.`nLệnh nhanh: Xem tin mới | Viết ngắn hơn | Dùng câu này: ... | Gửi | Chuyển Thu Hà",
    $Utf8NoBom
)
try {
    $notice = Invoke-NativeCapture -FilePath 'docker' -Arguments @(
        'exec', '-e', 'HERMES_HOME=/opt/data', $GatewayContainer,
        $HermesBin, 'send', '--to', $target, '--file', $noticeContainerPath
    )
    $notice.Output | ForEach-Object { Write-Host $_ }
    if ($notice.ExitCode -ne 0) {
        throw 'Could not deliver the control-topic connection notice.'
    }
}
finally {
    Remove-Item -LiteralPath $noticeHostPath -Force -ErrorAction SilentlyContinue
}

$startedAt = (docker inspect -f '{{.State.StartedAt}}' $MetaContainer | Out-String).Trim()
$logs = Invoke-NativeCapture -FilePath 'docker' -Arguments @(
    'logs', '--since', $startedAt, $MetaContainer
)
$conflictPattern = '(?i)polling conflict|terminated by other getUpdates request|Hermes Gateway Starting|hermes_plugins\.telegram_platform\.adapter|\[Telegram\].*getUpdates'
$conflictLines = @($logs.Output | ForEach-Object { "$($_)" } | Where-Object { $_ -match $conflictPattern })
if ($conflictLines.Count -gt 0) {
    $conflictLines | ForEach-Object { Write-Host $_ }
    throw 'Duplicate Telegram polling or Hermes gateway activity detected in Meta sidecar.'
}

Write-Host 'PASS: Telegram Fanpage control plane installed' -ForegroundColor Green
Write-Host 'CONTROL_SKILL=/thu-ha-inbox'
Write-Host "CONTROL_TOPIC=$TopicName"
Write-Host "CONTROL_TARGET=$target"
Write-Host 'CONTROL_MODE=APPROVAL_REQUIRED'
Write-Host 'INBOUND_NOTIFICATION=AUTOMATIC'
Write-Host 'ONE_OFF_STYLE_REWRITE=ENABLED'
Write-Host 'PERMANENT_SKILL_UPDATE=EXPLICIT_ONLY'
Write-Host 'MANUAL_META_SEND=ENABLED_WITH_AUDIT'
Write-Host 'DUPLICATE_SEND_GUARD=ENABLED'
Write-Host 'DUPLICATE_TELEGRAM_POLLING=NONE'
Write-Host 'THA_REPLY_MODE=DRAFT_ONLY'
Write-Host 'THA_META_AUTO_SEND=false'
Write-Host 'HEALTH_MODE=TELEGRAM_APPROVAL_REQUIRED'
