param(
    [string]$ContainerName = "hermes-tha-cloudflared-named",
    [int]$TailLines = 40
)

$ErrorActionPreference = "Stop"
$exists = docker ps -a --filter "name=^/$ContainerName$" --format "{{.Names}}"
if ($exists -ne $ContainerName) {
    Write-Host "CONTAINER_STATUS=NOT_INSTALLED"
    exit 1
}

$status = docker inspect --format '{{.State.Status}}' $ContainerName
$restartCount = docker inspect --format '{{.RestartCount}}' $ContainerName
$startedAt = docker inspect --format '{{.State.StartedAt}}' $ContainerName
$logs = docker logs --since 15m $ContainerName 2>&1
$registered = (($logs -join "`n") -match 'Registered tunnel connection')

Write-Host "CONTAINER_NAME=$ContainerName"
Write-Host "CONTAINER_STATUS=$status"
Write-Host "RESTART_COUNT=$restartCount"
Write-Host "STARTED_AT=$startedAt"
Write-Host "TOKEN_PRINTED=FALSE"
Write-Host "LOCAL_ORIGIN_URL=http://host.docker.internal:8788"
Write-Host "TUNNEL_CONNECTION_LOG=$(if ($registered) { 'REGISTERED' } else { 'NOT_SEEN_IN_LAST_15_MINUTES' })"
Write-Host "--- LOG TAIL ---"
docker logs --tail $TailLines $ContainerName
