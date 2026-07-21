param(
    [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$Container = 'hermes-gateway'
$HermesData = 'D:\HermesAgent\data'
$DestinationRoot = Join-Path $HermesData 'tha-integrations'
$RunnerHostPath = Join-Path $DestinationRoot 'fanpage_draft_run.sh'
$RunnerContainerPath = '/opt/data/tha-integrations/fanpage_draft_run.sh'
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$DryRunValue = if ($DryRun) { 'true' } else { 'false' }

$running = docker inspect -f '{{.State.Running}}' $Container 2>$null
if ($running -ne 'true') {
    throw "Container is not running: $Container"
}

$runnerScript = @"
#!/bin/sh
set -eu
ROOT=/opt/data/tha-integrations
CREDENTIALS=/opt/data/google/application_default_credentials.json
if [ -f /opt/data/.env ]; then
  set -a
  . /opt/data/.env
  set +a
fi
export GOOGLE_APPLICATION_CREDENTIALS="`$CREDENTIALS"
export PYTHONPATH="`$ROOT:`$ROOT/.vendor"
THA_FANPAGE_DRAFT_DRY_RUN=$DryRunValue python -m integrations.hermes.fanpage_draft_processor
"@

$normalized = $runnerScript -replace "`r`n", "`n" -replace "`r", "`n"
[System.IO.File]::WriteAllText($RunnerHostPath, $normalized, $Utf8NoBom)

docker exec $Container /bin/sh $RunnerContainerPath
if ($LASTEXITCODE -ne 0) {
    throw 'Fanpage draft processor failed.'
}

Write-Host "PASS: Fanpage draft processor completed"
Write-Host "DRY_RUN=$DryRunValue"
Write-Host 'AUTO_SEND=FALSE'
