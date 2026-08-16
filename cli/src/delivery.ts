import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";

import { safeChildEnvironment } from "./credentials.ts";
import { pythonCommand } from "./interpreters.ts";
import { fileSha256, traceOmniSciReceipts, type OmniSciTrace } from "./tools/omnisci.ts";
import { VISION_META_PREFIX, type PerceptionReceipt } from "./tools/vision.ts";

interface ToolCall {
  id?: string;
  function?: { name?: string; arguments?: string };
}

interface PendingItem {
  id: string | number;
  image: string;
  question: string;
}

interface Receipt {
  receipt_id?: string;
  image_sha256?: string;
  question_sha256?: string;
  observation_sha256?: string;
  observation?: string;
}

interface EvidenceCall {
  call_id?: string | number;
  status?: string;
  pending?: PendingItem[];
  receipts?: Record<string, Receipt>;
}

interface ManifestFile {
  path?: string;
  sha256?: string;
  size?: number;
}

interface PaperManifest {
  version?: number;
  status?: string;
  name?: string;
  inputs?: {
    bibliography?: ManifestFile | null;
    figures?: ManifestFile[];
  };
  artifacts?: {
    tex?: ManifestFile;
    pdf?: ManifestFile;
    overleaf_zip?: ManifestFile;
  };
  review_pages?: ManifestFile[];
}

interface VisionTrace {
  args: Record<string, unknown>;
  content: string;
  receiptId: string;
  meta?: PerceptionReceipt;
}

export interface DeliveryResult {
  ok: boolean;
  errors: string[];
  gate?: Record<string, unknown>;
}

const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

function traceVisionReceipts(messages: unknown[]): VisionTrace[] {
  const argsById = new Map<string, Record<string, unknown>>();
  const traces: VisionTrace[] = [];
  for (const raw of messages) {
    const message = raw as { role?: string; tool_calls?: ToolCall[]; tool_call_id?: string; content?: unknown };
    if (message.role === "assistant") {
      for (const call of message.tool_calls ?? []) {
        if (call.id && call.function?.name === "view_image") {
          try {
            argsById.set(call.id, JSON.parse(call.function.arguments || "{}") as Record<string, unknown>);
          } catch {
            // AgentLoop rejects malformed arguments, so they cannot prove a successful view.
          }
        }
      }
      continue;
    }
    if (message.role !== "tool" || !message.tool_call_id || typeof message.content !== "string") continue;
    const args = argsById.get(message.tool_call_id);
    if (!args) continue;
    const receiptId = /^OmniSci-Vision-Receipt:\s*([0-9a-f-]+)$/m.exec(message.content)?.[1];
    if (!receiptId) continue;
    let meta: PerceptionReceipt | undefined;
    const metaLine = message.content.split(/\r?\n/).find((line) => line.startsWith(VISION_META_PREFIX));
    if (metaLine) {
      try {
        const parsed = JSON.parse(metaLine.slice(VISION_META_PREFIX.length)) as PerceptionReceipt;
        if (parsed.receipt_id === receiptId) meta = parsed;
      } catch {
        // A malformed metadata line is not evidence.
      }
    }
    traces.push({ args, content: message.content, receiptId, meta });
  }
  return traces;
}

function pathInside(root: string, requested: string): string | null {
  const rootAbs = resolve(root);
  const path = resolve(rootAbs, requested);
  if (path !== rootAbs && !path.startsWith(rootAbs + sep)) return null;
  if (!existsSync(path)) return path;
  const realRoot = realpathSync(rootAbs);
  const real = realpathSync(path);
  return real === realRoot || real.startsWith(realRoot + sep) ? path : null;
}

function receiptIsFresh(receipt: PerceptionReceipt | undefined, startedAt: number): boolean {
  if (!receipt) return startedAt <= 0;
  const viewedAt = Date.parse(receipt.viewed_at);
  return Number.isFinite(viewedAt) && viewedAt >= startedAt - 2000;
}

