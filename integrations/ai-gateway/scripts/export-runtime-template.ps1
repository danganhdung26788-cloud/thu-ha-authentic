$ErrorActionPreference = 'Stop'

$WorkerDir = Split-Path -Parent $PSScriptRoot
$OutputDir = Join-Path $WorkerDir 'runtime\backup-template'
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null

Copy-Item (Join-Path $WorkerDir '.env.example') (Join-Path $OutputDir '.env.example') -Force
Copy-Item (Join-Path $WorkerDir 'README.md') (Join-Path $OutputDir 'README.md') -Force
Copy-Item (Join-Path $PSScriptRoot 'install-windows-runtime.ps1') $OutputDir -Force
Copy-Item (Join-Path $PSScriptRoot 'runtime-health-check.ps1') $OutputDir -Force

foreach ($taskName in @('Hermes-AI-Gateway-Dispatcher', 'Hermes-AI-Gateway-Approval-Processor')) {
    if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
        Export-ScheduledTask -TaskName $taskName |
            Set-Content -Path (Join-Path $OutputDir "$taskName.xml") -Encoding UTF8
    }
}

$Manifest = @"
BACKUP_TYPE=HERMES_AI_GATEWAY_RUNTIME_TEMPLATE
CREATED_AT=$((Get-Date).ToString('o'))
INCLUDES_SECRETS=FALSE
INCLUDES_ENV_EXAMPLE=TRUE
INCLUDES_TASK_XML=TRUE
INCLUDES_INSTALL_AND_HEALTH_SCRIPTS=TRUE
"@
[System.IO.File]::WriteAllText((Join-Path $OutputDir 'BACKUP_MANIFEST.txt'), $Manifest, $Utf8NoBom)

Get-ChildItem $OutputDir | Select-Object Name, Length | Format-Table -AutoSize
Write-Host 'HERMES_RUNTIME_TEMPLATE_BACKUP_PASS' -ForegroundColor Green
