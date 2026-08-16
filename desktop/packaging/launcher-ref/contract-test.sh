#!/usr/bin/env bash
# Conformance test for the omnisci-desktop runtime contract, the desktop service contract (3).
#
#   ./contract-test.sh path/to/omnisci-desktop
#
# It asserts only what the contract states, never one implementation's choices:
# the session is discovered through ~/.omnisci/desktop.lock, and nothing depends
# on the wording a particular binary prints. Assertions for behaviour the
# contract leaves open are marked SOFT and reported without failing the run.
#
# The whole thing runs under a throwaway HOME, so the real ~/.omnisci and the
# real workspace are never touched.
set -uo pipefail

BIN="${1:-dist/omnisci-desktop}"
[ -x "$BIN" ] || { echo "no executable at $BIN" >&2; exit 1; }
BIN=$(cd "$(dirname "$BIN")" && pwd)/$(basename "$BIN")

WORK=$(mktemp -d)
export HOME="$WORK/home"
mkdir -p "$HOME"
OMNI_HOME="$HOME/.omnisci"
LOCK="$OMNI_HOME/desktop.lock"
export OMNISCI_HOME="$OMNI_HOME"     # honoured by implementations that support it
export OMNISCI_WORKSPACE_ROOT="$WORK/workspace"
LOG="$WORK/stdout.txt"

pass=0; fail=0; soft=0
ok()   { printf '  \033[32mPASS\033[0m %s\n' "$1"; pass=$((pass+1)); }
bad()  { printf '  \033[31mFAIL\033[0m %s\n' "$1"; fail=$((fail+1)); }
skip() { printf '  \033[33mSKIP\033[0m %s\n' "$1"; soft=$((soft+1)); }
check(){ if [ "$2" = "$3" ]; then ok "$1 ($3)"; else bad "$1: expected $3, got $2"; fi; }
softcheck(){ if [ "$2" = "$3" ]; then ok "$1 ($3)"; else skip "$1: expected $3, got $2 (contract does not mandate this)"; fi; }

cleanup() {
  for pid in ${PID:-} ${ENVPID:-} ${SIGPID:-} ${HOLDER:-}; do
    kill -TERM "$pid" 2>/dev/null
  done
}
trap cleanup EXIT

code() { curl -sS -o /dev/null -w '%{http_code}' "$@"; }

