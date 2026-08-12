param(
  [string] $RootPath = ""
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($RootPath)) {
  $Root = Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")
} else {
  $Root = Resolve-Path -LiteralPath $RootPath
}

$LegacyData = Join-Path $Root.Path "backend\data"
if (-not (Test-Path -LiteralPath $LegacyData -PathType Container)) {
  Write-Verbose "TabKeep legacy backend data directory does not exist: $LegacyData"
  return
}

if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
  throw "LOCALAPPDATA is not available."
}

$AppData = Join-Path $env:LOCALAPPDATA "com.tabkeep.desktop"
$Marker = Join-Path $AppData "legacy-backend-data-path.txt"
New-Item -ItemType Directory -Force -Path $AppData | Out-Null
[IO.File]::WriteAllText(
  $Marker,
  (Resolve-Path -LiteralPath $LegacyData).Path,
  [Text.UTF8Encoding]::new($false)
)

Write-Output "Registered local TabKeep legacy data marker: $Marker"
