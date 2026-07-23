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
$SourceCosmeticsSkill = Join-Path $PSScriptRoot 'skills\thu-ha-cosmetics'
$DestinationRoot = Join-Path $DataRoot 'tha-integrations'
$DestinationIntegrations = Join-Path $DestinationRoot 'integrations'
$SkillRoot = Join-Path $DataRoot 'skills'
$TrainingSkillDestination = Join-Path $SkillRoot 'thu-ha-training'
$CosmeticsSkillDestination = Join-Path $SkillRoot 'thu-ha-cosmetics'
$TrainingRoot = Join-Path $DataRoot 'training\thu-ha-cosmetics'
$SkillLearningRoot = Join-Path $TrainingRoot 'skill-learning'
$LegacyActiveMemoryPath = Join-Path (Join-Path $DataRoot 'memories') 'THA_TRAINING_ACTIVE.md'
$EnvPath = Join-Path $DataRoot '.env'
$Timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
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

function Remove-EnvKey {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Key
    )
    if (-not (Test-Path $Path)) { return }
    $pattern = '^(?:export\s+)?' + [regex]::Escape($Key) + '='
    $lines = [System.IO.File]::ReadAllLines($Path) | Where-Object { $_ -notmatch $pattern }
    [System.IO.File]::WriteAllLines($Path, $lines, $Utf8NoBom)
}

function Assert-ContainerRunning {
    param([string]$Name)
    $running = docker inspect -f '{{.State.Running}}' $Name 2>$null
    if ($LASTEXITCODE -ne 0 -or ($running | Out-String).Trim().ToLowerInvariant() -ne 'true') {
        throw "Container is not running: $Name"
    }
}

function Install-CosmeticsSkillPreservingLearning {
    param(
        [Parameter(Mandatory = $true)][string]$Source,
        [Parameter(Mandatory = $true)][string]$Destination
    )
    if (Test-Path $Destination) {
        $backup = Join-Path (Join-Path $SkillLearningRoot 'versions') "preinstall-$Timestamp"
        New-Item -ItemType Directory -Force -Path (Split-Path $backup -Parent) | Out-Null
        Copy-Item -LiteralPath $Destination -Destination $backup -Recurse -Force
    } else {
        New-Item -ItemType Directory -Force -Path $Destination | Out-Null
    }

    Copy-Item -LiteralPath (Join-Path $Source 'SKILL.md') -Destination (Join-Path $Destination 'SKILL.md') -Force

    $sourceReferences = Join-Path $Source 'references'
    $destinationReferences = Join-Path $Destination 'references'
    New-Item -ItemType Directory -Force -Path $destinationReferences | Out-Null
    foreach ($file in Get-ChildItem -LiteralPath $sourceReferences -File) {
        $target = Join-Path $destinationReferences $file.Name
        $isLearnedReference = $file.Name -in @('sales-flow.md', 'tone-and-dialogue.md')
        if ($isLearnedReference -and (Test-Path $target)) {
            continue
        }
        Copy-Item -LiteralPath $file.FullName -Destination $target -Force
    }
}

foreach ($required in @(
    $SourceIntegrations,
    $SourceTrainingSkill,
    $SourceCosmeticsSkill,
    $EnvPath
)) {
    if (-not (Test-Path $required)) {
        throw "Required file or directory not found: $required"
    }
}
Assert-ContainerRunning -Name $GatewayContainer
Assert-ContainerRunning -Name $MetaContainer

$HermesBin = Resolve-ContainerCommandPath -Container $GatewayContainer -Command 'hermes'
$PythonBin = Resolve-ContainerCommandPath -Container $GatewayContainer -Command 'python'

