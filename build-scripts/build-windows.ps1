# Sion Client — Build autonome pour Windows
# Usage: Ouvrir PowerShell en administrateur, puis:
#   Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
#   .\build-scripts\build-windows.ps1
#
# Ce script installe les dependances manquantes et build l'application.
# Les libs CEF sont incluses dans les installeurs MSI/NSIS.

$ErrorActionPreference = "Stop"

# Navigate to project root (parent of build-scripts/)
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectDir = Split-Path -Parent $ScriptDir
Set-Location $ProjectDir

# Absolute paths used throughout the script
$tauriDir = "$ProjectDir\src-tauri"
$releaseDir = "$tauriDir\target\release"
$tauriConf = "$tauriDir\tauri.conf.json"
$cefDist = "$tauriDir\cef-dist"

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Sion Client - Build Windows" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# --- Helper ---
function Test-Command($cmd) {
    return [bool](Get-Command $cmd -ErrorAction SilentlyContinue)
}

# List of CEF files to bundle
$cefFiles = @(
    "libcef.dll","chrome_elf.dll","d3dcompiler_47.dll",
    "libEGL.dll","libGLESv2.dll","vulkan-1.dll","vk_swiftshader.dll",
    "chrome_100_percent.pak","chrome_200_percent.pak","resources.pak",
    "icudtl.dat","v8_context_snapshot.bin","snapshot_blob.bin","vk_swiftshader_icd.json"
)

function Find-CefDir {
    $cefDir = Get-ChildItem -Path "$releaseDir\build" -Recurse -Directory -Filter "cef_win*" -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $cefDir) {
        $cefDir = Get-ChildItem -Path "$releaseDir\build" -Recurse -Directory -Filter "cef_windows*" -ErrorAction SilentlyContinue | Select-Object -First 1
    }
    return $cefDir
}

function Stage-CefLibs($cefDir) {
    # Clean previous staging
    if (Test-Path $cefDist) { Remove-Item -Recurse -Force $cefDist }
    New-Item -ItemType Directory -Force -Path $cefDist | Out-Null

    $count = 0
    foreach ($f in $cefFiles) {
        $src = Join-Path $cefDir.FullName $f
        if (Test-Path $src) {
            Copy-Item $src "$cefDist\"
            $count++
        }
    }

    # Locales subdirectory
    $localesDir = Join-Path $cefDir.FullName "locales"
    if (Test-Path $localesDir) {
        New-Item -ItemType Directory -Force -Path "$cefDist\locales" | Out-Null
        Copy-Item "$localesDir\*" "$cefDist\locales\" -Force
    }

    Write-Host "  $count fichiers CEF copies dans cef-dist/" -ForegroundColor Green
}

# --- Check path length ---
if ($ProjectDir.Length -gt 30) {
    Write-Host "  ATTENTION: Le chemin actuel est long ($($ProjectDir.Length) caracteres)." -ForegroundColor Yellow
    Write-Host "  CEF necessite des chemins courts sur Windows." -ForegroundColor Yellow
    Write-Host "  Recommande: extraire a C:\sion-build\" -ForegroundColor Yellow
    Write-Host ""
    $continue = Read-Host "  Continuer quand meme ? (o/N)"
    if ($continue -ne "o" -and $continue -ne "O") { exit 0 }
}

# --- 1. Check/Install Visual Studio Build Tools ---
Write-Host "[1/10] Verification des Build Tools Visual Studio..." -ForegroundColor Yellow

$hasVS = $false
$vsWhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
if (Test-Path $vsWhere) {
    $vsInstall = & $vsWhere -latest -property installationPath 2>$null
    if ($vsInstall) { $hasVS = $true }
}

if (-not $hasVS) {
    Write-Host "  Build Tools non trouves. Installation via winget..." -ForegroundColor Gray
    if (Test-Command "winget") {
        winget install Microsoft.VisualStudio.2022.BuildTools --accept-source-agreements --accept-package-agreements --silent --override "--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
        Write-Host "  Build Tools installes. Un redemarrage peut etre necessaire." -ForegroundColor Green
    } else {
        Write-Host "  ERREUR: winget non disponible." -ForegroundColor Red
        Write-Host "  Installez manuellement les Build Tools VS 2022:" -ForegroundColor Red
        Write-Host "  https://visualstudio.microsoft.com/visual-cpp-build-tools/" -ForegroundColor Red
        Write-Host "  Selectionnez 'Developpement Desktop en C++'" -ForegroundColor Red
        exit 1
    }
} else {
    Write-Host "  OK" -ForegroundColor Green
}

# --- 2. Check/Install CMake ---
Write-Host "[2/10] Verification de CMake..." -ForegroundColor Yellow

