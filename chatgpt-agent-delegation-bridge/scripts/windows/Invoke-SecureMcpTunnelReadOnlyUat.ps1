[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^tunnel_[A-Za-z0-9_-]{16,128}$')]
  [string]$TunnelId,

  [Parameter(Mandatory = $false)]
  [string]$BridgeRoot = '',

  [Parameter(Mandatory = $false)]
  [string]$TunnelClientPath = '',

  [Parameter(Mandatory = $false)]
  [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9._-]{2,79}$')]
  [string]$Profile = 'system-ai-workflow-readonly',

  [Parameter(Mandatory = $false)]
  [switch]$KeepRunning
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

function Write-Utf8NoBom([string]$Path, [string]$Content) {
  $encoding = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($Path, $Content, $encoding)
}

function Protect-Text([string]$Text) {
  $safe = $Text
  $safe = [Regex]::Replace($safe, '(?i)Bearer\s+[A-Za-z0-9._~+/=-]+', 'Bearer [REDACTED]')
  $safe = [Regex]::Replace($safe, 'sk-[A-Za-z0-9_-]{16,}', '[REDACTED_API_KEY]')
  $safe = [Regex]::Replace(
    $safe,
    '(?im)^(\s*(?:CONTROL_PLANE_API_KEY|MCP_AUTH_TOKEN|SPECIALIST_API_KEY)\s*=).+$',
    '$1[REDACTED]'
  )
  return $safe
}

function Resolve-TunnelClient([string]$Candidate) {
  if (-not [string]::IsNullOrWhiteSpace($Candidate)) {
    $resolved = (Resolve-Path -LiteralPath $Candidate).Path
    if (-not (Test-Path -LiteralPath $resolved -PathType Leaf)) {
      throw 'Tunnel client path is not a file.'
    }
    return $resolved
  }
  foreach ($name in @('tunnel-client.exe', 'tunnel-client')) {
    $command = Get-Command $name -ErrorAction SilentlyContinue
    if ($null -ne $command) { return $command.Source }
  }
  throw 'tunnel-client is unavailable. Download the current supported binary from Platform tunnel settings or the official latest release.'
}

function Invoke-TunnelCommand([string[]]$Arguments, [string]$LogPath) {
  $lines = @(& $script:TunnelClient @Arguments 2>&1)
  $exitCode = $LASTEXITCODE
  $text = Protect-Text -Text (($lines | Out-String).Trim())
  Write-Utf8NoBom -Path $LogPath -Content $text
  if ($exitCode -ne 0) {
    throw "tunnel-client failed with exit code $exitCode. Review $LogPath."
  }
  return $text
}

function Stop-VerifiedProcess([int]$ProcessId, [string]$ExpectedPath) {
  if ($ProcessId -le 0) { return }
  $process = Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId" -ErrorAction SilentlyContinue
  if ($null -eq $process) { return }
  $actualPath = [string]$process.ExecutablePath
  if ([string]::IsNullOrWhiteSpace($actualPath) -or
      -not [string]::Equals($actualPath, $ExpectedPath, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "PID $ProcessId does not match the approved tunnel-client binary. No process was stopped."
  }
  Stop-Process -Id $ProcessId -Force -ErrorAction Stop
}

if ([string]::IsNullOrWhiteSpace($env:CONTROL_PLANE_API_KEY)) {
  throw 'CONTROL_PLANE_API_KEY is required in the current process environment. It will not be written to repository files or receipts.'
}

$TunnelClient = Resolve-TunnelClient -Candidate $TunnelClientPath
$runtimeDirectory = Join-Path $BridgeRoot 'runtime\secure-mcp-tunnel'
$profileDirectory = Join-Path $runtimeDirectory 'profiles'
$healthUrlFile = Join-Path $runtimeDirectory 'health.url'
$stdoutPath = Join-Path $runtimeDirectory 'tunnel.stdout.log'
$stderrPath = Join-Path $runtimeDirectory 'tunnel.stderr.log'
$doctorLogPath = Join-Path $runtimeDirectory 'doctor.log'
$initLogPath = Join-Path $runtimeDirectory 'init.log'
$pidPath = Join-Path $runtimeDirectory 'tunnel.pid'
$receiptPath = Join-Path $runtimeDirectory 'cwc-p4-secure-mcp-tunnel-read-only-uat-latest.json'
New-Item -ItemType Directory -Force -Path $profileDirectory | Out-Null
Remove-Item -LiteralPath $healthUrlFile, $stdoutPath, $stderrPath -Force -ErrorAction SilentlyContinue

$priorProfileDirectory = $env:TUNNEL_CLIENT_PROFILE_DIR
$env:TUNNEL_CLIENT_PROFILE_DIR = $profileDirectory
$bridgeStarted = $false
$tunnelProcess = $null
$passed = $false
$errorMessage = ''
$healthBaseUrl = ''
$ready = $false
$clientVersion = ''

try {
  $bridgeUat = Join-Path $ScriptDirectory 'Invoke-BridgeReadOnlyUat.ps1'
  & $bridgeUat -BridgeRoot $BridgeRoot -KeepRunning
  $bridgeStarted = $true

  $clientVersion = Protect-Text -Text ((& $TunnelClient version 2>&1 | Out-String).Trim())
  if ($LASTEXITCODE -ne 0) {
    $clientVersion = Protect-Text -Text ((& $TunnelClient --version 2>&1 | Out-String).Trim())
    if ($LASTEXITCODE -ne 0) { throw 'Unable to read tunnel-client version.' }
  }

  $profilePath = Join-Path $profileDirectory ($Profile + '.yaml')
  if (-not (Test-Path -LiteralPath $profilePath)) {
    [void](Invoke-TunnelCommand -Arguments @(
      'init',
      '--sample', 'sample_mcp_remote_no_auth',
      '--profile', $Profile,
      '--tunnel-id', $TunnelId,
      '--mcp-server-url', 'http://127.0.0.1:3210/mcp'
    ) -LogPath $initLogPath)
  }

  [void](Invoke-TunnelCommand -Arguments @('doctor', '--profile', $Profile, '--explain') -LogPath $doctorLogPath)

  $argumentList = @(
    'run',
    '--profile', $Profile,
    '--health.listen-addr', '127.0.0.1:0',
    '--health.url-file', ('"' + $healthUrlFile.Replace('"', '\"') + '"')
  )
  $tunnelProcess = Start-Process `
    -FilePath $TunnelClient `
    -ArgumentList $argumentList `
    -WorkingDirectory $BridgeRoot `
    -WindowStyle Hidden `
    -RedirectStandardOutput $stdoutPath `
    -RedirectStandardError $stderrPath `
    -PassThru
  Write-Utf8NoBom -Path $pidPath -Content ([string]$tunnelProcess.Id)

  $deadline = (Get-Date).AddSeconds(90)
  while ((Get-Date) -lt $deadline) {
    if ($tunnelProcess.HasExited) { break }
    if (Test-Path -LiteralPath $healthUrlFile) {
      $healthBaseUrl = (Get-Content -Raw -LiteralPath $healthUrlFile).Trim().TrimEnd('/')
      if ($healthBaseUrl -match '^http://127\.0\.0\.1:\d+$') {
        try {
          $healthResponse = Invoke-WebRequest -UseBasicParsing -Uri ($healthBaseUrl + '/healthz') -TimeoutSec 3
          $readyResponse = Invoke-WebRequest -UseBasicParsing -Uri ($healthBaseUrl + '/readyz') -TimeoutSec 3
          if ($healthResponse.StatusCode -eq 200 -and $readyResponse.StatusCode -eq 200) {
            $ready = $true
            break
          }
        } catch {
          # Continue until the control-plane poll and local MCP checks become ready.
        }
      }
    }
    Start-Sleep -Seconds 2
  }

  if (-not $ready) {
    $tail = if (Test-Path -LiteralPath $stderrPath) {
      Protect-Text -Text ((Get-Content -LiteralPath $stderrPath -Tail 100 -ErrorAction SilentlyContinue | Out-String).Trim())
    } else {
      'No tunnel stderr was created.'
    }
    throw "Secure MCP Tunnel did not become ready. Last stderr: $tail"
  }
  $passed = $true
} catch {
  $errorMessage = Protect-Text -Text $_.Exception.Message
} finally {
  if ($null -ne $tunnelProcess -and (-not $KeepRunning -or -not $passed)) {
    try {
      Stop-VerifiedProcess -ProcessId $tunnelProcess.Id -ExpectedPath $TunnelClient
      Remove-Item -LiteralPath $pidPath -Force -ErrorAction SilentlyContinue
      $tunnelProcess = $null
    } catch {
      if ([string]::IsNullOrWhiteSpace($errorMessage)) {
        $errorMessage = Protect-Text -Text $_.Exception.Message
      }
    }
  }

  if ($bridgeStarted -and (-not $KeepRunning -or -not $passed)) {
    try {
      & (Join-Path $ScriptDirectory 'Stop-Bridge.ps1') -BridgeRoot $BridgeRoot
      $bridgeStarted = $false
    } catch {
      if ([string]::IsNullOrWhiteSpace($errorMessage)) {
        $errorMessage = Protect-Text -Text $_.Exception.Message
      }
    }
  }

  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $tunnelIdHash = ([System.BitConverter]::ToString(
      $sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($TunnelId))
    )).Replace('-', '').ToLowerInvariant()
  } finally {
    $sha.Dispose()
  }

  $receipt = [ordered]@{
    schemaVersion = '1.0.0'
    phase = 'CWC-P4'
    mode = 'SECURE_MCP_TUNNEL_READ_ONLY_UAT'
    status = if ($passed) { 'PASS' } else { 'FAIL' }
    testedAt = (Get-Date).ToUniversalTime().ToString('o')
    tunnelIdSha256 = $tunnelIdHash
    profile = $Profile
    tunnelClientVersion = $clientVersion
    localMcpUrl = 'http://127.0.0.1:3210/mcp'
    outboundOnly = $true
    inboundFirewallPortRequired = $false
    tunnelReady = $ready
    controlPlaneApiKeyPersisted = $false
    localWrite = $false
    connectedToChatgpt = $false
    tunnelLeftRunning = ($null -ne $tunnelProcess)
    bridgeLeftRunning = $bridgeStarted
    localAdminUi = if ($ready -and -not [string]::IsNullOrWhiteSpace($healthBaseUrl)) { $healthBaseUrl + '/ui' } else { '' }
    error = $errorMessage
  }
  Write-Utf8NoBom -Path $receiptPath -Content ($receipt | ConvertTo-Json -Depth 8)

  if ($null -eq $priorProfileDirectory) {
    Remove-Item Env:TUNNEL_CLIENT_PROFILE_DIR -ErrorAction SilentlyContinue
  } else {
    $env:TUNNEL_CLIENT_PROFILE_DIR = $priorProfileDirectory
  }
}

if (-not $passed) {
  throw "CWC-P4 secure tunnel read-only UAT failed. Receipt: $receiptPath. Error: $errorMessage"
}

Write-Host 'CWC_P4_SECURE_MCP_TUNNEL_READ_ONLY_UAT=PASS'
Write-Host "UAT_RECEIPT=$receiptPath"
Write-Host 'OUTBOUND_ONLY=true'
Write-Host 'INBOUND_FIREWALL_PORT_REQUIRED=false'
Write-Host 'CONTROL_PLANE_API_KEY_PERSISTED=false'
Write-Host 'LOCAL_WRITE=false'
Write-Host 'CONNECTED_TO_CHATGPT=false'
Write-Host "TUNNEL_LEFT_RUNNING=$(($null -ne $tunnelProcess).ToString().ToLowerInvariant())"
Write-Host "BRIDGE_LEFT_RUNNING=$($bridgeStarted.ToString().ToLowerInvariant())"
