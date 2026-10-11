[CmdletBinding()]
param(
    [switch]$SkipTests,
    [ValidateSet('Standalone','Companion')][string]$Mode = 'Standalone'
)

$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path

function Assert-ProjectCondition {
    param(
        [Parameter(Mandatory = $true)][bool]$Condition,
        [Parameter(Mandatory = $true)][string]$Message
    )

    if (-not $Condition) {
        throw $Message
    }
}

function Read-ProjectText {
    param([Parameter(Mandatory = $true)][string]$RelativePath)

    $path = Join-Path $projectRoot $RelativePath
    Assert-ProjectCondition (Test-Path -LiteralPath $path -PathType Leaf) "Missing required file: $RelativePath"
    return Get-Content -Raw -LiteralPath $path
}

$baseConfig = Read-ProjectText 'src-tauri\tauri.conf.json' | ConvertFrom-Json
$iosConfig = Read-ProjectText 'src-tauri\tauri.ios.conf.json' | ConvertFrom-Json
$infoPlist = Read-ProjectText 'src-tauri\Info.ios.plist'
$workflow = Read-ProjectText $(if ($Mode -eq 'Companion') { '.github\workflows\ios.yml' } else { '.github\workflows\ios-unsigned.yml' })
$rustEntry = Read-ProjectText 'src-tauri\src\lib.rs'
$companion = Read-ProjectText 'src-tauri\src\companion.rs'

Assert-ProjectCondition ($baseConfig.identifier -eq 'com.focusfeed.next') 'The bundle identifier changed; update the App Store Connect record and this verifier together.'
Assert-ProjectCondition ($iosConfig.app.windows.Count -eq 1) 'The iOS configuration must define exactly one main window.'
Assert-ProjectCondition ($iosConfig.app.windows[0].label -eq 'main') 'The iOS window label must match the main capability.'
Assert-ProjectCondition ($iosConfig.app.windows[0].create -eq $true) 'The iOS window must be created from configuration.'
Assert-ProjectCondition ($iosConfig.bundle.iOS.minimumSystemVersion -eq '16.0') 'The verified deployment target is iOS 16.0.'
Assert-ProjectCondition ($rustEntry.Contains('#[cfg_attr(mobile, tauri::mobile_entry_point)]')) 'The Tauri mobile entry point is missing.'
if ($Mode -eq 'Companion') {
    Assert-ProjectCondition ($infoPlist.Contains('NSLocalNetworkUsageDescription')) 'The local-network privacy purpose string is missing.'
    Assert-ProjectCondition ($companion.Contains('pub struct RemoteProvider')) 'The iPhone remote provider is missing.'
    Assert-ProjectCondition ($workflow.Contains('--export-method app-store-connect')) 'The signed companion export gate is missing.'
    Assert-ProjectCondition ($workflow.Contains('xcrun altool --validate-app')) 'The App Store Connect validation gate is missing.'
} else {
    $buildScript = Read-ProjectText 'tools\build-ios-unsigned.sh'
    Assert-ProjectCondition ($buildScript.Contains('ios init --ci')) 'The build no longer generates the iOS project in CI.'
    Assert-ProjectCondition ($buildScript.Contains('CODE_SIGNING_ALLOWED = NO')) 'Unsigned signing control is missing.'
    Assert-ProjectCondition ($buildScript.Contains('codesign -dv')) 'Unsigned signature verification is missing.'
    Assert-ProjectCondition ($rustEntry.Contains('tauri_plugin_ios_reader::init()')) 'The standalone native provider plugin is missing.'
}

Add-Type -AssemblyName System.Drawing
$iconPath = Join-Path $projectRoot 'src-tauri\icons\icon-ios-1024.png'
Assert-ProjectCondition (Test-Path -LiteralPath $iconPath -PathType Leaf) 'The App Store icon is missing.'
$icon = [System.Drawing.Image]::FromFile($iconPath)
try {
    Assert-ProjectCondition ($icon.Width -eq 1024 -and $icon.Height -eq 1024) 'The App Store icon must be exactly 1024 x 1024.'
    Assert-ProjectCondition (-not [System.Drawing.Image]::IsAlphaPixelFormat($icon.PixelFormat)) 'The App Store icon must be opaque; alpha is not accepted.'
}
finally {
    $icon.Dispose()
}

Write-Host "iOS project structure: PASS"
Write-Host "Bundle identifier: $($baseConfig.identifier)"
Write-Host "Minimum iOS: $($iosConfig.bundle.iOS.minimumSystemVersion)"
Write-Host "App Store icon: 1024 x 1024, opaque"

if (-not $SkipTests) {
    Push-Location $projectRoot
    try {
        & node_modules\.bin\oxlint.cmd src perf tools\build-ios-native.mjs src-tauri\plugins\ios-reader\transaction
        if ($LASTEXITCODE -ne 0) { throw 'Scoped frontend lint failed.' }
        & npm.cmd run build
        if ($LASTEXITCODE -ne 0) { throw 'Production build failed.' }
        & npm.cmd test
        if ($LASTEXITCODE -ne 0) {
            throw "Frontend verification failed with exit code $LASTEXITCODE."
        }

        & cargo test --manifest-path 'src-tauri\Cargo.toml' --all
        if ($LASTEXITCODE -ne 0) {
            throw "Rust verification failed with exit code $LASTEXITCODE."
        }
    }
    finally {
        Pop-Location
    }
}

Write-Host "Focus Feed Next iPhone project verification: PASS"
