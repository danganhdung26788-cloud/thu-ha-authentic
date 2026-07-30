[CmdletBinding(SupportsShouldProcess)]
param(
    [string]$Container = "hermes-gateway",
    [string]$DataRoot = "D:\HermesAgent\data",
    [switch]$Restart,
    [ValidateSet("Plan", "Apply")]
    [string]$ScheduleMode = "Plan",
    [ValidateRange(15, 300)]
    [int]$HealthTimeoutSeconds = 60
)

$ErrorActionPreference = "Stop"
$sourceRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$targetRoot = Join-Path $DataRoot "tha-integrations"
$envFile = Join-Path $DataRoot ".env"
$required = @(
    "TELEGRAM_BOT_TOKEN",
    "HERMES_TASK_OWNER_USER_ID",
    "HERMES_TASK_CHAT_ID",
    "TASKFLOW_SPREADSHEET_ID",
    "TASK_ONLY_MODE"
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
if ($envText -notmatch "(?im)^TASK_ONLY_MODE=(true|yes|1)\s*$") {
    throw "TASK_ONLY_MODE must be true"
}
if ($ScheduleMode -eq "Apply" -and -not $Restart) {
    throw "ScheduleMode Apply requires -Restart so code is healthy before cutover"
}

$containerId = docker ps --filter "name=^/$Container$" --format "{{.ID}}"
if (-not $containerId) {
    throw "Running container not found: $Container"
}
docker exec $Container test -f /opt/hermes/plugins/platforms/telegram/adapter.py
if ($LASTEXITCODE -ne 0) {
    throw "Hermes Telegram polling adapter was not found"
}

function Test-RuntimeEnvironment {
    $runtimeCheck = (
        "import os,sys;" +
        "names=('HERMES_TASK_OWNER_USER_ID','HERMES_TASK_CHAT_ID'," +
        "'TASKFLOW_SPREADSHEET_ID','TASK_ONLY_MODE');" +
        "sys.exit(0 if all(os.getenv(n,'').strip() for n in names) " +
        "and os.getenv('TASK_ONLY_MODE','').strip().lower() in ('true','yes','1') else 2)"
    )
    docker exec $Container python -c $runtimeCheck
    return $LASTEXITCODE -eq 0
}

function Test-HermesHealth {
    $running = docker inspect --format "{{.State.Running}}" $Container 2>$null
    if ($LASTEXITCODE -ne 0 -or $running -ne "true") {
        return $false
    }
    $gatewayPattern = (
        "pgrep -f '^/opt/hermes/.venv/bin/python3 " +
        "/opt/hermes/.venv/bin/hermes gateway run' >/dev/null"
    )
    docker exec $Container sh -lc $gatewayPattern
    return $LASTEXITCODE -eq 0
}

function Wait-HermesHealth {
    param([int]$TimeoutSeconds)
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
        if ((Test-HermesHealth) -and (Test-RuntimeEnvironment)) {
            return $true
        }
        Start-Sleep -Seconds 2
    } while ((Get-Date) -lt $deadline)
    return $false
}

if (-not (Test-RuntimeEnvironment)) {
    throw (
        "Container runtime is missing Issue #39 variables. Recreate the container " +
        "with the reviewed env file before patching; restart alone does not reload env."
    )
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

if ($PSCmdlet.ShouldProcess($Container, "Compile patched adapter and modules before restart")) {
    docker exec $Container python -m py_compile `
        /opt/hermes/plugins/platforms/telegram/adapter.py `
        /opt/data/tha-integrations/integrations/hermes/task_checklist.py `
        /opt/data/tha-integrations/integrations/hermes/task_checklist_polling.py
    if ($LASTEXITCODE -ne 0) {
        docker exec $Container python `
            /opt/data/tha-integrations/integrations/hermes/patch_telegram_polling_adapter.py `
            --rollback
        if ($LASTEXITCODE -ne 0) {
            throw "Compile failed and adapter rollback failed"
        }
        docker exec $Container python -m py_compile `
            /opt/hermes/plugins/platforms/telegram/adapter.py
        if ($LASTEXITCODE -ne 0) {
            throw "Compile failed; rollback adapter also failed compile; gateway was not restarted"
        }
        throw "Compile failed; adapter restored and gateway was not restarted"
    }
}

& (Join-Path $PSScriptRoot "configure_task_only_schedules.ps1") `
    -Mode Plan -Container $Container -DataRoot $DataRoot

if ($Restart -and $PSCmdlet.ShouldProcess($Container, "Restart verified Hermes gateway")) {
    docker restart $Container | Out-Null
    if (-not (Wait-HermesHealth -TimeoutSeconds $HealthTimeoutSeconds)) {
        docker exec $Container python `
            /opt/data/tha-integrations/integrations/hermes/patch_telegram_polling_adapter.py `
            --rollback
        if ($LASTEXITCODE -ne 0) {
            throw "New gateway failed health check and adapter rollback failed"
        }
        docker exec $Container python -m py_compile `
            /opt/hermes/plugins/platforms/telegram/adapter.py
        if ($LASTEXITCODE -ne 0) {
            throw "Rollback adapter failed compile after new gateway health failure"
        }
        docker restart $Container | Out-Null
        if (-not (Wait-HermesHealth -TimeoutSeconds $HealthTimeoutSeconds)) {
            throw "New gateway failed; old adapter restored but old gateway health is also failing"
        }
        throw "New gateway failed health; old adapter restored and old health verified"
    }
    if ($ScheduleMode -eq "Apply") {
        & (Join-Path $PSScriptRoot "configure_task_only_schedules.ps1") `
            -Mode Apply -Container $Container -DataRoot $DataRoot
    }
}

Write-Output "ISSUE39_POLLING_INSTALL_READY=TRUE"
