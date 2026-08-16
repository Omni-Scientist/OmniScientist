#!/usr/bin/env bash
set -euo pipefail

CASE_ROOT=$(mktemp -d)
CASE="$CASE_ROOT/slides"
cp -a /opt/omnisci/docker/fixtures/data/slides "$CASE"

/opt/omnisci/bin/omnisci --data "$CASE" --auto-approve \
  "Use the visible difference between healthy and late-blight leaves to choose one small, defensible quantitative question. Complete every OmniScientist stage and inspect the final PDF." \
  | tee "$CASE_ROOT/omnisci-e2e.log"

test -f "$CASE/series.json"
test -f "$CASE/host/paper.tex"
test -f "$CASE/host/paper_overleaf.zip"
test -f "$CASE/host/paper.pdf"
test -f "$CASE/host/paper.manifest.json"
test -n "$(find "$CASE/host/paper_review" -name '*.png' -print -quit)"
python3 "$OMNISCI/gate_cli.py" check --task "$CASE" --tex host/paper.tex
pdftotext "$CASE/host/paper.pdf" "$CASE_ROOT/paper.txt"
test -s "$CASE_ROOT/paper.txt"

echo "OmniScientist DeepSeek end-to-end test passed: $CASE/host/paper.pdf"
