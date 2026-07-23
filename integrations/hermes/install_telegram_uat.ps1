#Requires -RunAsAdministrator

param(
    [string]$GatewayContainer = 'hermes-gateway',
    [string]$MetaContainer = 'hermes-tha-meta',
    [string]$DataRoot = 'D:\HermesAgent\data',
    [string]$LocalHealthUrl = 'http://127.0.0.1:8788/health'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$SourceIntegrations = Join-Path $RepoRoot 'integrations'
$SourceUatSkill = Join-Path $PSScriptRoot 'skills\thu-ha-uat'
$DestinationRoot = Join-Path $DataRoot 'tha-integrations'
$DestinationIntegrations = Join-Path $DestinationRoot 'integrations'
$SkillDestination = Join-Path (Join-Path $DataRoot 'skills') 'thu-ha-uat'
$EnvPath = Join-Path $DataRoot '.env'
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$PosSpreadsheetId = '1doVqvBOq0sn7mQ3LgfAuZfvfjW08jIWdvswgYTwiY-s'
$PosProductsRange = 'Products!A1:AN2000'

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
    if (-not $updated) { $lines += "$Key=$Value" }
    [System.IO.File]::WriteAllLines($Path, $lines, $Utf8NoBom)
}

function Assert-Running {
    param([string]$Container)
    $running = docker inspect -f '{{.State.Running}}' $Container 2>$null
    if ($LASTEXITCODE -ne 0 -or ($running | Out-String).Trim().ToLowerInvariant() -ne 'true') {
        throw "Container is not running: $Container"
    }
}

foreach ($required in @($SourceIntegrations, $SourceUatSkill, $EnvPath)) {
    if (-not (Test-Path $required)) {
        throw "Required file or directory not found: $required"
    }
}
Assert-Running -Container $GatewayContainer
Assert-Running -Container $MetaContainer

$HermesBin = Resolve-ContainerCommandPath -Container $GatewayContainer -Command 'hermes'
$PythonBin = Resolve-ContainerCommandPath -Container $GatewayContainer -Command 'python'

# Fail closed before changing runtime files or source routing.
Set-EnvValue -Path $EnvPath -Key 'THA_REPLY_MODE' -Value 'DRAFT_ONLY'
Set-EnvValue -Path $EnvPath -Key 'THA_META_AUTO_SEND' -Value 'false'
Set-EnvValue -Path $EnvPath -Key 'HERMES_HOME' -Value '/opt/data'
Set-EnvValue -Path $EnvPath -Key 'THA_HERMES_BIN' -Value $HermesBin
Set-EnvValue -Path $EnvPath -Key 'THA_PYTHON_BIN' -Value $PythonBin
Set-EnvValue -Path $EnvPath -Key 'THA_PRODUCT_SOURCE_MODE' -Value 'POS_WEBAPP'
Set-EnvValue -Path $EnvPath -Key 'THA_POS_SPREADSHEET_ID' -Value $PosSpreadsheetId
Set-EnvValue -Path $EnvPath -Key 'THA_POS_PRODUCTS_RANGE' -Value $PosProductsRange

docker restart $MetaContainer | Out-Null
Start-Sleep -Seconds 3

New-Item -ItemType Directory -Force -Path $DestinationRoot | Out-Null
New-Item -ItemType Directory -Force -Path (Split-Path $SkillDestination -Parent) | Out-Null
if (Test-Path $DestinationIntegrations) {
    Remove-Item $DestinationIntegrations -Recurse -Force
}
Copy-Item -LiteralPath $SourceIntegrations -Destination $DestinationRoot -Recurse -Force
if (Test-Path $SkillDestination) {
    Remove-Item $SkillDestination -Recurse -Force
}
Copy-Item -LiteralPath $SourceUatSkill -Destination $SkillDestination -Recurse -Force

$testModules = @(
    'integrations.hermes.tests.test_telegram_uat',
    'integrations.hermes.tests.test_fast_grounded_runtime',
    'integrations.hermes.tests.test_conversation_runtime_processor',
    'integrations.hermes.tests.test_context_safety_regression'
)
foreach ($module in $testModules) {
    $test = Invoke-NativeCapture -FilePath 'docker' -Arguments @(
        'exec',
        '-e', 'HERMES_HOME=/opt/data',
        '-e', 'THA_PRODUCT_SOURCE_MODE=FAST_INDEX',
        '-e', 'PYTHONPATH=/opt/data/tha-integrations:/opt/data/tha-integrations/.vendor',
        $GatewayContainer,
        $PythonBin,
        '-m', 'unittest', '-v', $module
    )
    $test.Output | ForEach-Object { Write-Host $_ }
    if ($test.ExitCode -ne 0) {
        throw "Telegram UAT/runtime test failed: $module"
    }
}

