#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Evidence CLI for host mode: the harness drives the evidence layer from the shell.

  python evidence_cli.py tools  --task galaxy_xsurvey
  python evidence_cli.py run    --task galaxy_xsurvey --tool look_at_image \
                                --args '{"files": ["data/sdss/g024.jpg"], "question": "morphology?"}'
  python evidence_cli.py ingest --task galaxy_xsurvey --call 1 --answers '{"1": "smooth, diffuse, no arms"}'

`run` returns either a finished numeric result (analyze_* tools compute, no model involved) or a draft holding
<<VISION:n>> placeholders plus the images to look at. The host opens those images with its own multimodal read,
then `ingest` substitutes its answers back into the draft. That final text is what the agent reasons over.
"""
import os, sys, json, argparse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import hostbridge as hb


def _json_arg(raw, path):
    if path:
        return json.load(open(path))
    return json.loads(raw) if raw else {}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("tools", help="modalities this case unlocks + the tool schemas")
    p.add_argument("--task", required=True)

    p = sub.add_parser("run", help="run one evidence tool")
    p.add_argument("--task", required=True)
    p.add_argument("--tool", required=True)
    p.add_argument("--args", default="{}", help="tool arguments as JSON")
    p.add_argument("--args-file", help="read tool arguments from a JSON file instead")
    p.add_argument("--budget", type=int, help="max images the host is allowed to look at for this case")

    p = sub.add_parser("ingest", help="fill the host's answers into a pending call")
    p.add_argument("--task", required=True)
    p.add_argument("--call", required=True)
    p.add_argument("--answers", default="{}", help='{"1": "what you saw", ...} keyed by vision request id')
    p.add_argument("--answers-file")

    a = ap.parse_args()
    td = hb.resolve_task(a.task)

    if a.cmd == "tools":
        out = hb.list_tools(td)
    elif a.cmd == "run":
        out = hb.run_tool(td, a.tool, _json_arg(a.args, a.args_file), a.budget)
    else:
        out = hb.ingest(td, a.call, _json_arg(a.answers, a.answers_file))

    print(json.dumps({"case": td, **out} if isinstance(out, dict) else out,
                     indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
