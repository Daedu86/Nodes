param(
  [string]$RunnerTaskName = "Nodes AI Canvas Codex Runner",
  [string]$NgrokTaskName = "Nodes AI Canvas ngrok Tunnel"
)

$ErrorActionPreference = "Stop"

function Remove-NodesTask {
  param([string]$TaskName)

  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if (-not $task) {
    Write-Host "Scheduled task '$TaskName' is not installed."
    return
  }

  try {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  } catch {
    # The task may already be stopped.
  }

  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Host "Removed '$TaskName'."
}

Remove-NodesTask -TaskName $RunnerTaskName
Remove-NodesTask -TaskName $NgrokTaskName
$protocolRoot = "HKCU:\Software\Classes\nodes-runner"
if (Test-Path $protocolRoot) {
  Remove-Item -Path $protocolRoot -Recurse -Force
  Write-Host "Removed the nodes-runner:// Agent Work launcher."
}
Write-Host "Codex runner and ngrok will no longer start automatically."
