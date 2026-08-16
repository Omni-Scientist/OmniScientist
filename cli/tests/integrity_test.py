#!/usr/bin/env python3
"""Negative-path integrity checks for the packaged OmniScientist CLIs."""
import hashlib
import itertools
import json
import os
import sys
import tempfile
import types
import zipfile

OMNISCI = "/opt/omnisci/skills/omnisci/bin"
sys.path.insert(0, OMNISCI)
import gate_cli as gate
import hostbridge as hb
import paper_cli as paper


FIXTURE_WORDS = (
    "recorded evidence supports a reproducible scientific account while the analysis connects observations "
    "to the stated question and keeps interpretation within the measured scope"
).split()


def _fixture_prose(target):
    total = target["words"][0]
    paragraphs = target["paragraphs"][0]
    sizes = [total // paragraphs + (i < total % paragraphs) for i in range(paragraphs)]
    stream = itertools.cycle(FIXTURE_WORDS)
    return "\n\n".join(" ".join(next(stream) for _ in range(size)) + "." for size in sizes)


def valid_sections(style="biomed"):
    contract = paper._style_contract(style)
    out = {
        "_style": style,
        "_order": contract["_order"],
        "_lead_section": contract["_lead_section"],
        "ABSTRACT": _fixture_prose(contract["ABSTRACT"]),
    }
    for name in contract["_order"]:
        out[name] = _fixture_prose(contract["sections"][name])
        if contract["sections"][name]["citations"]:
            out[name] += r" \cite{fixture2026}"
    return out


def make_case(kind="table"):
    td = tempfile.mkdtemp(prefix="omnisci-integrity-")
    json.dump({"members": [{"idx": 0, "file": "data.bin", "modality": kind}]},
              open(os.path.join(td, "series.json"), "w"))
    open(os.path.join(td, "data.bin"), "wb").write(b"fixture-data")
    return td


def test_receipts():
    td = make_case("image")
    image = os.path.join(td, "data.bin")
    calls = os.path.join(hb.host_dir(td), "calls")
    call_path = os.path.join(calls, "call_001.json")
    question = "what is visible?"
    call = {"call_id": 1, "draft": "item: <<VISION:1>>",
            "pending": [{"id": 1, "image": image, "question": question}],
            "status": "needs_vision"}
    json.dump(call, open(call_path, "w"))
    try:
        hb.ingest(td, 1, {})
        raise AssertionError("ingest accepted a hand-written perception without a receipt")
    except SystemExit:
        pass

    observation = "A factual fixture observation."
    call["receipts"] = {"1": {
        "receipt_id": "fixture-receipt",
        "image_sha256": hashlib.sha256(open(image, "rb").read()).hexdigest(),
        "question_sha256": hashlib.sha256(question.encode()).hexdigest(),
        "observation_sha256": hashlib.sha256(observation.encode()).hexdigest(),
        "observation": observation,
        "provider": "fixture",
        "model": "fixture",
        "viewed_at": "2026-01-01T00:00:00Z",
    }}
    json.dump(call, open(call_path, "w"))
    ingested = hb.ingest(td, 1, {})
    assert ingested["status"] == "done" and ingested["answers"]["1"] == observation
    ingested["receipts"]["1"]["observation"] = "tampered"
    json.dump(ingested, open(call_path, "w"))
    assert gate.perception_status(td)["invalid"]


def test_ledger_latest_success_only():
    td = make_case()
    analysis = os.path.join(td, "analysis.py")
    open(analysis, "w").write("print('metric = 12.34')\n")
    first = gate.record(td, "analysis.py", [], timeout=10)
    assert first["returncode"] == 0 and first["entry_sha256"] == gate._entry_sha256(first)
    assert any(abs(v - 12.34) < 1e-9 for v in gate.ledger_numbers(td))

    open(analysis, "w").write("print('metric = 56.78')\n")
    active, summary = gate.active_ledger(td)
    assert not active and summary["stale"] == 1
    assert gate.record(td, "analysis.py", [], timeout=10)["returncode"] == 0
    assert any(abs(v - 56.78) < 1e-9 for v in gate.ledger_numbers(td))

    open(analysis, "w").write("import sys\nprint('metric = 99.99')\nsys.exit(4)\n")
    assert gate.record(td, "analysis.py", [], timeout=10)["returncode"] == 4
    active, summary = gate.active_ledger(td)
    assert not active and summary["failed_latest"] == 1
    assert not gate.ledger_numbers(td)


def test_gate_numeric_strictness():
    assert gate.numbers("A single result was 9.") == [("9", 9.0)]
    prose = gate._prose_only(
        r"\begin{document}\begin{figure}[H]"
        r"\includegraphics[width=0.86\linewidth]{figure99.png}"
        r"\caption{The measured count was 99.}\label{fig:f1}\end{figure}\end{document}"
    )
    assert ("99", 99.0) in gate.numbers(prose)
    assert not any(tok == "0.86" for tok, _ in gate.numbers(prose))
    assert not gate.grounded(0.004, [1.96e-08])
    assert not gate.grounded(0.005, [0.0])
    assert gate.grounded(0.0, [0.0])


def test_invalid_ledger_and_perception_fail_closed():
    td = make_case()
    analysis = os.path.join(td, "analysis.py")
    open(analysis, "w").write("print('metric = 12.34')\n")
    gate.record(td, "analysis.py", [], timeout=10)
    with open(os.path.join(hb.host_dir(td), gate.LEDGER), "a") as f:
        f.write(json.dumps({"script": "analysis.py", "returncode": 0,
                            "stdout": "forged = 88.88"}) + "\n")
    _, ledger = gate.active_ledger(td)
    assert ledger["invalid"] == 1

    open(os.path.join(td, "series.json"), "w").write("{not-json")
    perception = gate.perception_status(td)
    assert perception["required"] and perception["discovery_errors"]


def test_clean_compile():
    td = make_case()
    sections = valid_sections()
    open(os.path.join(hb.host_dir(td), "references.bib"), "w").write(
        "@article{fixture2026,\n  title={Fixture}\n}\n"
    )

    def runner(code):
        def run(_cmd, work):
            open(os.path.join(work, "main.pdf"), "wb").write(b"%PDF-fixture")
            return types.SimpleNamespace(returncode=code, stdout="", stderr="fixture compiler error")
        return run

    first = paper.compile_paper(td, sections, "Fixture paper", tectonic_path="fixture",
                                command_runner=runner(0))
    assert first["status"] == "ok" and os.path.isfile(os.path.join(td, "host", "paper.pdf"))
    manifest = json.load(open(first["manifest"]))
    assert manifest["status"] == "ok"
    for artifact in manifest["artifacts"].values():
        assert hashlib.sha256(open(os.path.join(td, artifact["path"]), "rb").read()).hexdigest() \
               == artifact["sha256"]

    second = paper.compile_paper(td, sections, "Fixture paper", tectonic_path="fixture",
                                 command_runner=runner(7))
    assert second["status"] == "error" and second["tectonic_returncode"] == 7, second
    assert not os.path.exists(os.path.join(td, "host", "paper.pdf"))
    assert json.load(open(second["manifest"]))["status"] == "error"
    with zipfile.ZipFile(second["overleaf_zip"]) as archive:
        assert "main.pdf" not in archive.namelist()


def test_writing_contract_blocks_flat_sections():
    assert paper._word_count("A measured 95% interval remains stable after review.") == 7
    hidden = r"\href{https://" + "hidden/" * 40 + r"}{visible}"
    assert paper._word_count(hidden) == 1
    nested_hidden = r"\href{outer target}{\href{" + "nested/" * 40 + r"}{visible}}"
    assert paper._word_count(nested_hidden) == 1
    equation = "evidence " * 30 + "\n\n" + r"\begin{equation}x=y\end{equation}"
    assert paper._paragraph_word_counts(equation) == [30]
    listed = "evidence " * 30 + "\n\\begin{itemize}\n\\item " + "result " * 30 + \
             "\n\n\\item " + "finding " * 30 + "\n\\end{itemize}"
    assert len(paper._paragraph_word_counts(listed)) == 1

    for style in paper.paper_specs.FIELD_SPECS:
        contract = paper._style_contract(style)
        assert paper.validate_sections(valid_sections(style))["valid"]
        for target in [contract["ABSTRACT"]] + list(contract["sections"].values()):
            assert target["paragraphs"] == [len(target["ordered_paragraph_jobs"])] * 2
    style_mismatch = paper.validate_sections(valid_sections("biomed"), inferred_style="earth_space")
    assert any("does not match this case's resolved style" in e for e in style_mismatch["errors"])

    missing_citation = valid_sections("biomed")
    missing_citation["Introduction"] = missing_citation["Introduction"].replace(
        r" \cite{fixture2026}", ""
    )
    assert any("requires at least one citation" in e
               for e in paper.validate_sections(missing_citation)["errors"])
    unknown_citation = valid_sections("biomed")
    unknown_report = paper.validate_sections(unknown_citation, known_citations={"another"})
    assert any("absent from the current bibliography" in e for e in unknown_report["errors"])

    earth = paper._style_contract("earth_space")
    assert earth["_order"] == ["Introduction", "Data", "Methods", "Results", "Discussion", "Conclusions"]
    assert earth["sections"]["Introduction"]["paragraphs"] == [5, 5]
    jobs = earth["sections"]["Introduction"]["ordered_paragraph_jobs"]
    assert [job.split(":", 1)[0] for job in jobs] == [
        "BIG PICTURE", "NARROW TO SUBTOPIC", "PRIOR WORK", "GAP", "THIS STUDY"
    ]

    sections = valid_sections("earth_space")
    sections["Introduction"] = " ".join(itertools.islice(itertools.cycle(FIXTURE_WORDS), 800)) + "."
    report = paper.validate_sections(sections)
    assert not report["valid"]
    assert report["sections"]["Introduction"]["paragraphs"] == 1
    assert any("Introduction has 1 substantive paragraphs; expected 5-5" in e for e in report["errors"])

    dangling = valid_sections("biomed")
    dangling["Introduction"] = dangling["Introduction"].replace("\n\n", " $\n\n", 1)
    dangling_report = paper.validate_sections(dangling)
    assert not dangling_report["valid"]
    assert any("unmatched $" in e for e in dangling_report["errors"])

    document_escape = valid_sections("biomed")
    document_escape["Introduction"] += r"\end {document}"
    assert any("forbidden TeX structure" in e for e in paper.validate_sections(document_escape)["errors"])
    flattened = valid_sections("biomed")
    flattened["Introduction"] = r"{\let\par\relax " + flattened["Introduction"] + "}"
    assert any("forbidden TeX structure" in e for e in paper.validate_sections(flattened)["errors"])

    injected = valid_sections("biomed")
    injected["_results_table"] = r"\begin{table}fixture\end{table}\end{document}"
    assert any("forbidden document structure" in e for e in paper.validate_sections(injected)["errors"])
    duplicate_end = valid_sections("biomed")
    duplicate_end["_results_table"] = r"\begin{table}fixture\end{table}outside\end{table}"
    assert any("exactly one table environment" in e for e in paper.validate_sections(duplicate_end)["errors"])
    spaced_escape = valid_sections("biomed")
    spaced_escape["_results_table"] = (
        r"\begin{table}first\end{table}\end {document}\begin {table}second\end{table}"
    )
    assert any("forbidden document structure" in e for e in paper.validate_sections(spaced_escape)["errors"])
    allowed_table = valid_sections("biomed")
    allowed_table["_results_table"] = r"\begin{table}[H]\centering fixture\end{table}"
    assert paper.validate_sections(allowed_table)["valid"]

    missing_figure = valid_sections("biomed")
    missing_figure["_figures"] = [{"file": "host/figures/example.png", "caption": "Example."}]
    assert any("must reference every listed figure" in e
               for e in paper.validate_sections(missing_figure)["errors"])

    engine_paper = hb.engine_module("paper")
    caption_block = paper._figblocks("/tmp", [{"file": "example.png", "caption": "A_B & 95% # result"}],
                                     sanitize=engine_paper._sanitize_body)[0]
    assert r"\caption{A\_B \& 95\% \# result}" in caption_block
    assert engine_paper._sanitize_body(r"Cost \$5") == r"Cost \$5"
    alignat = r"\begin{alignat}{2}a_1 &= b_1 &\quad c_2 &= d_2\end{alignat}"
    assert paper._prose_tex_error(alignat) is None
    sanitized_alignat = engine_paper._sanitize_body(alignat)
    assert "a_1" in sanitized_alignat and r"\&" not in sanitized_alignat

    currency_figure = valid_sections("biomed")
    currency_figure["_figures"] = [{"file": "host/figures/example.png", "caption": r"Cost \$5 by group."}]
    currency_figure["Results"] = currency_figure["Results"].replace(
        ".", r". Figure~\ref{fig:f1} summarizes the groups.", 1
    )
    assert paper.validate_sections(currency_figure)["valid"]

    engine_agentic = hb.engine_module("agentic")
    table_sections = {
        "_order": ["Results"], "_lead_section": "Results",
        "Results": "FIRST PARAGRAPH.\n \nSECOND PARAGRAPH.",
        "_results_table": r"\begin{table}TABLE MARKER\end{table}",
        "ABSTRACT": "Fixture abstract.",
    }
    table_tex = engine_agentic._paper_tex({}, "Fixture", table_sections, [], False)
    assert table_tex.index("FIRST PARAGRAPH") < table_tex.index("TABLE MARKER") \
        < table_tex.index("SECOND PARAGRAPH")

    td = make_case()
    old_pdf = os.path.join(hb.host_dir(td), "paper.pdf")
    open(old_pdf, "wb").write(b"stale")
    called = []

    def must_not_compile(_cmd, _work):
        called.append(True)
        raise AssertionError("tectonic ran before the writing contract passed")

    failed = paper.compile_paper(td, sections, "Flat fixture", command_runner=must_not_compile)
    assert failed["status"] == "error" and "writing contract failed" in failed["error"]
    assert not called and not os.path.exists(old_pdf)
    assert not os.path.exists(os.path.join(td, "host", "paper.tex"))


def test_reference_provenance():
    td = make_case()
    host = hb.host_dir(td)
    bib = "@article{fixture2026,\n  title={Fixture},\n  doi={10.1000/fixture}\n}\n"
    bib_path = os.path.join(host, "references.bib")
    open(bib_path, "w").write(bib)
    json.dump({"version": 1, "bib_sha256": hashlib.sha256(bib.encode()).hexdigest(),
               "entries": [{"doi": "10.1000/fixture", "title": "Fixture"}]},
              open(os.path.join(host, "references.provenance.json"), "w"))
    tex = r"\begin{document}A result \cite{fixture2026}.\end{document}"
    assert gate.citation_status(td, tex)["valid"]
    open(bib_path, "a").write("% tampered\n")
    assert not gate.citation_status(td, tex)["valid"]


test_receipts()
test_ledger_latest_success_only()
test_gate_numeric_strictness()
test_invalid_ledger_and_perception_fail_closed()
test_writing_contract_blocks_flat_sections()
test_clean_compile()
test_reference_provenance()
print("OmniScientist integrity tests passed")