function validVisionTrace(
  root: string,
  trace: VisionTrace,
  expectedPath: string,
  expectedSha: string,
  startedAt: number,
): boolean {
  const requested = pathInside(root, String(trace.args.path ?? ""));
  if (!requested || !existsSync(requested) || realpathSync(requested) !== realpathSync(expectedPath)) return false;
  if (!trace.meta || trace.meta.receipt_id !== trace.receiptId) return false;
  if (trace.meta.image_sha256 !== expectedSha || fileSha256(expectedPath) !== expectedSha) return false;
  const question = String(trace.args.question ?? "请忠实描述图中可见的结构、异常和不确定之处。");
  if (trace.meta.question_sha256 !== sha256(question)) return false;
  const observation = String(trace.meta.observation ?? "");
  if (!observation || trace.meta.observation_sha256 !== sha256(observation)) return false;
  if (!trace.content.includes(observation) || !receiptIsFresh(trace.meta, startedAt)) return false;
  return true;
}

export function verifyPerceptionTrace(root: string, messages: unknown[], startedAt = 0): string[] {
  const callsDir = join(root, "host", "calls");
  if (!existsSync(callsDir)) return [];
  const traces = traceVisionReceipts(messages);
  const errors: string[] = [];
  for (const filename of readdirSync(callsDir).filter((name) => /^call_\d+\.json$/.test(name)).sort()) {
    let call: EvidenceCall;
    try {
      call = JSON.parse(readFileSync(join(callsDir, filename), "utf-8")) as EvidenceCall;
    } catch (error) {
      errors.push(`${filename} 不是合法的感知调用记录: ${String(error)}`);
      continue;
    }
    if (call.status !== "done") continue;
    for (const pending of call.pending ?? []) {
      const receipt = call.receipts?.[String(pending.id)];
      const id = receipt?.receipt_id;
      const trace = id ? traces.find((item) => item.receiptId === id) : undefined;
      const label = `call ${call.call_id ?? filename} request ${pending.id}`;
      if (!receipt || !id || !trace) {
        errors.push(`${label} 没有本次会话的 view_image 回执`);
        continue;
      }
      const requested = pathInside(root, String(trace.args.path ?? ""));
      const pendingPath = pathInside(root, String(pending.image));
      if (!requested || !pendingPath || !existsSync(requested) || !existsSync(pendingPath) ||
          realpathSync(requested) !== realpathSync(pendingPath)) {
        errors.push(`${label} 的 view_image 路径不匹配`);
      }
      if (String(trace.args.question ?? "") !== String(pending.question)) {
        errors.push(`${label} 的 view_image 问题不匹配`);
      }
      if (!receipt.observation || !trace.content.includes(receipt.observation)) {
        errors.push(`${label} 的 ingest 观察不来自 view_image 返回`);
      }
      if (startedAt > 0) {
        const expectedSha = pendingPath && existsSync(pendingPath) ? fileSha256(pendingPath) : "";
        if (!pendingPath || !validVisionTrace(root, trace, pendingPath, expectedSha, startedAt)) {
          errors.push(`${label} 的 view_image 像素哈希或时间不属于本轮`);
        }
      }
      if (trace.meta && (
        receipt.image_sha256 !== trace.meta.image_sha256 ||
        receipt.question_sha256 !== trace.meta.question_sha256 ||
        receipt.observation_sha256 !== trace.meta.observation_sha256
      )) {
        errors.push(`${label} 的 ingest 回执与会话回执哈希不一致`);
      }
    }
  }
  return errors;
}

export function verifyArtifactReviewTrace(
  root: string,
  messages: unknown[],
  files: ManifestFile[],
  startedAt: number,
  label: string,
): string[] {
  const traces = traceVisionReceipts(messages);
  const errors: string[] = [];
  for (const item of files) {
    const path = item.path ? pathInside(root, item.path) : null;
    if (!path || !existsSync(path) || !statSync(path).isFile() || !item.sha256) {
      errors.push(`${label} 缺少有效文件或哈希: ${String(item.path ?? "")}`);
      continue;
    }
    if (fileSha256(path) !== item.sha256) {
      errors.push(`${label} 在审阅后发生变化: ${item.path}`);
      continue;
    }
    if (!traces.some((trace) => validVisionTrace(root, trace, path, item.sha256!, startedAt))) {
      errors.push(`${label} 没有本轮真实 view_image 审阅: ${item.path}`);
    }
  }
  return errors;
}

