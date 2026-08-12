param(
  [string] $PythonExe = "",
  [switch] $InstallDependencies,
  [switch] $CleanBackend,
  [switch] $SkipBackendSmokeTest
)

$ErrorActionPreference = "Stop"

$Root = Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")
$backendScript = Join-Path $PSScriptRoot "release-backend.ps1"
$registerDataScript = Join-Path $PSScriptRoot "register-dev-data.ps1"

& $registerDataScript -RootPath $Root.Path

$backendArgs = @{}
if ($PythonExe) {
  $backendArgs.PythonExe = $PythonExe
}
if ($InstallDependencies) {
  $backendArgs.InstallDependencies = $true
}
if ($CleanBackend) {
  $backendArgs.Clean = $true
}
if ($SkipBackendSmokeTest) {
  $backendArgs.SkipSmokeTest = $true
}

Write-Host "[TabKeep] Building backend sidecar..." -ForegroundColor Cyan
& $backendScript @backendArgs

Write-Host "[TabKeep] Building Windows desktop installer..." -ForegroundColor Cyan
Push-Location (Join-Path $Root.Path "desktop")
try {
  & pnpm tauri:build:release
  if ($LASTEXITCODE -ne 0) {
    throw "Tauri desktop build failed."
  }
} finally {
  Pop-Location
}

Write-Host "[TabKeep] Windows release build completed." -ForegroundColor Green
