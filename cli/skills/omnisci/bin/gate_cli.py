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
import os, re, sys, json, glob, argparse, subprocess, hashlib, datetime

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
_EPSILON = 1e-12                                           # floating-point noise only; never a claim tolerance



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
            if abs(v - cand) <= max(_EPSILON, abs(cand) * 0.02):
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


def _file_sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def _entry_sha256(entry):
    """Hash the semantic entry, excluding the self-hash field itself."""
    payload = {k: v for k, v in entry.items() if k != "entry_sha256"}
    raw = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()


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
             "script_sha256": _file_sha256(path),
             "recorded_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
             "stdout": out, "stderr": err, "truncated": clipped}
    entry["entry_sha256"] = _entry_sha256(entry)
    with open(os.path.join(hb.host_dir(td), LEDGER), "a") as f:
        f.write(json.dumps(entry, ensure_ascii=False) + "\n")
    if clipped:
        print("[record] WARNING: stdout exceeded %d characters and was clipped in the middle; a number printed "
              "in the omitted part will not ground." % CAP, file=sys.stderr)
    return entry


def active_ledger(td):
    """Keep only the latest successful run of each invocation against the current script bytes."""
    p = os.path.join(hb.host_dir(td), LEDGER)
    if not os.path.exists(p):
        return [], {"entries": 0, "active": 0, "failed_latest": 0, "stale": 0,
                    "invalid": 0, "active_entries": []}
    entries, total, invalid = [], 0, 0
    for line in open(p):
        if not line.strip():
            continue
        total += 1
        try:
            entry = json.loads(line)
        except Exception:
            invalid += 1
            continue
        if not isinstance(entry, dict) or not entry.get("entry_sha256") \
                or entry.get("entry_sha256") != _entry_sha256(entry):
            invalid += 1
            continue
        entries.append(entry)
    latest = {}
    for entry in entries:
        key = (entry.get("script"), json.dumps(entry.get("argv") or [], sort_keys=True))
        latest[key] = entry
    active, failed, stale = [], 0, 0
    for entry in latest.values():
        if entry.get("returncode") != 0:
            failed += 1
            continue
        script = os.path.join(td, entry.get("script") or "")
        if not os.path.isfile(script) or not entry.get("script_sha256") \
                or _file_sha256(script) != entry.get("script_sha256"):
            stale += 1
            continue
        active.append(entry)
    active_meta = [{"entry_sha256": e["entry_sha256"], "script": e.get("script"),
                    "argv": e.get("argv") or []} for e in active]
    return active, {"entries": total, "active": len(active),
                    "failed_latest": failed, "stale": stale, "invalid": invalid,
                    "active_entries": active_meta}


def ledger_numbers(td):
    nums = []
    active, _ = active_ledger(td)
    for entry in active:
        nums.extend(v for _, v in numbers(entry.get("stdout", "")))
    return nums


def perception_status(td):
    """Was the evidence actually looked at? A rendered image that was never ingested is an image nobody read,
    and nothing downstream notices on its own, so the gate has to."""
    calls, pending, invalid, ingested, discovery_errors = [], [], [], 0, []
    for p in sorted(glob.glob(os.path.join(hb.host_dir(td), "calls", "call_*.json"))):
        try:
            c = json.load(open(p))
        except Exception as e:
            discovery_errors.append("%s: %s" % (os.path.basename(p), e))
            continue
        calls.append(c)
        if c.get("pending"):
            if c.get("status") == "done":
                errors = [err for item in c["pending"] for _, err in [hb.validate_receipt(td, c, item)] if err]
                if errors:
                    invalid.append({"call": c.get("call_id"), "errors": errors})
                else:
                    ingested += 1
            else:
                pending.append(c.get("call_id"))
    try:                                                   # does this case even have something to perceive?
        names = [t["name"] for t in hb.list_tools(td)["tools"]]
        required = any(n.startswith("look_at") and n != "look_at_table" for n in names)
    except BaseException as e:
        required = True
        discovery_errors.append("tool discovery failed: %s" % e)
    return {"calls": len(calls), "ingested": ingested, "pending": pending,
            "invalid": invalid, "required": required, "discovery_errors": discovery_errors}


def _prose_only(tex):
    """Strip non-claims while retaining figure captions, which can contain scientific claims."""
    tex = tex.split("\\begin{document}", 1)[-1]
    tex = re.sub(r"\\includegraphics(?:\[[^\]]*\])?\{[^}]*\}", " ", tex)
    tex = re.sub(r"\\(?:begin|end)\{figure\}(?:\[[^\]]*\])?", " ", tex)
    tex = re.sub(r"\\(label|ref|cite[a-zA-Z]*|bibliography[a-z]*)\{[^}]*\}", " ", tex)
    return tex


