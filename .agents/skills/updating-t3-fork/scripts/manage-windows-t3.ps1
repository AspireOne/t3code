[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("Stop", "Install", "Launch", "Status")]
  [string]$Action,

  [string]$InstallerPath
)

$ErrorActionPreference = "Stop"
$installedExe = Join-Path $env:LOCALAPPDATA "Programs\t3code\T3 Code (Alpha).exe"

function Get-T3Processes {
  @(Get-CimInstance Win32_Process | Where-Object {
    $_.ExecutablePath -and $_.ExecutablePath.Equals(
      $installedExe,
      [System.StringComparison]::OrdinalIgnoreCase
    )
  })
}

switch ($Action) {
  "Stop" {
    $processes = Get-T3Processes
    if ($processes.Count -eq 0) {
      Write-Output "T3 Code is not running."
      break
    }

    $ids = @($processes | ForEach-Object { [int]$_.ProcessId })
    $roots = @($processes | Where-Object { $ids -notcontains [int]$_.ParentProcessId })
    foreach ($root in $roots) {
      $process = Get-Process -Id $root.ProcessId -ErrorAction Stop
      if (-not $process.CloseMainWindow()) {
        throw "T3 Code process $($root.ProcessId) has no closable window. Close it normally and rerun the update."
      }
    }

    $deadline = [DateTime]::UtcNow.AddSeconds(45)
    while ((Get-T3Processes).Count -gt 0 -and [DateTime]::UtcNow -lt $deadline) {
      Start-Sleep -Milliseconds 250
    }
    if ((Get-T3Processes).Count -gt 0) {
      throw "T3 Code did not exit within 45 seconds. It was not force-killed; close it normally and rerun the update."
    }

    Write-Output "T3 Code closed cleanly."
  }

  "Install" {
    if ((Get-T3Processes).Count -gt 0) {
      throw "Refusing to install while T3 Code is running."
    }
    if (-not $InstallerPath -or -not (Test-Path -LiteralPath $InstallerPath)) {
      throw "Installer was not found at $InstallerPath."
    }

    $installer = Start-Process -FilePath $InstallerPath -ArgumentList "/S" -Wait -PassThru
    if ($installer.ExitCode -ne 0) {
      throw "T3 Code installer failed with exit code $($installer.ExitCode)."
    }
    if (-not (Test-Path -LiteralPath $installedExe)) {
      throw "The installed T3 executable was not found at $installedExe."
    }

    Write-Output $installedExe
  }

  "Launch" {
    if (-not (Test-Path -LiteralPath $installedExe)) {
      throw "The installed T3 executable was not found at $installedExe."
    }

    $existing = Get-T3Processes
    if ($existing.Count -gt 0) {
      Write-Output "T3 Code is already running."
      break
    }

    $process = Start-Process -FilePath $installedExe -PassThru
    Write-Output "Launched T3 Code process $($process.Id)."
  }

  "Status" {
    [pscustomobject]@{
      executable = $installedExe
      installed = Test-Path -LiteralPath $installedExe
      processes = @(Get-T3Processes | ForEach-Object { [int]$_.ProcessId })
    } | ConvertTo-Json -Compress
  }
}
