#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Gate CLI: the anti-fabrication guard, deterministic.

The engine's hard rule is that every number in the paper came out of a real run. Host mode keeps it by making
the run the only way a number enters the ledger, then checking the finished LaTeX against that ledger.

  python gate_cli.py record --task galaxy_xsurvey --script analysis/gap.py   # run it, bank its stdout
  python gate_cli.py check  --task galaxy_xsurvey --tex host/paper.tex       # every number must be grounded

`check` exits 2 when it finds an ungrounded number, so it can be wired to a Claude Code hook and block rather
than advise. Grounding tolerates percent/fraction and rounding, exactly as the engine does.
"""
import os, re, sys, json, glob, argparse, subprocess

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import hostbridge as hb

LEDGER = "ledger.jsonl"
_YEAR = re.compile(r"^(1[89]|20)\d\d$")                    # a citation year is not a result

# The engine's tokenizer is `-?\d+\.?\d*`, which misreads three things in real prose: a LaTeX range (200--1200)
# yields a phantom -1200, an exponent (1.96e-08) yields a phantom -08, and an identifier (R110104) yields 110104.
# All three are lexical accidents, not claims, so they are fixed here rather than papered over in the skill.
_RANGE = re.compile(r"(?<=\d)\s*(?:-{2,}|–|—)\s*(?=\d)")     # 200--1200 is a range, not a negation
_NUM = re.compile(r"(?<![A-Za-z0-9.])[-+]?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?(?![A-Za-z0-9_])")
# The lookbehind drops letters (R110104 is an identifier) and a preceding dot (the 45 of 0.45 is not its own
# number) but must NOT drop an underscore: `n_pairs_below_0.45 = 3` is the ledger's own required output shape.
_FLOOR = 0.005                                             # below this a number is unverifiable either way



def _case_relpath(path, td):
    """Path relative to the case dir, computed with BOTH sides resolved.

    os.path.relpath(realpath(x), td) blows up whenever td sits under a symlink
    (macOS /tmp -> /private/tmp is the everyday case): it yields
    ../../../private/tmp/<case>/host/... and joining that back onto td lands in
    a directory that does not exist, so the gate marks a perfectly good run stale.
    Resolving both sides keeps the stored path inside the case dir.
    """
    return os.path.relpath(os.path.realpath(path), os.path.realpath(td))

def numbers(text):
    """Numeric claims in a piece of text, as (token, value)."""
    out = []
    for m in _NUM.finditer(_RANGE.sub(" ", text or "")):
        tok = m.group(0)
        if len(re.sub(r"[^\d]", "", tok)) < 2:             # single digits are prose ("one of four cells")
            continue
        try:
            out.append((tok, float(tok)))
        except ValueError:
            pass
    return out


def grounded(v, gvals):
    """Tolerant of percent/fraction and rounding, as the engine is, but without its 0.02 absolute floor, which
    made every p-value and every small effect size unverifiable by construction."""
    for g in gvals:
        for cand in (g, g * 100.0, g / 100.0):
            if abs(v - cand) <= max(_FLOOR, abs(cand) * 0.02):
                return True
    return False


CAP = 2_000_000                                            # ledger entry size limit, per stream


def _clip(s):
    """Keep both ends if a stream is enormous. Tail-only truncation silently drops the constants a script
    prints first, and the gate then flags true numbers as ungrounded with no hint why."""
    if len(s) <= CAP:
        return s, False
    half = CAP // 2
    return s[:half] + "\n...[%d characters omitted by the recorder]...\n" % (len(s) - CAP) + s[-half:], True


def record(td, script, argv, timeout=None):
    path = script if os.path.isabs(script) else os.path.join(td, script)
    if not os.path.exists(path):
        raise SystemExit("no such script: %s" % path)
    # Streamed rather than captured wholesale, so a long analysis shows progress while it runs and still ends
    # up in the ledger verbatim. -u keeps the child from buffering its own output away from us.
    proc = subprocess.Popen([sys.executable, "-u", path] + list(argv), cwd=td, text=True,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    buf = {"stdout": [], "stderr": []}

    def pump(stream, name, echo):
        for line in stream:
            buf[name].append(line)
            echo.write(line); echo.flush()

    import threading
    threads = [threading.Thread(target=pump, args=(proc.stdout, "stdout", sys.stdout)),
               threading.Thread(target=pump, args=(proc.stderr, "stderr", sys.stderr))]
    for t in threads:
        t.start()
    try:
        proc.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait()
    for t in threads:
        t.join()

    out, clipped = _clip("".join(buf["stdout"]))
    err, _ = _clip("".join(buf["stderr"]))
    entry = {"script": _case_relpath(path, td), "argv": list(argv), "returncode": proc.returncode,
             "stdout": out, "stderr": err, "truncated": clipped}
    with open(os.path.join(hb.host_dir(td), LEDGER), "a") as f:
        f.write(json.dumps(entry, ensure_ascii=False) + "\n")
    if clipped:
        print("[record] WARNING: stdout exceeded %d characters and was clipped in the middle; a number printed "
              "in the omitted part will not ground." % CAP, file=sys.stderr)
    return entry


def ledger_numbers(td):
    p, nums = os.path.join(hb.host_dir(td), LEDGER), []
    if not os.path.exists(p):
        return []
    for line in open(p):
        nums.extend(v for _, v in numbers(json.loads(line).get("stdout", "")))
    return nums


def perception_status(td):
    """Was the evidence actually looked at? A rendered image that was never ingested is an image nobody read,
    and nothing downstream notices on its own, so the gate has to."""
    calls, pending, ingested = [], [], 0
    for p in sorted(glob.glob(os.path.join(hb.host_dir(td), "calls", "call_*.json"))):
        c = json.load(open(p))
        calls.append(c)
        if c.get("pending"):
            if c.get("status") == "done":
                ingested += 1
            else:
                pending.append(c.get("call_id"))
    try:                                                   # does this case even have something to perceive?
        names = [t["name"] for t in hb.list_tools(td)["tools"]]
        required = any(n.startswith("look_at") and n != "look_at_table" for n in names)
    except Exception:
        required = False
    return {"calls": len(calls), "ingested": ingested, "pending": pending, "required": required}


def _prose_only(tex):
    """Strip what is not a claim: preamble, figure blocks, includegraphics sizes, bibliography, labels/refs."""
    tex = tex.split("\\begin{document}", 1)[-1]
    tex = re.sub(r"\\begin\{figure\}.*?\\end\{figure\}", " ", tex, flags=re.S)
    tex = re.sub(r"\\includegraphics\[[^\]]*\]", " ", tex)
    tex = re.sub(r"\\(label|ref|cite[a-zA-Z]*|bibliography[a-z]*)\{[^}]*\}", " ", tex)
    return tex


def check(td, tex_path):
    path = tex_path if os.path.isabs(tex_path) else os.path.join(td, tex_path)
    gfloats = ledger_numbers(td)
    perc = perception_status(td)
    if not gfloats:
        return {"status": "blocked", "perception": perc,
                "reason": "the ledger is empty: no analysis was recorded, so no number in the paper can be "
                          "grounded. Run `gate_cli.py record` first."}
    if perc["pending"]:
        return {"status": "blocked", "perception": perc,
                "reason": "perception calls %s were rendered but never ingested, so there is no record that "
                          "anyone looked at them. Read each image and run `evidence_cli.py ingest`."
                          % perc["pending"]}
    if perc["required"] and not perc["ingested"]:
        return {"status": "blocked", "perception": perc,
                "reason": "this case carries evidence that has to be perceived, and no perception call was "
                          "completed. A hypothesis formed without looking at the data is the failure mode this "
                          "system exists to prevent."}
    bad, checked = [], 0
    for tok, val in numbers(_prose_only(open(path).read())):
        if _YEAR.match(tok):
            continue
        checked += 1
        if not grounded(val, gfloats):
            bad.append(tok)
    out = {"status": "ok" if not bad else "ungrounded", "checked": checked, "ledger_numbers": len(gfloats),
           "perception": perc, "ungrounded": sorted(set(bad), key=lambda s: -len(s))[:40]}
    if bad:
        p = os.path.join(hb.host_dir(td), LEDGER)
        if os.path.exists(p) and any(json.loads(l).get("truncated") for l in open(p)):
            out["note"] = ("a recorded run was clipped for size, so a number printed in the omitted part will "
                           "read as ungrounded. Print fewer intermediate lines and record again.")
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    r = sub.add_parser("record", help="run an analysis script and bank its stdout as the source of truth")
    r.add_argument("--task", required=True)
    r.add_argument("--script", required=True)
    r.add_argument("--timeout", type=float, help="seconds before the script is killed (default: no limit)")
    r.add_argument("argv", nargs="*")

    c = sub.add_parser("check", help="every number in the .tex must trace to the ledger")
    c.add_argument("--task", required=True)
    c.add_argument("--tex", required=True)

    a = ap.parse_args()
    td = hb.resolve_task(a.task)
    if a.cmd == "record":
        out = record(td, a.script, a.argv, a.timeout)      # stdout/stderr already streamed to the terminal
        print(json.dumps({"case": td, **{k: out[k] for k in ("script", "returncode", "truncated")}}, indent=2))
        sys.exit(out["returncode"])
    out = check(td, a.tex)
    print(json.dumps({"case": td, **out}, indent=2, ensure_ascii=False))
    sys.exit(0 if out["status"] == "ok" else 2)


if __name__ == "__main__":
    main()
