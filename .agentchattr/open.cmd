@echo off
REM Open this project's chat room in the browser (uses this instance's port).
setlocal enableextensions

set "AGENTCHATTR_CONFIG_DIR=%~dp0"
if "%AGENTCHATTR_CONFIG_DIR:~-1%"=="\" set "AGENTCHATTR_CONFIG_DIR=%AGENTCHATTR_CONFIG_DIR:~0,-1%"

where python3 >nul 2>&1 && (set "PY=python3") || (set "PY=python")

for /f "usebackq tokens=1,* delims==" %%A in (`""%PY%" "%AGENTCHATTR_CONFIG_DIR%\_load.py" "%AGENTCHATTR_CONFIG_DIR%\config.toml" "%AGENTCHATTR_CONFIG_DIR%""`) do (
    set "%%A=%%B"
)

if "%AGENTCHATTR_ROOT%"=="" (
    echo ERROR: open.cmd: _load.py did not produce AGENTCHATTR_ROOT. >&2
    endlocal
    exit /b 1
)

call "%AGENTCHATTR_ROOT%\launch.cmd" open
endlocal
