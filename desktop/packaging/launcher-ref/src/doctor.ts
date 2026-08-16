import { existsSync } from "node:fs";
import { join } from "node:path";

import { managedBinDir, venvPython } from "./paths.ts";

export type CheckStatus = "ok" | "missing" | "outdated" | "incomplete";

export interface Check {
  id: "python" | "python-packages" | "tectonic";
  label: string;
  status: CheckStatus;
  version: string | null;
  detail: string;
  /** Absolute path of what we found, so the UI can show which one is in use. */
  path: string | null;
}

export interface DoctorReport {
  ok: boolean;
  managed: { venv: string; bin: string };
  checks: Check[];
}

/**
 * Import names, not pip names. Source of truth for the pip names is
 * skill/omnisci/requirements.txt; keep the two in step.
 */
export const REQUIRED_MODULES: Array<{ pip: string; module: string }> = [
  { pip: "numpy", module: "numpy" },
  { pip: "pandas", module: "pandas" },
  { pip: "matplotlib", module: "matplotlib" },
  { pip: "sympy", module: "sympy" },
  { pip: "imageio", module: "imageio" },
  { pip: "soundfile", module: "soundfile" },
  { pip: "scipy", module: "scipy" },
  { pip: "scikit-learn", module: "sklearn" },
];

const MIN_PYTHON: [number, number] = [3, 10];

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export async function run(cmd: string[], timeoutMs = 20_000): Promise<RunResult> {
  try {
    const child = Bun.spawn(cmd, {
      stdout: "pipe",
      stderr: "pipe",
      // Credentials never reach a child process. the desktop service contract (7).
      env: strippedEnv(),
    });
    const timer = setTimeout(() => child.kill(), timeoutMs);
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    clearTimeout(timer);
    return { code, stdout, stderr };
  } catch (error) {
    return { code: 127, stdout: "", stderr: String(error) };
  }
}

/** A child environment with every credential-shaped variable removed. */
export function strippedEnv(extra: Record<string, string> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (/(?:^|_)(?:API_?KEY|TOKEN|SECRET|PASSWORD)$/i.test(key)) continue;
    if (/^(?:OPENAI|ANTHROPIC|DEEPSEEK|GEMINI|GOOGLE|MOONSHOT|DASHSCOPE|QWEN)_/i.test(key)) continue;
    out[key] = value;
  }
  return { ...out, ...extra };
}

function parsePythonVersion(text: string): [number, number, string] | null {
  const match = /Python (\d+)\.(\d+)(?:\.\d+)?/.exec(text);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), match[0].replace("Python ", "")];
}

/** The managed venv wins over whatever is on PATH, so bootstrap is authoritative. */
export async function findPython(): Promise<{ path: string; version: [number, number, string] } | null> {
  const candidates = [venvPython(), "python3", "python"];
  for (const candidate of candidates) {
    if (candidate.includes("/") && !existsSync(candidate)) continue;
    const result = await run([candidate, "-V"], 8000);
    if (result.code !== 0) continue;
    const version = parsePythonVersion(`${result.stdout}${result.stderr}`);
    if (version) return { path: candidate, version };
  }
  return null;
}

export async function findTectonic(): Promise<{ path: string; version: string } | null> {
  const managed = join(managedBinDir(), process.platform === "win32" ? "tectonic.exe" : "tectonic");
  const candidates = [managed, "tectonic"];
  for (const candidate of candidates) {
    if (candidate.includes("/") && !existsSync(candidate)) continue;
    const result = await run([candidate, "--version"], 8000);
    if (result.code !== 0) continue;
    const line = `${result.stdout}${result.stderr}`.trim().split("\n")[0] ?? "";
    return { path: candidate, version: line };
  }
  return null;
}

export async function doctor(): Promise<DoctorReport> {
  const checks: Check[] = [];

  const python = await findPython();
  if (!python) {
    checks.push({
      id: "python",
      label: "Python 3.10+",
      status: "missing",
      version: null,
      path: null,
      detail: "No python3 was found. Run the guided setup to install a managed one.",
    });
  } else {
    const [major, minor, printed] = python.version;
    const tooOld = major < MIN_PYTHON[0] || (major === MIN_PYTHON[0] && minor < MIN_PYTHON[1]);
    checks.push({
      id: "python",
      label: "Python 3.10+",
      status: tooOld ? "outdated" : "ok",
      version: printed,
      path: python.path,
      detail: tooOld ? `Found ${printed}, need 3.10 or newer.` : `Using ${python.path}`,
    });
  }

  if (!python) {
    checks.push({
      id: "python-packages",
      label: "Analysis packages",
      status: "missing",
      version: null,
      path: null,
      detail: "Cannot check without a Python interpreter.",
    });
  } else {
    // One interpreter start for all of them: importing eight modules serially
    // costs several seconds otherwise.
    const probe = REQUIRED_MODULES.map(
      (m) => `try:\n import ${m.module}\n print("ok ${m.pip}")\nexcept Exception:\n print("no ${m.pip}")`,
    ).join("\n");
    const result = await run([python.path, "-c", probe], 60_000);
    const missing = REQUIRED_MODULES.filter((m) => result.stdout.includes(`no ${m.pip}`)).map((m) => m.pip);
    const unknown = REQUIRED_MODULES.filter(
      (m) => !result.stdout.includes(`no ${m.pip}`) && !result.stdout.includes(`ok ${m.pip}`),
    ).map((m) => m.pip);
    const bad = [...missing, ...unknown];
    checks.push({
      id: "python-packages",
      label: "Analysis packages",
      status: bad.length === 0 ? "ok" : bad.length === REQUIRED_MODULES.length ? "missing" : "incomplete",
      version: null,
      path: python.path,
      detail:
        bad.length === 0
          ? `All ${REQUIRED_MODULES.length} present`
          : `Missing: ${bad.join(", ")}`,
    });
  }

  const tectonic = await findTectonic();
  checks.push({
    id: "tectonic",
    label: "tectonic (LaTeX to PDF)",
    status: tectonic ? "ok" : "missing",
    version: tectonic?.version ?? null,
    path: tectonic?.path ?? null,
    detail: tectonic
      ? `Using ${tectonic.path}`
      : "Not installed. Research still runs; it stops at the .tex file instead of a PDF.",
  });

  return {
    ok: checks.every((check) => check.status === "ok"),
    managed: { venv: venvPython(), bin: managedBinDir() },
    checks,
  };
}
