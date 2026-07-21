#Requires -RunAsAdministrator

param(
    [string]$ContainerName = "hermes-tha-cloudflared-named"
)

$ErrorActionPreference = "Stop"
$exists = docker ps -a --filter "name=^/$ContainerName$" --format "{{.Names}}"

if ($exists -ne $ContainerName) {
    Write-Host "NO_CHANGE: named tunnel container does not exist"
    exit 0
}

docker rm -f $ContainerName | Out-Null
if ($LASTEXITCODE -ne 0) {
    throw "Could not remove named tunnel container."
}

Write-Host "PASS: named Cloudflare Tunnel container removed"
Write-Host "CONTAINER_NAME=$ContainerName"
Write-Host "TOKEN_FILE_PRESERVED=TRUE"
