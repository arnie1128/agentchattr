@echo off
REM agentchattr — starts server (if not running) + Claude wrapper
cd /d "%~dp0.."

REM Auto-create venv and install deps on first run
if not exist ".venv" (
    python -m venv .venv
    .venv\Scripts\pip install -q -r requirements.txt >nul 2>nul
)
call .venv\Scripts\activate.bat

REM Pre-flight: check that claude CLI is installed
where claude >nul 2>&1
if %errorlevel% neq 0 (
    echo.
    echo   Error: "claude" was not found on PATH.
    echo   Install it first, then try again.
    echo.
    pause
    exit /b 1
)

REM Determine which port to monitor for the running server.
REM AGENTCHATTR_PORT may be set by a project-local wrapper for isolation;
REM if unset, fall back to the default 8300.
if defined AGENTCHATTR_PORT (set "AGENTCHATTR_CHECK_PORT=%AGENTCHATTR_PORT%") else (set "AGENTCHATTR_CHECK_PORT=8300")

REM Start server if not already running, then wait for it.
netstat -ano | findstr /C:":%AGENTCHATTR_CHECK_PORT% " | findstr LISTENING >nul 2>&1
if %errorlevel% neq 0 (
    REM The spawned cmd inherits AGENTCHATTR_* through Win32 process creation
    REM (the parent .cmd / .bat already has them set via setlocal). Inheriting
    REM avoids quoting hazards from paths containing & | ^ or other batch
    REM metacharacters that would otherwise need escaping in the command string.
    start "agentchattr server" cmd /c "python run.py"
)
:wait_server
netstat -ano | findstr /C:":%AGENTCHATTR_CHECK_PORT% " | findstr LISTENING >nul 2>&1
if %errorlevel% neq 0 (
    timeout /t 1 /nobreak >nul
    goto :wait_server
)

python wrapper.py claude %*
if %errorlevel% neq 0 (
    echo.
    echo   Agent exited unexpectedly. Check the output above.
    pause
)