# Restart the one existing Telegram gateway and Uvicorn-only Meta sidecar.
docker restart $GatewayContainer | Out-Null
Start-Sleep -Seconds 8
docker restart $MetaContainer | Out-Null

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
    docker logs --tail 100 $MetaContainer
    throw 'Meta sidecar health check failed after Telegram UAT installation.'
}
if ($health.mode -ne 'DRAFT_ONLY_INGEST') {
    throw "Expected DRAFT_ONLY_INGEST, got: $($health.mode)"
}

$skillCheck = Invoke-NativeCapture -FilePath 'docker' -Arguments @(
    'exec', '-e', 'HERMES_HOME=/opt/data', $GatewayContainer, $HermesBin, 'skills', 'list'
)
$skillText = $skillCheck.Output | Out-String
if (
    $skillCheck.ExitCode -ne 0 -or
    $skillText -notmatch 'thu-ha-cosmetics' -or
    $skillText -notmatch 'thu-ha-training' -or
    $skillText -notmatch 'thu-ha-uat'
) {
    throw 'Required Thu Ha cosmetics, training, and UAT skills were not discovered.'
}

$uat = Invoke-NativeCapture -FilePath 'docker' -Arguments @(
    'exec',
    '-e', 'HERMES_HOME=/opt/data',
    '-e', 'THA_PRODUCT_SOURCE_MODE=POS_WEBAPP',
    '-e', "THA_POS_SPREADSHEET_ID=$PosSpreadsheetId",
    '-e', "THA_POS_PRODUCTS_RANGE=$PosProductsRange",
    '-e', 'PYTHONPATH=/opt/data/tha-integrations:/opt/data/tha-integrations/.vendor',
    $GatewayContainer,
    $PythonBin,
    '-m', 'integrations.hermes.telegram_uat',
    '--message', 'Anh muốn mua mặt nạ giấy cho da hơi khô và muốn da sáng hơn, giá bao nhiêu cũng được.',
    '--format', 'json'
)
$uatText = $uat.Output | Out-String
if ($uat.ExitCode -ne 0) {
    throw "Telegram UAT POS smoke failed: $uatText"
}
try {
    $uatResult = $uatText | ConvertFrom-Json
}
catch {
    throw "Telegram UAT did not return valid JSON: $uatText"
}
if (
    $uatResult.status -ne 'PASS' -or
    $uatResult.source -ne 'POS_WEBAPP_PRODUCTS_SOURCE_OF_TRUTH' -or
    [string]::IsNullOrWhiteSpace($uatResult.product_key) -or
    [string]::IsNullOrWhiteSpace($uatResult.product_name) -or
    [string]::IsNullOrWhiteSpace($uatResult.sale_price) -or
    $uatResult.send_to_customer -ne $false -or
    [int]$uatResult.queue_writes -ne 0 -or
    [int]$uatResult.meta_calls -ne 0
) {
    throw "Telegram UAT source-of-truth verification failed: $uatText"
}

$startedAt = (docker inspect -f '{{.State.StartedAt}}' $MetaContainer | Out-String).Trim()
$logs = Invoke-NativeCapture -FilePath 'docker' -Arguments @(
    'logs', '--since', $startedAt, $MetaContainer
)
$conflictPattern = '(?i)polling conflict|terminated by other getUpdates request|Hermes Gateway Starting|hermes_plugins\.telegram_platform\.adapter|\[Telegram\].*getUpdates'
$conflictLines = @($logs.Output | ForEach-Object { "$($_)" } | Where-Object { $_ -match $conflictPattern })
if ($conflictLines.Count -gt 0) {
    $conflictLines | ForEach-Object { Write-Host $_ }
    throw 'Duplicate Telegram polling or Hermes gateway activity detected in Meta sidecar.'
}

Write-Host 'PASS: Telegram read-only UAT connected to POS Web App source of truth' -ForegroundColor Green
Write-Host 'UAT_SKILL=/thu-ha-uat'
Write-Host 'PRODUCT_SOURCE=POS_WEBAPP_PRODUCTS_SOURCE_OF_TRUTH'
Write-Host "SOURCE_SPREADSHEET_ID=$PosSpreadsheetId"
Write-Host "SOURCE_RANGE=$PosProductsRange"
Write-Host "UAT_PRODUCT_KEY=$($uatResult.product_key)"
Write-Host "UAT_PRODUCT_NAME=$($uatResult.product_name)"
Write-Host "UAT_PRODUCT_PRICE=$($uatResult.sale_price)"
Write-Host "UAT_PRODUCT_STOCK=$($uatResult.current_stock)"
Write-Host 'MESSENGER_PRODUCT_SOURCE=POS_WEBAPP_PRODUCTS_SOURCE_OF_TRUTH'
Write-Host 'UAT_SEND_TO_CUSTOMER=FALSE'
Write-Host 'UAT_QUEUE_WRITES=0'
Write-Host 'UAT_META_CALLS=0'
Write-Host 'DUPLICATE_TELEGRAM_POLLING=NONE'
Write-Host 'MODE=DRAFT_ONLY_INGEST'
Write-Host 'AUTO_SEND=DISABLED_FOR_LIVE_UAT'
