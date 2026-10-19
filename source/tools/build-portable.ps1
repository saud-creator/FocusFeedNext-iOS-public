<#
.SYNOPSIS
    Build the single-EXE portable Focus Feed Next release.

.DESCRIPTION
    The Tauri release executable contains the frontend resources. This script
    copies that executable into a versioned portable folder, creates a shortcut
    beside it, and records the SHA-256 hash. The application itself owns no
    durable AppData profile in portable mode; its per-run storage is cleaned by
    the executable.

    A Desktop shortcut is opt-in because it writes outside the repository. When
    the portable folder is moved, run this script again (or use -DesktopShortcut)
    so the absolute shortcut target is refreshed.

.PARAMETER DesktopShortcut
    Also create or refresh a shortcut on the current user's Desktop.

.PARAMETER TaskbarShortcut
    Also create or refresh the existing Focus Feed Next taskbar shortcut.

.PARAMETER SkipChecks
    Skip the frontend check and native release build. Use only when the
    release executable has already been built and you intentionally want to
    repackage it.
#>
[CmdletBinding()]
param(
    [switch]$DesktopShortcut,
    [switch]$TaskbarShortcut,
    [switch]$SkipChecks
)

$ErrorActionPreference = "Stop"

# The managed Windows PowerShell host on this machine can write a Shell link
# whose PIDL points at its sandbox profile alias. Prefer the bundled/current
# PowerShell 7 host when available; it preserves the real user-profile target.
if ($PSEdition -eq "Desktop") {
    $pwshCommand = (Get-Command pwsh.exe -ErrorAction SilentlyContinue |
        Select-Object -First 1).Source
    if (-not [string]::IsNullOrWhiteSpace($pwshCommand)) {
        $forwardArgs = @()
        if ($DesktopShortcut) { $forwardArgs += "-DesktopShortcut" }
        if ($TaskbarShortcut) { $forwardArgs += "-TaskbarShortcut" }
        if ($SkipChecks) { $forwardArgs += "-SkipChecks" }
        & $pwshCommand -NoProfile -ExecutionPolicy Bypass -File $PSCommandPath @forwardArgs
        exit $LASTEXITCODE
    }
}

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = (Resolve-Path (Join-Path $scriptRoot "..")).Path
$packagePath = Join-Path $repoRoot "package.json"
$lockPath = Join-Path $repoRoot "package-lock.json"
$cargoPath = Join-Path $repoRoot "src-tauri\Cargo.toml"
$tauriPath = Join-Path $repoRoot "src-tauri\tauri.conf.json"

$package = Get-Content -LiteralPath $packagePath -Raw | ConvertFrom-Json
$lockText = Get-Content -LiteralPath $lockPath -Raw
$lockVersionMatch = [regex]::Match(
    $lockText,
    '(?m)^\s*"version"\s*:\s*"([^"]+)"'
)
$lockRootVersionMatch = [regex]::Match(
    $lockText,
    '(?s)""\s*:\s*\{\s*"name"\s*:\s*"[^"]+"\s*,\s*"version"\s*:\s*"([^"]+)"'
)
$tauri = Get-Content -LiteralPath $tauriPath -Raw | ConvertFrom-Json
$packageVersion = [string]$package.version
$lockVersion = $lockVersionMatch.Groups[1].Value
$lockRootVersion = $lockRootVersionMatch.Groups[1].Value
$tauriVersion = [string]$tauri.version
$cargoVersion = (Select-String -LiteralPath $cargoPath -Pattern '^version\s*=\s*"([^"]+)"' | Select-Object -First 1).Matches.Groups[1].Value

if ([string]::IsNullOrWhiteSpace($packageVersion) -or
    $packageVersion -ne $lockVersion -or
    $packageVersion -ne $lockRootVersion -or
    $packageVersion -ne $tauriVersion -or
    $packageVersion -ne $cargoVersion) {
    throw "Version mismatch: package.json=$packageVersion, package-lock.json=$lockVersion/$lockRootVersion, Cargo.toml=$cargoVersion, tauri.conf.json=$tauriVersion. Update every version source before packaging."
}

if (-not $SkipChecks) {
    Push-Location $repoRoot
    try {
        Write-Host "Running frontend checks..."
        & npm.cmd run check
        if ($LASTEXITCODE -ne 0) { throw "Frontend checks failed." }

        Write-Host "Building the Tauri release executable..."
        # Portable distribution needs the release executable only. Installer
        # bundling is intentionally skipped here because it is a separate
        # release lane and can fail on machines without a working WiX toolchain.
        & npm.cmd run tauri -- build --no-bundle
        if ($LASTEXITCODE -ne 0) { throw "Tauri release build failed." }
    }
    finally {
        Pop-Location
    }
}

$sourceExe = Join-Path $repoRoot "src-tauri\target\release\focus-feed-next.exe"
if (-not (Test-Path -LiteralPath $sourceExe -PathType Leaf)) {
    throw "Release executable not found at $sourceExe. Run without -SkipChecks first."
}

$releaseRoot = Join-Path $repoRoot "dist-portable"
$portableDir = Join-Path $releaseRoot ("FocusFeedNext-v{0}" -f $packageVersion)
New-Item -ItemType Directory -Path $portableDir -Force | Out-Null

$portableExe = Join-Path $portableDir "FocusFeedNext.exe"
Copy-Item -LiteralPath $sourceExe -Destination $portableExe -Force

function ConvertTo-ShortcutPath([string]$Target) {
    # Keep the real absolute path. The managed Windows PowerShell host can
    # materialize an old sandbox PIDL when a Shell link is updated through a
    # short path; the full path is written by the PowerShell 7 host selected
    # above and is verified after Save().
    return [IO.Path]::GetFullPath($Target)
}