function currentArtifact(path: string, startedAt: number, required: boolean, errors: string[]): void {
  if (!existsSync(path)) {
    if (required) errors.push(`缺少交付物 ${path}`);
    return;
  }
  const stat = statSync(path);
  if (!stat.isFile() || stat.size === 0) errors.push(`交付物为空 ${path}`);
  if (stat.mtimeMs < startedAt - 2000) errors.push(`交付物不是本轮生成的 ${path}`);
}

function freshTraces(messages: unknown[], startedAt: number): OmniSciTrace[] {
  return traceOmniSciReceipts(messages).filter((trace) =>
    Number(trace.receipt.completed_at_ms) >= startedAt - 2000,
  );
}

function verifyManifestFile(
  root: string,
  item: ManifestFile | undefined,
  expectedPath: string,
  receiptHash: unknown,
  startedAt: number,
  errors: string[],
): string | null {
  if (!item?.path || item.path !== expectedPath || typeof item.sha256 !== "string") {
    errors.push(`paper manifest 缺少或错误绑定 ${expectedPath}`);
    return null;
  }
  const path = pathInside(root, item.path);
  if (!path) {
    errors.push(`paper manifest 路径越出工作区: ${item.path}`);
    return null;
  }
  currentArtifact(path, startedAt, true, errors);
  if (existsSync(path)) {
    const actual = fileSha256(path);
    if (actual !== item.sha256 || actual !== receiptHash) {
      errors.push(`交付物哈希与 compile 回执不一致: ${item.path}`);
    }
  }
  return path;
}

function verifyBibliography(
  root: string,
  manifest: PaperManifest,
  traces: OmniSciTrace[],
  errors: string[],
): void {
  const bib = join(root, "host", "references.bib");
  const provenance = join(root, "host", "references.provenance.json");
  if (!existsSync(bib) || !existsSync(provenance)) {
    errors.push("缺少 references.bib 或 references.provenance.json");
    return;
  }
  const bibSha = fileSha256(bib);
  const proofSha = fileSha256(provenance);
  const receipt = [...traces].reverse().find((trace) =>
    trace.receipt.operation === "bib" &&
    trace.receipt.bib_sha256 === bibSha &&
    trace.receipt.provenance_sha256 === proofSha,
  );
  if (!receipt) errors.push("当前 bibliography 没有本轮 omnisci_bib 可信回执");
  if (manifest.inputs?.bibliography?.sha256 !== bibSha) {
    errors.push("compile manifest 没有绑定当前 bibliography");
  }
}

function ledgerRawHashes(root: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const path = join(root, "host", "ledger.jsonl");
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, "utf-8").split(/\r?\n/).filter((item) => item.trim())) {
    try {
      const entry = JSON.parse(line) as { entry_sha256?: string };
      if (!entry.entry_sha256) continue;
      const hashes = out.get(entry.entry_sha256) ?? new Set<string>();
      hashes.add(sha256(line));
      out.set(entry.entry_sha256, hashes);
    } catch {
      // gate_cli reports malformed ledger entries; they cannot match a receipt here.
    }
  }
  return out;
}

function verifyLedger(
  root: string,
  gate: Record<string, unknown> | undefined,
  traces: OmniSciTrace[],
  errors: string[],
): void {
  const ledger = gate?.ledger as { active_entries?: Array<{ entry_sha256?: string }> } | undefined;
  const active = ledger?.active_entries ?? [];
  if (!active.length) {
    errors.push("最终 gate 没有返回 active ledger entry");
    return;
  }
  const raw = ledgerRawHashes(root);
  for (const entry of active) {
    const entrySha = entry.entry_sha256;
    const rawHashes = entrySha ? raw.get(entrySha) : undefined;
    const receipt = entrySha && rawHashes
      ? traces.find((trace) =>
          trace.receipt.operation === "record" &&
          trace.receipt.entry_sha256 === entrySha &&
          rawHashes.has(String(trace.receipt.ledger_line_sha256 ?? "")),
        )
      : undefined;
    if (!receipt) errors.push(`active ledger entry 没有本轮 omnisci_record 可信回执: ${entrySha ?? "unknown"}`);
  }
}

