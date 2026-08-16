#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Refuse to ship anything personal.

A public repository grown out of a working tree carries the environment it grew in:
home directory paths, a private key store, an internal gateway hostname, the names
of internal machines, one person's habits written into a shipped default. Removing
that once is easy. Keeping it removed is the part that needs a machine, so this runs
in CI and fails the build on the way back in.

    python3 scripts/scan_leaks.py            # scan the tree
    python3 scripts/scan_leaks.py --staged   # scan what is about to be committed
    python3 scripts/scan_leaks.py --add TERM # print the hash line for a new term

Two kinds of rule:

  * PATTERNS, below, are the shapes that are wrong for anyone: a home directory
    path, an API key, a private key block, an unexpected email address.

  * DENIED_HASHES are specific words. They are stored as SHA-256 rather than in
    plain text, because a readable blocklist of internal hostnames published in a
    public repository is itself the leak it was written to prevent. Scanning still
    works everywhere, including CI, and the file gives up nothing to a reader.

To add a term without ever committing it in the clear, run with --add and paste the
line, or put it in scripts/scan_leaks.local.json (git-ignored) as {"terms": [...]}.

A line containing `scan-leaks: allow` is skipped. That exists for deliberately fake
credentials: a test that proves redaction works needs a string shaped like a real key.

