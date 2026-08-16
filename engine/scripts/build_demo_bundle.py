#!/usr/bin/env python3
"""Build the small, diverse demo bundle shipped with the public repository.

The input is a directory containing the full prepared cases, each with a
``series.json`` and the files referenced by its ``members`` list. The output
keeps the original case instructions but replaces ``members`` with a small,
deterministically selected subset and copies only those referenced files.

This is a maintainer tool. End users get the generated demo files directly
when they clone the public repository.
"""

from __future__ import annotations

import argparse
import json
import shutil
from collections import defaultdict
from pathlib import Path


DEMO_CASES = (
    "birdaudio",
    "chem_series",
    "feynman",
    "galaxy_xsurvey",
    "histopath",
    "med_ct3d",
    "stead_seismic",
)


def first_by_group(members: list[dict], key: str, per_group: int) -> list[dict]:
    grouped: dict[str, list[dict]] = defaultdict(list)
    for member in members:
        grouped[str(member.get(key))].append(member)
    selected: list[dict] = []
    for group in sorted(grouped):
        selected.extend(grouped[group][:per_group])
    return selected


def select_members(case: str, members: list[dict]) -> tuple[list[dict], str]:
    if case == "birdaudio":
        return first_by_group(members, "label", 3), "first 3 clips per has-bird label"
    if case == "chem_series":
        return first_by_group(members, "n_Cl", 1), "one molecule per chlorine-count group"
    if case == "feynman":
        return members[:6], "first 6 distinct physical equations"
    if case == "histopath":
        return first_by_group(members, "label", 1), "one tile per tissue class"
    if case == "stead_seismic":
        return first_by_group(members, "label", 3), "first 3 traces per catalogue label"
    if case == "med_ct3d":
        chosen: list[dict] = []
        seen: set[tuple[str, str]] = set()
        per_subset = {"nodule": 2, "organ": 2, "fracture": 3}
        counts: dict[str, int] = defaultdict(int)
        for member in members:
            subset = str(member.get("subset"))
            label = str(member.get("label"))
            pair = (subset, label)
            if pair in seen or counts[subset] >= per_subset.get(subset, 0):
                continue
            chosen.append(member)
            seen.add(pair)
            counts[subset] += 1
        return chosen, "2 nodule, 2 organ, and 3 fracture volumes with distinct labels"
    if case == "galaxy_xsurvey":
        by_morph: dict[str, int] = {}
        for member in members:
            morph = str(member.get("morph"))
            by_morph.setdefault(morph, int(member["gid"]))
        gids = set(by_morph.values())
        selected = [member for member in members if int(member["gid"]) in gids]
        return selected, "one paired DECaLS/SDSS galaxy per morphology class"
    raise ValueError(f"no selector for {case}")


def build_case(source_root: Path, output_root: Path, case: str) -> None:
    source_case = source_root / case
    output_case = output_root / case
    series_path = source_case / "series.json"
    series = json.loads(series_path.read_text(encoding="utf-8"))
    full_members = series.get("members") or []
    selected, selection = select_members(case, full_members)

    demo_members = []
    for new_index, member in enumerate(selected):
        copied = dict(member)
        copied["idx"] = new_index
        relative = Path(str(copied["file"]))
        source_file = source_case / relative
        output_file = output_case / relative
        if not source_file.is_file():
            raise FileNotFoundError(source_file)
        output_file.parent.mkdir(parents=True, exist_ok=True)
        if source_file.suffix.lower() == ".csv":
            output_file.write_bytes(
                source_file.read_bytes().replace(b"\r\n", b"\n")
            )
        else:
            shutil.copy2(source_file, output_file)
        demo_members.append(copied)

    series["members"] = demo_members
    series["_demo"] = {
        "included": True,
        "members": len(demo_members),
        "full_members": len(full_members),
        "selection": selection,
        "purpose": "interface and perception smoke test; not the full paper evaluation",
    }
    series.pop("_members_note", None)
    output_case.mkdir(parents=True, exist_ok=True)
    (output_case / "series.json").write_text(
        json.dumps(series, indent=1, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    print(f"{case:18} {len(demo_members):>2}/{len(full_members):<4} {selection}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--source",
        type=Path,
        required=True,
        help="directory containing the full prepared case directories",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=Path(__file__).resolve().parents[1] / "examples",
        help="public examples directory (default: repository examples/)",
    )
    args = parser.parse_args()

    source_root = args.source.resolve()
    output_root = args.output.resolve()
    for case in DEMO_CASES:
        build_case(source_root, output_root, case)


if __name__ == "__main__":
    main()
