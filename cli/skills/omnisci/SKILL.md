---
name: omnisci
description: Run OmniScientist end to end in the OmniScientist CLI using DeepSeek V4 Flash. Turn raw research data (images, signals, audio, video, 3-D, tables, or graphs) and an open direction into perceived evidence, a falsifiable hypothesis, recorded analysis, real citations, a gated candidate paper, PDF, and Overleaf bundle. Use only when the user explicitly asks to make, draft, or produce a paper from data, invokes OmniScientist, or says things like "我的数据在这里，请帮我搞一篇论文" or "从这些数据做一篇论文". Do not trigger merely because the workspace contains research data, images, or series.json.
---

# omnisci: DeepSeek is the scientist, the CLIs are the instruments

Do the science in the current CLI session. The python here does only what a model must not do by hand: render
raw data into something viewable, run analysis code, fetch real references, assemble LaTeX, and enforce the
gates. These CLIs never call another model API. DeepSeek V4 Flash remains the scientist and author. Because the
official DeepSeek endpoint accepts text only, the CLI's `view_image` sends pixels to its fixed, vision-capable
sidecar and returns only the factual observation to DeepSeek. This follows OmniScientist's own text-backbone
plus `VISION_SIDECAR` design.

## Where the commands live

The CLIs ship inside this skill and the launcher sets `OMNISCI`. Confirm it once and use it in every command:

```bash
test -n "$OMNISCI" && test -f "$OMNISCI/evidence_cli.py"
python3 $OMNISCI/evidence_cli.py --help            # confirm before going further
```

`--task` takes a case directory (absolute paths always work), or a bare name that resolves under
`$OMNISCI_CASES` or the engine's bundled `examples/`. Every other path you pass (a script, a figure, a `.tex`,
a `sections.json`) is resolved **relative to the case directory**.

Every command echoes the `case` it resolved. **Check it on your first call.** A bare name can land on a bundled
example that already holds someone else's recorded runs, and the gate would then happily ground your paper's
numbers against their ledger. When the case is the user's own folder, pass its absolute path.

Three state-changing steps are OmniScientist tools, not shell commands: `omnisci_record`, `omnisci_bib`, and
`omnisci_compile`. Call them through the tool protocol. They run the packaged CLIs with argument arrays and
return receipts that the final delivery verifier binds to the current files. A `bash` call to the same Python
CLI may help diagnose a failure, but it cannot satisfy final delivery.

## Before the loop: is there a case?

A case is a directory holding a `series.json`. Bundled demos have one. **A real user almost never does**: they
have a folder of images, recordings or volumes, and a question. Build the case first, from their folder:

```bash
python3 $OMNISCI/case_cli.py inspect --dir ~/their_folder      # what is in there, what modality, what labels
python3 $OMNISCI/case_cli.py init --dir ~/their_folder \
    --role "a histopathologist reading H&E-stained sections" \
    --subject "a tissue microscopy field" \
    --direction "Find a concrete, testable question these fields can answer, choose the method yourself, and run real code to test it."
```

Before initialising a new case, check whether one already exists nearby: users often point at the `data/`
subfolder of a case whose `series.json` sits one level up (list the parent of the folder they named; the CLIs
also search upward, adopting a parent only when its `series.json` actually lists files under that folder).

`inspect` never writes; run it first and tell the user what you found. `init` writes `series.json` into their
folder and nothing else (use `--out` to build the case elsewhere and symlink the data instead). Files are
routed to a modality by extension, and each item's label is taken from its containing folder, so
`tumour/a.png` is labelled `tumour`; pass `--label-from none` when the folders mean nothing.

The three fields are yours to write, and `--direction` is the one that matters: state the data and the goal,
and **do not prescribe the method**. "Compare mean intensity between the two groups" produces a worse paper
than "find a concrete, testable question this data can answer". Ask the user for the framing if their request
is too thin to write it, then show them the direction you wrote before running.

## Three rules that are not negotiable

1. **Every number in the paper must come from a recorded run.** Numbers enter only through the
   `omnisci_record` tool, which runs the script and banks its stdout with a session receipt. This includes setup
   values: if you write that the green
   class covers 458 to 532 nm, that is a claim about the data and your script must print it. Never carry a
   number you computed in your head. `gate_cli.py check` blocks the paper otherwise.
