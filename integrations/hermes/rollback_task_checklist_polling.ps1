[CmdletBinding(SupportsShouldProcess)]
param(
    [string]$Container = "hermes-gateway",
    [switch]$Restart
)

$ErrorActionPreference = "Stop"
if (-not (docker ps --filter "name=^/$Container$" --format "{{.ID}}")) {
    throw "Running container not found: $Container"
}
if ($PSCmdlet.ShouldProcess($Container, "Restore backed-up polling adapter")) {
    docker exec $Container python `
        /opt/data/tha-integrations/integrations/hermes/patch_telegram_polling_adapter.py `
        --rollback
    if ($LASTEXITCODE -ne 0) {
        throw "Polling adapter rollback failed"
    }
}
if ($Restart -and $PSCmdlet.ShouldProcess($Container, "Restart Hermes gateway")) {
    docker restart $Container | Out-Null
}
Write-Output "ISSUE39_POLLING_ROLLBACK_READY=TRUE"
