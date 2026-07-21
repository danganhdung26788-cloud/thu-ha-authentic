param(
    [string]$PublicBaseUrl = "https://adventures-yourself-close-prison.trycloudflare.com",
    [string]$DataRoot = "D:\HermesAgent\data",
    [string]$ContainerName = "hermes-tha-meta",
    [string]$Image = "nousresearch/hermes-agent:latest",
    [int]$HostPort = 8788
)

$ErrorActionPreference = "Stop"

$envPath = Join-Path $DataRoot ".env"
$credentialPath = Join-Path $DataRoot "google\application_default_credentials.json"
$bridgePath = Join-Path $DataRoot "tha-integrations\integrations\hermes\meta_messenger_bridge.py"
$secretDir = "D:\HermesAgent\secrets"
$tokenFile = Join-Path $secretDir "meta_verify_token.txt"

foreach ($requiredPath in @($envPath, $credentialPath, $bridgePath)) {
    if (-not (Test-Path $requiredPath)) {
        throw "Required file not found: $requiredPath"
    }
}

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    throw "Docker command not found."
}

docker info | Out-Null
if ($LASTEXITCODE -ne 0) {
    throw "Docker daemon is unavailable. Start Docker Desktop first."
}

$bytes = New-Object byte[] 48
$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
try {
    $rng.GetBytes($bytes)
} finally {
    $rng.Dispose()
}
$verifyToken = [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')

$lines = @()
if (Test-Path $envPath) {
    $lines = [System.IO.File]::ReadAllLines($envPath)
}

$updated = $false
for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -match '^META_VERIFY_TOKEN=') {
        $lines[$i] = "META_VERIFY_TOKEN=$verifyToken"
        $updated = $true
    }
}
if (-not $updated) {
    $lines += "META_VERIFY_TOKEN=$verifyToken"
}

$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllLines($envPath, $lines, $utf8NoBom)

New-Item -ItemType Directory -Force -Path $secretDir | Out-Null
[System.IO.File]::WriteAllText($tokenFile, $verifyToken, $utf8NoBom)

$clipboardCopied = $false
if (Get-Command Set-Clipboard -ErrorAction SilentlyContinue) {
    Set-Clipboard -Value $verifyToken
    $clipboardCopied = $true
}

$existing = docker ps -a --filter "name=^/$ContainerName$" --format "{{.Names}}"
if ($existing -eq $ContainerName) {
    docker rm -f $ContainerName | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "Could not replace existing container: $ContainerName"
    }
}

$volumeArg = "${DataRoot}:/opt/data"
$portArg = "127.0.0.1:${HostPort}:8788"
$containerCommand = 'export GOOGLE_APPLICATION_CREDENTIALS=/opt/data/google/application_default_credentials.json; export PYTHONPATH=/opt/data/tha-integrations:/opt/data/tha-integrations/.vendor; exec python -m uvicorn integrations.hermes.meta_messenger_bridge:app --host 0.0.0.0 --port 8788'

$containerId = docker run -d `
    --name $ContainerName `
    --restart unless-stopped `
    -p $portArg `
    --env-file $envPath `
    -v $volumeArg `
    $Image `
    /bin/sh -lc $containerCommand

if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($containerId)) {
    throw "Failed to recreate Meta bridge container."
}

$health = $null
for ($attempt = 1; $attempt -le 20; $attempt++) {
    Start-Sleep -Seconds 2
    try {
        $health = Invoke-RestMethod -Uri "http://127.0.0.1:${HostPort}/health" -Method Get -TimeoutSec 5
        if ($health.status -eq "ok") {
            break
        }
    } catch {
        $health = $null
    }
}
if (-not $health -or $health.status -ne "ok") {
    docker logs --tail 30 $ContainerName
    throw "Meta bridge health check failed after token bootstrap."
}

docker exec $ContainerName /bin/sh -lc 'test -n "$META_VERIFY_TOKEN"'
if ($LASTEXITCODE -ne 0) {
    throw "META_VERIFY_TOKEN is still unavailable inside the container."
}

$verifyStatus = "SKIPPED"
$challengeMatch = "SKIPPED"
if (-not [string]::IsNullOrWhiteSpace($PublicBaseUrl)) {
    $base = $PublicBaseUrl.TrimEnd('/')
    $challenge = "THA_VERIFY_PASS_20260722"
    $verifyUri = "$base/webhook/meta-messenger?hub.mode=subscribe&hub.verify_token=$([uri]::EscapeDataString($verifyToken))&hub.challenge=$challenge"
    $response = Invoke-WebRequest -Uri $verifyUri -UseBasicParsing -TimeoutSec 20
    $verifyStatus = [string]$response.StatusCode
    $challengeMatch = [string]($response.Content -eq $challenge)
}

Write-Output "PASS: Meta verify token configured"
Write-Output "TOKEN_PRINTED=FALSE"
Write-Output "TOKEN_FILE=$tokenFile"
Write-Output "TOKEN_COPIED_TO_CLIPBOARD=$clipboardCopied"
Write-Output "CONTAINER_RESTARTED=TRUE"
Write-Output "HEALTH_STATUS=$($health.status)"
Write-Output "VERIFY_HTTP_STATUS=$verifyStatus"
Write-Output "VERIFY_CHALLENGE_MATCH=$challengeMatch"

$verifyToken = $null
$bytes = $null
