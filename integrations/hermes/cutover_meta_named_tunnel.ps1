#Requires -RunAsAdministrator

param(
    [Parameter(Mandatory = $true)]
    [string]$PublicBaseUrl,
    [string]$NamedContainerName = "hermes-tha-cloudflared-named",
    [string]$QuickContainerName = "hermes-tha-cloudflared-quick"
)

$ErrorActionPreference = "Stop"
$baseUrl = $PublicBaseUrl.TrimEnd('/')

$namedRunning = docker inspect -f '{{.State.Running}}' $NamedContainerName 2>$null
if ($LASTEXITCODE -ne 0 -or ($namedRunning | Out-String).Trim().ToLowerInvariant() -ne "true") {
    throw "Named tunnel container is not running: $NamedContainerName"
}

$health = Invoke-RestMethod -Uri "$baseUrl/health" -Method Get -TimeoutSec 20
if ($health.status -ne "ok") {
    throw "Public named-tunnel health check failed."
}
if ($health.mode -ne "DRAFT_ONLY_INGEST") {
    throw "Unexpected Meta bridge mode: $($health.mode)"
}

$quickExists = docker ps -a --filter "name=^/$QuickContainerName$" --format "{{.Names}}"
if ($quickExists -eq $QuickContainerName) {
    docker rm -f $QuickContainerName | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "Named tunnel is healthy but Quick Tunnel removal failed."
    }
}

Write-Host "PASS: Meta webhook cut over to named Cloudflare Tunnel"
Write-Host "PUBLIC_BASE_URL=$baseUrl"
Write-Host "PUBLIC_HEALTH_STATUS=$($health.status)"
Write-Host "MODE=$($health.mode)"
Write-Host "QUICK_TUNNEL_REMOVED=$(if ($quickExists -eq $QuickContainerName) { 'TRUE' } else { 'NOT_PRESENT' })"
Write-Host "CALLBACK_URL=$baseUrl/webhook/meta-messenger"
