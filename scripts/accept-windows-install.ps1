param(
  [string] $InstallerPath = "",
  [string] $LegacyDataDir = "",
  [int] $TimeoutSeconds = 420,
  [switch] $AllowExistingData,
  [switch] $UninstallAfter
)

$ErrorActionPreference = "Stop"
$Root = Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")

if ([string]::IsNullOrWhiteSpace($InstallerPath)) {
  $BundleDirectory = Join-Path $Root.Path "desktop\src-tauri\target\release\bundle\nsis"
  $LatestInstaller = Get-ChildItem -LiteralPath $BundleDirectory -Filter "TabKeep_*_x64-setup.exe" -File |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1
  if (-not $LatestInstaller) {
    throw "No TabKeep NSIS installer was found in: $BundleDirectory"
  }
  $InstallerPath = $LatestInstaller.FullName
}
$Installer = Resolve-Path -LiteralPath $InstallerPath
$ExpectedVersion = if ($Installer.Name -match '^TabKeep_(.+)_x64-setup\.exe$') {
  $Matches[1]
} else {
  throw "Unable to read the expected version from installer name: $($Installer.Name)"
}

if ([string]::IsNullOrWhiteSpace($LegacyDataDir)) {
  $LegacyDataDir = Join-Path $Root.Path "backend\data"
}
$LegacyData = Resolve-Path -LiteralPath $LegacyDataDir

if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
  throw "LOCALAPPDATA is not available."
}

$AppData = Join-Path $env:LOCALAPPDATA "com.tabkeep.desktop"
$TargetData = Join-Path $AppData "backend\data"
$ReceiptPath = Join-Path $TargetData "migration-receipt.json"

function Get-TabKeepProcesses {
  @(Get-Process -Name "TabKeep", "tabkeep-desktop", "tabkeep-backend" -ErrorAction SilentlyContinue)
}

function Get-InstalledTabKeep {
  $RegistryRoots = @(
    "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*",
    "HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*",
    "HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*"
  )

  foreach ($RegistryRoot in $RegistryRoots) {
    foreach ($Entry in @(Get-ItemProperty -Path $RegistryRoot -ErrorAction SilentlyContinue)) {
      if ($Entry.DisplayName -ne "TabKeep") {
        continue
      }

      $Candidates = @()
      if ($Entry.InstallLocation) {
        $InstallLocation = $Entry.InstallLocation.ToString().Trim().Trim('"')
        if (-not [string]::IsNullOrWhiteSpace($InstallLocation)) {
          $Candidates += Join-Path $InstallLocation "TabKeep.exe"
        }
      }
      if ($Entry.DisplayIcon) {
        $Candidates += ($Entry.DisplayIcon -replace ',\d+$', '').Trim('"')
      }
      foreach ($Candidate in $Candidates) {
        if (Test-Path -LiteralPath $Candidate -PathType Leaf) {
          return [pscustomobject]@{
            Executable = (Resolve-Path -LiteralPath $Candidate).Path
            UninstallString = $Entry.UninstallString
          }
        }
      }
    }
  }

  $Fallbacks = @(
    (Join-Path $env:LOCALAPPDATA "TabKeep\TabKeep.exe"),
    (Join-Path $env:LOCALAPPDATA "TabKeep\tabkeep-desktop.exe"),
    (Join-Path $env:LOCALAPPDATA "Programs\TabKeep\TabKeep.exe"),
    (Join-Path $env:LOCALAPPDATA "Programs\TabKeep\tabkeep-desktop.exe"),
    (Join-Path $env:ProgramFiles "TabKeep\TabKeep.exe")
  )
  foreach ($Candidate in $Fallbacks) {
    if (Test-Path -LiteralPath $Candidate -PathType Leaf) {
      return [pscustomobject]@{
        Executable = (Resolve-Path -LiteralPath $Candidate).Path
        UninstallString = $null
      }
    }
  }

  throw "TabKeep was installed, but its executable could not be located."
}

function Wait-Until {
  param(
    [scriptblock] $Condition,
    [string] $FailureMessage
  )

  $Deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  while ([DateTime]::UtcNow -lt $Deadline) {
    if (& $Condition) {
      return
    }
    Start-Sleep -Milliseconds 500
  }
  throw $FailureMessage
}

$ExistingProcesses = Get-TabKeepProcesses
if ($ExistingProcesses.Count -gt 0) {
  $Ids = ($ExistingProcesses | ForEach-Object Id) -join ", "
  throw "Close running TabKeep processes before acceptance testing. Process IDs: $Ids"
}

if ((Test-Path -LiteralPath $TargetData -PathType Container) -and -not $AllowExistingData) {
  $ExistingEntries = @(Get-ChildItem -LiteralPath $TargetData -Force -ErrorAction Stop)
  if ($ExistingEntries.Count -gt 0) {
    throw "The installed backend data directory is already initialized: $TargetData. Use -AllowExistingData only for an idempotency acceptance run."
  }
}

