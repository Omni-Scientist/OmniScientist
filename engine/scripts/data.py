#!/usr/bin/env python3
"""List, fetch, and verify OmniScientist research data.

Large third-party datasets are intentionally not committed to the code
repository. This CLI makes the boundary explicit: real demos ship in Git,
while full data come from their publisher or an established dataset hub.
"""

from __future__ import annotations

import argparse
import csv
import json
import shutil
import sys
import tempfile
import urllib.request
import zipfile
from pathlib import Path


REPO = Path(__file__).resolve().parents[1]
MANIFEST_PATH = REPO / "datasets" / "manifest.json"
EXAMPLES = REPO / "examples"
UCI_SUPERCON_URL = (
    "https://archive.ics.uci.edu/static/public/464/"
    "superconductivty%2Bdata.zip"
)
HF_H3_TRAIN = (
    "hf://datasets/InstaDeepAI/"
    "nucleotide_transformer_downstream_tasks/H3/train.parquet"
)


def manifest() -> dict:
    return json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))


def cases_by_name() -> dict[str, dict]:
    return {case["case"]: case for case in manifest()["cases"]}


def human_count(value: int) -> str:
    if value >= 1_000_000:
        return f"{value / 1_000_000:.1f}M"
    if value >= 1_000:
        return f"{value / 1_000:.1f}k"
    return str(value)


def command_list(_: argparse.Namespace) -> int:
    print(f"{'case':18} {'modality':22} {'demo':>7} {'paper':>8}  source")
    print("-" * 88)
    for case in manifest()["cases"]:
        demo = str(case["demo_items"]) if case["demo_in_repo"] else "fetch"
        print(
            f"{case['case']:18} {case['modality'][:22]:22} "
            f"{demo:>7} {human_count(case['paper_items']):>8}  {case['source']}"
        )
    return 0


def referenced_files(case_name: str) -> list[Path]:
    case_dir = EXAMPLES / case_name
    spec = json.loads((case_dir / "series.json").read_text(encoding="utf-8"))
    files: list[str] = []
    for member in spec.get("members") or []:
        if member.get("file"):
            files.append(str(member["file"]))
    for value in (spec.get("data", {}).get("files") or {}).values():
        files.append(str(value))
    return [case_dir / relative for relative in files]


def verify_case(case_name: str) -> tuple[int, int]:
    paths = referenced_files(case_name)
    present = sum(path.is_file() for path in paths)
    return present, len(paths)


def command_verify(args: argparse.Namespace) -> int:
    known = cases_by_name()
    selected = args.cases
    if not selected and args.demos:
        selected = [name for name, case in known.items() if case["demo_in_repo"]]
    if not selected:
        selected = list(known)
    failed = False
    for case_name in selected:
        if case_name not in known:
            print(f"unknown case: {case_name}", file=sys.stderr)
            failed = True
            continue
        present, total = verify_case(case_name)
        if total == 0:
            state = "metadata-only"
        elif present == total:
            state = "ready"
        else:
            state = f"missing {total - present}"
            failed = True
        print(f"{case_name:18} {state:14} ({present}/{total} referenced files)")
    return 1 if failed else 0


def fetch_supercon(force: bool) -> None:
    output = EXAMPLES / "supercon" / "data"
    targets = [output / "train.csv", output / "unique_m.csv"]
    if all(path.is_file() for path in targets) and not force:
        print("supercon: official files already present; use --force to replace")
        return
    output.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="omniscientist-supercon-") as temporary:
        archive = Path(temporary) / "supercon.zip"
        request = urllib.request.Request(
            UCI_SUPERCON_URL, headers={"User-Agent": "OmniScientist-data/1.0"}
        )
        print(f"downloading {UCI_SUPERCON_URL}")
        with urllib.request.urlopen(request) as response, archive.open("wb") as handle:
            shutil.copyfileobj(response, handle)
        with zipfile.ZipFile(archive) as bundle:
            members = {Path(name).name: name for name in bundle.namelist()}
            for filename in ("train.csv", "unique_m.csv"):
                if filename not in members:
                    raise RuntimeError(f"{filename} not found in UCI archive")
                with bundle.open(members[filename]) as source, (output / filename).open(
                    "wb"
                ) as target:
                    shutil.copyfileobj(source, target)
    print(f"supercon: wrote {targets[0]} and {targets[1]}")


def fetch_dna(force: bool) -> None:
    target = EXAMPLES / "dna" / "data" / "dna.csv"
    if target.is_file() and not force:
        print("dna: prepared file already present; use --force to replace")
        return
    try:
        from datasets import load_dataset
    except ImportError as exc:
        raise RuntimeError(
            "DNA download requires `pip install datasets pyarrow`"
        ) from exc
    dataset = load_dataset(
        "parquet",
        data_files={"train": HF_H3_TRAIN},
        split="train",
    )
    target.parent.mkdir(parents=True, exist_ok=True)
    with target.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=("sequence", "label", "task"))
        writer.writeheader()
        for row in dataset.select(range(10_000)):
            writer.writerow({field: row[field] for field in writer.fieldnames})
    print(f"dna: wrote first 10,000 stable H3 training rows to {target}")


