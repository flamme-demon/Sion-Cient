# Sion Client — Build autonome pour Windows
# Usage: Ouvrir PowerShell en administrateur, puis:
#   Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
#   .\build-scripts\build-windows.ps1
#
# Ce script installe les dependances manquantes et build l'application.
# Les DLL natives (ggml/transcribe) sont incluses dans les installeurs MSI/NSIS.

$ErrorActionPreference = "Stop"

# Navigate to project root (parent of build-scripts/)
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectDir = Split-Path -Parent $ScriptDir
Set-Location $ProjectDir

# Absolute paths used throughout the script
$tauriDir = "$ProjectDir\src-tauri"
$releaseDir = "$tauriDir\target\release"
$tauriConf = "$tauriDir\tauri.conf.json"
$nativeDist = "$tauriDir\native-dist"

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Sion Client - Build Windows" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# --- Helper ---
function Test-Command($cmd) {
    return [bool](Get-Command $cmd -ErrorAction SilentlyContinue)
}

# --- Check path length ---
if ($ProjectDir.Length -gt 30) {
    Write-Host "  ATTENTION: Le chemin actuel est long ($($ProjectDir.Length) caracteres)." -ForegroundColor Yellow
    Write-Host "  Les dependances natives (webrtc/ggml) peuvent echouer avec des chemins longs." -ForegroundColor Yellow
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

# Wipe Vite + dist caches and the previous release binary that have
# repeatedly bitten us with stale modules. Cargo's incremental cache for
# dependencies is preserved (we only nuke the final binary so the link
# step happens fresh).
Write-Host "  Nettoyage des caches Vite et binaire release..." -ForegroundColor Gray
if (Test-Path "$ProjectDir\dist") { Remove-Item -Recurse -Force "$ProjectDir\dist" }
if (Test-Path "$ProjectDir\node_modules\.vite") { Remove-Item -Recurse -Force "$ProjectDir\node_modules\.vite" }
if (Test-Path "$releaseDir\sion-client.exe") { Remove-Item -Force "$releaseDir\sion-client.exe" }

# --- 7. Build frontend ---
Write-Host "[7/10] Build du frontend..." -ForegroundColor Yellow
Set-Location $ProjectDir
bun run build
if ($LASTEXITCODE -ne 0) {
    Write-Host "  ERREUR: Build frontend echoue (code $LASTEXITCODE)." -ForegroundColor Red
    exit $LASTEXITCODE
}

# --- 8. Build Rust (compilation seule, pas de bundling) ---
Write-Host "[8/10] Compilation Rust + voix native..." -ForegroundColor Yellow
Write-Host "  Cela peut prendre plusieurs minutes a la premiere compilation..." -ForegroundColor Gray
Write-Host ""

# CUDA_HOME : le config.toml du projet pose "/opt/cuda" — un chemin LINUX — en
# valeur par defaut (`force = false`, donc une variable deja definie gagne). La
# CI en definit une depuis CUDA_PATH ; un build local Windows, lui, heritait du
# chemin Linux et webrtc-sys compilait sans NVENC en affichant un message
# trompeur : "cuda.h not found under /opt/cuda". Constate le 17/09.
if ($env:CUDA_PATH -and (Test-Path "$env:CUDA_PATH\include\cuda.h")) {
    $env:CUDA_HOME = $env:CUDA_PATH
    Write-Host "  CUDA detecte ($env:CUDA_PATH) - NVENC compile" -ForegroundColor Green
} else {
    # Chemin Windows inexistant mais explicite : webrtc-sys compile sans NVENC,
    # et le message nomme la vraie raison au lieu d'un chemin Unix.
    $env:CUDA_HOME = "$env:TEMP\sion-cuda-absent"
    Write-Host "  CUDA Toolkit absent - encodage video LOGICIEL" -ForegroundColor Yellow
    Write-Host "    (installer le CUDA Toolkit puis relancer pour activer NVENC)" -ForegroundColor DarkGray
}

Set-Location $tauriDir
cargo build --release
if ($LASTEXITCODE -ne 0) {
    Write-Host "  ERREUR: Compilation Rust echouee (code $LASTEXITCODE)." -ForegroundColor Red
    exit 1
}
Set-Location $ProjectDir

# --- 9. Prepare staging dir for native DLLs ---
Write-Host "[9/10] Preparation du staging des DLL natives..." -ForegroundColor Yellow
if (Test-Path $nativeDist) { Remove-Item -Recurse -Force $nativeDist }
New-Item -ItemType Directory -Force -Path $nativeDist | Out-Null

# --- 10. Bundle (MSI + NSIS) — re-utilise le cache cargo ---
Write-Host "[10/10] Generation des installeurs (MSI + NSIS)..." -ForegroundColor Yellow

# Variantes CPU de ggml + moteur transcribe. Elles sont liees dynamiquement
# pour que ggml choisisse son noyau selon le processeur de l'utilisateur : un
# lien statique embarquerait le jeu d'instructions de la MACHINE DE BUILD
# (AVX-512 sur les runners) et planterait en SIGILL ailleurs. build.rs les depose
# a cote du binaire ; il faut encore les faire entrer dans l'installeur, sinon
# l'application ne demarre pas du tout ("transcribe.dll est introuvable").
# On les stage dans native-dist pour que le glob native-dist/*.dll ci-dessous
# les embarque sans carte de ressources supplementaire.
$staged = @()
foreach ($pattern in @("ggml*.dll", "libggml*.dll", "transcribe*.dll", "libtranscribe*.dll")) {
    Get-ChildItem -Path $releaseDir -Filter $pattern -File -ErrorAction SilentlyContinue | ForEach-Object {
        Copy-Item $_.FullName "$nativeDist\" -Force
        $staged += $_.Name
    }
}
Write-Host "  DLL ggml/transcribe copiees ($($staged.Count)) : $($staged -join ', ')" -ForegroundColor Green
# Le nombre ne dit rien : les variantes ggml sont nombreuses et transcribe.dll
# unique, si bien qu'un lot ampute d'elle seule passait la garde tout en
# reproduisant la panne de la 1.6.2. Chaque famille est donc exigee a part.
$hasEngine = @($staged | Where-Object { $_ -like "transcribe*.dll" -or $_ -like "libtranscribe*.dll" }).Count
# Les variantes CPU comptent a part : `ggml*.dll` est deja satisfait par
# ggml-base.dll et ggml.dll, toujours presentes car liees a l'edition des liens.
# Les ggml-cpu-*.dll sont chargees a l'execution et leur absence ne se voit qu'au
# demarrage du moteur (« backend error (status 8) »).
$hasCpu = @($staged | Where-Object { $_ -like "ggml-cpu-*.dll" -or $_ -like "libggml-cpu-*.dll" }).Count
$hasGgml = @($staged | Where-Object { $_ -like "ggml*.dll" -or $_ -like "libggml*.dll" }).Count
if ($hasEngine -eq 0 -or $hasGgml -eq 0 -or $hasCpu -eq 0) {
    Write-Host "  ATTENTION: DLL manquantes (transcribe: $hasEngine, ggml: $hasGgml, variantes CPU: $hasCpu)" -ForegroundColor Red
}

# Backup tauri.conf.json
Copy-Item $tauriConf "$tauriConf.bak"

# Inject native DLLs into tauri.conf.json for bundling
$confJson = Get-Content $tauriConf -Raw | ConvertFrom-Json
$confJson.bundle | Add-Member -NotePropertyName "resources" -NotePropertyValue @{
    "native-dist/*.dll" = "./"
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

# NSIS uniquement, comme la CI. MSI refuse tout identifiant de pre-version non
# numerique : avec une version `2.0.0-alpha.5`, `tauri build` echoue sur
# « optional pre-release identifier in app version must be numeric-only ».
# Le Rust est deja compile a ce stade ; seul l'empaquetage tombait, et
# l'installeur reellement distribue est le NSIS.
bun run tauri build --bundles nsis
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

    # Centralised installer collection — same place every script drops into.
    $buildAppsDir = "$ProjectDir\build-apps"
    if (-not (Test-Path $buildAppsDir)) { New-Item -ItemType Directory -Force -Path $buildAppsDir | Out-Null }

    # Check for bundles
    $msiPath = Get-ChildItem "$releaseDir\bundle\msi\*.msi" -ErrorAction SilentlyContinue | Select-Object -First 1
    $nsisPath = Get-ChildItem "$releaseDir\bundle\nsis\*.exe" -ErrorAction SilentlyContinue | Select-Object -First 1

    if ($msiPath) {
        $msiSize = [math]::Round($msiPath.Length / 1MB, 1)
        # Strip the locale suffix that WiX appends — we want a clean filename
        # like "Sion Client_0.8.2_x64.msi" instead of "..._x64_en-US.msi".
        $cleanMsiName = $msiPath.Name -replace '_[a-z]{2}-[A-Z]{2}\.msi$', '.msi'
        Copy-Item -Force $msiPath.FullName "$buildAppsDir\$cleanMsiName"
        Write-Host "  Installeur MSI: $buildAppsDir\$cleanMsiName ($msiSize MB)" -ForegroundColor White
    }
    if ($nsisPath) {
        $nsisSize = [math]::Round($nsisPath.Length / 1MB, 1)
        # Strip the "-setup" suffix Tauri/NSIS appends — harmonise with the
        # MSI naming so we get "Sion Client_X.Y.Z_x64.exe".
        $cleanNsisName = $nsisPath.Name -replace '-setup\.exe$', '.exe'
        Copy-Item -Force $nsisPath.FullName "$buildAppsDir\$cleanNsisName"
        Write-Host "  Installeur NSIS: $buildAppsDir\$cleanNsisName ($nsisSize MB)" -ForegroundColor White
    }

    # Also create standalone directory + ZIP
    Write-Host ""
    Write-Host "  Creation du dossier standalone..." -ForegroundColor Gray

    $standaloneDir = "$releaseDir\sion-client-standalone"
    if (Test-Path $standaloneDir) { Remove-Item -Recurse -Force $standaloneDir }
    New-Item -ItemType Directory -Force -Path $standaloneDir | Out-Null

    Copy-Item $exePath "$standaloneDir\"
    if (Test-Path "$nativeDist\*.dll") {
        Copy-Item "$nativeDist\*.dll" "$standaloneDir\" -Force
    }
    if (Test-Path "$tauriDir\icons\icon.ico") {
        Copy-Item "$tauriDir\icons\icon.ico" "$standaloneDir\sion-client.ico"
    }

    # Create ZIP — versioned name, dropped into build-apps/ alongside the
    # MSI and NSIS installers for easy distribution. Same naming pattern
    # as Tauri's bundles (product name with space, no extra suffix).
    $version = (Get-Content "$tauriDir\Cargo.toml" | Select-String '^version\s*=\s*"([^"]+)"').Matches.Groups[1].Value
    if (-not $version) { $version = "0.0.0" }
    $zipName = "Sion Client_${version}_x64.zip"
    $zipPath = "$buildAppsDir\$zipName"
    if (Test-Path $zipPath) { Remove-Item $zipPath }
    Compress-Archive -Path "$standaloneDir\*" -DestinationPath $zipPath
    $zipSize = [math]::Round((Get-Item $zipPath).Length / 1MB, 1)

    Write-Host "  Dossier standalone: $standaloneDir" -ForegroundColor Green
    Write-Host "  Archive ZIP: $zipPath ($zipSize MB)" -ForegroundColor Green
} else {
    Write-Host "  ERREUR: Build echoue, binaire non trouve." -ForegroundColor Red
}

Write-Host "========================================" -ForegroundColor Green
Write-Host ""
