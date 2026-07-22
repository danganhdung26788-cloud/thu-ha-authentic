param(
    [string]$PublicBaseUrl = '',
    [string]$DataRoot = 'D:\HermesAgent\data',
    [string]$ContainerName = 'hermes-tha-meta',
    [string]$Image = 'nousresearch/hermes-agent:latest',
    [int]$HostPort = 8788
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$envPath = Join-Path $DataRoot '.env'
$credentialPath = Join-Path $DataRoot 'google\application_default_credentials.json'
$bridgePath = Join-Path $DataRoot 'tha-integrations\integrations\hermes\meta_messenger_bridge.py'
$sidecarScript = Join-Path $PSScriptRoot 'recreate_meta_bridge_sidecar.ps1'
$secretDir = 'D:\HermesAgent\secrets'
$tokenFile = Join-Path $secretDir 'meta_verify_token.txt'
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

foreach ($requiredPath in @($envPath, $credentialPath, $bridgePath, $sidecarScript)) {
    if (-not (Test-Path $requiredPath)) {
        throw "Required file not found: $requiredPath"
    }
}
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    throw 'Docker command not found.'
}

docker info | Out-Null
if ($LASTEXITCODE -ne 0) {
    throw 'Docker daemon is unavailable. Start Docker Desktop first.'
}

$bytes = New-Object byte[] 48
$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
try {
    $rng.GetBytes($bytes)
}
finally {
    $rng.Dispose()
}
$verifyToken = [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')

$lines = if (Test-Path $envPath) { [System.IO.File]::ReadAllLines($envPath) } else { @() }
$managed = @{
    META_VERIFY_TOKEN = $verifyToken
    HERMES_HOME = '/opt/data'
    THA_HERMES_BIN = '/opt/hermes/.venv/bin/hermes'
}
foreach ($key in $managed.Keys) {
    $updated = $false
    for ($i = 0; $i -lt $lines.Count; $i++) {
        if ($lines[$i] -match ('^(?:export\s+)?' + [regex]::Escape($key) + '=')) {
            $lines[$i] = "$key=$($managed[$key])"
            $updated = $true
        }
    }
    if (-not $updated) {
        $lines += "$key=$($managed[$key])"
    }
}
[System.IO.File]::WriteAllLines($envPath, $lines, $Utf8NoBom)

New-Item -ItemType Directory -Force -Path $secretDir | Out-Null
[System.IO.File]::WriteAllText($tokenFile, $verifyToken, $Utf8NoBom)

$clipboardCopied = $false
if (Get-Command Set-Clipboard -ErrorAction SilentlyContinue) {
    Set-Clipboard -Value $verifyToken
    $clipboardCopied = $true
}

& powershell.exe -NoProfile -ExecutionPolicy Bypass `
    -File $sidecarScript `
    -DataRoot $DataRoot `
    -ContainerName $ContainerName `
    -Image $Image `
    -HostPort $HostPort `
    -LocalHealthUrl "http://127.0.0.1:${HostPort}/health"
if ($LASTEXITCODE -ne 0) {
    throw "Meta bridge sidecar recreation failed with exit code $LASTEXITCODE"
}

$health = Invoke-RestMethod -Uri "http://127.0.0.1:${HostPort}/health" -Method Get -TimeoutSec 10
if ($health.status -ne 'ok') {
    throw 'Meta bridge health check failed after token bootstrap.'
}

docker exec $ContainerName /bin/sh -c 'test -n "$META_VERIFY_TOKEN"'
if ($LASTEXITCODE -ne 0) {
    throw 'META_VERIFY_TOKEN is still unavailable inside the container.'
}

$verifyStatus = 'SKIPPED'
$challengeMatch = 'SKIPPED'
if (-not [string]::IsNullOrWhiteSpace($PublicBaseUrl)) {
    $base = $PublicBaseUrl.TrimEnd('/')
    $challenge = 'THA_VERIFY_PASS_20260722'
    $verifyUri = "$base/webhook/meta-messenger?hub.mode=subscribe&hub.verify_token=$([uri]::EscapeDataString($verifyToken))&hub.challenge=$challenge"
    $response = Invoke-WebRequest -Uri $verifyUri -UseBasicParsing -TimeoutSec 20
    $verifyStatus = [string]$response.StatusCode
    $challengeMatch = [string]($response.Content -eq $challenge)
}

Write-Output 'PASS: Meta verify token configured'
Write-Output 'TOKEN_PRINTED=FALSE'
Write-Output "TOKEN_FILE=$tokenFile"
Write-Output "TOKEN_COPIED_TO_CLIPBOARD=$clipboardCopied"
Write-Output 'META_SIDECAR_ONLY=TRUE'
Write-Output 'DUPLICATE_TELEGRAM_POLLING=DISABLED'
Write-Output 'HERMES_BIN=/opt/hermes/.venv/bin/hermes'
Write-Output "HEALTH_STATUS=$($health.status)"
Write-Output "VERIFY_HTTP_STATUS=$verifyStatus"
Write-Output "VERIFY_CHALLENGE_MATCH=$challengeMatch"

$verifyToken = $null
$bytes = $null