if (-not (Test-Command "cmake")) {
    Write-Host "  CMake non trouve. Installation via winget..." -ForegroundColor Gray
    if (Test-Command "winget") {
        winget install Kitware.CMake --accept-source-agreements --accept-package-agreements --silent
        $cmakePath = "${env:ProgramFiles}\CMake\bin"
        if (Test-Path $cmakePath) { $env:PATH = "$cmakePath;$env:PATH" }
    } else {
        Write-Host "  ERREUR: Installez CMake manuellement: https://cmake.org/download/" -ForegroundColor Red
        exit 1
    }
    Write-Host "  CMake installe." -ForegroundColor Green
} else {
    Write-Host "  OK" -ForegroundColor Green
}

# --- 3. Check/Install Ninja ---
Write-Host "[3/10] Verification de Ninja..." -ForegroundColor Yellow

if (-not (Test-Command "ninja")) {
    Write-Host "  Ninja non trouve. Installation via winget..." -ForegroundColor Gray
    if (Test-Command "winget") {
        winget install Ninja-build.Ninja --accept-source-agreements --accept-package-agreements --silent
        $ninjaPath = "${env:ProgramFiles}\Ninja"
        if (Test-Path $ninjaPath) { $env:PATH = "$ninjaPath;$env:PATH" }
        $ninjaLocal = "$env:LOCALAPPDATA\Microsoft\WinGet\Links"
        if (Test-Path $ninjaLocal) { $env:PATH = "$ninjaLocal;$env:PATH" }
    } else {
        Write-Host "  ERREUR: Installez Ninja manuellement: https://ninja-build.org/" -ForegroundColor Red
        exit 1
    }
    Write-Host "  Ninja installe." -ForegroundColor Green
} else {
    Write-Host "  OK" -ForegroundColor Green
}

# --- 4. Check/Install Rust ---
Write-Host "[4/10] Verification de Rust..." -ForegroundColor Yellow

if (-not (Test-Command "rustc")) {
    Write-Host "  Rust non trouve. Installation via rustup..." -ForegroundColor Gray
    $rustupUrl = "https://static.rust-lang.org/rustup/dist/x86_64-pc-windows-msvc/rustup-init.exe"
    $rustupExe = "$env:TEMP\rustup-init.exe"
    Invoke-WebRequest -Uri $rustupUrl -OutFile $rustupExe -UseBasicParsing
    & $rustupExe -y --default-toolchain stable
    Remove-Item $rustupExe -Force
    $env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"
    Write-Host "  Rust installe." -ForegroundColor Green
} else {
    $rustVersion = rustc --version
    Write-Host "  OK ($rustVersion)" -ForegroundColor Green
}

# --- 5. Check/Install Bun ---
Write-Host "[5/10] Verification de Bun..." -ForegroundColor Yellow

if (-not (Test-Command "bun")) {
    Write-Host "  Bun non trouve. Installation..." -ForegroundColor Gray
    irm bun.sh/install.ps1 | iex
    $env:PATH = "$env:USERPROFILE\.bun\bin;$env:PATH"
    Write-Host "  Bun installe." -ForegroundColor Green
} else {
    $bunVersion = bun --version
    Write-Host "  OK (v$bunVersion)" -ForegroundColor Green
}

# --- 6. Install dependencies ---
Write-Host "[6/10] Installation des dependances..." -ForegroundColor Yellow
Write-Host "  bun install..." -ForegroundColor Gray
Set-Location $ProjectDir
bun install

# --- 7. Build frontend ---
Write-Host "[7/10] Build du frontend..." -ForegroundColor Yellow
Set-Location $ProjectDir
bun run build

# --- 8. Build Rust (compilation seule, pas de bundling) ---
Write-Host "[8/10] Compilation Rust + CEF..." -ForegroundColor Yellow
Write-Host "  Cela peut prendre plusieurs minutes a la premiere compilation..." -ForegroundColor Gray
Write-Host ""

Set-Location $tauriDir
cargo build --release
if ($LASTEXITCODE -ne 0) {
    Write-Host "  ERREUR: Compilation Rust echouee (code $LASTEXITCODE)." -ForegroundColor Red
    exit 1
}
Set-Location $ProjectDir

# --- 9. Stage CEF libs for bundler ---
Write-Host "[9/10] Staging des libs CEF pour le bundler..." -ForegroundColor Yellow

$cefDir = Find-CefDir
if ($cefDir) {
    Stage-CefLibs $cefDir
} else {
    Write-Host "  ATTENTION: Libs CEF non trouvees dans target/release/build/" -ForegroundColor Yellow
    Write-Host "  Les installeurs seront generes sans les libs CEF." -ForegroundColor Yellow
}

# --- 10. Bundle (MSI + NSIS) — re-utilise le cache cargo ---
Write-Host "[10/10] Generation des installeurs (MSI + NSIS)..." -ForegroundColor Yellow

# Backup tauri.conf.json
Copy-Item $tauriConf "$tauriConf.bak"

