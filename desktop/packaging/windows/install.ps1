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

# 图标也要装过去，快捷方式指的是装好之后那份。只复制 exe 的话，
# $InstallRoot\OmniScientist.ico 不存在，快捷方式就退回默认图标。
$IconSource = Join-Path $PSScriptRoot "OmniScientist.ico"
if (Test-Path $IconSource) {
    Copy-Item -Force $IconSource (Join-Path $InstallRoot "OmniScientist.ico")
}
New-Item -ItemType Directory -Force (Split-Path $Shortcut) | Out-Null

$Shell = New-Object -ComObject WScript.Shell
$Link = $Shell.CreateShortcut($Shortcut)
$Link.TargetPath = $Executable
$Link.WorkingDirectory = $InstallRoot
$Link.Description = "OmniScientist browser-based research workspace"
# 快捷方式默认会取 exe 内嵌的图标，但装到别处、或者 exe 换了之后
# 图标缓存经常不刷新。显式指向随包发出的那份 .ico，行为稳定。
$IconFile = Join-Path $InstallRoot "OmniScientist.ico"
if (Test-Path $IconFile) { $Link.IconLocation = $IconFile }
$Link.Save()

Write-Host "OmniScientist 已安装。"
Write-Host "  开始菜单：OmniScientist"
Write-Host "  程序：$Executable"
Write-Host "  卸载：powershell -ExecutionPolicy Bypass -File `"$PSScriptRoot\uninstall.ps1`""
