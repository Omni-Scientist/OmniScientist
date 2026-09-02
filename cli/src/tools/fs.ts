/**
 * 文件系统工具：list_dir / read_file / write_file / edit_file / grep_files。
 * 命名沿用 snake_case，跟 Claude Code 的 PascalCase 区分开。
 */

import { readdirSync, readFileSync, statSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join, relative } from "node:path";

import { sanitizeForDisplay } from "./shell.ts";
import type { Tool, ToolContext } from "./index.ts";
import { toolResultBudget } from "../context.ts";

const MAX_FILE_BYTES = 2_000_000; // 超过这个体量整读没意义，让它分段或 grep
// 单次进上下文的上限，超了存 artifact。这是**大窗口下的上限**，实际还要被
// toolResultBudget() 按当前模型的窗口收窄：60000 字符在 384k 窗口上占 4%，
// 在 40960 的自建部署上占 37%，后者连读两次就把窗口顶爆（2026-08-26 实测）。
const MAX_INLINE_CHARS = 60_000;
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
  return ctx.artifacts.truncate(`read_file: ${rel}`, body, toolResultBudget(MAX_INLINE_CHARS));
}

/**
 * 写 .json 文件之前先自己解析一遍，坏了就别落盘。
 *
 * 不然坏内容会一路传到下游工具那里才炸，而下游报的是它自己的 Traceback ——
 * 模型看到的是「某个 python 脚本挂了」，根本不知道是自己上一步写的文件有问题，
 * 更不知道错在第几行。
 *
 * 2026-08-26 实测：30B 手写了一份 25017 字节的 picks.json，第 18 行有个字符串没
 * 闭合，它对着 lit_cli.py 的 Traceback 改了四十分钟没改对。而 JSON.parse 的报错
 * 直接就带行列位置。
 *
 * 只认 .json 后缀，别的一律不碰：.jsonl 每行一个对象、模板文件带占位符，
 * 拿严格 JSON 去卡它们就是误伤。
 */
function isJsonPath(rel: string): boolean {
  return /\.json$/i.test(rel.trim());
}

function isValidJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

function checkJsonBeforeWrite(rel: string, content: string, when = "这份内容"): void {
  if (!isJsonPath(rel)) return;
  if (!content.trim()) return; // 空文件让它写，那是清空的意思
  try {
    JSON.parse(content);
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    // 大块内容手写 JSON 基本写不对：几千字的正文里但凡有一个引号、反斜杠或换行
    // 没转义，整份就废了，而且错在第几行全靠猜。2026-08-26 实测：30B 在 picks.json
    // 和 sections.json 上连着栽了七八次，每次都是「某个字符串没闭合」。
    // 让它改用脚本组装 —— json.dump 负责转义，这类错误就不存在了。
    const bulky = content.length > 3_000
      ? `\n这份内容有 ${content.length} 个字符，靠手写转义几乎不可能一次写对。`
        + `改用脚本来生成：写一个小的 python，把每一段正文放进普通字符串变量，`
        + `再用 json.dump 落盘。转义交给 json 库，你只管内容。`
      : "";
    throw new Error(
      `没写：${rel} ${when}不是合法 JSON，落盘只会让下游工具报一个看不懂的错。\n`
      + `解析器说：${why}\n`
      + `按这个位置改好再写。常见原因是字符串没闭合、少了逗号、多了尾逗号。`
      + `${bulky}\n`
      + `内容如果本来就该由某条命令产出，直接把那条命令的输出重定向进去，别手抄。`,
    );
  }
}

function writeFile(args: Record<string, unknown>, ctx: ToolContext): string {
  const rel = String(args.path);
  const path = ctx.resolve(rel);
  const content = String(args.content ?? "");
  checkJsonBeforeWrite(rel, content);
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
  const next = text.split(oldStr).join(newStr);

  // write_file 早就有这道闸，edit_file 一直是敞的，而删字段这种操作恰恰只会用 edit_file。
  // 2026-09-01 实测：模型删掉 sections.json 的最后一个字段 Conclusions，留下前一条的
  // 尾逗号，工具报成功，直到两步之后 paper_cli.py 抛一条截断的 Traceback 才暴露，
  // 模型还得自己去数第 14818 个字符在哪。
  //
  // 只在「改之前是合法 JSON」时才卡：文件本来就坏，正是要靠 edit_file 修回来的，
  // 那时候拦住等于把唯一的修复手段也堵死。
  if (isJsonPath(rel) && text.trim() && isValidJson(text)) {
    checkJsonBeforeWrite(rel, next, "改完之后");
  }

  writeFileSync(path, next, "utf-8");
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
