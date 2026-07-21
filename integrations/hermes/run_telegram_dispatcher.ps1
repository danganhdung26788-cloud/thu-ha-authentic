param(
    [string]$ContainerName = "hermes-gateway",
    [string]$DataRoot = "D:\HermesAgent\data"
)

$ErrorActionPreference = "Stop"
$logDirectory = Join-Path $DataRoot "tha-telegram"
$logPath = Join-Path $logDirectory "host-dispatcher.log"
$mutex = $null
$hasLock = $false

function Write-HostLog {
    param([string]$Message)
    $timestamp = Get-Date -Format "yyyy-MM-ddTHH:mm:ssK"
    $line = "[$timestamp] $Message"
    Add-Content -Path $logPath -Value $line -Encoding UTF8
    Write-Host $line
}

try {
    New-Item -ItemType Directory -Force -Path $logDirectory | Out-Null

    if (Test-Path $logPath) {
        $logFile = Get-Item $logPath
        if ($logFile.Length -gt 5MB) {
            $archivePath = Join-Path $logDirectory "host-dispatcher.previous.log"
            if (Test-Path $archivePath) {
                Remove-Item $archivePath -Force
            }
            Move-Item $logPath $archivePath -Force
        }
    }

    $mutex = New-Object System.Threading.Mutex($false, "Global\HermesThuHaTelegramDispatcher")
    $hasLock = $mutex.WaitOne(0, $false)
    if (-not $hasLock) {
        Write-HostLog "SKIP another dispatcher instance is still running"
        exit 0
    }

    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
        throw "Docker CLI was not found in PATH"
    }

    $running = (& docker inspect -f '{{.State.Running}}' $ContainerName 2>$null)
    if ($LASTEXITCODE -ne 0 -or ($running | Out-String).Trim().ToLowerInvariant() -ne "true") {
        throw "Container '$ContainerName' is not running"
    }

    $shellCommand = @'
set -a
. /opt/data/.env
set +a
export GOOGLE_APPLICATION_CREDENTIALS=/opt/data/google/application_default_credentials.json
export PYTHONPATH=/opt/data/tha-integrations:/opt/data/tha-integrations/.vendor
export THA_TELEGRAM_DRY_RUN=false
python -m integrations.hermes.telegram_dispatcher
'@ -replace "`r`n", "`n"

    Write-HostLog "START container=$ContainerName"
    $output = & docker exec $ContainerName /bin/sh -c $shellCommand 2>&1
    $exitCode = $LASTEXITCODE

    foreach ($line in $output) {
        if ($null -ne $line -and "$line".Trim()) {
            Write-HostLog ("RUNTIME " + "$line")
        }
    }

    if ($exitCode -ne 0) {
        throw "Telegram dispatcher exited with code $exitCode"
    }

    Write-HostLog "PASS Telegram dispatcher completed"
    exit 0
}
catch {
    try {
        New-Item -ItemType Directory -Force -Path $logDirectory | Out-Null
        Write-HostLog ("FAIL " + $_.Exception.Message)
    }
    catch {
        Write-Error $_.Exception.Message
    }
    exit 1
}
finally {
    if ($hasLock -and $null -ne $mutex) {
        $mutex.ReleaseMutex() | Out-Null
    }
    if ($null -ne $mutex) {
        $mutex.Dispose()
    }
}
