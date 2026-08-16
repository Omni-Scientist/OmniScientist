/**
 * 标准库：这个 harness 的差异化所在。
 *
 * 一条「标准」就是你已经定过的一个规矩，带生效条件，被上下文命中时
 * **直接注入，不询问**。设计上刻意不做「跳出来问你要不要用」：
 * 主动一旦变成打扰，两天就会被关掉。主动体现在「自动用对规矩」，
 * 不是「频繁开口」。默认连生效清单都不打印。
 *
 * 默认目录是 ~/.omnisci/standards/，不是仓库里。一条规矩都不随代码分发：
 * 个人定的规矩属于定它的人，不该跟着开源代码到别人机器上生效。
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import { OMNI_HOME } from "./soul.ts";

export const DEFAULT_STANDARDS_DIR = join(OMNI_HOME, "standards");

/**
 * file_globs 的门槛。一个垃圾目录里躺着一个 .tex 不代表你在写论文，
 * 必须是这类文件成气候才算信号。数值是拍的，但方向是对的：
 * 宁可漏一次，也不要在 ~/Downloads 里激活「论文写作套路」。
 */
const FILE_GLOB_MIN_COUNT = 3;
const FILE_GLOB_MIN_RATIO = 0.15;

export interface Standard {
  name: string;
  description: string;
  body: string;
  path: string;
  cwdGlobs: string[];
  fileGlobs: string[];
  dirContains: string[];
  keywords: string[];
  always: boolean;
  priority: number;
}

export interface ContextSignals {
  cwd: string;
  filenames: string[];
  userText: string;
  gitBranch: string | null;
}

export interface ActiveStandard {
  standard: Standard;
  reason: string;
}

function globToRe(glob: string): RegExp {
  const body = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*").replaceAll("?", ".");
  return new RegExp(`^${body}$`);
}

const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/;

/**
 * 读一个目录下的所有 .md 标准。
 * 格式错误直接抛，不跳过：一条静默失效的标准比没有标准更糟，
 * 你以为它在管着，其实没有。
 */
export function loadStandards(dir: string): Standard[] {
  if (!existsSync(dir)) return [];
  const out: Standard[] = [];
  for (const name of readdirSync(dir).filter((n) => n.endsWith(".md")).sort()) {
    const path = join(dir, name);
    const raw = readFileSync(path, "utf-8");
    const m = FRONTMATTER_RE.exec(raw);
    if (!m) throw new Error(`标准文件缺少 YAML frontmatter: ${path}`);
    const meta = (parseYaml(m[1]!) ?? {}) as Record<string, unknown>;
    const body = (m[2] ?? "").trim();
    if (!body) throw new Error(`标准文件正文是空的: ${path}`);
    const when = (meta.when ?? {}) as Record<string, unknown>;
    out.push({
      name: String(meta.name ?? name.replace(/\.md$/, "")),
      description: String(meta.description ?? ""),
      body,
      path,
      cwdGlobs: (when.cwd_globs ?? []) as string[],
      fileGlobs: (when.file_globs ?? []) as string[],
      dirContains: (when.dir_contains ?? []) as string[],
      keywords: (when.keywords ?? []) as string[],
      always: Boolean(meta.always ?? false),
      priority: Number(meta.priority ?? 0),
    });
  }
  return out;
}

/**
 * 四种信号，强弱不同：
 *   always        常驻
 *   keywords      用户自己说的，最可信
 *   cwdGlobs      目录路径，很可信
 *   dirContains   目录里有某个确切的东西（.git / pyproject.toml），精确
 *   fileGlobs     某类文件成气候，最弱，要过数量和占比双门槛
 */
export function matchStandard(s: Standard, ctx: ContextSignals): string | null {
  if (s.always) return "常驻";

  const low = ctx.userText.toLowerCase();
  for (const kw of s.keywords) {
    if (low.includes(kw.toLowerCase())) return `你提到了「${kw}」`;
  }
  for (const g of s.cwdGlobs) {
    if (globToRe(g).test(ctx.cwd)) return `目录匹配 ${g}`;
  }
  const names = new Set(ctx.filenames);
  for (const entry of s.dirContains) {
    if (names.has(entry)) return `目录里有 ${entry}`;
  }
  const total = ctx.filenames.length;
  if (total) {
    for (const g of s.fileGlobs) {
      const re = globToRe(g);
      const n = ctx.filenames.filter((f) => re.test(f)).length;
      if (n >= FILE_GLOB_MIN_COUNT && n / total >= FILE_GLOB_MIN_RATIO) {
        return `目录里 ${n}/${total} 个 ${g}`;
      }
    }
  }
  return null;
}

export class StandardsEngine {
  standards: Standard[];

  constructor(readonly dir: string = DEFAULT_STANDARDS_DIR) {
    this.standards = loadStandards(dir);
  }

  reload(): void {
    this.standards = loadStandards(this.dir);
  }

  active(ctx: ContextSignals): ActiveStandard[] {
    const hits: ActiveStandard[] = [];
    for (const s of this.standards) {
      const reason = matchStandard(s, ctx);
      if (reason) hits.push({ standard: s, reason });
    }
    return hits.sort((a, b) => b.standard.priority - a.standard.priority);
  }

  /** 注入系统提示或当轮消息的那段文字。 */
  asPromptBlock(active: ActiveStandard[]): string {
    if (!active.length) return "";
    const parts = [
      "以下是这位用户已经定过的规矩，当前处境命中了它们。",
      "直接照做，不要再问他要不要按这些来，也不要复述这些规矩。",
      "",
    ];
    for (const a of active) {
      parts.push(`## ${a.standard.name}`);
      if (a.standard.description) parts.push(`（${a.standard.description}）`);
      parts.push(a.standard.body, "");
    }
    return parts.join("\n");
  }

  /**
   * 把一条新规矩收进待合并区，等后台合并。
   * 不直接写进正式标准库：新规矩可能跟老的冲突或重复，合并要单独一步做，
   * 不能在对话中间偷偷改掉一条已经在生效的规矩。
   */
  capture(text: string, name: string, description = ""): string {
    const inbox = join(this.dir, "_inbox");
    mkdirSync(inbox, { recursive: true });
    const slug = name.toLowerCase().replace(/[^a-z0-9一-龥]+/g, "-").replace(/^-|-$/g, "") || "unnamed";
    let path = join(inbox, `${slug}.md`);
    let n = 2;
    while (existsSync(path)) path = join(inbox, `${slug}-${n++}.md`);
    const front = stringifyYaml({ name, description, when: { keywords: [] } });
    writeFileSync(path, `---\n${front}---\n\n${text.trim()}\n`, "utf-8");
    return path;
  }
}
