[CmdletBinding()]
param(
  [Parameter(Mandatory = $false)]
  [string]$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
& (Join-Path $PSScriptRoot 'Test-AgentV2.ps1') -ProjectRoot $ProjectRoot
& (Join-Path $PSScriptRoot 'Set-AgentV2Phase.ps1') `
  -ProjectRoot $ProjectRoot `
  -TargetPhase SHADOW `
  -Reason 'Runtime health, adapters and isolated deployment passed; begin read-only shadow comparison.' `
  -Confirm:$false
Write-Host 'Workflow AI V2 entered SHADOW. V1 remains authoritative and unchanged.'
