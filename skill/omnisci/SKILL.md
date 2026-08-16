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
python3 $OMNISCI/lit_cli.py search --query "<specific terms from your subject>" --n 6      # explore
python3 $OMNISCI/lit_cli.py search --doi 10.1038/s41597-022-01721-8                        # pin one you decided on
python3 $OMNISCI/lit_cli.py bib --task <case> --picks picks.json
```

`--n` is how many hits you get back in total. Free-text recall is **not stable**: the same query can return a
paper on one call and not the next, so once you have chosen a reference, re-fetch it with `--doi` and build
`picks.json` from those. `picks.json` is a JSON list of hit objects **exactly as search printed them**, one
array holding every reference you want; each `search` call prints its own array, so concatenate them yourself
rather than expecting the tool to accumulate.

`search` does not return bib keys, it returns papers; the keys are minted by `bib`, so run `bib` first and cite
the keys **it** prints. A `\cite` to any key outside the bib is stripped at assembly, so a hallucinated key
silently loses its citation.

### 4. Write and compile

```json
{"_order": ["Introduction", "Data", "Analysis", "Results", "Discussion"],
 "_lead_section": "Results",
 "_figures": [{"file": "host/figures/f.png", "caption": "..."}],
 "_results_table": "\\begin{table}[H]\\centering ... \\end{table}",
 "ABSTRACT": "...", "Introduction": "...", "Results": "..."}
```

Section order follows the field: Introduction / Data / Analysis / Results / Discussion for observational
science, Introduction / Related Work / Method / Experiments / Conclusion for ML, Results before Methods for
biology. Figures interleave into `_lead_section` and are numbered in the order you list them. Write your own
`Figure~\ref{fig:fN}` **inside `_lead_section`**: a reference from any other section does not count, and the
fallback sentence "These results are summarized in Figure~N" gets appended anyway.

**Tables go in `_results_table` and nowhere else.** It is inserted as raw LaTeX after the lead section's first
paragraph. A `tabular` written into ordinary section prose gets its `&` and `_` escaped and will not compile.

Your prose is sanitised on the way in: `_ % & #` are escaped, a bare `^` becomes a literal, em-dashes are
removed, and **everything after an unpaired `$` is truncated**. So write `cm$^{-1}$`, not `cm^-1`, and check
your math delimiters pair up.

```bash
python3 $OMNISCI/paper_cli.py compile --task <case> --sections sections.json --title "..."
```

Every compile also writes `<name>_overleaf.zip` beside the paper: the full LaTeX source, the figures and the
bib. If tectonic is not installed the status comes back `tex_only` and **that bundle is the deliverable**; hand
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

What counts as a number: anything with two or more digits, including wavelengths, window bounds and counts,
**and everything inside `_results_table`**, which is exactly where a re-expressed number tends to hide. Not
checked: four-digit years, single digits, identifiers with a letter prefix (`R110104`), and anything inside a
figure environment. Ranges written `200--1200` are read as two numbers. Percent and fraction forms of the same
recorded value both ground, within 2 per cent, so a printed `0.091` covers a written `9.1`. Write a p-value
exactly as your script printed it, `1.96e-08`, not re-expressed as `1.96\times10^{-8}$`.

### 6. Hand back

Read the PDF yourself before you show it. Then give the user the path, the hypothesis you tested, the decisive
numbers, the references, and what the gate said.

## What the gate does not do

It verifies that every numeral in the paper appeared in some recorded run, within tolerance. It does **not**
verify that a number is attached to the right quantity: writing "accuracy was 0.947" when 0.947 was a cosine
passes. Passing the gate means nothing was invented, not that the paper is correct. That part is on you.

## Honest framing

Present the output as a candidate paper. It is one reader, one sample, one analysis, and the Limitations belong
in the paper rather than in your summary of it. Show the user the commands you ran so they can rerun any step.
