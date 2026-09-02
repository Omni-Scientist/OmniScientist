"""mmsci AGENTIC scientist -- a SELF-CONTAINED agent harness (Codex / Claude-Code shape), NOT bolted onto
staged.py. It depends ONLY on pipeline.py for the low-level LLM transport (the gateway OpenAI client + image
encode + cost ledger); everything else (tools, literature search, the loop, the gates) lives here.

Shape (exactly the ReAct / main-loop model):
  main(task) -> for each STAGE -> agent_loop(...):  a real tool-using loop that calls tools, feeds results
  back, and KEEPS GOING until a DETERMINISTIC exit gate passes (or max_steps). The outer stage sequence is a
  thin pipeline; the intelligence is the inner loop. The gate is where the anti-fabrication / quality bars
  live -- the agent literally cannot leave a stage until its gate returns ok, which is stronger than any
  prompt instruction.

Locked design constraints (2026-06-27):
  - NO blind perception over ALL images. Materials are discovered via CHEAP text metadata (list_materials,
    zero pixels); images are inspected a FEW at a time, ON DEMAND, under a HARD budget (look_at_image).
  - General + tool-agnostic: vision is ONE optional tool; a text-only topic never even sees it. No
    multimodality for its own sake.
  - Quality >= the old single-shot: same 'known-landscape -> brainstorm 5 non-obvious -> self-screen
    novelty/feasibility -> select -> develop' discipline in the system prompt, AND finalize is gated
    (>=1 real literature search, candidates>=5, required fields). Novelty is grounded in REAL retrieval.
"""
import os, sys, json, re, subprocess, argparse, urllib.parse, urllib.request, zlib
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import pipeline                                  # pipeline.client (gateway), pipeline.U (cost), pipeline.chat
from pipeline import img_block, parse_json       # base64 image block + tolerant JSON parse
import evidence                                  # 4-category evidence layer (perceptual/structured/symbolic/procedural)
import paradigms                                 # research-framing library sampled into stage-1 ideation
import paperlint                                 # the acceptance checker; _result_numbers is shared, see _para_nums

_REF_FLOOR = paperlint.REFS_FLOOR                # block stage 3 at exactly the number refs_count will judge it by

# THE BRAIN reasons (agent loop + writing); THE EYE only answers look_at_* questions about one image. Keeping them
# separate is what makes the backbone axis mean anything: swapping the backbone must change REASONING, not perception
# (published runs all show mm_calls=0 on the backbone and every mm_call on the fixed vision model). It is also the only
# way to run a text-only backbone at all -- DeepSeek V4 / glm-5.2 / qwen3.7-max hard-404 on image input.
# Defaults mirror qc_run.sh, so a hand-typed `agentic.py --stage 3 --replay` costs the same as the pipeline.
# It used to default to claude-sonnet-5, which silently billed ~20x when the model env was forgotten.
_DEFAULT_BRAIN = "deepseek-v4-flash"                                # what qc_run.sh exports
_DEFAULT_EYE = "deepseek-v4-flash-vision-exp"                       # official-API-only vision side-car
_TEXT_ONLY = ("deepseek-", "glm-", "qwen", "kimi", "gemma")         # hard-404 on image input -> need the side-car
BRAIN = os.environ.get("OMNIST_MODEL", _DEFAULT_BRAIN)              # agent loop + writing (the reasoning backbone)
# The eye: an explicit OMNIST_PERCEIVER always wins; otherwise a text-only brain gets the DS side-car and a
# vision-capable brain (claude-*, gpt-*) is its own eye, which is the arrangement every published run used.
VISION = (os.environ.get("OMNIST_PERCEIVER")
          or (_DEFAULT_EYE if (BRAIN.startswith(_TEXT_ONLY) and BRAIN != _DEFAULT_EYE) else BRAIN))
# Route the EVIDENCE layer's perception through the same eye. Without this, evidence.py silently used its
# own hardcoded default (claude-sonnet-5) and OMNIST_PERCEIVER never reached the actual look_at_* tools.
evidence.PERCEIVER = VISION
evidence.PERCEIVERS["default"] = VISION
OPENALEX_MAIL = "mmsci@example.org"


def _perception_fail(tool, e):
    """A perception call died -> re-raise with a HUMAN summary on top (the raw trace stays chained below).
    The user must see WHY in one line -- 'no vision model configured' -- not just a bare traceback."""
    raise RuntimeError(
        "PERCEPTION FAILED in %r: the eye model %r errored (%s: %s). If the eye is a text-only model "
        "it cannot read images -- set OMNIST_PERCEIVER to a vision model, e.g. "
        "export OMNIST_PERCEIVER=deepseek-v4-flash-vision-exp (the official DeepSeek API)."
        % (tool, VISION, type(e).__name__, str(e)[:200])) from e


def task_dir(task):
    return os.path.join(HERE, "..", "examples", task)


def stages_dir(task):
    d = os.path.join(task_dir(task), "stages")
    os.makedirs(d, exist_ok=True)
    return d


def _write(task, name, obj, md):
    json.dump(obj, open(os.path.join(stages_dir(task), name + ".json"), "w"), indent=1, default=str)
    open(os.path.join(stages_dir(task), name + ".md"), "w").write(md)
    print("\n" + "=" * 78 + "\n" + md + "\n" + "=" * 78)
    print("wrote stages/%s.{json,md}" % name)


# ---------------------------------------------------------------- the generic ReAct loop (the heart)
def agent_loop(system, task, tools, exec_fn, model, done, max_steps=16, image_budget=8,
               search_budget=6, max_tokens=4000, log=print, trace_path=None):
    """Run a ReAct tool-use loop until `done(final, state)` passes or max_steps.

    tools   : OpenAI tool schemas the agent may call.
    exec_fn : exec_fn(name, args, state, log) -> str. Executes one tool; a 'finalize_*' tool stores its dict
              into state['final'].
    done    : done(final, state) -> (ok, why). The exit gate. Until ok, the agent is told why and continues.
    Budgets (image_budget, search_budget) cap the expensive tools so the agent CONVERGES instead of
    exploring forever; step-pressure forces a finalize before max_steps. Returns the gated final dict, or
    {'_failed': True, ...} on max_steps / gateway error.
    """
    msgs = [{"role": "system", "content": system}, {"role": "user", "content": task}]
    state = {"final": None, "img_used": 0, "img_budget": image_budget, "searched": 0,
             "search_budget": search_budget, "trace": [], "_pressured": False}
    full = [{"step": -1, "role": "system_prompt", "text": system},      # COMPLETE replayable trace (own file)
            {"step": -1, "role": "task_message", "text": task}]

    def _dump():
        if trace_path:
            try:
                json.dump(full, open(trace_path, "w"), ensure_ascii=False, indent=1, default=str)
            except Exception as e:
                log("  [agent] trace dump failed: %s" % e)

    def _bill(r):
        u = getattr(r, "usage", None)                         # feed the existing cost ledger
        if not u:
            return
        m = pipeline.U.setdefault(model, {"in": 0, "out": 0, "calls": 0, "mm_calls": 0, "cread": 0, "cwrite": 0})
        pt = getattr(u, "prompt_tokens", 0) or 0
        cr = getattr(u, "cache_read_input_tokens", 0) or 0     # Anthropic: cache read is SEPARATE from prompt_tokens
        cw = getattr(u, "cache_creation_input_tokens", 0) or 0
        ptd = getattr(u, "prompt_tokens_details", None)        # OpenAI: cached tokens are nested AND counted INSIDE prompt_tokens
        if ptd is not None:
            oc = getattr(ptd, "cached_tokens", 0) or 0
            cr += oc
            pt -= oc                                          # so bill only the FRESH remainder at full price (no double-count)
        m["in"] += pt
        m["out"] += getattr(u, "completion_tokens", 0) or 0
        m["cread"] += cr; m["cwrite"] += cw
        m["calls"] += 1
        if cr or cw:                                       # visible proof caching is working, per step
            log("  [cache] read=%d write=%d fresh_in=%d" % (cr, cw, pt))

    for step in range(max_steps):
        if state["final"] is None and step >= max_steps - 6 and not state["_pressured"]:
            _look_hint = ("" if not (state.get("img_budget", 0) > 0 and state.get("img_used", 0) == 0) else
                          " You have perception tools (look_at_*/analyze_*) and have not inspected a single real "
                          "item -- do ONE look_at_* call FIRST (the exit gate rejects a finalize that never "
                          "looked), then finalize.")
            msgs.append({"role": "user", "content":                # step-pressure: stop exploring, converge
                         "You are almost out of steps. STOP exploring/searching. SELECT from what you already "
                         "have and submit the full JSON via your finalize tool NOW." + _look_hint})
            state["_pressured"] = True
        try:
            r = pipeline.create(model, msgs, max_tokens=max_tokens, tools=tools, cache=True)
        except Exception as e:
            log("  [agent] create() error: %s -> retry once" % type(e).__name__)
            try:
                r = pipeline.create(model, msgs, max_tokens=max_tokens, tools=tools, cache=True)
            except Exception as e2:
                return {"_failed": True, "reason": "gateway error: %s" % e2}
        _bill(r)
        # Always-reasoning backbones (DeepSeek V4 flash) can burn the WHOLE token budget inside
        # reasoning_content: finish_reason='length' with EMPTY content and NO tool call. Verified live
        # 2026-08-28 (the qc_feynman stage-2 run died in 5 straight empty steps this way). One retry with a
        # doubled budget recovers it; without this the loop wastes its remaining steps on empty replies.
        _ch = r.choices[0]
        _tc = getattr(_ch.message, "tool_calls", None)
        _empty = not (_ch.message.content or "").strip()
        if getattr(_ch, "finish_reason", "") == "length" and (_empty or _tc):
            # length-cut reply: either reasoning ate the whole budget (empty content, no calls) or the
            # tool-call arguments JSON was cut mid-stream (calls present but unparseable/incomplete).
            log("  [agent] length-truncated reply (%s) -> retry with max_tokens=%d"
                % ("empty" if _empty else "cut tool-call args", max_tokens * 2))
            try:
                r = pipeline.create(model, msgs, max_tokens=max_tokens * 2, tools=tools, cache=True)
                _bill(r)
            except Exception as e:
                log("  [agent] doubled-budget retry failed: %s" % type(e).__name__)
        msg = r.choices[0].message
        calls = getattr(msg, "tool_calls", None)
        if calls:
            asst = {"role": "assistant",
                    "tool_calls": [{"id": c.id, "type": "function",
                                    "function": {"name": c.function.name,
                                                 "arguments": c.function.arguments}} for c in calls]}
            if (msg.content or "").strip():                   # omit content when empty (Claude rejects empty text blocks)
                asst["content"] = msg.content
            msgs.append(asst)
            entry = {"step": step, "role": "assistant", "reasoning_text": (msg.content or ""), "calls": []}
            for c in calls:
                try:
                    args = json.loads(c.function.arguments or "{}")
                except Exception:
                    args = {}
                if isinstance(args, dict) and set(args) == {"arguments"}:   # flash quirk: payload double-wrapped
                    _inner = args["arguments"]                              # in {"arguments": {...}} (seen live
                    if isinstance(_inner, str):                             # 2026-08-28, qc_feynman steps 48-49)
                        try:
                            _inner = json.loads(_inner)
                        except Exception:
                            _inner = None
                    if isinstance(_inner, dict):
                        args = _inner
                state["trace"].append({"step": step, "tool": c.function.name,
                                        "args": str(args)[:160]})   # truncated copy kept on the idea obj (no cycle)
                full_result = str(exec_fn(c.function.name, args, state, log) or "(no output)")
                msgs.append({"role": "tool", "tool_call_id": c.id,              # model sees a capped copy (token control)
                             "content": full_result[:6000] or "(empty)"})
                entry["calls"].append({"tool": c.function.name, "args": args,   # trace keeps the FULL result, uncapped
                                       "result": full_result})
            full.append(entry)
            if state.get("final") is not None:                # a finalize was called -> check the gate
                ok, why = done(state["final"], state)
                if ok:
                    log("  [agent] EXIT GATE PASSED at step %d (img_used=%d, searches=%d)"
                        % (step, state["img_used"], state["searched"]))
                    full.append({"step": step, "role": "exit_gate", "text": "PASSED"}); _dump()
                    state["final"]["_trace"] = state["trace"]
                    return state["final"]
                log("  [agent] finalize REJECTED: %s" % why)
                full.append({"step": step, "role": "exit_gate", "text": "REJECTED: " + why})
                state["final"] = None
                state["_rejects"] = state.get("_rejects", 0) + 1
                if state["_rejects"] >= 5 and "statistically supported" in why:   # weak backbone stuck re-chasing a significant lead -> push it to the honest null exit (now that the gate exempts verdict='null') instead of looping to max_steps
                    msgs.append({"role": "user", "content":
                                 ("You have been rejected %d times for a non-significant lead. STOP running more experiments to "
                                  "chase significance. Call finalize NOW with verdict='null' (or 'insufficient' if the data cannot "
                                  "answer the question) -- an honest null is a VALID, accepted outcome and WILL pass the gate. Keep "
                                  "your strongest analysis as 'lead'." % state["_rejects"])})
                else:
                    msgs.append({"role": "user", "content":
                                 "Your finalize did NOT pass the exit gate: " + why
                                 + " Fix exactly that and call the finalize tool again. Do not stop."})
            continue
        full.append({"step": step, "role": "assistant", "reasoning_text": (msg.content or ""),
                     "note": "no tool call (prose) -> nudged back"})
        msgs.append({"role": "user", "content":                # answered in prose -> push back to real work
                     "Do not answer in prose. Use the tools to do real work, and when the proposal is "
                     "complete call the finalize tool with the full JSON."})
    full.append({"step": max_steps, "role": "end", "text": "hit max_steps without a gated finalize"}); _dump()
    log("  [agent] hit max_steps (%d) without a gated finalize" % max_steps)
    return state.get("final") or {"_failed": True, "reason": "max_steps without a gated finalize"}


# ---------------------------------------------------------------- real tools (literature, vision)
def _oa(query, n=5):
    try:
        qs = urllib.parse.urlencode({"search": query, "per_page": n, "mailto": OPENALEX_MAIL,
                                     "select": "title,publication_year,authorships,primary_location,"
                                               "abstract_inverted_index,cited_by_count"})
        req = urllib.request.Request("https://api.openalex.org/works?" + qs,
                                     headers={"User-Agent": "mmsci/1.0 mailto:" + OPENALEX_MAIL})
        with urllib.request.urlopen(req, timeout=20) as r:
            data = json.loads(r.read().decode())
    except Exception:
        return []
    out = []
    for w in data.get("results", []):
        if not w.get("title"):
            continue
        inv = w.get("abstract_inverted_index") or {}
        pos = {}
        for word, idxs in inv.items():
            for i in idxs:
                pos[i] = word
        abs_ = " ".join(pos[i] for i in sorted(pos))[:500]
        auth = [a.get("author", {}).get("display_name", "") for a in (w.get("authorships") or [])[:4]]
        venue = ((w.get("primary_location") or {}).get("source") or {}).get("display_name") or ""
        out.append({"title": w["title"], "year": w.get("publication_year"), "venue": venue,
                    "authors": [a for a in auth if a], "abstract": abs_,
                    "cites": w.get("cited_by_count"), "source": "OA"})
    return out


def _crossref(query, n=4):
    url = "https://api.crossref.org/works?" + urllib.parse.urlencode(
        {"query": query, "rows": n, "select": "title,author,issued,container-title,is-referenced-by-count",
         "mailto": OPENALEX_MAIL})
    try:
        with urllib.request.urlopen(urllib.request.Request(
                url, headers={"User-Agent": "mmsci/1.0 (mailto:%s)" % OPENALEX_MAIL}), timeout=20) as r:
            data = json.loads(r.read().decode())
    except Exception:
        return []
    out = []
    for w in (((data.get("message") or {}).get("items")) or []):
        title = (w.get("title") or [""])[0]
        if not title:
            continue
        try:
            yr = (w.get("issued", {}).get("date-parts") or [[None]])[0][0]
        except Exception:
            yr = None
        auth = [(a.get("given", "") + " " + a.get("family", "")).strip() for a in (w.get("author") or [])[:4]]
        out.append({"title": title, "year": yr, "venue": (w.get("container-title") or [""])[0],
                    "authors": [a for a in auth if a], "abstract": "",
                    "cites": w.get("is-referenced-by-count"), "source": "CR"})
    return out


