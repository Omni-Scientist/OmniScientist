#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Perception-tool health self-check. For EACH modality it finds a real sample from examples/ and runs every
look_at_* / analyze_* tool, asserting the output is NON-DEGENERATE -- this catches a silently broken renderer
(e.g. the multichannel-signal orientation bug that rendered a 3x6000 waveform as a 3-point polyline). The VLM is
stubbed so the check is free; it exercises the load + render + native-analysis path, which is where breakage hides.

    python3 engine/omniscientist/selfcheck_tools.py   # check all modalities against the bundled examples
Exit code 0 = all tools healthy, 1 = at least one degenerate/broken tool.
"""
import os, sys, re, glob, json
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import evidence

EXROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "examples")


def _is_multichannel_npy(ap):
    try:
        import numpy as np
        s = np.load(ap, mmap_mode="r").shape
        # (few channels OR a much longer sample axis) with many samples: the transpose-sensitive case (matches _a_signal)
        return len(s) == 2 and s[0] < s[1] and (s[0] <= 16 or s[1] >= 4 * s[0]) and s[1] >= 64
    except Exception:
        return False


def _find_samples():
    """modality -> (case_dir, member_file_rel, abs_path). One real member per modality; for signal, PREFER a
    multichannel waveform so the orientation guard is actually exercised (that is what silently broke)."""
    samples = {}
    for sj in sorted(glob.glob(os.path.join(EXROOT, "*", "series.json"))):
        case = os.path.dirname(sj)
        try:
            members = json.load(open(sj)).get("members") or []
        except Exception:
            continue
        for m in members[:40]:
            rel = m.get("file", "")
            ap = os.path.join(case, rel)
            mod = m.get("modality") or evidence.EXT2MOD.get(os.path.splitext(rel)[1].lower())
            if not (mod and os.path.exists(ap)):
                continue
            if mod not in samples:
                samples[mod] = (case, rel, ap)
            elif mod == "signal" and ap.endswith(".npy") and _is_multichannel_npy(ap) \
                    and not _is_multichannel_npy(samples[mod][2]):
                samples[mod] = (case, rel, ap)                    # upgrade to a multichannel signal if the first was 1D
    return samples


def selfcheck(log=print):
    import numpy as np
    orig_vlm = evidence._vlm
    evidence._vlm = lambda png, q, mt=400: "VLM-STUB-OK"          # free: we test load+render, not the paid description
    results = []
    try:
        samples = _find_samples()
        for mod, tools in evidence._MOD_TOOLS.items():
            if mod not in samples:
                results.append((mod, "-", None, "no example sample for this modality")); continue
            case, rel, ap = samples[mod]
            for tool in tools:
                fn = evidence._FN.get(tool)
                if not fn:
                    continue
                try:
                    call_args = {"files": [rel]} if tool == "look_at_image" else {"file": rel}   # look_at_image reads 'files'
                    r = str(fn(call_args, case, {}, {"img_used": 0, "img_budget": 8}, lambda *a: None))
                    bad = (len(r.strip()) < 8) or any(k in r for k in ("NOT FOUND", "could not load", "could not read",
                                               "needs a WAV", "unknown tool", "(image budget reached)"))   # empty return == silently broken
                    note = r.replace("\n", " ")[:90]
                    if tool == "analyze_signal":                 # orientation guard: n must track the LONG axis
                        mm = re.search(r'"n":\s*(\d+)', r)
                        if mm and ap.endswith(".npy"):
                            n = int(mm.group(1)); dim = max(np.load(ap).shape)
                            if n < 0.5 * dim:
                                bad = True; note = "DEGENERATE n=%d vs raw max-dim %d (orientation bug)" % (n, dim)
                    results.append((mod, tool, not bad, note))
                except Exception as e:
                    results.append((mod, tool, False, "EXC %s: %s" % (type(e).__name__, e)))
    finally:
        evidence._vlm = orig_vlm
    ok = True
    for mod, tool, good, note in results:
        mark = "  -  " if good is None else (" OK  " if good else "FAIL ")
        if good is False:
            ok = False
        log("  [%s] %-16s %-16s %s" % (mark, mod, tool, note))
    log("  === %s ===" % ("ALL TOOLS HEALTHY" if ok else "BROKEN TOOL(S) DETECTED"))
    return ok


if __name__ == "__main__":
    sys.exit(0 if selfcheck() else 1)