2. **Every citation must be a paper that exists.** They come from `lit_cli.py search` and only from there.
   Every final pick needs a DOI: `bib` resolves it again and writes hash-bound verification provenance that the
   final gate checks. Discard the off-topic hits a broad query drags in.
3. **Look at the evidence before forming a hypothesis, and ingest what you saw.** A rendered image you never
   ingested is an image nobody read, and the gate now blocks on it.

## The loop

### 0. See the data

Read the case's `series.json` first. Field names vary: the open research brief may be called `direction`,
`request` or `idea_hints`, and `role` / `subject` / `property` describe the scientist you are playing. There is
no fixed schema, so read what is actually there.

Then ask what this case unlocks, and **read the returned schema rather than copying the shapes below**, since
arguments differ per tool:

```bash
python3 $OMNISCI/evidence_cli.py tools --task <case>
```

`look_at_image` takes `files` (an array). `look_at_signal`, `look_at_audio`, `look_at_video`, `look_at_3d` and
`look_at_trajectory` each take `file`, a **single** path, one call per item. `analyze_*` tools return numbers
immediately and involve no vision at all; use them freely, they cost nothing.

```bash
python3 $OMNISCI/evidence_cli.py run --task <case> --tool look_at_signal --args '{"file": "data/x.npy", "question": "..."}'
```

A `look_at_*` call returns `status: needs_vision` with a `pending` list. For every pending item, call OmniScientist's
`view_image` tool on its `image` path and ask its exact `question`. The tool binds its pixel observation to the
pending request with a receipt. Only after the real image has been returned, ingest that receipt:

```bash
python3 $OMNISCI/evidence_cli.py ingest --task <case> --call <id>
```

Do not hand-write `--answers`: ingest rejects text that differs from the `view_image` receipt. The request id
inside each call still starts at 1; it is not the call id and not a running total.

Ingest immediately after each call rather than batching at the end; a call left pending is indistinguishable
from never having looked. The budget is 12 **images**, not 12 calls: `look_at_image` with three files spends
three of them, while one `look_at_3d` spends one even though the render it returns holds six panels. Every call
prints `used=n/12`, so watch it. Raise it with `--budget` on `run` if the case needs more, and spend it on
items you chose for a reason.

This is the whole point of host mode. A non-image modality is rendered to a PNG by python first, and you read
that PNG the same way. Describe what is in the picture, not what you expect; if a render looks blank or
degenerate, say so rather than inventing structure.

### 1. Form a hypothesis

State one falsifiable question that follows from what you saw and from the case's brief. Choose the method
yourself. In an interactive session, tell the user the question before spending their time on it; in a
non-interactive run, put it at the top of your final report.

### 2. Run real analysis

Write a python script under `<case>/host/analysis/`, print every decisive number as `name = value`, and save
figures under `<case>/host/figures/`. The script runs with **cwd set to the case directory**, so resolve paths
from `__file__` if you need to be safe. Then call `omnisci_record` with `script` set to
`host/analysis/<name>.py`; pass `argv` only when the script actually takes positional arguments. Do not run
`gate_cli.py record` through `bash`: it produces a workspace ledger line but no trusted session receipt, so
final delivery rejects it.

Print more than you think you need: every constant, window, threshold and count that will appear in the prose.
Output is streamed as the script runs, so progress lines are useful, and it is banked verbatim unless it passes
2 million characters, at which point the middle is dropped and you are warned. The tool timeout is at most
600 seconds; set its `timeout` argument lower for a deliberately bounded analysis.

Only the latest run of each script-and-arguments invocation is active. A non-zero rerun invalidates its earlier
success, and editing the script invalidates every result recorded from its old bytes. Failed or stale stdout can
never ground a paper; fix the script and record it successfully again.

Call `view_image` on every analysis figure afterwards to confirm it is not blank, clipped, mislabeled, or
misleading. Report a null result as a null result; a paper that honestly resolves nothing is acceptable, a
paper that dresses a null as a discovery is not.

Figure shape contract: a single-column figure prints WIDE and SHORT, height about 0.43x its width (think
10:4.3); a figure meant to span both columns doubles the width at the SAME height, never the height. A
sparse chart (a handful of bars or points) gets a smaller height, not a bigger canvas, and two half-empty
plots belong in one multi-panel row rather than two figures. Compile lint reports `fig_aspect` red on
anything taller than these bands (col 0.58, wide 0.30 of the width).

