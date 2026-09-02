import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { safeChildEnvironment } from "../credentials.ts";
import { pythonCommand, withPythonPath } from "../interpreters.ts";
import type { Tool, ToolContext } from "./index.ts";

/**
 * 给工具的原始报错补一句「那该怎么办」。
 *
 * 这些 CLI 报的是它自己那一层的事实（某个 DOI 查不到、某个数没进账本），
 * 事实没错，但模型往往会顺着字面去改那个具体的值，而不是回头改做法。
 * 2026-08-26 实测：DOI 查不到之后，30B 连着换了两个编的 DOI 再试，
 * 它读成了「这个号写错了」，而不是「引用不能自己编」。
 *
 * 所以只在认得出的几种情况上追加一句可执行的指导，认不出就什么都不加 ——
 * 宁可不说，也不要猜错了把模型带偏。
 *
 * 「一次只写一节」那条是量出来的，不是经验之谈：2026-08-27 拿同一个模型同一段上下文
 * 各问一次，让它一次写五节，总共 815 词、平均每节 163 词；只让它写引言一节，
 * 663 词。两次都是自然收尾，没有被输出上限截断。差四倍。
 * 也就是说篇幅不够不是模型写不出来，是一次交付的节数太多、它把篇幅摊薄了。
 */
function hintFor(detail: string): string {
  if (/DOI did not resolve|did not resolve through/i.test(detail)) {
    return "\n\n[怎么办] 这个 DOI 在真实数据库里不存在，多半是自己写出来的。"
      + "引用不能编，也不能凭记忆写：先跑 lit_cli.py search 拿到真实结果，"
      + "把它输出的条目**原样**放进 picks.json（直接重定向或复制整条，不要改写字段）。";
  }
  if (/writing contract failed|prose words; expected|substantive paragraphs; expected/i.test(detail)) {
    // 指名道姓点出第一个字数不够的节。只说「一次写一节」太笼统，模型不知道从哪下手，
    // 结果还是把整篇重新生成一遍 —— 2026-08-27 实测：给了通用提示之后它照样一次写完
    // 六节，每节 130 到 256 词，跟没提示时一模一样。
    const short = /([A-Za-z][\w ]*?) has (\d+) prose words; expected (\d+)/.exec(detail);
    const pick = short
      ? `\n\n现在**只重写 ${short[1]} 这一个键**：它当前 ${short[2]} 词，至少要 ${short[3]} 词，`
        + `也就是还要再写 ${Math.max(0, Number(short[3]) - Number(short[2]))} 词左右。`
        + `sections.json 里其它键一个字都不要动，改完这一个键立刻编译，过了再挑下一个。`
      : "";
    return "\n\n[怎么办] 这是写作契约没满足，不是编译错误。两件事：\n"
      + "1. 先跑一次 contract 子命令，把**这个领域的**写作要求原样读出来"
      + "（每节几段、每段该讲什么、字数区间），照着它一段一段写。\n"
      + "2. **一次只写一节，不要重新生成整篇。** 一次交五节的时候，每节都会被写得很短；"
      + "单独写一节才写得开。做法是每次只替换 sections.json 里的一个键、其余原样保留，"
      + "写完立刻编译看这一节过没过，过了再写下一节。\n"
      + "在原文上小修小补通常补不上去 —— 缺的是整段内容，不是几个词。"
      + pick;
  }
  if (/ungrounded number|not.{0,20}ledger|没有.{0,10}回执/i.test(detail)) {
    return "\n\n[怎么办] 论文里出现了没有出处的数字。不要去改论文把数字删掉，"
      + "回到分析脚本里把它打印出来、重新 record 一次，让它有据可查。";
  }
  return "";
}

export const OMNISCI_RECEIPT_PREFIX = "OmniSci-Receipt: ";
const MAX_TOOL_MS = 610_000;

export type OmniSciOperation = "record" | "bib" | "compile";

