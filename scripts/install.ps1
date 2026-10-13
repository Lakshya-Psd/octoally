<#
.SYNOPSIS
  OctoAlly installer for native Windows (no WSL needed).

.DESCRIPTION
  Installs dependencies and builds OctoAlly inside this checkout, puts the
  `octoally` CLI on your user PATH, writes %USERPROFILE%\.octoally\install.json
  (read by the desktop app) and starts the server.

  Compatible with Windows PowerShell 5.1. Keep this file ASCII-only: PowerShell
  5.1 reads BOM-less scripts with the ANSI code page.

.PARAMETER NoStart
  Do not start the server or open the dashboard at the end.

.PARAMETER Service
  Start OctoAlly automatically at login (HKCU Run key, no admin needed).

.PARAMETER Desktop
  Also build the Electron desktop app installer (.exe). It is not run for you.

.PARAMETER SkipBuild
  Skip "npm run build" (dependencies are still installed).

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install.ps1 -Service
#>
[CmdletBinding()]
param(
  [switch]$NoStart,
  [switch]$Service,
  [switch]$Desktop,
  [switch]$SkipBuild
)

# Native tools (npm, git) write progress to stderr; with 'Stop' PowerShell 5.1
# can turn that into terminating errors. We check $LASTEXITCODE instead.
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'

$InstallDir = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$BinDir = Join-Path $InstallDir 'bin'
$Cli = Join-Path $BinDir 'octoally-win.mjs'
$ServerDir = Join-Path $InstallDir 'server'
$DashboardDir = Join-Path $InstallDir 'dashboard'
$DesktopDir = Join-Path $InstallDir 'desktop-electron'
$DataDir = Join-Path $env:USERPROFILE '.octoally'
$InstallJson = Join-Path $DataDir 'install.json'
$LocalBin = Join-Path $env:USERPROFILE '.local\bin'
$TotalSteps = 6
$Utf8NoBom = New-Object System.Text.UTF8Encoding $false

# --- Output helpers -----------------------------------------------------------

function Write-Tag([ConsoleColor]$Color, [string]$Message) {
  Write-Host '[OctoAlly] ' -ForegroundColor $Color -NoNewline
  Write-Host $Message
}
function Log-Info([string]$Message) { Write-Tag Cyan $Message }
function Log-Ok([string]$Message) { Write-Tag Green $Message }
function Log-Warn([string]$Message) { Write-Tag Yellow $Message }
function Log-Error([string]$Message) { Write-Tag Red $Message }
function Log-Step([int]$Number, [string]$Message) {
  Write-Host ''
  Write-Host "[$Number/$TotalSteps] $Message" -ForegroundColor White
}

# --- npm helper -----------------------------------------------------------------

# Runs npm in a folder. Sets $script:NpmExit (output goes straight to the console).
function Invoke-Npm([string]$Dir, [string[]]$NpmArgs) {
  $script:NpmExit = 1
  Push-Location -LiteralPath $Dir
  try {
    & $script:NpmCmd @NpmArgs
    $script:NpmExit = $LASTEXITCODE
  } finally {
    Pop-Location
  }
}

function Test-NativeModules {
  Push-Location -LiteralPath $ServerDir
  try {
    & $script:NodeExe -e "require('better-sqlite3'); require('node-pty')" 2>$null | Out-Null
    return ($LASTEXITCODE -eq 0)
  } catch {
    return $false
  } finally {
    Pop-Location
  }
}

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
  # Tell Explorer (and new terminals it starts) that the environment changed.
  try {
    if (-not ('OctoAlly.NativeMethods' -as [type])) {
      Add-Type -Namespace OctoAlly -Name NativeMethods -MemberDefinition @'
[DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);
'@
    }
    $result = [UIntPtr]::Zero
    [void][OctoAlly.NativeMethods]::SendMessageTimeout([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$result)
  } catch {
    # Not fatal: new sign-ins pick up the change anyway.
  }
}

function Set-UserPathRaw([string]$Value) {
  $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')
  try {
    # Keep the existing value type (REG_SZ / REG_EXPAND_SZ); default to REG_EXPAND_SZ.
    $kind = [Microsoft.Win32.RegistryValueKind]::ExpandString
    try {
      if ($null -ne $key.GetValue('Path')) { $kind = $key.GetValueKind('Path') }
    } catch { }
    if ($kind -ne [Microsoft.Win32.RegistryValueKind]::String) { $kind = [Microsoft.Win32.RegistryValueKind]::ExpandString }
    $key.SetValue('Path', $Value, $kind)
  } finally {
    $key.Close()
  }
  Send-EnvironmentChange
}

