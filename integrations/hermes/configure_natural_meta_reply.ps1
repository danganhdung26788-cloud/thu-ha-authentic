param(
    [ValidateSet('Enable', 'Disable')][string]$Action = 'Enable',
    [string]$ContainerName = 'hermes-gateway',
    [string]$EnvPath = 'D:\HermesAgent\data\.env',
    [string]$PageId = '108621404211232',
    [string]$GraphVersion = 'v25.0',
    [switch]$UseExistingToken
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Set-EnvValue {
    param(
        [string[]]$Lines,
        [string]$Key,
        [string]$Value
    )
    $filtered = @($Lines | Where-Object { $_ -notmatch ('^' + [regex]::Escape($Key) + '=') })
    $filtered += "$Key=$Value"
    return ,$filtered
}

function Get-EnvValue {
    param(
        [string[]]$Lines,
        [string]$Key
    )
    $prefix = "$Key="
    $line = @($Lines | Where-Object { $_.StartsWith($prefix, [System.StringComparison]::Ordinal) } | Select-Object -Last 1)
    if ($line.Count -eq 0) {
        return ''
    }
    return $line[0].Substring($prefix.Length)
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

if (-not (Test-Path $EnvPath)) {
    throw "Environment file not found: $EnvPath"
}

$running = docker inspect -f '{{.State.Running}}' $ContainerName 2>$null
if ($LASTEXITCODE -ne 0 -or ($running | Out-String).Trim().ToLowerInvariant() -ne 'true') {
    throw "Container is not running: $ContainerName"
}

$backupPath = "$EnvPath.meta-reply-backup-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
Copy-Item $EnvPath $backupPath -Force
$lines = @(Get-Content -Path $EnvPath)

if ($Action -eq 'Disable') {
    $lines = Set-EnvValue -Lines $lines -Key 'THA_REPLY_MODE' -Value 'DRAFT_ONLY'
    $lines = Set-EnvValue -Lines $lines -Key 'THA_META_AUTO_SEND' -Value 'false'
    [System.IO.File]::WriteAllLines($EnvPath, [string[]]$lines, $Utf8NoBom)
    Write-Host 'PASS: Natural Meta reply disabled'
    Write-Host 'THA_REPLY_MODE=DRAFT_ONLY'
    Write-Host 'THA_META_AUTO_SEND=false'
    exit 0
}

$secureToken = $null
$bstr = [IntPtr]::Zero
$plainToken = $null
try {
    if ($UseExistingToken) {
        $plainToken = Get-EnvValue -Lines $lines -Key 'META_PAGE_ACCESS_TOKEN'
        if ([string]::IsNullOrWhiteSpace($plainToken)) {
            throw 'META_PAGE_ACCESS_TOKEN_NOT_FOUND_IN_ENV'
        }
        Write-Host 'META_PAGE_ACCESS_TOKEN=USING_EXISTING_LOCAL_VALUE'
    }
    else {
        $secureToken = Read-Host 'Dan Page Access Token cua Fanpage Thu Ha Authentic roi nhan Enter' -AsSecureString
        $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureToken)
        $plainToken = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
    }

    if ([string]::IsNullOrWhiteSpace($plainToken)) {
        throw 'META_PAGE_ACCESS_TOKEN_EMPTY'
    }

    $activationTime = [DateTime]::UtcNow.ToString('o')
    $lines = Set-EnvValue -Lines $lines -Key 'META_PAGE_ACCESS_TOKEN' -Value $plainToken.Trim()
    $lines = Set-EnvValue -Lines $lines -Key 'THA_META_PAGE_ID' -Value $PageId
    $lines = Set-EnvValue -Lines $lines -Key 'META_GRAPH_API_VERSION' -Value $GraphVersion
    $lines = Set-EnvValue -Lines $lines -Key 'THA_REPLY_MODE' -Value 'NATURAL_AUTO_REPLY'
    $lines = Set-EnvValue -Lines $lines -Key 'THA_META_AUTO_SEND' -Value 'true'
    $lines = Set-EnvValue -Lines $lines -Key 'THA_META_AUTO_SEND_SINCE' -Value $activationTime
    [System.IO.File]::WriteAllLines($EnvPath, [string[]]$lines, $Utf8NoBom)

    $verifyCommand = @'
set -eu
set -a
. /opt/data/.env
set +a
export PYTHONPATH=/opt/data/tha-integrations:/opt/data/tha-integrations/.vendor
python -m integrations.hermes.meta_outbound_sender --verify-token
'@ -replace "`r`n", "`n"

    $result = Invoke-NativeCapture -FilePath 'docker' -Arguments @(
        'exec', $ContainerName, '/bin/sh', '-c', $verifyCommand
    )
    $result.Output | ForEach-Object { Write-Host $_ }
    if ($result.ExitCode -ne 0) {
        Copy-Item $backupPath $EnvPath -Force
        throw 'Page Access Token verification failed. Previous .env was restored.'
    }

    Write-Host 'PASS: Natural Meta reply enabled'
    Write-Host 'THA_REPLY_MODE=NATURAL_AUTO_REPLY'
    Write-Host 'THA_META_AUTO_SEND=true'
    Write-Host "THA_META_AUTO_SEND_SINCE=$activationTime"
    Write-Host 'OLD_DRAFTS_WILL_NOT_BE_SENT=TRUE'
}
finally {
    if ($bstr -ne [IntPtr]::Zero) {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
    }
    $plainToken = $null
    $secureToken = $null
}