# The lock file is the contract's own way of publishing the session, so it is
# what the test reads. Falls back to scraping a URL out of stdout.
read_session() {
  if [ -f "$LOCK" ]; then
    PORT=$(python3 -c "import json;print(json.load(open('$LOCK'))['port'])" 2>/dev/null)
    TOKEN=$(python3 -c "import json;print(json.load(open('$LOCK'))['token'])" 2>/dev/null)
  fi
  if [ -z "${PORT:-}" ] || [ -z "${TOKEN:-}" ]; then
    URL=$(grep -oE 'http://127\.0\.0\.1:[0-9]+/\?t=[A-Za-z0-9._-]+' "$1" | head -1)
    PORT=$(echo "$URL" | sed -E 's|.*:([0-9]+)/.*|\1|')
    TOKEN=${URL##*t=}
  fi
  [ -n "${PORT:-}" ] && [ -n "${TOKEN:-}" ]
}

echo "== startup =="
echo "  binary: $BIN"
"$BIN" --no-open --verbose > "$LOG" 2>&1 &
PID=$!
for _ in $(seq 1 150); do
  read_session "$LOG" && curl -sS -m 1 -o /dev/null "http://127.0.0.1:$PORT/api/health" 2>/dev/null && break
  sleep 0.2
done
if ! read_session "$LOG"; then
  echo "  never published a session (no lock file, no url on stdout). stdout was:"
  sed 's/^/    /' "$LOG"
  exit 1
fi
echo "  port=$PORT token=${TOKEN:0:8}…"

echo "== health =="
HEALTH=$(curl -sS "http://127.0.0.1:$PORT/api/health")
check "health needs no token" "$(code "http://127.0.0.1:$PORT/api/health")" "200"
check "health says ok"        "$(echo "$HEALTH" | grep -c '"ok":true')" "1"
check "health reports the bound port" "$(echo "$HEALTH" | grep -o '"port":[0-9]*' | cut -d: -f2)" "$PORT"
check "health reports the workspace"  "$(echo "$HEALTH" | grep -c "$OMNISCI_WORKSPACE_ROOT")" "1"
check "health reports a version"      "$(echo "$HEALTH" | grep -c '"version"')" "1"
check "workspace was created"         "$([ -d "$OMNISCI_WORKSPACE_ROOT" ] && echo yes || echo no)" "yes"

echo "== the session handshake =="
# The contract publishes the session as a URL with ?t=<token>. What the server
# does with it afterwards is its business: answer 200 and let the page carry the
# token, or mint a cookie and redirect. Both are exercised the same way, by
# following redirects with a cookie jar, which is what a browser does.
COOKIES="$WORK/cookies.txt"
check "index with the token" "$(code -L -c "$COOKIES" "http://127.0.0.1:$PORT/?t=$TOKEN")" "200"
check "index with a wrong token is refused" \
  "$(code -L -o /dev/null "http://127.0.0.1:$PORT/?t=wrong")" "401"
if [ -s "$COOKIES" ] && grep -qi 'token\|session' "$COOKIES"; then
  ok "the handshake set a session cookie"
  AUTH=(-b "$COOKIES")
else
  skip "no session cookie was set; falling back to the token on the query string"
  AUTH=()
fi
authed() { code "${AUTH[@]+"${AUTH[@]}"}" "$@"; }

echo "== token enforcement =="
check "api without any credential"  "$(code "http://127.0.0.1:$PORT/api/doctor")" "401"
check "api with a wrong token"      "$(code "http://127.0.0.1:$PORT/api/doctor?t=wrong")" "401"
check "api after the handshake"     "$(authed "http://127.0.0.1:$PORT/api/doctor?t=$TOKEN")" "200"
check "the session api is guarded too" "$(code "http://127.0.0.1:$PORT/api/v1/sessions")" "401"
softcheck "api with a header token" "$(code -H "x-omnisci-token: $TOKEN" "http://127.0.0.1:$PORT/api/doctor")" "200"

echo "== doctor =="
DOCTOR=$(curl -sS "${AUTH[@]+"${AUTH[@]}"}" "http://127.0.0.1:$PORT/api/doctor?t=$TOKEN")
for want in python tectonic; do
  check "doctor mentions $want" "$(echo "$DOCTOR" | grep -ci "$want")" "1"
done

echo "== binding =="
LISTEN=$(lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | awk -v p="$PID" '$2 == p {print $9}')
check "listens on loopback only" "$(echo "$LISTEN" | grep -c '^127\.0\.0\.1:')" "1"
check "no wildcard listener"     "$(echo "$LISTEN" | grep -cE '^(\*|0\.0\.0\.0)')" "0"
LAN_IP=$(ipconfig getifaddr en0 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}')
if [ -n "$LAN_IP" ]; then
  check "unreachable on the LAN address ($LAN_IP)" \
    "$(curl -sS -m 3 -o /dev/null -w '%{http_code}' "http://$LAN_IP:$PORT/api/health" 2>/dev/null)" "000"
else
  skip "no LAN address on this machine"
fi
softcheck "rejects a non-loopback Host header" \
  "$(code -H "host: evil.example.com" "http://127.0.0.1:$PORT/api/health")" "403"

echo "== lock file =="
check "lock exists"       "$([ -f "$LOCK" ] && echo yes || echo no)" "yes"
check "lock records the pid" "$(python3 -c "import json;print(json.load(open('$LOCK')).get('pid'))" 2>/dev/null)" "$PID"
softcheck "lock is 0600 (it holds the token)" "$(stat -f '%Lp' "$LOCK" 2>/dev/null || stat -c '%a' "$LOCK")" "600"

echo "== single instance =="
SECOND=$("$BIN" --no-open 2>&1); SECOND_CODE=$?
check "second launch exits 0" "$SECOND_CODE" "0"
check "second launch points at the running port" "$(echo "$SECOND" | grep -c ":$PORT/")" "1"
check "no second service came up" \
  "$(python3 -c "import json;print(json.load(open('$LOCK'))['pid'])")" "$PID"

echo "== credentials =="
mkdir -p "$OMNI_HOME"
# a fake key on purpose: the point is proving it never reaches the log
printf 'DEEPSEEK_API_KEY=sk-contract-test-secret-value\nbroken line here\n' > "$OMNI_HOME/env"  # scan-leaks: allow
chmod 600 "$OMNI_HOME/env"
CRED_CODE=$(authed "http://127.0.0.1:$PORT/api/credentials?t=$TOKEN")
if [ "$CRED_CODE" = "200" ]; then
  CREDS=$(curl -sS "${AUTH[@]+"${AUTH[@]}"}" "http://127.0.0.1:$PORT/api/credentials?t=$TOKEN")
  check "credential names are listed"       "$(echo "$CREDS" | grep -c DEEPSEEK_API_KEY)" "1"
  check "credential values are not returned" "$(echo "$CREDS" | grep -c 'sk-contract-test')" "0"
else
  skip "no GET /api/credentials (the contract does not name one); value exposure unchecked"
fi

echo "== the log never carries a secret =="
LOGFILE=$(ls "$OMNI_HOME"/logs/desktop-*.log 2>/dev/null | head -1)
if [ -n "$LOGFILE" ]; then
  ok "log file exists ($(basename "$LOGFILE"))"
  check "session token absent from the log" "$(grep -c "$TOKEN" "$LOGFILE")" "0"
  check "api key absent from the log"       "$(grep -c 'sk-contract-test-secret-value' "$LOGFILE")" "0"  # scan-leaks: allow
else
  bad "no log under $OMNI_HOME/logs"
fi

echo "== quit =="
check "quit needs the token" "$(code -X POST "http://127.0.0.1:$PORT/api/quit")" "401"
curl -sS "${AUTH[@]+"${AUTH[@]}"}" -X POST "http://127.0.0.1:$PORT/api/quit?t=$TOKEN" > /dev/null
for _ in $(seq 1 50); do kill -0 "$PID" 2>/dev/null || break; sleep 0.1; done
check "process is gone after quit" "$(kill -0 "$PID" 2>/dev/null && echo alive || echo gone)" "gone"
softcheck "lock file was released" "$([ -f "$LOCK" ] && echo present || echo removed)" "removed"
# Only disown it if it really died: clearing PID while the process is still up
# leaks a listener past the end of the run.
kill -0 "$PID" 2>/dev/null || PID=""

echo "== ports =="
python3 -c "
import socket, sys, time
s = socket.socket(); s.bind(('127.0.0.1', 0)); s.listen(1)
print(s.getsockname()[1]); sys.stdout.flush(); time.sleep(30)
" > "$WORK/busyport.txt" &
HOLDER=$!
for _ in $(seq 1 50); do [ -s "$WORK/busyport.txt" ] && break; sleep 0.1; done
BUSY=$(cat "$WORK/busyport.txt")
"$BIN" --no-open --port "$BUSY" > "$WORK/busy.txt" 2>&1
check "explicit --port on a taken port exits 2" "$?" "2"

rm -f "$LOCK" 2>/dev/null
OMNISCI_GATEWAY_PORT="$BUSY" "$BIN" --no-open --verbose > "$WORK/envport.txt" 2>&1 &
ENVPID=$!
ENV_OK=no
for _ in $(seq 1 100); do
  if [ -f "$LOCK" ]; then ENV_OK=yes; break; fi
  kill -0 "$ENVPID" 2>/dev/null || break
  sleep 0.1
done
if [ "$ENV_OK" = "yes" ]; then
  ENVPORT=$(python3 -c "import json;print(json.load(open('$LOCK'))['port'])" 2>/dev/null)
  softcheck "taken OMNISCI_GATEWAY_PORT falls back instead of dying" "$([ "$ENVPORT" != "$BUSY" ] && echo yes || echo no)" "yes"
else
  softcheck "taken OMNISCI_GATEWAY_PORT falls back instead of dying" "no" "yes"
fi
kill -TERM "$ENVPID" 2>/dev/null; wait "$ENVPID" 2>/dev/null; ENVPID=""
kill "$HOLDER" 2>/dev/null; HOLDER=""

echo "== signals and cli =="
rm -f "$LOCK" 2>/dev/null
"$BIN" --no-open > "$WORK/sig.txt" 2>&1 &
SIGPID=$!
for _ in $(seq 1 150); do [ -f "$LOCK" ] && break; sleep 0.1; done
kill -INT "$SIGPID" 2>/dev/null
# 放宽到 10 秒：机器忙的时候 5 秒会误报，实测干净退出只要 0.02 秒。
for _ in $(seq 1 100); do kill -0 "$SIGPID" 2>/dev/null || break; sleep 0.1; done
check "SIGINT exits cleanly" "$(kill -0 "$SIGPID" 2>/dev/null && echo alive || echo gone)" "gone"
softcheck "lock released after SIGINT" "$([ -f "$LOCK" ] && echo present || echo removed)" "removed"
SIGPID=""
"$BIN" --version  > /dev/null 2>&1; check "--version exits 0" "$?" "0"
"$BIN" --help     > /dev/null 2>&1; check "--help exits 0" "$?" "0"
"$BIN" --nonsense > /dev/null 2>&1; check "unknown flag exits 1" "$?" "1"

echo
echo "$pass passed, $fail failed, $soft skipped or soft"
[ "$fail" -eq 0 ]