function Test-PathListContains([string]$List, [string]$Dir) {
  if ([string]::IsNullOrEmpty($List)) { return $false }
  $target = $Dir.Trim().TrimEnd('\').ToLowerInvariant()
  foreach ($entry in ($List -split ';')) {
    if ([string]::IsNullOrWhiteSpace($entry)) { continue }
    $expanded = [Environment]::ExpandEnvironmentVariables($entry.Trim()).TrimEnd('\').ToLowerInvariant()
    if ($expanded -eq $target) { return $true }
  }
  return $false
}

# Adds $Dir to the user PATH (no duplicates) and to this session. Returns $true if the user PATH changed.
function Add-ToUserPath([string]$Dir) {
  $changed = $false
  $raw = Get-UserPathRaw
  if (-not (Test-PathListContains $raw $Dir)) {
    $parts = @($raw -split ';' | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    $parts += $Dir
    Set-UserPathRaw ($parts -join ';')
    $changed = $true
  }
  if (-not (Test-PathListContains $env:Path $Dir)) {
    $env:Path = $env:Path.TrimEnd(';') + ';' + $Dir
  }
  return $changed
}

# --- Banner ---------------------------------------------------------------------

Write-Host ''
Write-Host 'OctoAlly Installer (Windows)' -ForegroundColor White
Write-Host "  Install dir: $InstallDir"

# --- Step 1: Prerequisites --------------------------------------------------------

Log-Step 1 'Checking prerequisites...'

$nodeCmd = Get-Command node.exe -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $nodeCmd) {
  $pfNode = Join-Path $env:ProgramFiles 'nodejs\node.exe'
  if (Test-Path -LiteralPath $pfNode) {
    $env:Path = (Split-Path $pfNode) + ';' + $env:Path
    $nodeCmd = Get-Command node.exe -ErrorAction SilentlyContinue | Select-Object -First 1
  }
}
if (-not $nodeCmd) {
  Log-Error 'Node.js was not found.'
  Write-Host '  OctoAlly needs Node.js 20 or newer. Install the LTS version from:'
  Write-Host '    https://nodejs.org/en/download   (Windows Installer .msi)'
  Write-Host '  or run:  winget install OpenJS.NodeJS.LTS'
  Write-Host '  Then open a NEW terminal and run this installer again.'
  exit 1
}

$script:NodeExe = ([string](& $nodeCmd.Source -p 'process.execPath')).Trim()
if (-not $script:NodeExe -or -not (Test-Path -LiteralPath $script:NodeExe)) { $script:NodeExe = $nodeCmd.Source }
$nodeVersion = ([string](& $script:NodeExe -p 'process.versions.node')).Trim()
$nodeMajor = 0
[void][int]::TryParse(($nodeVersion -split '\.')[0], [ref]$nodeMajor)
if ($nodeMajor -lt 20) {
  Log-Error "Node.js $nodeVersion is too old - OctoAlly needs Node.js 20 or newer."
  Write-Host '  Install the current LTS from https://nodejs.org/en/download'
  Write-Host '  (or: winget install OpenJS.NodeJS.LTS), open a NEW terminal and run this installer again.'
  exit 1
}
Log-Ok "Node.js v$nodeVersion ($script:NodeExe)"

$script:NpmCmd = Join-Path (Split-Path $script:NodeExe) 'npm.cmd'
if (-not (Test-Path -LiteralPath $script:NpmCmd)) {
  $npmFound = Get-Command npm.cmd -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($npmFound) { $script:NpmCmd = $npmFound.Source } else { $script:NpmCmd = $null }
}
if (-not $script:NpmCmd) {
  Log-Error 'npm was not found next to Node.js. Reinstall Node.js from https://nodejs.org and try again.'
  exit 1
}
$npmVersion = ([string](& $script:NpmCmd --version 2>$null)).Trim()
Log-Ok "npm v$npmVersion"

$gitCmd = Get-Command git.exe -ErrorAction SilentlyContinue | Select-Object -First 1
if ($gitCmd) {
  Log-Ok 'git found'
} else {
  Log-Warn "git not found - 'octoally update' needs it (https://git-scm.com/download/win)"
}

$claudeCmd = Get-Command claude -ErrorAction SilentlyContinue | Select-Object -First 1
$claudeLocal = Join-Path $LocalBin 'claude.exe'
if ($claudeCmd) {
  Log-Ok "Claude Code found ($($claudeCmd.Source))"
} elseif (Test-Path -LiteralPath $claudeLocal) {
  Log-Ok "Claude Code found ($claudeLocal)"
} else {
  Log-Warn 'Claude Code was not found. Install it with:'
  Write-Host '    irm https://claude.ai/install.ps1 | iex'
}

$codexCmd = Get-Command codex -ErrorAction SilentlyContinue | Select-Object -First 1
if ($codexCmd) {
  Log-Ok "Codex CLI found ($($codexCmd.Source))"
} else {
  Log-Info 'Codex CLI not found (optional): npm install -g @openai/codex'
}

# --- Step 2: Dependencies ----------------------------------------------------------

Log-Step 2 'Installing dependencies...'

Log-Info 'Installing server dependencies (native modules: better-sqlite3, node-pty)...'
Invoke-Npm $ServerDir @('install', '--no-audit', '--no-fund')
if ($script:NpmExit -ne 0) {
  # node-gyp can exit non-zero after a successful build; accept it if the
  # native modules actually load (same rule as install.sh).
  if (Test-NativeModules) {
    Log-Warn "npm install exited with $script:NpmExit, but native modules load - continuing"
  } else {
    Log-Error "Server dependency install failed (npm exit code $script:NpmExit) - see the errors above."
    exit 1
  }
}
Log-Ok 'Server dependencies installed'

Log-Info 'Installing dashboard dependencies...'
Invoke-Npm $DashboardDir @('install', '--no-audit', '--no-fund')
if ($script:NpmExit -ne 0) {
  Log-Error "Dashboard dependency install failed (npm exit code $script:NpmExit) - see the errors above."
  exit 1
}
Log-Ok 'Dashboard dependencies installed'

# --- Step 3: Build -------------------------------------------------------------------

Log-Step 3 'Building...'

if ($SkipBuild) {
  Log-Info 'Skipping build (-SkipBuild)'
} else {
  Log-Info 'Building dashboard...'
  Invoke-Npm $DashboardDir @('run', 'build')
  if ($script:NpmExit -ne 0) {
    Log-Error "Dashboard build failed (npm exit code $script:NpmExit)."
    exit 1
  }
  Log-Ok 'Dashboard built'

  Log-Info 'Building server...'
  Invoke-Npm $ServerDir @('run', 'build')
  if ($script:NpmExit -ne 0) {
    Log-Error "Server build failed (npm exit code $script:NpmExit)."
    exit 1
  }
  Log-Ok 'Server built'
}

# --- Step 4: CLI, config, PATH ---------------------------------------------------------

Log-Step 4 'Installing CLI...'

$logsDir = Join-Path $InstallDir 'logs'
if (-not (Test-Path -LiteralPath $logsDir)) { New-Item -ItemType Directory -Path $logsDir -Force | Out-Null }

# Install-local config (same keys as the bash CLI: channel, local_version)
$configFile = Join-Path $InstallDir '.octoally'
if (-not (Test-Path -LiteralPath $configFile)) {
  $appVersion = 'unknown'
  try {
    $pkg = [IO.File]::ReadAllText((Join-Path $InstallDir 'package.json')) | ConvertFrom-Json
    if ($pkg.version) { $appVersion = [string]$pkg.version }
  } catch { }
  $config = [ordered]@{ channel = 'stable'; local_version = $appVersion } | ConvertTo-Json
  [IO.File]::WriteAllText($configFile, $config, $Utf8NoBom)
  Log-Ok "Created $configFile"
}

# %USERPROFILE%\.octoally\install.json - how the desktop app finds the CLI
if (-not (Test-Path -LiteralPath $DataDir)) { New-Item -ItemType Directory -Path $DataDir -Force | Out-Null }
$installInfo = [ordered]@{
  installDir  = ($InstallDir -replace '\\', '/')
  cli         = ($Cli -replace '\\', '/')
  node        = ($script:NodeExe -replace '\\', '/')
  installedAt = (Get-Date).ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", [Globalization.CultureInfo]::InvariantCulture)
}
[IO.File]::WriteAllText($InstallJson, ($installInfo | ConvertTo-Json), $Utf8NoBom)
Log-Ok "Wrote $InstallJson"

$pathChanged = $false
if (Add-ToUserPath $BinDir) {
  Log-Ok "Added $BinDir to your user PATH"
  $pathChanged = $true
} else {
  Log-Info "$BinDir is already on your user PATH"
}
if (Test-Path -LiteralPath $LocalBin) {
  if (Add-ToUserPath $LocalBin) {
    Log-Ok "Added $LocalBin to your user PATH (Claude Code)"
    $pathChanged = $true
  }
}
Log-Ok "CLI: $(Join-Path $BinDir 'octoally.cmd')"

# --- Step 5: Optional components -------------------------------------------------------

Log-Step 5 'Optional components...'

$desktopInstaller = $null
$desktopFailed = $false
if ($Desktop) {
  Log-Info 'Installing desktop app dependencies...'
  Invoke-Npm $DesktopDir @('install', '--no-audit', '--no-fund')
  if ($script:NpmExit -eq 0) {
    Log-Info 'Building desktop app installer (electron-builder, this can take a few minutes)...'
    Invoke-Npm $DesktopDir @('run', 'dist:win')
  }
  if ($script:NpmExit -eq 0) {
    $releaseDir = Join-Path $DesktopDir 'release'
    $desktopInstaller = Get-ChildItem -LiteralPath $releaseDir -Filter '*.exe' -File -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -notlike '__*' } |
      Sort-Object LastWriteTime -Descending |
      Select-Object -First 1
    if ($desktopInstaller) {
      Log-Ok "Desktop installer built: $($desktopInstaller.FullName)"
    } else {
      Log-Warn "Desktop build finished but no installer .exe was found in $releaseDir"
    }
  } else {
    $desktopFailed = $true
    Log-Warn "Desktop app build failed (npm exit code $script:NpmExit). The server and CLI are still installed."
    Log-Info "Retry later with: cd `"$DesktopDir`"; npm install; npm run dist:win"
  }
} else {
  Log-Info 'Desktop app: skipped (add -Desktop to build its installer)'
}

if ($Service) {
  & $script:NodeExe $Cli install-service
  if ($LASTEXITCODE -ne 0) { Log-Warn 'Could not install login auto-start (see above).' }
} else {
  Log-Info 'Login auto-start: skipped (add -Service, or run: octoally install-service)'
}

# --- Step 6: Start ------------------------------------------------------------------------

Log-Step 6 'Starting OctoAlly...'

$port = ([string](& $script:NodeExe $Cli port)).Trim()
if (-not $port) { $port = '42010' }
$dashboardUrl = "http://localhost:$port"
$started = $false

if ($NoStart) {
  Log-Info 'Not starting the server (-NoStart). Start it later with: octoally start'
} else {
  & $script:NodeExe $Cli start
  if ($LASTEXITCODE -eq 0) {
    $started = $true
    try { Start-Process $dashboardUrl } catch { Log-Info "Open $dashboardUrl in your browser" }
  } else {
    Log-Warn "The server did not start - check 'octoally logs' and 'octoally status'."
  }
}

# --- Summary --------------------------------------------------------------------------------

$serviceState = ([string](& $script:NodeExe $Cli service-status)).Trim()

Write-Host ''
Log-Ok 'OctoAlly is installed!'
Write-Host ''
Write-Host "  Install dir:  $InstallDir"
Write-Host "  Dashboard:    $dashboardUrl"
Write-Host '  CLI:          octoally start | stop | restart | status | logs | update'
Write-Host "  Auto-start:   $serviceState"
Write-Host "  Data:         $DataDir"
if ($desktopInstaller) {
  Write-Host "  Desktop app:  run the installer to install it:"
  Write-Host "                Start-Process '$($desktopInstaller.FullName)'"
} elseif ($desktopFailed) {
  Write-Host '  Desktop app:  build failed (see above)'
}
Write-Host ''
Write-Host 'Next steps:' -ForegroundColor White
$n = 1
if ($pathChanged) {
  Write-Host "  $n. Open a NEW terminal so the updated PATH is picked up (octoally, claude)."
  $n++
}
Write-Host "  $n. Run Claude Code once interactively to accept its terms and sign in:"
Write-Host '       claude'
Write-Host '     then once more to enable non-interactive agent sessions:'
Write-Host '       claude --dangerously-skip-permissions'
$n++
Write-Host "  $n. For Codex support (optional), run once and sign in:  codex"
$n++
if (-not $started) {
  Write-Host "  $n. Start the server:  octoally start   then open $dashboardUrl"
  $n++
}
Write-Host "  $n. In Git Bash, use 'octoally.cmd <command>' (plain 'octoally' there is the Linux script)."
Write-Host ''
exit 0
