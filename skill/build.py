#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Check the skill is self-contained, then zip it for a release.

`skill/omnisci/` is already installable as it stands: copy it into
`~/.claude/skills/` and it works. What this adds is the proof that it still is.
The failure it exists to catch is a `bin/*.py` that quietly starts importing
something out of `engine/`: everything keeps working in this checkout and breaks
on the first machine that only has the zip.

    python3 skill/build.py                 # verify only
    python3 skill/build.py --zip dist/     # verify, then write omnisci-skill.zip

Exit 0 clean, 1 on a failed check.
"""
import argparse
import os
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
SKILL = os.path.join(HERE, "omnisci")
ENGINE = os.path.join(REPO, "engine", "omniscientist")

REQUIRED = [
    "SKILL.md", "INSTALL.md", "requirements.txt",
    "bin/hostbridge.py", "bin/evidence_cli.py", "bin/gate_cli.py",
    "bin/lit_cli.py", "bin/paper_cli.py", "bin/case_cli.py",
    "bin/vendor/evidence.py", "bin/vendor/paper.py", "bin/vendor/agentic.py",
    "bin/vendor/paperlint.py", "bin/vendor/paradigms.py",
]


def check_files():
    missing = [f for f in REQUIRED if not os.path.exists(os.path.join(SKILL, f))]
    if missing:
        print("缺文件: %s" % ", ".join(missing), file=sys.stderr)
        return False
    print("files: %d 个必需文件齐全" % len(REQUIRED))
    return True


def check_self_contained():
    """把仓库从 sys.path 上摘掉再 import。还能解析出引擎，才叫自包含。"""
    code = (
        "import sys; sys.path.insert(0, %r); import hostbridge as hb; "
        "e = hb.find_engine(); assert 'vendor' in e, e; hb.evidence(); "
        "print('engine =', e)" % os.path.join(SKILL, "bin")
    )
    env = dict(os.environ)
    env["OMNISCI_ENGINE"] = ""          # 别让环境变量替它作弊
    env.pop("PYTHONPATH", None)
    with tempfile.TemporaryDirectory() as cwd:
        r = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True,
                           cwd=cwd, env=env)
    out = (r.stdout + r.stderr).strip()
    if r.returncode != 0:
        print("自包含检查失败:\n%s" % out, file=sys.stderr)
        return False
    print("self-contained: %s" % out.splitlines()[-1])
    return True


def report_drift():
    """vendor/ 是引擎的快照，不是符号链接。漂了多少，报出来给人看，不判失败。"""
    drifted = []
    for name in sorted(os.listdir(os.path.join(SKILL, "bin", "vendor"))):
        if not name.endswith(".py"):
            continue
        a = os.path.join(SKILL, "bin", "vendor", name)
        b = os.path.join(ENGINE, name)
        if not os.path.exists(b):
            drifted.append("%s (引擎里没有)" % name)
        elif open(a, "rb").read() != open(b, "rb").read():
            drifted.append(name)
    if drifted:
        print("vendor drift: %s" % ", ".join(drifted))
        print("  这是快照与 engine/omniscientist 的差异，不是错误。"
              "宿主模式的改动本来就先落在 skill 这边。")
    else:
        print("vendor drift: 无，与 engine/omniscientist 逐字一致")


def make_zip(out_dir):
    os.makedirs(out_dir, exist_ok=True)
    staging = tempfile.mkdtemp()
    try:
        shutil.copytree(SKILL, os.path.join(staging, "omnisci"),
                        ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
        path = shutil.make_archive(os.path.join(os.path.abspath(out_dir), "omnisci-skill"),
                                   "zip", staging, "omnisci")
    finally:
        shutil.rmtree(staging, ignore_errors=True)
    print("zip: %s (%.0f KB)" % (path, os.path.getsize(path) / 1024))
    return path


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--zip", metavar="DIR", help="写 omnisci-skill.zip 到这个目录")
    args = ap.parse_args()

    ok = check_files() and check_self_contained()
    report_drift()
    if not ok:
        return 1
    if args.zip:
        make_zip(args.zip)
    return 0


if __name__ == "__main__":
    sys.exit(main())
