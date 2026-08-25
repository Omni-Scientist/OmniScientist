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

/**
 * 分支查出来之后记多久。
 *
 * 桌面版每开一个会话都会走一次 gatherSignals，而 Windows 上 spawn 一次 git 要
 * 210 到 776 毫秒（2026-08-25 实测），全在请求处理器里同步付掉。分支不会在两次
 * 开会话之间自己变，所以按目录记一小会儿。代价是切完分支后半分钟内新建的会话
 * 还认旧分支，那只影响挑哪几条规范进提示词，不影响任何判断的对错。
 */
const BRANCH_TTL_MS = 30_000;
const branchCache = new Map<string, { at: number; branch: string | null }>();

function gitBranch(cwd: string): string | null {
  const hit = branchCache.get(cwd);
  if (hit && Date.now() - hit.at < BRANCH_TTL_MS) return hit.branch;

  let branch: string | null = null;
  try {
    const proc = Bun.spawnSync(["git", "rev-parse", "--abbrev-ref", "HEAD"], {
      cwd,
      env: safeChildEnvironment(),
      stdout: "pipe",
      stderr: "ignore",
    });
    if (proc.exitCode === 0) branch = new TextDecoder().decode(proc.stdout).trim() || null;
  } catch {
    // 机器上没装 git 时 Bun.spawnSync 是**抛**，不是返回非零。以前没接住，于是
    // 干净的 Windows 上这一抛顺着 gatherSignals → createRuntime 冒出去，
    // 每次打开会话都变成 404。没有 git 就是没有分支信号，别的信号照常工作。
    branch = null;
  }
  branchCache.set(cwd, { at: Date.now(), branch });
  return branch;
}

/** 只给测试用：清掉分支缓存。 */
export function resetSignalCache(): void {
  branchCache.clear();
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
