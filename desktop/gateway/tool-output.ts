import type { ChatMessage, ToolStep } from "../src/types.ts";

export const TOOL_OUTPUT_LIMIT = 12_000;

type Redact = (value: string, limit?: number) => string;

interface ToolOutput {
  output?: string;
  outputTruncated?: boolean;
}

interface RecordedToolResult {
  tool: string;
  source: string;
  output: string;
}

export interface StoredToolResult extends RecordedToolResult {
  turn: number;
}

function containsSkillInstructions(tool: string, source: string): boolean {
  if (tool === "use_skill") return true;
  return /(?:^|[/\\"'])SKILL\.md\b/i.test(source)
    || /(?:^|[/\\])skills?[/\\][^\s"']+/i.test(source) && /\b(?:cat|sed|head|tail|read_file)\b/i.test(source);
}

function redactCredentials(value: string): string {
  const credentialName = "(?:api[_-]?key|access[_-]?(?:key|token)|auth[_-]?token|client[_-]?secret|secret|password|credential|[A-Z][A-Z0-9_]*(?:_KEY|_TOKEN|_SECRET|_PASSWORD|_CREDENTIALS?))";
  return value
    .replace(
      /-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]*PRIVATE KEY-----/g,
      "[private key redacted]",
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/\b(?:sk|ghp|github_pat|xox[aboprs])[-_][A-Za-z0-9_-]{12,}\b/g, "[token redacted]")
    .replace(new RegExp(`((["']?${credentialName}["']?)\\s*[:=]\\s*)(["'])([^\\r\\n"']+)\\3`, "gi"), "$1$3[redacted]$3")
    .replace(new RegExp(`(\\b${credentialName}\\s*[:=]\\s*)[^\\s,;]+`, "gi"), "$1[redacted]");
}

function collapseLargeNumericArrays(value: string): string {
  return value.split(/(\r?\n)/).map((line) => {
    if (line.length < 160 || !line.includes("[") || !line.includes("]")) return line;
    const open = line.indexOf("[");
    const close = line.lastIndexOf("]");
    if (close <= open) return line;
    const body = line.slice(open + 1, close);
    const values = body.split(",").map((item) => item.trim());
    if (values.length < 40 || values.some((item) => !/^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?$/i.test(item))) {
      return line;
    }
    return `${line.slice(0, open)}[large numeric array omitted · ${values.length} values]${line.slice(close + 1)}`;
  }).join("");
}

export function sanitizeToolOutput(
  value: string | undefined,
  tool: string,
  source: string,
  redact: Redact,
  limit = TOOL_OUTPUT_LIMIT,
): ToolOutput {
  if (!value || containsSkillInstructions(tool, source)) return {};

  const withoutReceipts = value
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .split(/\r?\n/)
    .filter((line) => !/^\s*OmniSci-(?:Receipt|Vision-Receipt|Vision-Meta):/i.test(line))
    .join("\n");
  const collapsed = collapseLargeNumericArrays(withoutReceipts);
  const cleaned = redact(redactCredentials(collapsed), Math.max(limit * 8, collapsed.length + 1))
    .trim();
  if (!cleaned) return {};

  const outputTruncated = cleaned.length > limit;
  return {
    output: outputTruncated ? cleaned.slice(0, limit).trimEnd() : cleaned,
    ...(outputTruncated ? { outputTruncated: true } : {}),
  };
}

function recordedToolTurns(messages: unknown[]): RecordedToolResult[][] {
  const turns: RecordedToolResult[][] = [];
  const calls = new Map<string, { tool: string; source: string; turn: number }>();
  let turn = -1;

  for (const raw of messages) {
    if (!raw || typeof raw !== "object") continue;
    const message = raw as {
      role?: unknown;
      content?: unknown;
      tool_call_id?: unknown;
      tool_calls?: Array<{
        id?: unknown;
        function?: { name?: unknown; arguments?: unknown };
      }>;
    };
    if (message.role === "user") {
      turn += 1;
      turns[turn] ??= [];
      continue;
    }
    if (message.role === "assistant") {
      for (const call of message.tool_calls ?? []) {
        if (typeof call.id !== "string" || typeof call.function?.name !== "string" || turn < 0) continue;
        calls.set(call.id, {
          tool: call.function.name,
          source: typeof call.function.arguments === "string" ? call.function.arguments : "",
          turn,
        });
      }
      continue;
    }
    if (message.role !== "tool" || typeof message.tool_call_id !== "string") continue;
    const call = calls.get(message.tool_call_id);
    if (!call || typeof message.content !== "string") continue;
    turns[call.turn] ??= [];
    turns[call.turn]!.push({ tool: call.tool, source: call.source, output: message.content });
  }
  return turns;
}

function groupedStoredResults(results: StoredToolResult[]): RecordedToolResult[][] {
  const turns: RecordedToolResult[][] = [];
  for (const result of results) {
    const index = Math.max(0, result.turn - 1);
    turns[index] ??= [];
    turns[index]!.push(result);
  }
  return turns;
}

function expectedOutputLength(step: ToolStep): number | undefined {
  const match = /^([\d,]+)\s*字符$/u.exec(step.detail.trim());
  return match ? Number(match[1]!.replaceAll(",", "")) : undefined;
}

function matchResult(
  step: ToolStep,
  results: RecordedToolResult[],
  cursor: number,
): { result: RecordedToolResult; index: number } | undefined {
  const candidates = results
    .map((result, index) => ({ result, index }))
    .filter(({ result, index }) => index >= cursor && result.tool === step.tool);
  const expectedLength = expectedOutputLength(step);
  if (expectedLength !== undefined) {
    const exact = candidates.find(({ result }) => result.output.length === expectedLength);
    if (exact) return exact;
  }
  if (step.status === "failed") {
    const failure = candidates.find(({ result }) => /^(?:ERROR:|用户拒绝:)/u.test(result.output));
    if (failure) return failure;
  }
  return candidates[0];
}

/** Add bounded, sanitized raw results to Web snapshots created before outputs were persisted. */
export function hydrateToolOutputs(
  chatMessages: ChatMessage[],
  modelMessages: unknown[],
  redact: Redact,
  storedResults?: StoredToolResult[],
): boolean {
  const turns = storedResults?.length ? groupedStoredResults(storedResults) : recordedToolTurns(modelMessages);
  const cursors = new Map<number, number>();
  let chatTurn = -1;
  let changed = false;

  for (const message of chatMessages) {
    if (message.role === "user") {
      chatTurn += 1;
      continue;
    }
    const blockSteps = (message.blocks ?? [])
      .filter((block) => block.type === "tool")
      .map((block) => block.step);
    const steps = message.toolRun?.steps.length ? message.toolRun.steps : blockSteps;
    if (!steps.length || chatTurn < 0) continue;

    const results = turns[chatTurn] ?? [];
    let cursor = cursors.get(chatTurn) ?? 0;
    const outputs = new Map<string, ToolOutput>();
    for (const step of steps) {
      const matched = matchResult(step, results, cursor);
      if (!matched) continue;
      cursor = matched.index + 1;
      const sanitized = sanitizeToolOutput(
        matched.result.output,
        matched.result.tool,
        matched.result.source,
        redact,
      );
      outputs.set(step.id, sanitized);
      if (!step.output && sanitized.output) {
        Object.assign(step, sanitized);
        changed = true;
      }
    }
    cursors.set(chatTurn, cursor);

    for (const block of message.blocks ?? []) {
      if (block.type !== "tool") continue;
      const sanitized = outputs.get(block.step.id);
      if (!block.step.output && sanitized?.output) Object.assign(block.step, sanitized);
    }
    for (const step of message.toolRun?.steps ?? []) {
      const sanitized = outputs.get(step.id);
      if (!step.output && sanitized?.output) Object.assign(step, sanitized);
    }
  }
  return changed;
}
