[CmdletBinding()]
param(
    [string]$Version = "0.1.0",
    [ValidateSet("bun-windows-x64", "bun-windows-arm64")]
    [string]$Target = "bun-windows-x64",
    [string]$Out = (Join-Path $PSScriptRoot "dist"),
    [switch]$SkipInstall
)

$ErrorActionPreference = "Stop"

function Invoke-Checked {
    param(
        [Parameter(Mandatory = $true)][string]$Command,
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [Parameter(Mandatory = $true)][string]$WorkingDirectory
    )

    Write-Host ("> {0} {1}" -f $Command, ($Arguments -join " "))
    Push-Location $WorkingDirectory
    # $ErrorActionPreference = "Stop" 之下，原生命令往 stderr 写一个字 PowerShell
    # 就抛 NativeCommandError。bun 每跑一条 package script 都会把 "$ <命令>" 回显到
    # stderr，于是构建必然在第一步就断——脚本本来就检查 $LASTEXITCODE，那才是真门禁。
    $previous = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        & $Command @Arguments
        if ($LASTEXITCODE -ne 0) {
            throw "命令失败（$LASTEXITCODE）：$Command"
        }
    } finally {
        $ErrorActionPreference = $previous
        Pop-Location
    }
}

function Windows-Version([string]$RawVersion) {
    $parts = @($RawVersion -split "\." | ForEach-Object {
        $digits = ($_ -replace "[^0-9]", "")
        if ([string]::IsNullOrEmpty($digits)) { "0" } else { $digits }
    })
    while ($parts.Count -lt 4) { $parts += "0" }
    return (($parts | Select-Object -First 4) -join ".")
}

$DesktopRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
# 从 desktop/ 上一级就是仓库根；原来写的是 "..\.."，会跑到仓库外面，
# bun install 会在一个不存在的 cli/ 里执行，脚本第一步就挂。
$RepoRoot = (Resolve-Path (Join-Path $DesktopRoot "..")).Path
$Out = [IO.Path]::GetFullPath($Out)
$Arch = $Target -replace "^bun-windows-", ""
$PackageName = "OmniScientist-$Version-windows-$Arch"
$WindowsVersion = Windows-Version $Version

if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
    throw "找不到 bun。请先安装 Bun 1.3.x：https://bun.sh"
}

if (-not $SkipInstall) {
    Invoke-Checked "bun" @("install", "--frozen-lockfile") (Join-Path $RepoRoot "cli")
    Invoke-Checked "bun" @("install", "--frozen-lockfile") $DesktopRoot
}

Invoke-Checked "bun" @("run", "build:assets") $DesktopRoot

$StageParent = Join-Path ([IO.Path]::GetTempPath()) ("omniscientist-windows-" + [Guid]::NewGuid().ToString("N"))
$Stage = Join-Path $StageParent $PackageName
New-Item -ItemType Directory -Force $Stage | Out-Null
New-Item -ItemType Directory -Force $Out | Out-Null

try {
    $Executable = Join-Path $Stage "OmniScientist.exe"
    $BuildArguments = @(
        "build", "--compile", "--minify", "--target=$Target",
        "--windows-hide-console",
        "--windows-title=OmniScientist",
        "--windows-publisher=Omni-Scientist",
        "--windows-version=$WindowsVersion",
        "--windows-description=Browser-based multimodal research workspace",
        "--outfile", $Executable,
        "launcher/main.ts"
    )
    Invoke-Checked "bun" $BuildArguments $DesktopRoot

    Copy-Item (Join-Path $PSScriptRoot "install.ps1") $Stage
    Copy-Item (Join-Path $PSScriptRoot "uninstall.ps1") $Stage
    @"
OmniScientist Desktop $Version ($Arch)

安装（当前用户，不需要管理员权限）：

    powershell -ExecutionPolicy Bypass -File .\install.ps1

安装后可以从开始菜单打开 OmniScientist，也可以直接运行 OmniScientist.exe。

卸载：

    powershell -ExecutionPolicy Bypass -File .\uninstall.ps1

工作区默认是：%USERPROFILE%\OmniScientist
凭据文件是：%USERPROFILE%\.omnisci\env
运行日志是：%USERPROFILE%\.omnisci\logs

第一次运行时，界面会检查 Python 3.10+、科学计算包和 tectonic；缺少的依赖可以从工作台引导安装。
若安装了 WSL，Windows 版的 bash 工具默认通过 WSL 执行。可用 OMNISCI_SHELL=cmd 或 OMNISCI_SHELL=bash 覆盖。
"@ | Set-Content -Encoding UTF8 (Join-Path $Stage "README.txt")

    $Archive = Join-Path $Out "$PackageName.zip"
    if (Test-Path $Archive) { Remove-Item -Force $Archive }
    # 不用 Compress-Archive：Windows PowerShell 5.1 自带的那个实现打 120MB 的 exe 会
    # 直接 "Stream was not readable" 崩掉，构建到最后一步前功尽弃。.NET 的 ZipFile
    # 是同一个 Win10 上必有的组件，行为稳定。includeBaseDirectory 保持原来的目录层级。
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [System.IO.Compression.ZipFile]::CreateFromDirectory(
        $Stage, $Archive, [System.IO.Compression.CompressionLevel]::Optimal, $true)

    $Hash = Get-FileHash -Algorithm SHA256 $Archive
    "$($Hash.Hash.ToLower())  $([IO.Path]::GetFileName($Archive))" |
        Set-Content -Encoding ASCII -Path (Join-Path $Out "$PackageName.zip.sha256")

    Write-Host "wrote $Archive"
    Write-Host "sha256 $($Hash.Hash.ToLower())"
} finally {
    if (Test-Path $StageParent) { Remove-Item -Recurse -Force $StageParent }
}