# Fail closed before replacing runtime and skills.
Set-EnvValue -Path $EnvPath -Key 'THA_REPLY_MODE' -Value 'DRAFT_ONLY'
Set-EnvValue -Path $EnvPath -Key 'THA_META_AUTO_SEND' -Value 'false'
Set-EnvValue -Path $EnvPath -Key 'HERMES_HOME' -Value '/opt/data'
Set-EnvValue -Path $EnvPath -Key 'THA_HERMES_BIN' -Value $HermesBin
Set-EnvValue -Path $EnvPath -Key 'THA_PYTHON_BIN' -Value $PythonBin
Remove-EnvKey -Path $EnvPath -Key 'THA_ACTIVE_TRAINING_MEMORY_PATH'

docker restart $MetaContainer | Out-Null
Start-Sleep -Seconds 3

foreach ($directory in @(
    $DestinationRoot,
    $SkillRoot,
    (Join-Path $SkillLearningRoot 'pending'),
    (Join-Path $SkillLearningRoot 'active'),
    (Join-Path $SkillLearningRoot 'rolled_back'),
    (Join-Path $SkillLearningRoot 'versions')
)) {
    New-Item -ItemType Directory -Force -Path $directory | Out-Null
}

# Preserve any legacy active-memory file for audit, then remove it from runtime.
if (Test-Path $LegacyActiveMemoryPath) {
    $legacyRoot = Join-Path $TrainingRoot 'legacy-memory'
    New-Item -ItemType Directory -Force -Path $legacyRoot | Out-Null
    Move-Item -LiteralPath $LegacyActiveMemoryPath `
        -Destination (Join-Path $legacyRoot "THA_TRAINING_ACTIVE-$Timestamp.md") `
        -Force
}

if (Test-Path $DestinationIntegrations) {
    Remove-Item $DestinationIntegrations -Recurse -Force
}
Copy-Item -LiteralPath $SourceIntegrations -Destination $DestinationRoot -Recurse -Force

if (Test-Path $TrainingSkillDestination) {
    Remove-Item $TrainingSkillDestination -Recurse -Force
}
Copy-Item -LiteralPath $SourceTrainingSkill -Destination $TrainingSkillDestination -Recurse -Force
Install-CosmeticsSkillPreservingLearning `
    -Source $SourceCosmeticsSkill `
    -Destination $CosmeticsSkillDestination

$testModules = @(
    'integrations.hermes.tests.test_conversation_runtime_processor',
    'integrations.hermes.tests.test_fast_grounded_runtime',
    'integrations.hermes.tests.test_telegram_skill_learning',
    'integrations.hermes.tests.test_context_safety_regression',
    'integrations.hermes.tests.test_meta_outbound_sender',
    'integrations.hermes.tests.test_production_hardening_contract'
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
$skillText = $skillCheck.Output | Out-String
$skillCheck.Output | ForEach-Object { Write-Host $_ }
if (
    $skillCheck.ExitCode -ne 0 -or
    $skillText -notmatch 'thu-ha-training' -or
    $skillText -notmatch 'thu-ha-cosmetics'
) {
    throw 'Required Thu Ha skills were not discovered by Hermes.'
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
    throw 'Meta sidecar health check failed after native skill learning installation.'
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

Write-Host 'PASS: Hermes native skill learning and fast grounded runtime installed' -ForegroundColor Green
Write-Host 'TRAINING_SKILL=/thu-ha-training'
Write-Host "TRAINING_SKILL_PATH=$TrainingSkillDestination"
Write-Host "COSMETICS_SKILL_PATH=$CosmeticsSkillDestination"
Write-Host 'LEARNING_MODE=HERMES_SKILL_MANAGE'
Write-Host 'PROCEDURAL_MEMORY=PROGRESSIVE_ON_DEMAND_SKILL'
Write-Host 'TRAINING_HISTORY_IN_PROMPT=FALSE'
Write-Host 'RAW_TRAINING_MEMORY=DISABLED_ARCHIVED'
Write-Host 'SKILL_CHANGE_CONTROL=SNAPSHOT_AUDIT_VERIFY_ROLLBACK'
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
