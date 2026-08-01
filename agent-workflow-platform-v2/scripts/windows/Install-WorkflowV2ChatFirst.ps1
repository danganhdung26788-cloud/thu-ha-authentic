[CmdletBinding()]
param(
  [Parameter(Mandatory = $false)]
  [string]$ProjectRoot = '',

  [Parameter(Mandatory = $false)]
  [string]$WorkspaceRoot = '',

  [switch]$SkipCodexLoginCheck
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
if ([string]::IsNullOrWhiteSpace($WorkspaceRoot)) { $WorkspaceRoot = $ProjectRoot }

$envPath = Join-Path $ProjectRoot '.env'
if (-not (Test-Path $envPath)) {
  & (Join-Path $ScriptDirectory 'New-AgentV2Configuration.ps1') `
    -ProjectRoot $ProjectRoot `
    -WorkspaceRoot $WorkspaceRoot
}

& (Join-Path $ScriptDirectory 'Update-AgentV2ChatConfiguration.ps1') `
  -ProjectRoot $ProjectRoot

$deployParameters = @{
  ProjectRoot = $ProjectRoot
  WorkspaceRoot = $WorkspaceRoot
}
if ($SkipCodexLoginCheck) {
  $deployParameters['SkipCodexLoginCheck'] = $true
}

& (Join-Path $ScriptDirectory 'Deploy-AgentV2.ps1') @deployParameters

Write-Host 'Workflow AI chat-first installation and upgrade PASS.'
Write-Host 'From now on, normal use is the Workflow AI shortcut and one chat message.'
Write-Host 'V1 remains unchanged and CUTOVER_PHASE remains V1_ONLY.'
