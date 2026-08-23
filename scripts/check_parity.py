#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""四份实现之间的同步校验。

一份研究流程活在四个地方：

    engine/omniscientist        参考实现，论文实验跑的就是它
    cli/skills/omnisci          CLI 版 skill，像素交给视觉侧车，回执按 SHA-256 绑定
    skill/omnisci               Claude Code 版 skill，宿主自己读像素
    desktop/                    浏览器工作台，直接 import cli/src，并复用 cli 的 skill

它们**本来就不完全一样**，这是设计（宿主读图 vs 侧车读图，是两种机制）。危险的不是
差异，是"本该一起改的地方只改了一处"。这个脚本只管后者：把跨版本必须成立的不变量
写死，谁漏了谁在这里红。

    python3 scripts/check_parity.py

新增一条规则的成本应当很低——发现一处"改 A 忘了改 B"，就在这里补一条，别指望下次
还记得。
"""
import os
import re
import sys

# Windows 的 Python 默认按 cp1252 写 stdout，这个脚本的输出是中文，一 print 就
# UnicodeEncodeError 退 1。检查全过了却把 CI 判成失败，最难查的那种失败。
try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except (AttributeError, OSError):
    pass  # 老 Python 或者被重定向到不支持的流，那就维持原样

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

CLI_SKILL = "cli/skills/omnisci/bin"
HOST_SKILL = "skill/omnisci/bin"
ENGINE = "engine/omniscientist"

problems = []
checked = 0


def read(rel):
    path = os.path.join(ROOT, rel)
    if not os.path.exists(path):
        problems.append("文件不存在：%s" % rel)
        return None
    with open(path, encoding="utf-8") as handle:
        return handle.read()


def must_contain(rel, needle, why):
    """这个文件里必须有这段东西。"""
    global checked
    checked += 1
    body = read(rel)
    if body is None:
        return
    if needle not in body:
        problems.append("%s 缺少 %r\n      %s" % (rel, needle, why))


def must_not_match(rel, pattern, why):
    """这个文件里不许再出现这种写法。"""
    global checked
    checked += 1
    body = read(rel)
    if body is None:
        return
    hits = [
        "%s:%d" % (rel, i + 1)
        for i, line in enumerate(body.splitlines())
        if re.search(pattern, line) and not line.lstrip().startswith("#")
    ]
    if hits:
        problems.append("%s 仍在用 /%s/：%s\n      %s" % (rel, pattern, ", ".join(hits), why))


def must_be_identical(rels, why):
    """这几份必须逐字节一致。"""
    global checked
    checked += 1
    bodies = {rel: read(rel) for rel in rels}
    if any(body is None for body in bodies.values()):
        return
    first = rels[0]
    for rel in rels[1:]:
        if bodies[rel] != bodies[first]:
            problems.append("%s 和 %s 不一致\n      %s" % (first, rel, why))


# ---------------------------------------------------------------- 论文排版

# natbib + 作者-年份下，裸 \cite 等价于 \citet，句末旁引会渲染成没有括号的
# "Kather et al. [2016]"。三个版本都从各自的 preamble 生成 LaTeX，漏一个就有一个
# 版本产出的论文引用是坏的。
for edition in (CLI_SKILL + "/vendor", HOST_SKILL + "/vendor", ENGINE):
    must_contain(
        edition + "/agentic.py", r"\\let\\cite\\citep",
        "少了它，这个版本产出的论文里句末引用没有括号",
    )
    must_contain(
        edition + "/venue_styles.py", r"\\let\\cite\\citep",
        "venue 换肤那条路的 preamble 也要带上，否则换肤之后又坏回去",
    )

# ---------------------------------------------------------------- 路径解析

# os.path.relpath(realpath(x), td) 在 td 位于符号链接下时（macOS 的 /tmp）会算出
# ../../../private/... 这种绕行路径，join 回去解析不到，gate 把好好的运行判成 stale。
for rel in (CLI_SKILL + "/gate_cli.py", HOST_SKILL + "/gate_cli.py",
            CLI_SKILL + "/paper_cli.py"):
    must_contain(rel, "_case_relpath", "case 内相对路径必须两边都 realpath 之后再算")
    must_not_match(
        rel, r"os\.path\.relpath\([a-z_]+, td\)",
        "裸 relpath 会在符号链接工作区下算出绕行路径",
    )

# ---------------------------------------------------------------- PowerShell 编码

# 实测踩过：Windows PowerShell 5.1 读没有 BOM 的 UTF-8 文件时按系统 ANSI 代码页
# 解码，脚本里的中文注释变成乱码，整个文件报 Unexpected token 跑不起来。
# 也就是说 Windows 用户复制一键安装命令下去会直接失败，而我们在 mac 上完全看不见。
def must_have_bom(rel, why):
    """PowerShell 脚本必须带 UTF-8 BOM。"""
    global checked
    checked += 1
    path = os.path.join(ROOT, rel)
    if not os.path.exists(path):
        problems.append("文件不存在：%s" % rel)
        return
    with open(path, "rb") as handle:
        if not handle.read(3).startswith(b"\xef\xbb\xbf"):
            problems.append("%s 没有 UTF-8 BOM\n      %s" % (rel, why))


for _ps1 in ("install.ps1",
             "desktop/packaging/windows/install.ps1",
             "desktop/packaging/windows/build-windows.ps1",
             "desktop/packaging/windows/uninstall.ps1"):
    must_have_bom(_ps1, "Windows PowerShell 5.1 会把无 BOM 的 UTF-8 当 ANSI 读，中文注释变乱码后整个脚本解析失败")

# ---------------------------------------------------------------- 审阅页渲染

# 踩过：审阅页渲染硬依赖 poppler 的 pdftoppm，而它既不在 requirements 也不在
# doctor 里，装没装全靠运气；GUI 启动的应用 PATH 又只有四个系统目录，brew 装了
# 也看不见。结果是论文编译成功、卡在渲染审阅页，agent 反复要用户手敲 ln -s。
must_contain(
    CLI_SKILL + "/paper_cli.py", "_render_review_pages",
    "审阅页渲染必须走受管依赖，不能直接调外部程序",
)
must_contain(
    "cli/skills/omnisci/requirements.txt", "pypdfium2",
    "渲染器要在依赖清单里，doctor 和 bootstrap 才认得它",
)
must_not_match(
    CLI_SKILL + "/paper_cli.py", r'return finish\("error", error="pdftoppm is missing',
    "缺 pdftoppm 不该直接判死，受管渲染器才是主路径",
)

# 两份 requirements 分叉了，docs/INSTALL.md 里"权威清单"那句话就成了假的。
must_be_identical(
    ["cli/skills/omnisci/requirements.txt", "skill/omnisci/requirements.txt"],
    "两份依赖清单必须一致，文档把其中一份当权威清单在引用",
)

# ---------------------------------------------------------------- 两份 skill

# 这几个文件今天逐字节一致，没有任何该分叉的理由。分叉了就是有人只改了一边。
for name in ("case_cli.py", "vendor/evidence.py", "vendor/venue_styles.py", "vendor/writer.py"):
    must_be_identical(
        [CLI_SKILL + "/" + name, HOST_SKILL + "/" + name],
        "两份 skill 的这个文件没有该分叉的理由，八成是只改了一边",
    )

# ---------------------------------------------------------------- CLI 与桌面

# 桌面和 CLI 共用 cli/src 那套循环，但"跑一篇论文给多少轮预算"是各自传的。
# 桌面用默认的 80 轮会在感知做完、论文没编时被砍断，跟 CLI 当初一模一样的死法。
must_contain(
    "desktop/gateway/server.ts", "UNATTENDED_MAX_TURNS",
    "桌面跑论文和 CLI 的 --data 是同一条长流水线，不能用交互式的轮次预算",
)
must_contain(
    "cli/src/cli.tsx", "UNATTENDED_MAX_TURNS",
    "CLI 的 --data 无人值守路径要用加长预算",
)

# 论文工具靠 OMNISCI 找 python 脚本，没有就必然抛。桌面两处都设了，CLI 曾经漏掉，
# 于是命令行永远编不出论文，而系统提示里还写着"已把 OMNISCI 设为…"。
must_contain(
    "cli/src/bootstrap.ts", "process.env.OMNISCI =",
    "CLI 不设 OMNISCI 的话 omnisci_record / omnisci_compile 必然抛",
)
must_contain(
    "desktop/gateway/server.ts", "process.env.OMNISCI =",
    "gateway 同样要设，否则浏览器里跑论文也编不出来",
)

# 视觉侧车的三个环境变量，CLI 读它们、桌面写它们，名字必须对上，否则界面上配好了
# 命令行读不到。
for name in ("OMNISCI_VISION_PROVIDER", "OMNISCI_VISION_MODEL", "OMNISCI_VISION_EFFORT"):
    must_contain("cli/src/tools/vision.ts", name, "CLI 侧要读这个变量")
    must_contain("desktop/gateway/model-config.ts", name, "桌面侧要写同一个变量")

# 更新检查的开关只有一个名字。界面上关掉的是它，CLI 启动时读的也得是它；bash 启动器
# 有白名单，不在名单里就会被静默丢掉，于是"界面上关了、命令行还在查"。
for rel in ("cli/src/update.ts", "desktop/gateway/model-config.ts", "cli/bin/credential-env.sh"):
    must_contain(rel, "OMNISCI_UPDATE_CHECK", "更新检查开关三处要用同一个变量名")

# 检查到新版本只提示、不安装。哪天有人在这里加了下载和替换，这条会红。
must_not_match(
    "cli/src/update.ts", r"browser_download_url.*(writeFile|spawn|exec)|createWriteStream",
    "更新检查只报告，下载和替换是用户自己的决定",
)

# 更新提示要给下载链接和 sha256，就得认得出 release 里挂的产物名。那些名字由工作流拼，
# 三个平台三个规则（Windows 的带版本号、macOS 那段叫 macos 不叫 darwin），改了名字而
# 这边没跟上，提示就退化成一句光秃秃的"有新版本"，校验和链接永远不出现。
for token, where, why in (
    ("OmniScientist-macos-", ".github/workflows/release.yml", "macOS 桌面包名"),
    ("OmniScientist-linux-", ".github/workflows/release.yml", "Linux 桌面包名"),
    ("omnisci-windows-x86_64.exe", ".github/workflows/release.yml", "Windows CLI 产物名"),
    ("OmniScientist-$Version-windows-$Arch",
     "desktop/packaging/windows/build-windows.ps1", "Windows 桌面包名带版本号"),
):
    must_contain(where, token, "update.ts 的产物匹配是照着这个名字写的：%s" % why)

for token, why in (
    ('? "macos" : "linux"', "桌面包里 macOS 那段叫 macos，不是 process.platform 的 darwin"),
    (r"-windows-x64\\.zip", "Windows 桌面包是 zip，架构段是 x64"),
    (r"(?:-\d[\w.]*)?", "Windows 包名中间那截版本号要能跳过"),
):
    must_contain("cli/src/update.ts", token, why)

# ---------------------------------------------------------------------------
# 安装脚本能拼出来的产物名，release 必须真的构建
#
# 上面几条只验"名字的写法一致"，验不出"这个名字压根没人构建"。后者才是会让用户
# 拿到 404 的那种，而且只有那个平台的用户会遇到，我们自己永远撞不到。
#
# 所以这里按平台把安装脚本会请求的名字全列出来，逐个回 release.yml 里点名。
# 只认 matrix 里的那几行。不能拿整个文件去 grep：publish 那一步有一份"必须有的
# 产物"名单，整文件搜索会搜到它，于是矩阵里删掉一格照样过 —— 自己证明自己。
_release_body = read(".github/workflows/release.yml") or ""
_matrix_lines = [ln for ln in _release_body.splitlines() if re.search(r"^\s*- \{ runner:", ln)]
_matrix = "\n".join(_matrix_lines)

# Intel Mac（omnisci-darwin-x86_64 / OmniScientist-macos-x86_64.tar.gz）**有意不发**，
# 2026-08-18 定的。所以它不在下面这张名单里：install.sh 在 Intel Mac 上照样会拼出
# 那个名字并拿到 404，那是已知取舍，不是这个脚本该拦的东西。
for asset, why in (
    ("asset: omnisci-linux-x86_64", "install.sh 的 Linux x86_64"),
    ("asset: omnisci-linux-arm64", "install.sh 的 Linux arm64"),
    ("asset: omnisci-darwin-arm64", "install.sh 的 Apple silicon"),
    ("asset: omnisci-windows-x86_64.exe", "install.ps1（ARM64 也回落到这个）"),
):
    checked += 1
    if asset not in _matrix:
        problems.append(
            ".github/workflows/release.yml 的 cli matrix 不构建 %r\n"
            "      安装脚本会去下它，构建不出来就是那个平台的用户拿到 404：%s" % (asset, why))

# 桌面包的名字在工作流里是 ${{ matrix.arch }} 拼的，抓不到字面量，所以点 matrix 本身。
checked += 1
if not re.search(r"os: macos,\s+arch: arm64\b", _matrix):
    problems.append(
        ".github/workflows/release.yml 的 desktop matrix 少了 macOS arm64\n"
        "      官网 setup/mac-desktop.md 会去下它")

# install.ps1 不许再去要一个没人构建的 ARM64 exe。
must_not_match(
    "install.ps1", r"omnisci-windows-arm64",
    "上游没有 Windows ARM64 的构建；ARM64 应当回落到 x86_64，由系统模拟执行",
)

# 版本号躺在四个地方。它们只要有一处对不上，更新检查就会拿一个假的"当前版本"去跟
# release tag 比：说低了就永远提示有新版本（用户更新完还在提示），说高了就永远不提示。
VERSIONS = {
    "cli/package.json": r'"version":\s*"([^"]+)"',
    "cli/src/cli.tsx": r'const VERSION = "([^"]+)"',
    "desktop/package.json": r'"version":\s*"([^"]+)"',
    "desktop/launcher/main.ts": r'const VERSION = "([^"]+)"',
}
checked += 1
found = {}
for rel, pattern in VERSIONS.items():
    body = read(rel)
    if body is None:
        continue
    m = re.search(pattern, body)
    if not m:
        problems.append("%s 里找不到版本号（/%s/）" % (rel, pattern))
    else:
        found[rel] = m.group(1)
if len(set(found.values())) > 1:
    problems.append(
        "版本号对不上：%s\n      发版时四处要一起改，否则更新提示会拿错的当前版本去比"
        % ", ".join("%s=%s" % kv for kv in sorted(found.items()))
    )

# ------------------------------------------------------- 解释器一律探测后再用

# 硬编码 spawn("python3") / spawn("bash") 在 Windows 上必挂，而且挂得很隐蔽：
#   python3 → 微软商店的 2 字节占位符，跑起来退 49，所有论文工具全废
#   bash    → C:\Windows\System32\bash.exe，也就是 WSL 启动器，命令跑进另一个
#             操作系统，看到 /mnt/c/… 拿不到宿主环境变量
# 两个都得走 interpreters.ts，那里是真跑一次让候选自报身份。
for rel in ("cli/src/tools/omnisci.ts", "cli/src/delivery.ts",
            "cli/src/tools/shell.ts", "cli/src/hooks.ts",
            "desktop/launcher/main.ts"):
    must_not_match(
        rel, r'Bun\.spawn\(\s*\[\s*"(python3?|bash)"',
        "解释器要用 interpreters.ts 探测出来的，不能写死名字",
    )

# which/where 只回答"文件在不在"。占位符是存在的，所以这个判据本身就是错的。
must_not_match(
    "desktop/launcher/main.ts", r'which\("python',
    "选 python 要用 pythonCommand()，它跑一次才认，which 会选中商店占位符",
)

# 探测必须真的执行候选，而不是退回成判存在。
for needle, why in (
    ("sys.version_info[0]", "python 候选要自己报出主版本号才算通过"),
    ("$OSTYPE", "shell 候选要自报 OSTYPE，msys/cygwin 才是 Windows 原生 bash"),
    ("whichAll", "PATH 上同名的都要试，坏的排在前面时要能跳过"),
):
    must_contain("cli/src/interpreters.ts", needle, why)

# ---------------------------------------------------------------- 结果

if problems:
    print("check_parity: %d 项检查，%d 处不同步\n" % (checked, len(problems)))
    for item in problems:
        print("  - %s" % item)
    sys.exit(1)

print("check_parity: %d 项检查，四份实现同步" % checked)
