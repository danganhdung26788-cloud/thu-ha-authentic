[CmdletBinding()]
param(
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
Set-Location $BridgeRoot

if (-not (Test-Path '.env')) { throw 'Local .env is missing.' }
if (-not (Test-Path 'config\workspaces.json')) { throw 'Local workspace registry is missing.' }
if (-not (Test-Path 'dist\src\index.js')) { throw 'Bridge build is missing. Run Install-BridgeReadOnly.ps1 first.' }

$runtime = Join-Path $BridgeRoot 'runtime'
New-Item -ItemType Directory -Force -Path $runtime | Out-Null
$pidPath = Join-Path $runtime 'bridge.pid'
$stdoutPath = Join-Path $runtime 'bridge.stdout.log'
$stderrPath = Join-Path $runtime 'bridge.stderr.log'

function Test-Health {
  try {
    $response = Invoke-RestMethod -Uri 'http://127.0.0.1:3210/health' -TimeoutSec 3
    return $response.ok -eq $true
  } catch {
    return $false
  }
}

if (Test-Health) {
  Write-Host 'BRIDGE_ALREADY_READY=true'
  return
}

if (Test-Path $pidPath) {
  $priorPid = 0
  [void][int]::TryParse((Get-Content -Raw -LiteralPath $pidPath).Trim(), [ref]$priorPid)
  if ($priorPid -gt 0) {
    $prior = Get-Process -Id $priorPid -ErrorAction SilentlyContinue
    if ($null -ne $prior) {
      Stop-Process -Id $priorPid -Force -ErrorAction SilentlyContinue
      Start-Sleep -Seconds 1
    }
  }
  Remove-Item -LiteralPath $pidPath -Force -ErrorAction SilentlyContinue
}

Remove-Item -LiteralPath $stdoutPath -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $stderrPath -Force -ErrorAction SilentlyContinue
$nodePath = (Get-Command node.exe -ErrorAction Stop).Source
$process = Start-Process `
  -FilePath $nodePath `
  -ArgumentList @('--env-file=.env', 'dist\src\index.js') `
  -WorkingDirectory $BridgeRoot `
  -WindowStyle Hidden `
  -RedirectStandardOutput $stdoutPath `
  -RedirectStandardError $stderrPath `
  -PassThru

[System.IO.File]::WriteAllText($pidPath, [string]$process.Id)
$deadline = (Get-Date).AddSeconds(30)
while ((Get-Date) -lt $deadline) {
  if (Test-Health) {
    Write-Host 'BRIDGE_READY=true'
    Write-Host "BRIDGE_PID=$($process.Id)"
    Write-Host 'CONNECTED_TO_CHATGPT=false'
    return
  }
  if ($process.HasExited) { break }
  Start-Sleep -Seconds 1
}

$stderr = if (Test-Path $stderrPath) {
  (Get-Content -LiteralPath $stderrPath -Tail 80 -ErrorAction SilentlyContinue | Out-String).Trim()
} else {
  'No stderr log was created.'
}
throw "Bridge failed to become healthy. Review $stderrPath. Last stderr: $stderr"
