#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Case CLI: turn a user's folder of files into a case the engine can run.

A real user arrives with data, not with a `series.json`. This scans a directory, routes every file to a
modality by extension, guesses labels from the folder layout, and writes the `series.json` that every other
CLI expects. The scientific fields (role, subject, the open research direction) are yours to write: they are
the framing of the study, not something a scanner can infer.

  python3 case_cli.py init --dir ~/my_micrographs \\
        --role "a histopathologist" --subject "a tissue microscopy field" \\
        --direction "Find a concrete, testable question these images can answer and produce a short paper."

  python3 case_cli.py inspect --dir ~/my_micrographs        # look before committing

By default the case IS the user's directory: `series.json` is written into it and nothing is copied or moved.
Point `--out` somewhere else to keep their folder untouched, in which case `data` is symlinked.
"""
import os, re, sys, json, argparse, collections

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import hostbridge as hb

# the skill's own working files, which would otherwise be re-scanned as data on a second init
SKIP = {".ds_store", "series.json", "sections.json", "picks.json"}
SKIP_DIRS = {"host", "stages", "__pycache__", ".git", ".ipynb_checkpoints"}


def scan(root, max_files=4000):
    """Walk the directory and route each file to a modality using the engine's own extension map."""
    ev = hb.evidence()
    found, skipped = [], collections.Counter()
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS and not d.startswith(".")]
        for fn in sorted(filenames):
            if fn.lower() in SKIP or fn.startswith("."):
                continue
            ext = os.path.splitext(fn)[1].lower()
            mod = ev.EXT2MOD.get(ext)
            if not mod:
                skipped[ext or "(no extension)"] += 1
                continue
            rel = os.path.relpath(os.path.join(dirpath, fn), root)
            parent = os.path.dirname(rel)
            found.append({"file": rel, "modality": mod,
                          "label": os.path.basename(parent) if parent else None})
            if len(found) >= max_files:
                return found, skipped, True
    return found, skipped, False


def summarise(found, skipped, truncated):
    mods = collections.Counter(f["modality"] for f in found)
    labels = collections.Counter(f["label"] for f in found if f["label"])
    return {"n_files": len(found), "truncated": truncated,
            "modalities": dict(mods.most_common()),
            "labels": dict(labels.most_common(20)),
            "unrecognised_extensions": dict(skipped.most_common(10)),
            "sample": found[:3]}


def init(root, out, name, role, subject, direction, prop, max_files, label_from):
    found, skipped, truncated = scan(root, max_files)
    if not found:
        raise SystemExit("no files with a recognised extension under %s (unrecognised: %s)"
                         % (root, dict(skipped.most_common(10))))

    if out:
        case = os.path.abspath(os.path.join(out, name or os.path.basename(root.rstrip("/"))))
        os.makedirs(case, exist_ok=True)
        link = os.path.join(case, "data")
        if not os.path.exists(link):
            os.symlink(os.path.abspath(root), link)
        prefix = "data/"
    else:
        case, prefix = os.path.abspath(root), ""

    members = []
    for i, f in enumerate(found):
        m = {"idx": i, "file": prefix + f["file"], "modality": f["modality"]}
        if label_from == "dirname" and f["label"]:
            m["label"] = f["label"]
        members.append(m)

    series = {"role": role, "subject": subject, "property": prop or "",
              "direction": direction, "members": members}
    path = os.path.join(case, "series.json")
    if os.path.exists(path):
        raise SystemExit("%s already exists; edit it rather than overwriting a case" % path)
    json.dump(series, open(path, "w"), indent=1, ensure_ascii=False)

    s = summarise(found, skipped, truncated)
    s.update({"case": case, "series": path,
              "next": "run `evidence_cli.py tools --task %s` to see what this case unlocks" % case})
    return s


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    i = sub.add_parser("inspect", help="scan a directory without writing anything")
    i.add_argument("--dir", required=True)
    i.add_argument("--max", type=int, default=4000)

    c = sub.add_parser("init", help="write series.json for a directory of data")
    c.add_argument("--dir", required=True, help="the user's data directory")
    c.add_argument("--out", help="build the case elsewhere and symlink the data (default: in place)")
    c.add_argument("--name", help="case directory name when --out is used")
    c.add_argument("--role", required=True, help='the scientist you are playing, e.g. "a seismologist"')
    c.add_argument("--subject", required=True, help='what one item is, e.g. "a three-component waveform"')
    c.add_argument("--direction", required=True, help="the OPEN research brief; do not prescribe the method")
    c.add_argument("--property", dest="prop", help="the quantity of interest, if there is a natural one")
    c.add_argument("--max", type=int, default=4000)
    c.add_argument("--label-from", choices=["dirname", "none"], default="dirname",
                   help="take each item's label from its containing folder (default) or leave unlabelled")

    a = ap.parse_args()
    if a.cmd == "inspect":
        found, skipped, truncated = scan(os.path.expanduser(a.dir), a.max)
        out = summarise(found, skipped, truncated)
    else:
        out = init(os.path.expanduser(a.dir), a.out, a.name, a.role, a.subject, a.direction,
                   a.prop, a.max, a.label_from)
    print(json.dumps(out, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
