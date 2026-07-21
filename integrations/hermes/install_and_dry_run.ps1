Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$Container = 'hermes-gateway'
$HermesData = 'D:\HermesAgent\data'
$DestinationRoot = Join-Path $HermesData 'tha-integrations'
$DestinationIntegrations = Join-Path $DestinationRoot 'integrations'
$GoogleDir = Join-Path $HermesData 'google'
$MountedCredentials = Join-Path $GoogleDir 'application_default_credentials.json'
$HostAdc = if ($env:APPDATA) { Join-Path $env:APPDATA 'gcloud\application_default_credentials.json' } else { '' }
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$SourceIntegrations = Join-Path $RepoRoot 'integrations'
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Write-LfFile {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Content
    )

    $normalized = $Content -replace "`r`n", "`n" -replace "`r", "`n"
    [System.IO.File]::WriteAllText($Path, $normalized, $Utf8NoBom)
}

function Invoke-HermesScript {
    param(
        [Parameter(Mandatory = $true)][string]$ContainerPath,
        [Parameter(Mandatory = $true)][string]$FailureMessage
    )

    docker exec $Container /bin/sh $ContainerPath
    if ($LASTEXITCODE -ne 0) {
        throw $FailureMessage
    }
}

Write-Host 'Installing Thu Ha Authentic Hermes integration...'

if (-not (Test-Path $HermesData)) {
    throw "Hermes data directory not found: $HermesData"
}
if (-not (Test-Path $SourceIntegrations)) {
    throw "Repository integrations directory not found: $SourceIntegrations"
}

$running = docker inspect -f '{{.State.Running}}' $Container 2>$null
if ($running -ne 'true') {
    throw "Container is not running: $Container"
}

New-Item -ItemType Directory -Force -Path $DestinationRoot | Out-Null
New-Item -ItemType Directory -Force -Path $GoogleDir | Out-Null
if (Test-Path $DestinationIntegrations) {
    Remove-Item -Path $DestinationIntegrations -Recurse -Force
}
Copy-Item -LiteralPath $SourceIntegrations -Destination $DestinationRoot -Recurse -Force

# Reuse local gcloud ADC when it already exists. The file is copied into the
# Docker-mounted Hermes data directory; its contents are never printed.
if (-not (Test-Path $MountedCredentials) -and $HostAdc -and (Test-Path $HostAdc)) {
    Copy-Item -LiteralPath $HostAdc -Destination $MountedCredentials -Force
    Write-Host 'Google ADC copied into Hermes data volume.'
}

$bootstrapHostPath = Join-Path $DestinationRoot 'bootstrap_install.sh'
$bootstrapContainerPath = '/opt/data/tha-integrations/bootstrap_install.sh'
$bootstrapScript = @'
#!/bin/sh
set -eu
ROOT=/opt/data/tha-integrations
VENDOR="$ROOT/.vendor"
REQ="$ROOT/integrations/hermes/requirements.txt"
cd "$ROOT"
mkdir -p "$VENDOR"

if ! python -m pip --version >/dev/null 2>&1; then
  if python -m ensurepip --upgrade >/dev/null 2>&1; then
    :
  elif command -v apk >/dev/null 2>&1; then
    apk add --no-cache py3-pip
  elif command -v apt-get >/dev/null 2>&1; then
    apt-get update
    DEBIAN_FRONTEND=noninteractive apt-get install -y python3-pip
  else
    echo "ERROR: pip is unavailable and no supported package manager was found." >&2
    exit 20
  fi
fi

if ! python -m pip install --disable-pip-version-check --no-cache-dir --target "$VENDOR" -r "$REQ"; then
  python -m pip install --disable-pip-version-check --no-cache-dir --break-system-packages --target "$VENDOR" -r "$REQ"
fi

PYTHONPATH="$ROOT:$VENDOR" META_DEDUPE_DB=/tmp/tha-meta-dedupe.db \
python -m unittest discover -s integrations/hermes/tests -t . -p 'test_*.py'
'@
Write-LfFile -Path $bootstrapHostPath -Content $bootstrapScript
Invoke-HermesScript -ContainerPath $bootstrapContainerPath -FailureMessage 'Dependency bootstrap or unit tests failed.'

if (-not (Test-Path $MountedCredentials)) {
    Write-Host ''
    Write-Host 'WAITING_FOR_GOOGLE_CREDENTIALS'
    Write-Host "Expected credential file: $MountedCredentials"
    Write-Host 'Run integrations\hermes\setup_google_credentials.ps1, then rerun this installer.'
    throw 'Google Sheets credentials are not configured for the Hermes container.'
}

$dryRunHostPath = Join-Path $DestinationRoot 'telegram_dry_run.sh'
$dryRunContainerPath = '/opt/data/tha-integrations/telegram_dry_run.sh'
$dryRunScript = @'
#!/bin/sh
set -eu
ROOT=/opt/data/tha-integrations
CREDENTIALS=/opt/data/google/application_default_credentials.json
if [ -f /opt/data/.env ]; then
  set -a
  . /opt/data/.env
  set +a
fi
if [ ! -f "$CREDENTIALS" ]; then
  echo "ERROR: Google credentials file is missing: $CREDENTIALS" >&2
  exit 31
fi
export GOOGLE_APPLICATION_CREDENTIALS="$CREDENTIALS"
PYTHONPATH="$ROOT:$ROOT/.vendor" THA_TELEGRAM_DRY_RUN=true \
python -m integrations.hermes.telegram_dispatcher
'@
Write-LfFile -Path $dryRunHostPath -Content $dryRunScript
Invoke-HermesScript -ContainerPath $dryRunContainerPath -FailureMessage 'Telegram dry-run failed.'

Write-Host 'PASS: package installed, unit tests passed, Google Sheets dry-run executed.'
Write-Host 'Review TELEGRAM_QUEUE and RUN_LOG before enabling real delivery.'
