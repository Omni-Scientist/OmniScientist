import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { platform } from "node:os";
import { resolve } from "node:path";
import type { Server } from "bun";

import {
  EXIT_CONFIG,
  EXIT_MISSING_DEPS,
  EXIT_OK,
  EXIT_PORT_BUSY,
  UsageError,
  parseArgs,
  type Options,
} from "./args.ts";
import { doctor } from "./doctor.ts";
import { ensureOmniHome, readEnvFile } from "./env-file.ts";
import { Logger } from "./log.ts";
import { findLiveInstance, releaseLock, writeLock } from "./lock.ts";
import { defaultWorkspace } from "./paths.ts";
import { createServer } from "./server.ts";

// Replaced at build time by build.sh; the fallback only shows in `bun run src/main.ts`.
const VERSION = process.env.OMNISCI_DESKTOP_VERSION ?? "0.0.0-dev";

function openBrowser(url: string, log: Logger): void {
  const command =
    platform() === "darwin"
      ? ["open", url]
      : platform() === "win32"
        ? ["cmd", "/c", "start", "", url]
        : ["xdg-open", url];
  try {
    Bun.spawn(command, { stdout: "ignore", stderr: "ignore", stdin: "ignore" }).unref();
  } catch (error) {
    log.warn(`could not launch a browser: ${String(error)}`);
  }
}

function listen(
  options: Options,
  context: Parameters<typeof createServer>[0],
  log: Logger,
): Server {
  const requested = options.port;
  try {
    return createServer(context, requested ?? 0);
  } catch (error) {
    // Bun reports this as `code: "EADDRINUSE"` with a message that does not
    // contain the code, so match on the property first.
    const code = (error as NodeJS.ErrnoException).code;
    const message = error instanceof Error ? error.message : String(error);
    const busy = code === "EADDRINUSE" || /in use|address already/i.test(message);
    if (!busy || requested === null) throw error;
    if (options.portIsExplicit) {
      // An explicit --port is a promise to the caller: fail loudly rather than
      // silently listening somewhere they are not looking.
      log.error(`port ${requested} is already in use`);
      process.stderr.write(`omnisci-desktop: port ${requested} is already in use\n`);
      process.exit(EXIT_PORT_BUSY);
    }
    log.warn(`OMNISCI_GATEWAY_PORT=${requested} is taken, falling back to an ephemeral port`);
    return createServer(context, 0);
  }
}

async function main(): Promise<void> {
  let options: Options;
  try {
    const parsed = parseArgs(process.argv.slice(2), process.env, VERSION);
    if (typeof parsed === "string") {
      process.stdout.write(`${parsed}\n`);
      process.exit(EXIT_OK);
    }
    options = parsed;
  } catch (error) {
    const message = error instanceof UsageError ? error.message : String(error);
    process.stderr.write(`omnisci-desktop: ${message}\n`);
    process.exit(EXIT_CONFIG);
  }

  const log = new Logger(options.verbose);
  log.info(`omnisci-desktop ${VERSION} starting (pid ${process.pid})`);

  // Single instance. A second launch is a request to show the window, not to
  // start a second service. the desktop service contract (3).
  const live = await findLiveInstance();
  if (live) {
    log.info(`an instance is already running on port ${live.port} (pid ${live.pid})`);
    if (options.open) openBrowser(live.url, log);
    process.stdout.write(`omnisci-desktop already-running url=${live.url} port=${live.port} pid=${live.pid}\n`);
    process.exit(EXIT_OK);
  }

  const workspace = resolve(options.workspace ?? defaultWorkspace());
  try {
    ensureOmniHome();
    mkdirSync(workspace, { recursive: true });
  } catch (error) {
    process.stderr.write(`omnisci-desktop: cannot create workspace ${workspace}: ${String(error)}\n`);
    log.error(`cannot create workspace ${workspace}: ${String(error)}`);
    process.exit(EXIT_CONFIG);
  }
  log.info(`workspace: ${workspace}`);

  // Credentials are read for their names only. Values stay in the file and are
  // registered with the logger so they can never be printed. the desktop service contract (7).
  const credentials = readEnvFile();
  for (const value of Object.values(credentials.values)) log.hide(value);
  log.info(
    Object.keys(credentials.values).length > 0
      ? `credentials: ${Object.keys(credentials.values).sort().join(", ")}`
      : "credentials: none configured yet, the workbench will ask",
  );
  if (credentials.malformedLines.length > 0) {
    log.warn(`~/.omnisci/env has malformed lines: ${credentials.malformedLines.join(", ")}`);
  }

  if (options.requireDeps) {
    const report = await doctor();
    if (!report.ok) {
      const bad = report.checks.filter((check) => check.status !== "ok").map((check) => check.label);
      process.stderr.write(`omnisci-desktop: missing runtime dependencies: ${bad.join(", ")}\n`);
      log.error(`missing runtime dependencies: ${bad.join(", ")}`);
      process.exit(EXIT_MISSING_DEPS);
    }
  }

  const token = randomBytes(32).toString("hex");
  log.hide(token);

  let server: Server | null = null;
  let shuttingDown = false;
  const shutdown = (code: number): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`shutting down with code ${code}`);
    try {
      server?.stop(true);
    } catch {
      // Already stopped.
    }
    releaseLock(process.pid);
    process.exit(code);
  };

  server = listen(options, { token, workspace, version: VERSION, log, onQuit: () => shutdown(EXIT_OK) }, log);

  const port = server.port;
  const url = `http://127.0.0.1:${port}/?t=${token}`;
  writeLock({
    pid: process.pid,
    port,
    token,
    url,
    version: VERSION,
    startedAt: new Date().toISOString(),
  });
  log.info(`listening on 127.0.0.1:${port}`);

  process.on("SIGINT", () => shutdown(EXIT_OK));
  process.on("SIGTERM", () => shutdown(EXIT_OK));
  process.on("exit", () => releaseLock(process.pid));

  // The menu-bar host reads this line as a fallback when it cannot parse the
  // lock file. Keep the shape stable: key=value pairs after the state word.
  process.stdout.write(`omnisci-desktop ready url=${url} port=${port} pid=${process.pid}\n`);

  if (options.open) openBrowser(url, log);
}

await main();
