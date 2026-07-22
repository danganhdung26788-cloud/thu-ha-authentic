#Requires -RunAsAdministrator

param(
    [string]$GatewayContainer = 'hermes-gateway',
    [string]$MetaContainer = 'hermes-tha-meta',
    [string]$DataRoot = 'D:\HermesAgent\data',
    [string]$LocalHealthUrl = 'http://127.0.0.1:8788/health'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$SourceIntegrations = Join-Path $RepoRoot 'integrations'
$SourceTrainingSkill = Join-Path $PSScriptRoot 'skills\thu-ha-training'
$DestinationRoot = Join-Path $DataRoot 'tha-integrations'
$DestinationIntegrations = Join-Path $DestinationRoot 'integrations'
$SkillRoot = Join-Path $DataRoot 'skills'
$SkillDestination = Join-Path $SkillRoot 'thu-ha-training'
$MemoryRoot = Join-Path $DataRoot 'memories'
$ActiveMemoryPath = Join-Path $MemoryRoot 'THA_TRAINING_ACTIVE.md'
$TrainingRoot = Join-Path $DataRoot 'training\thu-ha-cosmetics'
$EnvPath = Join-Path $DataRoot '.env'
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

function Assert-ContainerRunning {
    param([string]$Name)
    $running = docker inspect -f '{{.State.Running}}' $Name 2>$null
    if ($LASTEXITCODE -ne 0 -or ($running | Out-String).Trim().ToLowerInvariant() -ne 'true') {
        throw "Container is not running: $Name"
    }
}

foreach ($required in @($SourceIntegrations, $SourceTrainingSkill, $EnvPath)) {
    if (-not (Test-Path $required)) {
        throw "Required file or directory not found: $required"
    }
}
Assert-ContainerRunning -Name $GatewayContainer
Assert-ContainerRunning -Name $MetaContainer

$HermesBin = Resolve-ContainerCommandPath -Container $GatewayContainer -Command 'hermes'
$PythonBin = Resolve-ContainerCommandPath -Container $GatewayContainer -Command 'python'

# Fail closed before replacing runtime files.
Set-EnvValue -Path $EnvPath -Key 'THA_REPLY_MODE' -Value 'DRAFT_ONLY'
Set-EnvValue -Path $EnvPath -Key 'THA_META_AUTO_SEND' -Value 'false'
Set-EnvValue -Path $EnvPath -Key 'THA_ACTIVE_TRAINING_MEMORY_PATH' -Value '/opt/data/memories/THA_TRAINING_ACTIVE.md'
Set-EnvValue -Path $EnvPath -Key 'HERMES_HOME' -Value '/opt/data'
Set-EnvValue -Path $EnvPath -Key 'THA_HERMES_BIN' -Value $HermesBin
Set-EnvValue -Path $EnvPath -Key 'THA_PYTHON_BIN' -Value $PythonBin

docker restart $MetaContainer | Out-Null
Start-Sleep -Seconds 3

foreach ($directory in @(
    $DestinationRoot,
    $SkillRoot,
    $MemoryRoot,
    (Join-Path $TrainingRoot 'active'),
    (Join-Path $TrainingRoot 'rolled_back'),
    (Join-Path $TrainingRoot 'versions')
)) {
    New-Item -ItemType Directory -Force -Path $directory | Out-Null
}

if (Test-Path $DestinationIntegrations) {
    Remove-Item $DestinationIntegrations -Recurse -Force
}
Copy-Item -LiteralPath $SourceIntegrations -Destination $DestinationRoot -Recurse -Force

if (Test-Path $SkillDestination) {
    Remove-Item $SkillDestination -Recurse -Force
}
Copy-Item -LiteralPath $SourceTrainingSkill -Destination $SkillDestination -Recurse -Force

if (-not (Test-Path $ActiveMemoryPath)) {
    [System.IO.File]::WriteAllText(
        $ActiveMemoryPath,
        "# Thu Hà Authentic — Telegram training đang có hiệu lực`n`nChưa có bài training đang hoạt động.`n",
        $Utf8NoBom
    )
}

$testModules = @(
    'integrations.hermes.tests.test_conversation_runtime_processor',
    'integrations.hermes.tests.test_fast_grounded_runtime',
    'integrations.hermes.tests.test_telegram_training_memory',
    'integrations.hermes.tests.test_context_safety_regression',
    'integrations.hermes.tests.test_meta_outbound_sender'
)
foreach ($module in $testModules) {
    $test = Invoke-NativeCapture -FilePath 'docker' -Arguments @(
        'exec',
        '-e', 'HERMES_HOME=/opt/data',
        '-e', 'PYTHONPATH=/opt/data/tha-integrations:/opt/data/tha-integrations/.vendor',
        $GatewayContainer,
        $PythonBin,
        '-m', 'unittest', '-v', $module
    )
    $test.Output | ForEach-Object { Write-Host $_ }
    if ($test.ExitCode -ne 0) {
        throw "Training/runtime test failed: $module"
    }
}

$skillCheck = Invoke-NativeCapture -FilePath 'docker' -Arguments @(
    'exec', '-e', 'HERMES_HOME=/opt/data', $GatewayContainer, $HermesBin, 'skills', 'list'
)
$skillCheck.Output | ForEach-Object { Write-Host $_ }
if ($skillCheck.ExitCode -ne 0 -or (($skillCheck.Output | Out-String) -notmatch 'thu-ha-training')) {
    throw 'Telegram training skill was not discovered by Hermes.'
}

# Restart only the existing gateway and Meta sidecar. No second Telegram poller is created.
docker restart $GatewayContainer | Out-Null
Start-Sleep -Seconds 8
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
    throw 'Meta sidecar health check failed after Telegram training installation.'
}
if ($health.mode -ne 'DRAFT_ONLY_INGEST') {
    throw "Expected fail-closed DRAFT_ONLY_INGEST mode, got: $($health.mode)"
}

