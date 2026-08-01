[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$P5EvidencePath,

  [Parameter(Mandatory = $true)]
  [string]$WorkspaceRoot,

  [Parameter(Mandatory = $true)]
  [string]$ApprovedWriteRoot,

  [Parameter(Mandatory = $false)]
  [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9._-]{2,79}$')]
  [string]$WorkspaceId = 'cwc-p6-controlled-write-uat',

  [Parameter(Mandatory = $false)]
  [string[]]$AllowedScripts = @(),

  [Parameter(Mandatory = $false)]
  [string]$BridgeRoot = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$ScriptDirectory = if (-not [string]::IsNullOrWhiteSpace($PSScriptRoot)) {
  $PSScriptRoot
} else {
  Split-Path -Parent $MyInvocation.MyCommand.Path
}
if ([string]::IsNullOrWhiteSpace($BridgeRoot)) {
  $BridgeRoot = (Resolve-Path (Join-Path $ScriptDirectory '..\..')).Path
} else {
  $BridgeRoot = (Resolve-Path $BridgeRoot).Path
}
$WorkspaceRoot = (Resolve-Path -LiteralPath $WorkspaceRoot).Path
$ApprovedWriteRoot = (Resolve-Path -LiteralPath $ApprovedWriteRoot).Path
$P5EvidencePath = (Resolve-Path -LiteralPath $P5EvidencePath).Path

function Write-Utf8NoBom([string]$Path, [string]$Content) {
  $encoding = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($Path, $Content, $encoding)
}

function Get-RelativeChild([string]$Root, [string]$Child, [string]$Kind) {
  $rootFull = [System.IO.Path]::GetFullPath($Root).TrimEnd('\', '/')
  $childFull = [System.IO.Path]::GetFullPath($Child).TrimEnd('\', '/')
  if ([string]::Equals($rootFull, $childFull, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "$Kind cannot be the entire workspace root."
  }
  $prefix = $rootFull + [System.IO.Path]::DirectorySeparatorChar
  if (-not $childFull.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "$Kind must be inside the workspace root."
  }
  return $childFull.Substring($prefix.Length).Replace('\', '/')
}

function Get-Sha256File([string]$Path) {
  $stream = [System.IO.File]::OpenRead($Path)
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    return ([System.BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-', '').ToLowerInvariant()
  } finally {
    $sha.Dispose()
    $stream.Dispose()
  }
}

$validator = Join-Path $BridgeRoot 'scripts\validate-cwc-p5-evidence.mjs'
& node.exe $validator $P5EvidencePath --require-pass
if ($LASTEXITCODE -ne 0) { throw 'CWC-P5 PASS evidence validation failed.' }
$p5 = Get-Content -Raw -LiteralPath $P5EvidencePath | ConvertFrom-Json
if ([string]$p5.workspacePlan -notin @('BUSINESS', 'ENTERPRISE', 'EDU')) {
  throw 'CWC-P6 write UAT requires Business, Enterprise, or Edu. Pro read-only evidence is insufficient.'
}

$writeRelative = Get-RelativeChild -Root $WorkspaceRoot -Child $ApprovedWriteRoot -Kind 'Approved write root'
if ((Split-Path -Leaf $ApprovedWriteRoot) -notmatch '^cwc-p6-uat-') {
  throw 'Approved write root leaf name must start with cwc-p6-uat- to enforce a dedicated sandbox.'
}

$scriptRelatives = @()
foreach ($script in $AllowedScripts) {
  $resolved = (Resolve-Path -LiteralPath $script).Path
  if ([System.IO.Path]::GetExtension($resolved) -ne '.ps1') {
    throw "Only explicit PowerShell .ps1 scripts may be registered: $script"
  }
  $scriptRelatives += Get-RelativeChild -Root $WorkspaceRoot -Child $resolved -Kind 'Allowed script'
}

$runtimeDirectory = Join-Path $BridgeRoot 'runtime\cwc-p6'
New-Item -ItemType Directory -Force -Path $runtimeDirectory | Out-Null
$configPath = Join-Path $runtimeDirectory 'workspaces.write-uat.json'
$manifestPath = Join-Path $runtimeDirectory 'controlled-write-profile-manifest.json'

$document = [ordered]@{
  defaultWorkspaceId = $WorkspaceId
  workspaces = @(
    [ordered]@{
      workspaceId = $WorkspaceId
      root = $WorkspaceRoot
      readRoots = @('.')
      writeRoots = @($writeRelative)
      allowedExecutables = if ($scriptRelatives.Count -gt 0) { @('powershell.exe', 'pwsh.exe') } else { @() }
      allowedScripts = @($scriptRelatives)
      scheduledTaskPrefix = 'CWC-P6-UAT-'
      allowCodexRead = $false
      allowLocalRead = $true
      allowLocalWrite = $true
    }
  )
}
Write-Utf8NoBom -Path $configPath -Content ($document | ConvertTo-Json -Depth 10)

$manifest = [ordered]@{
  schemaVersion = '1.0.0'
  phase = 'CWC-P6'
  status = 'PROFILE_READY_NOT_ACTIVATED'
  createdAt = (Get-Date).ToUniversalTime().ToString('o')
  workspacePlan = [string]$p5.workspacePlan
  workspaceId = $WorkspaceId
  workspaceRoot = $WorkspaceRoot
  writeRootRelative = $writeRelative
  allowedScripts = @($scriptRelatives)
  configPath = $configPath
  configSha256 = Get-Sha256File -Path $configPath
  approvalMode = 'EPHEMERAL_SINGLE_USE_PLAN_HASH'
  localWriteActivated = $false
  connectedWriteApp = $false
  production = $false
}
Write-Utf8NoBom -Path $manifestPath -Content ($manifest | ConvertTo-Json -Depth 10)

Write-Host 'CWC_P6_WRITE_PROFILE=READY_NOT_ACTIVATED'
Write-Host "PROFILE_PATH=$configPath"
Write-Host "MANIFEST_PATH=$manifestPath"
Write-Host 'LOCAL_WRITE_ACTIVATED=false'
Write-Host 'CONNECTED_WRITE_APP=false'
Write-Host 'PRODUCTION=false'
