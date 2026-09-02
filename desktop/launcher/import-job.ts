/**
 * 导入任务：把「复制一个文件夹进工作区」从一次阻塞到底的请求，改成可查进度的后台任务。
 *
 * 2026-09-02 Windows 实测：1500 个小文件的数据集复制了 47 秒，界面上只有一个不动的
 * "正在导入…"，用户以为卡死了。两件事一起修：Windows 用 robocopy 多线程复制（Node 的
 * fs.cp 是串行的，NTFS 加 Defender 逐文件扫描时慢一个量级），以及把已复制 / 总数报出来。
 *
 * 这里只放纯逻辑（计数、robocopy 参数与退出码、任务表），launcher/main.ts 一 import 就把
 * 服务起起来，测不了，所以能测的都搬到这。
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** 目录下所有条目数（文件 + 子目录），进度的分母和分子用同一种数法才对得上。文件返回 1。 */
export function countEntries(path: string): number {
  let st;
  try { st = statSync(path); } catch { return 0; }
  if (!st.isDirectory()) return 1;
  let n = 0;
  const stack = [path];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      n += 1;
      if (e.isDirectory()) stack.push(join(dir, e.name));
    }
  }
  return n;
}

/** 条目数 + 字节数。字节要 stat 每个文件，1500 个文件几十毫秒，可接受。 */
export function measureTree(path: string): { entries: number; bytes: number } {
  let st;
  try { st = statSync(path); } catch { return { entries: 0, bytes: 0 }; }
  if (!st.isDirectory()) return { entries: 1, bytes: st.size };
  let entries = 0, bytes = 0;
  const stack = [path];
  while (stack.length) {
    const dir = stack.pop()!;
    let list;
    try { list = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of list) {
      entries += 1;
      const full = join(dir, e.name);
      if (e.isDirectory()) stack.push(full);
      else { try { bytes += statSync(full).size; } catch { /* 消失的文件不算 */ } }
    }
  }
  return { entries, bytes };
}

/** 大到该提示"直接复制进工作区文件夹"的门槛：条目数或字节数任一超过。 */
export const IMPORT_HINT_ENTRIES = 2000;
export const IMPORT_HINT_BYTES = 1024 ** 3;
export function importNeedsHint(entries: number, bytes: number): boolean {
  return entries > IMPORT_HINT_ENTRIES || bytes > IMPORT_HINT_BYTES;
}

/**
 * robocopy 参数。/E 含空目录；/MT:16 十六线程，这是快的来源；/R:1 /W:1 别在锁住的文件上
 * 重试一百万次；其余是关掉逐文件日志，不然 1500 个文件就是 1500 行 stdout。
 */
export function robocopyArgs(source: string, target: string): string[] {
  return [source, target, "/E", "/MT:16", "/R:1", "/W:1", "/NFL", "/NDL", "/NJH", "/NJS", "/NP", "/NC", "/NS"];
}

/** robocopy 的退出码是位掩码：0-7 都算成功（1 = 有文件被复制），>= 8 才是失败。 */
export function robocopyOk(code: number | null): boolean {
  return code !== null && code >= 0 && code < 8;
}

export interface ImportJob {
  id: string;
  total: number;
  copied: number;
  done: boolean;
  path?: string;
  kind?: "dir" | "file";
  error?: string;
  startedAt: number;
}

const jobs = new Map<string, ImportJob>();
const JOB_TTL_MS = 10 * 60_000;

/** 建一个任务并立刻返回；run 在后台跑，通过 setCopied 报进度，抛错即失败。 */
export function startImportJob(
  total: number,
  run: (setCopied: (n: number) => void) => Promise<{ path: string; kind: "dir" | "file" }>,
  id = Math.random().toString(36).slice(2, 10),
): ImportJob {
  const job: ImportJob = { id, total, copied: 0, done: false, startedAt: Date.now() };
  jobs.set(id, job);
  for (const [k, j] of jobs) if (j.done && Date.now() - j.startedAt > JOB_TTL_MS) jobs.delete(k);
  run((n) => { job.copied = Math.min(n, job.total || n); })
    .then((r) => { job.path = r.path; job.kind = r.kind; job.copied = job.total || job.copied; })
    .catch((e) => { job.error = e instanceof Error ? e.message : String(e); })
    .finally(() => { job.done = true; });
  return job;
}

export function importJobStatus(id: string): ImportJob | null {
  return jobs.get(id) ?? null;
}
