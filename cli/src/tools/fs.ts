/**
 * 文件系统工具：list_dir / read_file / write_file / edit_file / grep_files。
 * 命名沿用 snake_case，跟 Claude Code 的 PascalCase 区分开。
 */

import { readdirSync, readFileSync, statSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join, relative } from "node:path";

import { sanitizeForDisplay } from "./shell.ts";
import type { Tool, ToolContext } from "./index.ts";

const MAX_FILE_BYTES = 2_000_000; // 超过这个体量整读没意义，让它分段或 grep
const MAX_INLINE_CHARS = 60_000; // 单次进上下文的上限，超了存 artifact
const SKIP_DIRS = new Set([
  ".git", "node_modules", "__pycache__", ".venv", "venv", ".mypy_cache", ".pytest_cache", "dist",
]);

function listDir(args: Record<string, unknown>, ctx: ToolContext): string {
  const path = ctx.resolve(String(args.path ?? "."));
  const st = statSync(path);
  if (!st.isDirectory()) throw new Error(`不是目录: ${path}`);

  const entries = readdirSync(path, { withFileTypes: true })
    .filter((e) => !SKIP_DIRS.has(e.name))
    .sort((a, b) => Number(a.isFile()) - Number(b.isFile()) || a.name.localeCompare(b.name))
    .map((e) => (e.isDirectory() ? `${e.name}/` : `${e.name}  ${statSync(join(path, e.name)).size}B`));
  return entries.length ? entries.join("\n") : "(空目录)";
}

function readFile(args: Record<string, unknown>, ctx: ToolContext): string {
  const rel = String(args.path);
  const path = ctx.resolve(rel);
  const size = statSync(path).size;
  if (size > MAX_FILE_BYTES) {
    throw new Error(
      `文件 ${rel} 有 ${size}B，超过 ${MAX_FILE_BYTES}B，太大了不适合整读。` +
      `用 offset/limit 分段读，或者用 grep_files 定位。`,
    );
  }
  let lines = readFileSync(path, "utf-8").split("\n");
  const offset = Number(args.offset ?? 0) || 0;
  const limit = args.limit === undefined ? undefined : Number(args.limit);
  lines = limit === undefined ? lines.slice(offset) : lines.slice(offset, offset + limit);
  const width = String(offset + lines.length).length;
  const body = lines.map((ln, i) => `${String(offset + i + 1).padStart(width)}\t${ln}`).join("\n");
  return ctx.artifacts.truncate(`read_file: ${rel}`, body, MAX_INLINE_CHARS);
}

function writeFile(args: Record<string, unknown>, ctx: ToolContext): string {
  const rel = String(args.path);
  const path = ctx.resolve(rel);
  const content = String(args.content ?? "");
  mkdirSync(dirname(path), { recursive: true });
  const existed = existsSync(path);
  writeFileSync(path, content, "utf-8");
  return `${existed ? "覆盖" : "新建"} ${rel}（${content.length} 字符）`;
}

function editFile(args: Record<string, unknown>, ctx: ToolContext): string {
  const rel = String(args.path);
  const path = ctx.resolve(rel);
  const oldStr = String(args.old_string);
  const newStr = String(args.new_string);
  if (oldStr === newStr) throw new Error("old_string 和 new_string 相同，这个编辑没有意义");

  const text = readFileSync(path, "utf-8");
  const count = text.split(oldStr).length - 1;
  if (count === 0) {
    throw new Error(`在 ${rel} 里找不到要替换的内容。原文可能有不同的缩进或空白。`);
  }
  if (count > 1 && !args.replace_all) {
    throw new Error(
      `要替换的内容在 ${rel} 里出现了 ${count} 次，不唯一。` +
      `把 old_string 扩大到唯一，或者传 replace_all=true。`,
    );
  }
  writeFileSync(path, text.split(oldStr).join(newStr), "utf-8");
  return `改好 ${rel}（替换 ${count} 处）`;
}

function* walk(dir: string): Generator<string> {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.isFile()) yield p;
  }
}

function globToRe(glob: string): RegExp {
  const body = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*").replaceAll("?", ".");
  return new RegExp(`^${body}$`);
}

function grepFiles(args: Record<string, unknown>, ctx: ToolContext): string {
  const root = ctx.resolve(String(args.path ?? "."));
  const pattern = new RegExp(String(args.pattern));
  const globRe = args.glob ? globToRe(String(args.glob)) : null;
  const maxHits = Number(args.max_results ?? 100) || 100;

  const hits: string[] = [];
  for (const file of walk(root)) {
    const name = file.slice(file.lastIndexOf("/") + 1);
    if (globRe && !globRe.test(name)) continue;
    let text: string;
    try {
      text = readFileSync(file, "utf-8");
    } catch {
      continue; // 二进制或不可读文件跳过。这不是错误，是筛选条件。
    }
    if (text.includes("\u0000")) continue; // 有 NUL 就是二进制，别当文本搜
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (pattern.test(lines[i]!)) {
        hits.push(`${relative(ctx.root, file)}:${i + 1}: ${lines[i]!.trim().slice(0, 200)}`);
        if (hits.length >= maxHits) return `${hits.join("\n")}\n（截断在 ${maxHits} 条）`;
      }
    }
  }
  return hits.length ? hits.join("\n") : "(没有匹配)";
}

export const FS_TOOLS: Tool[] = [
  {
    name: "list_dir",
    description: "列出工作区里某个目录的内容。",
    parameters: { type: "object", properties: { path: { type: "string", description: "相对路径，默认 '.'" } } },
    run: listDir,
  },
  {
    name: "read_file",
    description: "读工作区里的文本文件，返回带行号的内容。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        offset: { type: "integer", description: "从第几行开始（0 起）" },
        limit: { type: "integer", description: "最多读几行" },
      },
      required: ["path"],
    },
    run: readFile,
  },
  {
    name: "write_file",
    description: "写文件，已存在则整体覆盖。局部修改请用 edit_file。",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
    },
    needsApproval: true,
    summarize: (a) => sanitizeForDisplay(`写入 ${a.path}（${String(a.content ?? "").length} 字符）`),
    run: writeFile,
  },
  {
    name: "edit_file",
    description: "把文件里的一段精确文本替换成另一段。old_string 必须唯一。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        old_string: { type: "string" },
        new_string: { type: "string" },
        replace_all: { type: "boolean" },
      },
      required: ["path", "old_string", "new_string"],
    },
    needsApproval: true,
    summarize: (a) => sanitizeForDisplay(`编辑 ${a.path}`),
    run: editFile,
  },
  {
    name: "grep_files",
    description: "在工作区里按正则搜内容，返回 文件:行号:内容。",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "JS 正则" },
        path: { type: "string", description: "搜索起点，默认 '.'" },
        glob: { type: "string", description: "文件名过滤，如 '*.ts'" },
        max_results: { type: "integer" },
      },
      required: ["pattern"],
    },
    run: grepFiles,
  },
];
