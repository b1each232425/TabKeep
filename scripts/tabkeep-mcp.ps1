$ErrorActionPreference = "Stop"

$Root = Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")
$Backend = Join-Path $Root.Path "backend"
Set-Location -LiteralPath $Backend

# 优先使用项目约定的 tabkeep 环境；没有该环境时再回退到 conda/PATH。
# MCP 的 stdin/stdout 必须原样透传，因此不在当前脚本里执行 conda activate。
$PythonPath = $env:TABKEEP_PYTHON
if ([string]::IsNullOrWhiteSpace($PythonPath)) {
  $UserEnvPython = Join-Path $env:USERPROFILE ".conda\envs\tabkeep\python.exe"
  if (Test-Path -LiteralPath $UserEnvPython) {
    $PythonPath = $UserEnvPython
  }
}

if (-not [string]::IsNullOrWhiteSpace($PythonPath)) {
  & $PythonPath (Join-Path $Backend "mcp_server.py")
  exit $LASTEXITCODE
}

$CondaCommand = Get-Command conda.exe -ErrorAction SilentlyContinue
if ($null -ne $CondaCommand) {
  & $CondaCommand.Source run --no-capture-output -n tabkeep python (Join-Path $Backend "mcp_server.py")
  exit $LASTEXITCODE
}

$PathPython = Get-Command python.exe -ErrorAction SilentlyContinue | Select-Object -First 1
if ($null -eq $PathPython) {
  throw "python was not found in PATH and the tabkeep environment could not be located."
}

& $PathPython.Source (Join-Path $Backend "mcp_server.py")
exit $LASTEXITCODE
