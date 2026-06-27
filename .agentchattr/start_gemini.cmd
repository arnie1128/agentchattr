@echo off
REM Start Gemini wrapper for this project (auto-starts server if needed).
setlocal enableextensions

set "AGENTCHATTR_CONFIG_DIR=%~dp0"
if "%AGENTCHATTR_CONFIG_DIR:~-1%"=="\" set "AGENTCHATTR_CONFIG_DIR=%AGENTCHATTR_CONFIG_DIR:~0,-1%"

if not exist "%AGENTCHATTR_CONFIG_DIR%\_load.py" (
    echo ERROR: start_gemini.cmd: %AGENTCHATTR_CONFIG_DIR%\_load.py not found. >&2
    endlocal
    exit /b 1
)

where python3 >nul 2>&1 && (set "PY=python3") || (set "PY=python")

for /f "usebackq tokens=1,* delims==" %%A in (`""%PY%" "%AGENTCHATTR_CONFIG_DIR%\_load.py" "%AGENTCHATTR_CONFIG_DIR%\config.toml" "%AGENTCHATTR_CONFIG_DIR%""`) do (
    set "%%A=%%B"
)

if "%AGENTCHATTR_ROOT%"=="" (
    echo ERROR: start_gemini.cmd: _load.py did not produce AGENTCHATTR_ROOT. >&2
    endlocal
    exit /b 1
)

call "%AGENTCHATTR_ROOT%\launch.cmd" gemini --agent-cwd "%AGENT_CWD%" %*
endlocal
