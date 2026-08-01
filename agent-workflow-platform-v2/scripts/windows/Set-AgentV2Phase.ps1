[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('V1_ONLY', 'SHADOW', 'DUAL_RUN', 'V2_PRIMARY', 'V1_DECOMMISSIONED')]
  [string]$TargetPhase,

  [Parameter(Mandatory = $true)]
  [string]$Reason,

  [Parameter(Mandatory = $false)]
  [string]$ChangedBy = $env:USERNAME,

  [Parameter(Mandatory = $false)]
  [string]$ProjectRoot = '',

  [datetime]$RollbackUntil,
  [switch]$BackupVerified,
  [switch]$Soak7Pass,
  [switch]$RollbackExpired,
  [switch]$OwnerApproved
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$ScriptDirectory = if (-not [string]::IsNullOrWhiteSpace($PSScriptRoot)) {
  $PSScriptRoot
} else {
  Split-Path -Parent $MyInvocation.MyCommand.Path
}
if ([string]::IsNullOrWhiteSpace($ProjectRoot)) {
  $ProjectRoot = (Resolve-Path (Join-Path $ScriptDirectory '..\..')).Path
} else {
  $ProjectRoot = (Resolve-Path $ProjectRoot).Path
}

$envFile = Join-Path $ProjectRoot '.env'
if (-not (Test-Path $envFile)) { throw "Missing configuration: $envFile" }

$values = @{}
Get-Content -Path $envFile | ForEach-Object {
  $line = $_.Trim()
  if (-not $line -or $line.StartsWith('#')) { return }
  $separator = $line.IndexOf('=')
  if ($separator -gt 0) { $values[$line.Substring(0, $separator)] = $line.Substring($separator + 1) }
}
$token = $values['API_AUTH_TOKEN']
if (-not $token) { throw 'API_AUTH_TOKEN is missing.' }

if ($TargetPhase -in @('V2_PRIMARY', 'V1_DECOMMISSIONED') -and -not $OwnerApproved) {
  throw "$TargetPhase requires -OwnerApproved."
}
if ($TargetPhase -eq 'V2_PRIMARY' -and (-not $BackupVerified -or -not $RollbackUntil)) {
  throw 'V2_PRIMARY requires -BackupVerified and -RollbackUntil.'
}
if ($TargetPhase -eq 'V1_DECOMMISSIONED' -and (-not $BackupVerified -or -not $Soak7Pass -or -not $RollbackExpired)) {
  throw 'V1_DECOMMISSIONED requires verified backup, 7/7 soak and expired rollback window.'
}

$payload = [ordered]@{
  targetPhase = $TargetPhase
  changedBy = $ChangedBy
  reason = $Reason
  rollbackUntil = if ($RollbackUntil) { $RollbackUntil.ToUniversalTime().ToString('o') } else { $null }
  evidence = [ordered]@{
    command = 'Set-AgentV2Phase.ps1'
    requestedAt = (Get-Date).ToUniversalTime().ToString('o')
  }
  soak7Pass = [bool]$Soak7Pass
  rollbackExpired = [bool]$RollbackExpired
  backupVerified = [bool]$BackupVerified
  ownerApproved = [bool]$OwnerApproved
}

if (-not $PSCmdlet.ShouldProcess('Workflow AI V2', "Transition cutover phase to $TargetPhase")) { return }
$headers = @{ Authorization = "Bearer $token" }
$result = Invoke-RestMethod `
  -Uri 'http://127.0.0.1:3100/v1/cutover/transition' `
  -Method Post `
  -Headers $headers `
  -ContentType 'application/json' `
  -Body ($payload | ConvertTo-Json -Depth 10) `
  -TimeoutSec 30
$result | ConvertTo-Json -Depth 10
