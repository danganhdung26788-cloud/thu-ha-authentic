[CmdletBinding(SupportsShouldProcess)]
param(
    [string]$Container = "hermes-gateway",
    [string]$DataRoot = "D:\HermesAgent\data",
    [switch]$Restart
)

$ErrorActionPreference = "Stop"
$sourceRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$targetRoot = Join-Path $DataRoot "tha-integrations"
$envFile = Join-Path $DataRoot ".env"
$required = @(
    "TELEGRAM_BOT_TOKEN",
    "HERMES_TASK_OWNER_USER_ID",
    "HERMES_TASK_CHAT_ID",
    "TASKFLOW_SPREADSHEET_ID"
)

if (-not (Test-Path -LiteralPath $envFile -PathType Leaf)) {
    throw "Runtime env file not found: $envFile"
}
$envText = Get-Content -LiteralPath $envFile -Raw
foreach ($name in $required) {
    if ($envText -notmatch "(?m)^$([regex]::Escape($name))=.+$") {
        throw "Required environment variable is missing or empty: $name"
    }
}

$containerId = docker ps --filter "name=^/$Container$" --format "{{.ID}}"
if (-not $containerId) {
    throw "Running container not found: $Container"
}
docker exec $Container test -f /opt/hermes/plugins/platforms/telegram/adapter.py
if ($LASTEXITCODE -ne 0) {
    throw "Hermes Telegram polling adapter was not found"
}

if ($PSCmdlet.ShouldProcess($targetRoot, "Copy reviewed Issue #39 integration package")) {
    New-Item -ItemType Directory -Path $targetRoot -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $sourceRoot "integrations") `
        -Destination $targetRoot -Recurse -Force
}

if ($PSCmdlet.ShouldProcess($Container, "Patch existing getUpdates adapter")) {
    docker exec $Container python `
        /opt/data/tha-integrations/integrations/hermes/patch_telegram_polling_adapter.py
    if ($LASTEXITCODE -ne 0) {
        throw "Polling adapter patch failed"
    }
}

if ($Restart -and $PSCmdlet.ShouldProcess($Container, "Restart Hermes gateway")) {
    docker restart $Container | Out-Null
    docker exec $Container python -m py_compile `
        /opt/hermes/plugins/platforms/telegram/adapter.py `
        /opt/data/tha-integrations/integrations/hermes/task_checklist.py `
        /opt/data/tha-integrations/integrations/hermes/task_checklist_polling.py
    if ($LASTEXITCODE -ne 0) {
        throw "Post-restart compile check failed"
    }
}

Write-Output "ISSUE39_POLLING_INSTALL_READY=TRUE"