Exit 0 clean, 1 with findings.
"""
import argparse
import hashlib
import json
import os
import re
import subprocess
import sys

PATTERNS = [
    (r"/(?:home|Users)/(?!runner\b|user\b|bun\b|tester\b)[A-Za-z0-9_.-]+/", "a personal home directory path"),
    (r"\bsk-[A-Za-z0-9_-]{16,}", "an API key"),
    (r"\b(?:ghp|github_pat|xox[aboprs])[-_][A-Za-z0-9_-]{16,}", "an access token"),
    (r"-----BEGIN [A-Z ]*PRIVATE KEY-----", "a private key"),
    (r"(?i)\b[a-z0-9-]+\.(?:internal|corp|lan)\b/", "an internal host"),
    (r"[A-Za-z0-9._%+-]+@(?!example\.(?:org|com)\b|users\.noreply\.github\.com\b)"
     r"[A-Za-z0-9.-]+\.[A-Za-z]{2,}", "an email address"),
]

# SHA-256 of lowercased terms. Deliberately opaque; see the module docstring.
DENIED_HASHES = {
    "a047663119665f31a3457fc5f0414a3e5091888eb1b2bda6ee066fc9d0af78c8",
    "bf0c97708b849de696e7373508b13c5ea92bafa972fc941d694443e494a4b84d",
    "410e98c79a0a933896d63b155e564a6af05a82dee51cd6f22dd0aa4058609d86",
    "b31bf29179271bb2848a7451816466c1973652850ae9dac38e662eac7aef0807",
    "394b490233a5ef446bc8e233fd5050f635b644ee4a52d316b594f84711e436a0",
    "392a5bcbd71a7db2cfb9796c633326f7fba6730bdb0c801d3b0fd30886821000",
    "063daf1cb5f9f197989289667fd8d023f4e44919f6f4c752973685e02d1df725",
    "a11a38fb4da017f0bb82af6e34a462a831b1e04b914ec37747f61922dd2bc684",
    "ed2769dca4de078dea226cbe16095e05e7e8d98a55f8f67a08a6bd3b611cf4dc",
}

# The only address-shaped strings that belong in a public repository: a clone URL,
# and the polite-pool contact the engine sends to OpenAlex. Author contact details
# are deliberately not listed here: they live on the authors' own pages, and an
# allowlist of real addresses is itself a thing worth not publishing.
ALLOWED_EMAILS = {
    "mmsci@example.org",
    "git@github.com",
}

ALLOW_MARKER = "scan-leaks: allow"

SKIP_DIRS = {".git", "node_modules", "__pycache__", "dist", "dist-desktop", "dist-single",
             "test-results", "playwright-report", ".venv", "venv"}
SKIP_EXT = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".pdf", ".zip", ".gz", ".tgz", ".wav",
            ".mp3", ".mp4", ".npy", ".npz", ".woff", ".woff2", ".ttf", ".otf", ".ico", ".icns",
            ".pyc", ".so", ".dylib", ".dll", ".lock"}

CJK = re.compile(r"[一-鿿]+")
WORD = re.compile(r"[A-Za-z0-9_.-]+")


def digest(term):
    return hashlib.sha256(term.lower().encode("utf-8")).hexdigest()


def denied_terms(line, extra):
    """Every token, and every short CJK substring, checked against the hash set.

    CJK needs substrings because Chinese does not put spaces between words, so a
    two-character name sits inside a longer run of characters."""
    hits = []
    for token in WORD.findall(line):
        for candidate in {token, token.strip(".-_")}:
            if candidate and (digest(candidate) in DENIED_HASHES or candidate.lower() in extra):
                hits.append(candidate)
    for run in CJK.findall(line):
        for size in (2, 3, 4):
            for i in range(len(run) - size + 1):
                piece = run[i:i + size]
                if digest(piece) in DENIED_HASHES or piece in extra:
                    hits.append(piece)
    return hits


def local_terms(root):
    path = os.path.join(root, "scripts", "scan_leaks.local.json")
    if not os.path.exists(path):
        return set()
    try:
        with open(path, encoding="utf-8") as fh:
            return {t.lower() for t in json.load(fh).get("terms", [])}
    except (ValueError, OSError):
        print("scan_leaks: scan_leaks.local.json unreadable, ignoring", file=sys.stderr)
        return set()


def files_from_git(staged):
    cmd = ["git", "diff", "--cached", "--name-only", "--diff-filter=ACM"] if staged \
        else ["git", "ls-files"]
    out = subprocess.run(cmd, capture_output=True, text=True, check=True).stdout
    return [line for line in out.splitlines() if line]


def scan(paths, root, extra):
    findings = []
    for rel in paths:
        if any(part in SKIP_DIRS for part in rel.split("/")):
            continue
        if rel == "scripts/scan_leaks.py":
            continue
        if os.path.splitext(rel)[1].lower() in SKIP_EXT:
            continue
        full = os.path.join(root, rel)
        if not os.path.isfile(full):
            continue
        try:
            with open(full, encoding="utf-8") as fh:
                lines = fh.readlines()
        except (UnicodeDecodeError, OSError):
            continue
        for n, line in enumerate(lines, 1):
            if len(line) > 4000:            # minified bundles and data URIs, not prose
                continue
            if ALLOW_MARKER in line:
                continue
            for hit in denied_terms(line, extra):
                findings.append((rel, n, "a private term", hit))
            for pattern, what in PATTERNS:
                m = re.search(pattern, line)
                if not m:
                    continue
                hit = m.group(0)
                if "@" in hit and hit.strip(" '\"<>,;") in ALLOWED_EMAILS:
                    continue
                # A path segment inside a URL is somebody's web page, not this machine
                if hit.startswith("/home/") or hit.startswith("/Users/"):
                    before = line[:m.start()]
                    if "://" in before and " " not in before[before.rindex("://"):]:
                        continue
                findings.append((rel, n, what, hit[:70]))
    return findings


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--staged", action="store_true", help="scan the staged changes only")
    ap.add_argument("--add", metavar="TERM", help="print the hash line for a new denied term")
    args = ap.parse_args()

    if args.add:
        print('    "%s",' % digest(args.add))
        return 0

    root = subprocess.run(["git", "rev-parse", "--show-toplevel"],
                          capture_output=True, text=True, check=True).stdout.strip()
    paths = files_from_git(args.staged)
    findings = scan(paths, root, local_terms(root))

    if not findings:
        print("scan_leaks: %d files, clean" % len(paths))
        return 0

    print("scan_leaks: %d finding(s)\n" % len(findings), file=sys.stderr)
    for rel, n, what, hit in findings[:60]:
        print("  %s:%d  %s -> %r" % (rel, n, what, hit), file=sys.stderr)
    if len(findings) > 60:
        print("  ... and %d more" % (len(findings) - 60), file=sys.stderr)
    print("\nEvery one of these was real once. Fix the line; if it genuinely belongs in "
          "a public repository, add `%s` to it or widen ALLOWED_EMAILS." % ALLOW_MARKER,
          file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