$RequiredSourceEntries = @("config.json", "knowledge.db") | Where-Object {
  Test-Path -LiteralPath (Join-Path $LegacyData.Path $_)
}
if ($RequiredSourceEntries.Count -eq 0) {
  throw "Legacy data has neither config.json nor knowledge.db: $($LegacyData.Path)"
}

$PreviousLegacyDataDir = $env:TABKEEP_LEGACY_DATA_DIR
$PreviousAcceptanceExit = $env:TABKEEP_ACCEPTANCE_EXIT_AFTER_READY
$StartedApp = $null
$AcceptanceStart = Get-Date
$Installed = $null

try {
  Write-Host "[TabKeep] Installing $($Installer.Path)..." -ForegroundColor Cyan
  $InstallProcess = Start-Process -FilePath $Installer.Path -ArgumentList "/S" -PassThru -Wait
  if ($InstallProcess.ExitCode -ne 0) {
    throw "TabKeep installer failed with exit code $($InstallProcess.ExitCode)."
  }

  $Installed = Get-InstalledTabKeep
  Write-Host "[TabKeep] Installed executable: $($Installed.Executable)" -ForegroundColor Cyan

  $env:TABKEEP_LEGACY_DATA_DIR = $LegacyData.Path
  $env:TABKEEP_ACCEPTANCE_EXIT_AFTER_READY = "1"
  $StartedApp = Start-Process -FilePath $Installed.Executable -PassThru

  Wait-Until -FailureMessage "TabKeep backend did not become healthy within $TimeoutSeconds seconds." -Condition {
    try {
      $Health = Invoke-RestMethod -Uri "http://127.0.0.1:38471/" -TimeoutSec 2
      return $Health.version -eq $ExpectedVersion
    } catch {
      return $false
    }
  }
  Write-Host "[TabKeep] Backend health check passed." -ForegroundColor Green

  if (-not $AllowExistingData) {
    Wait-Until -FailureMessage "Legacy data migration receipt was not created." -Condition {
      Test-Path -LiteralPath $ReceiptPath -PathType Leaf
    }
    $Receipt = Get-Content -LiteralPath $ReceiptPath -Raw | ConvertFrom-Json
    foreach ($Entry in $RequiredSourceEntries) {
      if ($Receipt.copiedEntries -notcontains $Entry) {
        throw "Migration receipt does not include required entry: $Entry"
      }
      if (-not (Test-Path -LiteralPath (Join-Path $TargetData $Entry))) {
        throw "Migrated entry is missing: $Entry"
      }
      if (-not (Test-Path -LiteralPath (Join-Path $LegacyData.Path $Entry))) {
        throw "Legacy source was modified or removed: $Entry"
      }
    }
    Write-Host "[TabKeep] Legacy data migration checks passed." -ForegroundColor Green
  }

  Wait-Until -FailureMessage "Installed TabKeep did not exit after the acceptance health check." -Condition {
    $StartedApp.Refresh()
    return $StartedApp.HasExited
  }

  Wait-Until -FailureMessage "TabKeep backend sidecar remained after the desktop app exited." -Condition {
    $Residual = @(Get-Process -Name "tabkeep-backend" -ErrorAction SilentlyContinue | Where-Object {
      $_.StartTime -ge $AcceptanceStart
    })
    return $Residual.Count -eq 0
  }

  Write-Host "[TabKeep] Installed app exit and sidecar cleanup passed." -ForegroundColor Green
  Write-Host "[TabKeep] Windows installation acceptance passed." -ForegroundColor Green
} finally {
  if ($StartedApp -and -not $StartedApp.HasExited) {
    Stop-Process -Id $StartedApp.Id -Force -ErrorAction SilentlyContinue
  }
  Get-Process -Name "tabkeep-backend" -ErrorAction SilentlyContinue | Where-Object {
    $_.StartTime -ge $AcceptanceStart
  } | Stop-Process -Force -ErrorAction SilentlyContinue
  $env:TABKEEP_LEGACY_DATA_DIR = $PreviousLegacyDataDir
  $env:TABKEEP_ACCEPTANCE_EXIT_AFTER_READY = $PreviousAcceptanceExit

  if ($UninstallAfter -and $Installed -and $Installed.UninstallString) {
    $UninstallCommand = $Installed.UninstallString.Trim()
    if ($UninstallCommand -match '^"([^"]+)"(.*)$') {
      Start-Process -FilePath $Matches[1] -ArgumentList ($Matches[2].Trim(), "/S") -Wait
    } else {
      Start-Process -FilePath $UninstallCommand -ArgumentList "/S" -Wait
    }
  }
}
