import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { ENV_FILE, OMNI_HOME } from "./paths.ts";

export interface ParsedEnv {
  values: Record<string, string>;
  /** 1-based line numbers that were not KEY=VALUE. Never carries the content. */
  malformedLines: number[];
}

const KEY_LINE = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;

/**
 * Strict KEY=VALUE. This file is never executed as shell: no `export`, no
 * substitution, no command interpolation, no continuation lines. the desktop service contract (3).
 */
export function parseEnvText(text: string): ParsedEnv {
  const values: Record<string, string> = {};
  const malformedLines: number[] = [];
  text.split(/\r?\n/).forEach((rawLine, index) => {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) return;
    const match = KEY_LINE.exec(line);
    if (!match) {
      malformedLines.push(index + 1);
      return;
    }
    let value = match[2]!.trim();
    const quoted =
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2);
    if (quoted) value = value.slice(1, -1);
    values[match[1]!] = value;
  });
  return { values, malformedLines };
}

export function readEnvFile(path: string = ENV_FILE): ParsedEnv {
  if (!existsSync(path)) return { values: {}, malformedLines: [] };
  return parseEnvText(readFileSync(path, "utf8"));
}

function serialize(values: Record<string, string>): string {
  const header = [
    "# OmniScientist credentials. Written by the desktop app; mode 0600.",
    "# Strict KEY=VALUE, one per line. This file is never run as a shell script.",
    "",
  ].join("\n");
  const body = Object.entries(values)
    .filter(([key]) => KEY_LINE.test(`${key}=`))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  return `${header}${body}\n`;
}

/**
 * Write atomically at 0600. The temp file is created with the final mode so the
 * secret is never briefly world-readable.
 */
export function writeEnvFile(values: Record<string, string>, path: string = ENV_FILE): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = join(dirname(path), `.env.${process.pid}.tmp`);
  writeFileSync(temp, serialize(values), { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, path);
  chmodSync(path, 0o600);
}

/** Merge new keys over the existing file. An empty value deletes the key. */
export function updateEnvFile(patch: Record<string, string>, path: string = ENV_FILE): string[] {
  const current = readEnvFile(path).values;
  for (const [key, value] of Object.entries(patch)) {
    if (value === "") delete current[key];
    else current[key] = value;
  }
  writeEnvFile(current, path);
  return Object.keys(current);
}

export function ensureOmniHome(): void {
  mkdirSync(OMNI_HOME, { recursive: true, mode: 0o700 });
}
