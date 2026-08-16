/**
 * 硬拦截。执行层的规矩，不是提示词里的规矩。
 *
 * 为什么放在这儿而不是写进 system prompt：跑的是弱模型。Cline 的 Plan 模式边界
 * 靠提示词撑了整个产品生命周期，源码注释原话「models (especially weaker ones)
 * use it to edit files anyway」，2026-08 才改成代码强制。能落到执行层的规矩绝不写在提示词里。
 *
 * 三件事：
 *   1. 危险模式表。命中就硬拒，**并且在拒绝理由里给出改写好的安全命令**。
 *      光拒绝会让模型卡死或者去找绕路方案（只拒不给替代，模型会去找绕路方案），
 *      给了替代方案它下一步就能自己改对。
 *   2. 命令拆分。`bash -c "a && b"` 按 `&& || ; |` 拆成一条条逐条判，
 *      所以放行 `git add` 不会顺带放行 `git add . && rm -rf /`。
 *   3. 受保护路径。`.git`、`~/.ssh` 这类在任何模式下都不自动放行。
 *
 * 边界说清楚：这是黑名单，黑名单永远漏。它挡的是弱模型的手滑和惯性，
 * 不是挡一个存心绕过它的攻击者（`e=rm; $e -rf x` 这种就绕过去了）。
 * 真要挡后者得上 OS 沙箱，那条路 GUARD.md 里已经明确不走。
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { basename, isAbsolute, resolve as resolvePath, sep } from "node:path";

export type Verdict = "allow" | "ask" | "deny";

export interface GuardDecision {
  verdict: Verdict;
  /** 拒绝或追问的理由。deny 时这段会原样回喂给模型，所以必须带改写建议。 */
  reason?: string;
  /** 命中哪条规则，给人看的 */
  rule?: string;
}

const ALLOW: GuardDecision = { verdict: "allow" };

/** 数据驱动的规则，用户可以自己往 ~/.omnisci/guard-rules.json 里加。 */
export interface Rule {
  id: string;
  /** 命令位置的正则源码。只在命令位置匹配，`npm rm` 不会被当成 `rm`。 */
  command?: string;
  /** 整条命令的子串正则，不分大小写。用来拦包名、域名这类。 */
  contains?: string;
  verdict: "deny" | "ask";
  reason: string;
}

export interface GuardConfig {
  rules: Rule[];
  /** 任何模式下都不自动放行的路径。写入直接拒，读取每次都问。 */
  protectedPaths: string[];
  /** 工作区之外仍然允许写的地方。默认只有临时目录。 */
  writableOutside: string[];
}

// ---------------------------------------------------------------------------
// 改写建议要跟本机对得上
// ---------------------------------------------------------------------------

/**
 * `/usr/bin/trash` 只有 macOS 有，Linux 上是 trash-put 或 gio trash。
 * 建议一个不存在的命令等于没给建议，模型试一次失败又会绕回 rm，所以按当前机器实际探。
 */
/** 本机可用的那个「扔垃圾桶」命令本身，不带说明文字。拼进别的命令时用它。 */
function trashCommand(): string {
  if (platform() === "darwin" && existsSync("/usr/bin/trash")) return "/usr/bin/trash";
  if (existsSync("/usr/bin/trash-put")) return "trash-put";
  if (existsSync("/usr/bin/gio")) return "gio trash";
  return "";
}

function trashHint(): string {
  const cmd = trashCommand();
  if (!cmd) return "`mkdir -p .trash && mv <路径> .trash/`（自己搭个垃圾桶，别直接删）";
  return `\`${cmd} <路径>\`（进垃圾桶，可恢复）`;
}

