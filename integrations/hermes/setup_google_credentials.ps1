param(
    [string]$CredentialJson = '',
    [string]$OAuthClientJson = '',
    [string]$Account = 'danganhdung26788@gmail.com'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$HermesData = 'D:\HermesAgent\data'
$GoogleDir = Join-Path $HermesData 'google'
$Destination = Join-Path $GoogleDir 'application_default_credentials.json'
$HostAdc = if ($env:APPDATA) { Join-Path $env:APPDATA 'gcloud\application_default_credentials.json' } else { '' }

function Copy-CredentialFile {
    param([Parameter(Mandatory = $true)][string]$Source)

    if (-not (Test-Path $Source)) {
        throw "Credential file not found: $Source"
    }

    $json = Get-Content -LiteralPath $Source -Raw | ConvertFrom-Json
    $type = [string]$json.type
    if ($type -notin @('service_account', 'authorized_user')) {
        throw "Unsupported credential JSON type: $type"
    }

    New-Item -ItemType Directory -Force -Path $GoogleDir | Out-Null
    Copy-Item -LiteralPath $Source -Destination $Destination -Force

    if ($type -eq 'service_account') {
        Write-Host "SERVICE_ACCOUNT_EMAIL=$($json.client_email)"
        Write-Host 'Share HERMES_FAST_INDEX and HERMES_CONTROL_DB with that email as Editor.'
    }

    Write-Host "PASS: Google credential copied to $Destination"
    Write-Host 'The credential contents were not printed.'
}

if ($CredentialJson) {
    Copy-CredentialFile -Source (Resolve-Path $CredentialJson).Path
    exit 0
}

if ($OAuthClientJson) {
    $gcloud = Get-Command gcloud -ErrorAction SilentlyContinue
    if (-not $gcloud) {
        throw 'Google Cloud CLI is not installed. Install it first, then rerun this script.'
    }
    if (-not (Test-Path $OAuthClientJson)) {
        throw "OAuth client JSON not found: $OAuthClientJson"
    }

    $scopes = @(
        'openid',
        'https://www.googleapis.com/auth/userinfo.email',
        'https://www.googleapis.com/auth/spreadsheets'
    ) -join ','

    & gcloud auth application-default login $Account `
        --client-id-file=$OAuthClientJson `
        --scopes=$scopes `
        --disable-quota-project
    if ($LASTEXITCODE -ne 0) {
        throw 'gcloud application-default login failed.'
    }

    if (-not $HostAdc -or -not (Test-Path $HostAdc)) {
        throw 'gcloud completed but the local ADC file was not found.'
    }
    Copy-CredentialFile -Source $HostAdc
    exit 0
}

if ($HostAdc -and (Test-Path $HostAdc)) {
    Copy-CredentialFile -Source $HostAdc
    exit 0
}

Write-Host 'WAITING_FOR_GOOGLE_CREDENTIALS'
Write-Host ''
Write-Host 'Choose one local-only method; do not upload credential JSON into chat:'
Write-Host '1. Service account or existing authorized-user JSON:'
Write-Host '   .\integrations\hermes\setup_google_credentials.ps1 -CredentialJson C:\secure\google-credentials.json'
Write-Host '2. OAuth desktop client JSON plus Google Cloud CLI:'
Write-Host '   .\integrations\hermes\setup_google_credentials.ps1 -OAuthClientJson C:\secure\oauth-client.json'
exit 30
