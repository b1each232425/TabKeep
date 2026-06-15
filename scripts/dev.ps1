param(
  [ValidateSet("all", "backend", "extension", "desktop")]
  [string] $Only = "all",
  [switch] $NoBackend,
  [switch] $NoExtension,
  [switch] $NoDesktop,
  [switch] $DryRun
)

$ErrorActionPreference = "Stop"

$Root = Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")
$TempDir = Join-Path $Root.Path ".tmp"
New-Item -ItemType Directory -Force -Path $TempDir | Out-Null

$AllTargets = @(
  @{
    Id = "backend"
    Name = "TabKeep Backend :38471"
    WorkingDirectory = Join-Path $Root.Path "backend"
    Command = "Initialize-CondaTabKeep; python main.py"
  },
  @{
    Id = "extension"
    Name = "TabKeep Extension :3000"
    WorkingDirectory = Join-Path $Root.Path "extension"
    Command = "pnpm exec plasmo dev"
  },
  @{
    Id = "desktop"
    Name = "TabKeep Desktop :38472"
    WorkingDirectory = Join-Path $Root.Path "desktop"
    Command = "pnpm tauri:dev"
  }
)

function Test-TargetEnabled {
  param([hashtable] $Target)

  if ($Only -ne "all" -and $Target.Id -ne $Only) {
    return $false
  }

  if ($NoBackend -and $Target.Id -eq "backend") {
    return $false
  }

  if ($NoExtension -and $Target.Id -eq "extension") {
    return $false
  }

  if ($NoDesktop -and $Target.Id -eq "desktop") {
    return $false
  }

  return $true
}

function Start-TabKeepTarget {
  param([hashtable] $Target)

  $WorkingDirectory = Resolve-Path -LiteralPath $Target.WorkingDirectory
  $Name = $Target.Name
  $Command = $Target.Command

  if ($DryRun) {
    Write-Output "[$Name]"
    Write-Output "  cd $($WorkingDirectory.Path)"
    Write-Output "  TEMP=$TempDir"
    Write-Output "  $Command"
    return
  }

  $ChildScript = @"
`$host.UI.RawUI.WindowTitle = "$Name"
`$env:TEMP = "$TempDir"
`$env:TMP = "$TempDir"
Set-Location -LiteralPath "$($WorkingDirectory.Path)"

function Initialize-CondaTabKeep {
  `$conda = Get-Command conda -ErrorAction SilentlyContinue
  if (-not `$conda) {
    throw "conda was not found in PATH."
  }

  `$condaExe = `$conda.Source
  `$hook = & `$condaExe "shell.powershell" "hook"
  if (`$LASTEXITCODE -ne 0) {
    throw "Failed to load conda PowerShell hook."
  }

  `$hook | Out-String | Invoke-Expression
  conda activate tabkeep

  if (`$LASTEXITCODE -ne 0) {
    throw "Failed to activate conda env: tabkeep."
  }
}

function Assert-PnpmReady {
  if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
    throw "pnpm was not found in PATH."
  }

  if (-not (Test-Path -LiteralPath "node_modules")) {
    throw "node_modules is missing. Please run pnpm install in this directory first."
  }
}

function Initialize-ExtensionDevEnvironment {
  `$env:CI = "true"
  `$env:NO_UPDATE_NOTIFIER = "true"
  `$env:ADBLOCK = "1"
  Write-Host "Note: Plasmo may try to check its latest version online. If you see 'Extension re-packaged', the extension build is running." -ForegroundColor Yellow
}

Write-Host ""
Write-Host "[$Name]" -ForegroundColor Cyan
Write-Host "Working directory: $($WorkingDirectory.Path)"
Write-Host "Temp directory: $TempDir"
Write-Host "Command: $Command"
Write-Host ""
try {
  if ("$($Target.Id)" -eq "extension" -or "$($Target.Id)" -eq "desktop") {
    Assert-PnpmReady
  }

  if ("$($Target.Id)" -eq "extension") {
    Initialize-ExtensionDevEnvironment
  }

  $Command

  if (`$LASTEXITCODE -ne 0) {
    throw "Command exited with code: `$LASTEXITCODE"
  }
} catch {
  Write-Host ""
  Write-Host "[$Name] failed to start:" -ForegroundColor Red
  Write-Host `$_.Exception.Message -ForegroundColor Red
  Write-Host ""
}
"@

  $EncodedCommand = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($ChildScript))

  Start-Process -FilePath "powershell.exe" `
    -ArgumentList @("-NoExit", "-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", $EncodedCommand) `
    -WorkingDirectory $WorkingDirectory.Path
}

Write-Output "TabKeep dev launcher"
Write-Output "Root: $($Root.Path)"
Write-Output "Temp: $TempDir"
Write-Output ""

$StartedCount = 0

foreach ($Target in $AllTargets) {
  if (Test-TargetEnabled $Target) {
    Start-TabKeepTarget $Target
    $StartedCount += 1
  }
}

if ($StartedCount -eq 0) {
  Write-Output "没有需要启动的服务。"
  exit 0
}

if (-not $DryRun) {
  Write-Output ""
  Write-Output "已启动 $StartedCount 个开发进程。每个服务会在独立 PowerShell 窗口中显示日志。"
}