def _lit(query, n=5):
    hits, seen, out = (_oa(query, n) or []) + (_crossref(query, max(2, n // 2)) or []), set(), []
    for h in hits:
        k = (h.get("title") or "").lower()[:80]
        if k and k not in seen:
            seen.add(k); out.append(h)
    out.sort(key=lambda h: h.get("cites") or 0, reverse=True)    # Q3: surface high-impact papers first
    return out[:n + 2]


def _fmt_hits(hits):
    if not hits:
        return "NO results for that query. Try a different phrasing."
    lines = []
    for h in hits:
        a = ", ".join(h.get("authors", [])[:3])
        lines.append("- \"%s\" (%s, %s; cites=%s) [%s]\n  %s"
                     % (h.get("title", ""), a, h.get("year"), h.get("cites"),
                        h.get("source", ""), (h.get("abstract") or "")[:320]))
    return "\n".join(lines)


# ---------------------------------------------------------------- research-paradigm sampling (2026-08-28)
# The earlier no-framing-at-all stance produced a monoculture: perception-first ideation drifted into 'inspect
# the data, report an anomaly' and every paper became a negative/audit study. Stage 1 now shows the agent a
# RANDOM SAMPLE of ~10 research framings (paradigms.py; >=4 families, audit capped at ONE slot) purely to widen
# the brainstorm; the agent still picks whatever the data supports, and may go outside the list.


# ---------------------------------------------------------------- stage 1: ideation, as an AGENT
def _idea_tools(ptools):
    tools = [
        {"type": "function", "function": {
            "name": "list_materials",
            "description": "CHEAP overview of the dataset the experiment must run on: item count, fields, "
                           "categorical values, a few SAMPLE records as text, and (if any) how many images "
                           "exist with example file ids. Returns ZERO pixels. Call this FIRST.",
            "parameters": {"type": "object", "properties": {}}}},
        {"type": "function", "function": {
            "name": "search_literature",
            "description": "Real OpenAlex+Crossref search with abstracts. Learn what is ALREADY known (to "
                           "avoid it) and judge novelty. You MUST call this >=1 time before finalizing.",
            "parameters": {"type": "object",
                           "properties": {"query": {"type": "string", "description": "a focused query"}},
                           "required": ["query"]}}},
        {"type": "function", "function": {
            "name": "finalize_idea",
            "description": "Submit the finished proposal as JSON. Only when the gate is met (>=5 self-screened "
                           "candidates, >=1 search done, required fields filled).",
            "parameters": {"type": "object", "properties": {
                "material_type": {"type": "string", "description": "what KIND of data this is (images/tables/curves/time-series/text/...)"},
                "known_landscape": {"type": "string"},
                "candidates": {"type": "array",
                               "description": ">=5 distinct self-screened candidate projects; ONE SHORT line per field",
                               "items": {"type": "object", "properties": {
                                   "angle": {"type": "string"},
                                   "family": {"type": "string", "description": "paradigm FAMILY of this candidate (from the sampled framings, or 'other'); at most ONE candidate may be family 'audit'"},
                                   "novelty_risk": {"type": "string", "description": "low/med/high + why"},
                                   "feasibility": {"type": "string", "description": "fully_computational? testable on THIS data?"}}}},
                "selected": {"type": "string"},
                "paradigm": {"type": "string", "description": "the [family/name] framing from the sampled list that best matches the selected idea (or 'other/<word>')"},
                "research_question": {"type": "string"},
                "hypothesis": {"type": "string"},
                "focus_subset": {"type": "array", "items": {"type": "integer"}},
                "experiment": {"type": "string"},
                "fully_computational": {"type": "boolean", "description": "true IFF runnable END-TO-END on a computer with public/given data, NO wet-lab / physical experiment"},
                "feasibility": {"type": "string", "description": "data availability / statistical power / why no wet-lab is needed"},
                "expected_result": {"type": "string"},
                "what_would_falsify": {"type": "string"},
                "minimal_publishable_claim": {"type": "string", "description": "the smallest claim worth publishing even if the rest fails"},
                "why_nontrivial": {"type": "string"},
                "novelty_evidence": {"type": "string", "description": "what your searches ACTUALLY returned FOR and AGAINST this specific idea (with citations); phrase novelty as 'based on this search, appears under-explored' -- NEVER 'unstudied / first / no prior work'"},
                "what_data_cannot_establish": {"type": "string", "description": "the gap between the observable proxy/association this data DIRECTLY supports and any broader mechanism / real-world-structure / temporal / causal claim it does NOT prove"},
                "effective_sample_estimate": {"type": "string", "description": "from the REAL data counts, the expected number of DECISIVE events for your key test (e.g. expected errors/positives under the likely accuracy); is it adequate? if rare, use continuous signals (margin / entropy / embedding distance) / full data / a lower-capacity model"},
                "leakage_check": {"type": "string", "description": "does any step use ground-truth labels at inference/decision time? label-conditioned selection is ORACLE/upper-bound only and needs a label-agnostic counterpart + its false-positive rate"},
                "visual_audit": {"type": "string", "description": "which item-groups you ACTUALLY viewed; any disagreement between what you SAW and the item's GIVEN label and how you resolved it; do NOT claim visual patterns for groups you did not view"}},
                "required": ["known_landscape", "candidates", "selected", "paradigm",
                             "research_question", "hypothesis", "experiment", "fully_computational",
                             "what_would_falsify", "minimal_publishable_claim",
                             "novelty_evidence", "what_data_cannot_establish",
                             "effective_sample_estimate", "leakage_check"]}}},
    ]
    for pt in (ptools or []):                                 # perception tools for the present modalities
        tools.insert(2, pt)
    if ptools:                                                # visual_audit is required only when perception exists
        for t in tools:
            if t["function"]["name"] == "finalize_idea":
                t["function"]["parameters"]["required"].append("visual_audit")
    return tools


def _idea_exec(task):
    """Build the exec_fn closure (knows the task's materials)."""
    td = task_dir(task)
    held = json.load(open(os.path.join(td, "series.json")))
    members = held.get("members") or []
    data_block = held.get("data")
    by_file = {}
    for m in members:
        if m.get("file"):
            by_file[str(m["file"])] = m
        by_file[str(m.get("idx"))] = m

    def _materials():
        if data_block:
            return ("TABULAR dataset (no images). n_items=%s.\nSummary:\n%s"
                    % (data_block.get("n_items"), str(data_block.get("summary"))[:2500]))
        n = len(members)
        if n == 0:
            return ("NO dataset/images were provided -- this is a topic to study with standard public "
                    "datasets/benchmarks and your own code. Name the concrete dataset(s) and the decisive "
                    "measurement in your experiment protocol. (No look_at_image here.)")
        fields = sorted({k for m in members[:80] for k in m})
        cats = {}
        for f in fields:
            if f in ("idx", "file"):
                continue
            vals = {str(m.get(f)) for m in members if f in m}
            if 2 <= len(vals) <= 12:
                cats[f] = sorted(vals)
        sample = [{k: v for k, v in m.items() if k != "file"} for m in members[:3]]
        return json.dumps({"n_items": n, "fields": fields, "categorical_fields": cats,
                           "sample_records": sample, "n_images": n,
                           "example_file_ids": [str(m.get("idx")) for m in members[:6]],
                           "note": "Use look_at_image with these ids for a FEW images; you need not view all."},
                          ensure_ascii=False)[:3000]

    def _look(args, state, log):
        if state["img_used"] >= state["img_budget"]:
            return ("IMAGE BUDGET EXHAUSTED (looked at %d, the cap). Do NOT request more; decide from what "
                    "you have seen." % state["img_used"])
        files = args.get("files") or []
        if isinstance(files, str):
            files = [files]
        files, q, out = files[:4], args.get("question") or "What is scientifically notable here?", []
        for fid in files:
            if state["img_used"] >= state["img_budget"]:
                out.append("(budget reached; stopped)"); break
            m = by_file.get(str(fid))
            path = os.path.join(td, m["file"]) if m else os.path.join(td, str(fid))
            if not os.path.exists(path):
                out.append("%s: NOT FOUND" % fid); continue
            try:
                ans = pipeline.chat([{"type": "text", "text": q}, img_block(path)], VISION, 1600)
            except Exception as e:
                _perception_fail("look_at_image", e)
            state["img_used"] += 1
            out.append("%s: %s" % (fid, (ans or "").strip()[:600]))
        log("  [tool] look_at_image x%d (img_used=%d/%d)" % (len(files), state["img_used"], state["img_budget"]))
        return "\n".join(out)

    def exec_fn(name, args, state, log):
        if name == "list_materials":
            log("  [tool] list_materials"); return _materials()
        if name == "search_literature":
            if state["searched"] >= state.get("search_budget", 6):    # hard cap -> force convergence
                log("  [tool] search_literature REFUSED (budget %d reached)" % state["searched"])
                return ("SEARCH BUDGET EXHAUSTED (%d searches, the cap). Do NOT search again. Brainstorm "
                        "from what you already have and call finalize_idea now." % state["searched"])
            q = args.get("query", ""); hits = _lit(q, 3); state["searched"] += 1   # top-3 high-cite, fewer tokens
            log("  [tool] search_literature(%r) -> %d hits  [%d/%d]"
                % (q[:60], len(hits), state["searched"], state.get("search_budget", 6)))
            return _fmt_hits(hits)
        if name == "finalize_idea":
            state["final"] = args; return "received; checking the exit gate."
        try:
            r = evidence.run(name, args, state, log, td, by_file)   # image/table/signal/audio/video/3d/text
        except Exception as e:
            if name.startswith(("look_at_", "analyze_")):
                _perception_fail(name, e)
            raise
        if r is not None:
            return r
        return "unknown tool: %s" % name

    return exec_fn, held, members, data_block


def _idea_done(final, state):
    """Deterministic exit gate: structure + real-search grounding (NOT a quality downgrade). Vision is NOT
    gated here on purpose: if the task genuinely needs images the agent looks on its own (guarantee comes
    from task design, not enforcement) -- forcing a look would be multimodality for its own sake."""
    if final.get("_failed"):
        return False, "marked failed"
    miss = [k for k in ("research_question", "hypothesis", "experiment", "what_would_falsify")
            if not str(final.get(k, "")).strip()]
    if miss:
        return False, "required fields empty: " + ", ".join(miss)
    cands = final.get("candidates")
    if not isinstance(cands, list) or len(cands) < 5:
        return False, "need >=5 self-screened candidates (have %s)" % (len(cands) if isinstance(cands, list) else 0)
    # --- paradigm spread (2026-08-28): the brainstorm must not be an audit monoculture ---
    fams = [str(c.get("family", "")).strip().lower() for c in cands if isinstance(c, dict)]
    if sum(1 for f in fams if f == "audit") > 1:
        return False, ("at most ONE candidate may be an audit/error-finding study (family 'audit'); you have %d -- "
                       "replace the extras with candidates from other families (method / empirical_law / mechanism / "
                       "prediction / measurement / ...)" % sum(1 for f in fams if f == "audit"))
    if len({f for f in fams if f}) < 3:
        return False, ("tag every candidate with its paradigm 'family' and make the set span at least 3 DIFFERENT "
                       "families from the sampled framings -- a one-groove brainstorm is not a brainstorm")
    if not str(final.get("paradigm", "")).strip():
        return False, "set 'paradigm' to the [family/name] framing that best matches the selected idea (or 'other/<word>')"
    if paradigms.family_of(str(final.get("paradigm", "")).split("/")[-1]) == "audit" and \
            str(final.get("paradigm", "")).split("/")[0].strip().lower() != "audit":
        return False, "paradigm family/name mismatch -- use the exact [family/name] pair from the sampled list"
    if state.get("searched", 0) < 3 and not os.environ.get("MMSCI_NO_PRIORART"):   # ablation: -prior-art search
        return False, ("run at least 3 focused literature searches (including one aimed at your SELECTED idea "
                       "specifically) before finalizing -- you have %d" % state.get("searched", 0))
    if not str(final.get("selected", "")).strip():
        return False, "selected is empty"
    fc = final.get("fully_computational")
    if not (fc is True or str(fc).strip().lower() in ("true", "yes")):   # HARD GATE: no wet-lab ideas
        return False, ("the selected idea must be fully_computational (runnable end-to-end on a computer, NO "
                       "wet-lab / physical experiment). If nothing computational qualifies, brainstorm a "
                       "DIFFERENT angle and finalize that instead.")
    if not str(final.get("minimal_publishable_claim", "")).strip():
        return False, "state the minimal_publishable_claim (smallest claim worth publishing even if the rest fails)"
    # --- grounding gates: force the agent to reconcile evidence with the claim (all domain-general) ---
    for k, why in (("novelty_evidence", "summarize what the search returned FOR/AGAINST this specific idea + citations"),
                   ("what_data_cannot_establish", "state the gap between the observable proxy this data supports and any broader mechanism/real-world/causal claim"),
                   ("effective_sample_estimate", "estimate, from the REAL data counts, the decisive-event count for your key test and whether it is adequate"),
                   ("leakage_check", "state whether any step uses ground-truth labels at inference/decision time and how you avoid leakage")):
        if not str(final.get(k, "")).strip():
            return False, "fill '%s': %s" % (k, why)
    if state.get("img_used", 0) > 0 and not str(final.get("visual_audit", "")).strip():
        return False, ("you looked at images -- fill 'visual_audit': which groups you viewed + any visual-vs-label "
                       "disagreement and how you resolved it")
    _absolute = ("unstudied", "has not been studied", "have not been studied", "has never been",
                 "no prior work", "no existing work", "first to ", "never been explored", "not been explored")
    _blob = " ".join(str(final.get(k, "")) for k in
                     ("research_question", "hypothesis", "minimal_publishable_claim", "why_nontrivial",
                      "novelty_evidence", "known_landscape")).lower()
    _hit = [b for b in _absolute if b in _blob]
    if _hit and not os.environ.get("MMSCI_NO_NOVELTY_GATE"):   # ablation: -novelty gate
        return False, ("recalibrate novelty language: remove absolute-novelty phrasing %s and replace with "
                       "'based on this search, appears under-explored' -- a bounded search cannot support "
                       "'unstudied / first / no prior work'." % _hit)
    return True, ""


def stage1_ideation(task):
    """Agentic ideation: a tool-using agent (search literature + optionally peek at a few images) proposes ONE
    novel, feasible, falsifiable idea, gated on structure + real-search grounding."""
    exec_fn, held, members, data_block = _idea_exec(task)
    modalities = (evidence.detect_modalities(members)                 # which perception tools this task unlocks
                  if (members and not data_block and not os.environ.get("MMSCI_NO_VISION")) else set())  # MMSCI_NO_VISION = ablation
    ptools = evidence.tool_schemas(modalities)
    pnames = [t["function"]["name"] for t in ptools]
    has_perc = bool(pnames)
    has_images = "image" in modalities
    role = held.get("role", "an experienced researcher")
    subject, prop = held.get("subject", "item"), held.get("property", "a measured property")
    request = (held.get("request") or held.get("direction") or
               "Produce a research paper about %ss and their %s." % (subject, prop)).strip()
    hints = str(held.get("idea_hints") or "")      # from the case's series.json only; never a hardcoded domain hint
    ap = os.path.join(stages_dir(task), "_avoid.json")          # ideas the pipeline already tried & found infeasible
    avoid = json.load(open(ap)) if os.path.exists(ap) else []
    # fresh paradigm sample per attempt (seeded by task + attempt count -> reproducible, but re-rolls on backtrack)
    psample = paradigms.sample(10, seed=zlib.crc32(task.encode()) + 977 * len(avoid))

    system = (
        "You are " + role + ", proposing a research idea for a HIGH-QUALITY, publishable paper -- a normal full "
        "paper for the field (NOT a toy, a demo, or a 'short note'; ignore any 'short paper' wording in the "
        "request and aim for full quality). Work like a scientist who already knows the field and refuses to "
        "waste effort on the obvious, the untestable, or the impossible-to-run.\n\n"
        "TOOLS: list_materials (cheap, zero-pixel overview of the data the experiment must run on); "
        "search_literature (real OpenAlex/Crossref, to learn what is known and judge novelty)"
        + (("; PERCEPTION tools -- " + ", ".join(pnames) + " -- to inspect specific items (analyze_* give NATIVE "
            "numeric/text features in the modality's own form; look_at_* render the signal so you see its "
            "gestalt -- a picture is ONE channel, not the only one; run_python does deep custom analysis)") if has_perc else "")
        + "; finalize_idea (submit).\n\n"
        "PROCESS (keeps the idea non-trivial, novel, AND actually runnable -- do not skip it):\n"
        "1. INSPECT THE MATERIALS: list_materials"
        + ((" (and use the perception tools -- " + ", ".join(pnames) + " -- on a few representative items)") if has_perc else "")
        + " to identify WHAT KIND of data this is (images / tables / curves / time-series / text / code ...) "
        "and what is actually in it.\n"
        "2. KNOWN LANDSCAPE: a SMALL number of FOCUSED literature searches (about 3-6) to establish what is "
        "already well-established, so you deliberately AVOID it.\n"
        "3. FIND THE QUESTION: from what the materials actually contain, decide the most concrete, novel, "
        "testable question this data can genuinely support. Do NOT force a question the data cannot sustain.\n\n"
        "4. BRAINSTORM >=5 candidate research projects. "
        + ("Use what you OBSERVED in the materials (via the perception tools) to GENERATE candidates from "
           "concrete patterns, not literature alone. " if has_perc else "")
        + "Self-screen EACH on novelty_risk (already published / obvious? low/med/high+why).\n"
        "5. FEASIBILITY (be brutally honest -- this is a HARD GATE): rate each candidate fully_computational -- "
        "can it be carried out END-TO-END on a computer using public or the given data, with NO wet-lab / "
        "physical experiment? (studies of a COMPUTATIONAL system like an ML model or agent are fine; a study "
        "that needs physical cells/materials/organisms is NOT). Also note falsifiable and "
        "statistical_power at this sample size. COMPUTE BUDGET: design the experiment to complete in about "
        "20 minutes on a single machine (each code run is capped at ~150s) -- if the natural design is a huge "
        "grid, pre-shrink it (fewer levels, subsampled rows, fewer replicates) so the CORE claim still gets "
        "decisive numbers; scale is a limitation to note, not a reason to overrun.\n"
        "6. SELECT the ONE candidate that is GENUINELY NOVEL and fully_computational=YES -- the goal is NOVEL "
        "AND feasible, NOT the safest/most-standard option; also falsifiable, and 'valuable even if it fails'"
        + (", preferring one whose core hypothesis was inspired by inspecting the materials rather than "
           "literature alone" if has_perc else "")
        + ". If NONE is fully_computational, brainstorm a different angle -- NEVER propose something "
        "that needs a wet-lab.\n"
        "7. Develop the selected candidate into a full, falsifiable, dry-computational proposal and call "
        "finalize_idea (with its feasibility, fully_computational, and minimal_publishable_claim).\n\n"
        "GROUNDING RULES (a proposal that violates these is NOT ready -- the exit gate enforces them):\n"
        "- VISION: when you look at an item you are ALSO shown its GIVEN label; RECONCILE your read with it. If "
        "they disagree, do NOT proceed on your read -- flag it, re-check the id/label, lower confidence. Never "
        "name a class outside the given label space, and never characterize a group you did not view. Record "
        "this in visual_audit.\n"
        "- NOVELTY: run >=3 focused searches incl. one aimed at your SELECTED idea specifically; phrase novelty "
        "as 'based on this search, appears under-explored' -- NEVER 'unstudied / first / no prior work'. Record "
        "what the search returned in novelty_evidence.\n"
        "- CLAIM SCOPE: separate what the data DIRECTLY shows (a measured quantity / an association among "
        "measured variables) from a broader mechanism / real-world-structure / temporal / causal claim it "
        "cannot prove; keep the research_question and minimal_publishable_claim on the supported side (put the "
        "stronger reading in future work). Record the gap in what_data_cannot_establish.\n"
        "- STAT POWER: estimate from the REAL data counts how many DECISIVE events your key test needs; if they "
        "will be rare (e.g. few errors under a high-accuracy model), use CONTINUOUS signals (margin / entropy / "
        "embedding distance / calibration) or the full dataset or a lower-capacity model -- do not rely on a "
        "handful of hard events. Record this in effective_sample_estimate.\n"
        "- NO LEAKAGE: no step may use ground-truth labels at inference/decision time; any label-conditioned "
        "selection is oracle/upper-bound only and needs a label-agnostic counterpart + its false-positive rate. "
        "Record this in leakage_check.\n\n"
        "Write purely as " + role + " (the paper is ABOUT the science, never about AI / tools / which modality "
        "you used). Use tools when they genuinely help; never invent results or citations.\n\n"
        + paradigms.render(psample))
    avoid_txt = (("\n\nAVOID these previously-tried ideas (they turned out infeasible/null on this data -- "
                  "propose something genuinely DIFFERENT):\n" + "\n".join("- " + str(a)[:300] for a in avoid))
                 if avoid else "")
    task_msg = ("The researcher's request:\n\"" + request[:1200] + "\"" + avoid_txt + "\n\nProduce the proposal "
                "now, starting by calling list_materials.")

    # adaptive image budget: enough to view >=1 of each class/group -- derived from the data, never hardcoded
    n_groups = 1
    for f in ({k for m in members[:300] for k in m} - {"idx", "file"}):
        vals = {str(m.get(f)) for m in members if f in m}
        if 2 <= len(vals) <= 40:
            n_groups = max(n_groups, len(vals))
    img_budget = min(24, max(8, 2 * n_groups))

    obj = agent_loop(system, task_msg, _idea_tools(ptools), exec_fn, BRAIN, _idea_done,
                     max_steps=24, image_budget=img_budget, search_budget=8, max_tokens=8000, log=print,
                     trace_path=os.path.join(stages_dir(task), "01_trace.json"))

    n = (data_block.get("n_items") if data_block else len(members)) or 0
    md = ["# Stage 1 -- Ideation (AGENTIC: tool-using, real-search-grounded)", "",
          "_task: %s | %s %ss | property: %s | brain: %s_" % (task, n, subject, prop, BRAIN), ""]
    if obj.get("_failed"):
        md += ["**STAGE 1 FAILED -- " + str(obj.get("reason", "")) + "**"]
    else:
        md += ["_tool trace: %s_" % ", ".join(t["tool"] for t in obj.get("_trace", [])), ""]
        for k in ("material_type", "known_landscape", "candidates", "selected", "paradigm",
                  "research_question", "hypothesis", "focus_subset", "experiment", "fully_computational",
                  "feasibility", "effective_sample_estimate", "expected_result", "what_would_falsify",
                  "what_data_cannot_establish", "leakage_check", "novelty_evidence", "visual_audit",
                  "minimal_publishable_claim", "why_nontrivial"):
            v = obj.get(k)
            if v is None or v == "" or v == []:
                continue
            if k == "candidates" and isinstance(v, list):
                md += ["## Candidates (brainstorm + self-screen)"]
                for i, c in enumerate(v):
                    md += (["- **%d. %s** [%s] -- novelty_risk: %s; feasibility: %s"
                            % (i, c.get("angle", ""), c.get("family", "?"), c.get("novelty_risk", ""),
                               c.get("feasibility", ""))] if isinstance(c, dict) else ["- " + str(c)])
                md += [""]
            else:
                md += ["## " + k.replace("_", " ").title(), str(v).strip(), ""]
    _write(task, "01_ideation", obj, "\n".join(md))
    return obj


# ---------------------------------------------------------------- shared vision tool (used by >1 stage)
def _do_look(td, by_file, args, state, log):
    state.setdefault("img_used", 0); state.setdefault("img_budget", 8)
    if state["img_used"] >= state["img_budget"]:
        return "IMAGE BUDGET EXHAUSTED (%d). Decide from what you have already seen." % state["img_used"]
    files = args.get("files") or []
    if isinstance(files, str):
        files = [files]
    files, q, out = files[:4], args.get("question") or "What is scientifically notable here?", []
    for fid in files:
        if state["img_used"] >= state["img_budget"]:
            out.append("(budget reached; stopped)"); break
        m = by_file.get(str(fid))
        path = os.path.join(td, m["file"]) if m else os.path.join(td, str(fid))
        if not os.path.exists(path):
            out.append("%s: NOT FOUND" % fid); continue
        try:
            ans = pipeline.chat([{"type": "text", "text": q}, img_block(path)], VISION, 1600)
        except Exception as e:
            _perception_fail("look_at_image", e)
        state["img_used"] += 1
        out.append("%s: %s" % (fid, (ans or "").strip()[:600]))
    log("  [tool] look_at_image x%d (img_used=%d/%d)" % (len(files), state["img_used"], state["img_budget"]))
    return "\n".join(out)


# ---------------------------------------------------------------- stage 2: experiment = methods + execution
def _run_python(code, cwd, timeout=150):
    """Execute agent-written Python in the data dir, capture stdout/stderr. This is the COMPUTATION leg."""
    try:
        p = subprocess.run([sys.executable, "-c", code], cwd=cwd, capture_output=True, text=True, timeout=timeout)
        return p.returncode, (p.stdout or "")[-4000:], (p.stderr or "")[-1500:]
    except subprocess.TimeoutExpired:
        return -1, "", "TIMEOUT after %ds (your code ran too long -- make it cheaper)" % timeout
    except Exception as e:
        return -1, "", "runner error: %s" % e


def _exp_tools(ptools):
    tools = [
        {"type": "function", "function": {
            "name": "inspect_data",
            "description": "CHEAP overview of the dataset your code must run on (item count, fields, label "
                           "values, sample records, file-path pattern). The data dir is your code's CWD and "
                           "series.json there holds the full 'members' list. ZERO pixels.",
            "parameters": {"type": "object", "properties": {}}}},
        {"type": "function", "function": {
            "name": "run_python",
            "description": "Run Python in the data dir (CWD = the task's example dir) and get stdout+stderr. "
                           "LOAD the real data (json.load('series.json') -> members -> image files / fields); "
                           "compute the decisive numbers and PRINT them as 'name = value'. Iterate: if a result "
                           "is weak or the code errors, revise and rerun.",
            "parameters": {"type": "object",
                           "properties": {"code": {"type": "string", "description": "a complete Python script"}},
                           "required": ["code"]}}},
        {"type": "function", "function": {
            "name": "finalize_results",
            "description": "Submit results. Only after run_python actually produced the numbers. NEVER invent "
                           "numbers. If the data cannot support the test, set verdict='infeasible' honestly.",
            "parameters": {"type": "object", "properties": {
                "method_summary": {"type": "string", "description": "the concrete method, written to be REPRODUCIBLE: dataset composition (total n and per-class / per-group counts), preprocessing and normalization (state that any scaler is fit on train only), the EXACT model/classifier (name it, e.g. logistic regression / random forest), the evaluation protocol (random vs group-disjoint split, number of folds, stratification), and the statistical tests + multiple-comparison correction + the bootstrap/resampling unit"},
                "key_numbers": {"type": "object", "description": "name -> value, the decisive numbers your code PRINTED"},
                "what_was_tested": {"type": "string"},
                "stat_tests": {"type": "string", "description": "the TOTAL number of statistical tests you ACTUALLY ran (count them all, not a pre-planned number), the multiple-comparison correction applied to THAT count (Bonferroni/FDR), and which results survive it"},
                "independence_check": {"type": "string", "description": "is your predictor derived from the SAME model/representation whose behaviour you predict? if yes the correlation may be CIRCULAR -- use an INDEPENDENT predictor (different/frozen model, hand features) or SCOPE the claim to 'within this representation'"},
                "verdict": {"type": "string", "description": "supported / refuted / mixed / null / infeasible"},
                "result_statement": {"type": "string", "description": "one-paragraph plain result, HEADLINE first (the strongest supported finding); numbers grounded; weak sub-results (few events) labelled 'suggestive', not confirmed"},
                "analyses": {"type": "array", "description": "ONE entry per analysis in your battery (main, baseline, ablation, mechanism, breakdown, sensitivity...). Aim for >=5 -- this is a FULL study, not one test.", "items": {"type": "object", "properties": {"name": {"type": "string", "description": "e.g. main / baseline / ablation:X / mechanism / breakdown:by-subgroup / sensitivity:threshold"}, "finding": {"type": "string", "description": "one-line result of THIS analysis"}, "numbers": {"type": "string", "description": "its decisive numbers (name=value) from run_python output"}}}},
                "figures": {"type": "array", "description": "figures you saved (fig_*.png in CWD): the LEAD's figure FIRST, and OMIT the figures of any demoted analysis", "items": {"type": "object", "properties": {"file": {"type": "string"}, "caption": {"type": "string"}, "analysis": {"type": "string", "description": "the exact 'analyses' name this figure belongs to (so demoted figures can be dropped precisely)"}}}},
                "lead": {"type": "string", "description": "the EXACT name (from 'analyses', which must be ordered with it first) of the SINGLE strongest supported analysis = the paper's headline"},
                "demoted": {"type": "array", "description": "EXACT names (from 'analyses') of analyses that failed or were too weak to be a finding (e.g. a failed pre-registered PRIMARY). EXCLUDED from the paper; they live only in the trace. Use [] if none.", "items": {"type": "string"}}},
                "required": ["method_summary", "verdict", "result_statement", "stat_tests", "independence_check", "analyses", "lead", "demoted"]}}},
    ]
    for pt in (ptools or []):                                 # perception tools for the present modalities
        tools.insert(2, pt)
    return tools


def _exp_exec(task):
    td = task_dir(task)
    held = json.load(open(os.path.join(td, "series.json")))
    members = held.get("members") or []
    data_block = held.get("data")
    by_file = {}
    for m in members:
        if m.get("file"):
            by_file[str(m["file"])] = m
        by_file[str(m.get("idx"))] = m

    def _overview():
        if data_block:
            return "TABULAR. n=%s. series.json in CWD has the data block.\n%s" % (
                data_block.get("n_items"), str(data_block.get("summary"))[:2000])
        n = len(members)
        fields = sorted({k for m in members[:80] for k in m})
        cats = {f: sorted({str(m.get(f)) for m in members if f in m})
                for f in fields if f not in ("idx", "file") and 2 <= len({str(m.get(f)) for m in members if f in m}) <= 12}
        return json.dumps({"n_items": n, "fields": fields, "categorical_fields": cats,
                           "sample_records": members[:3],
                           "note": "CWD = data dir; json.load('series.json')['members'] has every item's file + labels."},
                          ensure_ascii=False)[:3000]

    def exec_fn(name, args, state, log):
        if name == "inspect_data":
            log("  [tool] inspect_data"); return _overview()
        if name == "run_python":
            state["runs_used"] = state.get("runs_used", 0) + 1
            # convergence budget 40, plus a WRAP-UP RESERVE of 6 once a finalize has been rejected: the exit gate asks
            # for make_figs.py and vector twins, both of which need code, and gwosc_gw deadlocked between 'finalize
            # REJECTED' and 'run_python REFUSED' for 20 steps with 32 good analyses on disk and nothing delivered.
            _cap = 40 + (6 if state.get("_rejects", 0) else 0)
            if state["runs_used"] > _cap:                  # (flash: 59 runs, zero finalize tries -> the cap exists)
                log("  [tool] run_python REFUSED (run budget %d reached)" % _cap)
                return ("RUN BUDGET EXHAUSTED (%d real runs, the cap). Do NOT run more code. Consolidate the "
                        "numbers your runs already printed and call finalize_results NOW -- order analyses "
                        "lead-first, list your saved figures, and report only printed numbers." % _cap)
            _left = _cap - state["runs_used"]
            _wrap = ""
            if state.get("_rejects", 0) and state["runs_used"] > 40:
                _wrap = ("\n\nWRAP-UP RESERVE: %d run(s) left, for make_figs.py and regenerating figures through "
                         "figtools.new()/figtools.save() ONLY; then call finalize_results." % _left)
            elif _left in (8, 4):
                _wrap = ("\n\nNOTE: %d runs left in your budget. Before it ends, write make_figs.py (self-contained, imports "
                         "figtools, regenerates EVERY figure) and make sure each figure was saved with figtools.save() so it "
                         "has a vector .pdf twin -- the exit gate requires both and a finalize without them is rejected." % _left)
            code = args.get("code", "")
            state.setdefault("codes", []).append(code)
            this_loaded = bool(re.search(r"series\.json|Image\.open|cv2\.imread|plt\.imread|np\.load|np\.loadtxt|"
                                         r"glob\.|os\.listdir|\.png|\.jpg|\.csv|open\(", code))
            if this_loaded:
                state["loaded_data"] = True                      # anti-fab: did it ever touch the REAL data?
            rc, out, err = _run_python(code, td)
            if rc == 0 and out.strip():
                state["good_runs"] = state.get("good_runs", 0) + 1
                state["stdout_all"] = (state.get("stdout_all", "") + "\n" + out)[-60000:]   # keep a full battery's outputs so the anti-fab number check (union of real runs) does not lose early analyses
                if this_loaded:                                  # stdout of the most recent SELF-CONTAINED run (loads data itself)
                    state["selfcontained_stdout"] = out
            log("  [tool] run_python rc=%s out=%dch loaded_real_data=%s good_runs=%d"
                % (rc, len(out), state.get("loaded_data", False), state.get("good_runs", 0)))
            return ("EXIT=%s\n--- stdout ---\n%s\n--- stderr ---\n%s" % (rc, out or "(empty)", err or "(none)"))[:5000] + _wrap
        if name == "finalize_results":
            state["final"] = args; return "received; checking the exit gate."
        try:
            r = evidence.run(name, args, state, log, td, by_file)   # image/table/signal/audio/video/3d/text
        except Exception as e:
            if name.startswith(("look_at_", "analyze_")):
                _perception_fail(name, e)
            raise
        if r is not None:
            if name.startswith(("look_at_", "analyze_", "read_")):
                state["perc_used"] = state.get("perc_used", 0) + 1   # ANY perception counts for the look-gate:
            return r                                                 # look_at_table does NOT bump img_used (that
        return "unknown tool: %s" % name                             # counter is pixel-renders only), so a tabular
                                                                     # task could never satisfy an img_used gate
    return exec_fn, held, members, data_block


def _num_tokens(s):
    # (?:\.\d+)? : a decimal part only when digits follow the dot, so '...of 10.' yields '10', not '10.' -- the strict
    # polish guard compared '10' with '10.' and reverted a section over a sentence-final period (2026-09-01)
    return [t for t in re.findall(r"-?\d+(?:\.\d+)?", s or "") if len(t.replace("-", "").replace(".", "")) >= 2]


def _num_grounded(x, gfloats):
    """A thesis number is 'grounded' if it matches some REAL result number, tolerant of percent<->fraction (21.7 vs
    0.217) and rounding -- so the anti-fabrication check does not falsely reject a legitimate figure that the model
    merely expressed in different units (which was forcing the positive-narrative planner into needless fallback)."""
    try:
        xv = float(x)
    except Exception:
        return True
    for g in gfloats:
        for cand in (g, g * 100.0, g / 100.0):
            if abs(xv - cand) <= max(0.02, abs(cand) * 0.02):
                return True
    return False


def _pvalues(s):
    """Extract p-values (scientific-notation SAFE: 'p=1.8e-11', 'p<0.001', 'p equals 0.72') from a free-text numbers
    string. Used to gate the LEAD's own significance and to derive thesis-core eligibility from REAL numbers."""
    out = []
    for pv in re.findall(r"(?i)\bp[\s_-]*(?:value|val)?\s*(?:=|==|equals|is|<|<=|>|>=|:)?\s*"
                         r"([0-9]*\.?[0-9]+(?:[eE][-+]?[0-9]+)?)", s or ""):
        try:
            out.append(float(pv))
        except Exception:
            pass
    return out


def _exp_done(final, state):
    """Exit gate = the anti-fabrication / real-compute guard (re-homed from staged's _fabricated). The agent
    cannot leave this stage with results that did not come from a real run."""
    if final.get("_failed"):
        return False, "marked failed"
    verdict = str(final.get("verdict", "")).strip().lower()
    if not verdict:
        return False, "verdict empty (supported/refuted/mixed/null/infeasible)"
    if state.get("good_runs", 0) < 1:
        return False, "you must run real code with run_python successfully (exit 0, real output) before finalizing"
    # perception gate: if this task has a real observation to SEE, a positive finalize must have actually looked at it.
    # (a weak backbone otherwise skips look_at_* entirely and writes from numbers alone -> the multimodal leg is dead.)
    if (state.get("img_budget", 0) > 0 and state.get("img_used", 0) + state.get("perc_used", 0) == 0
            and verdict not in ("infeasible", "insufficient", "null", "insufficient_data")):
        return False, ("this task carries a real observation you can SEE (look_at_*/analyze_* budget %d) but you "
                       "finalized without inspecting ANY of it -- inspect the actual data with a perception tool "
                       "at least once and reconcile your experiment with what you observed, don't work from "
                       "numbers alone" % state.get("img_budget", 0))
    if verdict in ("infeasible", "insufficient", "null", "insufficient_data"):
        return True, ""                                          # honest negative -> exits; outer route may backtrack
    if not final.get("key_numbers"):
        return False, "key_numbers is empty -- report the decisive numbers your code printed"
    _antifab = not os.environ.get("MMSCI_NO_ANTIFAB")            # ablation: -anti-fabrication gate
    nums = _num_tokens(json.dumps(final.get("key_numbers")))     # anti-fab 1: numbers must trace to real stdout
    if _antifab and nums and not any(n in state.get("stdout_all", "") for n in nums):
        return False, ("NONE of your reported numbers appear in any run_python output -- report numbers your "
                       "code actually printed, never invent them (or set verdict='infeasible')")
    if _antifab and not state.get("loaded_data"):               # anti-fab 2: must have touched the REAL data
        return False, ("no run_python ever LOADED the real data (series.json / the image files) -- you cannot "
                       "produce results by hand-coding/inventing rows; load the real data and recompute")
    # --- anti-fab reproducibility: >=60% of reported numbers must appear in the UNION of the agent's REAL
    #     run_python outputs. A thorough multi-analysis battery legitimately computes its numbers across several
    #     runs, so we do NOT force them all into ONE self-contained run (that over-tightening bounced valid heavy
    #     batteries into max_steps); but every reported number must still be REAL code output, never invented. ---
    sc = state.get("stdout_all", "")
    if _antifab and nums and len([n for n in nums if n in sc]) < 0.6 * len(nums):
        return False, ("REPRODUCIBILITY: most reported numbers do NOT appear in any of your run_python outputs. "
                       "Report only numbers your code actually printed (each analysis's decisive numbers must have "
                       "been printed by a real run); never paste approximate or invented numbers.")
    # --- batch-3 P2: if >=2 p-values are reported, force honest multiple-comparison accounting ---
    _pvals = [k for k in (final.get("key_numbers") or {}) if re.search(r"(?i)(^p_|_p$|^pval|^p$)", str(k))]
    if len(_pvals) >= 2 and not str(final.get("stat_tests", "")).strip():
        return False, ("you reported %d p-values -- fill 'stat_tests': COUNT every test you actually ran, apply "
                       "the multiple-comparison correction to THAT count, and state which survive it" % len(_pvals))
    # --- batch-3 P3: predictor/outcome circularity must be addressed ---
    if not str(final.get("independence_check", "")).strip():
        return False, ("fill 'independence_check': is your predictor derived from the same model whose behaviour "
                       "you predict? if yes, use an independent predictor or scope the claim to 'within this "
                       "representation'")
    # --- full-study gate: a real finding must be a THOROUGH battery, not a single test ---
    analyses = final.get("analyses") or []
    if len(analyses) < 4:
        return False, ("this must be a THOROUGH study (a full research-article experiment section), not one test: "
                       "run the battery -- main + baseline + ablation + mechanism + breakdown + sensitivity -- and "
                       "list EACH in 'analyses' with a saved fig_*.png; you listed %d, need >=4" % len(analyses))
    names = [str(a.get("name", "")).strip() for a in analyses]
    nameset = set(names)
    demoted = [str(d).strip() for d in (final.get("demoted", []) or [])]
    lead = str(final.get("lead", "")).strip()
    sc = state.get("stdout_all", "")
    # --- reframe/HARKing guard: the LEAD must be a REAL, SUPPORTED, first-listed analysis (no relabelling noise) ---
    if not lead:
        return False, ("set 'lead' to the name of your single strongest SUPPORTED analysis (the paper's headline); "
                       "order 'analyses' with it first and demote any failed/weak analysis into 'demoted'")
    if lead not in nameset:
        return False, ("'lead' (%r) must be the EXACT name of one of your 'analyses'; your names are: %s" % (lead, names))
    if lead in set(demoted):
        return False, "'lead' cannot also be in 'demoted' -- the lead is your strongest SUPPORTED finding, not a failed one"
    bad = [d for d in demoted if d not in nameset]
    if bad:
        return False, "every 'demoted' entry must be an EXACT 'analyses' name; unknown: %s" % bad
    if names and names[0] != lead:
        return False, "order 'analyses' LEAD-first: analyses[0] is %r but lead is %r" % (names[0], lead)
    # anti-fab, extended to the paper-facing fields the reframe leads with (not just key_numbers) --
    lead_a = next((a for a in analyses if str(a.get("name", "")).strip() == lead), {})
    lnums = _num_tokens(str(lead_a.get("numbers", "")))
    if lnums and not any(n in sc for n in lnums):
        return False, "the LEAD analysis's decisive numbers do not appear in any run_python output -- report numbers your code printed"
    # the LEAD is the paper's headline (stage 3's positive-narrative planner leads with it), so it must itself be
    # statistically SUPPORTED, not merely un-demoted. If the lead reports p-values and NONE is significant, block it:
    # a null/weak result must not become the headline (this is the deterministic tooth that makes "lead == supported"
    # actually TRUE, which the stage-3 thesis validator relies on). No p-value reported -> cannot check here -> allow.
    lpv = _pvalues(str(lead_a.get("numbers", "")))
    _verdict = str(final.get("verdict", "")).strip().lower()
    if lpv and min(lpv) >= 0.05 and _verdict not in ("null", "insufficient", "infeasible"):   # a null/insufficient/infeasible verdict IS ALLOWED a non-significant lead -- that is the honest finding. Only a POSITIVE-claim paper must lead with significance. Without this exemption the gate contradicts itself (tells the agent to set verdict='null' but then still rejects the same non-significant lead), and a weak backbone that cannot find a significant lead loops here to max_steps re-running experiments instead of taking the offered null exit.
        return False, ("the LEAD analysis %r is NOT statistically supported (all its p-values are >= 0.05, min p=%.3g); "
                       "the paper cannot lead with a null result -- choose a lead whose primary effect is significant, "
                       "strengthen it, or set verdict='null'/'insufficient'" % (lead, min(lpv)))
    rsnums = _num_tokens(str(final.get("result_statement", "")))
    if rsnums and len([n for n in rsnums if n in sc]) < 0.5 * len(rsnums):
        return False, ("most numbers in 'result_statement' are not in any run_python output -- the headline must be "
                       "grounded in real output, not written from memory")
    # a clearly non-significant analysis that is NOT the lead must be demoted (kept out of the paper), not shown as a finding --
    for a in analyses:
        nm = str(a.get("name", "")).strip()
        if nm == lead or nm in set(demoted):
            continue
        for pv in re.findall(r"(?i)\bp\s*(?:=|equals|<|>|:)?\s*(\d*\.\d+)", str(a.get("numbers", ""))):
            try:
                if float(pv) >= 0.05:
                    return False, ("analysis %r is non-significant (p=%s) but not demoted; if it does not support the "
                                   "finding put it in 'demoted' so it stays out of the paper (only in the trace)" % (nm, pv))
            except Exception:
                pass
    # multiple-comparison honesty: correct over EVERY test you ran (demoting must NOT shrink the denominator) --
    if _pvals:
        ran = len(analyses) + len(demoted)
        claimed = [int(x) for x in re.findall(r"\d+", str(final.get("stat_tests", ""))) if int(x) < 1000]
        if claimed and max(claimed) < ran:
            return False, ("'stat_tests': you ran at least %d analyses (including demoted) but your stated correction "
                           "count is only %d -- correct over EVERY test you ran, not just the ones shown" % (ran, max(claimed)))
    return True, ""


# Stage 2 uses GENERIC rigorous-experiment guidance (controls / baselines / proper statistics); it does NOT key
# off a per-mode method shape. The agent designs the method to fit the idea it produced in stage 1. This keeps
# the engine general and leaves no discovery-mode taxonomy in the code.

# Printed geometry per venue style: (column width in, full text width in, body pt). Derived from the
# venue_styles preambles (letterpaper minus margins; two-column splits at ~0.14in columnsep).
_VENUE_GEOM = {"cs_ml": (5.5, 5.5, 10.0), "biomed": (6.5, 6.5, 11.0),
               "earth_space": (3.43, 7.0, 10.0), "physics": (3.48, 7.1, 10.0), "chem": (3.43, 7.0, 10.0)}


def _deploy_figtools(task, held):
    """Drop figtools.py + the venue's printed geometry (figconfig.json) into the task dir, so stage-2 code can
    `import figtools` and every figure is born at its final printed width. Returns the geometry used."""
    import shutil as _sh
    import paper_specs as _ps
    td = task_dir(task)
    _sh.copy(os.path.join(HERE, "figtools.py"), os.path.join(td, "figtools.py"))
    C = {"role": str(held.get("role") or ""), "subject": str(held.get("subject") or ""),
         "field": str(held.get("field") or ""), "style": str(held.get("style") or "")}
    style = _ps.style_of(C)
    col, wide, body = _VENUE_GEOM.get(style, _VENUE_GEOM["earth_space"])
    json.dump({"col_in": col, "wide_in": wide, "body_pt": body, "style": style},
              open(os.path.join(td, "figconfig.json"), "w"))
    return style


def _fig_contract_ok(final, td):
    """Deterministic figure-contract gate (PAPER_QUALITY_SPEC S2): vector twin per figure, no sparse wide
    figures, at most 5 stat figures, and a no-LLM make_figs.py so figures can be restyled without rerunning
    the experiment."""
    if str(final.get("verdict", "")).strip().lower() in ("infeasible", "insufficient", "null", "insufficient_data"):
        return True, ""
    figs = [f for f in (final.get("figures") or []) if isinstance(f, dict)]
    if len(figs) > 5:
        return False, ("list at most 5 figures (the strongest, lead first -- the paper cannot hold more); "
                       "you listed %d. Keep the extra analyses in 'analyses' as text." % len(figs))
    try:
        meta = json.load(open(os.path.join(td, "figmeta.json")))
    except Exception:
        meta = {}
    for f in figs:
        fn = os.path.basename(str(f.get("file", "")).strip())
        base = os.path.splitext(fn)[0]
        if not os.path.exists(os.path.join(td, base + ".pdf")):
            return False, ("figure %r has no vector twin %s.pdf -- every figure must be made with "
                           "figtools.new()/figtools.save() (never bare plt.savefig)" % (fn, base))
        if (meta.get(fn) or meta.get(base + ".png") or {}).get("sparse"):
            return False, ("figure %r is a sparse WIDE figure (one thin panel stretched across the full page "
                           "width reads as empty space) -- remake it with figtools.new(width='col'), or give "
                           "it real multi-panel content" % fn)
    if not os.path.exists(os.path.join(td, "make_figs.py")):
        return False, ("write make_figs.py in CWD before finalizing: a self-contained script (loads series.json "
                       "and/or intermediates you saved, imports figtools) that regenerates EVERY listed figure "
                       "with no LLM involved -- the pipeline reruns it to restyle figures later")
    return True, ""


def stage2_experiment(task):
    """Agentic experiment: reads stage 1's saved idea (does NOT re-run ideation), then designs the METHOD and
    runs REAL code (iterating method<->run) until it has grounded results or an honest null/infeasible.
    The agent designs the method itself under generic rigor (controls / baselines / proper statistics)."""
    sd = stages_dir(task)
    ip = os.path.join(sd, "01_ideation.json")
    if not os.path.exists(ip):
        print("[stage2] no 01_ideation.json -- run stage 1 first"); return {"_failed": True, "reason": "no idea on disk"}
    idea = json.load(open(ip))
    if idea.get("_failed") or not str(idea.get("research_question", "")).strip():
        print("[stage2] stage-1 idea is empty/failed"); return {"_failed": True, "reason": "upstream idea unusable"}
    exec_fn, held, members, data_block = _exp_exec(task)
    _style = _deploy_figtools(task, held)                             # figtools.py + figconfig.json into CWD
    print("[stage2] figtools deployed (venue style: %s)" % _style)
    modalities = (evidence.detect_modalities(members)                 # perception tools this task unlocks
                  if (members and not data_block and not os.environ.get("MMSCI_NO_VISION")) else set())  # MMSCI_NO_VISION = ablation (blind stage 2, not only stage 1)
    ptools = evidence.tool_schemas(modalities)
    pnames = [t["function"]["name"] for t in ptools]
    has_perc = bool(pnames)
    role = held.get("role", "an experienced researcher")

    system = (
        "You are " + role + ". You are GIVEN a research idea (below) -- do NOT re-invent it. Your job: run a "
        "THOROUGH experimental STUDY -- a FULL research-article experiment section, NOT a single test -- that "
        "probes the hypothesis from every angle and produces real numbers AND figures. Iterate like a scientist: "
        "implement -> run_python -> inspect -> if a result is weak/ambiguous or code errors, REVISE and rerun.\n\n"
        "A FULL STUDY = this battery (do every one the data can support; aim for >=5 analyses and ~8 figures/tables):\n"
        + (("  (0) LOOK FIRST: EARLY in the study, inspect at least ONE representative real item with the "
            "perception tools (look_at_*/analyze_*) and reconcile what you SEE with your plan -- a finalize that "
            "never looked at any item is REJECTED by the exit gate. Do this before the heavy computation.\n") if has_perc else "")
        + "  (1) PRIMARY: the pre-specified test of your hypothesis. It MAY come out weak or fail -- that is fine and "
        "normal; do NOT force it to look like a win.\n"
        "  (2) BASELINE: contrast vs a simpler/alternative method or a trivial baseline, so the effect is non-trivial.\n"
        "  (3) ABLATION: remove/vary a component of your method to show which part drives the result.\n"
        "  (4) MECHANISM: dig into WHY the effect arises (the driving feature/structure), not just that it does.\n"
        "  (5) BREAKDOWN: split the result by group/class/condition/time -- where it holds and where it doesn't.\n"
        "  (6) SENSITIVITY: vary the key thresholds/hyperparameters/subsample and show the finding is stable.\n"
        "  (7) LEAKAGE / GROUPING: if the data carries ANY grouping id (source/event/subject/patient/site/recording/"
        "network), you MUST evaluate under a group-disjoint or leave-one-group-out split (not only a random split) and "
        "verify no group appears in both train and test, so the finding is not inflated by group-level memorization; "
        "report the group-out metric next to the random-split one. (Skip only if the data has no grouping id at all.)\n"
        "RUN BUDGET: you have AT MOST 40 run_python calls for the whole study (each capped at ~150s) -- plan the "
        "battery to fit, shrink grids/replicates rather than overrun, and reserve your last calls for the final "
        "self-contained consolidation run. Past 40 the tool refuses and you must finalize.\n\n"
        "For EACH analysis: print its decisive numbers as 'name = value' and, for the strongest analyses, make a "
        "publication figure. FIGURE CONTRACT (the exit gate enforces it):\n"
        "    import figtools                       # ALREADY in your CWD; styles everything (palette/serif/vector)\n"
        "    fig, ax = figtools.new(width='col')   # 'col' = single column (DEFAULT); 'wide' ONLY for true multi-panel\n"
        "    ax.bar(..., **figtools.bar_style(i))  # bars: light fill + dark same-family edge\n"
        "    ax.plot(..., **figtools.line_style(i))# lines/scatter: deep colour + distinct marker per series\n"
        "    figtools.save('short_name')           # writes vector fig_short_name.pdf + preview .png; list the .png\n"
        "DESIGN each figure BEFORE plotting: decide col-vs-wide from its content (a wide figure must be multi-panel "
        "or genuinely wide -- a single sparse panel at full width is REJECTED); figtools already sets the printed "
        "font size, so never shrink fonts to fit -- reduce content instead. No in-figure titles (the caption carries "
        "the message). At most 5 figures in the final 'figures' list (strongest only; every analysis still goes in "
        "'analyses' as text). Also SAVE the intermediate results your figures need (np.save/json.dump) and, before "
        "finalizing, write make_figs.py: a self-contained no-LLM script (imports figtools, loads series.json and/or "
        "your saved intermediates) that regenerates every listed figure -- the pipeline reruns it to restyle.\n\n"
        "TOOLS: inspect_data (cheap overview; the data is your code's CWD, series.json there has the full members "
        "list)" + ((("; PERCEPTION tools -- " + ", ".join(pnames) + " -- (analyze_* = native numeric/text "
                     "features; look_at_* = visual gestalt) to ground your analysis") if has_perc else "")) +
        "; run_python (executes your code in the data dir, returns stdout+stderr); finalize_results.\n\n"
        "IRON RULE -- NO FABRICATION: every number you report MUST come from real run_python output. NEVER "
        "hard-code, invent, or 'expand' data rows -- LOAD the real data (json.load('series.json')['members'] -> "
        "the image files / fields). If the data genuinely cannot support the test, run what you can and report "
        "verdict='infeasible' with what you found. Print every decisive number as 'name = value'.\n\n"
        "REPRODUCIBILITY: your FINAL reported numbers MUST all come from ONE self-contained run that loads the "
        "data, computes, runs the statistics, and prints ALL decisive numbers together. Do NOT paste intermediate "
        "numbers from a previous run back in as literals -- recompute them (pasting breaks reproducibility, looks "
        "like fabrication, and the exit gate rejects it).\n\n"
        "RIGOR (the exit gate enforces these):\n"
        "- MULTIPLE COMPARISONS: if you run several statistical tests, COUNT every test you actually ran and "
        "correct for THAT count (Bonferroni/FDR); report which results survive. Do not under-count the tests.\n"
        "- INDEPENDENCE: if your predictor and your outcome come from the SAME model/representation, the "
        "correlation may be circular -- use an INDEPENDENT predictor (a different/frozen model, hand features) "
        "or explicitly scope the claim to 'within this representation'.\n"
        "- HONEST POWER: a sub-result resting on very few events is 'suggestive', NOT a confirmed finding -- say so.\n"
        "REFRAME (do this at the END, before you finalize): pick the LEAD = the single STRONGEST SUPPORTED analysis "
        "in your battery. The LEAD may be the PRIMARY, or it may be a different analysis (a mechanism/alternative "
        "metric) if the PRIMARY came out weak. If you reframe onto a non-primary LEAD, you MUST have run genuine "
        "supporting analyses AROUND that LEAD (its own baseline/ablation/robustness), not just relabelled a lucky "
        "number. HARKing guard: a LEAD is only allowed if it (a) survives your multiple-comparison correction, (b) has "
        "a clear effect size, and (c) is not just the best of many noisy tries; if nothing clears this bar, report "
        "verdict='mixed' or 'null' honestly -- do NOT promote a weak result.\n"
        "Then produce the FINAL artifact centred on the LEAD (this is what the paper is written from, so the failed "
        "path must NOT survive here as a finding): order 'analyses' with the LEAD first, strongest to weakest; put the "
        "LEAD's figure first in 'figures' and OMIT the figures of demoted analyses; set 'lead' to the LEAD analysis "
        "name; put any failed/weak analysis (including a failed PRIMARY) in 'demoted' (names only); write "
        "'result_statement' leading with the LEAD; and set 'verdict' to reflect the LEAD (supported if the LEAD is "
        "solid). Keep the headline crisp; do NOT narrate the failed primary here -- the paper does not mention it, it "
        "only lives in the trace.")
    task_msg = (
        "The idea to test (from stage 1):\n"
        "- Research question: " + str(idea.get("research_question", ""))[:700] + "\n"
        "- Hypothesis: " + str(idea.get("hypothesis", ""))[:700] + "\n"
        "- Experiment protocol: " + str(idea.get("experiment", ""))[:1500] + "\n"
        "- Minimal publishable claim: " + str(idea.get("minimal_publishable_claim", ""))[:400] + "\n"
        "- Focus subset: " + str(idea.get("focus_subset", ""))[:300] + "\n\n"
        "Start by calling inspect_data and sketching the FULL battery of analyses you will run (main + baseline + "
        "ablation + mechanism + breakdown + sensitivity), then implement and run them one by one -- saving a "
        "fig_*.png and printing the decisive numbers for each -- before you finalize.")

    _td = task_dir(task)

    def _done2(final, state):
        ok, why = _exp_done(final, state)
        return (ok, why) if not ok else _fig_contract_ok(final, _td)

    obj = agent_loop(system, task_msg, _exp_tools(ptools), exec_fn, BRAIN, _done2,
                     max_steps=60, image_budget=8 if has_perc else 0,   # NO perception tools -> NO look-gate (a
                     max_tokens=12000, log=print,                        # data-block-only task has nothing to look
                     trace_path=os.path.join(stages_dir(task), "02_trace.json"))   # at and must not deadlock on it)
    # max_tokens 12000: flash's visible reasoning routinely spends 6-8k before the tool call; 8000 caused
    # constant truncation->double->retry churn (and each doubled retry is a full re-generation).

    md = ["# Stage 2 -- Experiment (AGENTIC: methods + real code execution)", "",
          "_task: %s | role: %s | brain: %s_" % (task, role, BRAIN), ""]
    if obj.get("_failed"):
        md += ["**STAGE 2 FAILED -- " + str(obj.get("reason", "")) + "**"]
    else:
        tr = obj.get("_trace", [])
        runs = sum(1 for t in tr if t["tool"] == "run_python")
        md += ["_tool trace: %s (run_python x%d)_" % (", ".join(t["tool"] for t in tr), runs), "",
               "## Verdict", "**" + str(obj.get("verdict", "")).upper() + "**", "",
               "## Method", str(obj.get("method_summary", "")).strip(), "",
               "## Key Numbers"]
        kn = obj.get("key_numbers") or {}
        md += (["- **%s** = %s" % (k, v) for k, v in kn.items()] if isinstance(kn, dict) else [str(kn)])
        md += ["", "## What Was Tested", str(obj.get("what_was_tested", "")).strip(), "",
               "## Result", str(obj.get("result_statement", "")).strip(), ""]
        analyses = obj.get("analyses") or []
        if analyses:
            md += ["## Analyses (full battery, %d)" % len(analyses)]
            for a in analyses:
                md += ["- **%s** -- %s  \n  _%s_" % (a.get("name", ""), a.get("finding", ""), a.get("numbers", ""))]
            md += [""]
        figs = obj.get("figures") or []
        if figs:
            md += ["## Figures (%d)" % len(figs)] + \
                  ["- `%s`: %s" % (f.get("file", ""), f.get("caption", "")) for f in figs] + [""]
    _write(task, "02_experiment", obj, "\n".join(md))
    return obj


# ================================================================ STAGE 3: WRITEUP (real paper -> PDF)
# Self-contained. Reuses the tested paper machinery in paper.py (gather_citations for REAL OpenAlex refs,
# gen_paper_staged for the section drafts, and the deterministic LaTeX sanitizers), but ASSEMBLES the
# multi-figure .tex itself (build_pdf only handles 2 figures) into a clean IMRaD template
# (../template_bio). The produced paper reads as a normal domain journal article: it names no AI /
# agent / pipeline. Confident framing in the main text; ALL caveats confined to a Limitations section.

def _strip_emdash(s):
    """No em-dash as sentence punctuation (house rule). Runs AFTER paper._sanitize_body, so unicode em/en dashes
    are already ASCII ('---' / '--'). Turns a dash used as punctuation into a comma; keeps numeric ranges like
    0.2--0.8 (double hyphen with no surrounding spaces) intact."""
    s = s or ""
    s = re.sub(r"\s*[—–]\s*", ", ", s)            # UNICODE em/en dash -> comma (never join two words into one)
    s = re.sub(r"\s*---\s*", ", ", s)                       # em-dash as punctuation -> comma
    s = re.sub(r"(?<=\S)\s+--\s+(?=\S)", ", ", s)           # SPACED en-dash as punctuation -> comma (keeps 0.2--0.8)
    s = re.sub(r"[^\S\n]+,", ",", s)
    s = re.sub(r",[^\S\n]*,", ",", s)
    s = re.sub(r"[^\S\n]{2,}", " ", s)                     # collapse horizontal whitespace but KEEP paragraph breaks (\n\n)
    s = re.sub(r"\n{3,}", "\n\n", s)                       # normalize runs of blank lines to a single blank line
    return s.strip()


def _dedash_tex(tex):
    """Dash-only cleanup for the FINAL assembled tex. The writer-stage _strip_emdash runs per section BEFORE the
    structure/polish passes, which then reintroduce em-dashes (e.g. 'arrivals—a pattern'); left raw, an em-dash
    both breaks the no-em-dash rule and reads as a joined word ('arrivalsa') when the PDF text is extracted. Convert a
    dash used as punctuation to a comma+space (NEVER joining the two words); keep unspaced numeric ranges (0.2--0.8)."""
    tex = re.sub(r"(?<=\d)\s*[–—]\s*(?=\d)", "--", tex or "")   # 2000–2020 / 0.2–0.8 are RANGES: keep them
    tex = re.sub(r"\s*[—–]\s*", ", ", tex)               # unicode em/en dash as punctuation -> comma+space
    tex = re.sub(r"\s*---\s*", ", ", tex)                       # ASCII em dash -> comma+space
    tex = re.sub(r"(?<=\S)\s+--\s+(?=\S)", ", ", tex)           # spaced ASCII en dash -> comma (keeps 0.2--0.8)
    return tex


def _annotate_exclusions(tex, exp, chat, model):
    """POST-POLISH (#1 statistical consistency): if an analysis's numbers record a test EXCLUSION (e.g. a note
    '(dof=3, BH/EH/HH/HN used)') and the paper does not already explain it, append ONE clarifying sentence after the
    results table so the reported degrees of freedom match the categories shown. Runs AFTER polish, so the sentence
    cannot be reworded away (the in-writer attempt sometimes is). The 'already explained' guard is SPECIFIC to a test
    exclusion, so it is not fooled by an unrelated 'excluded' (e.g. a dead channel dropped from a coincidence vote)."""
    note = next((str(a.get("numbers", "")) for a in (exp.get("analyses") or [])
                 if re.search(r"dof\s*=\s*\d+[^)]*\bused\b|exclud", str(a.get("numbers", "")), re.I)), "")
    if not note:
        return tex
    if re.search(r"exclud\w*[^.]{0,70}(sample size|too (small|few)|insufficient|small (sample|count)|for its |n\s*=?\s*\d)"
                 r"|too few (traces|samples|events)|excluding [A-Z]{1,3}[^.]{0,40}(sample|small|few|n\s*=?\s*\d)",
                 tex, re.I):
        return tex                                          # a test-exclusion explanation is already present (writer or a prior pass)
    try:
        sent = chat("A statistical test's numbers note: \"" + note[:220] + "\". In ONE plain sentence (<=32 words), "
                    "state which categories were INCLUDED in the test and which single category was EXCLUDED and why "
                    "(too few samples), so the degrees of freedom match. Output ONLY the sentence.", model, 130)
    except Exception:
        return tex
    sent = _dedash_tex((sent or "").strip().strip('"').strip())
    if not (sent and 15 < len(sent) < 320 and re.search(r"exclud|too few", sent, re.I)):
        return tex
    m = re.search(r"\\end\{table\}", tex) or re.search(r"\\chi\^?2?_?\{?\([0-9]", tex)   # after the table, else the chi mention
    if not m:
        return tex
    print("  [stage3] inserted a statistical-exclusion note (dof matches the categories tested)")
    return tex[:m.end()] + "\n\n" + sent + tex[m.end():]


def _fix_dof_consistency(tex, exp):
    """Deterministic (#1): a chi-square's stated degrees of freedom must match the grounded value. The writer sometimes
    gives one test's dof two ways (channel dof=3 in the table, but 'dof=4' in prose from confusing the 5 channels SHOWN
    with the 4 TESTED). For each analysis whose numbers record 'dof=K' and carry a distinctive keyword (channel /
    network), rewrite any 'dof=<other>' / 'degrees of freedom (<other>)' / '\\chi^2_{(<other>)}' inside a segment that
    mentions that keyword, to K. No LLM; keys off the grounded number, so it never invents a value."""
    for a in (exp.get("analyses") or []):
        # the grounded numbers give the exact "dof=K, <CODES> used" chunk (from the analysis battery). Anchor on its
        # first category CODE (e.g. BH) so we can replace any variant the writer wrote -- 'dof=4, BH/EH/HH/HN/SH used'
        # (SH wrongly included) -> the grounded 'dof=3, BH/EH/HH/HN used' -- WITHOUT a keyword window (which broke on the
        # decimal point in a p-value) and WITHOUT touching another test whose codes differ (network). No LLM, no invention.
        gm = re.search(r"dof\s*=\s*(\d+)\s*,\s*([A-Za-z0-9]+(?:/[A-Za-z0-9]+)*)\s+used", str(a.get("numbers", "")), re.I)
        if not gm:
            continue
        gchunk = "dof=%s, %s used" % (gm.group(1), gm.group(2))
        first = re.escape(gm.group(2).split("/")[0])                   # e.g. 'BH'
        tex = re.sub(r"dof\s*=\s*\d+\s*,\s*" + first + r"(?:/[A-Za-z0-9]+)*\s+used", gchunk, tex, flags=re.I)
    return tex


def _scrub_overclaim(tex):
    """Deterministic (post-polish): 'statistically indistinguishable from genuine/true/labeled X' claims a formal
    equivalence / distribution test the study did not run (its evidence is detector-score and feature-region overlap).
    Rescope any such phrase to the detector-defined feature region -- generic (keys off the over-claim phrase, no
    domain terms), belt-and-suspenders behind the soft anti-equation rule now in every section's grounding."""
    return re.sub(r"statistically indistinguishable from (?:the\s+)?"
                  r"(genuine|true|real|actual|labell?ed|catalogued|catalogued)\b",
                  r"consistent with the detector-defined feature region of \1", tex or "", flags=re.I)


def _clean_caption(cap):
    """Drop an internal all-caps tag the analysis battery prefixes (e.g. 'MAIN: ', 'BASELINE: ')."""
    return re.sub(r"^\s*[A-Z]{3,}\s*:\s*", "", (cap or "").strip())


_SECWORDS = r"Abstract|Introduction|Results|Discussion|Conclusions?|Methods?|Limitations|Background"


def _strip_pseudo_headers(s):
    """Drop a leading pseudo-heading the drafter sometimes prepends (e.g. '\\textbf{Abstract}', 'Conclusion:')."""
    s = (s or "").lstrip()
    s = re.sub(r"^\\(?:textbf|emph|textit|section\*?|subsection\*?)\{\s*(?:" + _SECWORDS + r")\s*\}\s*[:.]?\s*", "",
               s, flags=re.I)
    s = re.sub(r"^(?:" + _SECWORDS + r")\s*[:.]\s+", "", s, flags=re.I)
    return s.strip()


def _scrub_rs(rs, demoted):
    """Remove sentences that mention a demoted analysis or a failure/hedge phrase, so the failed path never reaches
    the confident Abstract/Results (it stays only in the trace). Fail-safe: if scrubbing empties it, keep the original."""
    dem = [str(d).strip().lower() for d in (demoted or [])] + [str(d).split(":")[-1].strip().lower() for d in (demoted or [])]
    bad = ("not significant", "non-significant", "nonsignificant", "no significant", "does not reach",
           "not reach significance", "did not reach", "fails to reach", "underpowered", "underpower",
           "pre-registered", "pre-specified", "pre-registration", "mixed result", "not confirmed",
           "not treated as", "not a confirmed", "was demoted", "demoted", "set aside", "suggestive",
           "tentative", "not definitive", "inconclusive", "fails correction", "fail correction",
           "did not survive", "does not survive")   # UNAMBIGUOUS failure/hedge markers only (no broad comparatives like "weaker")
    bad_re = re.compile(r"not\s+(?:\w+\s+){0,3}significant|no[nt][-\s]signif",
                        re.I)   # catches "not itself/statistically significant" (words in between) + "non-significant"

    def _bad(s):
        sl = s.lower()
        return any(t and t in sl for t in dem) or any(b in sl for b in bad) or bad_re.search(sl)

    out_paras, total, kept_n = [], 0, 0                     # scrub sentence-by-sentence but PRESERVE paragraph breaks
    for para in re.split(r"\n\s*\n", str(rs or "")):
        sents = [s for s in re.split(r"(?<=[.;])\s+", para) if s.strip()]
        kept = [s for s in sents if not _bad(s)]
        total += len(sents); kept_n += len(kept)
        if kept:
            out_paras.append(" ".join(kept).strip())
    txt = "\n\n".join(out_paras).strip()
    if not txt:                                             # scrubbing emptied it -> keep original (fail-safe)
        return str(rs or "").strip()
    if total >= 4 and kept_n < 0.5 * total:                 # mass removal => over-match; trust the prompt-cleaned original
        return str(rs or "").strip()
    return txt


def _trim_incomplete(t):
    """Deterministic anti-truncation guard: if a section generation was cut off mid-sentence (model hit its token
    cap and ended on a dangling clause / trailing comma), trim back to the last COMPLETE sentence so a section never
    ends mid-thought. Already-clean text (ends in sentence punctuation or a closer) is returned untouched."""
    t = (t or "").rstrip()
    if not t or t[-1] in ".!?)]}\"'":
        return t
    ends = list(re.finditer(r"[.!?][\"')\]]?(?=\s|$)", t))
    return t[:ends[-1].end()].rstrip() if ends else t


def _gather_citations_retry(chat, model, C, idea_text, obs, tries=3, log=print):
    """gather_citations, but retry because OpenAlex anonymous search is intermittently 503, and then -- if the
    count is still under the floor -- search the TASK's own subject instead of the stage-1 hypothesis.

    That last step is the one that matters in practice. Queries are generated from the hypothesis, so a narrow
    hypothesis produces narrow queries: rruff_raman's 'baseline photoluminescence index of REE-suffixed minerals'
    returned 7 papers and blocked the run, while the same task's plain subject ('a Raman spectrum of a mineral')
    returns 29. The literature was there; the search was aimed too tightly. Results are merged, hypothesis-first,
    so the specific papers still lead the bibliography and the broad ones only fill the tail.

    Returns ([], '') only when nothing at all came back, which means the search APIs are down, not the topic."""
    import paper, time
    best = ([], "")
    for t in range(tries):
        catalog, bib = paper.gather_citations(chat, model, C, idea_text, obs, log=log)
        if len(catalog) > len(best[0]):
            best = (catalog, bib)
        if len(catalog) >= _REF_FLOOR:
            return catalog, bib
        if t < tries - 1:
            # Retry on THIN, not just on empty. The 12 search queries are generated by the model on every call,
            # so a retry is a fresh set of queries, not the same request twice -- measured on rruff_raman, the
            # identical hypothesis yielded 7 refs on one draw and 33 on another. Keep the sleep: if the thinness
            # came from OpenAlex rather than the queries, hammering it immediately makes that worse.
            log("  [cite] %d refs is under the floor of %d -> redrawing search queries in %ds (attempt %d/%d)"
                % (len(catalog), _REF_FLOOR, 10 * (t + 1), t + 2, tries))
            time.sleep(10 * (t + 1))
    catalog, bib = best
    if len(catalog) < _REF_FLOOR:
        log("  [cite] %d refs from the hypothesis is under the floor of %d -> widening the search to the task "
            "subject itself" % (len(catalog), _REF_FLOOR))
        try:
            wide, wide_bib = paper.gather_citations(chat, model, C, str(C.get("subject", ""))[:300],
                                                    str(C.get("property", "") or C.get("request", ""))[:500], log=log)
        except Exception as e:
            log("  [cite] subject-level search failed: " + type(e).__name__)
            wide, wide_bib = [], ""
        seen = {p.get("title", "") for _, p in catalog}
        extra = [p for _, p in wide if p.get("title", "") not in seen]
        if extra:
            # Regenerate every key over one shared `used` set: the two searches ran independently, so both
            # could have minted the same key (two 2020 Smith papers) and a duplicate bibtex key breaks the build.
            used = set()
            catalog = [(paper._keygen(p, used), p) for _, p in catalog] + \
                      [(paper._keygen(p, used), p) for p in extra]
            bib = "\n\n".join(paper._bib_entry(k, p) for k, p in catalog)
            log("  [cite] subject-level search added %d -> %d references total" % (len(extra), len(catalog)))
    return catalog, bib


# NeurIPS-style SINGLE-COLUMN preamble. Self-contained (no external neurips.sty -> can never fail on a missing file):
# 10pt, ~5.5in single-column text block, bold numbered sections, a centered "Abstract" heading over an indented block.
# This is a faithful NeurIPS-style approximation, not the official .cls (which is not on CTAN and would need vendoring).
_TEX_PREAMBLE = (
    "\\documentclass[10pt]{article}\n\\usepackage[T1]{fontenc}\n\\usepackage{times}\n"
    "\\usepackage[letterpaper,left=1.5in,right=1.5in,top=1in,bottom=1in]{geometry}\n"   # 5.5in single-column block (NeurIPS)
    "\\usepackage{graphicx}\n\\usepackage{float}\n\\usepackage{placeins}\n"
    "\\usepackage{booktabs}\n\\usepackage{array}\n\\usepackage{multirow}\n"
    "\\usepackage{amsmath,amssymb}\n\\usepackage{bm}\n\\usepackage{natbib}\n"
    # natbib's plain \cite is \citet, so a sentence-final "... [Smith et al. [2016]]" comes out as a half sentence
    # with doubled brackets. Point \cite at \citep so those get parenthesised; explicit \citet / \citep stay.
    # (Was in the product engine since 08-2026; the research pipeline never had it and the 09-01 sync dropped it.)
    "\\let\\cite\\citep\n"
    "\\usepackage{caption}\n"
    "\\captionsetup{font=small,labelfont=bf,labelsep=period}\n\\usepackage[hidelinks]{hyperref}\n"
    "\\usepackage{cleveref}\n"                          # \cref/\Cref (must load after hyperref); the polish pass may use them
    "\\usepackage{titlesec}\n"
    "\\titleformat{\\section}{\\large\\bfseries}{\\thesection}{0.6em}{}\n"
    "\\titleformat{\\subsection}{\\normalsize\\bfseries}{\\thesubsection}{0.6em}{}\n"
    "\\titleformat{\\subsubsection}{\\normalsize\\bfseries\\itshape}{\\thesubsubsection}{0.6em}{}\n"
    "\\titlespacing*{\\section}{0pt}{2.4ex plus 1ex minus .2ex}{1.3ex plus .2ex}\n"
    "\\renewcommand{\\abstractname}{Abstract}\n"
    "\\renewenvironment{abstract}{\\centerline{\\normalsize\\bfseries\\abstractname}\\vspace{0.3ex}"
    "\\begin{quote}\\small}{\\end{quote}\\vspace{0.4ex}}\n"
    "\\setlength{\\parindent}{1.2em}\n\\setlength{\\parskip}{3pt}\n\\graphicspath{{figures/}}\n")


def _lead_headline(exp):
    """'lead' is an ANALYSIS NAME (per the stage-2 schema, gated to be an exact analyses[] key), NOT a sentence.
    Resolve it to that analysis's finding PROSE, falling back to the result_statement -- so title/grounding are built
    from a real finding, never a bare key like 'primary_H1_regression'."""
    lead = str(exp.get("lead", "")).strip()
    for a in (exp.get("analyses") or []):
        if str(a.get("name", "")).strip() == lead:
            f = str(a.get("finding", "")).strip()
            if f:
                return f
    return str(exp.get("result_statement", "")).strip()


# ---------------------------------------------------------------- Stage-3 THESIS PLANNER (positive narrative)
# A paper is not an experiment log: it selects the strongest DEFENSIBLE positive thesis from the analyses and organises
# everything around it, giving each analysis a rhetorical ROLE (core evidence / control / boundary / robustness) instead
# of flattening supported+weak results into "mixed evidence". The planner runs BEFORE the writer; if it fails or yields
# nothing defensible, the writer FALLS BACK to the plain outline->expand path (never a silent downgrade -- the fallback
# is logged). The "aggressive-but-DEFENSIBLE" brake is DETERMINISTIC and at the SOURCE, not a post-hoc word lexicon
# (that mangled legitimate cross-domain prose and could even strengthen a claim): (1) the stage-2 gate enforces the
# LEAD's own statistical significance, (2) a thesis CORE may rest only on the gated lead or an analysis with a real
# significant p-value, (3) the free-text thesis cannot cite a number absent from the real results, (4) the title is
# derived from the defensible thesis and re-checked against the plan's forbidden claims. So the positive framing can
# never tip into over-marketing / fabrication.


def _validate_thesis(th, supported, lead=""):
    """DETERMINISTIC teeth of aggressive-but-DEFENSIBLE: accept a planned thesis only if it is a real, positive claim
    whose CORE rests solely on SUPPORTED analyses (a weak/mixed/demoted result can be a control or boundary, NEVER the
    thesis core) and whose roles reference real analyses. 'Supported' = the gated stage-2 lead (which is, by
    construction, the strongest supported analysis and is never demoted) plus any analysis whose verdict is explicitly
    'supported' (the per-analysis verdict field is optional, so the lead anchors the set). Else -> reject -> fallback."""
    if not isinstance(th, dict):
        return False
    if len(str(th.get("paper_thesis", "")).strip()) < 25:
        return False
    roles = th.get("roles")
    if not isinstance(roles, dict) or not roles:
        return False
    names = {str(a.get("name", "")).strip() for a in supported}
    # core-eligibility ('strong'): an analysis may anchor the thesis UNLESS it is demonstrably non-significant (it
    # reports p-values that are ALL >= 0.05). An analysis with a significant p, or with no p-value at all (a prevalence,
    # detection rate, effect size or CI-based finding -- not every valid study is p-value based), is eligible; only a
    # shown-weak result is blocked. This keeps the anti-fab tooth (no weak result as thesis core) without forcing the
    # positive-narrative planner into fallback on any study that does not report p-values. Demoted analyses are already
    # excluded from `supported`; the lead's own significance is separately enforced at the stage-2 gate.
    def _core_ok(a):
        pv = _pvalues(str(a.get("numbers", "")))
        return (str(a.get("verdict", "")).strip().lower() == "supported") or (not pv) or any(p < 0.05 for p in pv)
    strong = {str(a.get("name", "")).strip() for a in supported if _core_ok(a)}
    cores = [n for n, r in roles.items() if str(r).strip().lower() == "core"]
    if not cores or any(n not in strong for n in cores):
        return False                                       # core must be a SUPPORTED analysis (no weak result as thesis)
    if any(n not in names for n in roles):
        return False                                       # roles must reference real analyses
    return True


def _plan_thesis(chat, model, C, exp, idea):
    """Plan the paper's POSITIVE thesis + per-analysis rhetorical roles from the SUPPORTED analyses. Returns the
    validated plan dict, or None (-> writer falls back to plain outline->expand). Never invents: it only reorganises
    the real, gated results into a defensible positive narrative."""
    dem = set(str(d).strip() for d in (exp.get("demoted", []) or []))
    supported = [a for a in (exp.get("analyses") or []) if str(a.get("name", "")).strip() not in dem]
    lead = str(exp.get("lead", "")).strip()
    if not supported or not lead:
        return None                                        # no kept analyses / no gated lead -> no defensible thesis
    rows = "\n".join("- %s | %s | %s" % (str(a.get("name", "")).strip(),
                     str(a.get("finding", "")).strip()[:160], str(a.get("numbers", "")).strip()[:120])
                     for a in supported)
    rq = (str(idea.get("research_question", "")).strip() + " " + str(idea.get("hypothesis", "")).strip()).strip()
    prompt = (
        "You are " + str(C.get("role", "a researcher")) + " turning a COMPLETED experiment into a POSITIVE scientific "
        "paper (not an experiment log). From the analyses below, select the SINGLE strongest DEFENSIBLE positive thesis "
        "and organise everything around it.\n"
        "The thesis MAY be NARROWER than the original hypothesis: if the original had two parts and only one is "
        "supported, the paper's thesis is the SUPPORTED part, and the weaker part becomes a boundary/control, NOT the "
        "main claim. Do NOT present results as 'mixed'; do NOT invent findings or numbers; ground the thesis ONLY in "
        "these results (if the thesis states a number, that number MUST appear in the analyses' numbers).\n"
        "Assign EVERY listed analysis exactly one rhetorical ROLE:\n"
        "  core       = direct evidence FOR the thesis. The LEAD analysis (" + lead + ") is the PRIMARY core; mark any "
        "OTHER analysis as core ONLY if it independently reaches significance (its own p < 0.05). A weak/non-significant "
        "analysis is NEVER core.\n"
        "  control    = a baseline/contrast that LOCATES the thesis (distinguishes it from a stronger unsupported claim)\n"
        "  boundary   = defines WHERE the thesis applies (channel/regime dependence, weak sub-results)\n"
        "  robustness = a generalisation or stress test\n"
        "Also give: not_the_paper = over-reaching claims this paper does NOT make; forbidden_claims = exact words/phrases "
        "the title and abstract must NOT use (causal, invariance, sufficiency, operational, or generalisation language "
        "the evidence does not license).\n"
        "Output ONLY JSON: {\"paper_thesis\":\"<one positive sentence>\",\"positive_core\":[\"...\"],"
        "\"roles\":{\"<analysis_name>\":\"core|control|boundary|robustness\"},\"not_the_paper\":[\"...\"],"
        "\"forbidden_claims\":[\"...\"]}\n\n"
        "ORIGINAL QUESTION/HYPOTHESIS: " + rq[:500] + "\n"
        "LEAD analysis: " + lead + "\n"
        "ANALYSES (name | finding | numbers):\n" + rows + "\n"
        "RESULT SUMMARY: " + str(exp.get("result_statement", "")).strip()[:600])
    # real result numbers a grounded thesis may cite (union of analyses' numbers + key_numbers + result), as floats
    gfloats = []
    for n in _num_tokens(" ".join(str(a.get("numbers", "")) for a in supported) + " "
                         + json.dumps(exp.get("key_numbers", {})) + " " + str(exp.get("result_statement", ""))):
        try:
            gfloats.append(float(n))
        except Exception:
            pass
    for _ in range(3):                                     # retry: a transient blank must not force the fallback path.
        try:                                               # 2400 tokens: full thesis JSON + not_the_paper/forbidden lists
            th = pipeline.parse_json(chat(prompt, model, 2400) or "")
        except Exception:
            th = None
        if not _validate_thesis(th, supported, lead):
            continue
        tnums = _num_tokens(str(th.get("paper_thesis", "")))    # anti-fab: the free-text thesis cannot smuggle an
        if tnums and not all(_num_grounded(n, gfloats) for n in tnums):   # invented headline number (%<->fraction tolerant)
            continue
        return th
    return None


def _has_forbidden(t, forbid):
    """True if title `t` contains any forbidden claim word as a WHOLE WORD. Short tokens (<4 chars) are ignored to
    avoid substring false-positives ('cause' in 'because', 'a' matching everything)."""
    low = (t or "").lower()
    return any(len(f) >= 4 and re.search(r"\b" + re.escape(f) + r"\b", low) for f in forbid)


def _scrub_title(t):
    """Deterministic title cleanup: a paper title is a clean phrase, not a statistic/method dump. Strip a raw count
    '(163/750)', a trailing 'via/using <method> scoring/detection/...' appendage, and a ': <statistic> ...' subtitle,
    so 'Coherent ... Traces: 21.7% (163/750) via Label-Agnostic Anomaly Scoring' -> 'Coherent ... Traces'."""
    t = (t or "").strip()
    t = re.sub(r"\s*\(\s*\d+\s*/\s*\d+\s*\)", "", t)                     # a raw count '(163/750)'
    t = re.sub(r"\s*[:,]?\s*\b(?:via|using|through|by means of)\b[^:]*?\b(?:scoring|detection|analysis|classification|"
               r"model|framework|method|methods|pipeline|algorithm|approach|network|detector)\b\.?\s*$", "", t, flags=re.I)
    if re.search(r":\s*(?:\d|about\s+\d|roughly\s+\d|nearly\s+\d)", t):  # a ': 21.7% ...' statistic subtitle
        t = re.sub(r"\s*:\s*(?:\d|about|roughly|nearly).*$", "", t)
    return re.sub(r"\s{2,}", " ", t).strip(" :,-;")


_TITLE_DANGLERS = {"under", "of", "in", "on", "for", "with", "and", "or", "the", "a", "an", "to", "via",
                   "by", "from", "at", "not", "versus", "vs", "as", "into", "over", "between", "without"}


# A title that OPENS on a preposition is a stranded modifier, not a noun phrase naming a finding: the plant
# paper shipped 'In registered 3D laser time series of growing plants', which states nothing. 'On' and
# 'Toward(s)' are the two openers that are real title forms ('On the Origin of Species'), so they stay legal.
_TITLE_BAD_OPENERS = {"in", "under", "with", "for", "from", "by", "at", "between", "among", "during",
                      "across", "within", "through", "via", "into", "over", "against", "about", "after",
                      "before", "and", "or", "but", "that", "which", "while", "because", "although"}


def _title_complete(t):
    """A title may not END on a dangling function word ('... landscapes under') or OPEN on a preposition
    ('In registered 3D laser time series ...' -- a modifier with no head noun and no claim)."""
    w = re.findall(r"[A-Za-z-]+", (t or "").lower())
    return bool(w) and w[-1] not in _TITLE_DANGLERS and w[0] not in _TITLE_BAD_OPENERS


def _gen_title(chat, model, C, exp, thesis=None):
    """One concise title pitched as the POSITIVE thesis, as strong as the evidence allows but no stronger. When a thesis
    plan exists the title is derived from it (defensible by construction) and any forbidden-claim WORD triggers a
    re-try, then a screened fallback. Retries on empty; never ships 'Untitled' or a title carrying a forbidden claim."""
    import paper
    th = str((thesis or {}).get("paper_thesis", "")).strip()
    headline = th or _scrub_rs(_lead_headline(exp), exp.get("demoted", []))
    forbid = [str(x).strip().lower() for x in (thesis or {}).get("forbidden_claims", []) or [] if str(x).strip()]
    prompt = ("You are " + str(C.get("role", "a researcher")) + ". Write ONE research-paper title whose claim IS the "
              "positive thesis below, pitched as strong as the evidence allows but no stronger. A title is ONE clean "
              "noun phrase naming the FINDING -- NOT a finding-plus-statistic-plus-method dump. Length is FIELD-DEPENDENT: "
              "biology / clinical / chemistry titles are often long and descriptive, CS / physics shorter -- be as long "
              "as the finding needs and no longer; do NOT pad, but do NOT drop the specific finding to hit a word count. "
              "HARD RULES (independent of length): (a) put NO raw count like '(163/750)', NO p-value, and NO exact "
              "statistic in the title; a bare percentage is discouraged -- prefer 'a fifth of' / 'a substantial fraction "
              "of'. (b) do NOT append the method with 'via/using/through <method> scoring/detection/analysis' -- the "
              "method belongs in the abstract, not the title. (c) NO colon subtitle that dumps a statistic or the method "
              "name. (d) NO code notation: never 'tau=1e-2', 'R^2', underscores, or parameter settings in a title -- "
              "name the concept in words. A title is a COMPLETE noun phrase, never a truncated clause. "
              "Use associational/descriptive language; do NOT use causal, invariance, sufficiency, or operational "
              "wording the thesis does not state. If the claim is a fraction / prevalence over a NAMED dataset that was "
              "SAMPLED (not analyzed in full), SCOPE it -- 'a sampled set of ...', 'in sampled ...' -- not the ENTIRE set."
              + ((" Do NOT use these words: " + "; ".join(forbid) + ".") if forbid else "")
              + "\nTHESIS: " + (headline[:220] or str(C.get("subject", "the studied system")))
              + "\nOutput ONLY the title text, no quotation marks, no markdown.")
    best = ""
    for _ in range(3):                                     # 140 tokens: enough for a full title (60 truncated it)
        t = _scrub_title(paper._clean_title((chat(prompt, model, 140) or "").strip()))   # strip count/method/stat-dump
        if len(t) >= 12 and not _has_forbidden(t, forbid) and _title_complete(t):
            return t                                       # a clean COMPLETE title, free of forbidden over-claims
        if len(t) >= 12 and not best:
            best = t                                       # keep the first non-trivial candidate as a last resort
    # fallback: a concise title from the DEFENSIBLE thesis's first clause, trimmed at a SAFE word boundary --
    # the old flat [:16]-word chop shipped a published title ending in '... landscapes under' (twice).
    base = re.sub(r"\s+", " ", (headline or str(C.get("subject", ""))).strip())
    words = re.split(r"[,;:]", base)[0].split()[:16]
    while words and words[0].lower().strip(".:,-") in _TITLE_BAD_OPENERS:
        words.pop(0)                                       # never open a title on a stranded preposition
    while words and words[-1].lower().strip(".:,-") in _TITLE_DANGLERS:
        words.pop()                                        # never end a title on a dangling function word
    base = paper._clean_title(" ".join(words))
    if base and not _has_forbidden(base, forbid):
        return base
    if best and not _has_forbidden(best, forbid) and _title_complete(best):
        return best
    return base or "Untitled"


def _paper_tex(C, title, out, figblocks, bib, known=None):
    """Assemble the .tex DYNAMICALLY from the writer's ordered sections (out['_order']); interleave the figures into
    the lead (Results-type) section and guarantee each figure is referenced; author-year references via natbib.
    `known` = the real bib keys; any \\cite to a key outside it is stripped (never ships an undefined "[?]" cite)."""
    import paper as _paper
    known = set(known or [])
    defined = set(re.findall(r"\\label\{(fig:f\d+)\}", "\n".join(figblocks)))   # figure labels that actually exist

    def _drop_dangling_refs(s):
        # a \ref to a figure with no matching \label renders as "Figure ??"; rewrite the whole "Figure~\ref{..}" token
        s = re.sub(r"(?:Figure|Fig\.?|Table)~?\s*\\ref\{(fig:f\d+)\}",
                   lambda m: m.group(0) if m.group(1) in defined else "the analysis", s)
        return re.sub(r"\\ref\{(fig:f\d+)\}", lambda m: m.group(0) if m.group(1) in defined else "", s)

    def _san(s):
        s = _strip_emdash(_paper._sanitize_body(_strip_pseudo_headers(s or "")))
        if known:                                          # keep only \cite keys that are in the real bib
            s = _paper._filter_cites(s, known)
        return _drop_dangling_refs(s)

    def _interleave(prose, blocks):
        labs = re.findall(r"\\label\{(fig:f\d+)\}", "\n".join(blocks))
        referenced = set(re.findall(r"\\ref\{(fig:f\d+)\}", prose))
        missing = [l for l in labs if l not in referenced]
        if missing:                                        # every figure must be cited in text. NOTE: phrasing must
            prose = (prose.rstrip() + "\n\n" +             # NOT match the 'summarized in Figure' filler-scrub regex,
                     " ".join("Figure~\\ref{%s} presents the corresponding supporting analysis." % l
                              for l in missing))           # which would delete this and re-orphan the figures.
        paras = [p for p in re.split(r"\n\s*\n", prose) if p.strip()] or [prose]
        n, fi, ordered = len(blocks), 0, []
        for i, p in enumerate(paras):
            ordered.append(p)
            while fi < n and fi < round((i + 1) * n / len(paras)):
                ordered.append(blocks[fi]); fi += 1
        ordered.extend(blocks[fi:])
        return "\n\n".join(ordered)

    lead = out.get("_lead_section")
    body = []
    for name in out["_order"]:
        prose = _san(out.get(name, ""))
        if not prose.strip():
            print("  [stage3] WARNING dropping empty section: %s (writer returned no prose)" % name)
            continue
        if name == lead:
            if figblocks:
                prose = _interleave(prose, figblocks)
            tbl = out.get("_results_table", "")            # raw, grounded-verified LaTeX table -> inserted WITHOUT _san
            if isinstance(tbl, str) and tbl.strip():
                parts = prose.split("\n\n", 1)             # place it right after the section's first paragraph
                prose = parts[0] + "\n\n" + tbl + ("\n\n" + parts[1] if len(parts) > 1 else "")
        body.append("\\section{%s}\n%s" % (name, prose))
    # flush every pending float BEFORE the bibliography: figures may never land after References (house rule)
    bibblock = ("\\FloatBarrier\n\n" + ("\\bibliographystyle{plainnat}\n\\bibliography{references}" if bib else "")).rstrip()
    _authors = _paper._latex_escape_title(str(C.get("authors") or "").strip() or "Anonymous")   # empty \author{} reads as unfinished/AI
    return (_TEX_PREAMBLE
            + "\\title{\\bfseries %s}\n\\author{%s}\n\\date{}\n"
              "\\begin{document}\n\\maketitle\n\n\\begin{abstract}\n\\noindent %s\n\\end{abstract}\n\n"
              % (_paper._latex_escape_title(title or "Untitled"), _authors, _san(out.get("ABSTRACT", "")))
            + "\n\n".join(body) + "\n\n" + bibblock + "\n\n\\end{document}\n")


def _proofread_abstract(chat, model, abstract):
    """One tight proofread call for the paper's face (a flash-written abstract shipped 'sntific'). Fix ONLY
    spelling/grammar; guards revert on any number change or length drift."""
    a = (abstract or "").strip()
    if not a:
        return abstract
    out = (chat("Proofread this scientific abstract. Fix ONLY spelling and grammar errors; change NO numbers, "
                "NO terminology, NO claims, NO sentence order. Return only the corrected abstract text.\n\n" + a,
                model, 700, label="proofread") or "").strip()
    if out and abs(len(out) - len(a)) < 0.15 * len(a) and _num_tokens(out) == _num_tokens(a):
        return out
    return abstract


def _mathify_underscores(tex):
    """Prose code-speak like 'x\\_j' / 'R\\_ratio' (an escaped underscore variable in TEXT mode) becomes real
    math: $x_{j}$ / $R_{\\mathrm{ratio}}$. Single-letter bases only, outside math spans -- deterministic."""
    spans = []
    tex = re.sub(r"\\begin\{(equation|align|eqnarray|displaymath|gather)\*?\}.*?\\end\{\1\*?\}"
                 r"|\\\[.*?\\\]|\\\(.*?\\\)|\$[^$]*\$",
                 lambda m: spans.append(m.group(0)) or "\x00U%d\x00" % (len(spans) - 1),
                 tex, flags=re.S)   # display envs are math too: wrapping 'sigma' to $\sigma$ INSIDE an
                                    # equation nests $ in math mode and breaks the compile (audit item 2)

    def _rep(m):
        base, sub = m.group(1), m.group(2)
        return "$%s_{%s}$" % (base, sub if len(sub) <= 2 else "\\mathrm{%s}" % sub)

    tex = re.sub(r"\b([A-Za-z])\\_\{?([A-Za-z0-9]{1,12})\}?", _rep, tex)
    # 'R\textasciicircum{}2' / '10\textasciicircum{}{-6}' (the assembler's escape of a prose caret) -> $R^{2}$ / $10^{-6}$
    tex = re.sub(r"\b([A-Za-z0-9]+(?:\.\d+)?)\\textasciicircum\{\}\{?(-?[A-Za-z0-9]+(?:\.\d+)?)\}?", r"$\1^{\2}$", tex)
    # bare greek names in prose ('3 sigma', 'the sigma clipping') -> real math; in English science prose
    # these words have exactly one meaning, so the replacement is safe.
    for g in ("sigma", "tau", "rho", "lambda", "epsilon"):
        tex = re.sub(r"(?<![\\{])\b%s\b(?![}$])" % g, "$\\\\%s$" % g, tex)
    # e-notation in prose (1e-6, 5.3e-4) -> proper powers of ten (numerically identical, notation only)
    def _enote(m):
        coef, ex = m.group(1), int(m.group(2))
        return ("$10^{%d}$" % ex) if coef in ("1", "1.0") else ("$%s\\times10^{%d}$" % (coef, ex))
    tex = re.sub(r"\b(\d+(?:\.\d+)?)e(-?\d+)\b", _enote, tex)

    def _enote_math(m):                                    # inside math: same conversion, no extra $ wrapper
        coef, ex = m.group(1), int(m.group(2))
        return ("10^{%d}" % ex) if coef in ("1", "1.0") else ("%s\\times10^{%d}" % (coef, ex))

    def _sub_math(m):                                      # R\_ratio inside math -> R_{\mathrm{ratio}}
        s = m.group(1)
        return "_{%s}" % (s if len(s) <= 2 else "\\mathrm{%s}" % s)
    for i, sp in enumerate(spans):
        if sp.startswith("$") and not sp.startswith("$$"):   # inline math carries the same code-speak as prose
            sp = re.sub(r"\b(\d+(?:\.\d+)?)e(-?\d+)\b", _enote_math, sp)
            sp = re.sub(r"\\_\{?([A-Za-z0-9]{1,12})\}?", _sub_math, sp)
        tex = tex.replace("\x00U%d\x00" % i, sp)
    return tex


def _para_nums(p):
    """What counts as a result number, taken straight from the acceptance checker: the writer has to budget
    by the exact rule that will judge it. These were two copies of one regex and they drifted -- paperlint
    stopped charging for math notation, CI intervals and bare sample sizes, this one kept charging -- so the
    density pass spent its 3-number budget scrubbing text lint was never going to flag."""
    return paperlint._result_numbers(p)


_ABBREV = ("al", "fig", "figs", "eq", "eqs", "sec", "tab", "vs", "cf", "no", "approx", "i.e", "e.g", "et")


def _sentences(body):
    """Sentence slices that keep every character (join(_sentences(x)) == x), abbreviation-aware."""
    body = body or ""
    out, last = [], 0
    for m in re.finditer(r"(?<=[.!?])\s+(?=[A-Z\\])", body):
        head = body[last:m.start()].rstrip()
        tail = re.findall(r"([A-Za-z.]+)[.!?]$", head)
        if tail and tail[0].rstrip(".").lower() in _ABBREV:
            continue                                       # 'et al.' / 'Fig.' is not a sentence end
        out.append(body[last:m.end()])
        last = m.end()
    out.append(body[last:])
    return out


def _shrink_dense_sentences(chat, model, orig, pointer, limit=3):
    """SENTENCE-level density rewrite, the fallback for when the paragraph-level one gets no answer. Measured
    on the plant paper: the long multi-constraint paragraph prompt sends flash into a reasoning loop that
    returns empty at every budget, while the same model rewrites the offending SENTENCE on the first try in
    ~650 tokens. Only sentences over the limit are sent; each result must keep its numbers verbatim and add
    none, or that sentence is left exactly as it was. Returns '' when nothing could be improved."""
    out, changed = [], False
    for s in _sentences(orig):
        onums = set(_para_nums(s))
        if len(_para_nums(s)) <= limit:
            out.append(s)
            continue
        p = ("Rewrite this sentence so it states at most %d numbers; move the rest to a pointer to %s. Copy "
             "every kept number verbatim, character for character. Keep every \\cite and \\ref intact, add no "
             "new number. Output ONLY the rewritten sentence.\n\n" % (limit, pointer)) + s.strip()
        got = re.sub(r"^```[a-zA-Z]*\n?|\n?```$", "", (chat(p, model, 500, label="density-sent") or "").strip()).strip()
        nn = _para_nums(got)
        if (got and len(nn) <= limit and all(x in onums for x in nn) and len(got) >= 40
                and got.count("\\cite") >= s.count("\\cite") and got.count("$") % 2 == 0
                and got.count("{") == got.count("}")):
            out.append(got + s[len(s.rstrip()):])          # keep the original trailing whitespace
            changed = True
        else:
            out.append(s)
    return "".join(out) if changed else ""


def _split_dense_paragraph(orig, limit=3):
    """TEXT-PRESERVING last resort for the density rule: break the paragraph at SENTENCE boundaries into the
    fewest chunks that each carry <= limit result numbers. Every character is copied verbatim, so nothing can
    be deleted, reworded, rounded or invented -- the failure mode that wrecked the plant paper's abstract came
    from a scrubber rewriting text, and this pass deliberately cannot. Returns '' when a SINGLE sentence already
    exceeds the limit (no split can help; the original then stands and lint reports it)."""
    body = (orig or "").strip()
    if not body:
        return ""
    sents = _sentences(body)
    if any(len(_para_nums(s)) > limit for s in sents):
        return ""
    chunks, cur = [], ""
    for s in sents:
        if cur and len(_para_nums(cur + s)) > limit:
            chunks.append(cur.strip())
            cur = s
        else:
            cur += s
    if cur.strip():
        chunks.append(cur.strip())
    return "\n\n".join(chunks) if len(chunks) > 1 else ""


def _toks(s):
    """Every numeric token in a string, loosely (sample sizes, exponents, years included), with citation keys,
    labels and pointers removed first so 'lee2019' or 'fig:3' cannot ground a table cell. The table path asks
    'does this number occur verbatim in the paragraph?', a different question from 'is it a result number'
    (_para_nums); a sample size in a table cell is legitimate, a rounded eta-squared is not."""
    s = re.sub(r"\\(?:cite[a-zA-Z]*|ref|eqref|label|url)\{[^}]*\}", " ", s or "")
    return set(re.findall(r"\d+(?:\.\d+)?", s))


def _nkey(x):
    """Comparison key for a result-number token: '-0.31' and '0.31', '12%' and '12' are the same number."""
    return (x or "").strip().strip("%").lstrip("-").replace(",", "")


def _float_coverage(tex):
    """{label: numeric tokens} for every float already in the tex -- a table's cells, a figure's caption. A dense
    paragraph whose numbers already live in one of them is pointed at it (lossless, no new float), which is also
    what keeps two paragraphs restating the same ANOVA from growing two identical tables. Layout digits
    (colspec widths, \\multicolumn{2}, \\cmidrule{2-3}) are stripped so they cannot pose as data."""
    cov = {}
    for m in re.finditer(r"\\begin\{(table|figure)\*?\}(.*?)\\end\{\1\*?\}", tex, re.S):
        env, body = m.group(1), m.group(2)
        lab = re.search(r"\\label\{([^}]+)\}", body)
        if not lab:
            continue
        if env == "table":
            tb = re.search(r"\\begin\{tabular\}\{(?:[^{}]|\{[^{}]*\})*\}(.*?)\\end\{tabular\}", body, re.S)
            src = tb.group(1) if tb else ""
            src = re.sub(r"\\(?:multicolumn|multirow)\{\d+\}|\\cmidrule(?:\([^)]*\))?\{[^}]*\}", " ", src)
        else:
            cp = re.search(r"\\caption\{((?:[^{}]|\{[^{}]*\})*)\}", body)
            src = cp.group(1) if cp else ""
        cov[lab.group(1)] = _toks(src)
    return cov


def _best_pointer(onums, cov, default):
    """The float that already carries the most of this paragraph's numbers -> ('Table~\\ref{..}', label, tokens).
    Falls back to the paper's first table/figure (the old behaviour) when no float shares a number."""
    best, bl = 0, None
    want = set(_nkey(x) for x in onums)
    for lab, toks in cov.items():
        k = len(want & toks)
        if k > best:
            best, bl = k, lab
    if bl is None:
        return default, None, set()
    return ("%s~\\ref{%s}" % ("Table" if bl.startswith("tab:") else "Figure", bl)), bl, cov[bl]


def _looks_tabular(orig, onums):
    """A table written as a sentence: several 'name = number' statistics and >= 5 distinct result numbers. The
    variance-decomposition paragraph that stalled rruff_raman had seven (three eta-squared, three p, one R-squared);
    no rewrite can keep them all under 3 per paragraph, and dropping them loses the result -- only a table fits."""
    flat = re.sub(r"\$([^$]*)\$", r" \1 ", orig or "")
    assigns = len(re.findall(r"(?:=|\\approx|\\sim|\\neq|\\le|\\ge|\\leq|\\geq|\\ll|\\gg|<|>)\s*-?\d", flat))
    return assigns >= 4 and len(set(_nkey(x) for x in onums)) >= 5


def _cell_chars(c):
    """The characters a cell actually typesets: math markup stripped ('$3.6\\times10^{-19}$' -> '3.6x10-19').
    \\times becomes 'x' BEFORE the control-word strip, or it vanishes and the p-value column stops looking numeric."""
    return re.sub(r"[\$\{\}\^_~]|\\[a-zA-Z]+\s?", "", re.sub(r"\\times\s*", "x", c or "")).strip()


def _est_width_pt(rows):
    """Rough typeset width of the booktabs tabular at \\small Times: about 4pt per typeset character for each
    column's widest cell, plus 2 x \\tabcolsep (12pt) per column. Used only to decide single- vs double-column;
    the model's 'Variance explained ($\\eta^2$)' header pushed a 3-column table 34pt into the margin (14 overfull
    boxes, lint red) when it sat in one column."""
    ncol = len(rows[0])
    return sum(max(4.0 * len(_cell_chars(r[j])) for r in rows) for j in range(ncol)) + 12.0 * ncol


def _cell_problem(c):
    """The table rules on ONE cell, as a rejection reason ('' = clean). Mirrors paperlint's `tables` check plus
    the compile hazards a model-written cell can carry (control characters outside math, a leading '[' that TeX
    reads as the optional argument of the preceding \\\\ or \\midrule, unbalanced braces inside math)."""
    s = (c or "").strip()
    if not s or s in ("-", "--", ",", "."):
        return "a cell is empty"
    if len(_cell_chars(s)) > 40:
        return "a cell is longer than 40 characters"
    if "\\pm" in s or "±" in s:
        return "a cell uses plus-minus"
    if re.search(r"\([^)]*\d[^)]*\)", re.sub(r"\$[^$]*\$", "", s)):   # same rule as paperlint: '(n=739)' is clutter, '($\eta^2$)' is not
        return "a cell has a parenthesis containing digits"
    if re.search(r"\d\s*/\s*\d", s):
        return "a cell has a slash-composite value"
    if re.search(r"[—–]|--", s):
        return "a cell has a dash"
    if re.search(r"\b\d+(?:\.\d+)?e-?\d+\b", s, re.I):
        return "a cell uses e-notation (write $a\\times10^{b}$)"
    if s.count("$") % 2 or s.count("{") != s.count("}"):
        return "a cell has an unbalanced $ or brace"
    if s.startswith("["):
        return "a cell must not start with ["
    if "\\\\" in s or "\\begin" in s or re.search(r"(?<!\\)&", s):
        return "a cell contains a row break, an environment or an alignment tab"
    if re.search(r"[^\x00-\x7f]", s):                      # T1 drops the glyph silently (lint: missing_glyphs)
        return "a cell has a non-ASCII character (write Greek letters and symbols in math, e.g. $\\eta^2$)"
    plain = re.sub(r"\$[^$]*\$", "", s).replace("\\%", "").replace("\\&", "")
    if re.search(r"[_^#&{}\\|]", plain):
        return "a cell has LaTeX control characters outside math (_ ^ # & { } backslash)"
    return ""


def _table_rows_problem(rows, cap, otoks):
    """Whole-table rules (shape, caption, grounding) as a rejection reason; '' when the rows can be built."""
    if len(rows) < 3:
        return "the table needs a header row and at least 2 data rows"
    ncol = len(rows[0])
    if not 2 <= ncol <= 6:
        return "the table must have 2 to 6 columns"
    if len(rows) - 1 > 10:
        return "the table has more than 10 data rows"
    if any(len(r) != ncol for r in rows):
        return "every row must have exactly as many cells as the header"
    for r in rows:
        for c in r:
            bad = _cell_problem(c)
            if bad:
                return bad + (": '%s'" % c.strip()[:30])
    long_h = [c for c in rows[0] if len(_cell_chars(c)) > 20]
    if long_h:
        return "a header cell is longer than 20 characters (use short headers such as Effect, $\\eta^2$, $p$): '%s'" % long_h[0][:30]
    # a two-column 'Quantity | Value' list mixes CI bounds, effect sizes and shortfalls in one column: that is a
    # key-value dump, not a table (one KIND of quantity per column). Make the model lay it out as rows = settings
    # or groups, columns = statistics; the glm heartsound paper shipped exactly this dump before the rule existed.
    if ncol == 2 and re.fullmatch(r"(?i)\s*(?:values?|statistics?|numbers?|results?|estimates?|metrics?|quantity|quantities)\s*",
                                  _cell_chars(rows[0][1])):
        return ("a two-column label/Value list is not a table: put ONE kind of quantity per column (rows = groups or "
                "settings, columns = statistics such as $d$, $p$, CI bounds), and keep unrelated numbers in the prose")
    # one TYPE per column (table rule): a statistic column holds numbers in every row, never a stray symbol
    # -- Sonnet once filed R-squared as the row 'Full model & 0.0688 & $R^2$', text in the p-value column.
    for j in range(1, ncol):
        kinds = {bool(re.fullmatch(r"-?\d+(?:\.\d+)?(?:x10-?\d+)?%?", _cell_chars(r[j]))) for r in rows[1:]}
        if len(kinds) > 1:
            return ("column %d mixes numbers and text; one type per column (a statistic of another kind gets its own "
                    "column, or stays in the prose)" % (j + 1))
    cap = (cap or "").strip()
    if not cap or "\n" in cap:
        return "the caption must be one non-empty line"
    if "\\pm" in cap or "±" in cap:
        return "the caption must not use plus-minus"
    if re.search(r"\([^)]*\d[^)]*\)", re.sub(r"\$[^$]*\$", "", cap)) or re.search(r"\d\s*/\s*\d", cap) or re.search(r"[—–]|--", cap):
        return "the caption must not contain parentheses with digits, slashes between digits, or dashes"
    if (re.search(r"[^\x00-\x7f]", cap) or cap.count("$") % 2 or cap.count("{") != cap.count("}") or "\\\\" in cap
            or re.search(r"[_^#&{}\\]", re.sub(r"\$[^$]*\$", "", cap).replace("\\%", ""))):
        return "the caption must be ASCII with any symbol inside balanced $...$ and no LaTeX control characters outside math"
    if _toks(cap) - otoks:
        return "the caption contains numbers not in the paragraph: " + ", ".join(sorted(_toks(cap) - otoks)[:5])
    body = "\n".join(" ".join(r) for r in rows)
    if _toks(body) - otoks:
        return "the table contains numbers not in the paragraph: " + ", ".join(sorted(_toks(body) - otoks)[:5])
    if not any(_toks(c) for r in rows[1:] for c in r[1:]):
        return "the table carries no numbers"
    return ""


def _build_table(rows, cap, label):
    """Deterministic booktabs table from validated rows: first column left-aligned labels, the rest right-aligned;
    a bare % is escaped so a model-written '12.3%' cannot comment out the row. A table that would not fit one
    column (>= 5 columns, or an estimated width past ~235pt of the 247pt column) gets the %WIDE marker the venue
    skins turn into a double-column float (the same convention the writer's results table uses)."""
    esc = lambda s: re.sub(r"(?<!\\)%", r"\\%", (s or "").strip())
    ncol = len(rows[0])
    lines = [" & ".join(esc(c) for c in r) + " \\\\" for r in rows]
    wide = ncol >= 5 or _est_width_pt(rows) > 235.0
    return ("\\begin{table}[t]" + ("%WIDE\n" if wide else "\n") + "\\centering\n\\small\n\\caption{" + esc(cap)
            + "}\n\\label{" + label + "}\n\\begin{tabular}{" + "l" + "r" * (ncol - 1) + "}\n\\toprule\n" + lines[0]
            + "\n\\midrule\n" + "\n".join(lines[1:]) + "\n\\bottomrule\n\\end{tabular}\n\\end{table}")


_DENS_TABLE_PROMPT = (
    "This LaTeX paragraph states a group of related statistics as running prose. Move them into ONE small table and "
    "rewrite the paragraph around it.\n"
    "Return EXACTLY this plain-text layout (no code fences, no markdown, nothing before or after):\n"
    "CAPTION: <one line, no numbers>\n"
    "TABLE:\n"
    "<header cells separated by |>\n"
    "<one data row per line, cells separated by |>\n"
    "PARAGRAPH:\n"
    "<the rewritten paragraph>\n"
    "RULES (each is checked by a program; one violation rejects the whole answer):\n"
    "- Table: first column = short text row labels (at most 40 characters); every other column = ONE statistic in "
    "ONE unit with a uniform number of decimals; short headers of at most 20 characters (e.g. Effect, $\\eta^2$, "
    "$p$; units or symbols belong in the header, never in cells); 2 to 6 columns; 2 to 10 data rows; no empty "
    "cell; no plus-minus; no parentheses containing "
    "digits; no slash-composites like 1.2/3.4; no dashes; math in a cell written inline as $...$ (e.g. "
    "$3.6\\times10^{-19}$, never 3.6e-19); no \\begin, \\multirow or \\multicolumn; no markdown separator line.\n"
    "- Every number in the table and in the caption must appear VERBATIM in the paragraph below (never round, never "
    "reformat 0.647 into 64.7\\%%); together the table and the rewritten paragraph must keep EVERY number the paragraph "
    "had, so nothing is lost.\n"
    "- Paragraph: 1 to 3 numbers (the decisive ones, e.g. the largest effect, stay in the prose), copied verbatim; cite the table as Table~\\ref{%s} "
    "where the reader needs the rest; keep every \\cite and \\ref, keep the meaning and tone, add no new number, "
    "embed no table or \\begin environment, use no dashes, write percent signs as \\%%, and do not describe a number "
    "as shown in a figure or table that does not carry it.\n")


def _tabulate_dense_paragraph(chat, model, orig, label, ptr=None, covered=frozenset()):
    """TABLE path of the density rule: the model lays the paragraph's statistics out as rows plus a slimmed paragraph,
    the code builds the booktabs table and re-checks every rule deterministically. Contract: GROUNDED (no number in
    table or caption that the paragraph did not contain) and LOSSLESS (every result number of the original survives
    in the paragraph, the table, or the float `ptr` -- but only if the rewritten paragraph actually cites it).
    Returns (paragraph, table tex, table tokens) or ('', '', set()) after 3 rejected answers, each retry told exactly
    why the last one was rejected."""
    onums = set(_para_nums(orig))
    otoks = _toks(orig)
    ofloats = []
    for x in onums:
        try:
            ofloats.append(float(_nkey(x)))
        except Exception:
            pass
    ptr_lab = re.search(r"\\ref\{([^}]+)\}", ptr or "")
    already = sorted(set(_nkey(x) for x in onums) & set(covered)) if ptr_lab else []
    why = ""
    for _ in range(3):
        p = _DENS_TABLE_PROMPT % label
        if already:
            p += ("- %s already carries these numbers of the paragraph: %s. If the rewritten paragraph cites it, they "
                  "may be left out of both the table and the prose.\n" % (ptr, ", ".join(already)))
        p += "\n" + orig.strip()
        if why:
            p += "\n\nYour previous answer was REJECTED because " + why + ". Answer again, fixing exactly that."
        got = re.sub(r"^```[a-zA-Z]*\n?|\n?```$", "", (chat(p, model, 1800, label="density-table") or "").strip()).strip()
        got = got.replace("**", "").replace("\r\n", "\n")
        if not got:
            # An EMPTY reply is not a format slip, it is the always-reasoning backbone (flash) burning the whole
            # budget on thinking -- and chat() already retried it once at triple budget. Re-sending the same prompt
            # twice more cost the deepseek harness run ~6 dead calls per paragraph; go straight to the rewrite path.
            print("    [stage3] density-table: empty answer (reasoning budget exhausted), not retrying the table")
            return "", "", set()
        m = re.search(r"CAPTION:\s*(.*?)\s*\n\s*TABLE:\s*(.*?)\s*PARAGRAPH:\s*(.*)$", got, re.S)
        if not m:
            why = "it did not follow the CAPTION / TABLE / PARAGRAPH layout"
            continue
        cap, rows_txt, para = m.group(1).strip(), m.group(2).strip(), m.group(3).strip()
        rows = [[c.strip() for c in ln.strip().strip("|").split("|")]
                for ln in rows_txt.splitlines() if ln.strip() and not re.fullmatch(r"[\s|:=-]+", ln)]
        why = _table_rows_problem(rows, cap, otoks)
        if why:
            continue
        para = _unicode_hygiene(_dedash_tex(re.sub(r"(?<!\\)%", r"\\%", para)))   # '31%' would comment out the line; map dashes/Greek
        nn = _para_nums(para)
        if any(len(_para_nums(c)) > 3 for c in para.split("\n\n") if c.strip()):
            why = "the rewritten paragraph still carries more than 3 numbers (%s)" % ", ".join(nn[:6])
            continue
        if not nn:
            why = "the rewritten paragraph keeps no number at all; keep the single decisive one (e.g. the largest effect) in the prose"
            continue
        if not all((x in onums) or _num_grounded(_nkey(x), ofloats) for x in nn):
            why = "the rewritten paragraph contains a number the original did not have"
            continue
        if ("\\ref{%s}" % label) not in para:
            why = "the rewritten paragraph does not cite Table~\\ref{%s}" % label
            continue
        if "\\begin{" in para or para.count("$") % 2 or para.count("{") != para.count("}") or re.search(r"(?<!\\)[&#]", para):
            why = "the rewritten paragraph embeds an environment, has unbalanced $ or braces, or a bare & or #"
            continue
        if para.count("\\cite") < orig.count("\\cite") or para.count("\\ref") < orig.count("\\ref") + 1:
            why = "the rewritten paragraph dropped a \\cite or \\ref"
            continue
        if re.search(r"[—–]|---|(?<=\S)\s+--\s+(?=\S)", para):
            why = "the rewritten paragraph uses a dash as punctuation"
            continue
        if re.search(r"[^\x00-\x7f]", para):               # Greek/symbols outside math never reach the PDF under T1
            why = "the rewritten paragraph has a non-ASCII character (write symbols in math, e.g. $\\eta^2$)"
            continue
        if re.search(r"^\s*(?:Note|Notes|Explanation|Changes?)\s*:", para, re.M):
            why = "the answer appended a note after the paragraph; output only the paragraph text"
            continue
        if len(para) < 0.35 * len(orig):
            why = "the rewritten paragraph is too short (keep the meaning; only the numbers move)"
            continue
        ttoks = _toks("\n".join(" ".join(r) for r in rows)) | _toks(cap)
        kept = _toks(para) | ttoks
        if ptr_lab and ("\\ref{%s}" % ptr_lab.group(1)) in para:
            kept |= set(covered)
        lost = sorted(x for x in onums if _nkey(x) not in kept)
        if lost:
            why = "these numbers of the original were lost (put them in the table or the paragraph): " + ", ".join(lost)
            continue
        return para, _build_table(rows, cap, label), ttoks
    print("    [stage3] density-table: gave up (%s)" % why)
    return "", "", set()


def _fix_density(chat, model, tex):
    """Enforce the number-density rule POST-HOC: at most 3 result numbers per prose paragraph, NO exemption --
    the same rule paperlint applies. (Until 2026-09-01 this pass still exempted the densest paragraph 'up to 10'
    after lint had dropped that allowance on 08-31: the fixer skipped exactly the paragraph lint then failed, so no
    number of self-heal replays could go green. rruff_raman sat red through two Sonnet-5 rounds on an 8-number
    paragraph the pass never touched.)
    Three ways out, per paragraph: (1) a lossless TABLE when the paragraph is a group of statistics written as prose
    (>= 4 'name = number' and >= 5 distinct numbers): the model lays out rows, the code builds the booktabs table and
    proves nothing was invented and nothing was lost; (2) the guarded REWRITE that keeps the <= 3 decisive numbers
    and points at the float already carrying the rest (subset guard: may drop numbers, never invent); (3) per-sentence
    rewrite + verbatim split; a paragraph with >= 5 numbers that survived all of that gets the table as a last resort.
    Whatever is still dense is named in the log, so a red round says WHICH paragraph, not just 'red'."""
    tex = _mathify_underscores(tex)                        # 'x\_j' prose variables -> real math, deterministically
    # SECTION-level scoping, same knife as paperlint: split on \section and only treat Results/Discussion/
    # Conclusion segments. (The old per-block heading search assumed '\section' starts its own block; in the
    # real assembled tex headings glue to the preceding paragraph and the whole Results section fell out of
    # scope -- the pass found 0 dense paragraphs while lint counted 6.)
    parts = re.split(r"(\\section\*?\{[^}]*\})", tex)
    seg_blocks, cands = {}, []                             # seg index -> block list; candidates (pi, bi, head, orig, n, distinct)
    _env_re = re.compile(r"\\begin\{(\w+\*?)\}.*?\\end\{\1\}|(?<!\\)\\\[.*?\\\]", re.S)   # envs and \[..\] display math
    for pi in range(1, len(parts), 2):
        name = re.match(r"\\section\*?\{([^}]*)\}", parts[pi]).group(1)
        if not paperlint._is_results_section(name):        # ONE classifier for checker and fixer (they drifted once)
            continue
        blocks = (parts[pi + 1] if pi + 1 < len(parts) else "").split("\n\n")
        seg_blocks[pi] = blocks
        for bi, b in enumerate(blocks):
            head_m = re.match(r"^\s*(?:(?:\\(?:sub)+section\*?\{[^}]*\}\s*\n)+)", b)   # glued subsection heads
            head = head_m.group(0) if head_m else ""
            body = b[len(head):]
            # A block with an environment glued in (a display equation mid-paragraph, a figure with no blank line
            # before it) is handled as its PROSE FRAGMENTS around the environments -- exactly how lint counts it,
            # stripping the environment and counting the prose on either side. The environment is never touched.
            frags, last = [], 0
            for m in _env_re.finditer(body):
                frags.append((last, body[last:m.start()])); last = m.end()
            frags.append((last, body[last:]))
            for start, frag in frags:
                # the same 80-char floor lint uses: a shorter dense paragraph is red for lint, so it is a candidate
                if "\\caption" in frag or len(frag.strip()) <= 80 or len(_para_nums(frag)) <= 3:
                    continue
                cands.append((pi, bi, head if start == 0 else "", frag, len(_para_nums(frag)),
                              len(set(_nkey(x) for x in _para_nums(frag)))))
    # most DISTINCT numbers first: that paragraph is the one that gets a table; paragraphs restating a subset of it
    # are handled after and pointed at the table instead of growing another.
    dense = sorted(cands, key=lambda x: (-x[5], -x[4]))
    if not dense:
        return "".join(parts)

    def _put(pi, bi, head, orig, new):
        """Swap one candidate (a whole block, or a prose fragment of a block) for its fix; False if it is gone."""
        blk = seg_blocks[pi][bi]
        if (head + orig) not in blk:
            return False
        seg_blocks[pi][bi] = blk.replace(head + orig, head + new, 1)
        return True
    cov = _float_coverage(tex)                             # label -> numeric tokens each existing float carries
    _tl = re.search(r"\\label\{(tab:[^}]+)\}", tex) or re.search(r"\\label\{(fig:[^}]+)\}", tex)
    default_ptr = ("Table~\\ref{%s}" % _tl.group(1) if _tl and _tl.group(1).startswith("tab:")
                   else ("Figure~\\ref{%s}" % _tl.group(1) if _tl else "the figures and tables"))
    used_labels = set(re.findall(r"\\label\{([^}]+)\}", tex))
    fixed, left, added = 0, [], []

    def _try_table(pi, bi, head, orig, ptr, covered):
        n = 1
        while ("tab:dens%d" % n) in used_labels:
            n += 1
        lab = "tab:dens%d" % n
        para, tab_tex, ttoks = _tabulate_dense_paragraph(chat, model, orig, lab, ptr, covered)
        if not para:
            return False
        if not _put(pi, bi, head, orig, para + "\n\n" + tab_tex):
            return False
        used_labels.add(lab); added.append(lab)
        cov[lab] = ttoks                                   # later paragraphs point at it instead of growing another
        print("    [stage3] density: '%s...' -> %s (%d numeric tokens in the table, paragraph keeps %d)"
              % (re.sub(r"\s+", " ", orig.strip())[:45], lab, len(ttoks), len(_para_nums(para))))
        return True

    for pi, bi, head, orig, cnt, _dcnt in dense:
        onums = set(_para_nums(orig))
        pointer, ptr_lab, covered = _best_pointer(onums, cov, default_ptr)
        uncovered = set(_nkey(x) for x in onums) - covered
        tabular_first = _looks_tabular(orig, onums) and len(uncovered) >= 4
        table_why = ""
        if tabular_first:
            if _try_table(pi, bi, head, orig, pointer, covered):
                fixed += 1
                continue
            table_why = "table rejected 3x"
        already = sorted(set(_nkey(x) for x in onums) & covered)
        # The pointer sentence must stay TRUE: the model is told exactly which of the paragraph's numbers the
        # pointed-at float carries, and that anything else may be dropped but never described as 'reported in'
        # that float (the first Sonnet replay wrote 'the hyperparameter grids are reported in Table 1' about a
        # table that holds only eta-squared and p). One pointer per paragraph, or the table gets cited nine times.
        prompt = ("Rewrite this LaTeX paragraph so NO single paragraph carries more than 3 numeric results. "
                  "If it holds many decisive numbers, SPLIT it into 2-3 shorter paragraphs (blank line between "
                  "them), each developing one idea with at most 3 numbers; drop or qualify the non-decisive "
                  "numbers. "
                  + ("%s carries these numbers of the paragraph and ONLY these: %s. You may drop them from the "
                     "prose and refer the reader to %s for them (at most ONE such pointer in the whole rewrite, "
                     "and none if the paragraph already cites it). Any other number is NOT in that float: keep it "
                     "within the budget or drop it, but never say it is reported, given or shown there. "
                     % (pointer, ", ".join(already), pointer) if already else
                     "Numbers you drop must simply be dropped, or qualified in words; do not claim they are shown "
                     "in a table or figure unless the paragraph already cites the figure that shows them. ")
                  + "COPY every kept number VERBATIM, character for character (never reformat 0.647 into 64.7\\% or "
                  "round it). Keep every \\cite, \\ref and math environment intact, add NO new numbers, write percent "
                  "signs as \\%, keep the meaning and tone. Output ONLY the rewritten text.\n\n" + orig)
        ofloats = []
        for x in onums:
            try:
                ofloats.append(float(_nkey(x)))
            except Exception:
                pass
        done, why = False, ""
        # The rewrite model gets 3 shots; the 4th candidate is the per-sentence rewrite plus the deterministic
        # split, because on the hardest paragraphs flash NEVER answers -- measured on the plant paper's 21-number
        # paragraph: finish='length' with 0 content and 9.4k/12.2k completion tokens spent entirely on reasoning,
        # at both budgets. Raising the cap makes it burn more, not answer.
        for _attempt in range(4):
            if _attempt == 3:
                shrunk = _shrink_dense_sentences(chat, model, orig, pointer) or orig
                out = _split_dense_paragraph(shrunk) or shrunk   # a shrink that already fits needs no split
                if shrunk != orig:
                    print("    [stage3] density: 3 paragraph rewrites rejected (%s); per-sentence rewrite%s applied"
                          % (why, " + split" if out != shrunk else ""))
            else:
                # attempts 2 and 3 carry the rejection reason: the same prompt re-sent blind produced the same
                # 4-number rewrite twice on the stead robustness paragraph
                p_i = prompt if not why else (prompt + "\n\nYour previous rewrite was REJECTED because it was %s. "
                                              "Rewrite again, fixing exactly that." % why)
                out = re.sub(r"^```[a-zA-Z]*\n?|\n?```$", "",
                             (chat(p_i, model, 1400, label="density") or "").strip()).strip()
            out = _unicode_hygiene(_dedash_tex(re.sub(r"(?<!\\)%", r"\\%", out)))   # escape '%', map dashes/Greek before judging
            nn = _para_nums(out)
            # a kept number counts as grounded if it appears verbatim OR is an equivalent form of a real one
            # (percent<->fraction, rounding) -- the strict verbatim-subset guard rejected every rewrite when
            # flash reformatted 0.647 as 64.7%.
            grounded = all((x in onums) or _num_grounded(_nkey(x), ofloats) for x in nn)
            per_para_ok = all(len(_para_nums(p)) <= 3 for p in out.split("\n\n") if p.strip())
            if (out and per_para_ok and grounded and len(out) >= 0.5 * len(orig)
                    and out.count("\\ref") >= orig.count("\\ref") and out.count("\\cite") >= orig.count("\\cite")
                    and out.count("$") % 2 == 0 and out.count("{") == out.count("}")
                    and not re.search(r"(?<!\\)[&#]", out) and not re.search(r"[^\x00-\x7f]", out)
                    and _put(pi, bi, head, orig, out)):
                fixed += 1; done = True
                break
            why = ("empty" if not out else "still >3 per paragraph" if not per_para_ok else "ungrounded number"
                   if not grounded else "too short" if len(out) < 0.5 * len(orig) else "dropped ref/cite or bad LaTeX")
        if done:
            continue
        if not tabular_first and len(onums) >= 5:
            if _try_table(pi, bi, head, orig, pointer, covered):
                fixed += 1
                continue
            table_why = "last-resort table rejected 3x"
        left.append("%d numbers; rewrite: %s%s: '%s...'" % (cnt, why, ("; " + table_why) if table_why else "",
                                                             re.sub(r"\s+", " ", orig.strip())[:60]))
    for pi, blocks in seg_blocks.items():
        parts[pi + 1] = "\n\n".join(blocks)
    print("  [stage3] density pass: fixed %d of %d dense paragraph(s)%s"
          % (fixed, len(dense), (", added " + ", ".join(added)) if added else ""))
    for item in left:
        print("    [stage3] density: NOT fixed -> " + item)
    return "".join(parts)


def _cite_coverage(chat, model, tex, catalog, target=20):
    """The reader-visible References list holds only CITED entries. Natural writing tops out around 7-14
    unique keys, so weave genuinely relevant UNUSED catalog entries into the Introduction's closing and the
    Discussion's prior-work paragraphs. Guards: new \\cite keys must come from the unused set, numbers are
    untouched, and a paragraph that cannot absorb more is left alone -- coverage, never padding."""
    def _cited(s):
        return set(k.strip() for grp in re.findall(r"\\cite[a-zA-Z]*\{([^}]*)\}", s) for k in grp.split(",") if k.strip())
    have = _cited(tex)
    unused = [(k, p) for k, p in (catalog or []) if k not in have]
    if len(have) >= target or not unused:
        return tex
    menu = "\n".join("\\cite{%s} = %s (%s)" % (k, str(p.get("title", ""))[:90], p.get("year", "")) for k, p in unused[:25])
    parts = re.split(r"(\\section\*?\{[^}]*\})", tex)
    woven = 0
    for pi in range(1, len(parts), 2):
        name = re.match(r"\\section\*?\{([^}]*)\}", parts[pi]).group(1).lower()
        if not ("introduc" in name or "discussion" in name or "related" in name):
            continue
        if len(_cited("".join(parts))) >= target:
            break
        blocks = parts[pi + 1].split("\n\n")
        # up to THREE paragraphs per section, each offered only the works still unused: one paragraph per section
        # topped out at 12-14 unique keys on the dna paper (floor 15) run after run, so coverage never converged
        eligible = [i for i, b in enumerate(blocks) if len(b.strip()) > 200 and "\\begin{" not in b][:3]
        for bi in eligible:
            if len(_cited("".join(parts))) >= target:
                break
            have_now = _cited("".join(parts))
            still = [(k, p) for k, p in (catalog or []) if k not in have_now]
            if not still:
                break
            menu = "\n".join("\\cite{%s} = %s (%s)" % (k, str(p.get("title", ""))[:90], p.get("year", "")) for k, p in still[:25])
            orig = blocks[bi]
            out = re.sub(r"^```[a-zA-Z]*\n?|\n?```$", "", (chat(
                "Expand this LaTeX paragraph by weaving in the RELEVANT works below where they genuinely support "
                "or contrast the point -- cite with \\cite{key} using EXACT keys, group related ones, and SKIP any "
                "that do not fit (coverage must never read as padding). Keep every existing sentence's meaning, "
                "every number and every existing \\cite/\\ref unchanged. Output ONLY the paragraph (it may grow to "
                "two paragraphs).\n\nAVAILABLE WORKS:\n" + menu + "\n\nPARAGRAPH:\n" + orig,
                model, 1600, label="citecov") or "").strip()).strip()
            # normalise before judging: a bare % is escaped, dashes/Greek/accents get their LaTeX forms, and only
            # a glyph no hygiene could map rejects the weave (rejecting every em dash threw away good weaves)
            out = _unicode_hygiene(_dedash_tex(re.sub(r"(?<!\\)%", r"\\%", out)))
            newk = _cited(out) - _cited(orig)
            _nocite = lambda s: re.sub(r"\\cite[a-zA-Z]*\{[^}]*\}", "", s)   # keys carry years (smith2020): strip
            if (out and newk and newk <= (set(k for k, _ in still) | have_now)   # before the number guard, or every
                    and _cited(orig) <= _cited(out)                          # weave self-rejects; no existing cite swapped out
                    and out.count("\\ref{") >= orig.count("\\ref{")
                    and not re.search(r"(?<!\\)[&#]", out) and not re.search(r"[^\x00-\x7f]", out)
                    and set(_num_tokens(_nocite(out))) == set(_num_tokens(_nocite(orig)))
                    and out.count("$") % 2 == 0 and out.count("{") == out.count("}") and len(out) >= len(orig)):
                blocks[bi] = out
                parts[pi + 1] = "\n\n".join(blocks)
                woven += len(newk)
    if woven:
        print("  [stage3] citation coverage: wove %d additional reference(s), now %d unique cited"
              % (woven, len(_cited("".join(parts)))))
    return "".join(parts)


def _display_long_math(tex, limit=28):
    """A long inline formula cannot break across lines, so it protrudes into the margin (whoi_plankton: 41 pt from
    an inline \\max_{...} expression, identical on every replay because the prose is checkpointed). Inline math whose
    PRINTED length (commands count as one glyph, \\mathrm{NCC} as its letters) exceeds `limit` characters becomes
    display math. Captions, tabulars and headings are left alone; display math does not belong there."""
    keep = []

    def _hold(m):
        keep.append(m.group(0))
        return "\x00K%d\x00" % (len(keep) - 1)
    s = re.sub(r"\\caption(?:\[[^\]]*\])?\{(?:[^{}]|\{(?:[^{}]|\{[^{}]*\})*\})*\}|\\(?:sub)*section\*?\{[^}]*\}"
               r"|\\begin\{tabular\*?\}.*?\\end\{tabular\*?\}", _hold, tex or "", flags=re.S)

    def _printed(body):
        body = re.sub(r"\\(?:mathrm|mathbf|mathit|mathcal|text|operatorname)\{([^{}]*)\}", r"\1", body)
        body = re.sub(r"\\[a-zA-Z]+", "x", body)            # a command prints as about one glyph
        return len(re.sub(r"[{}^_\\\s]", "", body))

    def _conv(m):
        inner = m.group(1) if m.group(1) is not None else m.group(2)
        if _printed(inner) > limit:
            return "\\[ " + inner.strip() + " \\]"
        return m.group(0)
    s = re.sub(r"\\\((.*?)\\\)|(?<![\\$])\$([^$\n]+?)\$(?!\$)", _conv, s, flags=re.S)
    for i, k in enumerate(keep):
        s = s.replace("\x00K%d\x00" % i, k)
    return s


def _unicode_hygiene(s):
    """Last-mile glyph hygiene for text written by the POST passes (polish, coverage, density, annotate): the writer's
    sections went through paper._sanitize_body, these did not. Under T1 fontenc a U+2212 minus, an en dash or a
    '<=' sign is silently DROPPED ('r = -0.42' prints as 'r = 0.42'), while 'x', degree and micro print as wrong
    glyphs with no warning at all. Greek letters and operators become math outside math and bare commands inside."""
    import paper                                           # local: the module-level alias in this file is _paper
    import unicodedata
    _caps = {"Gamma", "Delta", "Theta", "Lambda", "Xi", "Pi", "Sigma", "Upsilon", "Phi", "Psi", "Omega"}
    _latin = {"Alpha": "A", "Beta": "B", "Epsilon": "E", "Zeta": "Z", "Eta": "H", "Iota": "I", "Kappa": "K", "Mu": "M",
              "Nu": "N", "Omicron": "O", "Rho": "P", "Tau": "T", "Chi": "X"}

    def _greek(ch):                                        # any Greek letter paper._UNI does not list (eta was missing)
        try:
            m = re.match(r"GREEK (SMALL|CAPITAL) LETTER ([A-Z]+)", unicodedata.name(ch))
        except ValueError:
            return None
        if not m:
            return None
        base = {"lamda": "lambda"}.get(m.group(2).lower(), m.group(2).lower())
        if m.group(1) == "SMALL":
            return "\\" + base
        cap = base.capitalize()
        return ("\\" + cap) if cap in _caps else _latin.get(cap, cap)

    greek = {u: t for u, t in paper._UNI.items()}
    for cp in range(0x391, 0x3CA):
        if chr(cp) not in greek and _greek(chr(cp)):
            greek[chr(cp)] = _greek(chr(cp))
    spans = []
    # (?<!\\) : the two-column header's '\\[0.6em]' row spacing is not a display-math opener (same bug lint had)
    s = re.sub(r"\\begin\{(equation|align|eqnarray|displaymath|gather)\*?\}.*?\\end\{\1\*?\}|(?<!\\)\\\[.*?\\\]|\\\(.*?\\\)|\$[^$]*\$",
               lambda m: spans.append(m.group(0)) or "\x00H%d\x00" % (len(spans) - 1), s or "", flags=re.S)
    for u, t in greek.items():                             # outside math: '$\theta$', and 'θ_E' -> '$\theta_{E}$'
        if t.startswith("\\"):
            s = re.sub(re.escape(u) + r"(?:_\{?([A-Za-z0-9]+)\}?)?",
                       lambda m, t=t: "$" + t + ("_{%s}" % m.group(1) if m.group(1) else "") + "$", s)
        else:
            s = s.replace(u, t)
    for u, t in paper._UNI2.items():
        s = s.replace(u, t)
    for u, t in paper._UNI_ACCENT.items():
        s = s.replace(u, t)
    s = s.replace("\u2212", "-").replace("\u00b5", "$\\mu$").replace("\u00b0", "$^{\\circ}$")
    for i, sp in enumerate(spans):
        for u, t in greek.items():
            sp = sp.replace(u, (t + " ") if t.startswith("\\") else t)
        for u, t in paper._UNI2.items():
            sp = sp.replace(u, t.strip("$") + " ")
        sp = sp.replace("\u2212", "-").replace("\u00b5", "\\mu ").replace("\u00b0", "^{\\circ}")
        s = s.replace("\x00H%d\x00" % i, sp)
    return s


def _fix_unbalanced_envs(tex):
    """Deterministically remove ORPHAN \\begin{env}/\\end{env} halves. A lone '\\end{equation}' shipped by
    the writer killed a compile, and the failure-fallback chain then rebuilt from the PRE-polish snapshot --
    silently discarding every post-pass improvement (density, mathify, proofread). Orphan halves are deleted
    (the prose survives); balanced pairs are untouched."""
    for env in ("equation", "equation*", "align", "align*", "eqnarray", "displaymath"):
        b_pat, e_pat = "\\begin{%s}" % env, "\\end{%s}" % env
        if tex.count(b_pat) == tex.count(e_pat):
            continue
        out, open_pos, removed = [], [], 0
        for tok in re.split(r"(\\(?:begin|end)\{%s\})" % re.escape(env), tex):
            if tok == b_pat:
                if open_pos:                               # a begin while one is open: the EARLIER one is the orphan
                    out[open_pos.pop()] = ""; removed += 1   # (dropping the LATER one, as before, swallowed the prose
                open_pos.append(len(out)); out.append(tok)   #  in between into display math)
            elif tok == e_pat:
                if not open_pos:
                    removed += 1; continue                 # orphan end -> drop
                open_pos.pop(); out.append(tok)
            else:
                out.append(tok)
        for j in open_pos:                                 # still-unclosed begins -> drop
            out[j] = ""; removed += 1
        tex = "".join(out)
        if removed:
            print("  [stage3] env-balance: removed %d orphan %s delimiter(s)" % (removed, env))
    return tex


def _pmap(fn, items, tag):
    """Order-preserving parallel map for independent per-section LLM calls. OMNIST_SERIAL_WRITE=1 forces the
    serial path. Per-item isolation (audit item 1): a completed item's result is NEVER discarded or re-run --
    only the items that actually failed get one serial retry each, and an item that fails twice re-raises
    (fail loud, never a silent hole)."""
    if os.environ.get("OMNIST_SERIAL_WRITE") or len(items) <= 1:
        return [fn(x) for x in items]
    results = [None] * len(items)
    failed = []
    try:
        from concurrent.futures import ThreadPoolExecutor
        with ThreadPoolExecutor(max_workers=min(6, len(items))) as ex:
            futs = {ex.submit(fn, x): i for i, x in enumerate(items)}
            for fut, i in futs.items():
                try:
                    results[i] = fut.result()
                except Exception as e:
                    failed.append((i, type(e).__name__))
    except Exception as e:                                 # executor itself unavailable -> plain serial
        print("  [stage3] %s parallel unavailable (%s) -> serial" % (tag, type(e).__name__))
        return [fn(x) for x in items]
    for i, err in failed:
        print("  [stage3] %s item %d failed in parallel (%s) -> one serial retry" % (tag, i, err))
        results[i] = fn(items[i])                          # raises on second failure: loud, not silent
    return results


def _split_float_tail(body, pattern=r"\n*\\end\{document\}.*$"):
    m = re.search(pattern, body, re.S)
    if m:
        return body[:m.start()], body[m.start():]
    return body, ""


def _structure_sections(chat, model, tex):
    """SECOND-ROUND structure pass: add \\subsection headings where a section has distinct parts -- the way a writer
    (or Sakana's multi-round edit) naturally structures a section it just finished. Our first-round writer expands a
    FLAT list of paragraph jobs, so structure never emerges there; rather than pre-planning it rigidly per field, we
    let the model decide it AFTER the prose exists. For each long-enough \\section, ONE dedicated call inserts 2-4
    \\subsection{} headings at natural paragraph boundaries. It may ONLY add heading lines: a deterministic guard
    reverts any section whose prose (with \\subsection lines stripped + whitespace normalized) is not IDENTICAL to the
    input -- so this pass can never alter a number, cite, ref, figure, or word. A single-topic section is left as-is."""
    def _norm(s):
        return re.sub(r"\s+", " ", re.sub(r"\\subsection\*?\{[^}]*\}", "", s or "")).strip()
    parts = re.split(r"(\\section\*?\{[^}]*\})", tex)
    if len(parts) < 3:
        return tex
    rebuilt, added = [parts[0]], 0
    def _one(args):
        header, body, tail = args
        _hn = (re.search(r"\{([^}]*)\}", header) or [None, ""])
        _hn = (_hn.group(1) if hasattr(_hn, "group") else "").lower()
        # the Introduction (and Conclusion) flow as continuous prose in every field -> never sub-section them; also skip
        # short or already-structured sections.
        if any(k in _hn for k in ("introduction", "conclusion")) \
                or len(re.findall(r"\w+", body)) < 180 or "\\subsection" in body:
            return header + body + tail, 0
        prompt = ("Here is ONE section of a research paper. If it covers clearly distinct parts, insert 2 to 4 "
                  "\\subsection{Short Title} headings, each on its OWN line immediately before the paragraph that begins "
                  "that part, so the section reads with sub-headings like a well-structured paper. INSERT HEADING LINES "
                  "ONLY: do NOT change, reorder, add, or delete any other text, number, \\cite, \\ref, figure, table, or "
                  "equation. If the section is genuinely single-topic, return it UNCHANGED. Keep the leading \\section "
                  "line. Return the full section, no code fences.\n\n" + header + body)
        try:
            out = re.sub(r"^```[a-zA-Z]*\n?|\n?```$", "", (chat(prompt, model, 3500) or "").strip()).strip()
        except Exception as e:                             # fail CLOSED: the section stays as written
            print("  [stage3] structure: section call failed (%s) -> kept as written" % type(e).__name__)
            return header + body + tail, 0
        out_body = re.sub(r"^\s*\\section\*?\{[^}]*\}", "", out).strip()
        heads = re.findall(r"\\subsection\*?\{([^}]*)\}", out_body)
        # _norm collapses ALL whitespace, so paragraph breaks were outside the 'verbatim' check: a model that glued
        # three paragraphs into one passed and handed density/lint a number wall. Count paragraphs too, keep headings
        # plain ASCII without LaTeX specials (a '50% threshold' heading comments out its own line), and move a
        # heading glued to the end of the previous line onto its own block so blank-line-based passes see it.
        _paras = lambda s: [p for p in re.split(r"\n\s*\n", re.sub(r"\\subsection\*?\{[^}]*\}", "", s or "")) if p.strip()]
        if (out_body and out_body.count("\\subsection") >= 1 and _norm(out_body) == _norm(body)
                and len(_paras(out_body)) == len(_paras(body))
                and not any(re.search(r"(?<!\\)[%&#_^]|[^\x00-\x7f]", h) for h in heads)):
            out_body = re.sub(r"(?<!\n)\s*(\\subsection\*?\{[^}]*\})\s*", r"\n\n\1\n", out_body).strip()
            return header + "\n" + out_body + "\n" + tail, out_body.count("\\subsection")
        return header + body + tail, 0                       # prose not preserved verbatim, or nothing added -> revert

    items = []
    for i in range(1, len(parts), 2):
        body, tail = _split_float_tail(parts[i + 1] if i + 1 < len(parts) else "")
        items.append((parts[i], body, tail))
    results = _pmap(_one, items, "structure")
    rebuilt += [t for t, _ in results]
    added = sum(n for _t, n in results)
    print("  [stage3] structure: inserted %d subsection heading(s) (prose preserved verbatim)" % added)
    return "".join(rebuilt)


def _polish_tex(chat, model, tex, known_cites, gfloats, forbidden, real_models, rounds=1):
    """GUARDED PER-SECTION polish. A single whole-document rewrite of a 10+ page paper is both slow (many minutes /
    frequently truncates) and fragile (one bad token reverts the whole pass), so instead we polish each \\section body
    INDEPENDENTLY with a bounded call and deterministically REVERT only the sections that break a guard (a cite outside
    the real bib, >=2 NEW ungrounded result-numbers, a NEW over-claim word, a model never run, or a truncated return).
    Fast, and one bad section can never corrupt the rest. Presentation only: tighten prose, de-hedge (Results should
    REPORT findings, not re-qualify every sentence), add \\subsection/\\paragraph structure to long Methods/Experiments
    sections SPARINGLY, display a key equation -- never touching numbers, citations, refs, figures, or claim strength."""
    import writer as _writer
    parts = re.split(r"(\\section\*?\{[^}]*\})", tex)
    if len(parts) < 3:                                     # no \section structure -> nothing safe to split on
        print("  [stage3] polish: skipped (no \\section structure)"); return tex
    def _one(args):
        header, body, tail = args
        if len(body.strip()) < 220:                        # too short to benefit -> leave as-is
            return header + body + tail, None
        prompt = ("You are polishing ONE section of a LaTeX research paper for a top venue. Improve ONLY this section's "
                  "presentation:\n"
                  "- tighten and de-duplicate prose; remove repeated sentences and repeated statements of the same "
                  "result;\n"
                  "- de-hedge: state any scope caveat at most ONCE; a Results section should REPORT findings, not "
                  "re-qualify every sentence (repeated self-protective qualifiers read as machine hedging).\n"
                  "This is a PROSE-ONLY pass. Do NOT change, add, or remove any NUMBER, any \\cite key, any \\ref/\\label, "
                  "any figure, table, or equation environment (keep EVERY \\begin{figure}/\\begin{table}/\\begin{equation} "
                  "and \\includegraphics exactly as-is, in place); do NOT strengthen any claim or rename any method/model. "
                  "Keep the leading \\section line. Return ONLY this section's LaTeX in full, no code fences.\n\n"
                  + header + body)
        try:
            out = re.sub(r"^```[a-zA-Z]*\n?|\n?```$", "", (chat(prompt, model, 3500) or "").strip()).strip()
        except Exception as e:                             # fail CLOSED: the section stays as written, stage 3 goes on
            print("  [stage3] polish: section call failed (%s) -> kept as written" % type(e).__name__)
            return header + body + tail, False
        out_body = re.sub(r"^\s*\\section\*?\{[^}]*\}", "", out).strip()      # drop a leaked header; we re-prepend a clean one
        # reject a truncated/unbalanced return: a cut-off tail leaves an odd number of $ (unclosed inline math), an
        # unbalanced brace, or a dangling trailing backslash -- any of which breaks compilation (the "Missing $" class).
        balanced = (out_body.count("$") % 2 == 0 and out_body.count("{") == out_body.count("}")
                    and not re.search(r"\\\s*$", out_body))
        # reject a return truncated MID-SENTENCE that still happens to be brace-balanced (e.g. cut after all equations at
        # "...cross-validation to produce"): a finished section ends on sentence punctuation or a closed env/paren/math,
        # never on a bare word/comma/digit. This is the guard the length+balance checks miss when the cut is near the end.
        _tail_ok = bool(re.search(r"[.!?})\]$]\s*$", out_body))
        # polish is PROSE-ONLY: revert a section whose figure/table/equation/includegraphics counts changed -- it must
        # neither DROP a \begin{figure} while "tightening" nor INVENT extra display equations (the writer + assembler own
        # the structural elements; polish only tightens the words around them).
        _env = lambda s: (s.count("\\begin{figure}"), s.count("\\begin{table}"), s.count("\\begin{tabular}"),
                          s.count("\\begin{equation}"), s.count("\\includegraphics"),
                          s.count("\\end{figure}"), s.count("\\end{table}"), s.count("\\end{tabular}"),
                          s.count("\\end{equation}"),        # a dropped \end{} compiled to a failure that reverted EVERY pass
                          s.count("%WIDE"))               # the wide-float marker must survive polish (reskin needs it)
        ok = (len(out_body) >= 0.5 * len(body.strip()) and balanced and _tail_ok   # truncated / gutted / unbalanced / cut mid-sentence -> revert
              and _env(out_body) == _env(body))                       # dropped a figure / invented an equation -> revert
        if ok:
            # LaTeX safety first: a bare % comments out the rest of its line (invisible to lint, which strips comments
            # too), a bare & or # breaks the compile, and anything non-ASCII is dropped by T1 fontenc -- a U+2212
            # minus sign vanishing turns r=-0.31 into 0.31 in print.
            # normalise first (dashes -> commas, Greek/accents -> LaTeX), then reject only what could not be mapped
            out_body = _unicode_hygiene(_dedash_tex(re.sub(r"(?<!\\)%(?!WIDE)", r"\\%", out_body)))
            if re.search(r"(?<!\\)[&#]", out_body) or re.search(r"[^\x00-\x7f]", out_body):
                ok = False
                _hn = re.search(r"\{([^}]*)\}", header)
                print("  [stage3] polish: section '%s' reverted: a bare & or #, or a glyph hygiene could not map" % (_hn.group(1) if _hn else "?"))
        if ok:
            _ck = lambda s: set(k.strip() for grp in re.findall(r"\\cite[a-zA-Z]*\{([^}]*)\}", s) for k in grp.split(",") if k.strip())
            cites, cites_b = _ck(out_body), _ck(body)
            # polish is a CHANGE-NO-NUMBER pass, so the guard is set EQUALITY of the numeric tokens (cite keys and
            # labels stripped first, they carry years) plus the powers of ten. The old rule counted only NEW tokens,
            # ran each through the +/-2% _num_grounded tolerance and rejected at >= 2, so one 0.73 -> 0.78 edit, a
            # p crossing 0.05, an exponent change or a dropped number all passed (2026-09-01 audit, F1).
            _nk = lambda s: re.sub(r"\\(?:cite[a-zA-Z]*|ref|eqref|label)\{[^}]*\}", " ", s)
            _pow = lambda s: sorted(re.sub(r"\s+", "", x) for x in re.findall(r"10\s*\^\s*\{?[-+]?\d+\}?", s))
            n_out, n_in = set(_num_tokens(_nk(out_body))), set(_num_tokens(_nk(body)))
            new_eno = set(re.findall(r"\b\d+(?:\.\d+)?e-?\d+\b", out_body)) - set(re.findall(r"\b\d+(?:\.\d+)?e-?\d+\b", body))
            rej = ""
            if known_cites and not cites <= set(known_cites): rej = "cite outside the real bib"
            elif not cites_b <= cites: rej = "dropped citation(s) %s" % sorted(cites_b - cites)[:3]
            elif out_body.count("\\ref{") < body.count("\\ref{"): rej = "dropped a \\ref"
            elif set(re.findall(r"\\label\{[^}]*\}", out_body)) != set(re.findall(r"\\label\{[^}]*\}", body)): rej = "label set changed"
            elif n_out != n_in or _pow(out_body) != _pow(body) or new_eno:
                rej = "numbers changed (only in original: %s; only in rewrite: %s)" % (sorted(n_in - n_out)[:5], sorted(n_out - n_in)[:5])
            elif any(len(f) >= 4 and f in out_body.lower() and f not in body.lower() for f in (forbidden or [])): rej = "a forbidden claim word appeared"
            elif (_writer._models_in(out_body) - _writer._models_in(body)) - set(real_models or []): rej = "an unrun model was named"
            if rej:
                ok = False
                _hn = re.search(r"\{([^}]*)\}", header)
                print("  [stage3] polish: section '%s' reverted: %s" % (_hn.group(1) if _hn else "?", rej))
        if ok:
            return header + "\n" + out_body + "\n" + tail, True
        return header + body + tail, False

    items = []
    for i in range(1, len(parts), 2):
        # keep the bibliography block AND \end{document} (+ anything after) OUT of the polish body: the assembler
        # appends them right after the LAST section, so they land inside that section's polish chunk -- a truncated
        # return would silently drop them.
        body, tail = _split_float_tail(
            parts[i + 1] if i + 1 < len(parts) else "",
            r"\n*(?:\\FloatBarrier|\\bibliographystyle\{|\\bibliography\{|\\end\{document\}).*$")
        items.append((parts[i], body, tail))
    results = _pmap(_one, items, "polish")
    rebuilt = [parts[0]] + [t for t, _f in results]
    kept = sum(1 for _t, f in results if f is True)
    total = sum(1 for _t, f in results if f is not None)
    result = "".join(rebuilt)
    if "\\documentclass" not in result or "\\end{document}" not in result:    # assembly lost a required token -> full revert
        print("  [stage3] polish: reverted (assembly integrity check failed)"); return tex
    print("  [stage3] polish: %d/%d section(s) improved (guards held)" % (kept, total))
    return result


def _data_caption(subject, mod):
    """A NORMAL descriptive caption that names the actual data ('Representative frontal chest X-ray radiographs ...'),
    derived from the case subject -- NOT a defensive 'we show the modality' sentence. Trims parentheticals, the leading
    article/measurement, and trailing modifiers (sampled/recorded/from/of...) down to the head noun phrase."""
    s = re.sub(r"\([^)]*\)", " ", str(subject or ""))
    s = re.split(r"[,;]", s)[0].strip()
    s = re.sub(r"^(a|an|one|each|the)\s+", "", s, flags=re.I)
    s = re.sub(r"^(single|individual)\s+", "", s, flags=re.I)
    if re.match(r"^[\d.]+", s):
        s = re.sub(r"^[\d.]+[-\s]*[A-Za-z]*\s+", "", s)
    s = re.split(r"\s+(?:sampled|recorded|captured|taken|drawn|obtained|measured|acquired|collected|from|of|at|per|"
                 r"with|containing|showing|that|which)\b", s, flags=re.I)[0]
    s = " ".join(re.sub(r"\s{2,}", " ", s).strip().split()[:6]) or \
        {"image": "images", "audio": "audio clips", "signal": "signals", "threeD": "point clouds"}.get(mod, "examples")
    noun = s if s.lower().endswith("s") else s + "s"
    if mod == "audio":
        return "Log-frequency spectrograms of representative %s from the dataset (class label above each panel)." % noun
    if mod == "signal":
        return "Representative %s from the dataset (one panel per example, class label above)." % noun
    if mod == "threeD":
        return "Orthographic (XY) projections of representative %s from the dataset." % noun
    if mod == "video":
        return "Representative frames from example %s in the dataset." % noun
    return "Representative %s from the dataset (class label above each panel)." % noun


def _pipeline_stages(chat, model, exp, subject):
    """Ask for 3-5 SHORT ordered method-pipeline stage labels (for the method-overview schematic). Returns a list."""
    p = ("Summarize this study's METHOD as an ordered pipeline of 3 to 5 SHORT stage labels (each AT MOST 5 words, "
         "concrete nouns, NO sentences), from the raw input to the final result/decision. Output ONLY a JSON list of "
         "strings.\n\nSUBJECT: " + str(subject)[:200] + "\nMETHOD: " + str(exp.get("method_summary", ""))[:1200])
    r = re.sub(r"^```[a-zA-Z]*\n?|\n?```$", "", (chat(p, model, 220) or "").strip())
    try:
        return [str(x).strip() for x in json.loads(r) if str(x).strip()][:5]
    except Exception:
        return []


def _insert_lead_figs(tex, block):
    """Insert a pre-composed block (data-exemplar + method-pipeline figures with their \\ref sentences) at the top of
    the first data/results-type section (never the Introduction/Related Work), so the paper shows its raw perception
    input and its method overview where the data is described. (figure -> figure* for two-column styles is handled
    downstream by venue_styles.reskin.)"""
    if not block:
        return tex
    m = re.search(r"\\section\{(?:Data|Experimental[^}]*|Methods?|Results?[^}]*|Theory[^}]*)\}[^\n]*\n", tex)
    if not m:
        m = re.search(r"\\section\{(?!Introduction)(?!Related)[^}]*\}[^\n]*\n", tex)
    if not m:
        return tex
    return tex[:m.end()] + block + tex[m.end():]


def stage3_writeup(task, replay=False):
    """Stage 3: turn the completed stage-1/stage-2 artifacts for `task` into a real, compiled research paper.
    replay=True reuses stages/03_writer_state.json (citations + written sections + thesis) and reruns ONLY
    title/assembly/passes/compile -- the pass-level resume the iterate-in-place rule demands.
    FIELD-AWARE writer: picks a journal STYLE (paper_specs) decoupled from the domain, writes every section
    OUTLINE-then-EXPAND (writer.write_paper) so sections are multi-paragraph, on-length, and cite the real refs,
    then assembles the .tex dynamically in the style's section order (figures interleaved) and compiles (tectonic)."""
    # local thinking backbones (Qwen3.5) spend the whole per-paragraph budget on <think> and return empty prose ->
    # disable thinking for the WRITING stage ONLY (stage 1/2 keep it, reasoning helps ideation/experiment). See pipeline.create().
    os.environ["OMNIST_LOCAL_NOTHINK"] = "1"
    import shutil, paper
    sd = stages_dir(task)
    td = task_dir(task)
    series = json.load(open(os.path.join(td, "series.json")))
    ip, ep = os.path.join(sd, "01_ideation.json"), os.path.join(sd, "02_experiment.json")
    if not (os.path.exists(ip) and os.path.exists(ep)):
        print("[stage3] need 01_ideation.json + 02_experiment.json on disk"); return {"_failed": True, "reason": "no upstream artifacts"}
    idea, exp = json.load(open(ip)), json.load(open(ep))
    # anti-hollow-paper guard: stage 2 must have produced a REAL, gated experiment. If it failed (e.g. hit max_steps
    # without a gated finalize) or carries no analyses / no lead, REFUSE to emit a paper instead of writing a hollow
    # one around empty results -- the pipeline should re-run stage 2 (or backtrack stage 1 to a feasible idea), never
    # fabricate a finished-looking paper from nothing.
    if exp.get("_failed") or not (exp.get("analyses") and str(exp.get("lead", "")).strip()):
        print("[stage3] REFUSING to write a paper: stage 2 produced no gated experiment "
              "(_failed=%r, analyses=%d, lead=%r). Re-run stage 2 or backtrack stage 1 to a feasible idea first."
              % (exp.get("_failed"), len(exp.get("analyses") or []), str(exp.get("lead", "")).strip()))
        return {"_failed": True, "reason": "stage 2 produced no gated experiment; refusing to write a hollow paper"}

    # journal STYLE (decoupled from the research domain) + author voice, from series.json (no domain literals in code)
    C = {"role": str(series.get("role") or "an experienced researcher"),
         "subject": str(series.get("subject") or "the studied system"),
         "field": str(series.get("field") or ""), "style": str(series.get("style") or "")}
    import paper_specs, writer
    style = paper_specs.style_of(C)
    print("[stage3] journal style: %s | %s" % (style, " -> ".join(paper_specs.FIELD_SPECS[style]["order"])))
    obs = str(series.get("subject", "")).strip()[:700]
    idea_text = (str(idea.get("research_question", "")).strip() + " " + str(idea.get("hypothesis", "")).strip()).strip()

    # REPLAY: reuse the saved writer state (citations + sections + thesis) and rerun only what comes after.
    _ws_path = os.path.join(sd, "03_writer_state.json")
    _ws = None
    if replay and os.path.exists(_ws_path):
        _ws = json.load(open(_ws_path))
        print("[stage3] REPLAY: reusing saved citations/sections/thesis (skipping the ~20min writing phase)")
    elif replay and os.path.exists(os.path.join(sd, "03_sections.json")) \
            and os.path.exists(os.path.join(sd, "latex_03_paper", "references.bib")):
        _bibtxt = open(os.path.join(sd, "latex_03_paper", "references.bib")).read()
        _ws = {"out": json.load(open(os.path.join(sd, "03_sections.json"))), "bib": _bibtxt, "thesis": None,
               "catalog": [[k, {"title": k}] for k in re.findall(r"@\w+\{([^,]+),", _bibtxt)]}
        print("[stage3] REPLAY: rebuilt state from 03_sections.json + references.bib (pre-checkpoint run)")
    elif replay:
        print("[stage3] --replay requested but no reusable writer state exists -> running the full stage")

    # 1) REAL citations (OpenAlex/Crossref, with retry). A citation-free "fallback" would be a silent downgrade,
    #    so BLOCK instead -- but block at the number that actually matters. The floor is paperlint's refs_count
    #    (>=15 PRINTED, house rule); this used to be hardcoded at 20 in three places while the comment said 15,
    #    which rejected a 16-reference subject that would have linted green. gather_citations still AIMS at 20
    #    (its min_refs) so there is headroom for the ones the writer never works in.
    if _ws is not None:
        catalog, bib = [tuple(x) for x in _ws["catalog"]], _ws["bib"]
    else:
        catalog, bib = _gather_citations_retry(pipeline.chat, BRAIN, C, idea_text, obs)
    if len(catalog) < _REF_FLOOR and catalog and os.environ.get("OMNIST_SOFT_GATES"):
        # the one gate that used to leave the reader with NOTHING: below the floor the paper is still written here,
        # lint marks refs_count red, and the driver reports DONE_WITH_RED -- a paper with a warning beats no paper.
        print("[stage3] WARNING: only %d real references (floor is %d); OMNIST_SOFT_GATES is set, writing anyway. "
              "refs_count will be RED in lint." % (len(catalog), _REF_FLOOR))
    elif len(catalog) < _REF_FLOOR:
        if _ws is not None:                                # audit item 6: replay must not bypass the refs floor
            print("[stage3] BLOCKING: replay state carries only %d references (floor is %d). "
                  "Run stage 3 WITHOUT --replay to regather citations." % (len(catalog), _REF_FLOOR))
        elif not catalog:                                  # nothing at all -> the search APIs, not the subject
            print("[stage3] BLOCKING: citation search returned NOTHING (floor is %d). That is an OpenAlex/Crossref "
                  "outage, not a property of this task -- re-run when they respond." % _REF_FLOOR)
        else:                                              # some results, just too few -> the subject is too narrow
            print("[stage3] BLOCKING: only %d real references exist for this subject after the broadened search "
                  "(floor is %d). This is NOT an API outage -- the topic is too narrow to carry a literature "
                  "section, and a paper below the floor could not pass paperlint anyway. Re-running will return "
                  "the same count; widen the subject in series.json or pick another task." % (len(catalog), _REF_FLOOR))
        return {"_failed": True, "reason": "references below floor (%d < %d)" % (len(catalog), _REF_FLOOR)}

    # 2) figures from stage 2 (lead-first; drop demoted analyses' figures); underscore-free \ref labels.
    #    Keep ONLY figures whose file actually exists on disk, so the writer is never told to \ref a figure we
    #    cannot include (a dangling \ref renders as "Figure ??"). figmap labels then match figblocks exactly.
    _dem = set(str(d).strip() for d in (exp.get("demoted", []) or []))
    figs = [f for f in (exp.get("figures", []) or []) if str(f.get("analysis", "")).strip() not in _dem]
    figs = [f for f in figs if f.get("file") and os.path.exists(os.path.join(td, str(f.get("file"))))]
    figmap = [(f.get("file", ""), "fig:f%d" % (i + 1), _clean_caption(f.get("caption", ""))) for i, f in enumerate(figs)]

    # 3) WRITE the paper -- field-aware, OUTLINE-then-EXPAND; failed path scrubbed deterministically; retry on empty;
    #    multi-paragraph, on-length, citation-bearing sections in the style's canonical order.
    # thesis planner (positive-narrative): select the strongest DEFENSIBLE thesis + per-analysis rhetorical roles. If it
    # fails or yields nothing defensible, FALL BACK to the plain writer -- logged, never a silent downgrade.
    if _ws is not None:
        thesis, out = _ws.get("thesis"), _ws["out"]
    else:
        thesis = _plan_thesis(pipeline.chat, BRAIN, C, exp, idea)
        if thesis:
            print("[stage3] thesis planner OK -> positive-narrative mode | thesis: %s"
                  % str(thesis.get("paper_thesis", ""))[:130])
            print("[stage3]   roles: %s" % "; ".join("%s=%s" % (n, r) for n, r in (thesis.get("roles") or {}).items())[:220])
        else:
            print("[stage3] thesis planner unavailable -> FALLBACK to plain outline->expand writer")
        print("[stage3] writing (outline -> expand)")
        out = writer.write_paper(pipeline.chat, BRAIN, C, exp, idea, catalog,
                                 _scrub_rs, _trim_incomplete, exp.get("demoted", []), style, figmap, thesis=thesis)
        json.dump({"catalog": [[k, p] for k, p in catalog], "bib": bib, "out": out, "thesis": thesis},
                  open(_ws_path, "w"), indent=1, default=str)   # the replay checkpoint
    if _ws is not None and not str(out.get("_results_table", "")).strip():
        print("[stage3] REPLAY: no results table in saved state -> regenerating just the table")
        out["_results_table"] = writer._results_table(pipeline.chat, BRAIN, C, exp, exp.get("demoted", []))
        if out["_results_table"]:
            _ws["out"]["_results_table"] = out["_results_table"]           # write back: next replay reuses it
            json.dump(_ws, open(_ws_path, "w"), indent=1, default=str)
    out["ABSTRACT"] = _proofread_abstract(pipeline.chat, BRAIN, out.get("ABSTRACT", ""))
    title = _gen_title(pipeline.chat, BRAIN, C, exp, thesis=thesis)

    # 4) copy figures into the build dir and build the figure environments. VECTOR first: figtools saves a
    #    .pdf twin next to each .png -- the paper embeds the PDF (crisp at any zoom), the .png is only a
    #    preview. Width class comes from figmeta.json ('col' -> \columnwidth figure, 'wide' -> %WIDE marker
    #    that venue_styles turns into figure* spanning both columns). Placement is [t] (top), never [H].
    try:
        figmeta = json.load(open(os.path.join(td, "figmeta.json")))
    except Exception:
        figmeta = {}
    if len(figmap) > 5:
        print("  [stage3] capping main-text figures at 5 (lead-first); dropping: %s"
              % ", ".join(f for f, _, _ in figmap[5:]))
        figmap = figmap[:5]
    work = os.path.join(sd, "latex_03_paper"); shutil.rmtree(work, ignore_errors=True)
    os.makedirs(os.path.join(work, "figures"))
    figblocks = []
    for i, (fname, lab, cap) in enumerate(figmap):
        base = os.path.splitext(fname)[0]
        src_pdf, src_png = os.path.join(td, base + ".pdf"), os.path.join(td, fname)
        if os.path.exists(src_pdf):
            incl = "f%d.pdf" % (i + 1); shutil.copy(src_pdf, os.path.join(work, "figures", incl))
        elif os.path.exists(src_png):
            incl = "f%d.png" % (i + 1); shutil.copy(src_png, os.path.join(work, "figures", incl))
            print("  [stage3] WARNING raster figure (no vector twin): %s" % fname)
        else:
            print("  [stage3] WARNING missing figure on disk: %s" % fname); continue
        _bn = os.path.basename(fname)
        wide = (figmeta.get(_bn) or figmeta.get(os.path.splitext(_bn)[0] + ".png") or {}).get("width") == "wide"
        cap_tex = _strip_emdash(paper._sanitize_body(cap))
        figblocks.append("\\begin{figure}[t]%s\n\\centering\n\\includegraphics[width=%s]{%s}\n"
                         "\\caption{%s}\n\\label{%s}\n\\end{figure}"
                         % ("%WIDE" if wide else "", "\\textwidth" if wide else "\\columnwidth",
                            incl, cap_tex, lab))

    # 4b) DATA-EXEMPLAR figure: a multimodal paper must SHOW its raw perception input (X-ray/spectrogram/waveform/point
    #     cloud), not only scalar features. (A generic auto method-pipeline schematic was tried and removed: it padded
    #     every paper to the same ~5 boxes with a boilerplate caption -- fake and templated. Better none than a bad one.)
    lead_block = ""
    try:
        import evidence as _ev
        _membs = series.get("members") or [{"file": f} for f in ((series.get("data") or {}).get("files") or {}).values()
                                           if isinstance(f, str)]   # dna: data.files only, members empty -> no exemplar at all
        _ex = _ev.exemplar_figure(td, _membs, os.path.join(work, "figures", "fdata.png"))
        if _ex:
            _emod = _ex[2]
            _cap = _strip_emdash(paper._sanitize_body(_data_caption(C.get("subject", ""), _emod)))
            _what = {"image": "input images", "audio": "audio clips (shown as spectrograms)", "signal": "signals",
                     "threeD": "3D point clouds", "video": "video frames",
                     "table": "data tables", "sequence": "sequences"}.get(_emod, "input data")
            lead_block += ("\\begin{figure}[t]\n\\centering\n\\includegraphics[width=\\columnwidth]{fdata.png}\n"
                           "\\caption{%s}\n\\label{fig:data}\n\\end{figure}\n\n"
                           "Figure~\\ref{fig:data} shows representative examples of the raw %s analysed here. "
                           % (_cap, _what))
            print("[stage3] data-exemplar figure rendered (%s modality)" % _emod)
    except Exception as _e:
        print("  [stage3] data-exemplar figure skipped: %s" % _e)

    # 5) assemble the .tex dynamically in the style's section order (figures interleave into the lead section)
    tex = _paper_tex(C, title, out, figblocks, bib, known={k for k, _ in (catalog or [])})
    tex = _insert_lead_figs(tex, lead_block)
    tex = paper._prune_empty_sections(tex)
    # scrub the recurring low-value figure-pointer filler sentence ("These results are summarized in Figure~\ref{..}.")
    # -- an AI residue reviewers flag as abrupt; the figures are already discussed in the surrounding prose.
    tex = re.sub(r"(?:(?:These|Those|The(?:se)?(?: above)?)\s+results|They)\s+are\s+summariz\w+\s+in\s+"
                 r"Figures?~\\ref\{[^}]*\}(?:\s*(?:,|and|,\s*and)\s*Figures?~\\ref\{[^}]*\})*\s*\.\s*", " ", tex)
    # that scrub can remove a figure's ONLY reference (fig_referenced then fails on every replay, because the
    # sections come from the checkpoint): give such a figure a pointer sentence right before its float
    for _lab in re.findall(r"\\label\{(fig:f\d+)\}", tex):
        if not re.search(r"\\ref\{%s\}" % re.escape(_lab), tex):
            tex, _n = re.subn(r"(\\begin\{figure\*?\}(?:(?!\\end\{figure).)*?\\label\{%s\})" % re.escape(_lab),
                              lambda m: "Figure~\\ref{%s} presents the corresponding supporting analysis.\n\n%s" % (_lab, m.group(1)),
                              tex, count=1, flags=re.S)
            if _n:
                print("  [stage3] re-anchored %s (its only reference was in a scrubbed filler sentence)" % _lab)
    # 5a) SECOND-ROUND structure pass: insert \subsection headings where a section has distinct parts (model-decided
    #     after the prose exists, heading-insertion-only). Dedicated + reliable, vs. the incidental bullet polish had.
    print("[stage3] structure pass (subsection headings)")
    tex = _structure_sections(pipeline.chat, BRAIN, tex)
    # 5b) GUARDED polish pass: richer, better-looking prose/equations/structure, but reverted if it touches numbers,
    #     citations, claims or the model name (keeps the deterministic guarantees the writer established).
    _known = {k for k, _ in (catalog or [])}
    _gf = []
    for _n in _num_tokens(" ".join(str(a.get("numbers", "")) for a in (exp.get("analyses") or []))
                          + " " + json.dumps(exp.get("key_numbers", {})) + " " + str(exp.get("result_statement", ""))):
        try:
            _gf.append(float(_n))
        except Exception:
            pass
    _forbidden = [str(x).strip().lower() for x in ((thesis or {}).get("forbidden_claims", []) or []) if str(x).strip()]
    import writer as _wr
    _real_models = _wr._models_in(str(exp.get("method_summary", "")))
    print("[stage3] polish pass (guarded)")
    tex_prepolish = _dedash_tex(tex)                     # the writer's clean, already-compilable tex -- fallback if polish breaks LaTeX
    tex = _dedash_tex(_polish_tex(pipeline.chat, BRAIN, tex, _known, _gf, _forbidden, _real_models))
    print("[stage3] citation coverage pass")
    tex = _cite_coverage(pipeline.chat, BRAIN, tex, catalog)
    tex = _annotate_exclusions(tex, exp, pipeline.chat, BRAIN)   # #1a: state which categories a test used
    tex = _fix_dof_consistency(tex, exp)                             # #1b: force each test's dof to its grounded value
    tex = _scrub_overclaim(tex)                                      # rescope 'statistically indistinguishable from genuine ...'
    # density LAST among prose passes: annotate/dof above INJECT numbers back into paragraphs, which un-did
    # an earlier density fix (v2 still lint-failed with 5 dense paragraphs for exactly this reason).
    print("[stage3] density pass (<=3 result numbers per paragraph)")
    tex = _fix_density(pipeline.chat, BRAIN, tex)
    import venue_styles                                              # cast into the paper's FIELD VENUE template (NeurIPS/Nature/PRL/ApJ/ACS)
    tex_cs = tex_prepolish                                           # un-skinned cs_ml prepolish = guaranteed-compilable ultimate fallback
    def _final_hygiene(s):
        # last-mile glyph hygiene: anything T1 cannot render is silently DROPPED from the PDF (the lint's
        # missing_glyphs check caught em-dashes, curly quotes and unromanized names in three shipped papers).
        s = _dedash_tex(s)                                 # em/en/---/spaced -- as punctuation -> comma (house rule); ranges kept
        for a, b in (("“", "``"), ("”", "''"), ("’", "'"), ("‘", "`"), ("…", "...")):
            s = s.replace(a, b)
        # markdown habit: a literal [ ] typed around the cite. plainnat prints its OWN brackets, so the pair
        # rendered as '[Ciampitti et al. [2013]]' -- five of them shipped in the plant paper's introduction.
        # Adjacent cites of the same command inside one bracket merge into one key list ('[\cite{a},\cite{b}]'
        # would otherwise render as 'A [2019],B [2021]', comma unspaced).
        def _unbracket(m):
            inner = m.group(1).strip().strip(",; ").strip()
            cmds, keys = set(), []
            for c in re.finditer(r"\\(cite[a-zA-Z]*)\{([^}]*)\}", inner):
                cmds.add(c.group(1))
                keys += [k.strip() for k in c.group(2).split(",") if k.strip()]
            return "\\%s{%s}" % (cmds.pop(), ",".join(dict.fromkeys(keys))) if len(cmds) == 1 and keys else inner
        s = re.sub(r"\[\s*((?:\\cite[a-zA-Z]*\{[^}]*\}[\s,;]*)+)\]", _unbracket, s)
        return _unicode_hygiene(_display_long_math(s))

    tex = _final_hygiene(_fix_unbalanced_envs(venue_styles.reskin(tex, style)))
    tex_prepolish = _final_hygiene(_fix_unbalanced_envs(venue_styles.reskin(tex_prepolish, style)))
    bib = paper._bib_hygiene(bib) if bib else bib
    if bib:
        open(os.path.join(work, "references.bib"), "w").write(bib)
    json.dump(out, open(os.path.join(sd, "03_sections.json"), "w"), indent=1, default=str)   # the written sections (debug/transparency)
    main = os.path.join(work, "main.tex"); open(main, "w").write(tex)
    open(os.path.join(work, "main_prefix.tex"), "w").write(tex)                                    # keep the pre-fix tex for diagnosis
    pdf = os.path.join(work, "main.pdf")

    def _compile():
        try:
            r = subprocess.run([paper.TECTONIC, "--print", "main.tex"], cwd=work, capture_output=True, text=True, timeout=300)
            open(os.path.join(work, "compile.log"), "w").write(r.stdout + r.stderr)   # paperlint reads Overfull \hbox from it
            return "" if os.path.exists(pdf) else (r.stdout + r.stderr)[-1200:]
        except Exception as e:
            return "%s: %s" % (type(e).__name__, e)

    degraded = []                                                  # which rungs of the fallback ladder were used
    err = _compile()
    if err:
        print("[stage3] compile error, trying one LLM fix pass:\n" + err[-500:])
        try:
            fix = pipeline.chat("This LaTeX failed to compile with tectonic.\nERROR:\n" + err + "\n\nReturn the FULL "
                                "corrected main.tex that compiles (keep ALL content and every figure/caption/\\ref; fix "
                                "unescaped _ % & # outside math, stray wrappers, unbalanced braces, malformed math). "
                                "Output ONLY the raw .tex, no code fences.\n\nMAIN.TEX:\n" + open(main).read(),
                                BRAIN, 8000)
            fix = re.sub(r"^```[a-zA-Z]*\n?|\n?```$", "", (fix or "").strip())
            cur = open(main).read()
            _nk = lambda s: re.sub(r"\\(?:cite[a-zA-Z]*|ref|eqref|label)\{[^}]*\}", " ", s)
            _cites = lambda s: set(k.strip() for g in re.findall(r"\\cite[a-zA-Z]*\{([^}]*)\}", s) for k in g.split(",") if k.strip())
            # a whole-document LLM rewrite may fix SYNTAX only: same sections, same citations, same numbers, about the
            # same length -- otherwise the 8000-token cap plus a helpful model quietly ships a shorter paper.
            same = ("\\documentclass" in fix and "\\end{document}" in fix and len(fix) >= 0.9 * len(cur)
                    and re.findall(r"\\section\*?\{([^}]*)\}", fix) == re.findall(r"\\section\*?\{([^}]*)\}", cur)
                    and _cites(fix) == _cites(cur) and set(_num_tokens(_nk(fix))) == set(_num_tokens(_nk(cur))))
            if same:
                open(main, "w").write(fix); err = _compile()
            else:
                print("  [stage3] fix pass rejected: it changed content (sections/cites/numbers/length), not just syntax")
        except Exception as e:
            print("  [stage3] fix pass failed: %s" % e)
    if err:                                                        # fix pass failed -> revert to clean pre-polish writer tex FIRST
        print("[stage3] still failing -> reverting polish, building the pre-polish writer tex")   # (keeps refs + full sections)
        degraded.append("pre-polish tex shipped: polish, citation coverage, density and hygiene passes discarded")
        open(main, "w").write(tex_prepolish); err = _compile()
    if err and bib:                                                # citation/bibtex build STILL failing -> last-resort citation-free build
        print("[stage3] still failing -> citation-free fallback build")
        degraded.append("citations stripped (refs_count will fail)")
        src = re.sub(r"\\cite[a-zA-Z]*\{[^}]*\}", "", open(main).read())
        src = src.replace("\\bibliographystyle{plainnat}", "").replace("\\bibliography{references}", "")
        open(main, "w").write(src); err = _compile()
    if err:                                                        # even the venue skin's fallbacks failed -> un-skinned cs_ml base (always compiles)
        print("[stage3] still failing -> ultimate fallback: un-skinned cs_ml base tex")
        degraded.append("un-skinned base tex shipped")
        tex_cs = _final_hygiene(_fix_unbalanced_envs(tex_cs)); open(main, "w").write(tex_cs); err = _compile()
        if err and bib:
            src = re.sub(r"\\cite[a-zA-Z]*\{[^}]*\}", "", tex_cs)
            src = src.replace("\\bibliographystyle{plainnat}", "").replace("\\bibliography{references}", "")
            open(main, "w").write(src); err = _compile()

    tex_out = os.path.join(sd, "03_paper.tex")
    open(tex_out, "w").write(open(main).read())
    ok = os.path.exists(pdf)
    if ok:
        shutil.copy(pdf, os.path.join(sd, "03_paper.pdf"))
    elif os.path.exists(os.path.join(sd, "03_paper.pdf")):
        # otherwise lint judges the NEW tex against the OLD pdf and the heal loop can print SELF_HEAL_OK on a stale build
        os.remove(os.path.join(sd, "03_paper.pdf"))
        print("[stage3] removed the previous 03_paper.pdf: this build produced none, a stale one must not pass as fresh")
    if degraded:
        print("[stage3] DEGRADED BUILD: " + "; ".join(degraded))
    md = ["# Stage 3 -- Writeup (research paper -> PDF)", "",
          "_task: %s | style: %s | figures: %d | references: %d | brain: %s_" % (task, style, len(figblocks), len(catalog), BRAIN), "",
          "## Title", title, "", "## Abstract", out.get("ABSTRACT", ""), "",
          "**PDF:** %s" % ("stages/03_paper.pdf" if ok else "FAILED: " + (err or "no pdf")[:300])]
    _write(task, "03_paper", {"title": title, "abstract": out.get("ABSTRACT", ""), "n_figures": len(figblocks),
                              "n_references": len(catalog), "pdf": ok, "tex": tex_out, "degraded": degraded}, "\n".join(md))
    print("[stage3] tex -> %s | pdf -> %s (%s)" % (tex_out, os.path.join(sd, "03_paper.pdf"),
                                                   "OK" if ok else "FAILED"))
    return {"title": title, "abstract": out.get("ABSTRACT", ""), "pdf": ok, "n_figures": len(figblocks),
            "n_references": len(catalog), "degraded": degraded, "_failed": not ok}


# ---------------------------------------------------------------- LEVEL 1: the deterministic controller
def _route(stage, artifact):
    """Deterministic transition (CODE decides, not the LLM). Returns the next stage key, or BACKTRACK/DONE/ABORT.
    Rule: a stage that produced a real result advances; null/infeasible re-ideates; un-ideatable aborts."""
    if artifact.get("_failed"):
        return "BACKTRACK" if stage == "2" else "ABORT"          # exp failed -> re-ideate; can't ideate -> abort
    if stage == "1":
        return "2"
    if stage == "2":
        verdict = str(artifact.get("verdict", "")).strip().lower()
        if verdict in ("null", "infeasible", "insufficient", "insufficient_data"):
            return "BACKTRACK"                                   # no finding -> the idea was bad, re-ideate
        return "3"                                               # supported/mixed/refuted WITH a finding -> write it up
    return "DONE"                                                # stage 3 done -> pipeline complete


def _record_avoid(task, idea, exp):
    """Persist the failed idea so the next ideation proposes something different (else temp=0 loops forever)."""
    ap = os.path.join(stages_dir(task), "_avoid.json")
    avoid = json.load(open(ap)) if os.path.exists(ap) else []
    rq = str((idea or {}).get("research_question", ""))[:200]
    why = str((exp or {}).get("result_statement", (exp or {}).get("reason", "")))[:200]
    avoid.append("%s (failed: %s)" % (rq, why))
    json.dump(avoid, open(ap, "w"), indent=1)


def run_pipeline(task, max_backtracks=2):
    """LEVEL 1: chain the stage agents with deterministic routing + backtracking. Each stage reads the prior
    stage's artifact from disk (checkpoint); the LLM never decides the transitions -- _route does."""
    if os.environ.get("MMSCI_SINGLE_PASS"):                     # ablation: collapse the agentic loop to a single pass
        max_backtracks = 0
    elif os.environ.get("MMSCI_MAX_BACKTRACKS"):                # strong+strict backbones (gpt-5.6) reject trivial ideas and
        max_backtracks = int(os.environ["MMSCI_MAX_BACKTRACKS"])  # honestly hit null -> give them more tries to find a novel+supported one
    ap = os.path.join(stages_dir(task), "_avoid.json")          # fresh full run -> clear backtrack memory
    if os.path.exists(ap):
        os.remove(ap)
    backtracks, stage, last_idea, last_verdict = 0, "1", None, ""
    while True:
        print("\n" + "#" * 72 + "\n#  PIPELINE -> stage %s   (backtracks %d/%d)\n" % (stage, backtracks, max_backtracks) + "#" * 72)
        artifact = STAGES[stage](task)
        if stage == "1":
            last_idea = artifact
        elif stage == "2":
            last_verdict = str(artifact.get("verdict", ""))
        nxt = _route(stage, artifact)
        if nxt == "DONE":
            wrote = bool(isinstance(artifact, dict) and artifact.get("pdf"))
            print("\n[PIPELINE] DONE -- full run complete (stage-2 verdict=%s; paper %s)."
                  % (last_verdict or "?", "compiled" if wrote else "written but PDF not confirmed"))
            return {"status": "done", "verdict": last_verdict,
                    "paper": artifact if isinstance(artifact, dict) else None, "backtracks": backtracks}
        if nxt == "ABORT":
            print("\n[PIPELINE] ABORT at stage %s: %s" % (stage, artifact.get("reason", "")))
            return {"status": "abort", "stage": stage}
        if nxt == "BACKTRACK":
            backtracks += 1
            if backtracks > max_backtracks:
                print("\n[PIPELINE] gave up after %d backtracks -- no feasible idea found on this data." % max_backtracks)
                return {"status": "exhausted", "backtracks": backtracks}
            _record_avoid(task, last_idea, artifact)
            print("\n[PIPELINE] stage 2 null/infeasible -> BACKTRACK to ideation (avoid list updated, attempt %d)." % (backtracks + 1))
            stage = "1"
            continue
        stage = nxt


# ---------------------------------------------------------------- the thin outer pipeline
STAGES = {"1": stage1_ideation, "2": stage2_experiment, "3": stage3_writeup, "run": run_pipeline}   # 4 (review) to come


def main():
    ap = argparse.ArgumentParser(description="mmsci agentic (self-contained tool-using stages)")
    ap.add_argument("--task", required=True)
    ap.add_argument("--stage", default="1")
    ap.add_argument("--replay", action="store_true",
                    help="stage 3 only: reuse the saved writer state (03_writer_state.json) -- skip citations "
                         "and section writing, rerun only title/assembly/passes/compile. Minutes, not half an "
                         "hour; THE way to verify a harness fix on an existing trajectory.")
    a = ap.parse_args()
    _r = None
    if a.stage == "3":
        _r = stage3_writeup(a.task, replay=a.replay)
    else:
        STAGES[a.stage](a.task)
    print("\n[cost] this run ~$%.4f" % pipeline.spend())
    _co = os.environ.get("OMNIST_COST_OUT")               # let a batch driver capture per-run token/$ for tab:eval-cost
    if _co:
        try:
            json.dump({"task": a.task, "stage": a.stage, "model": BRAIN,
                       "spend": pipeline.spend(), "usage": pipeline.U}, open(_co, "w"), indent=1)
        except Exception as e:
            print("[cost] could not write OMNIST_COST_OUT:", e)
    if isinstance(_r, dict) and _r.get("_failed"):
        raise SystemExit(1)                               # a failed stage 3 exits non-zero; the driver no longer trusts a stale pdf


if __name__ == "__main__":
    main()
