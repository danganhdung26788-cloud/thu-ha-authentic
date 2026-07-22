param(
    [string]$ContainerName = "hermes-gateway",
    [string]$DataRoot = "D:\HermesAgent\data"
)

$ErrorActionPreference = "Stop"
$logDirectory = Join-Path $DataRoot "tha-fanpage-draft"
$logPath = Join-Path $logDirectory "host-draft-processor.log"
$mutex = $null
$hasLock = $false

function Write-HostLog {
    param([string]$Message)
    $timestamp = Get-Date -Format "yyyy-MM-ddTHH:mm:ssK"
    $line = "[$timestamp] $Message"
    Add-Content -Path $logPath -Value $line -Encoding UTF8
    Write-Host $line
}

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

    return [pscustomobject]@{
        Output = $output
        ExitCode = $exitCode
    }
}

try {
    New-Item -ItemType Directory -Force -Path $logDirectory | Out-Null

    if (Test-Path $logPath) {
        $logFile = Get-Item $logPath
        if ($logFile.Length -gt 5MB) {
            $archivePath = Join-Path $logDirectory "host-draft-processor.previous.log"
            if (Test-Path $archivePath) {
                Remove-Item $archivePath -Force
            }
            Move-Item $logPath $archivePath -Force
        }
    }

    $mutex = New-Object System.Threading.Mutex($false, "Global\HermesThuHaFanpageDraftProcessor")
    $hasLock = $mutex.WaitOne(0, $false)
    if (-not $hasLock) {
        Write-HostLog "SKIP another Hermes conversation runtime instance is still running"
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
set -eu
if [ -f /opt/data/.env ]; then
  set -a
  . /opt/data/.env
  set +a
fi
export HERMES_HOME="${HERMES_HOME:-/opt/data}"
export GOOGLE_APPLICATION_CREDENTIALS=/opt/data/google/application_default_credentials.json
export PYTHONPATH=/opt/data/tha-integrations:/opt/data/tha-integrations/.vendor
export THA_AI_FIRST_DRY_RUN=false
python -m integrations.hermes.conversation_runtime_processor
python -m integrations.hermes.meta_outbound_sender
'@ -replace "`r`n", "`n"

    Write-HostLog "START container=$ContainerName processor=HERMES_CONVERSATION_RUNTIME"
    $result = Invoke-NativeCapture -FilePath 'docker' -Arguments @(
        'exec', $ContainerName, '/bin/sh', '-c', $shellCommand
    )

    foreach ($line in $result.Output) {
        if ($null -ne $line -and "$line".Trim()) {
            Write-HostLog ("RUNTIME " + "$line")
        }
    }

    if ($result.ExitCode -ne 0) {
        throw "Hermes conversation runtime pipeline exited with code $($result.ExitCode)"
    }

    Write-HostLog "PASS Hermes conversation runtime pipeline completed"
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