export interface OmniSciReceipt {
  version: 1;
  operation: OmniSciOperation;
  completed_at_ms: number;
  [key: string]: unknown;
}

export interface OmniSciTrace {
  tool: string;
  args: Record<string, unknown>;
  receipt: OmniSciReceipt;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function fileSha256(path: string): string {
  return sha256(readFileSync(path));
}

function omnisciBin(name: string): string {
  const root = process.env.OMNISCI;
  if (!root) throw new Error("OMNISCI 未设置，无法使用内置论文工具");
  const path = join(root, name);
  if (!existsSync(path)) throw new Error(`内置 OmniScientist CLI 不存在: ${path}`);
  return path;
}

async function runCli(
  cli: string,
  argv: string[],
  ctx: ToolContext,
  timeoutMs = MAX_TOOL_MS,
): Promise<{ stdout: string; stderr: string }> {
  const proc = Bun.spawn([...pythonCommand(), omnisciBin(cli), ...argv], {
    cwd: ctx.root,
    env: withPythonPath(safeChildEnvironment()),
    stdout: "pipe",
    stderr: "pipe",
  });
  const collected = Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  const result = await Promise.race([collected, timeout]);
  if (timer) clearTimeout(timer);
  if (!result) {
    proc.kill("SIGTERM");
    setTimeout(() => {
      try { proc.kill("SIGKILL"); } catch { /* already exited */ }
    }, 2000);
    throw new Error(`${cli} 超过 ${Math.round(timeoutMs / 1000)} 秒，已终止`);
  }
  const [stdout, stderr, code] = result;
  if (code !== 0) {
    const detail = `${stdout}${stderr ? `\n[stderr]\n${stderr}` : ""}`.trim().slice(-4000);
    throw new Error(`${cli} 退出码 ${code}${detail ? `:\n${detail}` : ""}${hintFor(detail)}`);
  }
  return { stdout, stderr };
}

function receiptText(receipt: OmniSciReceipt, body: string, ctx: ToolContext): string {
  const detail = ctx.artifacts.truncate(
    `omnisci ${receipt.operation}`,
    body.trim() || "(无额外输出)",
    30_000,
  );
  return `${OMNISCI_RECEIPT_PREFIX}${JSON.stringify(receipt)}\n${detail}`;
}

function latestLedgerLine(root: string): { raw: string; entry: Record<string, unknown> } {
  const path = join(root, "host", "ledger.jsonl");
  if (!existsSync(path)) throw new Error("record 成功返回，但 host/ledger.jsonl 不存在");
  const lines = readFileSync(path, "utf-8").split(/\r?\n/).filter((line) => line.trim());
  const raw = lines.at(-1);
  if (!raw) throw new Error("record 成功返回，但 ledger 是空的");
  let entry: Record<string, unknown>;
  try {
    entry = JSON.parse(raw) as Record<string, unknown>;
  } catch (error) {
    throw new Error(`record 写出的最后一条 ledger 不是合法 JSON: ${String(error)}`);
  }
  if (entry.returncode !== 0 || typeof entry.entry_sha256 !== "string") {
    throw new Error("record 没有写出带 entry_sha256 的成功记录");
  }
  return { raw, entry };
}

async function record(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const requested = String(args.script ?? "");
  if (!requested) throw new Error("omnisci_record 需要 script");
  const script = ctx.resolve(requested);
  const stat = statSync(script);
  if (!stat.isFile()) throw new Error(`分析脚本不是文件: ${requested}`);
  const argv = Array.isArray(args.argv) ? args.argv.map(String) : [];
  const timeoutSeconds = Math.min(Math.max(Number(args.timeout ?? 600) || 600, 1), 600);
  const result = await runCli(
    "gate_cli.py",
    ["record", "--task", ctx.caseRoot, "--script", script, "--timeout", String(timeoutSeconds), ...argv],
    ctx,
    Math.min(MAX_TOOL_MS, (timeoutSeconds + 10) * 1000),
  );
  const { raw, entry } = latestLedgerLine(ctx.caseRoot);
  const receipt: OmniSciReceipt = {
    version: 1,
    operation: "record",
    completed_at_ms: Date.now(),
    entry_sha256: entry.entry_sha256,
    ledger_line_sha256: sha256(raw),
    script: entry.script,
    script_sha256: entry.script_sha256,
    argv: entry.argv,
  };
  return receiptText(receipt, `${result.stdout}${result.stderr ? `\n[stderr]\n${result.stderr}` : ""}`, ctx);
}

async function bib(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const requested = String(args.picks ?? "");
  if (!requested) throw new Error("omnisci_bib 需要 picks");
  const picks = ctx.resolve(requested);
  if (!statSync(picks).isFile()) throw new Error(`picks 不是文件: ${requested}`);
  const result = await runCli(
    "lit_cli.py",
    ["bib", "--task", ctx.caseRoot, "--picks", picks],
    ctx,
    180_000,
  );
  const bibPath = join(ctx.caseRoot, "host", "references.bib");
  const provenancePath = join(ctx.caseRoot, "host", "references.provenance.json");
  if (!existsSync(bibPath) || !existsSync(provenancePath)) {
    throw new Error("bib 成功返回，但引用或 provenance 文件缺失");
  }
  const receipt: OmniSciReceipt = {
    version: 1,
    operation: "bib",
    completed_at_ms: Date.now(),
    bib_sha256: fileSha256(bibPath),
    provenance_sha256: fileSha256(provenancePath),
    picks_sha256: fileSha256(picks),
  };
  const thin = thinBibliographyNote(bibPath);
  return receiptText(
    receipt,
    `${result.stdout}${result.stderr ? `\n[stderr]\n${result.stderr}` : ""}${thin}`,
    ctx,
  );
}

/**
 * 引用太少时当场说出来。
 *
 * 这里只警告，不抛错。硬拦会让用户空着手走，而参考文献少是「论文偏弱」不是
 * 「论文不成立」。但也不能沉默：2026-09-01 实测，一篇 med_ct3d 的论文只带了 5 条
 * 引用就一路走到交付，全链路没有任何一处提过数量 —— SKILL.md 没写，gate 没查，
 * 编译不管。模型做了一次 `--n 6` 的搜索，挑了 5 条，然后就以为这一步做完了。
 */
const BIB_FLOOR = 12;

function thinBibliographyNote(bibPath: string): string {
  const entries = (readFileSync(bibPath, "utf-8").match(/^@/gm) ?? []).length;
  if (entries >= BIB_FLOOR) return "";
  return `\n\n注意：参考文献只有 ${entries} 条，少于 ${BIB_FLOOR} 条这个下限。`
    + `一次搜索的召回撑不起一篇论文的相关工作，通常要对不同子话题各搜一轮`
    + `（数据集与基准、任务本身的既有方法、你用的度量或统计手段、对照任务所在的领域），`
    + `每轮 --n 8 到 10，再把所有 hit 合并进 picks.json 重新调一次 omnisci_bib。`
    + `不是硬闸，少了照样能编译交付，但相关工作会明显单薄。`;
}

interface PaperManifest {
  status?: string;
  artifacts?: Record<string, { path?: string; sha256?: string }>;
  inputs?: {
    bibliography?: { sha256?: string } | null;
    figures?: Array<{ path?: string; sha256?: string }>;
  };
  review_pages?: Array<{ path?: string; sha256?: string }>;
  /** 验收 lint 的标签。红了照样出 PDF，见 paper_cli.py 的 _acceptance_lint。 */
  lint?: {
    ok?: boolean;
    error?: string;
    red?: string[];
    refs_floor?: number;
    checks?: Record<string, { ok?: boolean; detail?: string }>;
  };
}

/**
 * 把验收 lint 的结果说给模型听。每次都说，包括全绿：以前这一层根本不存在，模型无从知道
 * 论文离交付标准差在哪，5 条引用就一路走到底。红项是标签不是闸，PDF 已经生成。
 */
function lintNote(lint: PaperManifest["lint"]): string {
  if (!lint) return "";
  if (lint.error) return `\n\n验收检查没跑成（不影响 PDF）：${lint.error}`;
  const checks = lint.checks ?? {};
  const total = Object.keys(checks).length;
  const red = lint.red ?? [];
  if (!red.length) return `\n\n验收检查：${total} 项全绿。`;
  const lines = red.map((k) => `- ${k}: ${checks[k]?.detail ?? ""}`.trimEnd());
  return `\n\n验收检查：${total} 项里 ${red.length} 项红（PDF 已生成，这些是标签不是闸）：\n${lines.join("\n")}\n`
    + `按条修完再 omnisci_compile 一次。refs_count 红就回到 lit_cli.py 多搜几个子话题、合并 picks 重跑 omnisci_bib；`
    + `number_density 红就把成组的数字做成表、正文只留主效应；overfull 红多半是过长的行内公式或不可断的长串。`;
}

async function compile(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const requested = String(args.sections ?? "");
  const title = String(args.title ?? "").trim();
  if (!requested || !title) throw new Error("omnisci_compile 需要 sections 和 title");
  const sections = ctx.resolve(requested);
  if (!statSync(sections).isFile()) throw new Error(`sections 不是文件: ${requested}`);
  const authors = String(args.authors ?? "Anonymous");
  const name = String(args.name ?? "paper");
  let result;
  try {
    result = await runCli(
      "paper_cli.py",
      [
        "compile", "--task", ctx.caseRoot, "--sections", sections, "--title", title,
        "--authors", authors, "--name", name,
      ],
      ctx,
      MAX_TOOL_MS,
    );
  } catch (e) {
    // 写作契约没过的话，把契约原文一并给它。
    //
    // 契约细则（每节几段、每段该讲什么、字数区间）写在 skill 文档里，那份文档有
    // 一万八千多字符，读完之后模型还要跑几十轮工具才轮到动笔，到那时细则早被埋在
    // 历史深处了。它只好凭印象写，然后一轮轮试错。契约本来就有个命令能原样打出来，
    // 失败的这一刻正是最该看的时候，替它跑一次比让它自己想起来要靠谱。
    //
    // 只在契约失败时跑，且拿不到就算了 —— 补充信息而已，不值得让主错误被它盖住。
    const message = e instanceof Error ? e.message : String(e);
    if (!/writing contract failed|prose words; expected/i.test(message)) throw e;
    let spec = "";
    try {
      const c = await runCli("paper_cli.py", ["contract", "--task", ctx.caseRoot], ctx, 120_000);
      spec = c.stdout.trim();
    } catch { /* 拿不到就不给，别把真正的错误盖掉 */ }
    throw spec
      ? new Error(`${message}\n\n[这个领域的写作契约原文]\n${spec}`)
      : e;
  }
  const manifestPath = join(ctx.caseRoot, "host", `${name}.manifest.json`);
  if (!existsSync(manifestPath)) throw new Error("compile 成功返回，但 paper manifest 不存在");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as PaperManifest;
  const receipt: OmniSciReceipt = {
    version: 1,
    operation: "compile",
    completed_at_ms: Date.now(),
    name,
    status: manifest.status,
    manifest_sha256: fileSha256(manifestPath),
    tex_sha256: manifest.artifacts?.tex?.sha256,
    pdf_sha256: manifest.artifacts?.pdf?.sha256,
    overleaf_zip_sha256: manifest.artifacts?.overleaf_zip?.sha256,
    bibliography_sha256: manifest.inputs?.bibliography?.sha256,
    figures: manifest.inputs?.figures ?? [],
    review_pages: manifest.review_pages ?? [],
  };
  return receiptText(
    receipt,
    `${result.stdout}${result.stderr ? `\n[stderr]\n${result.stderr}` : ""}${lintNote(manifest.lint)}`,
    ctx,
  );
}

const OPERATION_BY_TOOL: Record<string, OmniSciOperation> = {
  omnisci_record: "record",
  omnisci_bib: "bib",
  omnisci_compile: "compile",
};

export function traceOmniSciReceipts(messages: unknown[]): OmniSciTrace[] {
  const calls = new Map<string, { tool: string; args: Record<string, unknown> }>();
  const traces: OmniSciTrace[] = [];
  for (const raw of messages) {
    const message = raw as {
      role?: string;
      tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
      tool_call_id?: string;
      content?: unknown;
    };
    if (message.role === "assistant") {
      for (const call of message.tool_calls ?? []) {
        const tool = String(call.function?.name ?? "");
        if (!call.id || !(tool in OPERATION_BY_TOOL)) continue;
        try {
          calls.set(call.id, {
            tool,
            args: JSON.parse(call.function?.arguments || "{}") as Record<string, unknown>,
          });
        } catch {
          // A malformed tool call cannot have executed successfully through AgentLoop.
        }
      }
      continue;
    }
    if (message.role !== "tool" || !message.tool_call_id || typeof message.content !== "string") continue;
    const call = calls.get(message.tool_call_id);
    if (!call) continue;
    const firstLine = message.content.split(/\r?\n/, 1)[0] ?? "";
    if (!firstLine.startsWith(OMNISCI_RECEIPT_PREFIX)) continue;
    try {
      const receipt = JSON.parse(firstLine.slice(OMNISCI_RECEIPT_PREFIX.length)) as OmniSciReceipt;
      if (receipt.version !== 1 || receipt.operation !== OPERATION_BY_TOOL[call.tool]) continue;
      traces.push({ ...call, receipt });
    } catch {
      // Only a syntactically valid harness receipt is evidence.
    }
  }
  return traces;
}

export const OMNISCI_TOOLS: Tool[] = [
  {
    name: "omnisci_record",
    description:
      "运行工作区内的分析脚本并生成本会话可信 ledger 回执。论文数字必须通过这个工具记录，不能用 bash 直接调用 gate_cli record。",
    parameters: {
      type: "object",
      properties: {
        script: { type: "string", description: "工作区内分析脚本的相对路径" },
        argv: { type: "array", items: { type: "string" }, description: "传给脚本的位置参数" },
        timeout: { type: "integer", minimum: 1, maximum: 600, description: "超时秒数，默认 600" },
      },
      required: ["script"],
    },
    needsApproval: true,
    summarize: (args) => `记录分析 ${String(args.script ?? "")}`,
    run: record,
  },
  {
    name: "omnisci_bib",
    description:
      "用 DOI 重新验证 picks 并生成 references.bib、provenance 和本会话可信哈希回执。最终引用必须通过此工具。",
    parameters: {
      type: "object",
      properties: { picks: { type: "string", description: "工作区内 picks JSON 的相对路径" } },
      required: ["picks"],
    },
    needsApproval: true,
    summarize: (args) => `验证引用 ${String(args.picks ?? "")}`,
    run: bib,
  },
  {
    name: "omnisci_compile",
    description:
      "从 sections JSON 干净生成论文 tex、PDF、Overleaf zip、PDF 审阅页和本会话可信 manifest 回执。最终交付必须通过此工具。",
    parameters: {
      type: "object",
      properties: {
        sections: { type: "string", description: "工作区内 sections JSON 的相对路径" },
        title: { type: "string" },
        authors: { type: "string", description: "默认 Anonymous" },
        name: { type: "string", description: "产物名，最终交付使用 paper" },
      },
      required: ["sections", "title"],
    },
    needsApproval: true,
    summarize: (args) => `编译论文 ${String(args.title ?? "").slice(0, 100)}`,
    run: compile,
  },
];
