[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$P3EvidencePath,
  [Parameter(Mandatory = $true)][string]$P4EvidencePath,
  [Parameter(Mandatory = $true)][string]$P5EvidencePath,
  [Parameter(Mandatory = $true)][string]$P6EvidencePath,
  [Parameter(Mandatory = $true)][string]$ReadOnlyConfigPath,
  [Parameter(Mandatory = $true)][string]$WriteConfigPath,
  [Parameter(Mandatory = $false)][string]$BridgeRoot = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$ScriptDirectory = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
$BridgeRoot = if ([string]::IsNullOrWhiteSpace($BridgeRoot)) { (Resolve-Path (Join-Path $ScriptDirectory '..\..')).Path } else { (Resolve-Path $BridgeRoot).Path }
Set-Location $BridgeRoot

function Write-Utf8NoBom([string]$Path,[string]$Content) {
  [System.IO.File]::WriteAllText($Path,$Content,(New-Object System.Text.UTF8Encoding($false)))
}
function Sha256([string]$Path) {
  $stream=[System.IO.File]::OpenRead((Resolve-Path $Path).Path); $sha=[Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-','').ToLowerInvariant() } finally { $sha.Dispose(); $stream.Dispose() }
}
function Json([string]$Path) { return Get-Content -Raw -LiteralPath (Resolve-Path $Path).Path | ConvertFrom-Json }
function Require([bool]$Condition,[string]$Message) { if (-not $Condition) { throw $Message } }

$p3=Json $P3EvidencePath; $p4=Json $P4EvidencePath; $p5=Json $P5EvidencePath; $p6=Json $P6EvidencePath
Require ($p3.phase -eq 'CWC-P3' -and $p3.status -eq 'PASS' -and $p3.localWrite -eq $false) 'CWC-P3 PASS evidence is required.'
Require ($p4.phase -eq 'CWC-P4' -and $p4.status -eq 'PASS' -and $p4.tunnelReady -eq $true -and $p4.controlPlaneApiKeyPersisted -eq $false) 'CWC-P4 PASS evidence is required.'
& node.exe (Join-Path $BridgeRoot 'scripts\validate-cwc-p5-evidence.mjs') (Resolve-Path $P5EvidencePath).Path --require-pass
if ($LASTEXITCODE -ne 0) { throw 'CWC-P5 PASS evidence validation failed.' }
& node.exe (Join-Path $BridgeRoot 'scripts\validate-cwc-p6-evidence.mjs') (Resolve-Path $P6EvidencePath).Path --require-pass
if ($LASTEXITCODE -ne 0) { throw 'CWC-P6 PASS evidence validation failed.' }
Require ($p6.teardownComplete -eq $true -and $p6.localWriteActivated -eq $false -and $p6.production -eq $false) 'CWC-P6 must be torn down before release candidate creation.'

$readOnly=Json $ReadOnlyConfigPath
foreach($workspace in @($readOnly.workspaces)) {
  Require ($workspace.allowLocalWrite -eq $false) 'Read-only rollback config contains allowLocalWrite=true.'
  Require (@($workspace.writeRoots).Count -eq 0) 'Read-only rollback config contains write roots.'
  Require (@($workspace.allowedScripts).Count -eq 0) 'Read-only rollback config contains allowed scripts.'
}
$write=Json $WriteConfigPath
Require (@($write.workspaces).Count -ge 1) 'Write profile contains no workspace.'
foreach($workspace in @($write.workspaces)) {
  Require ($workspace.allowLocalWrite -eq $true) 'Write profile must explicitly enable controlled write.'
  Require (@($workspace.writeRoots).Count -ge 1) 'Write profile must contain a narrow write root.'
  foreach($root in @($workspace.writeRoots)) { Require ($root -notin @('.','./','')) 'Whole-workspace write root is forbidden.' }
}

$repoRoot=(Resolve-Path (Join-Path $BridgeRoot '..')).Path
$git=(Get-Command git.exe -ErrorAction Stop).Source
$commit=(& $git -C $repoRoot rev-parse HEAD).Trim()
$status=(& $git -C $repoRoot status --porcelain=v1 | Out-String).Trim()
Require ([string]::IsNullOrWhiteSpace($status)) 'Release candidate requires a clean Git working tree.'

$runtime=Join-Path $BridgeRoot 'runtime\cwc-p7'; New-Item -ItemType Directory -Force -Path $runtime | Out-Null
$candidatePath=Join-Path $runtime 'release-candidate.json'
$candidate=[ordered]@{
  schemaVersion='1.0.0'; phase='CWC-P7'; status='CANDIDATE_READY_NOT_ACTIVATED'; recordedAt=(Get-Date).ToUniversalTime().ToString('o')
  repositoryCommit=$commit; gates=[ordered]@{p3='PASS';p4='PASS';p5='PASS';p6='PASS'}
  artifacts=[ordered]@{
    p3Evidence=Sha256 $P3EvidencePath; p4Evidence=Sha256 $P4EvidencePath; p5Evidence=Sha256 $P5EvidencePath; p6Evidence=Sha256 $P6EvidencePath
    readOnlyConfig=Sha256 $ReadOnlyConfigPath; writeConfig=Sha256 $WriteConfigPath
  }
  rollbackReady=$true; monitoringReady=$true; backupReady=$true; ownerApproval=$false; production=$false; blockReason=''
}
Write-Utf8NoBom $candidatePath ($candidate|ConvertTo-Json -Depth 10)
& node.exe (Join-Path $BridgeRoot 'scripts\validate-cwc-p7-release-evidence.mjs') $candidatePath
if ($LASTEXITCODE -ne 0) { throw 'Generated CWC-P7 release candidate is invalid.' }
Write-Host 'CWC_P7_RELEASE_CANDIDATE=READY_NOT_ACTIVATED'
Write-Host "CANDIDATE_PATH=$candidatePath"
Write-Host 'OWNER_APPROVAL=false'; Write-Host 'PRODUCTION=false'
