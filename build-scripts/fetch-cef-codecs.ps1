# Swap the minimal libcef.dll (no proprietary codecs) for the STANDARD build's
# (with H.264/AAC) so <video> plays MP4 natively on Windows. The `cef` crate
# downloads the minimal distribution; we fetch only the standard libcef.dll
# (~1 GB archive, once) and overwrite it in the CEF build dir.
#
# The version MUST match what cef-dll-sys downloads (read from archive.json):
# cef_binary_147.0.10+gd58e84d+chromium-147.0.7727.118  (the cef crate 148.0.0
# wraps CEF binary 147.0.10 — NOT a downgrade).
param([string]$CefDir = "")
$ErrorActionPreference = "Stop"

# Keep in sync with the `cef` crate version in src-tauri/Cargo.toml.
$CEF_VER = "147.0.10+gd58e84d+chromium-147.0.7727.118"

if (-not $CefDir) {
    $root = Split-Path -Parent $PSScriptRoot
    $buildRoot = Join-Path $root "src-tauri\target\release\build"
    $d = Get-ChildItem -Path $buildRoot -Recurse -Directory -Filter "cef_win*" -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $d) { $d = Get-ChildItem -Path $buildRoot -Recurse -Directory -Filter "cef_windows*" -ErrorAction SilentlyContinue | Select-Object -First 1 }
    if (-not $d) { Write-Error "Dossier CEF introuvable sous target/release/build — lancez 'cargo build --release' d'abord."; exit 1 }
    $CefDir = $d.FullName
}

$libcef = Join-Path $CefDir "libcef.dll"
$marker = Join-Path $CefDir "libcef.dll.standard"
if (Test-Path $marker) { Write-Host "  libcef.dll standard deja installe (codecs)" -ForegroundColor Green; exit 0 }
if (-not (Test-Path $libcef)) { Write-Error "libcef.dll introuvable dans $CefDir"; exit 1 }

$name = "cef_binary_${CEF_VER}_windows64"
$url = "https://cef-builds.spotifycdn.com/" + ($name -replace '\+', '%2B') + ".tar.bz2"
$tmp = Join-Path $env:TEMP ("cef_std_" + [System.Guid]::NewGuid().ToString() + ".tar.bz2")
$ext = Join-Path $env:TEMP ("cef_std_ext_" + [System.Guid]::NewGuid().ToString())
New-Item -ItemType Directory -Force -Path $ext | Out-Null

Write-Host "  Telechargement du CEF standard (avec codecs, ~1 Go)..." -ForegroundColor Yellow
Write-Host "  $url"
curl.exe -L --fail -o $tmp $url
Write-Host "  Extraction de libcef.dll..." -ForegroundColor Yellow
# bsdtar (Win10+) handles .tar.bz2. Extract just the libcef.dll entry, then
# locate it (avoids --strip-components quirks across tar versions).
tar -xf $tmp -C $ext "*/Release/libcef.dll"
$extracted = (Get-ChildItem -Path $ext -Recurse -Filter "libcef.dll" -ErrorAction SilentlyContinue | Select-Object -First 1)
if (-not $extracted) { Write-Error "libcef.dll absent de l'archive standard"; exit 1 }

if (-not (Test-Path "$libcef.minimal.bak")) { Copy-Item $libcef "$libcef.minimal.bak" -Force }
Copy-Item $extracted.FullName $libcef -Force
New-Item -ItemType File -Path $marker -Force | Out-Null
Remove-Item $tmp -Force -ErrorAction SilentlyContinue
Remove-Item $ext -Recurse -Force -ErrorAction SilentlyContinue
Write-Host "  libcef.dll standard installe (codecs H.264/AAC actives)" -ForegroundColor Green
