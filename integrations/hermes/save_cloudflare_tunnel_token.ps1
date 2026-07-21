#Requires -RunAsAdministrator

param(
    [string]$TokenPath = "D:\HermesAgent\secrets\cloudflare_tunnel_token.txt"
)

$ErrorActionPreference = "Stop"
$tokenDirectory = Split-Path -Parent $TokenPath
New-Item -ItemType Directory -Force -Path $tokenDirectory | Out-Null

$secureToken = Read-Host "Paste the Cloudflare named tunnel token, then press Enter" -AsSecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureToken)

try {
    $plainToken = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
    if ([string]::IsNullOrWhiteSpace($plainToken)) {
        throw "CLOUDFLARE_TUNNEL_TOKEN_EMPTY"
    }
    if ($plainToken -notmatch '^eyJ') {
        throw "CLOUDFLARE_TUNNEL_TOKEN_FORMAT_INVALID"
    }

    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($TokenPath, $plainToken.Trim(), $utf8NoBom)

    & icacls $TokenPath /inheritance:r | Out-Null
    & icacls $TokenPath /grant:r "$env:USERNAME:(F)" "SYSTEM:(F)" | Out-Null

    Write-Host "PASS: Cloudflare tunnel token saved"
    Write-Host "TOKEN_PRINTED=FALSE"
    Write-Host "TOKEN_PATH=$TokenPath"
}
finally {
    if ($bstr -ne [IntPtr]::Zero) {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
    }
    $plainToken = $null
    $secureToken = $null
}
