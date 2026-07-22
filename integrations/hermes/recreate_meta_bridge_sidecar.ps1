param(
    [string]$DataRoot = 'D:\HermesAgent\data',
    [string]$ContainerName = 'hermes-tha-meta',
    [string]$GatewayContainer = 'hermes-gateway',
    [string]$Image = 'nousresearch/hermes-agent:latest',
    [int]$HostPort = 8788,
    [string]$LocalHealthUrl = 'http://127.0.0.1:8788/health',
    [string]$HermesBin = '',
    [string]$PythonBin = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$envPath = Join-Path $DataRoot '.env'
$credentialPath = Join-Path $DataRoot 'google\application_default_credentials.json'
$bridgePath = Join-Path $DataRoot 'tha-integrations\integrations\hermes\meta_messenger_bridge.py'
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

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
    $path = @($result.Output | ForEach-Object { "$($_)".Trim() } | Where-Object { $_ }) | Select-Object -First 1
    if ($result.ExitCode -ne 0 -or [string]::IsNullOrWhiteSpace($path)) {
        throw "Could not resolve '$Command' inside container '$Container'."
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

foreach ($requiredPath in @($envPath, $credentialPath, $bridgePath)) {
    if (-not (Test-Path $requiredPath)) {
        throw "Required Meta sidecar file not found: $requiredPath"
    }
}
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    throw 'Docker command not found.'
}

docker info | Out-Null
if ($LASTEXITCODE -ne 0) {
    throw 'Docker daemon is unavailable. Start Docker Desktop first.'
}

if ([string]::IsNullOrWhiteSpace($HermesBin)) {
    $HermesBin = Resolve-ContainerCommandPath -Container $GatewayContainer -Command 'hermes'
}
if ([string]::IsNullOrWhiteSpace($PythonBin)) {
    $PythonBin = Resolve-ContainerCommandPath -Container $GatewayContainer -Command 'python'
}

Set-EnvValue -Path $envPath -Key 'HERMES_HOME' -Value '/opt/data'
Set-EnvValue -Path $envPath -Key 'THA_HERMES_BIN' -Value $HermesBin
Set-EnvValue -Path $envPath -Key 'THA_PYTHON_BIN' -Value $PythonBin

$existing = docker ps -a --filter "name=^/$ContainerName$" --format '{{.Names}}'
if ($existing -eq $ContainerName) {
    docker rm -f $ContainerName | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "Could not replace existing Meta sidecar: $ContainerName"
    }
}

$volumeArg = "${DataRoot}:/opt/data"
$portArg = "127.0.0.1:${HostPort}:8788"
$containerCommand = @'
set -eu
export HERMES_HOME="${HERMES_HOME:-/opt/data}"
export HOME="${HOME:-/opt/data/home}"
export GOOGLE_APPLICATION_CREDENTIALS=/opt/data/google/application_default_credentials.json
export PYTHONPATH=/opt/data/tha-integrations:/opt/data/tha-integrations/.vendor
test -x "$THA_HERMES_BIN"
test -x "$THA_PYTHON_BIN"
exec "$THA_PYTHON_BIN" -m uvicorn integrations.hermes.meta_messenger_bridge:app --host 0.0.0.0 --port 8788
'@ -replace "`r`n", "`n"

$containerId = docker run -d `
    --name $ContainerName `
    --restart unless-stopped `
    --user '10000:10000' `
    --entrypoint /bin/sh `
    -p $portArg `
    --env-file $envPath `
    -e 'HERMES_HOME=/opt/data' `
    -e 'HOME=/opt/data/home' `
    -e "THA_HERMES_BIN=$HermesBin" `
    -e "THA_PYTHON_BIN=$PythonBin" `
    -v $volumeArg `
    $Image `
    -c $containerCommand

if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($containerId)) {
    throw 'Failed to recreate dedicated Meta bridge sidecar.'
}

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
    Write-Host '--- META SIDECAR LOG TAIL ---'
    docker logs --tail 80 $ContainerName
    throw 'Dedicated Meta sidecar health check failed.'
}

$entrypoint = docker inspect $ContainerName --format '{{json .Config.Entrypoint}}'
$command = docker inspect $ContainerName --format '{{json .Config.Cmd}}'
if ($entrypoint -notmatch '/bin/sh') {
    throw "Unexpected Meta sidecar entrypoint: $entrypoint"
}

Write-Host 'PASS: Dedicated Meta bridge sidecar recreated'
Write-Host "META_CONTAINER=$ContainerName"
Write-Host 'META_SIDECAR_ONLY=TRUE'
Write-Host "META_ENTRYPOINT=$entrypoint"
Write-Host "META_COMMAND=$command"
Write-Host "LOCAL_HEALTH_STATUS=$($health.status)"
Write-Host "MODE=$($health.mode)"
Write-Host 'DUPLICATE_HERMES_GATEWAY=DISABLED'
Write-Host 'DUPLICATE_TELEGRAM_POLLING=DISABLED'
Write-Host "HERMES_BIN=$HermesBin"
Write-Host "PYTHON_BIN=$PythonBin"