def citation_status(td, tex):
    bib = os.path.join(hb.host_dir(td), "references.bib")
    provenance = os.path.join(hb.host_dir(td), "references.provenance.json")
    cited = set()
    for group in re.findall(r"\\cite[a-zA-Z]*\s*\{([^}]*)\}", tex or ""):
        cited.update(k.strip() for k in group.split(",") if k.strip())
    if not cited:
        return {"valid": False, "reason": "the paper contains no citations"}
    if not os.path.isfile(bib) or not os.path.isfile(provenance):
        return {"valid": False, "reason": "references.bib or its verification provenance is missing"}
    try:
        bib_text = open(bib).read()
        proof = json.load(open(provenance))
    except Exception as e:
        return {"valid": False, "reason": "reference provenance is unreadable: %s" % e}
    actual_sha = _file_sha256(bib)
    if proof.get("bib_sha256") != actual_sha:
        return {"valid": False, "reason": "references.bib changed after DOI verification"}
    keys = set(re.findall(r"@\w+\{([^,]+),", bib_text))
    if not cited.issubset(keys):
        return {"valid": False, "reason": "paper cites keys absent from the verified bibliography: %s"
                % sorted(cited - keys)}
    bib_dois = set(re.findall(r"\bdoi\s*=\s*\{([^}]+)\}", bib_text, flags=re.I))
    proof_entries = proof.get("entries") or []
    proof_dois = {str(e.get("doi") or "").lower() for e in proof_entries if isinstance(e, dict)}
    if not proof_entries or "" in proof_dois or {d.lower() for d in bib_dois} != proof_dois:
        return {"valid": False, "reason": "every bibliography entry must have DOI verification provenance"}
    return {"valid": True, "cited": len(cited), "verified_entries": len(proof_entries),
            "bib_sha256": actual_sha, "provenance_sha256": _file_sha256(provenance)}


def check(td, tex_path):
    path = tex_path if os.path.isabs(tex_path) else os.path.join(td, tex_path)
    if not os.path.isfile(path):
        return {"status": "blocked", "reason": "paper tex does not exist: %s" % path}
    tex = open(path).read()
    tex_sha = _file_sha256(path)
    gfloats = ledger_numbers(td)
    _, ledger = active_ledger(td)
    perc = perception_status(td)
    citations = citation_status(td, tex)
    if not citations["valid"]:
        return {"status": "blocked", "tex_sha256": tex_sha, "perception": perc, "ledger": ledger,
                "citations": citations, "reason": citations["reason"]}
    if ledger["invalid"]:
        return {"status": "blocked", "tex_sha256": tex_sha, "perception": perc, "ledger": ledger,
                "citations": citations,
                "reason": "the analysis ledger contains malformed or hash-invalid entries"}
    if not gfloats:
        return {"status": "blocked", "tex_sha256": tex_sha, "perception": perc, "ledger": ledger,
                "reason": "the ledger has no current successful analysis. Failed runs never ground numbers, "
                          "and a script edit invalidates its old run. Run `gate_cli.py record` successfully."}
    if perc["discovery_errors"]:
        return {"status": "blocked", "tex_sha256": tex_sha, "perception": perc, "ledger": ledger,
                "reason": "perception discovery failed closed: %s" % perc["discovery_errors"]}
    if perc["pending"]:
        return {"status": "blocked", "tex_sha256": tex_sha, "perception": perc,
                "reason": "perception calls %s were rendered but never ingested, so there is no record that "
                          "anyone looked at them. Read each image and run `evidence_cli.py ingest`."
                          % perc["pending"]}
    if perc["invalid"]:
        return {"status": "blocked", "tex_sha256": tex_sha, "perception": perc,
                "reason": "one or more completed perception calls lack a valid view_image receipt: %s"
                          % perc["invalid"]}
    if perc["required"] and not perc["ingested"]:
        return {"status": "blocked", "tex_sha256": tex_sha, "perception": perc,
                "reason": "this case carries evidence that has to be perceived, and no perception call was "
                          "completed. A hypothesis formed without looking at the data is the failure mode this "
                          "system exists to prevent."}
    bad, checked = [], 0
    for tok, val in numbers(_prose_only(tex)):
        if _YEAR.match(tok):
            continue
        checked += 1
        if not grounded(val, gfloats):
            bad.append(tok)
    out = {"status": "ok" if not bad else "ungrounded", "tex_sha256": tex_sha,
           "checked": checked, "ledger_numbers": len(gfloats),
           "ledger": ledger,
           "perception": perc, "citations": citations,
           "ungrounded": sorted(set(bad), key=lambda s: -len(s))[:40]}
    if bad:
        p = os.path.join(hb.host_dir(td), LEDGER)
        if os.path.exists(p) and any(json.loads(l).get("truncated") for l in open(p)):
            out["note"] = ("a recorded run was clipped for size, so a number printed in the omitted part will "
                           "read as ungrounded. Print fewer intermediate lines and record again.")
    # Surface acceptance-lint reds here too: gate is the last thing a run checks, and a paper with
    # standing reds (too many numbers per paragraph, thin bibliography, tower figures) is not done.
    try:
        red = ((json.load(open(os.path.join(hb.host_dir(td), "paper.manifest.json"))).get("lint") or {})
               .get("red")) or []
    except Exception:
        red = []
    if red:
        out["lint_red"] = red
        out["lint_note"] = ("acceptance lint has RED items; the paper is not delivery-ready until this list "
                            "is empty. Fix them and recompile, or justify each survivor in one sentence in "
                            "your final report.")
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
        print(json.dumps({"case": td, **{k: out[k] for k in
                         ("script", "returncode", "truncated", "entry_sha256")}}, indent=2))
        sys.exit(out["returncode"])
    out = check(td, a.tex)
    print(json.dumps({"case": td, **out}, indent=2, ensure_ascii=False))
    sys.exit(0 if out["status"] == "ok" else 2)


if __name__ == "__main__":
    main()
