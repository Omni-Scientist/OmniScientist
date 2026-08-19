# OmniScientist CLI installer for Windows.
#
#   irm https://raw.githubusercontent.com/Omni-Scientist/OmniScientist/main/install.ps1 | iex
#
# Downloads one file. The binary carries the skill inside it, so there is nothing to
# unpack and no layout to preserve.
#
#   $env:VERSION = 'v0.1.0'          pin a release instead of taking the latest
#   $env:BIN_DIR = 'C:\tools'        install somewhere else
#
# STATUS: the Windows build is produced by CI but has not been run by anyone on a
# Windows machine. Treat it as untested. docs/INSTALL.md says what to check, and a
# report of what works would be welcome.
$ErrorActionPreference = 'Stop'

$Repo    = 'Omni-Scientist/OmniScientist'
$BinDir  = if ($env:BIN_DIR) { $env:BIN_DIR } else { Join-Path $env:LOCALAPPDATA 'OmniScientist\bin' }
$Version = if ($env:VERSION) { $env:VERSION } else { 'latest' }

# ARM64 也拿 x64 那个包。Windows on ARM 透明模拟 x64，跑得动；
# 而以前这里映射到 omnisci-windows-arm64.exe，那个资产从来没有被构建过，
# 于是 ARM 机器上必然 404 —— 报"没有你这个架构的构建"都比拿到 404 强。
$arch = switch ($env:PROCESSOR_ARCHITECTURE) {
  'AMD64' { 'x86_64' }
  'ARM64' { 'x86_64' }
  default { throw "没有 $($env:PROCESSOR_ARCHITECTURE) 架构的构建" }
}
if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') {
  Write-Host 'Windows ARM64：装 x64 版本，由系统模拟执行。'
}

$asset = "omnisci-windows-$arch.exe"
$base  = if ($Version -eq 'latest') {
  "https://github.com/$Repo/releases/latest/download"
} else {
  "https://github.com/$Repo/releases/download/$Version"
}

$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ([System.IO.Path]::GetRandomFileName())
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
  Write-Host "下载 $asset ..."
  $exe = Join-Path $tmp 'omnisci.exe'
  Invoke-WebRequest -Uri "$base/$asset" -OutFile $exe -UseBasicParsing

  # 校验和可选：release 里有 SHA256SUMS 就核。所有产物的校验和都在这一个文件里，
  # 以前是每个产物旁边挂一个 .sha256，release 列表被撑成两倍长。
  #
  # 下载和核对分成两段：以前合在一个 try 里，而 404 在 5.1 抛 WebException、在 7 抛
  # HttpResponseException，只 catch 前者的话 PS7 上少个校验和文件会直接把安装打断。
  $sumFile = Join-Path $tmp 'SHA256SUMS'
  $haveSums = $true
  try {
    Invoke-WebRequest -Uri "$base/SHA256SUMS" -OutFile $sumFile -UseBasicParsing
  } catch {
    $haveSums = $false
    Write-Host '这个 release 没带校验和，跳过校验'
  }
  if ($haveSums) {
    # 第二列可能带 * 前缀，那是 sha256sum 的二进制模式写出来的。
    $want = Get-Content $sumFile | ForEach-Object {
      $parts = $_ -split '\s+', 2
      if ($parts.Count -eq 2 -and $parts[1].Trim().TrimStart('*') -eq $asset) { $parts[0] }
    } | Select-Object -First 1
    if (-not $want) {
      Write-Host "SHA256SUMS 里没有 ${asset}，跳过校验"
    } else {
      $got = (Get-FileHash -Algorithm SHA256 $exe).Hash.ToLower()
      if ($got -ne $want.ToLower()) { throw '校验和不匹配，下载的文件不对' }
      Write-Host '校验和通过'
    }
  }

  New-Item -ItemType Directory -Path $BinDir -Force | Out-Null
  Move-Item -Force $exe (Join-Path $BinDir 'omnisci.exe')
} finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}

Write-Host ''
Write-Host "装好了: $(Join-Path $BinDir 'omnisci.exe')"

$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($userPath -notlike "*$BinDir*") {
  [Environment]::SetEnvironmentVariable('Path', "$userPath;$BinDir", 'User')
  Write-Host "已加入用户 PATH，新开一个终端才生效。"
}

Write-Host ''
Write-Host '还需要一个 API key，写进 %USERPROFILE%\.omnisci\env：'
Write-Host '  DEEPSEEK_API_KEY=...'
Write-Host '  ANTHROPIC_API_KEY=...     # 看图、信号、音视频、三维数据时用到'
Write-Host ''
Write-Host "出 PDF 还要 python3 和 tectonic，装法见"
Write-Host "  https://github.com/$Repo/blob/main/docs/INSTALL.md"
