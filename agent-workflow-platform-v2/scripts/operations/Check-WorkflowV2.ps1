[CmdletBinding()]
param(
  [Parameter(Mandatory = $false)]
  [string]$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
& (Join-Path $ProjectRoot 'scripts\windows\Test-AgentV2.ps1') -ProjectRoot $ProjectRoot
