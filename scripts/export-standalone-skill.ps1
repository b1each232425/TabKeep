$ErrorActionPreference = "Stop"

$Root = Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")
$Exporter = Join-Path $Root.Path "scripts\export_standalone_skill.py"
Set-Location -LiteralPath $Root.Path

# 优先使用项目约定环境，也允许通过 TABKEEP_PYTHON 指定解释器。
$PythonPath = $env:TABKEEP_PYTHON
if ([string]::IsNullOrWhiteSpace($PythonPath)) {
  $UserEnvPython = Join-Path $env:USERPROFILE ".conda\envs\tabkeep\python.exe"
  if (Test-Path -LiteralPath $UserEnvPython) {
    $PythonPath = $UserEnvPython
  }
}

if (-not [string]::IsNullOrWhiteSpace($PythonPath)) {
  & $PythonPath $Exporter @args
  exit $LASTEXITCODE
}

$CondaCommand = Get-Command conda.exe -ErrorAction SilentlyContinue
if ($null -ne $CondaCommand) {
  & $CondaCommand.Source run --no-capture-output -n tabkeep python $Exporter @args
  exit $LASTEXITCODE
}

$PathPython = Get-Command python.exe -ErrorAction SilentlyContinue | Select-Object -First 1
if ($null -eq $PathPython) {
  throw "python was not found in PATH and the tabkeep environment could not be located."
}

& $PathPython.Source $Exporter @args
exit $LASTEXITCODE
