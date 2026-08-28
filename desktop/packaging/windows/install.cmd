@echo off
setlocal
title OmniScientist Installer

set "SRC=%~dp0"
set "DEST=%LOCALAPPDATA%\Programs\OmniScientist"
set "EXE=%DEST%\OmniScientist.exe"
set "LNK=%APPDATA%\Microsoft\Windows\Start Menu\Programs\OmniScientist.lnk"

if not exist "%SRC%OmniScientist.exe" (
    echo [error] OmniScientist.exe not found next to this script.
    goto :fail
)

rem A running copy keeps the exe locked and the copy below would fail with a
rem cryptic sharing violation. Say it in plain words and ask before closing it.
tasklist /FI "IMAGENAME eq OmniScientist.exe" 2>nul | find /I "OmniScientist.exe" >nul
if not errorlevel 1 (
    echo OmniScientist is currently running. It must be closed before installing.
    choice /C YN /M "Close it now and continue"
    if errorlevel 2 goto :cancelled
    taskkill /F /IM OmniScientist.exe >nul 2>nul
    timeout /T 2 /NOBREAK >nul
)

if not exist "%DEST%" mkdir "%DEST%"
copy /Y "%SRC%OmniScientist.exe" "%EXE%" >nul || goto :fail
if exist "%SRC%OmniScientist.ico" copy /Y "%SRC%OmniScientist.ico" "%DEST%\OmniScientist.ico" >nul

rem Batch cannot create a .lnk by itself; write a throwaway VBScript and run it.
rem cscript ships with every Windows, so this adds no dependency.
set "VBS=%TEMP%\omnisci-shortcut.vbs"
> "%VBS%" echo Set shell = CreateObject("WScript.Shell")
>> "%VBS%" echo Set link = shell.CreateShortcut("%LNK%")
>> "%VBS%" echo link.TargetPath = "%EXE%"
>> "%VBS%" echo link.WorkingDirectory = "%DEST%"
>> "%VBS%" echo link.IconLocation = "%DEST%\OmniScientist.ico"
>> "%VBS%" echo link.Description = "OmniScientist browser-based research workspace"
>> "%VBS%" echo link.Save
cscript //nologo "%VBS%" || goto :fail
del "%VBS%" >nul 2>nul

echo Installed. From now on, open OmniScientist from the Start Menu.
echo Starting OmniScientist...
start "" "%EXE%"
goto :done

:cancelled
echo Installation cancelled. Close OmniScientist, then run install.cmd again.
goto :done

:fail
echo Installation failed.

:done
echo.
pause
endlocal
