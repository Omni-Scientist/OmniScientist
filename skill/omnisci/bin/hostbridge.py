# -*- coding: utf-8 -*-
"""HOST BRIDGE: run the evidence layer with the HOST harness as the perceiver.

The API engine calls a VLM itself (`evidence._vlm` -> `pipeline.chat`). In host mode there is no API key and
no model call: the render half still runs in python (npy waveform, wav spectrogram, video contact sheet, point
cloud projection -> png), and the seeing half is handed back to the harness, which opens the png with its own
built-in multimodal read.

The cut is exactly one function. Every `look_at_*` tool ends in `_vlm(png, question)`, and its return value is
only ever interpolated into the result string, never branched on, so swapping `_vlm` for a collector lets the
whole tool run to completion with `<<VISION:n>>` placeholders, which the host fills in afterwards.

    tools   = list_tools(td)                      # what this case unlocks
    call    = run_tool(td, name, args)            # -> {"result": .., "pending": [{id, image, question}]}
    final   = ingest(td, call_id, {"1": ".."})    # placeholders -> the host's own answers
"""
import os, re, sys, json, types

# Chinese-locale Windows opens files as GBK by default, so any CLI that reads a
# UTF-8 JSON crashes with UnicodeDecodeError (seen live 2026-09-02). Re-exec once
# into python's UTF-8 mode; every CLI imports this module first, so all are covered.
if os.name == "nt" and not sys.flags.utf8_mode and os.environ.get("PYTHONUTF8") != "1":
    os.environ["PYTHONUTF8"] = "1"
    os.execv(sys.executable, [sys.executable] + sys.argv)

HERE = os.path.dirname(os.path.abspath(__file__))
REAL = os.path.dirname(os.path.realpath(__file__))          # the CLIs are reached through a symlink once the
PLACEHOLDER = "<<VISION:%d>>"                               # skill is installed under ~/.claude/skills/


def _engine_candidates():
    for base in (HERE, REAL):
        yield os.path.normpath(os.path.join(base, "vendor"))            # a packaged copy, when there is one
        yield os.path.normpath(os.path.join(base, "..", "..", "engine", "scripts"))


def find_engine():
    env = os.environ.get("OMNISCI_ENGINE")
    if env:
        return env
    for c in _engine_candidates():
        if os.path.exists(os.path.join(c, "evidence.py")):
            return c
    return next(_engine_candidates())


DEFAULT_ENGINE = find_engine()

_PENDING = []                                              # (re)filled by _collect_vlm during one tool call
_evidence = None


def _install_pipeline_stub():
    """evidence.py does `import pipeline`, whose module body builds API clients from env keys and dies without
    them. Host mode never calls a model, so a stub with the two symbols evidence imports is enough."""
    if "pipeline" in sys.modules:
        return
    stub = types.ModuleType("pipeline")

    def _refuse(*a, **k):
        raise RuntimeError("host mode: the engine must not call a model API; the host harness does the seeing")

    def parse_json(txt):                                   # pure helper the engine imports by name; no API involved
        import re as _re, json as _json
        for m in _re.finditer(r"\{(?:[^{}]|\{[^{}]*\})*\}", txt or "", _re.S):
            try:
                return _json.loads(m.group(0))
            except Exception:
                continue
        return None

    stub.chat = _refuse
    stub.agent_loop = _refuse
    stub.parse_json = parse_json
    stub.img_block = lambda path: {"type": "image_url", "image_url": {"url": "file://%s" % path}}
    sys.modules["pipeline"] = stub


def engine_module(name):
    """Import an engine module (paper / agentic / writer) under the stub, for its pure helpers."""
    evidence()                                             # installs the stub + puts the engine on sys.path
    return __import__(name)


def _collect_vlm(png, question, mt=350):
    """Replaces evidence._vlm: bank the (image, question) and hand back a placeholder."""
    _PENDING.append({"id": len(_PENDING) + 1, "image": os.path.abspath(png), "question": question})
    return PLACEHOLDER % len(_PENDING)


def evidence():
    """Import the engine's evidence layer once, with the API perceiver replaced by the collector."""
    global _evidence
    if _evidence is None:
        engine = find_engine()
        if not os.path.exists(os.path.join(engine, "evidence.py")):
            raise SystemExit("evidence.py not found under %s (set OMNISCI_ENGINE to the engine scripts dir)" % engine)
        _install_pipeline_stub()
        sys.path.insert(0, engine)
        import evidence as ev
        ev._vlm = _collect_vlm
        ev._render = _naming_render(ev._render)
        _evidence = ev
    return _evidence


def _naming_render(orig):
    """The engine names a render `r_<hash>.png`, which tells you nothing about what it shows. Put the source
    stem in the filename so a directory of renders is readable on its own."""
    def render(plot_fn, tag):
        out = orig(plot_fn, tag)
        stem = re.sub(r"[^A-Za-z0-9_.-]", "_", os.path.splitext(os.path.basename(str(tag)))[0])[:48]
        if not stem:
            return out
        new = os.path.join(os.path.dirname(out), "%s__%s" % (stem, os.path.basename(out)))
        try:
            os.replace(out, new)
            return new
        except OSError:
            return out
    return render


# ---------------------------------------------------------------- case + state
def _claims(series_path, case_dir, sub):
    """True when this series.json lists member files under sub, i.e. the case owns that folder."""
    try:
        doc = json.load(open(series_path))
    except Exception:
        return False
    subp = sub.rstrip(os.sep)
    prefix = subp + os.sep
    for m in (doc.get("members") or [])[:200]:
        f = m.get("file") if isinstance(m, dict) else None
        if not f:
            continue
        fa = os.path.abspath(os.path.join(case_dir, f))
        # a member file under the given folder, or the given folder inside a
        # member's directory subtree: either way the case owns that folder
        if fa.startswith(prefix):
            return True
        fdir = os.path.dirname(fa)
        if subp == fdir or subp.startswith(fdir + os.sep):
            return True
    return False


