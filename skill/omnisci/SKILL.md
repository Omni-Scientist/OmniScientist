---
name: omnisci
description: Run OmniScientist end to end inside this harness, with no API key. The user gives a domain, some raw data (images, signals, audio, video, 3-D, tables, graphs) and an open research direction; YOU perceive the evidence with your own eyes, form a falsifiable hypothesis, write and run real analysis code, and produce a cited PDF paper. Use when the user types /omnisci or says things like "make a paper from these images", "run OmniScientist on this seismogram", "从这些数据做一篇论文".
---

# omnisci: you are the scientist, the CLIs are the instruments

You do the science yourself. The python here does only what a model must not do by hand: render raw data into
something viewable, run analysis code, fetch real references, assemble LaTeX, and enforce the gates. No model
API is called at any point. Your own multimodal read is the perceiver.

## Where the commands live

The CLIs ship inside this skill. Set this once, at the start of the session, and use it in every command:

```bash
export OMNISCI=~/.claude/skills/omnisci/bin        # or wherever this skill is installed
python3 $OMNISCI/evidence_cli.py --help            # confirm before going further
```

`--task` takes a case directory (absolute paths always work), or a bare name that resolves under
`$OMNISCI_CASES` or the engine's bundled `examples/`. Every other path you pass (a script, a figure, a `.tex`,
a `sections.json`) is resolved **relative to the case directory**.

Every command echoes the `case` it resolved. **Check it on your first call.** A bare name can land on a bundled
example that already holds someone else's recorded runs, and the gate would then happily ground your paper's
numbers against their ledger. When the case is the user's own folder, pass its absolute path.

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

1. **Every number in the paper must come from a recorded run.** Numbers enter only through
   `gate_cli.py record`, which banks a script's stdout. This includes setup values: if you write that the green
   class covers 458 to 532 nm, that is a claim about the data and your script must print it. Never carry a
   number you computed in your head. `gate_cli.py check` blocks the paper otherwise.
2. **Every citation must be a paper that exists.** They come from `lit_cli.py search` and only from there.
   Prefer hits that carry a DOI, and discard the off-topic ones a broad query drags in.
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

A `look_at_*` call returns `status: needs_vision` with images. **Read each PNG yourself**, then record what you
saw:

```bash
python3 $OMNISCI/evidence_cli.py ingest --task <case> --call <id> --answers '{"1": "what you actually saw"}'
```

The key in `--answers` is the `id` inside that call's own `pending` list, which starts at 1 for every call. It
is not the call id and not a running total.

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
from `__file__` if you need to be safe. Then:

```bash
python3 -u $OMNISCI/gate_cli.py record --task <case> --script host/analysis/<name>.py
```

Print more than you think you need: every constant, window, threshold and count that will appear in the prose.
Output is streamed as the script runs, so progress lines are useful, and it is banked verbatim unless it passes
2 million characters, at which point the middle is dropped and you are warned. There is no default timeout; set
`--timeout <seconds>` if you want one.

Read your own figures afterwards to confirm they are not broken. Report a null result as a null result; a paper
that honestly resolves nothing is acceptable, a paper that dresses a null as a discovery is not.

### 3. Get real references

```bash
python3 $OMNISCI/lit_cli.py search --query "<specific terms from your subject>" --n 10     # explore
python3 $OMNISCI/lit_cli.py search --doi 10.1038/s41597-022-01721-8                        # pin one you decided on
python3 $OMNISCI/lit_cli.py bib --task <case> --picks picks.json
```

**A paper needs at least 15 references, and 15 to 25 is the normal range.** One search does not get you there:
its recall covers one subtopic, so run several, one per angle. For a typical study that means the dataset or
benchmark you used, the existing methods for the task itself, the metric or statistical machinery you rely on,
and the field each control task belongs to. Concatenate every hit you want into one `picks.json`. The compile
step counts the references actually printed in the PDF and reports `refs_count` red below 15; that is a label,
not a compile error, but a thin bibliography makes the related-work discussion visibly weak.

`--n` is how many hits you get back in total. Free-text recall is **not stable**: the same query can return a
paper on one call and not the next, so once you have chosen a reference, re-fetch it with `--doi` and build
`picks.json` from those. `picks.json` is a JSON list of hit objects **exactly as search printed them**, one
array holding every reference you want; each `search` call prints its own array, so concatenate them yourself
rather than expecting the tool to accumulate.

`search` does not return bib keys, it returns papers; the keys are minted by `bib`, so run `bib` first and cite
the keys **it** prints. A `\cite` to any key outside the bib is stripped at assembly, so a hallucinated key
silently loses its citation.

### 4. Get the writing contract, outline, write, and compile

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

