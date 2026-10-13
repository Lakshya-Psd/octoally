<#
.SYNOPSIS
  OctoAlly uninstaller for native Windows.

.DESCRIPTION
  Stops the server, removes the login auto-start, removes this checkout's bin
  folder from your user PATH and deletes %USERPROFILE%\.octoally\install.json.
  Asks before deleting your OctoAlly data (%USERPROFILE%\.octoally - database,
  settings); the default answer is No. This checkout itself is never deleted.

  Compatible with Windows PowerShell 5.1. Keep this file ASCII-only.

.PARAMETER KeepData
  Keep %USERPROFILE%\.octoally without asking.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\uninstall.ps1
#>
[CmdletBinding()]
param(
  [switch]$KeepData
)

$ErrorActionPreference = 'Continue'

$InstallDir = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$BinDir = Join-Path $InstallDir 'bin'
$Cli = Join-Path $BinDir 'octoally-win.mjs'
$DataDir = Join-Path $env:USERPROFILE '.octoally'
$InstallJson = Join-Path $DataDir 'install.json'

function Write-Tag([ConsoleColor]$Color, [string]$Message) {
  Write-Host '[OctoAlly] ' -ForegroundColor $Color -NoNewline
  Write-Host $Message
}
function Log-Info([string]$Message) { Write-Tag Cyan $Message }
function Log-Ok([string]$Message) { Write-Tag Green $Message }
function Log-Warn([string]$Message) { Write-Tag Yellow $Message }

# --- PATH helpers (HKCU\Environment, keeps REG_EXPAND_SZ entries intact) ------

function Get-UserPathRaw {
  $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $false)
  if ($null -eq $key) { return '' }
  try {
    $value = $key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    if ($null -eq $value) { return '' }
    return [string]$value
  } finally {
    $key.Close()
  }
}

function Send-EnvironmentChange {
  try {
    if (-not ('OctoAlly.NativeMethods' -as [type])) {
      Add-Type -Namespace OctoAlly -Name NativeMethods -MemberDefinition @'
[DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);
'@
    }
    $result = [UIntPtr]::Zero
    [void][OctoAlly.NativeMethods]::SendMessageTimeout([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$result)
  } catch { }
}

function Test-SamePath([string]$Entry, [string]$Dir) {
  if ([string]::IsNullOrWhiteSpace($Entry)) { return $false }
  $a = [Environment]::ExpandEnvironmentVariables($Entry.Trim()).TrimEnd('\').ToLowerInvariant()
  $b = $Dir.Trim().TrimEnd('\').ToLowerInvariant()
  return ($a -eq $b)
}

# Removes $Dir from the user PATH and this session. Returns $true if the user PATH changed.
function Remove-FromUserPath([string]$Dir) {
  $raw = Get-UserPathRaw
  $parts = @($raw -split ';' | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
  $kept = @($parts | Where-Object { -not (Test-SamePath $_ $Dir) })
  $changed = $false
  if ($kept.Count -ne $parts.Count) {
    $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')
    try {
      # Keep the existing value type (REG_SZ / REG_EXPAND_SZ).
      $kind = [Microsoft.Win32.RegistryValueKind]::ExpandString
      try { $kind = $key.GetValueKind('Path') } catch { }
      if ($kind -ne [Microsoft.Win32.RegistryValueKind]::String) { $kind = [Microsoft.Win32.RegistryValueKind]::ExpandString }
      $key.SetValue('Path', ($kept -join ';'), $kind)
    } finally {
      $key.Close()
    }
    Send-EnvironmentChange
    $changed = $true
  }
  $env:Path = (@($env:Path -split ';' | Where-Object { $_ -and -not (Test-SamePath $_ $Dir) })) -join ';'
  return $changed
}

# --- Main -------------------------------------------------------------------------

Write-Host ''
Write-Host 'OctoAlly Uninstaller (Windows)' -ForegroundColor White
Write-Host "  Install dir: $InstallDir (kept - delete it yourself if you want it gone)"
Write-Host ''

# Find node: install.json first, then PATH, then Program Files.
$nodeExe = $null
try {
  $info = [IO.File]::ReadAllText($InstallJson) | ConvertFrom-Json
  if ($info.node -and (Test-Path -LiteralPath $info.node)) { $nodeExe = [string]$info.node }
} catch { }
if (-not $nodeExe) {
  $nodeCmd = Get-Command node.exe -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($nodeCmd) { $nodeExe = $nodeCmd.Source }
}
if (-not $nodeExe) {
  $pfNode = Join-Path $env:ProgramFiles 'nodejs\node.exe'
  if (Test-Path -LiteralPath $pfNode) { $nodeExe = $pfNode }
}

if ($nodeExe -and (Test-Path -LiteralPath $Cli)) {
  Log-Info 'Stopping the server...'
  & $nodeExe $Cli stop
  Log-Info 'Removing login auto-start...'
  & $nodeExe $Cli uninstall-service
} else {
  Log-Warn 'Node.js or the CLI was not found - skipping server stop.'
  & reg.exe delete 'HKCU\Software\Microsoft\Windows\CurrentVersion\Run' /v OctoAlly /f 2>$null | Out-Null
}

if (Remove-FromUserPath $BinDir) {
  Log-Ok "Removed $BinDir from your user PATH"
} else {
  Log-Info "$BinDir was not on your user PATH"
}

if (Test-Path -LiteralPath $InstallJson) {
  Remove-Item -LiteralPath $InstallJson -Force
  Log-Ok "Deleted $InstallJson"
}

if (Test-Path -LiteralPath $DataDir) {
  $deleteData = $false
  if (-not $KeepData) {
    try {
      $answer = Read-Host "Also delete your OctoAlly data (database, settings) in $DataDir? [y/N]"
      if ($answer -match '^(y|yes)$') { $deleteData = $true }
    } catch {
      $deleteData = $false
    }
  }
  if ($deleteData) {
    Remove-Item -LiteralPath $DataDir -Recurse -Force
    Log-Ok "Deleted $DataDir"
  } else {
    Log-Info "Kept your data in $DataDir"
  }
}

Write-Host ''
Log-Ok 'OctoAlly has been uninstalled.'
Write-Host '  Not removed:'
Write-Host "    - This checkout: $InstallDir"
Write-Host "    - Running terminal sessions (winmux daemon). End them with: node `"$Cli`" mux kill-server"
Write-Host '    - The desktop app, if you installed it: Settings > Apps > Installed apps > OctoAlly'
Write-Host '    - Claude Code / Codex and %USERPROFILE%\.local\bin on PATH'
Write-Host ''
exit 0
