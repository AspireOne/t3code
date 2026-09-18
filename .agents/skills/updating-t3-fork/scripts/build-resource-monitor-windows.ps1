[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$RepoRoot,

  [ValidateSet("x64")]
  [string]$Arch = "x64"
)

$ErrorActionPreference = "Stop"

$vswhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
if (-not (Test-Path -LiteralPath $vswhere)) {
  throw "Visual Studio Installer's vswhere.exe was not found. Install Visual Studio with the MSVC x64 build tools."
}

$visualStudio = & $vswhere `
  -latest `
  -products * `
  -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 `
  -property installationPath
if (-not $visualStudio) {
  throw "Visual Studio with the MSVC x64 build tools was not found."
}

$developerShell = Join-Path $visualStudio "Common7\Tools\VsDevCmd.bat"
$cargo = (Get-Command cargo.exe -ErrorAction Stop).Source
$manifest = "native\resource-monitor\Cargo.toml"
$target = "x86_64-pc-windows-msvc"
# Keep Cargo's many intermediate files on NTFS instead of the WSL UNC share.
# Isolate checkouts; Cargo still validates source, lockfile, flags and toolchain.
$repoHash = [Convert]::ToHexString([System.Security.Cryptography.SHA256]::HashData(
  [System.Text.Encoding]::UTF8.GetBytes($RepoRoot)
)).Substring(0, 16).ToLowerInvariant()
$targetDir = Join-Path $env:LOCALAPPDATA "T3Code\build-cache\resource-monitor\$repoHash"
$cachedOutput = Join-Path $targetDir "$target\release\t3-resource-monitor.exe"
$output = Join-Path $RepoRoot "native\resource-monitor\target\$target\release\t3-resource-monitor.exe"

if (-not (Test-Path -LiteralPath $developerShell)) {
  throw "Visual Studio developer shell was not found at $developerShell."
}
if (-not (Test-Path -LiteralPath $RepoRoot)) {
  throw "Repository root was not found at $RepoRoot."
}

# `pushd` maps the WSL UNC checkout to a temporary drive for cmd.exe. This is
# required because cmd.exe cannot use a UNC path as its current directory.
$command = @(
  "call `"$developerShell`" -no_logo -arch=$Arch -host_arch=x64"
  "pushd `"$RepoRoot`""
  "`"$cargo`" build --locked --release --manifest-path `"$manifest`" --target $target --target-dir `"$targetDir`""
  "popd"
) -join " && "

$previousLocation = Get-Location
try {
  Set-Location $env:SystemRoot
  & $env:ComSpec /d /s /c $command
  $buildExitCode = $LASTEXITCODE
} finally {
  Set-Location $previousLocation
}
if ($buildExitCode -ne 0) {
  throw "Windows resource-monitor build failed with exit code $buildExitCode."
}
if (-not (Test-Path -LiteralPath $cachedOutput)) {
  throw "Windows resource-monitor output was not produced at $cachedOutput."
}
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $output) | Out-Null
Copy-Item -LiteralPath $cachedOutput -Destination $output -Force

Write-Output $output
