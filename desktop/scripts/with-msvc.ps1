param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]] $Command
)

$ErrorActionPreference = "Stop"

function Find-VcVars64 {
  $envCandidates = @($env:TABKEEP_VCVARS64, $env:VCVARS64) |
    Where-Object { $_ -and (Test-Path -LiteralPath $_) }
  if ($envCandidates.Count -gt 0) {
    return (Resolve-Path -LiteralPath $envCandidates[0]).Path
  }

  $vswhere = "C:\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe"
  if (Test-Path -LiteralPath $vswhere) {
    $found = & $vswhere `
      -latest `
      -products * `
      -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 `
      -find "VC\Auxiliary\Build\vcvars64.bat" |
      Select-Object -First 1

    if ($found -and (Test-Path -LiteralPath $found)) {
      return (Resolve-Path -LiteralPath $found).Path
    }
  }

  $knownPaths = @(
    "D:\vs\VC\Auxiliary\Build\vcvars64.bat",
    "C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat",
    "C:\Program Files\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat",
    "C:\Program Files\Microsoft Visual Studio\2022\Professional\VC\Auxiliary\Build\vcvars64.bat",
    "C:\Program Files\Microsoft Visual Studio\2022\Enterprise\VC\Auxiliary\Build\vcvars64.bat"
  )

  foreach ($path in $knownPaths) {
    if (Test-Path -LiteralPath $path) {
      return (Resolve-Path -LiteralPath $path).Path
    }
  }

  return $null
}

function Quote-CmdArg([string] $Value) {
  if ($Value -notmatch '[\s"&|<>^]') {
    return $Value
  }
  return '"' + ($Value -replace '"', '\"') + '"'
}

if (-not $Command -or $Command.Count -eq 0) {
  $Command = @("tauri", "dev")
}

$vcvars = Find-VcVars64
if (-not $vcvars) {
  Write-Error "未找到 vcvars64.bat。请安装 Visual Studio Build Tools C++ 工具链，或设置 TABKEEP_VCVARS64 指向 vcvars64.bat。"
  exit 1
}

$commandLine = ($Command | ForEach-Object { Quote-CmdArg $_ }) -join " "
Write-Host "[TabKeep] MSVC: $vcvars"
Write-Host "[TabKeep] Run: $commandLine"

$cmdLineForCmd = '"' + $vcvars + '" >nul && ' + $commandLine
& cmd.exe /d /s /c $cmdLineForCmd
exit $LASTEXITCODE
