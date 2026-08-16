/**
 * 触发器：从当前处境里采集信号。
 *
 * 只采能确凿观察到的东西：工作目录、目录里有哪些文件、git 分支、这次输入说了什么。
 * 不做「猜他大概想干嘛」那种推断，猜错一次主动就变成添乱。
 */

import { readdirSync } from "node:fs";

import type { ContextSignals } from "./standards.ts";
import { safeChildEnvironment } from "./credentials.ts";

// 只看顶层文件名就够判断「这是个什么场子」，不递归，避免大目录卡住
const MAX_FILENAMES = 400;

function gitBranch(cwd: string): string | null {
  const proc = Bun.spawnSync(["git", "rev-parse", "--abbrev-ref", "HEAD"], {
    cwd,
    env: safeChildEnvironment(),
    stdout: "pipe",
    stderr: "ignore",
  });
  if (proc.exitCode !== 0) return null;
  return new TextDecoder().decode(proc.stdout).trim() || null;
}

export function gatherSignals(cwd: string, userText = ""): ContextSignals {
  let filenames: string[] = [];
  try {
    filenames = readdirSync(cwd).slice(0, MAX_FILENAMES);
  } catch {
    // 目录读不了就是没有文件信号，其他信号照常工作。这不是错误。
    filenames = [];
  }
  return { cwd, filenames, userText, gitBranch: gitBranch(cwd) };
}