function New-FocusFeedShortcut([string]$Path, [string]$Target) {
    $shortcutTarget = ConvertTo-ShortcutPath -Target $Target
    $workingDirectory = ConvertTo-ShortcutPath -Target (Split-Path -Parent $Target)
    # Delete the exact old link before creating a fresh Shell object. Updating
    # an existing .lnk in place can preserve a stale Shell PIDL from the
    # managed build profile, which makes the target look like
    # C:\Users\CodexSandboxOffline outside this session. Do not set IconLocation:
    # WScript can canonicalize that field through the same temporary profile
    # even when TargetPath is correct.
    if (Test-Path -LiteralPath $Path -PathType Leaf) {
        [IO.File]::Delete($Path)
    }
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($Path)
    $shortcut.TargetPath = $shortcutTarget
    $shortcut.WorkingDirectory = $workingDirectory
    $shortcut.Description = "Focus Feed Next v$packageVersion (portable)"
    $shortcut.Save()

    # In this managed host, WScript's post-save TargetPath property resolves
    # the Shell PIDL through C:\Users\CodexSandboxOffline even though the raw
    # link contains the real path. Validate the persisted path bytes rather
    # than accepting that host-specific virtual profile alias.
    $bytes = [IO.File]::ReadAllBytes($Path)
    $ascii = [Text.Encoding]::ASCII.GetString($bytes)
    $unicode = [Text.Encoding]::Unicode.GetString($bytes)
    if (-not $ascii.Contains($shortcutTarget) -and -not $unicode.Contains($shortcutTarget)) {
        throw "Shortcut file does not contain the real target after saving ${Path}: $shortcutTarget"
    }
    if (-not $ascii.Contains($workingDirectory) -and -not $unicode.Contains($workingDirectory)) {
        throw "Shortcut file does not contain the real working directory after saving ${Path}: $workingDirectory"
    }
}

$localShortcut = Join-Path $portableDir "FocusFeedNext.lnk"
New-FocusFeedShortcut -Path $localShortcut -Target $portableExe

if ($DesktopShortcut) {
    $desktop = [Environment]::GetFolderPath("Desktop")
    if ([string]::IsNullOrWhiteSpace($desktop)) {
        throw "Windows did not return a Desktop path; the Desktop shortcut was not created."
    }
    New-FocusFeedShortcut -Path (Join-Path $desktop "FocusFeedNext.lnk") -Target $portableExe
}

if ($TaskbarShortcut) {
    $applicationData = [Environment]::GetFolderPath("ApplicationData")
    if ([string]::IsNullOrWhiteSpace($applicationData)) {
        throw "Windows did not return the user's application-data path; the taskbar shortcut was not refreshed."
    }
    $taskbarDir = Join-Path $applicationData "Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar"
    if (-not (Test-Path -LiteralPath $taskbarDir -PathType Container)) {
        throw "The user's taskbar pin directory was not found at $taskbarDir."
    }
    New-FocusFeedShortcut -Path (Join-Path $taskbarDir "Focus Feed Next.lnk") -Target $portableExe
}

function Get-Sha256([string]$Path) {
    # Some managed Windows PowerShell hosts omit the Microsoft.PowerShell.Utility
    # module, so Get-FileHash is not guaranteed to exist. The .NET primitive is
    # present in the same host and streams the EXE without loading it all into
    # the PowerShell process.
    $algorithm = [System.Security.Cryptography.SHA256]::Create()
    $stream = [System.IO.File]::OpenRead($Path)
    try {
        return ([BitConverter]::ToString($algorithm.ComputeHash($stream))).Replace('-', '').ToLowerInvariant()
    }
    finally {
        $stream.Dispose()
        $algorithm.Dispose()
    }
}

$hash = Get-Sha256 -Path $portableExe
Set-Content -LiteralPath (Join-Path $portableDir "SHA256.txt") -Value "$hash  FocusFeedNext.exe" -Encoding utf8

# Keep the portable release directory deterministic: only the newly built
# version remains. Limit deletion to versioned FocusFeedNext release folders
# directly below dist-portable; source files and unrelated user files are not
# candidates for cleanup.
$releaseRootPrefix = "$releaseRoot\"
$versionedReleasePattern = '^FocusFeedNext-v\d+\.\d+\.\d+(?:-[^\\]+)?$'
$removedReleaseDirs = @(
    Get-ChildItem -LiteralPath $releaseRoot -Directory -Force |
        Where-Object {
            $_.FullName.StartsWith($releaseRootPrefix, [StringComparison]::OrdinalIgnoreCase) -and
            $_.FullName -ne $portableDir -and
            $_.Name -match $versionedReleasePattern
        }
)
foreach ($oldReleaseDir in $removedReleaseDirs) {
    Remove-Item -LiteralPath $oldReleaseDir.FullName -Recurse -Force
}

Write-Host ""
Write-Host "Portable release: $portableDir"
Write-Host "Executable      : $portableExe"
Write-Host "Shortcut        : $localShortcut"
Write-Host "Version         : v$packageVersion (shown in Settings > About)"
Write-Host "SHA-256         : $hash"
if ($DesktopShortcut) {
    Write-Host "Desktop shortcut: refreshed"
}
if ($TaskbarShortcut) {
    Write-Host "Taskbar shortcut: refreshed"
}
if ($removedReleaseDirs.Count -gt 0) {
    Write-Host "Old releases removed: $($removedReleaseDirs.Name -join ', ')"
}