```json
{"_style": "earth_space",
 "_order": ["Introduction", "Data", "Methods", "Results", "Discussion", "Conclusions"],
 "_lead_section": "Results",
 "_figures": [{"file": "host/figures/f.png", "caption": "..."}],
 "_results_table": "\\begin{table}[H]\\centering ... \\end{table}",
 "ABSTRACT": "...", "Introduction": "...", "Results": "..."}
```

Figures interleave into `_lead_section` and are numbered in the order you list them. Write your own
`Figure~\ref{fig:fN}` **inside `_lead_section`**: a reference from any other section does not count, and the
writing-contract gate rejects a listed figure that is not referenced there.

**Tables go in `_results_table` and nowhere else.** It is inserted as raw LaTeX after the lead section's first
paragraph. A `tabular` written into ordinary section prose gets its `&` and `_` escaped and will not compile.
`_results_table` must contain exactly one complete `table` environment and no document or section commands.

Your prose is sanitised on the way in: `_ % & #` are escaped, a bare `^` becomes a literal, em-dashes are
removed, and the writing-contract gate rejects an unpaired `$` before the sanitizer could truncate the section.
So write `cm$^{-1}$`, not `cm^-1`, and check your math delimiters pair up. Outside supported math and list
environments, keep LaTeX to citations, references, and simple text emphasis.

Hand-writing a large JSON file rarely survives the escaping; generate `sections.json` with a small python script
and `json.dump`, then compile:

```bash
python3 $OMNISCI/paper_cli.py compile --task <case> --sections host/sections.json --title "<title>"
```

Compilation validates the writing contract before LaTeX assembly. If it reports `writing contract failed`, rewrite
the named sections from their ordered jobs and compile again. Do not bypass the error by adding empty lines: only
paragraph blocks with substantial prose count.

A successful compile writes, under `host/`: `paper.pdf`, `paper.tex`, `paper_overleaf.zip` (source, figures and
bib, the deliverable when tectonic is missing and the status comes back `tex_only`), `paper.manifest.json`
(hash-bound record of inputs and outputs), one PNG per page under `paper_review/`, and `paper.lint.json`. The
JSON it prints ends with a `lint` object, the engine's **acceptance report**: printed reference count (floor 15),
result-number density per paragraph (at most 3), table rules, overfull boxes, missing glyphs, figure fonts and
colours, stripper wreckage in the abstract, and more. `lint.red` lists what failed with a one-line reason each.
Red items are labels, not a gate: the PDF is already on disk. Fix them before handing back when you can; a
`refs_count` red means going back to `lit_cli.py`, not rewording. Every compile starts from a clean build
directory and a failed rerun removes the prior PDF, so an old PDF can never masquerade as the new result.

### 5. Pass the gate

```bash
python3 $OMNISCI/gate_cli.py check --task <case> --tex host/paper.tex
```

Exit 2 means one of these: a perception call was left pending, or a case with perceptual evidence has no
completed perception at all (the rule is exactly one ingested call or more and zero pending; there is no
per-member coverage requirement); the paper cites a key that is not in the verified bibliography, or
`references.bib` changed after its DOI verification; the analysis ledger has no current successful run (a failed
run never grounds numbers, and editing a script invalidates its old run, so record again); or a number in the
prose is ungrounded. Fix an ungrounded number **at the source**, by printing it from the analysis and recording
again, rather than by deleting a true sentence.

What counts as a number: every numeric token, including single digits, wavelengths, window bounds, counts,
figure captions, and everything inside `_results_table`. Four-digit citation years and identifiers with a letter
prefix (`R110104`) are not results. Ranges written `200--1200` are read as two numbers. Percent and fraction forms
of the same recorded value both ground, within 2 per cent relative tolerance and only a tiny floating-point
epsilon, so a printed `0.091` covers a written `9.1` but cannot cover an unrelated small value. Write a p-value
exactly as your script printed it, `1.96e-08`, not re-expressed as `1.96\times10^{-8}`.

### 6. Hand back

Inspect the finished PDF before showing it. Read `host/paper.manifest.json` and look at **every** image listed
under `review_pages` with your own eyes (you are the perceiver in this harness) to catch blank pages, clipping,
overlapping content, and broken figures. Then give the user the path, the hypothesis you tested, the decisive
numbers, the references, what the gate said, and which lint items are still red.

## What the gate does not do

It verifies that every numeral in the paper appeared in some recorded run, within tolerance. It does **not**
verify that a number is attached to the right quantity: writing "accuracy was 0.947" when 0.947 was a cosine
passes. Passing the gate means nothing was invented, not that the paper is correct. That part is on you.

## Honest framing

Present the output as a candidate paper. It is one reader, one sample, one analysis, and the Limitations belong
in the paper rather than in your summary of it. Show the user the commands you ran so they can rerun any step.
