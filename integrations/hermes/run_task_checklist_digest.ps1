[CmdletBinding()]
param(
    [string]$Container = "hermes-gateway",
    [string]$DataRoot = "D:\HermesAgent\data"
)

$ErrorActionPreference = "Stop"
$envFile = Join-Path $DataRoot ".env"
if (-not (Test-Path -LiteralPath $envFile -PathType Leaf)) {
    throw "Runtime env file not found: $envFile"
}
$envText = Get-Content -LiteralPath $envFile -Raw
if ($envText -notmatch "(?im)^TASK_ONLY_MODE=(true|yes|1)\s*$") {
    throw "TASK_ONLY_MODE=true is required; legacy brief fallback is forbidden"
}
if (-not (docker ps --filter "name=^/$Container$" --format "{{.ID}}")) {
    throw "Running container not found: $Container"
}
docker exec `
    -e PYTHONPATH=/opt/data/tha-integrations `
    $Container python -m integrations.hermes.task_checklist digest --send
if ($LASTEXITCODE -ne 0) {
    throw "Task-only checklist digest failed"
}
