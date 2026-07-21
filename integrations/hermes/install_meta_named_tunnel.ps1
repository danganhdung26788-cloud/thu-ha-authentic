#Requires -RunAsAdministrator

param(
    [string]$ContainerName = "hermes-tha-cloudflared-named",
    [string]$MetaContainerName = "hermes-tha-meta",
    [string]$TokenPath = "D:\HermesAgent\secrets\cloudflare_tunnel_token.txt",
    [string]$LocalHealthUrl = "http://127.0.0.1:8788/health"
)

$ErrorActionPreference = "Stop"

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    throw "Docker command not found."
}
if (-not (Test-Path $TokenPath)) {
    throw "Cloudflare tunnel token file not found: $TokenPath"
}
if ((Get-Item $TokenPath).Length -lt 20) {
    throw "Cloudflare tunnel token file is empty or invalid."
}

$metaRunning = docker inspect -f '{{.State.Running}}' $MetaContainerName 2>$null
if ($LASTEXITCODE -ne 0 -or ($metaRunning | Out-String).Trim().ToLowerInvariant() -ne "true") {
    throw "Meta bridge container is not running: $MetaContainerName"
}

$health = Invoke-RestMethod -Uri $LocalHealthUrl -Method Get -TimeoutSec 10
if ($health.status -ne "ok") {
    throw "Meta bridge local health check failed."
}

$existing = docker ps -a --filter "name=^/$ContainerName$" --format "{{.Names}}"
if ($existing -eq $ContainerName) {
    docker rm -f $ContainerName | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "Could not replace existing named tunnel container."
    }
}

$volumeArg = "${TokenPath}:/run/secrets/tunnel-token:ro"
$containerId = docker run -d `
    --name $ContainerName `
    --restart unless-stopped `
    -v $volumeArg `
    cloudflare/cloudflared:latest `
    tunnel --no-autoupdate run --token-file /run/secrets/tunnel-token

if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($containerId)) {
    throw "Failed to create named Cloudflare Tunnel container."
}

Start-Sleep -Seconds 8
$status = docker inspect --format '{{.State.Status}}' $ContainerName
$restartCount = docker inspect --format '{{.RestartCount}}' $ContainerName
if ($status -ne "running") {
    Write-Host "--- CONTAINER LOG TAIL ---"
    docker logs --tail 30 $ContainerName
    throw "Named tunnel container is not running."
}

$logs = docker logs --since 2m $ContainerName 2>&1
$registered = (($logs -join "`n") -match 'Registered tunnel connection')

Write-Host "PASS: named Cloudflare Tunnel container installed"
Write-Host "CONTAINER_NAME=$ContainerName"
Write-Host "CONTAINER_STATUS=$status"
Write-Host "RESTART_COUNT=$restartCount"
Write-Host "TOKEN_PRINTED=FALSE"
Write-Host "LOCAL_ORIGIN_URL=http://host.docker.internal:8788"
Write-Host "TUNNEL_CONNECTION_LOG=$(if ($registered) { 'REGISTERED' } else { 'PENDING_DASHBOARD_HEALTH' })"
Write-Host "NEXT=configure a Published application route in Cloudflare Dashboard"
