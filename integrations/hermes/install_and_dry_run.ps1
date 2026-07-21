Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$Container = 'hermes-gateway'
$HermesData = 'D:\HermesAgent\data'
$DestinationRoot = Join-Path $HermesData 'tha-integrations'
$DestinationIntegrations = Join-Path $DestinationRoot 'integrations'
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$SourceIntegrations = Join-Path $RepoRoot 'integrations'

function Invoke-HermesShell {
    param(
        [Parameter(Mandatory = $true)][string]$Command,
        [Parameter(Mandatory = $true)][string]$FailureMessage
    )

    # PowerShell here-strings use CRLF on Windows. BusyBox/Debian sh may treat
    # the carriage return as part of a command, so normalize before docker exec.
    $normalized = $Command -replace "`r", ''
    docker exec $Container /bin/sh -lc $normalized
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
if (Test-Path $DestinationIntegrations) {
    Remove-Item -Path $DestinationIntegrations -Recurse -Force
}
# Copy the complete Python package, including integrations/__init__.py.
Copy-Item -LiteralPath $SourceIntegrations -Destination $DestinationRoot -Recurse -Force

$installCommand = @'
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

Invoke-HermesShell -Command $installCommand -FailureMessage 'Dependency bootstrap or unit tests failed.'

$dryRunCommand = @'
set -eu
ROOT=/opt/data/tha-integrations
if [ -f /opt/data/.env ]; then
  set -a
  . /opt/data/.env
  set +a
fi
PYTHONPATH="$ROOT:$ROOT/.vendor" THA_TELEGRAM_DRY_RUN=true \
python -m integrations.hermes.telegram_dispatcher
'@

Invoke-HermesShell -Command $dryRunCommand -FailureMessage 'Telegram dry-run failed.'

Write-Host 'PASS: package installed, unit tests passed, Telegram dry-run executed.'
Write-Host 'Review TELEGRAM_QUEUE and RUN_LOG before enabling real delivery.'
