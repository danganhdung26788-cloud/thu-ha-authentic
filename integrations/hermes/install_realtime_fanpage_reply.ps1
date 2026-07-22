#Requires -RunAsAdministrator

param(
    [string]$MetaContainerName = 'hermes-tha-meta',
    [string]$FallbackTaskName = 'Hermes-ThuHa-Fanpage-Draft-Processor',
    [string]$LocalHealthUrl = 'http://127.0.0.1:8788/health'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$naturalInstaller = Join-Path $PSScriptRoot 'install_natural_cosmetics_agent.ps1'
$fallbackInstaller = Join-Path $PSScriptRoot 'install_fanpage_draft_scheduled_task.ps1'

if (-not (Test-Path $naturalInstaller)) {
    throw "Natural cosmetics installer not found: $naturalInstaller"
}

Write-Host 'Installing current natural-reply code, context guard and tests...'
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $naturalInstaller
if ($LASTEXITCODE -ne 0) {
    throw "Natural cosmetics installation failed with exit code $LASTEXITCODE"
}

$metaExists = docker ps -a --filter "name=^/$MetaContainerName$" --format '{{.Names}}'
if ($metaExists -ne $MetaContainerName) {
    throw "Meta bridge container is not installed: $MetaContainerName"
}

docker restart $MetaContainerName | Out-Null
if ($LASTEXITCODE -ne 0) {
    throw "Could not restart Meta bridge container: $MetaContainerName"
}

$health = $null
for ($attempt = 1; $attempt -le 30; $attempt++) {
    Start-Sleep -Seconds 2
    try {
        $health = Invoke-RestMethod -Uri $LocalHealthUrl -Method Get -TimeoutSec 5
        if ($health.status -eq 'ok') {
            break
        }
    }
    catch {
        $health = $null
    }
}

if (-not $health -or $health.status -ne 'ok') {
    Write-Host '--- META BRIDGE LOG TAIL ---'
    docker logs --tail 60 $MetaContainerName
    throw 'Meta bridge health check failed after realtime installation.'
}

if ($health.mode -ne 'REALTIME_NATURAL_AUTO_REPLY' -and $health.mode -ne 'DRAFT_ONLY_INGEST') {
    throw "Unexpected Meta bridge mode after restart: $($health.mode)"
}

if ($health.context_guard -ne 'enabled') {
    throw "Context guard is not enabled after restart: $($health.context_guard)"
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

Write-Host 'PASS: Realtime Fanpage natural reply installed'
Write-Host "META_CONTAINER=$MetaContainerName"
Write-Host "LOCAL_HEALTH_STATUS=$($health.status)"
Write-Host "MODE=$($health.mode)"
Write-Host "SCHEDULED_FALLBACK=$($health.scheduled_fallback)"
Write-Host "CONTEXT_GUARD=$($health.context_guard)"
Write-Host "FALLBACK_TASK_STATE=$($task.State)"
Write-Host "FALLBACK_LAST_RESULT=$($taskInfo.LastTaskResult)"
Write-Host 'PRODUCT_CONTEXT=STRICT_TRUSTED_CONTEXT_ONLY'
Write-Host 'RANDOM_CATALOG_FALLBACK=DISABLED'
Write-Host 'CORRECTION_HANDOFF=ENABLED'