export function builtinRules(): Rule[] {
  return [
    {
      id: "rm",
      // rmdir 和 unlink 是同一件事换个名字，不列进来等于留了两扇后门
      command: "rm|rmdir|unlink",
      verdict: "deny",
      reason:
        `删除命令不可恢复，默认禁用。改用 ${trashHint()}。` +
        "如果确实要永久删除（比如清 node_modules 这种可重建的），说清楚是哪个目录、为什么，然后由人自己敲。",
    },
    {
      id: "find-delete",
      // find 自己就能删，不经过 rm。`-exec rm` 里的 rm 不在命令位置上，
      // 命令位置匹配抓不到，只能整条扫。这是最容易漏的一条。
      contains: "(?:^|\\s)-delete(?:\\s|$)|-exec\\s+(?:sudo\\s+)?(?:\\S*/)?rm(?:\\s|$)|-execdir\\s+(?:\\S*/)?rm(?:\\s|$)",
      verdict: "deny",
      reason:
        `find 自己就能删文件，跟 rm 一样不可恢复，一样禁用。` +
        `要批量清理：先 \`find ... -print\` 把清单打出来看一眼，确认无误再` +
        (trashCommand()
          ? ` \`find ... -exec ${trashCommand()} {} +\`。`
          : ` 把它们 mv 进一个 .trash/ 目录。`),
    },
    {
      id: "rsync-delete",
      // rsync --delete 会照着源端删目标端，跟 rm 一样是不可恢复的删除，
      // 但它同时是往 NAS 做镜像的标准手法，硬拒会把正常备份也挡掉，所以只问不拒。
      contains: "rsync[^|;&]*\\s--delete",
      verdict: "ask",
      reason:
        "rsync --delete 会把目标端多出来的文件删掉，不可恢复。" +
        "先 --dry-run 看一遍要删什么，确认了再点头。",
    },
    {
      id: "shred",
      command: "shred|mkfs\\.\\w+|mkfs",
      verdict: "deny",
      reason: "这是不可恢复的擦除/格式化，默认禁用。要清空数据请说明目标和理由，然后由人自己敲。",
    },
    {
      id: "truncate",
      command: "truncate",
      verdict: "deny",
      reason:
        "truncate 会把文件清零且不可恢复。常见用途是备份完清空源端，那就先把校验结果拿出来：" +
        "文件数、总大小、**mtime** 三项都对得上，并且确认目标不是仍在被写入的路径" +
        "（训练 checkpoint、服务输出、daemon 日志）。核对完由人自己敲。",
    },
    {
      id: "qdel",
      command: "qdel|qsig|qhold|scancel",
      verdict: "deny",
      reason:
        "qdel 不可恢复，在共享集群上可能摧毁别人跑了几天的训练，而 harness 无法替你确认这个 job " +
        "是不是当前工作目录提交的。先 `qstat -f <jobid>` 看 submit dir 和 jobname，确认之后把 jobid " +
        "和证据报上来，由人自己敲 qdel。",
    },
    {
      id: "git-push",
      command: "git\\s+(?:-\\S+\\s+)*push",
      verdict: "ask",
      // 「需明确批准」不等于「问一次以后都行」。ask 每次都问，不吃会话放行，也不吃 --auto-approve。
      reason: "push 会把东西推到别人看得见的地方，每次都要单独点头。",
    },
    {
      id: "git-destructive",
      // 末尾那个 (?=\s|$) 要求整条模式吃到词尾，所以 -fd 后面还有字母的写法
      // （`git clean -fdx`）必须让模式自己吃掉，不然匹配不上。之前就漏在这儿。
      command: "git\\s+(?:-\\S+\\s+)*(?:reset\\s+--hard|clean\\s+-[a-zA-Z]*[fd][a-zA-Z]*|checkout\\s+--\\s|restore\\s)",
      verdict: "ask",
      reason: "这会丢掉未提交的改动，丢了找不回来。确认过工作区没有要留的东西再点头。",
    },
  ];
}

const DEFAULT_PROTECTED = [
  ".git",
  ".omnisci",
  "~/.ssh",
  "~/.omnisci",
  // 凭据惯例位置。agent 会 shell out，这些地方一律不许碰。
  "~/.netrc",
  "~/.gnupg",
  "~/.aws",
  "~/.config/gh",
  // GUARD.md 没列 ~/.claude，但拦截钩子自己就住在这儿。
  // 模型能改 ~/.claude/hooks/*.sh 和 settings.json，等于能把防护自己拆掉。
  "~/.claude",
];

/** 工作区之外默认只有临时目录可写。/tmp 是 scratch，拦它只会逼模型把临时文件写进仓库。 */
const DEFAULT_WRITABLE_OUTSIDE = ["/tmp", "/var/tmp", "/dev/null", "/dev/stdout", "/dev/stderr"];

export function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return resolvePath(homedir(), p.slice(2));
  return p;
}

export const DEFAULT_RULES_FILE = resolvePath(homedir(), ".omnisci/guard-rules.json");

