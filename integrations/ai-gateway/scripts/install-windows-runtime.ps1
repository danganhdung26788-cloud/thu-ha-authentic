$ErrorActionPreference = 'Stop'

$WorkerDir = Split-Path -Parent $PSScriptRoot
$NodePath = (Get-Command node.exe -ErrorAction Stop).Source
$RuntimeDir = Join-Path $WorkerDir 'runtime'
$DispatcherTask = 'Hermes-AI-Gateway-Dispatcher'
$ApprovalTask = 'Hermes-AI-Gateway-Approval-Processor'
$DispatcherVbs = Join-Path $RuntimeDir 'run-dispatcher-hidden.vbs'
$ApprovalVbs = Join-Path $RuntimeDir 'run-approval-hidden.vbs'

foreach ($path in @(
    (Join-Path $WorkerDir '.env'),
    (Join-Path $WorkerDir 'src\worker.js'),
    (Join-Path $WorkerDir 'src\run-with-log-rotation.js'),
    (Join-Path $WorkerDir 'src\approval-processor.js')
)) {
    if (-not (Test-Path $path)) { throw "Missing runtime file: $path" }
}

New-Item -ItemType Directory -Path $RuntimeDir -Force | Out-Null
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

$ApprovalCommand = 'cmd.exe /d /s /c "cd /d ""{0}"" && ""{1}"" --env-file="".env"" ""src\approval-processor.js"" >> ""runtime\approval.log"" 2>&1"' -f `
    $WorkerDir,
    $NodePath

$DispatcherVbsContent = @"
Option Explicit
Dim shell
Set shell = CreateObject("WScript.Shell")
shell.CurrentDirectory = "$WorkerDir"
shell.Run Chr(34) & "$NodePath" & Chr(34) & " --env-file=" & Chr(34) & ".env" & Chr(34) & " " & Chr(34) & "src\run-with-log-rotation.js" & Chr(34), 0, False
"@

$ApprovalEscaped = $ApprovalCommand.Replace('"', '""')
$ApprovalVbsContent = @"
Option Explicit
Dim shell
Set shell = CreateObject("WScript.Shell")
shell.CurrentDirectory = "$WorkerDir"
shell.Run "$ApprovalEscaped", 0, True
"@

[System.IO.File]::WriteAllText($DispatcherVbs, $DispatcherVbsContent, $Utf8NoBom)
[System.IO.File]::WriteAllText($ApprovalVbs, $ApprovalVbsContent, $Utf8NoBom)

foreach ($taskName in @($DispatcherTask, $ApprovalTask)) {
    if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
        Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
        Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    }
}

$UserId = "$env:USERDOMAIN\$env:USERNAME"
$Principal = New-ScheduledTaskPrincipal -UserId $UserId -LogonType Interactive -RunLevel Limited
$Settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero)

$DispatcherAction = New-ScheduledTaskAction `
    -Execute "$env:WINDIR\System32\wscript.exe" `
    -Argument "`"$DispatcherVbs`"" `
    -WorkingDirectory $WorkerDir
$DispatcherTrigger = New-ScheduledTaskTrigger -AtLogOn -User $UserId
Register-ScheduledTask `
    -TaskName $DispatcherTask `
    -Action $DispatcherAction `
    -Trigger $DispatcherTrigger `
    -Principal $Principal `
    -Settings $Settings `
    -Description 'Hermes AI Gateway Dispatcher G0.4' `
    -Force | Out-Null

$ApprovalAction = New-ScheduledTaskAction `
    -Execute "$env:WINDIR\System32\wscript.exe" `
    -Argument "`"$ApprovalVbs`"" `
    -WorkingDirectory $WorkerDir
$ApprovalTrigger = New-ScheduledTaskTrigger `
    -Once `
    -At (Get-Date).AddMinutes(1) `
    -RepetitionInterval (New-TimeSpan -Minutes 1) `
    -RepetitionDuration (New-TimeSpan -Days 3650)
Register-ScheduledTask `
    -TaskName $ApprovalTask `
    -Action $ApprovalAction `
    -Trigger $ApprovalTrigger `
    -Principal $Principal `
    -Settings $Settings `
    -Description 'Hermes AI Gateway Approval Processor G0.4' `
    -Force | Out-Null

Start-ScheduledTask -TaskName $DispatcherTask
Start-ScheduledTask -TaskName $ApprovalTask
Start-Sleep -Seconds 20

& (Join-Path $PSScriptRoot 'runtime-health-check.ps1')
