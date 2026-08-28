@echo off
setlocal
title OmniScientist Uninstaller

set "DEST=%LOCALAPPDATA%\Programs\OmniScientist"
set "LNK=%APPDATA%\Microsoft\Windows\Start Menu\Programs\OmniScientist.lnk"

tasklist /FI "IMAGENAME eq OmniScientist.exe" 2>nul | find /I "OmniScientist.exe" >nul
if not errorlevel 1 (
    echo OmniScientist is running. Close it first, then run uninstall.cmd again.
    goto :done
)

if exist "%DEST%" rd /S /Q "%DEST%"
if exist "%LNK%" del "%LNK%"
echo Uninstalled. Your workspace and data were kept:
echo   %USERPROFILE%\OmniScientist
echo   %USERPROFILE%\.omnisci
echo   %LOCALAPPDATA%\OmniScientist
echo Delete those folders manually if you no longer want them.

:done
echo.
pause
endlocal
