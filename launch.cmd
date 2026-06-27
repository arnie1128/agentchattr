@echo off
REM agentchattr - stable public launch entry.  Usage: launch.cmd <target> [args]
REM   <target> = open | server | <agent>   (e.g. launch.cmd codex)
REM Instances call ONLY this entry; engine-internal launcher paths may change
REM freely behind it without breaking any instance.
setlocal enableextensions
cd /d "%~dp0"

set "TARGET=%~1"
if "%TARGET%"=="" set "TARGET=server"

if /i "%TARGET%"=="open" (
    if defined AGENTCHATTR_PORT (set "P=%AGENTCHATTR_PORT%") else (set "P=8300")
    start "" "http://127.0.0.1:%P%"
    endlocal & exit /b 0
)

set "REST="
for /f "tokens=1*" %%a in ("%*") do set "REST=%%b"

if /i "%TARGET%"=="server" (
    call "launchers\windows\start.bat" %REST%
) else (
    call "launchers\windows\start_%TARGET%.bat" %REST%
)
endlocal