export async function verifyPaperDelivery(
  root: string,
  messages: unknown[],
  startedAt: number,
): Promise<DeliveryResult> {
  const errors: string[] = [];
  const host = join(root, "host");
  const manifestPath = join(host, "paper.manifest.json");
  currentArtifact(join(root, "series.json"), 0, true, errors);
  currentArtifact(manifestPath, startedAt, true, errors);
  errors.push(...verifyPerceptionTrace(root, messages, startedAt));

  const traces = freshTraces(messages, startedAt);
  let manifest: PaperManifest | undefined;
  let compileTrace: OmniSciTrace | undefined;
  if (existsSync(manifestPath)) {
    try {
      manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as PaperManifest;
    } catch (error) {
      errors.push(`paper manifest 不是合法 JSON: ${String(error)}`);
    }
    const manifestSha = fileSha256(manifestPath);
    compileTrace = [...traces].reverse().find((trace) =>
      trace.receipt.operation === "compile" &&
      trace.receipt.name === "paper" &&
      trace.receipt.manifest_sha256 === manifestSha,
    );
    if (!compileTrace) errors.push("当前 paper manifest 没有本轮 omnisci_compile 可信回执");
  }

  let texPath: string | null = null;
  if (manifest && compileTrace) {
    if (manifest.version !== 1 || manifest.name !== "paper" || manifest.status !== "ok" ||
        compileTrace.receipt.status !== "ok") {
      errors.push("最终 compile manifest 不是成功的 paper v1 交付");
    }
    texPath = verifyManifestFile(
      root, manifest.artifacts?.tex, "host/paper.tex", compileTrace.receipt.tex_sha256,
      startedAt, errors,
    );
    verifyManifestFile(
      root, manifest.artifacts?.pdf, "host/paper.pdf", compileTrace.receipt.pdf_sha256,
      startedAt, errors,
    );
    verifyManifestFile(
      root, manifest.artifacts?.overleaf_zip, "host/paper_overleaf.zip",
      compileTrace.receipt.overleaf_zip_sha256, startedAt, errors,
    );
    verifyBibliography(root, manifest, traces, errors);
    const figures = manifest.inputs?.figures ?? [];
    const reviewPages = manifest.review_pages ?? [];
    if (!reviewPages.length) errors.push("compile manifest 没有当前 PDF 的渲染审阅页");
    errors.push(...verifyArtifactReviewTrace(root, messages, figures, startedAt, "分析图"));
    errors.push(...verifyArtifactReviewTrace(root, messages, reviewPages, startedAt, "PDF 页面"));
  }

  let gate: Record<string, unknown> | undefined;
  if (texPath && existsSync(texPath)) {
    const omnisci = process.env.OMNISCI;
    if (!omnisci) {
      errors.push("OMNISCI 未设置，无法执行最终 gate");
    } else {
      const proc = Bun.spawn(
        [...pythonCommand(), join(omnisci, "gate_cli.py"), "check", "--task", root, "--tex", "host/paper.tex"],
        { cwd: root, stdout: "pipe", stderr: "pipe", env: safeChildEnvironment() },
      );
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      try {
        gate = JSON.parse(stdout) as Record<string, unknown>;
      } catch {
        errors.push(`最终 gate 没有返回合法 JSON: ${(stderr || stdout).slice(-500)}`);
      }
      if (code !== 0 || gate?.status !== "ok") {
        errors.push(`最终 gate 未通过: ${String(gate?.reason ?? stderr.trim() ?? `exit ${code}`)}`);
      }
      const texSha = fileSha256(texPath);
      if (gate?.tex_sha256 !== texSha || manifest?.artifacts?.tex?.sha256 !== texSha) {
        errors.push("最终 gate 检查的 tex 与 compile 交付 tex 不是同一哈希");
      }
      const citations = gate?.citations as Record<string, unknown> | undefined;
      const bib = join(host, "references.bib");
      const proof = join(host, "references.provenance.json");
      if (existsSync(bib) && citations?.bib_sha256 !== fileSha256(bib)) {
        errors.push("最终 gate 的 bibliography 哈希与交付不一致");
      }
      if (existsSync(proof) && citations?.provenance_sha256 !== fileSha256(proof)) {
        errors.push("最终 gate 的 provenance 哈希与交付不一致");
      }
      verifyLedger(root, gate, traces, errors);
    }
  }
  return { ok: errors.length === 0, errors, gate };
}
