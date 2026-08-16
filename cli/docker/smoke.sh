#!/usr/bin/env bash
set -euo pipefail

CASE_ROOT=$(mktemp -d)
IMAGE_CASE="$CASE_ROOT/slides"
cp -a /opt/omnisci/docker/fixtures/data/slides "$IMAGE_CASE"

python3 "$OMNISCI/case_cli.py" inspect --dir "$IMAGE_CASE"
python3 "$OMNISCI/case_cli.py" init --dir "$IMAGE_CASE" \
  --role "a plant pathologist reading leaf photographs" \
  --subject "a photograph of a single leaf" \
  --direction "Find a concrete, testable question these photographs can answer, choose the method yourself, and run real code to test it."

python3 "$OMNISCI/evidence_cli.py" tools --task "$IMAGE_CASE"
FIRST=$(python3 -c "import json; print(json.load(open('$IMAGE_CASE/series.json'))['members'][0]['file'])")
python3 "$OMNISCI/evidence_cli.py" run --task "$IMAGE_CASE" --tool look_at_image \
  --args "{\"files\":[\"$FIRST\"],\"question\":\"describe the visible leaf\"}" > "$CASE_ROOT/perception.json"
if python3 "$OMNISCI/evidence_cli.py" ingest --task "$IMAGE_CASE" --call 1; then
  echo "ingest unexpectedly accepted a perception call without view_image" >&2
  exit 1
fi

CASE="$CASE_ROOT/table"
cp -a /opt/omnisci/docker/fixtures/data/table "$CASE"
python3 "$OMNISCI/case_cli.py" init --dir "$CASE" \
  --role "a data analyst" \
  --subject "a grouped numeric observation" \
  --direction "Compare the two fixture groups with a recorded, reproducible analysis."
python3 "$OMNISCI/evidence_cli.py" tools --task "$CASE"

mkdir -p "$CASE/host/analysis"
cp /opt/omnisci/docker/fixtures/table_analysis.py "$CASE/host/analysis/"
python3 "$OMNISCI/lit_cli.py" search --doi 10.1038/s41597-022-01721-8 > "$CASE/host/picks.json"
python3 /opt/omnisci/docker/fixtures/table_sections.py > "$CASE/host/sections.json"
bun run /opt/omnisci/tests/delivery-smoke.ts "$CASE"

test -f "$CASE/host/paper.tex"
test -f "$CASE/host/paper_overleaf.zip"
test -f "$CASE/host/paper.pdf"
test -f "$CASE/host/paper.manifest.json"
test -n "$(find "$CASE/host/paper_review" -name '*.png' -print -quit)"
echo "OmniScientist container smoke test passed: $CASE/host/paper.pdf"
