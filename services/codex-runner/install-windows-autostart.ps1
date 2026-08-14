param(
  [string]$RunnerTaskName = "Nodes AI Canvas Codex Runner",
  [string]$NgrokTaskName = "Nodes AI Canvas ngrok Tunnel"
)

$ErrorActionPreference = "Stop"
$RunnerDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RunnerSupervisor = Join-Path $RunnerDir "windows-runner.ps1"
$NgrokSupervisor = Join-Path $RunnerDir "windows-ngrok.ps1"
$UriHandler = Join-Path $RunnerDir "windows-control-uri.ps1"
$EnvFile = Join-Path $RunnerDir ".env"

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "Node.js was not found in PATH. Install Node.js 22+ first."
}

if (-not (Get-Command codex -ErrorAction SilentlyContinue)) {
  throw "Codex CLI was not found in PATH. Install Codex CLI first."
}

if (-not (Get-Command ngrok -ErrorAction SilentlyContinue)) {
  throw "ngrok was not found in PATH. Install/configure ngrok first."
}

if (-not (Test-Path $EnvFile)) {
  throw "Missing $EnvFile. Create services/codex-runner/.env before installing autostart."
}

if (-not (Test-Path $NgrokSupervisor)) {
  throw "Missing $NgrokSupervisor. Pull the latest repository changes first."
}

if (-not (Test-Path $UriHandler)) {
  throw "Missing $UriHandler. Pull the latest repository changes first."
}

$currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $currentUser
$principal = New-ScheduledTaskPrincipal -UserId $currentUser -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero)

function Register-NodesTask {
  param(
    [string]$TaskName,
    [string]$ScriptPath
  )

  $escapedScript = $ScriptPath.Replace('"', '\"')
  $actionArgs = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$escapedScript`""
  $action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $actionArgs -WorkingDirectory $RunnerDir
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
  Start-ScheduledTask -TaskName $TaskName
}

Register-NodesTask -TaskName $RunnerTaskName -ScriptPath $RunnerSupervisor
Register-NodesTask -TaskName $NgrokTaskName -ScriptPath $NgrokSupervisor

$protocolRoot = "HKCU:\Software\Classes\nodes-runner"
$protocolCommand = Join-Path $protocolRoot "shell\open\command"
$handlerCommand = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$UriHandler`" `"%1`""
New-Item -Path $protocolCommand -Force | Out-Null
Set-Item -Path $protocolRoot -Value "URL:Nodes AI Canvas Runner"
New-ItemProperty -Path $protocolRoot -Name "URL Protocol" -Value "" -PropertyType String -Force | Out-Null
Set-Item -Path $protocolCommand -Value $handlerCommand

Write-Host "Installed and started '$RunnerTaskName'."
Write-Host "Installed and started '$NgrokTaskName'."
Write-Host "Both services will now start automatically when you sign in to Windows."
Write-Host "Registered the nodes-runner:// launcher for Agent Work controls."
Write-Host "Runner health: http://127.0.0.1:8787/healthz"
Write-Host "ngrok inspect: http://127.0.0.1:4040/api/tunnels"
Write-Host "Logs:          $RunnerDir\.logs"
