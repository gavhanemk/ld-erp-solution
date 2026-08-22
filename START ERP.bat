@echo off
REM LD ERP Solution — double-click this to start the ERP.
REM
REM Windows will not run a .ps1 file on double-click, so this .bat hands it to
REM PowerShell. %~dp0 is this file's own folder, so it works no matter where
REM the shortcut is launched from.

title LD ERP Solution - Launcher
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0START ERP.ps1"