### 3. Get real references

```bash
python3 $OMNISCI/lit_cli.py search --query "<specific terms from your subject>" --n 10     # explore
python3 $OMNISCI/lit_cli.py search --doi 10.1038/s41597-022-01721-8                        # pin one you decided on
```

**A paper needs at least 12 references, and 15 to 25 is the normal range.** One search does not get you there:
its recall covers one subtopic, so run several, one per angle. For a typical study that means the dataset or
benchmark you used, the existing methods for the task itself, the metric or statistical machinery you rely on,
and the field each control task belongs to. Concatenate every hit you want into one `picks.json`. `omnisci_bib`
tells you the count it wrote and warns when it is under the floor; a thin bibliography is not a compile error,
it just makes the related-work discussion visibly weak.

Write the combined picks under the case, for example `host/picks.json`, then call `omnisci_bib` with that
relative path. Do not invoke `lit_cli.py bib` through `bash`; only the dedicated tool creates the session
receipt required for delivery.

`--n` is how many hits you get back in total. Free-text recall is **not stable**: the same query can return a
paper on one call and not the next, so once you have chosen a reference, re-fetch it with `--doi` and build
`picks.json` from those. `picks.json` is a JSON list of hit objects **exactly as search printed them**, one
array holding every reference you want; each `search` call prints its own array, so concatenate them yourself
rather than expecting the tool to accumulate.

`search` does not return bib keys, it returns papers; the keys are minted by `bib`, so run `bib` first and cite
the keys **it** prints. `bib` rejects picks without a DOI and re-fetches each DOI instead of trusting fields in
`picks.json`. A `\cite` to any key outside the bib is stripped at assembly, so a hallucinated key silently
loses its citation; a changed or hand-written bibliography fails the gate's provenance hash.

### 4. Get the writing contract, outline, write, and compile

`omnisci_compile` ends with an **acceptance report**: the engine's paper lint (printed reference count with a
floor of 15, result-number density per paragraph, table rules, overfull boxes, missing glyphs, figure fonts and
colours, stripper wreckage in the abstract, and more). Red items are labels, not a gate: the PDF is already on
disk. Treat them as the remaining distance to the house standard and fix them before delivery when you can. A
`refs_count` red means going back to `lit_cli.py`, not rewording.

Before drafting any prose, print the contract selected from the case's field or explicit style:

```bash
python3 $OMNISCI/paper_cli.py contract --task <case>
```

The case's resolved style is binding. If the user explicitly requests another venue style, first set the top-level
`style` field in `series.json` to `earth_space`, `cs_ml`, `biomed`, `physics`, or `chem`, then rerun the command.
Use `contract --style ...` only to preview an alternative; compilation rejects a `_style` that disagrees with the case.

Treat that JSON as the writing schema, not as optional advice:

- Copy `_style`, `_order`, and `_lead_section` exactly into `sections.json`. Do not rename a canonical section
  (for example, do not substitute `Analysis` for `Methods`) or omit the concluding section.
- For every section, map each `ordered_paragraph_jobs` entry to the recorded facts and real references it needs,
  then expand the jobs **in order**. Emit one substantive paragraph per job and separate adjacent paragraphs with
  a blank line (`\n\n`). Do not print the job labels or the outline itself in the paper.
- A section whose contract sets `citations` to `true` must cite at least one key from the current verified
  `references.bib`; compilation rejects missing and unknown keys rather than silently producing uncited prior work.
- Stay inside each section's `words` and `paragraphs` ranges. The Abstract is deliberately one paragraph; a body
  section is not. Never collapse several jobs into one long paragraph and never fake compliance with one-sentence
  fragments.
- Preserve rhetorical roles. The headline finding belongs in the lead Results-type section; controls establish
  boundaries, the Discussion interprets without restating all results, and Limitations bound scope without erasing
  the supported finding.

For `earth_space`, this restores the five-part Introduction used by the original writer: big picture, narrowing to
the subtopic, a cited prior-work synthesis, the precise gap, and this study with a qualitative preview. Other styles
receive their own venue-specific arc from the command rather than this earth-science arc.

```json
{"_style": "earth_space",
 "_order": ["Introduction", "Data", "Methods", "Results", "Discussion", "Conclusions"],
 "_lead_section": "Results",
 "_figures": [{"file": "host/figures/f.png", "caption": "..."}],
 "_results_table": "\\begin{table}[H]\\centering ... \\end{table}",
 "ABSTRACT": "...", "Introduction": "...", "Results": "..."}
```

