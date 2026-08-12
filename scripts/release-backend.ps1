param(
  [string] $PythonExe = "",
  [switch] $InstallDependencies,
  [switch] $SkipSmokeTest,
  [switch] $ReuseExisting,
  [switch] $Clean,
  [int] $SmokeTimeoutSeconds = 180
)

$ErrorActionPreference = "Stop"

$Root = Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")
$BackendDir = Join-Path $Root.Path "backend"
$ReleaseDir = Join-Path $Root.Path ".release\backend"
$WorkDir = Join-Path $ReleaseDir "build"
$DistDir = Join-Path $ReleaseDir "dist"
$SpecPath = Join-Path $BackendDir "tabkeep_backend.spec"
$ExecutablePath = Join-Path $DistDir "tabkeep-backend.exe"

function Resolve-TabKeepPython {
  if ($PythonExe) {
    return (Resolve-Path -LiteralPath $PythonExe).Path
  }

  if ($env:TABKEEP_PYTHON) {
    return (Resolve-Path -LiteralPath $env:TABKEEP_PYTHON).Path
  }

  if ($env:CONDA_PREFIX) {
    $activePython = Join-Path $env:CONDA_PREFIX "python.exe"
    if (Test-Path -LiteralPath $activePython) {
      return $activePython
    }
  }

  $conda = Get-Command conda -ErrorAction SilentlyContinue
  if ($conda) {
    $resolved = & $conda.Source run -n tabkeep python -c "import sys; print(sys.executable)"
    if ($LASTEXITCODE -eq 0) {
      $candidate = ($resolved | Select-Object -Last 1).Trim()
      if (Test-Path -LiteralPath $candidate) {
        return (Resolve-Path -LiteralPath $candidate).Path
      }
    }
  }

  $python = Get-Command python -ErrorAction SilentlyContinue
  if ($python) {
    return $python.Source
  }

  throw "Python was not found. Activate the tabkeep Conda environment or pass -PythonExe."
}

function Get-RustTargetTriple {
  $rustc = Get-Command rustc -ErrorAction SilentlyContinue
  if (-not $rustc) {
    throw "rustc was not found; the Tauri sidecar target triple cannot be resolved."
  }

  $version = & $rustc.Source -vV
  $hostLine = $version | Where-Object { $_ -like "host:*" } | Select-Object -First 1
  if (-not $hostLine) {
    throw "rustc -vV did not return a host target."
  }
  return $hostLine.Substring(5).Trim()
}

function Invoke-BackendSmokeTest {
  param(
    [string] $Executable,
    [string] $DataDir,
    [int] $TimeoutSeconds
  )

  New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
  $stdoutPath = Join-Path $ReleaseDir "smoke-stdout.log"
  $stderrPath = Join-Path $ReleaseDir "smoke-stderr.log"
  Remove-Item -LiteralPath $stdoutPath, $stderrPath -Force -ErrorAction SilentlyContinue
  $oldDataDir = $env:TABKEEP_DATA_DIR
  $oldBackendPort = $env:TABKEEP_BACKEND_PORT
  $portProbe = [System.Net.Sockets.TcpListener]::new(
    [System.Net.IPAddress]::Loopback,
    0
  )
  $portProbe.Start()
  $smokePort = $portProbe.LocalEndpoint.Port
  $portProbe.Stop()
  $env:TABKEEP_DATA_DIR = $DataDir
  $env:TABKEEP_BACKEND_PORT = [string] $smokePort
  $process = $null
  $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
  try {
    $process = Start-Process `
      -FilePath $Executable `
      -WorkingDirectory (Split-Path -Parent $Executable) `
      -WindowStyle Hidden `
      -RedirectStandardOutput $stdoutPath `
      -RedirectStandardError $stderrPath `
      -PassThru

    $ready = $false
    for ($attempt = 0; $attempt -lt ($TimeoutSeconds * 2); $attempt += 1) {
      if ($process.HasExited) {
        $stderrTail = Get-Content -LiteralPath $stderrPath -Tail 20 -ErrorAction SilentlyContinue
        throw "The backend exited before the health check, exitCode=$($process.ExitCode).`n$stderrTail"
      }
      try {
        $response = Invoke-RestMethod -Uri "http://127.0.0.1:$smokePort/" -TimeoutSec 2
        if ($response.version -eq "1.0.0") {
          $ready = $true
          break
        }
        Start-Sleep -Milliseconds 500
      } catch {
        Start-Sleep -Milliseconds 500
      }
    }

    if (-not $ready) {
      $stderrTail = Get-Content -LiteralPath $stderrPath -Tail 20 -ErrorAction SilentlyContinue
      throw "The backend executable did not pass its health check within $TimeoutSeconds seconds.`n$stderrTail"
    }
    $elapsedSeconds = [Math]::Round($stopwatch.Elapsed.TotalSeconds, 1)
    Write-Host "Backend smoke test passed: version=$($response.version), startup=${elapsedSeconds}s" -ForegroundColor Green
  } finally {
    $stopwatch.Stop()
    if ($process -and -not $process.HasExited) {
      Stop-Process -Id $process.Id -Force
      $process.WaitForExit()
    }
    $env:TABKEEP_DATA_DIR = $oldDataDir
    $env:TABKEEP_BACKEND_PORT = $oldBackendPort
  }
}

$Python = Resolve-TabKeepPython
Write-Host "[TabKeep] Python: $Python" -ForegroundColor Cyan

if ($InstallDependencies) {
  & $Python -m pip install -r (Join-Path $BackendDir "requirements-build.txt")
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to install backend build dependencies."
  }
}

& $Python -c "import PyInstaller"
if ($LASTEXITCODE -ne 0) {
  throw "PyInstaller is missing. Run this script again with -InstallDependencies."
}

if (-not ($ReuseExisting -and (Test-Path -LiteralPath $ExecutablePath))) {
  New-Item -ItemType Directory -Force -Path $WorkDir, $DistDir | Out-Null
  $pyInstallerArgs = @(
    "-m",
    "PyInstaller",
    "--noconfirm",
    "--workpath",
    $WorkDir,
    "--distpath",
    $DistDir
  )
  if ($Clean) {
    $pyInstallerArgs += "--clean"
  }
  $pyInstallerArgs += $SpecPath
  & $Python @pyInstallerArgs
  if ($LASTEXITCODE -ne 0) {
    throw "PyInstaller build failed."
  }
} else {
  Write-Host "[TabKeep] Reusing existing backend executable." -ForegroundColor Yellow
}
if (-not (Test-Path -LiteralPath $ExecutablePath)) {
  throw "Backend build completed without producing $ExecutablePath"
}

if (-not $SkipSmokeTest) {
  Invoke-BackendSmokeTest `
    -Executable $ExecutablePath `
    -DataDir (Join-Path $ReleaseDir "smoke-data") `
    -TimeoutSeconds $SmokeTimeoutSeconds
}

$TargetTriple = Get-RustTargetTriple
$TauriBinaryDir = Join-Path $Root.Path "desktop\src-tauri\binaries"
$TauriBinary = Join-Path $TauriBinaryDir "tabkeep-backend-$TargetTriple.exe"
New-Item -ItemType Directory -Force -Path $TauriBinaryDir | Out-Null
Copy-Item -LiteralPath $ExecutablePath -Destination $TauriBinary -Force

$sizeMb = [Math]::Round((Get-Item -LiteralPath $ExecutablePath).Length / 1MB, 1)
Write-Host "[TabKeep] Backend built: $ExecutablePath ($sizeMb MB)" -ForegroundColor Green
Write-Host "[TabKeep] Tauri sidecar: $TauriBinary" -ForegroundColor Green
