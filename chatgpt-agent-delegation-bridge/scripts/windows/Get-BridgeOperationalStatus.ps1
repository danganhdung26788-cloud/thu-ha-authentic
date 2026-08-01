[CmdletBinding()]
param([string]$BridgeRoot='')
$ErrorActionPreference='Stop'; Set-StrictMode -Version Latest
$ScriptDirectory=if($PSScriptRoot){$PSScriptRoot}else{Split-Path -Parent $MyInvocation.MyCommand.Path}
$BridgeRoot=if([string]::IsNullOrWhiteSpace($BridgeRoot)){(Resolve-Path (Join-Path $ScriptDirectory '..\..')).Path}else{(Resolve-Path $BridgeRoot).Path}
function Write-Utf8NoBom([string]$Path,[string]$Content){[IO.File]::WriteAllText($Path,$Content,(New-Object Text.UTF8Encoding($false)))}
function Read-Env([string]$Name,[string]$Default){
  $envPath=Join-Path $BridgeRoot '.env'; if(-not(Test-Path $envPath)){return $Default}
  foreach($line in Get-Content $envPath){$t=$line.Trim();$i=$t.IndexOf('=');if($i -gt 0 -and -not $t.StartsWith('#') -and $t.Substring(0,$i)-eq$Name){return $t.Substring($i+1)}};return $Default
}
$bind=Read-Env 'MCP_BIND' '127.0.0.1';$port=[int](Read-Env 'MCP_PORT' '3210');$hostName=if($bind -in @('0.0.0.0','localhost')){'127.0.0.1'}else{$bind}
$headers=@{};$auth=Read-Env 'MCP_AUTH_MODE' 'none';if($auth-eq'bearer'){$token=Read-Env 'MCP_AUTH_TOKEN' '';if($token){$headers.Authorization="Bearer $token"}}
$bridgeReady=$false;$health=$null
try{$health=Invoke-RestMethod -Uri "http://${hostName}:$port/health" -Headers $headers -TimeoutSec 3;$bridgeReady=$health.ok-eq$true}catch{}
$tunnelReady=$false;$tunnelHealth='';$healthFile=Join-Path $BridgeRoot 'runtime\secure-mcp-tunnel\health.url'
if(Test-Path $healthFile){$tunnelHealth=(Get-Content -Raw $healthFile).Trim().TrimEnd('/');if($tunnelHealth-match'^http://127\.0\.0\.1:\d+$'){try{$r=Invoke-WebRequest -UseBasicParsing -Uri "$tunnelHealth/readyz" -TimeoutSec 3;$tunnelReady=$r.StatusCode-eq200}catch{}}}
$runtime=Join-Path $BridgeRoot 'runtime\cwc-p7';New-Item -ItemType Directory -Force -Path $runtime|Out-Null;$path=Join-Path $runtime 'operational-status-latest.json'
$receipt=[ordered]@{schemaVersion='1.0.0';phase='CWC-P7';mode='READ_ONLY_OPERATIONAL_STATUS';checkedAt=(Get-Date).ToUniversalTime().ToString('o');bridgeReady=$bridgeReady;tunnelReady=$tunnelReady;chatgptPrimaryBrain=if($health){$health.targets-ne$null}else{$false};mutationPerformed=$false;productionClaimed=$false}
Write-Utf8NoBom $path ($receipt|ConvertTo-Json -Depth 8)
Write-Host "BRIDGE_READY=$($bridgeReady.ToString().ToLowerInvariant())";Write-Host "TUNNEL_READY=$($tunnelReady.ToString().ToLowerInvariant())";Write-Host 'MUTATION_PERFORMED=false';Write-Host "STATUS_RECEIPT=$path"
