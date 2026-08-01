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

$windowsScripts = Join-Path $ProjectRoot 'scripts\windows'
$rules = @(
  @{ Name = 'PSScriptRoot in default ProjectRoot parameter'; Pattern = '\[string\]\$ProjectRoot\s*=\s*\(Resolve-Path\s*\(Join-Path\s*\$PSScriptRoot' },
  @{ Name = 'PowerShell 7-only utf8NoBOM encoding'; Pattern = '-Encoding\s+utf8NoBOM' },
  @{ Name = 'Unavailable RandomNumberGenerator.Fill API'; Pattern = 'RandomNumberGenerator\]::Fill' },
  @{ Name = 'Executable shim instead of explicit Windows command'; Pattern = '(?m)&\s+(docker|git|node|npm|npx)\s' }
)

$violations = @()
Get-ChildItem -Path $windowsScripts -Filter '*.ps1' -File | ForEach-Object {
  $content = Get-Content -Raw -LiteralPath $_.FullName
  foreach ($rule in $rules) {
    if ($content -match $rule.Pattern) {
      $violations += "{0}: {1}" -f $_.FullName, $rule.Name
    }
  }
}

if ($violations.Count -gt 0) {
  throw "Windows PowerShell 5.1 compatibility violations:`n$($violations -join "`n")"
}

Write-Host 'Windows PowerShell 5.1 compatibility scan PASS.'
