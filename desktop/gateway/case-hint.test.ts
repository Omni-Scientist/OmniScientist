import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { caseHint, normalizeDataPath, snapToCase } from "./case-hint.ts";

const outer = mkdtempSync(join(tmpdir(), "omni-case-"));
const root = join(outer, "ws");
mkdirSync(join(root, "mycase", "data", "deep"), { recursive: true });
mkdirSync(join(root, "mycase", "stray"), { recursive: true });
mkdirSync(join(root, "bare"), { recursive: true });
// mycase 的 series.json 认领 data/ 下的文件；stray 没被认领
writeFileSync(join(root, "mycase", "series.json"), JSON.stringify({
  members: [{ idx: 0, file: "data/seis_0000.npy", label: "earthquake" }],
}));
// 工作区根自己也是个 case（members 空，不认领任何子目录）
writeFileSync(join(root, "series.json"), JSON.stringify({ members: [] }));
// 工作区根之外的 series.json，吸附永远不该认
writeFileSync(join(outer, "series.json"), JSON.stringify({
  members: [{ idx: 0, file: "ws/bare/x.npy" }],
}));

test("normalizeDataPath 把展示形态和绝对路径都归一成工作区相对路径", () => {
  expect(normalizeDataPath(root, "$WORKSPACE/a/b")).toBe("a/b");
  expect(normalizeDataPath(root, "$WORKSPACE//a/b")).toBe("a/b");
  expect(normalizeDataPath(root, "$WORKSPACE")).toBe(".");
  expect(normalizeDataPath(root, root)).toBe(".");
  expect(normalizeDataPath(root, join(root, "mycase"))).toBe("mycase");
  expect(normalizeDataPath(root, "mycase/data/")).toBe("mycase/data");
  expect(normalizeDataPath(root, "a/../b")).toBe("b");
  expect(normalizeDataPath(root, "")).toBe("");
  // $WORKSPACEfoo 不是占位符，别误剥
  expect(normalizeDataPath(root, "$WORKSPACEfoo")).toBe("$WORKSPACEfoo");
});

test("normalizeDataPath 表达不成工作区内路径的一律回空", () => {
  expect(normalizeDataPath(root, "../x")).toBe("");
  expect(normalizeDataPath(root, "$WORKSPACE/../x")).toBe("");
  expect(normalizeDataPath(root, "..")).toBe("");
  expect(normalizeDataPath(root, resolve(outer, "elsewhere"))).toBe("");
});

test("snapToCase 只吸附真正认领子目录的上层 case", () => {
  expect(snapToCase(root, "mycase/data")).toBe("mycase");
  expect(snapToCase(root, "mycase/data/deep")).toBe("mycase");
  // 上层有 series.json 但 members 不认领：不吸附，按裸数据处理
  expect(snapToCase(root, "mycase/stray")).toBe("mycase/stray");
  // 自己就有 series.json 或没有任何上层认领：原样
  expect(snapToCase(root, "mycase")).toBe("mycase");
  expect(snapToCase(root, "bare")).toBe("bare");
  expect(snapToCase(root, ".")).toBe(".");
  expect(snapToCase(root, "")).toBe("");
});

test("caseHint 第一级：目录里就有 series.json（含工作区根表示成 .）", () => {
  expect(caseHint(root, "mycase")).toContain("case root");
  expect(caseHint(root, "mycase")).toContain("mycase/host");
  expect(caseHint(root, "mycase")).toContain("omnisci_compile");
  expect(caseHint(root, ".")).toContain("case root");
});

test("caseHint 裸数据：case_cli 建档，判断不出才问一句并等回答", () => {
  const hint = caseHint(root, "bare");
  expect(hint).toContain("case_cli.py inspect");
  expect(hint).toContain("init");
  expect(hint).toContain("ask the user in one short question");
  expect(hint).toContain("end your turn");
  expect(hint).toContain("formats are supported");
});
