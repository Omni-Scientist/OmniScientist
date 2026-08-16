import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { safeChildEnvironment } from "../credentials.ts";
import { pythonCommand } from "../interpreters.ts";
import type { Tool, ToolContext } from "./index.ts";

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
    env: safeChildEnvironment(),
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
    throw new Error(`${cli} 退出码 ${code}${detail ? `:\n${detail}` : ""}`);
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
  return receiptText(receipt, `${result.stdout}${result.stderr ? `\n[stderr]\n${result.stderr}` : ""}`, ctx);
}

interface PaperManifest {
  status?: string;
  artifacts?: Record<string, { path?: string; sha256?: string }>;
  inputs?: {
    bibliography?: { sha256?: string } | null;
    figures?: Array<{ path?: string; sha256?: string }>;
  };
  review_pages?: Array<{ path?: string; sha256?: string }>;
}

async function compile(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const requested = String(args.sections ?? "");
  const title = String(args.title ?? "").trim();
  if (!requested || !title) throw new Error("omnisci_compile 需要 sections 和 title");
  const sections = ctx.resolve(requested);
  if (!statSync(sections).isFile()) throw new Error(`sections 不是文件: ${requested}`);
  const authors = String(args.authors ?? "Anonymous");
  const name = String(args.name ?? "paper");
  const result = await runCli(
    "paper_cli.py",
    [
      "compile", "--task", ctx.caseRoot, "--sections", sections, "--title", title,
      "--authors", authors, "--name", name,
    ],
    ctx,
    MAX_TOOL_MS,
  );
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
  return receiptText(receipt, `${result.stdout}${result.stderr ? `\n[stderr]\n${result.stderr}` : ""}`, ctx);
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
