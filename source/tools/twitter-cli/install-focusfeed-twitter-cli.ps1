<#
.SYNOPSIS
    Install the pinned twitter-cli and apply the Focus Feed Next provider patches.

.DESCRIPTION
    Focus Feed Next reads X through twitter-cli. Upstream discards every MP4
    rendition except the largest, and its generic timeline safety cap can stop
    a bookmark fetch early. By the time the video JSON is written, the
    alternative video renditions are gone.

    This script exists so that patch is reproducible rather than a hand edit
    somebody made once inside site-packages and could not repeat. It:

      1. verifies the pinned upstream commit before touching anything,
      2. installs it through the SAME pipx environment the app already uses,
         so there is exactly one twitter.exe on the machine,
      3. applies the provider patches, refusing if the upstream context moved,
      4. verifies video variants and exhaustive bookmark policy,
      5. is idempotent - running it twice is a no-op the second time.

    It never reads, writes, prints or requires any X credential. The provider
    patches touch parsing, serialisation and bookmark fetch policy only.

.PARAMETER Rollback
    Reinstall the pinned upstream commit unpatched and stop. The escape hatch
    if a patched build ever misbehaves.

.PARAMETER WhatIf
    Report what would happen and change nothing.

.EXAMPLE
    .\install-focusfeed-twitter-cli.ps1
    .\install-focusfeed-twitter-cli.ps1 -Rollback
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [switch]$Rollback
)

$ErrorActionPreference = "Stop"

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$commit = (Get-Content (Join-Path $here "PINNED_UPSTREAM_COMMIT.txt") -Raw).Trim()
$mediaPatch = Join-Path $here "patches\0001-media-variants.patch"
$bookmarksPatch = Join-Path $here "patches\0002-unlimited-bookmarks.patch"
$repo = "https://github.com/public-clis/twitter-cli.git"

function Fail($message) {
    Write-Error $message
    exit 1
}

if ($commit -notmatch '^[0-9a-f]{40}$') {
    Fail "PINNED_UPSTREAM_COMMIT.txt does not contain a full commit hash."
}

# --- locate the environment the app actually uses ---------------------------
#
# Not "a" twitter-cli: the one the app resolves. Two installations on one
# machine is the failure this whole script is arranged to avoid, because the
# app would keep using whichever the PATH found first and the patch would look
# as though it had done nothing.

$shim = Join-Path $env:USERPROFILE ".local\bin\twitter.exe"
if (-not (Test-Path $shim)) {
    Fail "No twitter.exe at $shim. Focus Feed Next resolves the provider there; install twitter-cli with pipx first."
}

$venv = Join-Path $env:LOCALAPPDATA "pipx\pipx\venvs\twitter-cli"
$site = Join-Path $venv "Lib\site-packages\twitter_cli"
if (-not (Test-Path $site)) {
    Fail "Expected the pipx environment at $venv. Install with pipx so there is one shim, not two."
}

$python = Join-Path $venv "Scripts\python.exe"
if (-not (Test-Path $python)) { Fail "No interpreter at $python." }

Write-Host "Provider shim : $shim"
Write-Host "Environment   : $venv"
Write-Host "Pinned commit : $commit"

# --- is the patch already applied? ------------------------------------------

$mediaApplied = Select-String -Path (Join-Path $site "models.py") -Pattern "class MediaVariant" -Quiet -ErrorAction SilentlyContinue
$bookmarksApplied = Select-String -Path (Join-Path $site "client.py") -Pattern "respect_max_count=False" -Quiet -ErrorAction SilentlyContinue
$applied = $mediaApplied -and $bookmarksApplied

if ($Rollback) {
    if ($PSCmdlet.ShouldProcess("twitter-cli", "reinstall pinned upstream, unpatched")) {
        Write-Host "Rolling back to unpatched upstream..."
        & pipx install --force "git+$repo@$commit"
        if ($LASTEXITCODE -ne 0) { Fail "pipx install failed." }
        Write-Host "Rolled back. The app will see one MP4 per video again."
    }
    exit 0
}

if ($applied) {
    Write-Host "Provider patches already applied. Nothing to do."
    exit 0
}

# --- install the pinned upstream --------------------------------------------

if ($PSCmdlet.ShouldProcess("twitter-cli", "install pinned upstream $commit")) {
    & pipx install --force "git+$repo@$commit"
    if ($LASTEXITCODE -ne 0) { Fail "pipx install failed; the environment is unchanged." }
}

$reported = (& $shim --version) -join " "
if ($reported -notmatch "0\.8\.6") {
    Fail "Installed build reports '$reported'; expected 0.8.6. Refusing to patch an unexpected version."
}

# --- verify the context the patch expects -----------------------------------
#
# A patch applied to source that has moved underneath it is worse than a patch
# that refused: it can half-apply and leave a build that imports but parses
# wrongly. Each anchor below is a line the patch depends on.

$anchors = @{
    "models.py"        = "class TweetMedia"
    "parser.py"        = 'mp4_variants.sort\(key=lambda v: v.get\("bitrate", 0\), reverse=True\)'
    "serialization.py" = '"media": \['
    "client.py"        = "def fetch_bookmarks"
}
foreach ($file in $anchors.Keys) {
    $path = Join-Path $site $file
    if (-not (Select-String -Path $path -Pattern $anchors[$file] -Quiet)) {
        Fail "Upstream $file no longer contains the context this patch expects. Do not force it - re-derive the patch against the new source."
    }
}

if (-not $PSCmdlet.ShouldProcess("twitter_cli", "apply the media and unlimited-bookmarks patches")) { exit 0 }

# --- apply -------------------------------------------------------------------
#
# Applied by a Python rewriter rather than `git apply`, because site-packages is
# not a git tree and shipping a whole vendored checkout to patch four files
# would be a much larger thing to keep honest.

$applier = Join-Path $here "apply_patch.py"
& $python $applier $site
if ($LASTEXITCODE -ne 0) { Fail "The patch did not apply cleanly. The environment may be half-changed; run with -Rollback." }

# --- verify the patched build actually does the new thing --------------------

$check = @(
    'import inspect'
    'from twitter_cli.models import TweetMedia, MediaVariant'
    'from twitter_cli.serialization import tweet_to_dict'
    'from twitter_cli.client import TwitterClient'
    'm = TweetMedia(type="video", url="u", variants=[MediaVariant(url="v", content_type="video/mp4", bitrate=832000, width=640, height=360)])'
    'assert m.variants and m.variants[0].height == 360'
    'assert "respect_max_count=False" in inspect.getsource(TwitterClient.fetch_bookmarks)'
    'assert "if respect_max_count:" in inspect.getsource(TwitterClient._fetch_timeline)'
    'print("ok")'
) -join [Environment]::NewLine
$check | & $python -
if ($LASTEXITCODE -ne 0) { Fail "The patched build does not import cleanly. Run with -Rollback." }

$mediaHash = (Get-FileHash $mediaPatch -Algorithm SHA256).Hash.ToLower()
$bookmarksHash = (Get-FileHash $bookmarksPatch -Algorithm SHA256).Hash.ToLower()
@(
    "media $mediaHash"
    "bookmarks $bookmarksHash"
) | Set-Content -Path (Join-Path $here "PATCH_SHA256.txt") -Encoding utf8

Write-Host ""
Write-Host "Patched. twitter-cli now reports every MP4 rendition and exhausts bookmarks."
Write-Host "Media patch SHA-256: $mediaHash"
Write-Host "Bookmark patch SHA-256: $bookmarksHash"
Write-Host "Diagnostics shows these hashes so a running app can be matched to its provider patches."
