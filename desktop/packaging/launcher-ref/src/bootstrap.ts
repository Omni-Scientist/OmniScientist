import { chmodSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { arch, platform } from "node:os";
import { join } from "node:path";

import { REQUIRED_MODULES, findPython, strippedEnv } from "./doctor.ts";
import type { Logger } from "./log.ts";
import { managedBinDir, venvDir, venvPython } from "./paths.ts";

export type JobState = "idle" | "running" | "done" | "failed";

export interface JobEvent {
  seq: number;
  kind: "log" | "step" | "state";
  text: string;
}

const MAX_BUFFERED_EVENTS = 2000;

/**
 * One bootstrap at a time. Progress is a numbered event log so a client that
 * reconnects mid-run can replay from where it left off rather than seeing a
 * blank screen.
 */
export class BootstrapJob {
  state: JobState = "idle";
  step = "";
  error: string | null = null;
  private events: JobEvent[] = [];
  private seq = 0;
  private readonly listeners = new Set<(event: JobEvent) => void>();

  constructor(private readonly log: Logger) {}

  subscribe(listener: (event: JobEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  since(seq: number): JobEvent[] {
    return this.events.filter((event) => event.seq > seq);
  }

  private push(kind: JobEvent["kind"], text: string): void {
    const event: JobEvent = { seq: ++this.seq, kind, text: this.log.redact(text) };
    this.events.push(event);
    if (this.events.length > MAX_BUFFERED_EVENTS) this.events.splice(0, this.events.length - MAX_BUFFERED_EVENTS);
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A dead SSE connection must not take the job down.
      }
    }
  }

  private setStep(text: string): void {
    this.step = text;
    this.log.info(`bootstrap: ${text}`);
    this.push("step", text);
  }

  snapshot(): { state: JobState; step: string; error: string | null; seq: number } {
    return { state: this.state, step: this.step, error: this.error, seq: this.seq };
  }

  /** Returns false when a run is already in flight. */
  start(): boolean {
    if (this.state === "running") return false;
    this.state = "running";
    this.error = null;
    this.push("state", "running");
    void this.run()
      .then(() => {
        this.state = "done";
        this.setStep("Setup complete");
        this.push("state", "done");
      })
      .catch((error: unknown) => {
        this.state = "failed";
        this.error = String(error instanceof Error ? error.message : error);
        this.log.error(`bootstrap failed: ${this.error}`);
        this.push("state", "failed");
      });
    return true;
  }

  private async exec(cmd: string[], timeoutMs = 900_000): Promise<void> {
    this.push("log", `$ ${cmd.join(" ")}`);
    const child = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", env: strippedEnv() });
    const timer = setTimeout(() => child.kill(), timeoutMs);
    const pump = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
      const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
      let buffered = "";
      for (;;) {
        const { done, value } = await reader.read();
        buffered += value ?? "";
        const lines = buffered.split("\n");
        buffered = lines.pop() ?? "";
        for (const line of lines) if (line.trim()) this.push("log", line.trimEnd());
        if (done) break;
      }
      if (buffered.trim()) this.push("log", buffered.trimEnd());
    };
    const [, , code] = await Promise.all([pump(child.stdout), pump(child.stderr), child.exited]);
    clearTimeout(timer);
    if (code !== 0) throw new Error(`${cmd[0]} exited with ${code}`);
  }

  private async run(): Promise<void> {
    mkdirSync(managedBinDir(), { recursive: true });

    this.setStep("Locating a Python interpreter");
    const python = await findPython();
    if (!python) {
      throw new Error(
        "No python3 on this machine. Install Python 3.10+ (python.org or `brew install python`) and run setup again.",
      );
    }

    if (!existsSync(venvPython())) {
      this.setStep("Creating the managed environment");
      await this.exec([python.path, "-m", "venv", venvDir()], 300_000);
    } else {
      this.setStep("Reusing the existing managed environment");
    }

    this.setStep("Upgrading pip");
    await this.exec([venvPython(), "-m", "pip", "install", "--upgrade", "pip", "--disable-pip-version-check"]);

    this.setStep("Installing analysis packages");
    await this.exec([
      venvPython(),
      "-m",
      "pip",
      "install",
      "--disable-pip-version-check",
      ...REQUIRED_MODULES.map((m) => m.pip),
    ]);

    this.setStep("Installing tectonic");
    await this.installTectonic();
  }

  private async installTectonic(): Promise<void> {
    const target = join(managedBinDir(), platform() === "win32" ? "tectonic.exe" : "tectonic");
    if (existsSync(target)) {
      this.push("log", `tectonic already present at ${target}`);
      return;
    }
    const asset = await resolveTectonicAsset();
    this.push("log", `downloading ${asset.name} (${(asset.size / 1e6).toFixed(1)} MB)`);
    const response = await fetch(asset.url, { redirect: "follow" });
    if (!response.ok) throw new Error(`tectonic download failed: HTTP ${response.status}`);

    const scratch = join(managedBinDir(), `.tectonic-${process.pid}`);
    rmSync(scratch, { recursive: true, force: true });
    mkdirSync(scratch, { recursive: true });
    const archive = join(scratch, asset.name);
    await Bun.write(archive, await response.arrayBuffer());

    // bsdtar handles both .tar.gz and .zip, and ships with macOS, Linux and
    // Windows 10+, so one command covers every platform.
    await this.exec(["tar", "-xf", archive, "-C", scratch], 300_000);

    const binary = join(scratch, platform() === "win32" ? "tectonic.exe" : "tectonic");
    if (!existsSync(binary)) throw new Error(`the tectonic archive did not contain a tectonic binary`);
    renameSync(binary, target);
    if (platform() !== "win32") chmodSync(target, 0o755);
    rmSync(scratch, { recursive: true, force: true });
    this.push("log", `installed ${target}`);
  }
}

interface TectonicAsset {
  name: string;
  url: string;
  size: number;
}

/** Rust target triple for the machine we are on. */
export function hostTriple(): string {
  const cpu = arch() === "arm64" ? "aarch64" : "x86_64";
  switch (platform()) {
    case "darwin":
      return `${cpu}-apple-darwin`;
    case "win32":
      return `${cpu}-pc-windows-msvc`;
    default:
      return `${cpu}-unknown-linux-gnu`;
  }
}

/**
 * Asks GitHub for the newest stable `tectonic@` release rather than pinning a
 * URL that goes stale. Per-crate tags (tectonic_io_base@...) share the repo and
 * are filtered out.
 */
export async function resolveTectonicAsset(): Promise<TectonicAsset> {
  const response = await fetch(
    "https://api.github.com/repos/tectonic-typesetting/tectonic/releases?per_page=100",
    { headers: { accept: "application/vnd.github+json" } },
  );
  if (!response.ok) throw new Error(`GitHub releases API returned ${response.status}`);
  const releases = (await response.json()) as Array<{
    tag_name: string;
    prerelease: boolean;
    assets: Array<{ name: string; browser_download_url: string; size: number }>;
  }>;

  const triple = hostTriple();
  for (const release of releases) {
    if (release.prerelease || !release.tag_name.startsWith("tectonic@")) continue;
    const asset = release.assets.find(
      (candidate) => candidate.name.includes(triple) && /\.(tar\.gz|zip)$/.test(candidate.name),
    );
    if (asset) return { name: asset.name, url: asset.browser_download_url, size: asset.size };
  }
  throw new Error(`no published tectonic build for ${triple}`);
}