/**
 * 读用户自己加的规则。这类规则通常是被坑一次加一条，所以这个文件必须存在感低、改起来快。
 * 文件坏了直接抛：吞掉错误会让人以为规则生效了，其实在裸奔。
 */
export function loadGuardConfig(file = DEFAULT_RULES_FILE): GuardConfig {
  const base: GuardConfig = {
    rules: builtinRules(),
    protectedPaths: [...DEFAULT_PROTECTED],
    writableOutside: [...DEFAULT_WRITABLE_OUTSIDE],
  };
  if (!existsSync(file)) return base;

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf-8"));
  } catch (e) {
    throw new Error(`guard 规则文件 ${file} 不是合法 JSON：${e instanceof Error ? e.message : e}`);
  }
  const cfg = parsed as Partial<GuardConfig> & { disableRules?: string[] };

  if (cfg.rules) {
    for (const r of cfg.rules) {
      if (!r.id || !r.reason || (!r.command && !r.contains)) {
        throw new Error(`guard 规则文件 ${file} 里有条目缺 id / reason / command|contains：${JSON.stringify(r)}`);
      }
      if (r.verdict !== "deny" && r.verdict !== "ask") {
        throw new Error(`guard 规则 ${r.id} 的 verdict 只能是 deny 或 ask，给的是 ${r.verdict}`);
      }
      // 正则写错要当场炸，不能等到某条危险命令来了才发现这条规则根本没编译
      if (r.command) new RegExp(r.command);
      if (r.contains) new RegExp(r.contains);
    }
    base.rules.push(...cfg.rules);
  }
  // 关掉内置规则要显式列 id，免得他哪天想放开 rm 还得改源码
  if (cfg.disableRules?.length) {
    const off = new Set(cfg.disableRules);
    base.rules = base.rules.filter((r) => !off.has(r.id));
  }
  if (cfg.protectedPaths) base.protectedPaths.push(...cfg.protectedPaths);
  if (cfg.writableOutside) base.writableOutside.push(...cfg.writableOutside);
  return base;
}

// ---------------------------------------------------------------------------
// 命令拆分
// ---------------------------------------------------------------------------

/**
 * 带这些东西的命令不拆：重定向、变量、命令替换、通配、控制流。
 * 不做完整 shell 解析，拆不干净的整条当一条判，宁可多问。
 */
