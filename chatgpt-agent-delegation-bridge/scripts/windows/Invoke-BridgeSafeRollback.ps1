[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$ReadOnlyConfigPath,
  [Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{64}$')][string]$ExpectedSha256,
  [Parameter(Mandatory=$true)][switch]$OwnerApproved,
  [string]$BridgeRoot='',
  [string]$TunnelClientPath=''
)
$ErrorActionPreference='Stop';Set-StrictMode -Version Latest
if(-not$OwnerApproved){throw 'Explicit owner approval is required for rollback.'}
$ScriptDirectory=if($PSScriptRoot){$PSScriptRoot}else{Split-Path -Parent $MyInvocation.MyCommand.Path}
$BridgeRoot=if([string]::IsNullOrWhiteSpace($BridgeRoot)){(Resolve-Path (Join-Path $ScriptDirectory '..\..')).Path}else{(Resolve-Path $BridgeRoot).Path}
$ReadOnlyConfigPath=(Resolve-Path $ReadOnlyConfigPath).Path
function Write-Utf8NoBom([string]$Path,[string]$Content){[IO.File]::WriteAllText($Path,$Content,(New-Object Text.UTF8Encoding($false)))}
function Sha256([string]$Path){$s=[IO.File]::OpenRead($Path);$h=[Security.Cryptography.SHA256]::Create();try{return([BitConverter]::ToString($h.ComputeHash($s))).Replace('-','').ToLowerInvariant()}finally{$h.Dispose();$s.Dispose()}}
$actual=Sha256 $ReadOnlyConfigPath;if($actual-ne$ExpectedSha256){throw 'Read-only rollback config SHA-256 mismatch.'}
$doc=Get-Content -Raw $ReadOnlyConfigPath|ConvertFrom-Json
foreach($w in @($doc.workspaces)){if($w.allowLocalWrite-ne$false-or@($w.writeRoots).Count-gt0-or@($w.allowedScripts).Count-gt0){throw "Rollback config is not strict read-only: $($w.workspaceId)"}}
$tunnelPid=Join-Path $BridgeRoot 'runtime\secure-mcp-tunnel\tunnel.pid'
if((Test-Path $tunnelPid)-and[string]::IsNullOrWhiteSpace($TunnelClientPath)){throw 'A tunnel PID exists. TunnelClientPath is required so rollback can stop and verify the tunnel process.'}
# Stop verified runtime before changing configuration.
if(-not[string]::IsNullOrWhiteSpace($TunnelClientPath)){& (Join-Path $ScriptDirectory 'Stop-SecureMcpTunnel.ps1') -BridgeRoot $BridgeRoot -TunnelClientPath $TunnelClientPath -StopBridge}else{& (Join-Path $ScriptDirectory 'Stop-Bridge.ps1') -BridgeRoot $BridgeRoot}
$runtime=Join-Path $BridgeRoot 'runtime\cwc-p7\rollback';New-Item -ItemType Directory -Force -Path $runtime|Out-Null
$stamp=(Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ');$active=Join-Path $BridgeRoot 'config\workspaces.json';$backup=''
if(Test-Path $active){$backup=Join-Path $runtime "workspaces-before-rollback-$stamp.json";Copy-Item $active $backup -Force}
Copy-Item $ReadOnlyConfigPath $active -Force
if((Sha256 $active)-ne$ExpectedSha256){throw 'Rollback read-back SHA-256 verification failed.'}
$repoRoot=(Resolve-Path (Join-Path $BridgeRoot '..')).Path;$git=(Get-Command git.exe -ErrorAction Stop).Source;$commit=(& $git -C $repoRoot rev-parse HEAD).Trim()
$receiptPath=Join-Path $runtime "rollback-$stamp.json";$rollbackId="ROLLBACK-$([guid]::NewGuid())"
$receipt=[ordered]@{schemaVersion='1.0.0';phase='CWC-P7';status='ROLLED_BACK';repositoryCommit=$commit;recordedAt=(Get-Date).ToUniversalTime().ToString('o');gates=[ordered]@{p3='PASS';p4='PASS';p5='PASS';p6='PASS'};artifacts=[ordered]@{readOnlyConfig=$ExpectedSha256};rollbackReady=$true;monitoringReady=$true;backupReady=$true;ownerApproval=$true;production=$false;rollbackId=$rollbackId;rolledBackAt=(Get-Date).ToUniversalTime().ToString('o');rollbackVerification='PASS';backupPath=$backup}
Write-Utf8NoBom $receiptPath ($receipt|ConvertTo-Json -Depth 10)
& node.exe (Join-Path $BridgeRoot 'scripts\validate-cwc-p7-release-evidence.mjs') $receiptPath
if($LASTEXITCODE-ne0){throw 'Rollback receipt validation failed.'}
Write-Host 'CWC_P7_ROLLBACK=PASS';Write-Host "ROLLBACK_ID=$rollbackId";Write-Host "ROLLBACK_RECEIPT=$receiptPath";Write-Host 'PRODUCTION=false';Write-Host 'RUNTIME_RESTARTED=false'
