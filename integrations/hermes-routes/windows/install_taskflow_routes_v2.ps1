#Requires -RunAsAdministrator

param(
    [string]$PythonExecutable
)

$ErrorActionPreference = "Stop"
$routesRoot = Split-Path $PSScriptRoot -Parent
$runner = Join-Path $PSScriptRoot "run_taskflow_routes_v2.ps1"
if (-not (Test-Path -LiteralPath $runner -PathType Leaf)) {
    throw "Runner script not found: $runner"
}
$runner = (Resolve-Path -LiteralPath $runner).Path

if ([string]::IsNullOrWhiteSpace($PythonExecutable)) {
    $PythonExecutable = Join-Path $routesRoot ".venv\Scripts\python.exe"
}
if (-not (Test-Path -LiteralPath $PythonExecutable -PathType Leaf)) {
    throw "Python executable not found: $PythonExecutable. Create the repository virtual environment and install integrations/hermes-routes/requirements.txt."
}
$PythonExecutable = (Resolve-Path -LiteralPath $PythonExecutable).Path

$credentialsPath = $env:GOOGLE_APPLICATION_CREDENTIALS
if ([string]::IsNullOrWhiteSpace($credentialsPath)) {
    throw "GOOGLE_APPLICATION_CREDENTIALS is not set. Set it to the Google credential file before installing Scheduled Tasks."
}
if (-not (Test-Path -LiteralPath $credentialsPath -PathType Leaf)) {
    throw "Google credential file not found: $credentialsPath"
}

$definitions = @(
    @{ Name = "Hermes-Route-Ops-Health"; Route = "RT-OPS-HEALTH-01"; At = "07:30" },
    @{ Name = "Hermes-Route-Due-Check"; Route = "RT-DUE-CHECK-01"; At = "08:00" },
    @{ Name = "Hermes-Route-File-Sync"; Route = "RT-FILE-SYNC-01"; At = "09:00" }
)
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name

foreach ($definition in $definitions) {
    $arguments = @(
        "-NoProfile",
        "-NonInteractive",
        "-WindowStyle Hidden",
        "-ExecutionPolicy Bypass",
        "-File `"$runner`"",
        "-Route `"$($definition.Route)`"",
        "-Mode run",
        "-PythonExecutable `"$PythonExecutable`""
    ) -join " "
    $action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $arguments
    $trigger = New-ScheduledTaskTrigger -Daily -At $definition.At
    $principal = New-ScheduledTaskPrincipal `
        -UserId $identity `
        -LogonType Interactive `
        -RunLevel Highest
    $settings = New-ScheduledTaskSettingsSet `
        -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries `
        -StartWhenAvailable `
        -MultipleInstances IgnoreNew `
        -ExecutionTimeLimit (New-TimeSpan -Minutes 20)

    Register-ScheduledTask `
        -TaskName $definition.Name `
        -Action $action `
        -Trigger $trigger `
        -Principal $principal `
        -Settings $settings `
        -Description "Read-only TalkFlow Routes V2 runner; audit writes only to HERMES_CONTROL_DB/RUN_LOG." `
        -Force | Out-Null
    Write-Host "REGISTERED=$($definition.Name) ROUTE=$($definition.Route) AT=$($definition.At)"
}
