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
# 包名不带版本号：release 里所有产物都不带，这样 releases/latest/download/<name>
# 是一条永远有效的链接。以前只有这一个包带（脚本自己塞的），于是它成了唯一做不了
# 直链的产物，assetPatternFor() 还得留一段可选的 -1.2.3 专门兜它。2026-08-25 统一。
# 版本号仍然刻进 exe 的版本信息和 README.txt，只是不进文件名。
$PackageName = "OmniSci-Desktop-Windows-$Arch"
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
        # 不传这条的话 exe 用的是系统默认图标，任务栏、开始菜单、资源管理器里
        # 全是一张白纸，跟 macOS 那边有 Dock 图标的观感差一大截。
        "--windows-icon=$(Join-Path $PSScriptRoot 'OmniScientist.ico')",
        "--outfile", $Executable,
        "launcher/main.ts"
    )
    Invoke-Checked "bun" $BuildArguments $DesktopRoot

    Copy-Item (Join-Path $PSScriptRoot "OmniScientist.ico") $Stage
    Copy-Item (Join-Path $PSScriptRoot "install.cmd") $Stage
    Copy-Item (Join-Path $PSScriptRoot "uninstall.cmd") $Stage
    @"
OmniScientist Desktop $Version ($Arch)

安装（当前用户，不需要管理员权限）：

    双击 install.cmd

装完会自动启动。以后从开始菜单打开 OmniScientist，或直接运行 OmniScientist.exe。

卸载：

    双击 uninstall.cmd

工作区默认是：%USERPROFILE%\OmniScientist
凭据文件是：%USERPROFILE%\.omnisci\env
运行日志是：%USERPROFILE%\.omnisci\logs

第一次运行时，界面会检查 Python 3.10+、科学计算包和 tectonic；缺少的依赖可以从工作台引导安装。

bash 工具需要原生 bash，装 Git for Windows 即可（https://git-scm.com/download/win）。
WSL 的 bash 会被拒绝：它跑在另一个操作系统里，看到的是 /mnt/c/... 而不是 C:\...，
也拿不到本进程的环境变量，命令会以难以察觉的方式出错。要指定别的用 OMNISCI_SHELL。
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
