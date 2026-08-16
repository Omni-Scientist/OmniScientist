# omnisci-desktop, reference implementation

the desktop service contract (3) describes a service binary the packaging work is supposed to
receive from the repository maintainer. At the time the macOS packaging started
that binary did not exist anywhere in the tree: no `desktop/launcher/`, no CI
producing `omnisci-desktop-darwin-*`, nothing implementing `/api/health`. Without
it there was nothing for the `.app` to wrap and nothing to test against, so this
was written to the contract instead.

**The real launcher has since landed** as `desktop/launcher/main.ts`, and it
passes the conformance suite here (36 assertions, 0 failures, 4 soft). The
shipping `.app` is built around that one. What still earns its keep in this
directory is `contract-test.sh`; the implementation beside it is now a second
opinion, useful for telling a launcher bug apart from a packaging bug, and
deletable the day someone finds it a better home.

It implements the contract and nothing beyond it: it serves the built workbench,
reports dependency status, installs the Python environment and tectonic, and manages
the process lifecycle. The research engine lives elsewhere, so anything under
`/api/v1/` answers `503`.

The `.app` needed no changes to move from this binary to the real one, which was
the point of writing it against the contract rather than against an
implementation.

## Build and run

```bash
cd ../..                       # desktop/
bun install && bun run build   # produces dist/, which gets embedded

cd packaging/launcher-ref
./build.sh --version 0.1.0 --out dist/omnisci-desktop
./dist/omnisci-desktop --no-open --verbose
```

Cross-compiling works from any host bun runs on:

```bash
./build.sh --target bun-darwin-arm64 --version 0.1.0
./build.sh --target bun-darwin-x64   --version 0.1.0
./build.sh --target bun-windows-x64  --version 0.1.0
```

## Checking a real binary against the contract

```bash
./contract-test.sh /path/to/the/real/omnisci-desktop
```

Every row of the SPEC section 3 table: loopback-only binding, token enforcement,
the lock file and its permissions, single instance, credential handling, log
scrubbing, quit, signals, port behaviour and exit codes. It runs under a throwaway
`HOME`, so it never touches your real settings or your real workspace, and it
discovers the session through the lock file rather than through anything a
particular binary prints.

Assertions the contract does not mandate are reported as SOFT and do not fail the
run: they are places two honest implementations may legitimately differ. Anything
that does fail is a contract gap worth raising before the packaging inherits it.

Results as of this writing: the real launcher 36 passed / 0 failed / 4 soft, this
reference 41 passed / 0 failed.

## Decisions this implementation had to make

The contract leaves four things open. Both implementations had to pick, and they
picked differently in places, which is worth knowing when reading the SOFT
results above.

1. **The lock file is JSON**: `{pid, port, token, url, version, startedAt}`, mode
   0600. The contract says the file records pid, port and token but not in what
   format. The menu-bar host reads it to learn the URL. It also tolerates extra
   fields, and falls back to parsing the ready line if the JSON does not parse.

2. **A ready line on stdout**:
   `omnisci-desktop ready url=<url> port=<n> pid=<n>`, and
   `omnisci-desktop already-running url=… port=… pid=…` when a live instance was
   found. This is the host's fallback path for learning the session.

3. **The page mints a cookie.** The contract says every API and SSE request
   carries the token; the frontend in `desktop/src` sends no token at all, and
   relies on the Vite dev proxy injecting a header, which does not exist in a
   packaged build. Rather than change `desktop/src`, loading `/?t=<token>` with a
   valid token sets a cookie here, and the API also accepts the token from the
   query string, `x-omnisci-token` or a bearer header. A request carrying none of
   them still gets 401. The real launcher solved the same problem better: it
   answers `/?t=` with a 302 and an HttpOnly cookie, so the token never stays in
   the address bar.

4. **Port conflicts differ by source.** `--port` on a taken port exits 2, because
   an explicit port is a promise to the caller. `OMNISCI_GATEWAY_PORT` on a taken
   port logs a warning and falls back to an ephemeral port, which is what
   acceptance item 21 asks for. With neither set, the port is ephemeral and
   cannot conflict.

Two smaller ones: exit code 3 (missing runtime dependencies) only ever fires
under `--require-deps`, since a missing tectonic is a degraded run rather than a
failure; and requests whose `Host` header is not loopback get 403, which costs
nothing and closes DNS rebinding.

## Files

| File | What |
|---|---|
| `src/main.ts` | startup, single instance, lock file, signals, browser launch |
| `src/server.ts` | HTTP surface, token enforcement, static assets |
| `src/doctor.ts` | python, package and tectonic detection |
| `src/bootstrap.ts` | venv creation, pip install, tectonic download, progress over SSE |
| `src/env-file.ts` | strict `KEY=VALUE` parsing and 0600 atomic writes |
| `src/lock.ts` | lock file read, write, liveness probe |
| `src/log.ts` | logging with credential scrubbing |
| `tools/gen-assets.ts` | embeds the built frontend into the binary |
| `contract-test.sh` | the contract, executable |
