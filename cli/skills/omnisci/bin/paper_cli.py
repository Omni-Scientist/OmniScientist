#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Paper CLI: assemble the host's sections into the engine's LaTeX and compile with tectonic.

The host writes the prose (it is the brain). This does the mechanical half, reusing the engine's own assembler
(`agentic._paper_tex`), so host mode inherits its guarantees for free: figures interleaved into the lead section
and each one referenced, dangling \\ref rewritten, \\cite keys outside the real bib stripped, em-dashes removed.

  python paper_cli.py contract --task galaxy_xsurvey
  python paper_cli.py compile --task galaxy_xsurvey --sections sections.json --title "..."

sections.json:
  {"_style": "earth_space",
   "_order": ["Introduction", "Data", "Methods", "Results", "Discussion", "Conclusions"],
   "_lead_section": "Results",
   "_figures": [{"file": "host/figures/fig_gap.png", "caption": "..."}],   # relative to the case dir, or absolute
   "_results_table": "\\begin{table}[H]...\\end{table}",                   # raw LaTeX; the only way to ship a table
   "ABSTRACT": "...", "Introduction": "...", "Results": "...", ...}

A compile failure returns the tectonic error instead of a PDF; the host fixes its own LaTeX and runs again.
"""
import os, re, sys, json, shutil, argparse, subprocess, hashlib, datetime

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import hostbridge as hb
from vendor import paper_specs


MIN_PARAGRAPH_WORDS = 30
MATH_ENV_INNER = (r"equation\*?|align\*?|alignat\*?|flalign\*?|gather\*?|multline\*?|"
                  r"split|aligned|eqnarray\*?|displaymath")
ALLOWED_PROSE_ENVS = {
    "equation", "equation*", "align", "align*", "alignat", "alignat*", "flalign", "flalign*",
    "gather", "gather*", "multline", "multline*", "split", "aligned", "eqnarray", "eqnarray*",
    "displaymath", "itemize", "enumerate", "description",
}
ALLOWED_PROSE_COMMANDS = {
    "begin", "end", "item", "ref", "label", "eqref",
    "textbf", "textit", "emph", "textrm", "textnormal", "texttt", "textsc", "underline",
    "mathrm", "mathbf", "mathit", "mathsf", "mathtt", "operatorname", "text",
    "footnote", "url", "href", "AA", "LaTeX", "textsuperscript", "textsubscript", "textdegree",
    "textasciicircum",
}



def _case_relpath(path, td):
    """Path relative to the case dir, computed with BOTH sides resolved.

    os.path.relpath(realpath(x), td) blows up whenever td sits under a symlink
    (macOS /tmp -> /private/tmp is the everyday case): it yields
    ../../../private/tmp/<case>/host/... and joining that back onto td lands in
    a directory that does not exist, so the gate marks a perfectly good run stale.
    Resolving both sides keeps the stored path inside the case dir.
    """
    return os.path.relpath(os.path.realpath(path), os.path.realpath(td))

def _style_contract(style):
    if style not in paper_specs.FIELD_SPECS:
        raise ValueError("unknown paper style %r; choose one of: %s" %
                         (style, ", ".join(sorted(paper_specs.FIELD_SPECS))))
    spec = paper_specs.FIELD_SPECS[style]
    lead = next((name for name in spec["order"]
                 if spec["sections"][name].get("floats") == "lead"), None)

    def public(section):
        return {
            "words": list(section["words"]),
            "paragraphs": list(section["paras"]),
            "ordered_paragraph_jobs": list(section["outline"]),
            "citations": bool(section.get("cite")),
            "figures": section.get("floats", "none"),
        }

    return {
        "version": 1,
        "_style": style,
        "_order": list(spec["order"]),
        "_lead_section": lead,
        "ABSTRACT": public(spec["abstract"]),
        "sections": {name: public(spec["sections"][name]) for name in spec["order"]},
    }


def writing_contract(td, style=None):
    if style is None:
        series = os.path.join(td, "series.json")
        case = json.load(open(series)) if os.path.isfile(series) else {}
        style = paper_specs.style_of(case)
    return _style_contract(style)


def _braced_arg(text, pos):
    while pos < len(text) and text[pos].isspace():
        pos += 1
    if pos >= len(text) or text[pos] != "{":
        return None
    depth, start, i = 1, pos + 1, pos + 1
    while i < len(text):
        if text[i] in "{}":
            slashes, j = 0, i - 1
            while j >= 0 and text[j] == "\\":
                slashes += 1
                j -= 1
            if slashes % 2 == 0:
                depth += 1 if text[i] == "{" else -1
                if depth == 0:
                    return text[start:i], i + 1
        i += 1
    return None


def _without_hidden_link_targets(text):
    """Keep rendered link labels while dropping href targets and bare URL payloads."""
    text, out, cursor = text or "", [], 0
    for match in re.finditer(r"\\(href|url)\b", text):
        if match.start() < cursor:
            continue
        first = _braced_arg(text, match.end())
        if first is None:
            continue
        if match.group(1) == "href":
            second = _braced_arg(text, first[1])
            if second is None:
                continue
            replacement, end = _without_hidden_link_targets(second[0]), second[1]
        else:
            replacement, end = " ", first[1]
        out.extend((text[cursor:match.start()], replacement))
        cursor = end
    out.append(text[cursor:])
    return "".join(out)


def _without_nonprose(text):
    # This runs on pre-sanitized section JSON, where a bare percent is prose and the assembler will escape it.
    text = _without_hidden_link_targets(text)
    text = re.sub(r"\\begin\s*\{\s*(" + MATH_ENV_INNER + r")\s*\}.*?"
                  r"\\end\s*\{\s*\1\s*\}", " ", text,
                  flags=re.DOTALL)
    text = re.sub(r"\$\$.*?\$\$|\\\[.*?\\\]|\\\(.*?\\\)|\$[^$]*\$", " ", text,
                  flags=re.DOTALL)
    text = re.sub(r"\\cite[a-zA-Z]*\{[^}]*\}|\\(?:ref|label)\{[^}]*\}", " ", text)
    text = re.sub(r"\\(?:begin|end)\{[^}]*\}|\\[a-zA-Z@]+\*?", " ", text)
    return text.replace("{", " ").replace("}", " ")


def _word_count(text):
    return len(re.findall(r"[A-Za-z]+(?:['-][A-Za-z]+)*", _without_nonprose(text)))


def _paragraph_word_counts(text):
    text = re.sub(
        r"\\begin\{(itemize|enumerate|description)\}.*?\\end\{\1\}",
        lambda match: re.sub(r"\n\s*\n", "\n", match.group(0)),
        text or "",
        flags=re.DOTALL,
    )
    blocks = [block.strip() for block in re.split(r"\n\s*\n", text or "") if block.strip()]
    counts = [_word_count(block) for block in blocks]
    return [count for count in counts if count]  # displayed equations are blocks, but not prose paragraphs


def _citation_keys(text):
    visible = _without_hidden_link_targets(text)
    keys = []
    for match in re.finditer(r"\\cite[a-zA-Z]*\{([^{}]*)\}", visible):
        keys.extend(key.strip() for key in match.group(1).split(",") if key.strip())
    return keys


def _unescaped_dollar_count(text):
    count = 0
    for i, char in enumerate(text or ""):
        if char != "$":
            continue
        slashes, j = 0, i - 1
        while j >= 0 and text[j] == "\\":
            slashes += 1
            j -= 1
        if slashes % 2 == 0:
            count += 1
    return count


def _prose_tex_error(text):
    structural = re.search(
        r"\\(?:begin|end)\s*\{\s*(?:document|table\*?|figure\*?|abstract)\s*\}|"
        r"\\(?:documentclass|usepackage|input|include|bibliography|write|openout|read|catcode|"
        r"def|gdef|edef|xdef|let|futurelet|newcommand|renewcommand|providecommand|newenvironment|"
        r"renewenvironment|csname|endcsname|everypar|endinput|par|section|subsection|subsubsection|"
        r"paragraph|newpage|clearpage|pagebreak)\b",
        text or "",
        flags=re.IGNORECASE,
    )
    if structural:
        return "forbidden TeX structure or layout command %s" % structural.group(0)

    stack = []
    for match in re.finditer(r"\\(begin|end)\s*\{\s*([^{}]+?)\s*\}", text or ""):
        action, env = match.group(1), match.group(2)
        if env not in ALLOWED_PROSE_ENVS:
            return "unsupported TeX environment %s" % env
        if action == "begin":
            stack.append(env)
        elif not stack or stack.pop() != env:
            return "unbalanced TeX environment %s" % env
    if stack:
        return "unclosed TeX environment %s" % stack[-1]

    masked = text or ""
    masked = re.sub(
        r"\\begin\s*\{\s*(" + MATH_ENV_INNER + r")\s*\}.*?"
        r"\\end\s*\{\s*\1\s*\}",
        " MATH ",
        masked,
        flags=re.DOTALL,
    )
    masked = re.sub(r"\$\$.*?\$\$|\\\[.*?\\\]|\\\(.*?\\\)|\$[^$]*\$", " MATH ", masked,
                    flags=re.DOTALL)
    commands = re.findall(r"\\([A-Za-z@]+)\*?", masked)
    unsupported = sorted({command for command in commands
                          if command not in ALLOWED_PROSE_COMMANDS and not command.lower().startswith("cite")})
    if unsupported:
        return "unsupported TeX command(s): %s" % ", ".join("\\" + c for c in unsupported)
    return None


def _table_contract_error(table):
    if table in (None, ""):
        return None
    if not isinstance(table, str):
        return "_results_table must be a string containing one table environment"
    if _unescaped_dollar_count(table) % 2:
        return "_results_table contains an unmatched $ math delimiter"
    forbidden = re.search(
        r"\\(?:begin|end)\s*\{\s*document\s*\}|"
        r"\\(?:documentclass|usepackage|input|include|bibliography|write|openout|read|catcode|"
        r"def|gdef|edef|xdef|let|futurelet|newcommand|renewcommand|providecommand|newenvironment|"
        r"renewenvironment|csname|endcsname|everypar|endinput)\b|"
        r"\\(?:section|subsection|subsubsection|paragraph)\*?\s*\{",
        table,
        flags=re.IGNORECASE,
    )
    if forbidden:
        return "_results_table contains forbidden document structure: %s" % forbidden.group(0)
    if (len(re.findall(r"\\begin\s*\{\s*table\*?\s*\}", table)) != 1 or
            len(re.findall(r"\\end\s*\{\s*table\*?\s*\}", table)) != 1):
        return "_results_table must contain exactly one table environment"
    pattern = (r"\s*\\begin\s*\{\s*(table\*?)\s*\}(?:\[[^\]]*\])?.*"
               r"\\end\s*\{\s*\1\s*\}\s*\Z")
    if not re.fullmatch(pattern, table, flags=re.DOTALL):
        return "_results_table may contain only one complete table environment and no outside content"
    return None


def validate_sections(sections, inferred_style=None, known_citations=None):
    errors, counts = [], {}
    if not isinstance(sections, dict):
        return {"version": 1, "valid": False, "style": None, "sections": {},
                "errors": ["sections.json must contain a JSON object"]}

    supplied_style = sections.get("_style")
    if not isinstance(supplied_style, str) or supplied_style not in paper_specs.FIELD_SPECS:
        choices = ", ".join(sorted(paper_specs.FIELD_SPECS))
        if supplied_style:
            errors.append("_style is %r; expected one of: %s" % (supplied_style, choices))
        else:
            errors.append("missing _style; run paper_cli.py contract for this case and copy its _style")
        style = inferred_style if inferred_style in paper_specs.FIELD_SPECS else None
    else:
        style = supplied_style
        if inferred_style in paper_specs.FIELD_SPECS and supplied_style != inferred_style:
            errors.append("_style %r does not match this case's resolved style %r; set series.json style explicitly "
                          "before requesting a different venue contract" % (supplied_style, inferred_style))

    if style is None:
        return {"version": 1, "valid": False, "style": supplied_style,
                "sections": counts, "errors": errors}

    contract = _style_contract(style)
    expected_order = contract["_order"]
    actual_order = sections.get("_order")
    if actual_order != expected_order:
        errors.append("_order must be %s for style %s; found %r" %
                      (json.dumps(expected_order), style, actual_order))
    if sections.get("_lead_section") != contract["_lead_section"]:
        errors.append("_lead_section must be %r for style %s; found %r" %
                      (contract["_lead_section"], style, sections.get("_lead_section")))

    table_error = _table_contract_error(sections.get("_results_table"))
    if table_error:
        errors.append(table_error)

    figures = sections.get("_figures") or []
    if not isinstance(figures, list):
        errors.append("_figures must be a JSON array")
        figures = []
    for i, figure in enumerate(figures, 1):
        if not isinstance(figure, dict) or not isinstance(figure.get("file"), str):
            errors.append("_figures[%d] must contain a string file path" % (i - 1))
            continue
        caption = figure.get("caption", "")
        if not isinstance(caption, str):
            errors.append("_figures[%d].caption must be a string" % (i - 1))
        elif _unescaped_dollar_count(caption) % 2:
            errors.append("_figures[%d].caption contains an unmatched $ math delimiter" % (i - 1))
        else:
            caption_error = _prose_tex_error(caption)
            if caption_error:
                errors.append("_figures[%d].caption contains %s" % (i - 1, caption_error))
    lead_prose = sections.get(contract["_lead_section"], "")
    lead_refs = set(re.findall(r"\\ref\{(fig:f\d+)\}", lead_prose if isinstance(lead_prose, str) else ""))
    missing_refs = ["fig:f%d" % i for i in range(1, len(figures) + 1) if "fig:f%d" % i not in lead_refs]
    if missing_refs:
        errors.append("%s must reference every listed figure before compilation; missing: %s" %
                      (contract["_lead_section"], ", ".join(missing_refs)))

    allowed = set(expected_order) | {"ABSTRACT"}
    extras = sorted(key for key, value in sections.items()
                    if not key.startswith("_") and key not in allowed and isinstance(value, str))
    if extras:
        errors.append("prose sections not present in the %s contract: %s" % (style, ", ".join(extras)))

    targets = [("ABSTRACT", contract["ABSTRACT"])] + [
        (name, contract["sections"][name]) for name in expected_order
    ]
    for name, target in targets:
        prose = sections.get(name)
        if not isinstance(prose, str) or not prose.strip():
            errors.append("%s is missing or empty" % name)
            continue
        if _unescaped_dollar_count(prose) % 2:
            errors.append("%s contains an unmatched $ math delimiter; assembly would truncate the section" % name)
        tex_error = _prose_tex_error(prose)
        if tex_error:
            errors.append("%s contains %s" % (name, tex_error))
        words = _word_count(prose)
        block_words = _paragraph_word_counts(prose)
        paragraphs = sum(n >= MIN_PARAGRAPH_WORDS for n in block_words)
        short_blocks = [n for n in block_words if n < MIN_PARAGRAPH_WORDS]
        citation_keys = _citation_keys(prose)
        counts[name] = {"words": words, "paragraphs": paragraphs,
                        "paragraph_block_words": block_words, "citation_keys": citation_keys}
        lo_words, hi_words = target["words"]
        jobs = target["ordered_paragraph_jobs"]
        lo_paras = hi_paras = len(jobs)
        if not lo_words <= words <= hi_words:
            errors.append("%s has %d prose words; expected %d-%d" %
                          (name, words, lo_words, hi_words))
        if not lo_paras <= paragraphs <= hi_paras:
            errors.append("%s has %d substantive paragraphs; expected %d-%d "
                          "(one for each ordered_paragraph_jobs entry, separated with blank lines)" %
                          (name, paragraphs, lo_paras, hi_paras))
        if short_blocks:
            errors.append("%s contains paragraph blocks shorter than %d prose words: %s" %
                          (name, MIN_PARAGRAPH_WORDS, ", ".join(map(str, short_blocks))))
        if target["citations"] and not citation_keys:
            errors.append("%s requires at least one citation from the current bibliography" % name)
        if known_citations is not None:
            unknown = sorted(set(citation_keys) - set(known_citations))
            if unknown:
                errors.append("%s cites keys absent from the current bibliography: %s" %
                              (name, ", ".join(unknown)))
            if target["citations"] and citation_keys and not set(citation_keys).intersection(known_citations):
                errors.append("%s requires at least one citation key present in the current bibliography" % name)

    return {"version": 1, "valid": not errors, "style": style,
            "sections": counts, "errors": errors}


def _figblocks(td, figs, sanitize=None):
    out = []
    for i, f in enumerate(figs or [], 1):
        caption = (f.get("caption") or "").strip()
        if sanitize:
            caption = sanitize(caption)
        out.append("\\begin{figure}[H]\n\\centering\n\\includegraphics[width=0.86\\linewidth]{%s}\n"
                   "\\caption{%s}\n\\label{fig:f%d}\n\\end{figure}" % (os.path.basename(f["file"]),
                                                                      caption, i))
    return out


def _file_sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def _artifact(td, path):
    return {"path": _case_relpath(path, td), "sha256": _file_sha256(path),
            "size": os.path.getsize(path)}


def compile_paper(td, sections, title, authors="Anonymous", name="paper", tectonic_path=None,
                  command_runner=None, sections_path=None):
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", name or ""):
        return {"status": "error", "error": "paper name must contain only letters, digits, dot, dash, underscore"}
    host = hb.host_dir(td)
    work = os.path.join(host, "latex")
    out_pdf = os.path.join(host, "%s.pdf" % name)
    out_tex = os.path.join(host, "%s.tex" % name)
    zip_path = os.path.join(host, "%s_overleaf.zip" % name)
    manifest_path = os.path.join(host, "%s.manifest.json" % name)
    review_dir = os.path.join(host, "%s_review" % name)

    # Every compile is a clean generation. Otherwise a failed second compile can look successful because the
    # first run's main.pdf is still present, and the new zip can silently retain removed figures.
    if os.path.isdir(work):
        shutil.rmtree(work)
    for old in (out_pdf, out_tex, zip_path, manifest_path):
        if os.path.exists(old):
            os.remove(old)
    if os.path.isdir(review_dir):
        shutil.rmtree(review_dir)

    try:
        inferred_style = writing_contract(td)["_style"]
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        return {"status": "error", "error": "cannot resolve the writing contract: %s" % exc}
    bib = os.path.join(hb.host_dir(td), "references.bib")
    known = set(re.findall(r"@\w+\{([^,]+),", open(bib).read())) if os.path.isfile(bib) else set()
    quality = validate_sections(sections, inferred_style=inferred_style, known_citations=known)
    if not quality["valid"]:
        return {
            "status": "error",
            "error": "writing contract failed:\n- " + "\n- ".join(quality["errors"]),
            "writing_contract": quality,
        }

    a, p = hb.engine_module("agentic"), hb.engine_module("paper")
    sanitized_sections = dict(sections)
    for section_name in ["ABSTRACT"] + list(sections.get("_order") or []):
        sanitized_sections[section_name] = a._strip_emdash(
            p._sanitize_body(a._strip_pseudo_headers(sections.get(section_name, "")))
        )
    sanitized_quality = validate_sections(sanitized_sections, inferred_style=inferred_style,
                                          known_citations=known)
    if not sanitized_quality["valid"]:
        return {
            "status": "error",
            "error": "post-sanitization writing contract failed:\n- " +
                     "\n- ".join(sanitized_quality["errors"]),
            "writing_contract": sanitized_quality,
        }
    quality = sanitized_quality
    figdir = os.path.join(work, "figures")
    os.makedirs(figdir, exist_ok=True)

    figs = sections.get("_figures") or []
    basenames = [os.path.basename(f.get("file") or "") for f in figs]
    if len(basenames) != len(set(basenames)):
        return {"status": "error", "error": "figure basenames must be unique"}
    figure_inputs = []
    for f in figs:                                          # figures live next to the case; copy them in
        src = f["file"] if os.path.isabs(f["file"]) else os.path.join(td, f["file"])
        if not os.path.exists(src):
            return {"status": "error", "error": "figure not found: %s" % src}
        real_src, real_td = os.path.realpath(src), os.path.realpath(td)
        if real_src != real_td and not real_src.startswith(real_td + os.sep):
            return {"status": "error", "error": "figure leaves the case directory: %s" % src}
        shutil.copy(src, os.path.join(figdir, os.path.basename(src)))
        figure_inputs.append({"path": _case_relpath(src, td), "sha256": _file_sha256(src),
                              "bundled_as": "figures/%s" % os.path.basename(src)})

    if os.path.exists(bib):
        shutil.copy(bib, os.path.join(work, "references.bib"))

    sections_input = {"sha256": hashlib.sha256(json.dumps(
        sections, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")).hexdigest()}
    if sections_path and os.path.isfile(sections_path):
        sections_input = _artifact(td, sections_path)
    bib_input = _artifact(td, bib) if os.path.isfile(bib) else None

    tex = a._paper_tex({"authors": authors}, title, sections,
                       _figblocks(td, figs, sanitize=p._sanitize_body), bool(known), known=known)
    main = os.path.join(work, "main.tex")
    open(main, "w").write(tex)
    shutil.copy(main, out_tex)

    # An Overleaf-ready bundle is always written, before any compile output exists to pollute it. It is the
    # deliverable when tectonic is missing, and the handoff format when someone wants to keep editing.
    bundle = os.path.join(host, "%s_overleaf" % name)
    zip_path = shutil.make_archive(bundle, "zip", work)

    def _run(cmd, **kw):
        if command_runner:
            return command_runner(cmd, work)
        return subprocess.run(cmd, cwd=work, capture_output=True, text=True, timeout=300, **kw)

    # the engine hardcodes ~/.local/bin/tectonic, which is one machine's layout; prefer whatever is on PATH
    tectonic = tectonic_path or shutil.which("tectonic") or p.TECTONIC
    common = {"tex": out_tex, "overleaf_zip": zip_path, "n_figures": len(figs), "n_refs": len(known),
              "writing_contract": quality}

    def finish(status, review_pages=None, **extra):
        artifacts = {"tex": _artifact(td, out_tex), "overleaf_zip": _artifact(td, zip_path)}
        if os.path.isfile(out_pdf) and os.path.getsize(out_pdf):
            artifacts["pdf"] = _artifact(td, out_pdf)
        manifest = {
            "version": 1,
            "generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "name": name,
            "status": status,
            "title": title,
            "writing_contract": quality,
            "inputs": {"sections": sections_input, "bibliography": bib_input,
                       "figures": figure_inputs},
            "artifacts": artifacts,
            "review_pages": [_artifact(td, p) for p in (review_pages or [])],
        }
        if extra.get("error"):
            manifest["error"] = extra["error"]
        with open(manifest_path, "w") as f:
            json.dump(manifest, f, indent=2, ensure_ascii=False, sort_keys=True)
        return dict(common, status=status, manifest=manifest_path,
                    manifest_sha256=_file_sha256(manifest_path),
                    artifact_sha256={k: v["sha256"] for k, v in artifacts.items()},
                    review_pages=manifest["review_pages"], **extra)

    if not command_runner and not os.path.exists(tectonic):
        return finish("tex_only",
                      note="tectonic is not installed, so no PDF was produced. Everything else worked: upload "
                           "%s to Overleaf (New Project, Upload Project) and compile there, or install tectonic "
                           "and run this command again." % os.path.basename(zip_path))
    r = _run([tectonic, "main.tex"])
    pdf = os.path.join(work, "main.pdf")
    if r.returncode != 0 or not os.path.exists(pdf) or os.path.getsize(pdf) == 0:
        return finish("error", tectonic_returncode=r.returncode,
                      error=(r.stdout + r.stderr)[-1500:],
                      note="the LaTeX did not compile; %s still holds the full source for Overleaf"
                           % os.path.basename(zip_path))

    shutil.copy(pdf, out_pdf)
    review_pages = []
    if not command_runner:
        pdftoppm = shutil.which("pdftoppm")
        if not pdftoppm:
            return finish("error", error="pdftoppm is missing; the compiled PDF cannot be reviewed")
        os.makedirs(review_dir, exist_ok=True)
        preview = subprocess.run([pdftoppm, "-png", "-r", "120", out_pdf,
                                  os.path.join(review_dir, "page")],
                                 capture_output=True, text=True, timeout=300)
        review_pages = [os.path.join(review_dir, f) for f in sorted(os.listdir(review_dir))
                        if f.lower().endswith(".png")]
        if preview.returncode != 0 or not review_pages:
            return finish("error", error="PDF page rendering failed: %s" %
                          (preview.stdout + preview.stderr)[-1500:])
    return finish("ok", review_pages=review_pages, pdf=out_pdf, tex=out_tex,
                  sections=[s for s in sections.get("_order", [])])


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    k = sub.add_parser("contract", help="print the field-specific writing contract")
    k.add_argument("--task", required=True)
    k.add_argument("--style", choices=sorted(paper_specs.FIELD_SPECS))
    c = sub.add_parser("compile", help="sections.json -> PDF")
    c.add_argument("--task", required=True)
    c.add_argument("--sections", required=True)
    c.add_argument("--title", required=True)
    c.add_argument("--authors", default="Anonymous")
    c.add_argument("--name", default="paper")
    a = ap.parse_args()
    td = hb.resolve_task(a.task)
    if a.cmd == "contract":
        print(json.dumps({"case": td, **writing_contract(td, a.style)}, indent=2, ensure_ascii=False))
        return
    sections_path = hb.case_path(td, a.sections)
    out = compile_paper(td, json.load(open(sections_path)), a.title, a.authors, a.name,
                        sections_path=sections_path)
    print(json.dumps({"case": td, **out}, indent=2, ensure_ascii=False))
    sys.exit(0 if out["status"] in ("ok", "tex_only") else 1)


if __name__ == "__main__":
    main()
