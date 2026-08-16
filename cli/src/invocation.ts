import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

export interface Invocation {
  root: string;
  /** 只有显式 --data 才有值，也只有它会启动论文交付校验。 */
  dataArg?: string;
  taskWords: string[];
}

function absolute(path: string): string {
  return resolve(path.replace(/^~/, homedir()));
}

/**
 * 区分三种入口：裸目录是交互工作区，普通文字是通用一次性任务，
 * 显式 --data 才是 OmniSci 的无人值守论文模式。
 */
export function resolveInvocation(
  cwd: string,
  data: string | undefined,
  positionals: string[],
): Invocation {
  const positionalPath = !data && positionals.length === 1
    ? absolute(positionals[0]!)
    : null;
  const positionalIsWorkspace = Boolean(
    positionalPath && existsSync(positionalPath) && statSync(positionalPath).isDirectory(),
  );
  const rootArg = data ?? (positionalIsWorkspace ? positionals[0]! : cwd);

  return {
    root: absolute(rootArg),
    dataArg: data,
    taskWords: positionalIsWorkspace ? [] : positionals,
  };
}