const UNSPLITTABLE = /[$`*?<>]|\[|(?:^|\s)(?:if|then|else|fi|for|while|until|do|done|case|esac|function)(?:\s|$)/;

/**
 * 按 `&&` `||` `;` `|` `&` 换行拆成一条条命令。引号内的操作符不算。
 * 拆不动就返回整条，由调用方当一条不可分割的命令来判。
 */
export function splitCommands(cmd: string): string[] {
  const trimmed = cmd.trim();
  if (!trimmed) return [];
  if (UNSPLITTABLE.test(trimmed)) return [trimmed];

  const parts: string[] = [];
  let buf = "";
  let quote: string | null = null;

  for (let i = 0; i < trimmed.length; i++) {
    const c = trimmed[i]!;
    if (quote) {
      buf += c;
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; buf += c; continue; }
    if (c === "\\") { buf += c + (trimmed[i + 1] ?? ""); i++; continue; }
    const two = trimmed.slice(i, i + 2);
    if (two === "&&" || two === "||") { parts.push(buf); buf = ""; i++; continue; }
    if (c === ";" || c === "|" || c === "&" || c === "\n") { parts.push(buf); buf = ""; continue; }
    buf += c;
  }
  parts.push(buf);

  const out = parts.map((p) => p.trim()).filter(Boolean);
  return out.length ? out : [trimmed];
}

/** 按引号切词。不展开变量也不展开通配，只是把一条命令拆成 token。 */
export function tokenize(unit: string): string[] {
  const tokens: string[] = [];
  let buf = "";
  let quote: string | null = null;
  let started = false;

  for (let i = 0; i < unit.length; i++) {
    const c = unit[i]!;
    if (quote) {
      if (c === quote) { quote = null; continue; }
      buf += c;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; started = true; continue; }
    if (c === "\\") { buf += unit[i + 1] ?? ""; i++; started = true; continue; }
    if (/\s/.test(c)) {
      if (buf || started) { tokens.push(buf); buf = ""; started = false; }
      continue;
    }
    buf += c;
    started = true;
  }
  if (buf || started) tokens.push(buf);
  return tokens;
}

/** 命令前面这些前缀不改变「真正跑的是什么」，判的时候要跳过去。 */
const PREFIX = /^(?:sudo|command|nohup|time|exec|env|xargs|nice|ionice|stdbuf|setsid)$/;

/** 一条命令真正执行的那个程序名，剥掉 sudo / env FOO=1 / 绝对路径。 */
export function commandName(unit: string): string {
  const tokens = tokenize(unit);
  for (const raw of tokens) {
    if (!raw) continue;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(raw)) continue; // FOO=1 cmd
    if (raw.startsWith("-")) continue;
    const name = basename(raw);
    if (PREFIX.test(name)) continue;
    return name;
  }
  return "";
}

/** 命令位置的匹配前缀：行首、或者任何一个 shell 操作符之后，允许 sudo / 绝对路径。 */
function commandPosRegex(pattern: string): RegExp {
  const prefix = String.raw`(?:^|&&|\|\||;|\||&|\x60|\$\()\s*`;
  const wrappers = String.raw`(?:(?:sudo|command|nohup|time|exec|xargs|nice|setsid)\s+|[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*`;
  // 前面允许绝对路径（/bin/rm），也允许一个反斜杠（`\rm` 是绕开 alias 的常用写法，
  // 不认它就等于给 rm 留了个后门）
  const path = String.raw`\\?(?:\S*/)?`;
  return new RegExp(`${prefix}${wrappers}${path}(?:${pattern})(?=\\s|$|;|&|\\|)`, "i");
}

// ---------------------------------------------------------------------------
// 写入目标提取
// ---------------------------------------------------------------------------

export interface WriteTarget {
  path: string;
  /** 怎么写的，给人和模型看：重定向 / mv 目标 / tee ... */
  how: string;
  /** 只是清空（`> file` 和 truncate），比普通写入更该拦 */
  clears: boolean;
}

/**
 * 从一条命令里抠出「会被写坏的路径」。
 * 抠不全是必然的（黑名单的老问题），抠到的那些就按规矩判。
 */
export function writeTargets(unit: string): WriteTarget[] {
  const out: WriteTarget[] = [];
  const tokens = tokenize(unit);

  // 重定向。`>` 覆盖（可能清空），`>>` 追加。写在一起的 `>file` 也要认。
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    // 前面可能带 fd 号（`2>` `2>>`）或者 `&>`，`2>&1` 那种不是写文件，靠后面的解析挡掉
    const m = /^(\d*&?>{1,2}\|?)(.*)$/.exec(t);
    if (!m) continue;
    const op = m[1]!;
    const target = m[2] || tokens[i + 1] || "";
    // `2>&1` 是把 fd 接到另一个 fd 上，不是写文件
    if (!target || target.startsWith(">") || target.startsWith("&")) continue;
    if (!m[2]) i++;
    out.push({ path: target, how: op.includes(">>") ? "追加重定向" : "覆盖重定向", clears: !op.includes(">>") });
  }

  const name = commandName(unit);
  const args = tokens.filter((t) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(t) && !/^&?>{1,2}/.test(t));
  // 去掉程序名本身和它前面的 sudo 之类
  const idx = args.findIndex((t) => !t.startsWith("-") && basename(t) === name);
  const rest = idx >= 0 ? args.slice(idx + 1) : args;
  const plain = rest.filter((t) => !t.startsWith("-"));

  switch (name) {
    case "mv":
    case "cp":
    case "install":
    case "rsync":
    case "ln":
      if (plain.length >= 2) out.push({ path: plain[plain.length - 1]!, how: `${name} 的目标`, clears: false });
      break;
    case "tee":
      for (const p of plain) out.push({ path: p, how: "tee 写入", clears: !rest.some((t) => /^-a|--append/.test(t)) });
      break;
    case "dd":
      for (const t of rest) if (t.startsWith("of=")) out.push({ path: t.slice(3), how: "dd 输出", clears: true });
      break;
    case "sed":
      if (rest.some((t) => /^-\w*i/.test(t))) {
        for (const p of plain.slice(1)) out.push({ path: p, how: "sed -i 原地改写", clears: false });
      }
      break;
    case "truncate":
      for (const p of plain) out.push({ path: p, how: "truncate 清零", clears: true });
      break;
    case "chmod":
    case "chown":
    case "chgrp":
      // 第一个位置参数是模式或属主（777 / user:group），后面才是路径
      for (const p of plain.slice(1)) out.push({ path: p, how: `${name} 改权限`, clears: false });
      break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 路径判定
// ---------------------------------------------------------------------------

function underOrEqual(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

/**
 * 这个路径是不是受保护的。
 * 相对形式（`.git`）按工作区内任意一层匹配，绝对形式（`~/.ssh`）按前缀匹配。
 */
export function protectedHit(abs: string, root: string, protectedPaths: string[]): string | null {
  for (const raw of protectedPaths) {
    const p = expandHome(raw);
    if (isAbsolute(p)) {
      if (underOrEqual(abs, resolvePath(p))) return raw;
      continue;
    }
    // 相对项：路径里任意一段等于它就算命中，比如 <root>/sub/.git/config
    const relParts = abs.startsWith(root + sep) ? abs.slice(root.length + 1).split(sep) : [];
    if (relParts.includes(p)) return raw;
  }
  return null;
}

/** 家目录本身或者它的祖先。`chmod -R` 打到这一层是灾难。 */
function atOrAboveHome(abs: string): boolean {
  const home = homedir();
  return abs === home || underOrEqual(home, abs);
}

function resolveAgainst(root: string, p: string): string {
  return isAbsolute(p) ? resolvePath(p) : resolvePath(root, p);
}

// ---------------------------------------------------------------------------
// 判决
// ---------------------------------------------------------------------------

export interface GuardContext {
  root: string;
  config: GuardConfig;
}

/** 只跑规则表，不做路径分析。远端命令（ssh 里那截）只能用这个。 */
export function checkRules(unit: string, config: GuardConfig): GuardDecision {
  // deny 优先于 ask，所以先把 deny 扫完再扫 ask
  for (const pass of ["deny", "ask"] as const) {
    for (const r of config.rules) {
      if (r.verdict !== pass) continue;
      const hit =
        (r.command && commandPosRegex(r.command).test(unit)) ||
        (r.contains && new RegExp(r.contains, "i").test(unit));
      if (hit) return { verdict: r.verdict, reason: r.reason, rule: r.id };
    }
  }
  return ALLOW;
}

/**
 * 把命令再包一层的那些程序。`bash -c "rm -rf /"` 里的 rm 藏在引号里，
 * 命令位置匹配抓不到，必须把内层字符串抠出来单独判一遍。
 * 弱模型写出 `bash -c` 和 `ssh 机器 "..."` 是家常便饭，不补这个洞等于白做。
 */
const LOCAL_WRAPPER = new Set(["bash", "sh", "zsh", "dash", "ksh", "eval"]);
const REMOTE_WRAPPER = new Set(["ssh", "srun"]);

/** 抠出被包在里面的那条命令。抠不出来返回空串。 */
export function innerCommand(unit: string): { inner: string; remote: boolean } | null {
  const tokens = tokenize(unit);
  const name = commandName(unit);
  const start = tokens.findIndex((t) => basename(t) === name);
  const rest = tokens.slice(start + 1);

  if (LOCAL_WRAPPER.has(name)) {
    const ci = rest.findIndex((t) => t === "-c" || t === "-lc" || t === "-cl");
    if (ci >= 0 && rest[ci + 1]) return { inner: rest[ci + 1]!, remote: false };
    if (name === "eval" && rest.length) return { inner: rest.join(" "), remote: false };
    return null;
  }
  if (REMOTE_WRAPPER.has(name)) {
    // ssh [选项] host cmd...：跳过选项和它们的取值，第一个裸 token 是 host，剩下的是命令
    const withValue = new Set(["-i", "-p", "-o", "-l", "-F", "-J", "-b", "-c", "-D", "-L", "-R", "-W"]);
    let i = 0;
    while (i < rest.length && rest[i]!.startsWith("-")) {
      if (withValue.has(rest[i]!)) i++;
      i++;
    }
    i++; // host
    const inner = rest.slice(i).join(" ").trim();
    return inner ? { inner, remote: true } : null;
  }
  return null;
}

/** 判一条不可再拆的命令。 */
export function checkUnit(unit: string, ctx: GuardContext): GuardDecision {
  const { root, config } = ctx;

  // 0. 外层是 bash -c / ssh 这类包装，先判内层。
  //    本地包装（bash -c）内层跟直接跑没区别，规则和路径全查；
  //    远端包装（ssh）只查规则表：远端路径是另一台机器的文件系统，
  //    拿本地工作区去判「越界」会把正常的远端操作全拦掉。
  const wrapped = innerCommand(unit);
  if (wrapped) {
    for (const sub of splitCommands(wrapped.inner)) {
      const d = wrapped.remote ? checkRules(sub, config) : checkUnit(sub, ctx);
      if (d.verdict !== "allow") {
        return { ...d, reason: `（包在 ${commandName(unit)} 里的 \`${sub}\`）${d.reason}` };
      }
    }
  }

  // 1. 规则表
  const byRule = checkRules(unit, config);
  if (byRule.verdict !== "allow") return byRule;

  // 2. 写入目标：受保护路径、工作区之外、清空已存在的文件
  const name = commandName(unit);
  const recursive = /(?:^|\s)-\w*[Rr](?:\s|$)|--recursive/.test(unit);

  for (const t of writeTargets(unit)) {
    if (!t.path || t.path.startsWith("$")) continue;
    const abs = resolveAgainst(root, expandHome(t.path));

    const prot = protectedHit(abs, root, config.protectedPaths);
    if (prot) {
      return {
        verdict: "deny",
        rule: "protected-path",
        reason:
          `${t.how} 打到受保护路径 ${abs}（命中 ${prot}）。这类路径任何模式下都不放行。` +
          `要动它请说清楚为什么，然后由人自己敲。`,
      };
    }

    if ((name === "chmod" || name === "chown" || name === "chgrp") && recursive && atOrAboveHome(abs)) {
      return {
        verdict: "deny",
        rule: "chmod-recursive-home",
        reason:
          `${name} -R 打到 ${abs}，这是家目录或它的上层，递归改权限会把整台机器的文件搅乱且很难还原。` +
          `把目标缩小到具体那个目录，不要用家目录当起点。`,
      };
    }

    const outside = !underOrEqual(abs, root);
    const allowedOutside = config.writableOutside.some((w) => underOrEqual(abs, resolvePath(expandHome(w))));
    if (outside && !allowedOutside) {
      return {
        verdict: "deny",
        rule: "write-outside-workspace",
        reason:
          `${t.how} 越出工作区：${abs}（工作区是 ${root}）。` +
          `工作区外的写入、移动、覆盖一律不放行。临时文件写 /tmp，要落到别处请说明理由，然后由人自己敲。`,
      };
    }

    // `> 已存在的文件` 是覆盖，不是新建。GUARD.md 的原话是「先比对 mtime 再说」。
    // 新建文件用 `>` 完全正常，所以只拦已存在的那种，不然模型连日志都没法写。
    if (t.clears && existsSync(abs) && !allowedOutside) {
      return {
        verdict: "ask",
        rule: "overwrite-existing",
        reason:
          `${t.how} 会覆盖已经存在的 ${abs}，原内容不可恢复。` +
          `只是想追加就用 >>，想留底就先 cp 一份，确认要覆盖再点头。`,
      };
    }
  }

  // 3. 只是提到受保护路径（读、grep、cat），不自动放行，每次都问
  for (const tok of tokenize(unit)) {
    if (!tok || tok.startsWith("-") || tok.startsWith("$")) continue;
    if (!tok.includes("/") && !tok.startsWith("~") && !tok.startsWith(".")) continue;
    const abs = resolveAgainst(root, expandHome(tok));
    const prot = protectedHit(abs, root, config.protectedPaths);
    if (prot) {
      return {
        verdict: "ask",
        rule: "protected-path-read",
        reason: `这条命令碰到受保护路径 ${abs}（命中 ${prot}），任何模式下都不自动放行。`,
      };
    }
  }

  return ALLOW;
}

