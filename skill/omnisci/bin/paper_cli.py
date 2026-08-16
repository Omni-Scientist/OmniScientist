#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Paper CLI: assemble the host's sections into the engine's LaTeX and compile with tectonic.

The host writes the prose (it is the brain). This does the mechanical half, reusing the engine's own assembler
(`agentic._paper_tex`), so host mode inherits its guarantees for free: figures interleaved into the lead section
and each one referenced, dangling \\ref rewritten, \\cite keys outside the real bib stripped, em-dashes removed.

  python paper_cli.py compile --task galaxy_xsurvey --sections sections.json --title "..."

sections.json:
  {"_order": ["Introduction", "Data", "Analysis", "Results", "Discussion"],
   "_lead_section": "Results",
   "_figures": [{"file": "host/figures/fig_gap.png", "caption": "..."}],   # relative to the case dir, or absolute
   "_results_table": "\\begin{table}[H]...\\end{table}",                   # raw LaTeX; the only way to ship a table
   "ABSTRACT": "...", "Introduction": "...", "Results": "...", ...}

A compile failure returns the tectonic error instead of a PDF; the host fixes its own LaTeX and runs again.
"""
import os, sys, json, shutil, argparse, subprocess

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import hostbridge as hb


def _figblocks(td, figs):
    out = []
    for i, f in enumerate(figs or [], 1):
        out.append("\\begin{figure}[H]\n\\centering\n\\includegraphics[width=0.86\\linewidth]{%s}\n"
                   "\\caption{%s}\n\\label{fig:f%d}\n\\end{figure}" % (os.path.basename(f["file"]),
                                                                      (f.get("caption") or "").strip(), i))
    return out


def compile_paper(td, sections, title, authors="Anonymous", name="paper"):
    a, p = hb.engine_module("agentic"), hb.engine_module("paper")
    work = os.path.join(hb.host_dir(td), "latex")
    figdir = os.path.join(work, "figures")
    os.makedirs(figdir, exist_ok=True)

    figs = sections.get("_figures") or []
    for f in figs:                                          # figures live next to the case; copy them in
        src = f["file"] if os.path.isabs(f["file"]) else os.path.join(td, f["file"])
        if not os.path.exists(src):
            return {"status": "error", "error": "figure not found: %s" % src}
        shutil.copy(src, os.path.join(figdir, os.path.basename(src)))

    bib = os.path.join(hb.host_dir(td), "references.bib")
    known = set()
    if os.path.exists(bib):
        shutil.copy(bib, os.path.join(work, "references.bib"))
        import re
        known = set(re.findall(r"@\w+\{([^,]+),", open(bib).read()))

    tex = a._paper_tex({"authors": authors}, title, sections, _figblocks(td, figs), bool(known), known=known)
    main = os.path.join(work, "main.tex")
    open(main, "w").write(tex)

    # An Overleaf-ready bundle is always written, before any compile output exists to pollute it. It is the
    # deliverable when tectonic is missing, and the handoff format when someone wants to keep editing.
    bundle = os.path.join(hb.host_dir(td), "%s_overleaf" % name)
    zip_path = shutil.make_archive(bundle, "zip", work)

    def _run(cmd, **kw):
        return subprocess.run(cmd, cwd=work, capture_output=True, text=True, timeout=300, **kw)

    # the engine hardcodes ~/.local/bin/tectonic, which is one machine's layout; prefer whatever is on PATH
    tectonic = shutil.which("tectonic") or p.TECTONIC
    common = {"tex": main, "overleaf_zip": zip_path, "n_figures": len(figs), "n_refs": len(known)}
    if not os.path.exists(tectonic):
        return dict(common, status="tex_only",
                    note="tectonic is not installed, so no PDF was produced. Everything else worked: upload "
                         "%s to Overleaf (New Project, Upload Project) and compile there, or install tectonic "
                         "and run this command again." % os.path.basename(zip_path))
    r = _run([tectonic, "main.tex"])
    pdf = os.path.join(work, "main.pdf")
    if not os.path.exists(pdf):
        return dict(common, status="error", error=(r.stdout + r.stderr)[-1500:],
                    note="the LaTeX did not compile; %s still holds the full source for Overleaf"
                         % os.path.basename(zip_path))

    out_pdf = os.path.join(hb.host_dir(td), "%s.pdf" % name)
    shutil.copy(pdf, out_pdf)
    out_tex = os.path.join(hb.host_dir(td), "%s.tex" % name)
    shutil.copy(main, out_tex)
    return dict(common, status="ok", pdf=out_pdf, tex=out_tex,
                sections=[s for s in sections.get("_order", [])])


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("compile", help="sections.json -> PDF")
    c.add_argument("--task", required=True)
    c.add_argument("--sections", required=True)
    c.add_argument("--title", required=True)
    c.add_argument("--authors", default="Anonymous")
    c.add_argument("--name", default="paper")
    a = ap.parse_args()
    td = hb.resolve_task(a.task)
    out = compile_paper(td, json.load(open(hb.case_path(td, a.sections))), a.title, a.authors, a.name)
    print(json.dumps({"case": td, **out}, indent=2, ensure_ascii=False))
    sys.exit(0 if out["status"] in ("ok", "tex_only") else 1)


if __name__ == "__main__":
    main()
