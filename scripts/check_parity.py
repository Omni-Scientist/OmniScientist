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


# 桌面版的 install/uninstall 已换成 .cmd（batch 不吃 BOM，加了反而坏），
# 这里只剩根目录 CLI 安装脚本和打包脚本两个 ps1 要查。
for _ps1 in ("install.ps1",
             "desktop/packaging/windows/build-windows.ps1"):
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

# 更新提示要给下载链接和 sha256，就得认得出 release 里挂的产物名。名字在 2026-08-25
# 统一过：一律 <产品>-<平台>[-<架构>].<扩展名>，一律不带版本号，一律用人话。改了名字
# 而这边没跟上，提示就退化成一句光秃秃的"有新版本"，校验和链接永远不出现。
# 0.2.0 起桌面包由 release.yml 通过 workflow_call 调三条 desktop-*.yml 构建，
# publish 统一改成稳定名（不带版本号）挂载，SHA256SUMS 也在那里对最终字节算。
for token, where, why in (
    ("OmniSci-Desktop-macOS.zip", ".github/workflows/desktop-macos.yml", "macOS 桌面包打包时就用稳定名"),
    ("OmniSci-Desktop-macOS.zip", ".github/workflows/release.yml", "publish 点名的 macOS 桌面包名"),
    ("OmniSci-Desktop-Linux-x64.deb", ".github/workflows/release.yml", "publish 改名并点名的 Linux 桌面包名"),
    ("OmniSci-Desktop-Windows-x64-setup.exe", ".github/workflows/release.yml", "publish 改名并点名的 Windows 桌面包名"),
):
    must_contain(where, token, "update.ts 的产物匹配是照着这个名字写的：%s" % why)

for token, why in (
    ('"omnisci-CLI" : "OmniSci-Desktop"', "两条产品线的前缀"),
    ("-Windows-x64.zip", "Windows 的 CLI 是 zip，架构段是 x64"),
    ("-Windows-x64-setup.exe", "Windows 的桌面版是 NSIS 安装器（0.2.0 起）"),
    ("-macOS.tar.gz", "macOS 的 CLI 是 tar.gz"),
    ("-macOS.zip", "macOS 的桌面版是 zip"),
    ("-Linux-${linuxArch}.deb", "Linux 的桌面版是 .deb（0.2.0 起）"),
    ('"ARM64" : "x64"', "Linux 架构段用人话，不是 uname 的 aarch64/x86_64"),
):
    must_contain("cli/src/update.ts", token, why)

# 名字里不许再出现版本号。2026-08-25 之前只有 Windows 桌面包带，那一个例外让它成了
# 唯一做不了 latest/download 直链的产物，update.ts 还得留一段可选正则去兜。
must_not_match(
    "cli/src/update.ts", r"\(\?:-\\d",
    "产物名一律不带版本号，不该再有「跳过版本号」的可选正则",
)

# ---------------------------------------------------------------------------
# CLI 停发（2026-09-02 定）：release 只出桌面三平台 + skill。install.sh / install.ps1
# 保留在原地，但开头就明确报停发并指去 releases 页，绝不让老用户拿到裸 404。
for rel in ("install.sh", "install.ps1"):
    must_contain(rel, "discontinued", "CLI 安装脚本必须明确自报停发，而不是下载 404")

# 0.2.0 起桌面包不走 release.yml 的 matrix，由它 workflow_call 三条 desktop-*.yml
# 在原生 runner 上构建。两头都点一遍：工作流得可被调用，release.yml 得真在调。
for wf in ("desktop-macos.yml", "desktop-linux.yml", "desktop-windows.yml"):
    # 带冒号，认的是 on: 里真实的触发器，头部注释里提一嘴不算数
    must_contain(".github/workflows/" + wf, "workflow_call:",
                 "发版靠 release.yml 调它构建桌面包，去掉这个触发发行版就缺这个平台")
    must_contain(".github/workflows/release.yml", "./.github/workflows/" + wf,
                 "release.yml 不调 %s，那个平台的桌面包就不会出现在发行版里" % wf)