The contract determines section order for the selected field. Figures interleave into `_lead_section` and are
numbered in the order you list them. Write your own
`Figure~\ref{fig:fN}` **inside `_lead_section`**: a reference from any other section does not count, and the
writing-contract gate rejects a listed figure that is not referenced there.

**Tables go in `_results_table` and nowhere else.** It is inserted as raw LaTeX after the lead section's first
paragraph. A `tabular` written into ordinary section prose gets its `&` and `_` escaped and will not compile.
`_results_table` must contain exactly one complete `table` environment and no document or section commands.

Your prose is sanitised on the way in: `_ % & #` are escaped, a bare `^` becomes a literal, em-dashes are
removed, and the writing-contract gate rejects an unpaired `$` before the sanitizer could truncate the section.
So write `cm$^{-1}$`, not `cm^-1`, and check your math delimiters pair up.
Outside supported math and list environments, keep LaTeX to citations, references, and simple text emphasis. The
gate rejects section/document commands, macro definitions, layout primitives, and arbitrary environments because
they can change or hide the validated paragraph structure.

Call `omnisci_compile` with the case-relative `sections` path and the paper `title`; leave `name` as `paper`.
Only this tool creates the trusted compile receipt. It also writes `host/paper.manifest.json` and renders every
page of the current PDF under `host/paper_review/` for mandatory visual review.

Compilation validates the writing contract before LaTeX assembly. If it reports `writing contract failed`, rewrite
the named sections from their ordered jobs and run `omnisci_compile` again. Do not bypass the error by adding empty
lines: only paragraph blocks with substantial prose count.

Every compile starts from a clean managed build directory and writes `<name>_overleaf.zip` beside the paper:
the current LaTeX source, figures, and bib only. A failed rerun removes the prior PDF, so an old successful PDF
can never masquerade as the new result. If tectonic is not installed the status comes back `tex_only` and
**that bundle is the deliverable**; hand
the user the zip and tell them to upload it to Overleaf (New Project, Upload Project). A compile failure
returns the tectonic error instead of a PDF, and the bundle is still there; fix your LaTeX and run again.

### 5. Pass the gate

```bash
python3 $OMNISCI/gate_cli.py check --task <case> --tex host/paper.tex
```

Exit 2 means one of three things. Two are about perception: some call was left pending, or a case with
perceptual evidence has **no** completed perception at all. The rule is exactly that, at least one ingested
call and zero pending; there is no per-member coverage requirement, and with a case of 1500 members there
could not be. The third is an ungrounded number. Fix that **at the source**, by printing it from the analysis
and recording again, rather than by deleting a true sentence.

What counts as a number: every numeric token, including single digits, wavelengths, window bounds, counts,
figure captions, and everything inside `_results_table`. Four-digit citation years and identifiers with a
letter prefix (`R110104`) are not results. Ranges written `200--1200` are read as two numbers. Percent and
fraction forms of the same recorded value both ground, within 2 per cent relative tolerance and only a tiny
floating-point epsilon, so a printed `0.091` covers a written `9.1` but cannot cover an unrelated small value.
Write a p-value exactly as your script printed it, `1.96e-08`, not re-expressed as
`1.96\times10^{-8}$`.

### 6. Hand back

Inspect the finished PDF before showing it. Extract its text with `pdftotext`, then read
`host/paper.manifest.json` and call `view_image` on **every** listed `review_pages` image to catch blank pages,
clipping, overlapping content, and broken figures. These pages were rendered from the hash-bound current PDF;
hand-rendered substitutes do not count. The final verifier also requires a current `view_image` receipt for
every analysis figure listed in the manifest. Then give the user the path, the hypothesis you tested, the
decisive numbers, the references, and what the gate said.

## What the gate does not do

It verifies that every numeral in the paper appeared in some recorded run, within tolerance. It does **not**
verify that a number is attached to the right quantity: writing "accuracy was 0.947" when 0.947 was a cosine
passes. Passing the gate means nothing was invented, not that the paper is correct. That part is on you.

## Honest framing

Present the output as a candidate paper. It is one reader, one sample, one analysis, and the Limitations belong
in the paper rather than in your summary of it. Show the user the commands you ran so they can rerun any step.