$smoke = Invoke-NativeCapture -FilePath 'docker' -Arguments @(
    'exec', '-e', 'HERMES_HOME=/opt/data', $MetaContainer,
    $HermesBin, '-z', 'Reply with exactly one word: OK'
)
$smokeText = @($smoke.Output | ForEach-Object { "$($_)".Trim() } | Where-Object { $_ }) -join "`n"
if ($smoke.ExitCode -ne 0 -or $smokeText -notmatch '(?m)^\s*OK\s*$') {
    throw "Hermes runtime smoke failed: $smokeText"
}

$conflicts = Invoke-NativeCapture -FilePath 'docker' -Arguments @(
    'logs', '--since', '3m', $MetaContainer
)
$conflictText = $conflicts.Output | Out-String
if ($conflictText -match 'Telegram|polling conflict|Hermes Gateway Starting') {
    throw 'Duplicate Telegram or Hermes gateway activity detected in Meta sidecar.'
}

Write-Host 'PASS: Telegram live training and fast grounded sales runtime installed' -ForegroundColor Green
Write-Host 'TRAINING_SKILL=/thu-ha-training'
Write-Host "TRAINING_SKILL_PATH=$SkillDestination"
Write-Host "ACTIVE_MEMORY_PATH=$ActiveMemoryPath"
Write-Host 'TRAINING_MEMORY=VERSIONED_ACTIVE_WITH_ROLLBACK'
Write-Host 'APPROVED_TRAINERS=NONG_THU_HA,DANG_ANH_DUNG'
Write-Host 'PRODUCT_ADVICE=ONE_PRODUCT_NAME_PRICE_FIRST'
Write-Host 'FOLLOWUP_ADVICE=ON_CUSTOMER_REQUEST'
Write-Host 'PRODUCT_KEY_REQUIRED=TRUE'
Write-Host 'META_SIDECAR_ONLY=TRUE'
Write-Host 'DUPLICATE_TELEGRAM_POLLING=NONE'
Write-Host 'HERMES_RUNTIME_SMOKE=PASS'
Write-Host 'MODE=DRAFT_ONLY_INGEST'
Write-Host 'AUTO_SEND=DISABLED_FOR_LIVE_UAT'
Write-Host 'TELEGRAM_SETUP_STEP_1=/topic'
Write-Host 'TELEGRAM_SETUP_STEP_2=Create topic TRAINING THU HA'
Write-Host 'TELEGRAM_SETUP_STEP_3=/thu-ha-training'
