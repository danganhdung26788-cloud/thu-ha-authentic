[CmdletBinding()]
param(
  [Parameter(Mandatory = $false)]
  [string]$ProjectRoot = ''
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

& (Join-Path $ScriptDirectory 'Test-AgentV2.ps1') -ProjectRoot $ProjectRoot
& (Join-Path $ScriptDirectory 'Set-AgentV2Phase.ps1') `
  -ProjectRoot $ProjectRoot `
  -TargetPhase SHADOW `
  -Reason 'Runtime health, adapters and isolated deployment passed; begin read-only shadow comparison.' `
  -Confirm:$false
Write-Host 'Workflow AI V2 entered SHADOW. V1 remains authoritative and unchanged.'
