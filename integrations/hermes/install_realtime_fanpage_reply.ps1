#Requires -RunAsAdministrator

param(
    [string]$MetaContainerName = 'hermes-tha-meta',
    [string]$FallbackTaskName = 'Hermes-ThuHa-Fanpage-Draft-Processor',
    [string]$LocalHealthUrl = 'http://127.0.0.1:8788/health',
    [string]$DataRoot = 'D:\HermesAgent\data'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$naturalInstaller = Join-Path $PSScriptRoot 'install_natural_cosmetics_agent.ps1'
$sidecarInstaller = Join-Path $PSScriptRoot 'recreate_meta_bridge_sidecar.ps1'
$fallbackInstaller = Join-Path $PSScriptRoot 'install_fanpage_draft_scheduled_task.ps1'
$envPath = Join-Path $DataRoot '.env'
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
    if (-not $updated) {
        $lines += "$Key=$Value"
    }
    [System.IO.File]::WriteAllLines($Path, $lines, $Utf8NoBom)
}

foreach ($required in @($naturalInstaller, $sidecarInstaller, $envPath)) {
    if (-not (Test-Path $required)) {
        throw "Required realtime installation file not found: $required"
    }
}

Write-Host 'Installing reliable Hermes conversation runtime and tests...'
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $naturalInstaller
if ($LASTEXITCODE -ne 0) {
    throw "Natural cosmetics installation failed with exit code $LASTEXITCODE"
}

# Use absolute paths. Login shells and older cached image layers may not expose the
# virtualenv on PATH even though the Hermes binary exists in the official image.
Set-EnvValue -Path $envPath -Key 'HERMES_HOME' -Value '/opt/data'
Set-EnvValue -Path $envPath -Key 'THA_HERMES_BIN' -Value '/opt/hermes/.venv/bin/hermes'

# Recreate the Meta adapter as a true sidecar. Bypassing the image s6 entrypoint is
# intentional here: the sidecar must run only Uvicorn, never a second Hermes gateway
# or a second Telegram long-poller against the shared data directory.
& powershell.exe -NoProfile -ExecutionPolicy Bypass `
    -File $sidecarInstaller `
    -DataRoot $DataRoot `
    -ContainerName $MetaContainerName `
    -LocalHealthUrl $LocalHealthUrl
if ($LASTEXITCODE -ne 0) {
    throw "Meta sidecar recreation failed with exit code $LASTEXITCODE"
}

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
    Write-Host '--- META SIDECAR LOG TAIL ---'
    docker logs --tail 80 $MetaContainerName
    throw 'Meta sidecar health check failed after realtime installation.'
}
if ($health.mode -ne 'REALTIME_NATURAL_AUTO_REPLY' -and $health.mode -ne 'DRAFT_ONLY_INGEST') {
    throw "Unexpected Meta bridge mode after recreation: $($health.mode)"
}
if ($health.reasoning_mode -ne 'HERMES_CONVERSATION_RUNTIME') {
    throw "Reliable Hermes conversation runtime is not active: $($health.reasoning_mode)"
}
if ($health.factual_lookup -ne 'ON_DEMAND_WITH_PRICE') {
    throw "Price-aware factual lookup is not active: $($health.factual_lookup)"
}
if ($health.hermes_home -ne '/opt/data') {
    throw "Unexpected Hermes home in Meta bridge: $($health.hermes_home)"
}

# This is a real provider smoke test, not a mocked unit test. Installation fails
# closed rather than silently sending canned fallbacks to customers.
$smokeScript = @'
set -eu
if [ -f /opt/data/.env ]; then
  set -a
  . /opt/data/.env
  set +a
fi
export HERMES_HOME="${HERMES_HOME:-/opt/data}"
HERMES_BIN="${THA_HERMES_BIN:-/opt/hermes/.venv/bin/hermes}"
test -x "$HERMES_BIN"
result="$("$HERMES_BIN" -z 'Trả lời duy nhất một từ: OK' 2>/tmp/tha-hermes-realtime-smoke.err)"
test -n "$result"
'@ -replace "`r`n", "`n"

$smoke = Invoke-NativeCapture -FilePath 'docker' -Arguments @(
    'exec', $MetaContainerName, '/bin/sh', '-c', $smokeScript
)
if ($smoke.ExitCode -ne 0) {
    $diagnostic = Invoke-NativeCapture -FilePath 'docker' -Arguments @(
        'exec', $MetaContainerName, '/bin/sh', '-c',
        'echo "HERMES_BIN=${THA_HERMES_BIN:-/opt/hermes/.venv/bin/hermes}"; ls -l /opt/hermes/.venv/bin/hermes 2>/dev/null || true; tail -c 1000 /tmp/tha-hermes-realtime-smoke.err 2>/dev/null || true'
    )
    Write-Host 'HERMES_RUNTIME_SMOKE=FAILED' -ForegroundColor Red
    foreach ($line in $diagnostic.Output) {
        if ($null -ne $line -and "$line".Trim()) { Write-Host "$line" }
    }
    Set-EnvValue -Path $envPath -Key 'THA_REPLY_MODE' -Value 'DRAFT_ONLY'
    Set-EnvValue -Path $envPath -Key 'THA_META_AUTO_SEND' -Value 'false'
    throw 'Hermes live runtime failed. Auto-send was disabled to prevent canned replies.'
}

$task = Get-ScheduledTask -TaskName $FallbackTaskName -ErrorAction SilentlyContinue
if ($null -eq $task) {
    if (-not (Test-Path $fallbackInstaller)) {
        throw "Fallback installer not found: $fallbackInstaller"
    }
    & powershell.exe -NoProfile -ExecutionPolicy Bypass `
        -File $fallbackInstaller `
        -TaskName $FallbackTaskName `
        -IntervalMinutes 5
    if ($LASTEXITCODE -ne 0) {
        throw "Fallback Scheduled Task installation failed with exit code $LASTEXITCODE"
    }
}
else {
    Start-ScheduledTask -TaskName $FallbackTaskName
}

$task = Get-ScheduledTask -TaskName $FallbackTaskName -ErrorAction Stop
$taskInfo = Get-ScheduledTaskInfo -TaskName $FallbackTaskName

Write-Host 'PASS: Realtime Fanpage reliable Hermes conversation runtime installed'
Write-Host "META_CONTAINER=$MetaContainerName"
Write-Host 'META_SIDECAR_ONLY=TRUE'
Write-Host 'DUPLICATE_TELEGRAM_POLLING=DISABLED'
Write-Host "LOCAL_HEALTH_STATUS=$($health.status)"
Write-Host "MODE=$($health.mode)"
Write-Host "SCHEDULED_FALLBACK=$($health.scheduled_fallback)"
Write-Host "REASONING_MODE=$($health.reasoning_mode)"
Write-Host "FACTUAL_LOOKUP=$($health.factual_lookup)"
Write-Host "HERMES_HOME=$($health.hermes_home)"
Write-Host 'HERMES_BIN=/opt/hermes/.venv/bin/hermes'
Write-Host 'HERMES_RUNTIME_SMOKE=PASS'
Write-Host "FALLBACK_TASK_STATE=$($task.State)"
Write-Host "FALLBACK_LAST_RESULT=$($taskInfo.LastTaskResult)"
Write-Host 'PRICE_AWARE_RECOMMENDATION=ENABLED'
Write-Host 'GENERIC_FALLBACK_LOOP=DISABLED'
Write-Host 'AUTO_SEND=UNCHANGED'
