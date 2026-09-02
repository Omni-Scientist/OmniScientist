/**
 * 导入任务的纯逻辑。跑法：cd desktop && bun run test:unit
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { countEntries, importJobStatus, robocopyArgs, robocopyOk, startImportJob } from "../launcher/import-job.ts";

describe("导入任务", () => {
  test("条目计数：文件 + 子目录，文件本身算 1，不存在算 0", () => {
    const root = mkdtempSync(join(tmpdir(), "omni-import-"));
    mkdirSync(join(root, "a", "b"), { recursive: true });
    writeFileSync(join(root, "a", "x.npy"), "1"); writeFileSync(join(root, "a", "b", "y.npy"), "2"); writeFileSync(join(root, "z.json"), "3");
    expect(countEntries(root)).toBe(5);              // a, a/x, a/b, a/b/y, z
    expect(countEntries(join(root, "z.json"))).toBe(1);
    expect(countEntries(join(root, "nope"))).toBe(0);
  });

  test("robocopy：多线程、含空目录、不刷逐文件日志；退出码 0-7 成功，8 起失败", () => {
    const args = robocopyArgs("C:\\src", "C:\\dst");
    expect(args.slice(0, 2)).toEqual(["C:\\src", "C:\\dst"]);
    expect(args).toContain("/E"); expect(args).toContain("/MT:16"); expect(args).toContain("/NFL");
    for (const ok of [0, 1, 3, 7]) expect(robocopyOk(ok)).toBe(true);
    for (const bad of [8, 16, null]) expect(robocopyOk(bad)).toBe(false);
  });

  test("任务立刻返回，进度可查，完成后带路径；失败带错误", async () => {
    let tick!: (n: number) => void;
    const job = startImportJob(10, async (setCopied) => { tick = setCopied; await new Promise((r) => setTimeout(r, 20)); return { path: "ds", kind: "dir" }; }, "j1");
    expect(job.done).toBe(false);
    tick(4); expect(importJobStatus("j1")?.copied).toBe(4);
    await new Promise((r) => setTimeout(r, 40));
    const s = importJobStatus("j1")!; expect(s.done).toBe(true); expect(s.path).toBe("ds"); expect(s.copied).toBe(10);
    const bad = startImportJob(3, async () => { throw new Error("disk full"); }, "j2");
    await new Promise((r) => setTimeout(r, 10));
    expect(importJobStatus("j2")?.error).toBe("disk full"); expect(bad.done).toBe(true);
    expect(importJobStatus("nope")).toBeNull();
  });
});