/** 判一整条 bash 命令：拆开逐条判，取最严的那条。 */
export function checkCommand(command: string, ctx: GuardContext): GuardDecision {
  let worst: GuardDecision = ALLOW;
  for (const unit of splitCommands(command)) {
    const d = checkUnit(unit, ctx);
    if (d.verdict === "deny") return { ...d, reason: `拒绝执行 \`${unit}\`：${d.reason}` };
    if (d.verdict === "ask" && worst.verdict === "allow") worst = { ...d, reason: `\`${unit}\`：${d.reason}` };
  }
  return worst;
}

/**
 * 「本次会话一直允许」的粒度：一条命令归一成一个命令类。
 * `git add x` 和 `git add y` 同类，`git add` 和 `rm` 不同类。
 * 拆不动的复杂命令用整条原文当 key，等于只放行一模一样的那条，宁可多问。
 */
const MULTI_VERB = new Set([
  "git", "npm", "pnpm", "yarn", "bun", "cargo", "docker", "kubectl", "uv", "pip", "pip3",
  "conda", "apt", "apt-get", "brew", "systemctl", "gh", "tmux", "go", "poetry", "gcloud", "aws",
]);

export function commandClass(unit: string): string {
  if (UNSPLITTABLE.test(unit)) return unit.trim();
  const name = commandName(unit);
  if (!name) return unit.trim();

  // 包装类的类别要看内层。放行一次 `bash -c "ls"` 不能等于放行所有 `bash -c`，
  // 那等于把刚补上的洞从审批门这边又开回来。
  const wrapped = innerCommand(unit);
  if (wrapped) {
    const inner = splitCommands(wrapped.inner).map(commandClass).join(" && ");
    // ssh 的类别带上机器名：ssh host-a nvidia-smi 和 ssh host-b qstat 不该算同一类
    if (wrapped.remote) {
      const tokens = tokenize(unit);
      const host = tokens.find((t, i) => i > 0 && !t.startsWith("-") && !t.includes("=")) ?? "";
      return `${name} ${host} ${inner}`;
    }
    return `${name} -c ${inner}`;
  }

  if (!MULTI_VERB.has(name)) return name;

  const tokens = tokenize(unit);
  const start = tokens.findIndex((t) => basename(t) === name);
  for (const t of tokens.slice(start + 1)) {
    if (t.startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) continue;
    return `${name} ${t}`;
  }
  return name;
}

