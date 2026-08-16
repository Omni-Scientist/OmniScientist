#!/usr/bin/env python3
"""Build contract-complete prose for the model-free container smoke test."""
import itertools
import json
import os
import sys

sys.path.insert(0, os.environ["OMNISCI"])
import paper_cli as paper


FILLER = (
    "recorded evidence supports a reproducible scientific account while each interpretation remains tied to "
    "the observed sample the stated comparison and the limits of the analytical design"
).split()


def paragraph(prefix, target_words, stream):
    missing = target_words - paper._word_count(prefix)
    if missing < 0:
        raise ValueError("fixture paragraph prefix exceeds its target")
    suffix = " ".join(next(stream) for _ in range(missing))
    return (prefix.rstrip(". ") + (" " + suffix if suffix else "") + ".").strip()


def section(target, prefixes):
    n_paragraphs = target["paragraphs"][0]
    if len(prefixes) != n_paragraphs:
        raise ValueError("fixture prefix count does not match the contract")
    total = target["words"][0]
    sizes = [total // n_paragraphs + (i < total % n_paragraphs) for i in range(n_paragraphs)]
    stream = itertools.cycle(FILLER)
    return "\n\n".join(paragraph(prefix, size, stream) for prefix, size in zip(prefixes, sizes))


contract = paper._style_contract("biomed")
sections = {
    "_style": "biomed",
    "_order": contract["_order"],
    "_lead_section": contract["_lead_section"],
    "_figures": [{
        "file": "host/figures/fig_values.png",
        "caption": "Recorded values in the two fixture groups.",
    }],
    "ABSTRACT": section(contract["ABSTRACT"], [
        "This deterministic study checks whether a packaged scientific workflow can preserve recorded evidence, "
        "structured prose, compilation, and delivery integrity from one reproducible analysis",
    ]),
    "Introduction": section(contract["sections"]["Introduction"], [
        "Reproducible research software matters because scientific claims must remain connected to inspectable data "
        "and repeatable analysis",
        "Existing data publication practice emphasizes traceable research objects and durable provenance "
        "\\cite{yang2023}, but an automated paper workflow must also preserve those links during composition",
        "The objective of this fixture study is to verify that a grouped observation moves through analysis, "
        "structured writing, compilation, and guarded delivery without losing its recorded basis",
    ]),
    "Results": section(contract["sections"]["Results"], [
        "The recorded run contained 12 rows and produced group means of 12.50 and 22.50, for a difference of 10.00. "
        "Figure~\\ref{fig:f1} shows every measured value",
        "The observed separation supplies the primary fixture result and confirms that the generated figure agrees "
        "with the values emitted by the recorded script",
        "The packaging controls retain the same source artifact across paper assembly and prevent an unrelated result "
        "from replacing the active recorded output",
        "The integrity checks bind the current prose, figure, bibliography, and compiled artifact so later mutation is "
        "detected rather than silently accepted",
    ]),
    "Discussion": section(contract["sections"]["Discussion"], [
        "The fixture demonstrates that structural and provenance checks can operate together without asking the "
        "assembler to invent scientific interpretation",
        "Its contribution is a bounded systems result: the packaged path preserves the supplied evidence and writing "
        "contract through the delivery boundary",
        "The artificial grouped sample is intentionally narrow and does not establish scientific generality; it tests "
        "workflow behavior rather than a substantive domain hypothesis",
        "Future checks can extend this bounded fixture to additional modalities while retaining the same requirements "
        "for recorded evidence, structured writing, and artifact review",
    ]),
    "Methods": section(contract["sections"]["Methods"], [
        "A deterministic script loaded the grouped table, summarized each group, computed their difference, and wrote "
        "a figure from the same in-memory observations",
        "The dedicated recording tool executed that script and banked its standard output before any numerical result "
        "was admitted to the manuscript",
        "The paper tool validated the field contract, assembled the current sections and figure, compiled the document, "
        "rendered review pages, and recorded hashes for delivery verification",
        "Evaluation then compared every current artifact with its trusted receipt and deliberately modified copies to "
        "confirm that stale or altered delivery files are rejected",
    ]),
}

report = paper.validate_sections(sections)
if not report["valid"]:
    raise SystemExit("invalid smoke fixture: " + "; ".join(report["errors"]))
json.dump(sections, sys.stdout, indent=1, ensure_ascii=False)
sys.stdout.write("\n")
