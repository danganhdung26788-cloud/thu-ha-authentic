Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$Container = 'hermes-gateway'
$HermesData = 'D:\HermesAgent\data'
$DestinationRoot = Join-Path $HermesData 'tha-integrations'
$DestinationPackage = Join-Path $DestinationRoot 'integrations\hermes'

Write-Host 'Installing Thu Ha Authentic Hermes integration...'

if (-not (Test-Path $HermesData)) {
    throw "Hermes data directory not found: $HermesData"
}

$running = docker inspect -f '{{.State.Running}}' $Container 2>$null
if ($running -ne 'true') {
    throw "Container is not running: $Container"
}

New-Item -ItemType Directory -Force -Path $DestinationPackage | Out-Null
Copy-Item -Path (Join-Path $PSScriptRoot '*') -Destination $DestinationPackage -Recurse -Force

$installCommand = @'
python -m pip install -r /opt/data/tha-integrations/integrations/hermes/requirements.txt &&
PYTHONPATH=/opt/data/tha-integrations META_DEDUPE_DB=/tmp/tha-meta-dedupe.db \
python -m unittest integrations.hermes.tests.test_integration
'@

docker exec $Container /bin/sh -lc $installCommand
if ($LASTEXITCODE -ne 0) {
    throw 'Dependency installation or unit tests failed.'
}

$dryRunCommand = @'
set -a
. /opt/data/.env
set +a
PYTHONPATH=/opt/data/tha-integrations THA_TELEGRAM_DRY_RUN=true \
python /opt/data/tha-integrations/integrations/hermes/telegram_dispatcher.py
'@

docker exec $Container /bin/sh -lc $dryRunCommand
if ($LASTEXITCODE -ne 0) {
    throw 'Telegram dry-run failed.'
}

Write-Host 'PASS: package installed, unit tests passed, Telegram dry-run executed.'
Write-Host 'Review TELEGRAM_QUEUE and RUN_LOG before enabling real delivery.'