# Inject CEF resources into tauri.conf.json for bundling
$confJson = Get-Content $tauriConf -Raw | ConvertFrom-Json
$confJson.bundle | Add-Member -NotePropertyName "resources" -NotePropertyValue @{
    "cef-dist/*.dll" = "./"
    "cef-dist/*.pak" = "./"
    "cef-dist/*.dat" = "./"
    "cef-dist/*.bin" = "./"
    "cef-dist/*.json" = "./"
    "cef-dist/locales/*" = "./locales/"
} -Force
[System.IO.File]::WriteAllText($tauriConf, ($confJson | ConvertTo-Json -Depth 10), [System.Text.UTF8Encoding]::new($false))

Set-Location $ProjectDir

# Wipe stale bundles so we can detect a failed `tauri build` (otherwise the
# script picks up the previous successful build's installers and reports a
# misleading version).
$msiBundleDir = "$releaseDir\bundle\msi"
$nsisBundleDir = "$releaseDir\bundle\nsis"
if (Test-Path $msiBundleDir) { Remove-Item -Recurse -Force $msiBundleDir }
if (Test-Path $nsisBundleDir) { Remove-Item -Recurse -Force $nsisBundleDir }

bun run tauri build
$tauriBuildExitCode = $LASTEXITCODE

# Restore tauri.conf.json from backup (guaranteed clean)
Set-Location $ProjectDir
if (Test-Path "$tauriConf.bak") {
    Move-Item -Force "$tauriConf.bak" $tauriConf
}

if ($tauriBuildExitCode -ne 0) {
    Write-Host ""
    Write-Host "ERREUR: tauri build a echoue (code $tauriBuildExitCode)." -ForegroundColor Red
    Write-Host "       Les installeurs MSI/NSIS n'ont pas ete generes." -ForegroundColor Red
    Write-Host "       Verifier les erreurs ci-dessus." -ForegroundColor Red
    exit $tauriBuildExitCode
}

# --- Result ---
$exePath = "$releaseDir\sion-client.exe"

Write-Host ""
Write-Host "========================================" -ForegroundColor Green

if (Test-Path $exePath) {
    $size = [math]::Round((Get-Item $exePath).Length / 1MB, 1)
    Write-Host "  Build reussi !" -ForegroundColor Green
    Write-Host "  Binaire: $exePath ($size MB)" -ForegroundColor White
    Write-Host ""

    # Check for bundles
    $msiPath = Get-ChildItem "$releaseDir\bundle\msi\*.msi" -ErrorAction SilentlyContinue | Select-Object -First 1
    $nsisPath = Get-ChildItem "$releaseDir\bundle\nsis\*.exe" -ErrorAction SilentlyContinue | Select-Object -First 1

    if ($msiPath) {
        $msiSize = [math]::Round($msiPath.Length / 1MB, 1)
        Write-Host "  Installeur MSI: $($msiPath.FullName) ($msiSize MB)" -ForegroundColor White
    }
    if ($nsisPath) {
        $nsisSize = [math]::Round($nsisPath.Length / 1MB, 1)
        Write-Host "  Installeur NSIS: $($nsisPath.FullName) ($nsisSize MB)" -ForegroundColor White
    }

    # Also create standalone directory + ZIP
    Write-Host ""
    Write-Host "  Creation du dossier standalone..." -ForegroundColor Gray

    if ($cefDir) {
        $standaloneDir = "$releaseDir\sion-client-standalone"
        if (Test-Path $standaloneDir) { Remove-Item -Recurse -Force $standaloneDir }
        New-Item -ItemType Directory -Force -Path $standaloneDir | Out-Null

        Copy-Item $exePath "$standaloneDir\"
        foreach ($f in $cefFiles) {
            $src = Join-Path $cefDir.FullName $f
            if (Test-Path $src) { Copy-Item $src "$standaloneDir\" }
        }
        $localesDir = Join-Path $cefDir.FullName "locales"
        if (Test-Path $localesDir) {
            Copy-Item -Recurse -Force $localesDir "$standaloneDir\locales"
        }
        if (Test-Path "$tauriDir\icons\icon.ico") {
            Copy-Item "$tauriDir\icons\icon.ico" "$standaloneDir\sion-client.ico"
        }

        # Create ZIP
        $zipPath = "$releaseDir\sion-client-standalone.zip"
        if (Test-Path $zipPath) { Remove-Item $zipPath }
        Compress-Archive -Path "$standaloneDir\*" -DestinationPath $zipPath
        $zipSize = [math]::Round((Get-Item $zipPath).Length / 1MB, 1)

        Write-Host "  Dossier standalone: $standaloneDir" -ForegroundColor Green
        Write-Host "  Archive ZIP: $zipPath ($zipSize MB)" -ForegroundColor Green
    } else {
        Write-Host "  ATTENTION: Libs CEF non trouvees pour le dossier standalone." -ForegroundColor Yellow
    }
} else {
    Write-Host "  ERREUR: Build echoue, binaire non trouve." -ForegroundColor Red
}

Write-Host "========================================" -ForegroundColor Green
Write-Host ""
