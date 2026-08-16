import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { LOG_DIR } from "./paths.ts";

type Level = "info" | "warn" | "error" | "debug";

/**
 * Credentials must never reach the log (the desktop service contract (7)). Two defences: every
 * literal secret the process knows about is registered here and scrubbed, and
 * anything that looks like a key is scrubbed by shape as well.
 */
const SECRET_SHAPES: RegExp[] = [
  /\b(sk-[A-Za-z0-9_-]{6})[A-Za-z0-9_-]+/g,
  /\b((?:OPENAI|ANTHROPIC|DEEPSEEK|GEMINI|GOOGLE|MOONSHOT|QWEN|DASHSCOPE)[A-Z0-9_]*(?:KEY|TOKEN|SECRET))\s*=\s*\S+/gi,
];

export class Logger {
  private readonly secrets = new Set<string>();
  private file: string | null = null;

  constructor(private readonly verbose: boolean) {
    try {
      mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 });
      const day = new Date().toISOString().slice(0, 10);
      this.file = join(LOG_DIR, `desktop-${day}.log`);
    } catch (error) {
      // A log we cannot open is not a reason to refuse to start; say so on
      // stderr once and carry on.
      process.stderr.write(`omnisci-desktop: cannot open log directory: ${String(error)}\n`);
      this.file = null;
    }
  }

  /** Register a literal that must never appear in the log (the session token). */
  hide(secret: string): void {
    if (secret.length >= 8) this.secrets.add(secret);
  }

  redact(text: string): string {
    let out = text;
    for (const secret of this.secrets) out = out.split(secret).join("[redacted]");
    for (const shape of SECRET_SHAPES) out = out.replace(shape, "$1[redacted]");
    return out;
  }

  private emit(level: Level, message: string): void {
    if (level === "debug" && !this.verbose) return;
    const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${this.redact(message)}\n`;
    if (this.file) {
      try {
        appendFileSync(this.file, line, { mode: 0o600 });
      } catch {
        // Disk full or permissions changed under us. Keep running.
      }
    }
    if (this.verbose || level === "error") process.stderr.write(line);
  }

  info(message: string): void {
    this.emit("info", message);
  }
  warn(message: string): void {
    this.emit("warn", message);
  }
  error(message: string): void {
    this.emit("error", message);
  }
  debug(message: string): void {
    this.emit("debug", message);
  }

  get path(): string | null {
    return this.file;
  }
}
