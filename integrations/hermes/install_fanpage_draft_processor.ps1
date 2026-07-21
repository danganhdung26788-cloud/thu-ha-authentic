Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$Container = 'hermes-gateway'
$HermesData = 'D:\HermesAgent\data'
$DestinationRoot = Join-Path $HermesData 'tha-integrations'
$DestinationIntegrations = Join-Path $DestinationRoot 'integrations'
$MountedCredentials = Join-Path $HermesData 'google\application_default_credentials.json'
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

if (-not (Test-Path $SourceIntegrations)) {
    throw "Repository integrations directory not found: $SourceIntegrations"
}
if (-not (Test-Path $MountedCredentials)) {
    throw "Google credential file not found: $MountedCredentials"
}

$running = docker inspect -f '{{.State.Running}}' $Container 2>$null
if ($running -ne 'true') {
    throw "Container is not running: $Container"
}

New-Item -ItemType Directory -Force -Path $DestinationRoot | Out-Null
if (Test-Path $DestinationIntegrations) {
    Remove-Item -Path $DestinationIntegrations -Recurse -Force
}
Copy-Item -LiteralPath $SourceIntegrations -Destination $DestinationRoot -Recurse -Force

$verifyHostPath = Join-Path $DestinationRoot 'fanpage_draft_verify.sh'
$verifyContainerPath = '/opt/data/tha-integrations/fanpage_draft_verify.sh'
$verifyScript = @'
#!/bin/sh
set -eu
ROOT=/opt/data/tha-integrations
CREDENTIALS=/opt/data/google/application_default_credentials.json
export GOOGLE_APPLICATION_CREDENTIALS="$CREDENTIALS"
export PYTHONPATH="$ROOT:$ROOT/.vendor"
cd "$ROOT"
python -m unittest integrations.hermes.tests.test_fanpage_draft_processor
THA_FANPAGE_DRAFT_DRY_RUN=true python -m integrations.hermes.fanpage_draft_processor
'@
Write-LfFile -Path $verifyHostPath -Content $verifyScript

docker exec $Container /bin/sh $verifyContainerPath
if ($LASTEXITCODE -ne 0) {
    throw 'Fanpage draft processor tests or dry-run failed.'
}

Write-Host 'PASS: Fanpage draft processor installed'
Write-Host 'MODE=DRAFT_ONLY'
Write-Host 'AUTO_SEND=FALSE'
Write-Host 'NEXT=run_fanpage_draft_processor.ps1'
