[CmdletBinding()]
param(
    [switch]$Uninstall,
    [switch]$PurgeData
)

$ErrorActionPreference = "Stop"
$InstallRoot = Join-Path $env:LOCALAPPDATA "Programs\OmniScientist"
$Executable = Join-Path $InstallRoot "OmniScientist.exe"
$Shortcut = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\OmniScientist.lnk"

function Remove-IfPresent([string]$Path) {
    if (Test-Path $Path) { Remove-Item -Recurse -Force $Path }
}

if ($Uninstall) {
    Remove-IfPresent $InstallRoot
    Remove-IfPresent $Shortcut
    if ($PurgeData) {
        Remove-IfPresent (Join-Path $env:LOCALAPPDATA "OmniScientist")
        Remove-IfPresent (Join-Path $env:USERPROFILE ".omnisci")
    }
    Write-Host "OmniScientist 已卸载。工作区和运行数据默认保留。"
    if ($PurgeData) { Write-Host "已按要求删除托管依赖和 ~/.omnisci；工作区目录仍保留。" }
    exit 0
}

$Source = Join-Path $PSScriptRoot "OmniScientist.exe"
if (-not (Test-Path $Source)) {
    throw "同目录下找不到 OmniScientist.exe"
}

New-Item -ItemType Directory -Force $InstallRoot | Out-Null
Copy-Item -Force $Source $Executable
New-Item -ItemType Directory -Force (Split-Path $Shortcut) | Out-Null

$Shell = New-Object -ComObject WScript.Shell
$Link = $Shell.CreateShortcut($Shortcut)
$Link.TargetPath = $Executable
$Link.WorkingDirectory = $InstallRoot
$Link.Description = "OmniScientist browser-based research workspace"
$Link.Save()

Write-Host "OmniScientist 已安装。"
Write-Host "  开始菜单：OmniScientist"
Write-Host "  程序：$Executable"
Write-Host "  卸载：powershell -ExecutionPolicy Bypass -File `"$PSScriptRoot\uninstall.ps1`""