def fetch_histopath(force: bool) -> None:
    output = EXAMPLES / "histopath" / "data1k"
    if output.is_dir() and len(list(output.glob("*.png"))) >= 1000 and not force:
        print("histopath: 1,000-tile prepared subset already present")
        return
    try:
        from datasets import load_dataset
    except ImportError as exc:
        raise RuntimeError(
            "Histopathology download requires `pip install datasets`"
        ) from exc
    dataset = load_dataset("1aurent/Kather-texture-2016", split="train")
    names = dataset.features["label"].names
    counts = {index: 0 for index in range(len(names))}
    members = []
    output.mkdir(parents=True, exist_ok=True)
    for example in dataset:
        label_index = int(example["label"])
        if counts[label_index] >= 125:
            continue
        label = names[label_index]
        filename = f"{label}_{counts[label_index]:03d}.png"
        example["image"].convert("RGB").save(output / filename)
        members.append(
            {"idx": len(members), "file": f"data1k/{filename}", "label": label}
        )
        counts[label_index] += 1
        if all(value == 125 for value in counts.values()):
            break

    spec_path = EXAMPLES / "histopath" / "series.json"
    spec = json.loads(spec_path.read_text(encoding="utf-8"))
    spec["members"] = members
    spec["_demo"] = {
        "included": False,
        "members": len(members),
        "purpose": "full prepared paper subset fetched from the upstream dataset",
    }
    spec_path.write_text(
        json.dumps(spec, indent=1, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    print(f"histopath: wrote {len(members)} tiles to {output}")


def fetch_ogb(force: bool) -> None:
    try:
        import torch
        from ogb.linkproppred import LinkPropPredDataset
    except ImportError as exc:
        raise RuntimeError(
            "BioKG download requires `pip install torch ogb`"
        ) from exc
    root = EXAMPLES / "kg_biokg" / "data" / "ogbl-biokg"
    if force and root.exists():
        print(
            "kg_biokg: --force does not delete the OGB cache; remove the exact cache "
            "directory manually if a clean re-download is required"
        )
    original_load = torch.load
    torch.load = lambda *a, **kw: original_load(  # type: ignore[assignment]
        *a, **{**kw, "weights_only": False}
    )
    try:
        dataset = LinkPropPredDataset(name="ogbl-biokg", root=str(root))
        split = dataset.get_edge_split()
    finally:
        torch.load = original_load

    mapping_output = EXAMPLES / "kg_biokg" / "data" / "mapping"
    mapping_output.mkdir(parents=True, exist_ok=True)
    expected = {
        "relidx2relname.csv",
        "drug_entidx2name.csv",
        "protein_entidx2name.csv",
        "disease_entidx2name.csv",
        "sideeffect_entidx2name.csv",
        "function_entidx2name.csv",
    }
    for source in root.rglob("*.csv"):
        if source.name in expected:
            shutil.copy2(source, mapping_output / source.name)
    print(
        "kg_biokg: ready; "
        + ", ".join(f"{name}={len(part['head']):,}" for name, part in split.items())
    )


FETCHERS = {
    "uci_supercon": fetch_supercon,
    "hf_h3": fetch_dna,
    "hf_kather": fetch_histopath,
    "ogb": fetch_ogb,
}


def command_fetch(args: argparse.Namespace) -> int:
    known = cases_by_name()
    case = known.get(args.case)
    if case is None:
        print(f"unknown case: {args.case}", file=sys.stderr)
        return 2
    fetcher = FETCHERS.get(case["fetcher"])
    if fetcher is None:
        print(f"{case['case']}: automatic full-data fetch is not enabled")
        print(f"source:  {case['source_url']}")
        print(f"download: {case['download']}")
        print(f"prepare:  {case['prepare']}")
        return 2
    try:
        fetcher(args.force)
    except Exception as exc:
        print(f"{case['case']}: {exc}", file=sys.stderr)
        return 1
    present, total = verify_case(args.case)
    print(f"verification: {present}/{total} referenced files present")
    return 0 if present == total else 1


def command_show(args: argparse.Namespace) -> int:
    case = cases_by_name().get(args.case)
    if case is None:
        print(f"unknown case: {args.case}", file=sys.stderr)
        return 2
    for key in (
        "dataset",
        "modality",
        "source",
        "source_url",
        "license",
        "download",
        "prepare",
        "split_protocol",
    ):
        print(f"{key.replace('_', ' ').title()}: {case[key]}")
    return 0


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(description=__doc__)
    commands = root.add_subparsers(dest="command", required=True)

    list_parser = commands.add_parser("list", help="show all public data cases")
    list_parser.set_defaults(function=command_list)

    verify_parser = commands.add_parser(
        "verify", help="check files referenced by series.json"
    )
    verify_parser.add_argument("cases", nargs="*")
    verify_parser.add_argument(
        "--demos",
        action="store_true",
        help="verify only the real-data demos shipped in Git",
    )
    verify_parser.set_defaults(function=command_verify)

    fetch_parser = commands.add_parser(
        "fetch", help="fetch a supported full-data case from its publisher"
    )
    fetch_parser.add_argument("case")
    fetch_parser.add_argument("--force", action="store_true")
    fetch_parser.set_defaults(function=command_fetch)

    show_parser = commands.add_parser(
        "show", help="show provenance, preparation, and split protocol"
    )
    show_parser.add_argument("case")
    show_parser.set_defaults(function=command_show)
    return root


def main() -> int:
    args = parser().parse_args()
    return int(args.function(args))


if __name__ == "__main__":
    raise SystemExit(main())
