param([string]$Release = 'standalone-0.8.2')
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$releaseRoot = Join-Path (Join-Path $root 'dist-ios') $Release
if (Test-Path -LiteralPath $releaseRoot) { throw 'Source snapshot already exists; use a new release label.' }
$source = Join-Path $releaseRoot 'source'
New-Item -ItemType Directory -Path $source -Force | Out-Null
$files = @(& git -C $root ls-files)
$files += @(& rg --files (Join-Path $root 'src') (Join-Path $root 'src-tauri') (Join-Path $root 'tools') (Join-Path $root 'public') -g '!target/**' -g '!gen/**' -g '!node_modules/**' -g '!*.rar' -g '!*.zip') | ForEach-Object {
    if ([IO.Path]::IsPathRooted($_)) {
        $full = [IO.Path]::GetFullPath($_)
        if (-not $full.StartsWith($root + [IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)) { throw 'Source path escaped the workspace.' }
        $full.Substring($root.Length + 1)
    } else { $_ }
}
$files += @('IOS_STANDALONE.md','IPHONE_BUILD.md','RELEASE_0.7.0.md','RELEASE_0.8.0.md','RELEASE_0.8.1.md','RELEASE_0.8.2.md','vite.version.ts','src/vite-env.d.ts')
$accepted = @()
foreach ($relative in ($files | ForEach-Object { $_.Replace('\','/') } | Sort-Object -Unique)) {
    $relative = $relative.Replace('\','/')
    if ($relative -match '(^|/)(target|gen|node_modules|dist|dist-ios|dist-portable|supercord|\.git|\.claude|\.agents|\.codex)(/|$)' -or $relative -match '\.(rar|zip|exe|ipa|p8|p12|mobileprovision)$' -or $relative -match '(^|/)\.env') { continue }
    $from = Join-Path $root $relative
    if (-not (Test-Path -LiteralPath $from -PathType Leaf)) { continue }
    $to = Join-Path $source $relative
    New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($to)) -Force | Out-Null
    Copy-Item -LiteralPath $from -Destination $to
    $accepted += $relative
}
Add-Type -AssemblyName System.IO.Compression.FileSystem
Add-Type -AssemblyName System.IO.Compression
$zip = Join-Path $releaseRoot 'FocusFeedNext-source.zip'
$archive = [IO.Compression.ZipFile]::Open($zip,[IO.Compression.ZipArchiveMode]::Create)
try {
    foreach ($relative in $accepted) {
        [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive,(Join-Path $source $relative),$relative.Replace('\','/'),[IO.Compression.CompressionLevel]::Optimal) | Out-Null
    }
} finally { $archive.Dispose() }
$accepted | Set-Content -LiteralPath (Join-Path $releaseRoot 'source-manifest.txt') -Encoding utf8
Get-Item -LiteralPath $zip | Select-Object FullName,Length
