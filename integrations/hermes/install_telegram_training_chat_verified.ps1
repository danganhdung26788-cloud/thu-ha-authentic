#Requires -RunAsAdministrator

param(
    [string]$GatewayContainer = 'hermes-gateway',
    [string]$MetaContainer = 'hermes-tha-meta',
    [string]$DataRoot = 'D:\HermesAgent\data',
    [string]$LocalHealthUrl = 'http://127.0.0.1:8788/health'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$installer = Join-Path $PSScriptRoot 'install_telegram_training_chat.ps1'
$verifier = Join-Path $PSScriptRoot 'verify_telegram_training_install.ps1'

try {
    & $installer `
        -GatewayContainer $GatewayContainer `
        -MetaContainer $MetaContainer `
        -DataRoot $DataRoot `
        -LocalHealthUrl $LocalHealthUrl
    return
}
catch {
    Write-Warning "Primary installer stopped: $($_.Exception.Message)"
    Write-Host 'Running precise post-install verification...' -ForegroundColor Cyan
}

& $verifier `
    -GatewayContainer $GatewayContainer `
    -MetaContainer $MetaContainer `
    -LocalHealthUrl $LocalHealthUrl
