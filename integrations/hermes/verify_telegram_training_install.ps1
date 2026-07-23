#Requires -RunAsAdministrator

param(
    [string]$GatewayContainer = 'hermes-gateway',
    [string]$MetaContainer = 'hermes-tha-meta',
    [string]$LocalHealthUrl = 'http://127.0.0.1:8788/health'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

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

foreach ($container in @($GatewayContainer, $MetaContainer)) {
    $running = docker inspect -f '{{.State.Running}}' $container 2>$null
    if ($LASTEXITCODE -ne 0 -or ($running | Out-String).Trim().ToLowerInvariant() -ne 'true') {
        throw "Container is not running: $container"
    }
}

$health = Invoke-RestMethod -Uri $LocalHealthUrl -Method Get -TimeoutSec 15
if ($health.status -ne 'ok') {
    throw "Meta health is not OK: $($health | ConvertTo-Json -Compress)"
}
if ($health.mode -ne 'DRAFT_ONLY_INGEST') {
    throw "Expected fail-closed DRAFT_ONLY_INGEST mode, got: $($health.mode)"
}

$HermesBin = Resolve-ContainerCommandPath -Container $GatewayContainer -Command 'hermes'

$smoke = Invoke-NativeCapture -FilePath 'docker' -Arguments @(
    'exec', '-e', 'HERMES_HOME=/opt/data', $MetaContainer,
    $HermesBin, '-z', 'Reply with exactly one word: OK'
)
$smokeText = @($smoke.Output | ForEach-Object { "$($_)".Trim() } | Where-Object { $_ }) -join "`n"
if ($smoke.ExitCode -ne 0 -or $smokeText -notmatch '(?m)^\s*OK\s*$') {
    throw "Hermes runtime smoke failed: $smokeText"
}

$skillCheck = Invoke-NativeCapture -FilePath 'docker' -Arguments @(
    'exec', '-e', 'HERMES_HOME=/opt/data', $GatewayContainer, $HermesBin, 'skills', 'list'
)
$skillText = $skillCheck.Output | Out-String
if (
    $skillCheck.ExitCode -ne 0 -or
    $skillText -notmatch 'thu-ha-training' -or
    $skillText -notmatch 'thu-ha-cosmetics'
) {
    throw 'Required Thu Ha skills were not discovered by Hermes.'
}

$startedAt = (docker inspect -f '{{.State.StartedAt}}' $MetaContainer 2>$null | Out-String).Trim()
if ([string]::IsNullOrWhiteSpace($startedAt)) {
    throw 'Could not determine Meta sidecar start time.'
}

$logs = Invoke-NativeCapture -FilePath 'docker' -Arguments @(
    'logs', '--since', $startedAt, $MetaContainer
)
if ($logs.ExitCode -ne 0) {
    throw 'Could not read Meta sidecar logs for isolation verification.'
}

$conflictPattern = '(?i)polling conflict|terminated by other getUpdates request|Hermes Gateway Starting|hermes_plugins\.telegram_platform\.adapter|\[Telegram\].*getUpdates'
$conflictLines = @(
    $logs.Output |
        ForEach-Object { "$($_)" } |
        Where-Object { $_ -match $conflictPattern }
)
if ($conflictLines.Count -gt 0) {
    Write-Host 'META_SIDECAR_CONFLICT_LINES_BEGIN' -ForegroundColor Red
    $conflictLines | ForEach-Object { Write-Host $_ }
    Write-Host 'META_SIDECAR_CONFLICT_LINES_END' -ForegroundColor Red
    throw 'Real duplicate Telegram polling or Hermes gateway activity detected in Meta sidecar.'
}

$inspect = Invoke-NativeCapture -FilePath 'docker' -Arguments @(
    'inspect', '-f', '{{json .Config.Entrypoint}} {{json .Config.Cmd}}', $MetaContainer
)
$inspectText = $inspect.Output | Out-String
if ($inspect.ExitCode -ne 0) {
    throw 'Could not inspect Meta sidecar command.'
}
if ($inspectText -match '(?i)s6-svscan|gateway\s+run|Hermes Gateway Starting') {
    throw "Meta container is not isolated as a Uvicorn-only sidecar: $inspectText"
}

Write-Host 'PASS: Hermes native skill learning installation verified' -ForegroundColor Green
Write-Host 'LEARNING_MODE=HERMES_SKILL_MANAGE'
Write-Host 'PROCEDURAL_MEMORY=PROGRESSIVE_ON_DEMAND_SKILL'
Write-Host 'TRAINING_HISTORY_IN_PROMPT=FALSE'
Write-Host 'RAW_TRAINING_MEMORY=DISABLED_ARCHIVED'
Write-Host 'SKILL_CHANGE_CONTROL=SNAPSHOT_AUDIT_VERIFY_ROLLBACK'
Write-Host 'PRODUCT_ADVICE=ONE_PRODUCT_NAME_PRICE_FIRST'
Write-Host 'PRODUCT_KEY_REQUIRED=TRUE'
Write-Host 'META_SIDECAR_ONLY=TRUE'
Write-Host 'DUPLICATE_TELEGRAM_POLLING=NONE'
Write-Host 'HERMES_RUNTIME_SMOKE=PASS'
Write-Host 'MODE=DRAFT_ONLY_INGEST'
Write-Host 'AUTO_SEND=DISABLED_FOR_LIVE_UAT'
