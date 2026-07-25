param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("RT-DUE-CHECK-01", "RT-FILE-SYNC-01", "RT-OPS-HEALTH-01")]
    [string]$Route,
    [ValidateSet("run", "smoke", "self-test")]
    [string]$Mode = "run",
    [string]$PythonExecutable = "python"
)

$ErrorActionPreference = "Stop"
$runner = Join-Path (Split-Path $PSScriptRoot -Parent) "src\taskflow_routes_v2.py"
if (-not (Test-Path -LiteralPath $runner)) {
    throw "Runner not found: $runner"
}
if ($Mode -ne "self-test" -and [string]::IsNullOrWhiteSpace($env:GOOGLE_APPLICATION_CREDENTIALS)) {
    throw "GOOGLE_APPLICATION_CREDENTIALS is required"
}

if ($Mode -eq "self-test") {
    & $PythonExecutable $runner self-test
} else {
    & $PythonExecutable $runner $Mode --route $Route
}
exit $LASTEXITCODE
