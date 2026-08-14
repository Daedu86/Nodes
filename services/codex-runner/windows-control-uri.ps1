param(
  [Parameter(Mandatory = $true)]
  [string]$Uri,
  [string]$RunnerTaskName = "Nodes AI Canvas Codex Runner",
  [string]$NgrokTaskName = "Nodes AI Canvas ngrok Tunnel",
  [int]$RunnerPort = 8787,
  [int]$NgrokInspectPort = 4040
)

$ErrorActionPreference = "Stop"

try {
  $parsed = [System.Uri]$Uri
  if ($parsed.Scheme -ne "nodes-runner") {
    throw "Unsupported launcher protocol."
  }
  $action = $parsed.Host.ToLowerInvariant()
} catch {
  exit 2
}

function Start-NodesTask {
  param([string]$TaskName)
  if (-not (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue)) {
    throw "Scheduled task '$TaskName' is not installed."
  }
  Start-ScheduledTask -TaskName $TaskName
}

function Stop-NodesTask {
  param([string]$TaskName)
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  }
}

function Stop-ProcessOnPort {
  param([int]$Port)
  Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty OwningProcess -Unique |
    ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }
}

function Stop-NodesServices {
  Stop-NodesTask -TaskName $NgrokTaskName
  Stop-NodesTask -TaskName $RunnerTaskName
  Stop-ProcessOnPort -Port $NgrokInspectPort
  Stop-ProcessOnPort -Port $RunnerPort
}

switch ($action) {
  "start" {
    Start-NodesTask -TaskName $RunnerTaskName
    Start-NodesTask -TaskName $NgrokTaskName
  }
  "stop" {
    Stop-NodesServices
  }
  "restart" {
    Stop-NodesServices
    Start-Sleep -Milliseconds 500
    Start-NodesTask -TaskName $RunnerTaskName
    Start-NodesTask -TaskName $NgrokTaskName
  }
  default { exit 2 }
}
