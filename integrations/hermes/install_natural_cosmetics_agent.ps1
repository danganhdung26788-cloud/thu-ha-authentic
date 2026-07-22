param(
    [string]$Container = 'hermes-gateway',
    [string]$HermesData = 'D:\HermesAgent\data'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$SourceIntegrations = Join-Path $RepoRoot 'integrations'
$SourceSkill = Join-Path $PSScriptRoot 'skills\thu-ha-cosmetics'
$MemorySectionPath = Join-Path $PSScriptRoot 'templates\thu-ha-memory\MEMORY.section.md'
$UserSectionPath = Join-Path $PSScriptRoot 'templates\thu-ha-memory\USER.section.md'
$DestinationRoot = Join-Path $HermesData 'tha-integrations'
$DestinationIntegrations = Join-Path $DestinationRoot 'integrations'
$SkillRoot = Join-Path $HermesData 'skills'
$SkillDestination = Join-Path $SkillRoot 'thu-ha-cosmetics'
$MemoriesRoot = Join-Path $HermesData 'memories'
$MemoryPath = Join-Path $MemoriesRoot 'MEMORY.md'
$UserPath = Join-Path $MemoriesRoot 'USER.md'
$TrainingRoot = Join-Path $HermesData 'training\thu-ha-cosmetics'
$Timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Write-Utf8NoBom {
    param([string]$Path, [string]$Content)
    $normalized = $Content -replace "`r`n", "`n" -replace "`r", "`n"
    [System.IO.File]::WriteAllText($Path, $normalized, $Utf8NoBom)
}

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

    return [pscustomobject]@{
        Output = $output
        ExitCode = $exitCode
    }
}

function Update-ManagedSection {
    param(
        [string]$TargetPath,
        [string]$SectionPath,
        [string]$StartMarker,
        [string]$EndMarker
    )

    $section = [System.IO.File]::ReadAllText($SectionPath)
    $existing = if (Test-Path $TargetPath) {
        [System.IO.File]::ReadAllText($TargetPath)
    } else {
        ''
    }

    if (Test-Path $TargetPath) {
        Copy-Item $TargetPath "$TargetPath.$Timestamp.bak" -Force
    }

    $pattern = '(?s)' + [regex]::Escape($StartMarker) + '.*?' + [regex]::Escape($EndMarker)
    if ([regex]::IsMatch($existing, $pattern)) {
        $updated = [regex]::Replace($existing, $pattern, $section.Trim())
    } elseif ([string]::IsNullOrWhiteSpace($existing)) {
        $updated = $section.Trim() + "`n"
    } else {
        $updated = $existing.TrimEnd() + "`n`n" + $section.Trim() + "`n"
    }
    Write-Utf8NoBom -Path $TargetPath -Content $updated
}

foreach ($required in @($SourceIntegrations, $SourceSkill, $MemorySectionPath, $UserSectionPath)) {
    if (-not (Test-Path $required)) {
        throw "Required source not found: $required"
    }
}

$running = docker inspect -f '{{.State.Running}}' $Container 2>$null
if ($LASTEXITCODE -ne 0 -or ($running | Out-String).Trim().ToLowerInvariant() -ne 'true') {
    throw "Container is not running: $Container"
}

foreach ($directory in @(
    $DestinationRoot,
    $SkillRoot,
    $MemoriesRoot,
    (Join-Path $HermesData 'cache\thu-ha-cosmetics'),
    (Join-Path $HermesData 'sessions\thu-ha-customers'),
    (Join-Path $TrainingRoot 'pending'),
    (Join-Path $TrainingRoot 'approved'),
    (Join-Path $TrainingRoot 'rejected'),
    (Join-Path $TrainingRoot 'versions')
)) {
    New-Item -ItemType Directory -Force -Path $directory | Out-Null
}

if (Test-Path $DestinationIntegrations) {
    Remove-Item $DestinationIntegrations -Recurse -Force
}
Copy-Item -LiteralPath $SourceIntegrations -Destination $DestinationRoot -Recurse -Force

if (Test-Path $SkillDestination) {
    $SkillBackup = Join-Path (Join-Path $TrainingRoot 'versions') "skill-$Timestamp"
    Copy-Item $SkillDestination $SkillBackup -Recurse -Force
    Remove-Item $SkillDestination -Recurse -Force
}
Copy-Item $SourceSkill $SkillDestination -Recurse -Force

Update-ManagedSection `
    -TargetPath $MemoryPath `
    -SectionPath $MemorySectionPath `
    -StartMarker '<!-- THA_COSMETICS_MEMORY_START -->' `
    -EndMarker '<!-- THA_COSMETICS_MEMORY_END -->'

Update-ManagedSection `
    -TargetPath $UserPath `
    -SectionPath $UserSectionPath `
    -StartMarker '<!-- THA_COSMETICS_USER_START -->' `
    -EndMarker '<!-- THA_COSMETICS_USER_END -->'

$verifyScript = @'
set -eu
if [ -f /opt/data/.env ]; then
  set -a
  . /opt/data/.env
  set +a
fi
export HERMES_HOME="${HERMES_HOME:-/opt/data}"
export THA_HERMES_BIN="${THA_HERMES_BIN:-/opt/hermes/.venv/bin/hermes}"
export GOOGLE_APPLICATION_CREDENTIALS=/opt/data/google/application_default_credentials.json
export PYTHONPATH=/opt/data/tha-integrations:/opt/data/tha-integrations/.vendor
cd /opt/data/tha-integrations
python -m unittest -v integrations.hermes.tests.test_conversation_runtime_processor
python -m unittest -v integrations.hermes.tests.test_ai_first_reply_processor
python -m unittest -v integrations.hermes.tests.test_natural_reply_processor
python -m unittest -v integrations.hermes.tests.test_context_safety_regression
python -m unittest -v integrations.hermes.tests.test_cosmetics_training_store
python -m unittest -v integrations.hermes.tests.test_meta_outbound_sender
test -x "$THA_HERMES_BIN"
"$THA_HERMES_BIN" skills list | grep -i 'thu-ha-cosmetics'
THA_AI_FIRST_DRY_RUN=true python -m integrations.hermes.conversation_runtime_processor
python -m integrations.hermes.meta_outbound_sender
'@ -replace "`r`n", "`n"

$result = Invoke-NativeCapture -FilePath 'docker' -Arguments @(
    'exec', $Container, '/bin/sh', '-c', $verifyScript
)
$result.Output | ForEach-Object { Write-Host $_ }
if ($result.ExitCode -ne 0) {
    throw "Natural cosmetics agent verification failed with exit code $($result.ExitCode)"
}

Write-Host 'PASS: Thu Ha cosmetics native skill installed'
Write-Host "SKILL_PATH=$SkillDestination"
Write-Host "MEMORY_PATH=$MemoryPath"
Write-Host "USER_PATH=$UserPath"
Write-Host "TRAINING_PATH=$TrainingRoot"
Write-Host 'PROCESSOR=HERMES_CONVERSATION_RUNTIME'
Write-Host 'REASONING_MODE=NATURAL_CONVERSATION'
Write-Host 'FACTUAL_LOOKUP=ON_DEMAND_WITH_PRICE'
Write-Host 'HERMES_HOME=/opt/data'
Write-Host 'HERMES_BIN=/opt/hermes/.venv/bin/hermes'
Write-Host 'GENERIC_FALLBACK_LOOP=DISABLED'
Write-Host 'AUTO_SEND=UNCHANGED'
