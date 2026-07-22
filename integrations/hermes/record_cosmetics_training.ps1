param(
    [Parameter(Mandatory = $true)][string]$MessageId,
    [Parameter(Mandatory = $true)][ValidateSet('NONG_THU_HA', 'DANG_ANH_DUNG')][string]$Trainer,
    [Parameter(Mandatory = $true)][string]$Reason,
    [Parameter(Mandatory = $true)][string]$CorrectedReply,
    [string]$ContainerName = 'hermes-gateway',
    [string]$DataRoot = 'D:\HermesAgent\data'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$InputRoot = Join-Path $DataRoot 'training\thu-ha-cosmetics\input'
New-Item -ItemType Directory -Force -Path $InputRoot | Out-Null

$InputName = 'correction-' + [Guid]::NewGuid().ToString('N') + '.txt'
$HostInputPath = Join-Path $InputRoot $InputName
$ContainerInputPath = '/opt/data/training/thu-ha-cosmetics/input/' + $InputName
[System.IO.File]::WriteAllText($HostInputPath, $CorrectedReply.Trim(), $Utf8NoBom)

try {
    $running = docker inspect -f '{{.State.Running}}' $ContainerName 2>$null
    if ($LASTEXITCODE -ne 0 -or ($running | Out-String).Trim().ToLowerInvariant() -ne 'true') {
        throw "Container is not running: $ContainerName"
    }

    $shellCommand = @'
set -eu
if [ -f /opt/data/.env ]; then
  set -a
  . /opt/data/.env
  set +a
fi
export GOOGLE_APPLICATION_CREDENTIALS=/opt/data/google/application_default_credentials.json
export PYTHONPATH=/opt/data/tha-integrations:/opt/data/tha-integrations/.vendor
python -m integrations.hermes.cosmetics_training_store \
  --message-id "$THA_TRAIN_MESSAGE_ID" \
  --corrected-reply-file "$THA_TRAIN_REPLY_FILE" \
  --reason "$THA_TRAIN_REASON" \
  --trainer "$THA_TRAINER"
'@ -replace "`r`n", "`n"

    $output = docker exec `
        -e "THA_TRAIN_MESSAGE_ID=$MessageId" `
        -e "THA_TRAIN_REPLY_FILE=$ContainerInputPath" `
        -e "THA_TRAIN_REASON=$Reason" `
        -e "THA_TRAINER=$Trainer" `
        $ContainerName /bin/sh -c $shellCommand 2>&1
    $exitCode = $LASTEXITCODE
    $output | ForEach-Object { Write-Host $_ }
    if ($exitCode -ne 0) {
        throw "Training correction runner failed with exit code $exitCode"
    }
}
finally {
    if (Test-Path $HostInputPath) {
        Remove-Item $HostInputPath -Force
    }
}
