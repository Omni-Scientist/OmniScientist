import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";

import { LOCK_FILE } from "./paths.ts";
import { ensureOmniHome } from "./env-file.ts";

export interface LockRecord {
  pid: number;
  port: number;
  token: string;
  url: string;
  version: string;
  startedAt: string;
}

/**
 * The lock file carries the session token, so it is a credential file: 0600, and
 * it is the only place the menu-bar host is expected to read the token from.
 */
export function readLock(path: string = LOCK_FILE): LockRecord | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<LockRecord>;
    if (typeof parsed.pid !== "number" || typeof parsed.port !== "number") return null;
    if (typeof parsed.token !== "string" || !parsed.token) return null;
    return {
      pid: parsed.pid,
      port: parsed.port,
      token: parsed.token,
      url: parsed.url ?? `http://127.0.0.1:${parsed.port}/?t=${parsed.token}`,
      version: parsed.version ?? "unknown",
      startedAt: parsed.startedAt ?? "unknown",
    };
  } catch {
    return null;
  }
}

export function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the pid exists but belongs to someone else, which for our
    // purposes still counts as "taken".
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Confirms the pid in the lock is actually our service and not a recycled pid. */
export async function probeHealth(port: number, timeoutMs = 1500): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return false;
    const body = (await response.json()) as { ok?: boolean };
    return body.ok === true;
  } catch {
    return false;
  }
}

/** Returns the live instance described by the lock file, or null. */
export async function findLiveInstance(path: string = LOCK_FILE): Promise<LockRecord | null> {
  const record = readLock(path);
  if (!record) return null;
  if (!processAlive(record.pid)) return null;
  if (!(await probeHealth(record.port))) return null;
  return record;
}

export function writeLock(record: LockRecord, path: string = LOCK_FILE): void {
  ensureOmniHome();
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
}

/** Only removes the lock when it is still ours. */
export function releaseLock(pid: number, path: string = LOCK_FILE): void {
  try {
    const record = readLock(path);
    if (record && record.pid !== pid) return;
    if (existsSync(path)) unlinkSync(path);
  } catch {
    // Nothing useful to do while shutting down.
  }
}