# install.ps1 不许再去要一个没人构建的 ARM64 exe。
must_not_match(
    "install.ps1", r"omnisci-windows-arm64",
    "上游没有 Windows ARM64 的构建；ARM64 应当回落到 x86_64，由系统模拟执行",
)

# 版本号躺在五个地方。它们只要有一处对不上，更新检查就会拿一个假的"当前版本"去跟
# release tag 比：说低了就永远提示有新版本（用户更新完还在提示），说高了就永远不提示。
# tauri.conf.json 那份还决定安装包文件名和系统"已安装程序"里显示的版本。
VERSIONS = {
    "cli/package.json": r'"version":\s*"([^"]+)"',
    "cli/src/cli.tsx": r'const VERSION = "([^"]+)"',
    "desktop/package.json": r'"version":\s*"([^"]+)"',
    "desktop/launcher/main.ts": r'const VERSION = "([^"]+)"',
    "desktop/src-tauri/tauri.conf.json": r'"version":\s*"([^"]+)"',
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
        "版本号对不上：%s\n      发版时五处要一起改，否则更新提示会拿错的当前版本去比"
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

# ---------------------------------------------------------------- 界面多语言

def check_locales():
    """t() 用到的每一句都要在英文表里，i18n 声明的每门语言都要有文件。

    漏一句的后果不是报错，是德语界面上突然冒出一行中文，而且只有说德语的人
    会看见。所以这件事必须在 CI 里挡，不能靠人肉抽查。
    """
    global checked
    src = os.path.join(ROOT, "desktop", "src")

    i18n = read("desktop/src/lib/i18n.tsx")
    if i18n is None:
        return
    codes = re.findall(r'\{\s*code:\s*"([\w-]+)"', i18n)
    checked += 1
    if len(codes) < 2:
        problems.append("desktop/src/lib/i18n.tsx 里没解析出 LANGS，检查规则失效了")
        return

    # 中文是源文（键就是中文），没有 zh.ts
    for code in codes:
        checked += 1
        if code == "zh":
            continue
        if not os.path.exists(os.path.join(src, "lib", "locales", "%s.ts" % code)):
            problems.append(
                "LANGS 里有 %s 但 locales/%s.ts 不存在\n"
                "      少一张表构建直接失败，因为 i18n.tsx 是静态 import 的" % (code, code))
            continue
        # 加一门语言要动三处：LANGS、locales/ 下的表、i18n.tsx 的 import 和
        # LOCALES 映射。只查前两处的话，"表建好了但忘了 import"会一路绿灯，
        # 而那门语言在界面上整个回退成英文，没有任何报错。
        checked += 1
        var = re.sub(r"-(\w)", lambda m: m.group(1).upper(), code)
        table = re.search(r"const LOCALES[^{]*\{(.*?)\n\};", i18n, re.S)
        wired = ('from "./locales/%s"' % code) in i18n and bool(
            table and re.search(r"(^|[{,\s])(%s|\"%s\")\s*[,:}]" % (var, code), table.group(1)))
        if not wired:
            problems.append(
                "locales/%s.ts 存在，但 i18n.tsx 没有 import 它、或者没登记进 LOCALES\n"
                "      这门语言会静默回退成英文，构建和运行都不报错" % code)

    en_body = read("desktop/src/lib/locales/en.ts")
    if en_body is None:
        return
    known = set(re.findall(r'^\s*"((?:[^"\\]|\\.)*)":', en_body, re.M))

    # t("…") 的第一个参数是中文原文。跨行调用和模板串不在这条规则的射程内，
    # 只挡最常见也最容易漏的那种：新写一句 t("中文") 就忘了往表里加。
    missing = set()
    for folder, _dirs, files in os.walk(src):
        for name in files:
            # 词条表本身不扫。os.walk 给的目录名没有结尾分隔符，所以这里判的是
            # 目录名本身；写成 `"/locales/" in folder` 那样永远不成立，等于没排除。
            if not name.endswith((".ts", ".tsx")) or os.path.basename(folder) == "locales":
                continue
            with open(os.path.join(folder, name), encoding="utf-8") as handle:
                text = handle.read()
            for literal in re.findall(r'\bt\(\s*"((?:[^"\\]|\\.)+)"', text):
                if re.search(r"[一-鿿]", literal) and literal not in known:
                    missing.add(literal)

    checked += 1
    if missing:
        problems.append(
            "这些 t() 的原文不在 locales/en.ts 里，非中文界面上会露出中文：\n      %s"
            % "\n      ".join(sorted(missing)[:12]))

    # 通道的 label / hint 是**服务端**给的，前端拿到就直接显示，不经过 t() 的
    # 字面量，所以上面那条规则查不到它们。漏过一次：英文界面的模型列表里赫然
    # 写着"自定义端点"。前端现在会把它们过一遍 t()，但键得先在 en.ts 里有。
    config = read("desktop/gateway/model-config.ts")
    if config is not None:
        checked += 1
        server_side = set()
        for value in re.findall(r'^\s*(?:label|hint):\s*"((?:[^"\\]|\\.)+)"', config, re.M):
            if re.search(r"[一-鿿]", value) and value not in known:
                server_side.add(value)
        if server_side:
            problems.append(
                "model-config.ts 这些通道文案会直接显示在界面上，但不在 locales/en.ts 里：\n      %s"
                % "\n      ".join(sorted(server_side)))

    # 启动器抛给界面的错误也一样：DownloadError 的第一个参数和接口回的 errorKey
    # 都是词条键，界面拿去过 t()。表里没有就等于英文界面上糊一句中文。
    for rel, pattern in (
        ("desktop/launcher/update-download.ts", r'new DownloadError\(\s*"((?:[^"\\]|\\.)+)"'),
        ("desktop/launcher/main.ts", r'errorKey:\s*"((?:[^"\\]|\\.)+)"'),
    ):
        body = read(rel)
        if body is None:
            continue
        checked += 1
        gone = sorted({v for v in re.findall(pattern, body)
                       if re.search(r"[一-鿿]", v) and v not in known})
        if gone:
            problems.append(
                "%s 这些错误文案会显示在界面上，但不在 locales/en.ts 里：\n      %s"
                % (os.path.basename(rel), "\n      ".join(gone)))


check_locales()

# README 的语言切换行指到哪，哪就得有文件。链接指向 404 比不给链接更糟。
# 译文住在 docs/i18n/，英文那份留在根目录（GitHub 首页要它）。
I18N_DIR = "docs/i18n"


def translated_readmes():
    """所有译文的仓库相对路径。挪过一次位置，别再按根目录硬找。"""
    folder = os.path.join(ROOT, I18N_DIR)
    if not os.path.isdir(folder):
        return []
    return ["%s/%s" % (I18N_DIR, f) for f in sorted(os.listdir(folder))
            if re.match(r"^README_[\w-]+\.md$", f)]


# 每份 README 都有同一条语言切换行，死链要一起查。只查英文那份的话，
# 译文里同样的死链没人管。链接是相对各自所在目录解析的。
for _source in ["README.md"] + translated_readmes():
    _body = read(_source)
    if _body is None:
        continue
    _base = os.path.dirname(os.path.join(ROOT, _source))
    for _target in sorted(set(re.findall(r'href="([\w./-]*README[\w.-]*\.md)"', _body))):
        checked += 1
        if not os.path.exists(os.path.normpath(os.path.join(_base, _target))):
            problems.append("%s 的语言切换行指向 %s，但这个文件不存在" % (_source, _target))


def check_language_order():
    """README 的语言行和软件里的下拉必须同一个顺序、同一批语言。

    分家过一次：README 把繁體中文排在简体后面，软件排在日語前面。同一个人在
    官网和软件里看到两份清单，会以为其中一处漏了语言。
    """
    global checked
    checked += 1
    i18n = read("desktop/src/lib/i18n.tsx")
    readme = read("README.md")
    if i18n is None or readme is None:
        return
    in_app = re.findall(r'native:\s*"([^"]+)"', i18n)
    # 语言行长这样：<strong>English</strong> · <a href="README_zh.md">简体中文</a> · …
    line = next((l for l in readme.split("\n") if "README_zh.md" in l), "")
    # href 里允许带目录：译文挪进 docs/i18n/ 之后，语言行写的是
    # docs/i18n/README_zh.md，写死 README 开头就一个名字都抓不到，
    # 而这条检查会安静地退化成「只有 English」，看着像 README 出了问题。
    in_readme = re.findall(
        r"<strong>([^<]+)</strong>|<a href=\"[\w./-]*README[\w.-]*\.md\">([^<]+)</a>", line)
    in_readme = [a or b for a, b in in_readme]
    if in_app != in_readme:
        problems.append(
            "README.md 的语言行跟 i18n.tsx 的 LANGS 顺序或内容对不上\n"
            "      软件   %s\n      README %s" % (" ".join(in_app), " ".join(in_readme)))


check_language_order()


def check_translated_readmes():
    """每份译文的骨架必须跟 README.md 一模一样。

    译文是机器翻出来的，模型偶尔会吞掉一个标题、少翻一个列表项、把代码块改一个
    字。这些在日文或俄文页面上没人看得出来"少了什么"，只会觉得这软件做了一半。
    所以拿英文那份当基准逐项对。文字当然不同，对的是结构和那些不该动的东西。

    README_paper.md 不在此列：那是面向论文的另一篇，不是 README.md 的译文。
    """
    global checked
    src = read("README.md")
    if src is None:
        return

    # 注释和目录树里的说明文字是**应该**被翻译的（手写的中文版就翻了）。
    # 这里要守的不是逐字节相同，是"用户复制粘贴的那条命令没被改过"。所以先把
    # 注释和各语种的文字抠掉再比，留下命令、路径和目录树的框线。
    words = re.compile(r"[Ѐ-ӿ　-〿぀-ヿ一-鿿가-힯＀-￯]+")

    def commands(text):
        out = []
        for block in re.findall(r"```[a-z]*\n(.*?)```", text, re.S):
            block = re.sub(r"#[^\n]*", "", block)
            if "├" in block or "└" in block:
                # 目录树。每行后面那串说明本来就该翻（英文版是英文，中文版是中文），
                # 能对的是框线和路径本身，所以每行只留这两样。
                kept = []
                for line in block.split("\n"):
                    hit = re.match(r"^([\s│├└─]*)(\S+)", line)
                    if hit:
                        kept.append(hit.group(1).rstrip() + " " + hit.group(2))
                block = "\n".join(kept)
            else:
                block = words.sub("", block)
            out.append(re.sub(r"[ \t]+", " ", block).strip())
        return sorted(out)

    def norm(ref, where, mod=os.path):
        """把相对引用归一化到仓库根。

        同一张图在 README.md 里写 assets/x.png，在 docs/i18n/ 里写
        ../../assets/x.png，指的是同一个文件。不归一化就会把「挪了目录」
        报成「链接对不上」。
        """
        # 结果统一成正斜杠。os.path.normpath 在 Windows 上给的是反斜杠，
        # docs\i18n\README_zh.md 匹配不上下面那条写死正斜杠的排除规则，
        # 于是兄弟语言的链接没被排除，Windows 的 CI 报「外链 31 对 30」，
        # 而 macOS 和 Linux 上全绿——最难查的那种。
        return mod.normpath(mod.join(mod.dirname(where), ref)).replace("\\", "/")

    def facts(text, where):
        return {
            "代码围栏": text.count("```"),
            "标题层级": [len(m.group(1)) for m in re.finditer(r"^(#{1,6}) ", text, re.M)],
            "列表项": len(re.findall(r"^\s*[-*] ", text, re.M)),
            "表格行": len(re.findall(r"^\|.*\|$", text, re.M)),
            "图片": sorted({norm(v, where) for v in re.findall(r'src="([^"]+)"', text)
                          if not v.startswith("http")}),
            "命令": commands(text),
            # 语言切换行每份都不一样（当前语言加粗），所以 README_*.md 排除。
            # 页内锚点也排除，它们指向的是被翻译过的标题。
            "外链": sorted({
                x if x.startswith("http") else norm(x, where)
                for x in re.findall(r"\]\(([^)]+)\)", text) + re.findall(r'href="([^"]+)"', text)
                if not x.startswith("#")
                and not re.match(r"^(docs/i18n/)?README(_[\w-]+)?\.md$",
                                 x if x.startswith("http") else norm(x, where))}),
        }

    def numbers(text):
        """正文里出现的数字，按出现次数计。

        版本号、日期、arXiv 编号、论文里报的 21.7% 都在这里面，模型把它们改一个
        字，读那份译文的人就拿到了一个假数据，而且没有任何办法发现。

        比之前先规范化：法语、德语、俄语用小数逗号，`21.7%` 在法语版里正确写法是
        `21,7 %`，这是排版不是错误。百分号前的空格（含不换行空格）也一并抹掉。
        """
        from collections import Counter
        # 先把链接和路径整段抠掉。译文跟原文不在同一层目录，`docs/i18n/`
        # 只出现在原文那份，而 "i18n" 里带数字，比出来就是「译文少了九个 18」，
        # 纯噪音。要比的是正文里的数据，不是路径。
        text = re.sub(r'\]\([^)]*\)|href="[^"]*"|src="[^"]*"|https?://\S+', ' ', text)
        flat = re.sub(r"(?<=\d)[,  ](?=\d)", ".", text)
        flat = re.sub(r"(?<=\d)[  ]+%", "%", flat)
        return Counter(re.findall(r"\d+(?:[.\-]\d+)*", flat))

    # 自检：norm() 必须吐正斜杠。忘了 replace(os.sep, "/") 的话，这份脚本在
    # macOS 和 Linux 上全绿、只在 Windows 的 CI 上红，而且报的是「外链 31 对 30」
    # 这种跟根因毫无关系的话。2026-08-24 就是这么烧掉一轮 CI 的。
    # 拿 ntpath 显式跑一遍 Windows 语义。只用 os.path 的话，这条自检在
    # macOS 和 Linux 上永远是绿的（那两个平台本来就吐正斜杠），等于摆设，
    # 而它要防的恰恰是「本机全绿、只有 Windows 的 CI 红」。
    checked += 1
    import ntpath
    if "\\" in norm("../../assets/x.png", "docs/i18n/README_zh.md", ntpath):
        problems.append(
            "check_parity 的 norm() 在 Windows 语义下吐反斜杠\n"
            "      后果是这份脚本在 macOS/Linux 全绿、只在 Windows 的 CI 上红，"
            "而且报的是「外链数量对不上」这种跟根因无关的话")

    want = facts(src, "README.md")
    want_nums = numbers(src)
    for name in translated_readmes():
        checked += 1
        body = read(name)
        if body is None:
            continue
        if "⟦" in body:
            problems.append("%s 里残留了翻译占位符 ⟦⟧，说明生成过程出错了" % name)
            continue
        got = facts(body, name)
        diff = [k for k in want if want[k] != got[k]]
        if diff:
            size = lambda v: len(v) if isinstance(v, list) else v   # noqa: E731
            problems.append("%s 的结构跟 README.md 对不上：%s" % (
                name, "；".join("%s 原文 %s 译文 %s" % (k, size(want[k]), size(got[k])) for k in diff)))

        # 只查"原文有、译文没有"，不查译文多出来的。
        #
        # 多出来是正常的：日语习惯把英文拼写的数词写成阿拉伯数字（Ten languages
        # 是 10言語，twelve modalities 是 12のモダリティ），中文也一样。真正危险的
        # 只有一个方向——原文里的某个数字在译文里不见了，那说明它被改写成了别的值，
        # 而读那份译文的人拿到的就是一个假数据。21.7% 被写成 31.7% 正是这样露馅的。
        checked += 1
        lost = want_nums - numbers(body)
        if lost:
            problems.append("%s 里少了 README.md 有的数字 %s，八成是被改写了" % (name, dict(lost)))


check_translated_readmes()

# ---------------------------------------------------------------- 结果

if problems:
    print("check_parity: %d 项检查，%d 处不同步\n" % (checked, len(problems)))
    for item in problems:
        print("  - %s" % item)
    sys.exit(1)

print("check_parity: %d 项检查，四份实现同步" % checked)
