[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("Stop", "Install", "Launch", "Status")]
  [string]$Action,

  [string]$InstallerPath,

  [ValidateRange(1, 300)]
  [int]$LaunchTimeoutSeconds = 60,

  [ValidateRange(1, 30)]
  [int]$LaunchStabilitySeconds = 3
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

    $localInstaller = Join-Path ([IO.Path]::GetTempPath()) "t3code-fork-$([guid]::NewGuid()).exe"
    try {
      Copy-Item -LiteralPath $InstallerPath -Destination $localInstaller
      $installer = Start-Process -FilePath $localInstaller -ArgumentList "/S" -Wait -PassThru
      if ($installer.ExitCode -ne 0) {
        throw "T3 Code installer failed with exit code $($installer.ExitCode)."
      }
    } finally {
      Remove-Item -LiteralPath $localInstaller -Force -ErrorAction SilentlyContinue
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

    $deadline = [DateTime]::UtcNow.AddSeconds($LaunchTimeoutSeconds)
    $attempt = 0
    while ([DateTime]::UtcNow -lt $deadline) {
      $processes = Get-T3Processes
      if ($processes.Count -eq 0) {
        $attempt++
        $process = Start-Process -FilePath $installedExe -PassThru
        Write-Output "Launched T3 Code process $($process.Id) (attempt $attempt)."
      } elseif ($attempt -eq 0) {
        Write-Output "T3 Code is already running."
      }

      $stabilityDeadline = [DateTime]::UtcNow.AddSeconds($LaunchStabilitySeconds)
      while ([DateTime]::UtcNow -lt $stabilityDeadline) {
        if ((Get-T3Processes).Count -eq 0) {
          break
        }
        Start-Sleep -Milliseconds 250
      }

      $processes = Get-T3Processes
      if ($processes.Count -gt 0) {
        Write-Output "T3 Code remained running for $LaunchStabilitySeconds seconds."
        break
      }

      Write-Output "T3 Code exited during startup; waiting for installer cleanup before retrying."
      Start-Sleep -Seconds 1
    }

    if ((Get-T3Processes).Count -eq 0) {
      throw "T3 Code did not remain running within $LaunchTimeoutSeconds seconds."
    }
  }

  "Status" {
    [pscustomobject]@{
      executable = $installedExe
      installed = Test-Path -LiteralPath $installedExe
      processes = @(Get-T3Processes | ForEach-Object { [int]$_.ProcessId })
    } | ConvertTo-Json -Compress
  }
}