export function commandClasses(command: string): string[] {
  return [...new Set(splitCommands(command).map(commandClass))];
}

/**
 * 文件工具的路径判定。ctx.resolve 已经把越界挡在工作区外了，
 * 这里补的是工作区**内部**的受保护路径（`.git`、`.omnisci`）。
 */
export function checkPath(abs: string, ctx: GuardContext, write: boolean): GuardDecision {
  const prot = protectedHit(abs, ctx.root, ctx.config.protectedPaths);
  if (!prot) return ALLOW;
  if (write) {
    return {
      verdict: "deny",
      rule: "protected-path",
      reason:
        `${abs} 在受保护路径里（命中 ${prot}），任何模式下都不写。` +
        `${prot === ".git" ? "要改仓库状态用 git 命令，不要直接动 .git 里的文件。" : "要动它请由人自己来。"}`,
    };
  }
  return {
    verdict: "ask",
    rule: "protected-path-read",
    reason: `${abs} 在受保护路径里（命中 ${prot}），读它也要单独点头。`,
  };
}

/** 一个工具调用整体的判决。bash 走命令分析，文件工具走路径分析。 */
export function checkTool(
  name: string,
  args: Record<string, unknown>,
  ctx: GuardContext,
): GuardDecision {
  if (name === "bash") return checkCommand(String(args.command ?? ""), ctx);

  const WRITERS = new Set(["write_file", "edit_file"]);
  const READERS = new Set(["read_file", "list_dir", "grep_files"]);
  if (!WRITERS.has(name) && !READERS.has(name)) return ALLOW;

  const rel = args.path === undefined ? "" : String(args.path);
  if (!rel) return ALLOW;
  const abs = resolveAgainst(ctx.root, expandHome(rel));
  return checkPath(abs, ctx, WRITERS.has(name));
}

/** 给 /guard 命令用：把当前生效的规则列出来。 */
export function describeConfig(cfg: GuardConfig): string {
  const lines = [`规则 ${cfg.rules.length} 条：`];
  for (const r of cfg.rules) {
    const what = r.command ? `命令 /${r.command}/` : `含 /${r.contains}/`;
    lines.push(`  ${r.verdict === "deny" ? "拒" : "问"}  ${r.id.padEnd(18)} ${what}`);
  }
  lines.push("", `受保护路径：${cfg.protectedPaths.join("  ")}`);
  lines.push(`工作区外可写：${cfg.writableOutside.join("  ")}`);
  lines.push("", `自己加规则：${DEFAULT_RULES_FILE}`);
  return lines.join("\n");
}