def resolve_task(task):
    """A task is a directory holding series.json; a bare name is looked up under the engine's examples/."""
    cands = [task, os.path.join(os.environ.get("OMNISCI_CASES", ""), task) if os.environ.get("OMNISCI_CASES") else None,
             os.path.join(DEFAULT_ENGINE, "..", "examples", task)]
    for c in cands:
        if c and os.path.exists(os.path.join(c, "series.json")):
            return os.path.abspath(c)
    # Users often point at a subfolder of the case (typically its data/ directory).
    # Only walk upward for path-like arguments (a bare name is an examples/ lookup;
    # a typo there must stay loud), and only adopt a parent whose series.json
    # actually lists files under the folder we were given.
    if os.sep in task or os.path.exists(task):
        sub = os.path.abspath(task)
        p = sub
        for _ in range(3):
            parent = os.path.dirname(p)
            if parent == p or parent in ("/", os.path.expanduser("~")):
                break
            p = parent
            sj = os.path.join(p, "series.json")
            if os.path.exists(sj):
                if _claims(sj, p, sub):
                    sys.stderr.write("note: case resolved upward to %s (its series.json lists files under %s)\n" % (p, task))
                    return p
                break
    raise SystemExit("no series.json for task %r or a parent that claims it; for a bare data folder run case_cli.py inspect + init first (looked in: %s)"
                     % (task, ", ".join(x for x in cands if x)))


def case_path(td, p):
    """Accept a path given relative to the case dir, relative to cwd, or absolute, so every CLI agrees."""
    if os.path.isabs(p) or os.path.exists(p):
        return p
    joined = os.path.join(td, p)
    return joined if os.path.exists(joined) else p


def load_case(td):
    series = json.load(open(os.path.join(td, "series.json")))
    members = series.get("members") or []
    by_file = {str(m["file"]): m for m in members if m.get("file")}
    return series, members, by_file


def host_dir(td):
    d = os.path.join(td, "host")
    os.makedirs(os.path.join(d, "calls"), exist_ok=True)
    return d


def load_state(td, budget=None):
    p = os.path.join(host_dir(td), "state.json")
    st = json.load(open(p)) if os.path.exists(p) else {"img_used": 0, "img_budget": 12, "next_call": 1}
    if budget:
        st["img_budget"] = budget
    return st


def save_state(td, st):
    json.dump(st, open(os.path.join(host_dir(td), "state.json"), "w"), indent=2)


# ---------------------------------------------------------------- the three operations
# The engine's schema text describes the 3-D tools as point-cloud/mesh only, which is wrong for dense voxel
# volumes and can read as "this case has no applicable perception tool". Corrected here rather than in the
# engine, whose descriptions are also prompt text for the API arm.
_TOOL_NOTES = {
    "look_at_3d": " ALSO accepts a dense voxel volume (.npy): it renders three orthogonal centre slices plus "
                  "three maximum-intensity projections. On volumes containing bone or contrast the MIP panels "
                  "saturate, so read the slice panels and treat the projections with suspicion.",
    "analyze_3d": " For a dense voxel volume it returns shape, occupied fraction and connected components "
                  "instead of point-cloud geometry.",
}


def list_tools(td):
    ev = evidence()
    series, members, _ = load_case(td)
    mods = ev.detect_modalities(members) if members else ({"table"} if series.get("data") else {"image"})
    tools = []
    for t in ev.tool_schemas(mods):
        fn = dict(t["function"])
        fn["description"] += _TOOL_NOTES.get(fn["name"], "")
        tools.append(fn)
    return {"modalities": sorted(mods), "n_members": len(members), "tools": tools}


def run_tool(td, name, args, budget=None):
    ev = evidence()
    _PENDING.clear()
    ev._RDIR = os.path.join(host_dir(td), "renders")        # renders land next to the case, not in /tmp
    series, members, by_file = load_case(td)
    st = load_state(td, budget)
    logs = []
    result = ev.run(name, args or {}, st, logs.append, td, by_file)
    if result is None:
        raise SystemExit("unknown tool %r (see: evidence_cli.py tools)" % name)
    pending = list(_PENDING)
    call = {"call_id": st["next_call"], "tool": name, "args": args, "draft": result,
            "pending": pending, "log": logs, "status": "needs_vision" if pending else "done"}
    if not pending:
        call["result"] = result
    json.dump(call, open(os.path.join(host_dir(td), "calls", "call_%03d.json" % st["next_call"]), "w"),
              indent=2, ensure_ascii=False)
    st["next_call"] += 1
    save_state(td, st)
    return call


def ingest(td, call_id, answers):
    p = os.path.join(host_dir(td), "calls", "call_%03d.json" % int(call_id))
    if not os.path.exists(p):
        raise SystemExit("no such call: %s" % p)
    call = json.load(open(p))
    text, missing = call["draft"], []
    for item in call["pending"]:
        a = answers.get(str(item["id"])) or answers.get(item["id"])
        if not a:
            missing.append(item["id"]); continue
        text = text.replace(PLACEHOLDER % item["id"], str(a).strip())
    if missing:
        raise SystemExit("no answer given for vision request(s): %s" % missing)
    call["result"], call["status"], call["answers"] = text, "done", answers
    json.dump(call, open(p, "w"), indent=2, ensure_ascii=False)
    return call
