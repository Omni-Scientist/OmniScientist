import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { extname, join, relative, resolve } from "node:path";

import { DEFAULT_EFFORT, ModelClient, supportsEffort, type ProviderName } from "../model.ts";
import type { Tool, ToolContext, ToolResult } from "./index.ts";

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const VISION_META_PREFIX = "OmniSci-Vision-Meta: ";
const MIME: Record<string, string> = {
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

export interface VisionConfig {
  provider: ProviderName;
  model: string;
  /** 覆盖通道的默认地址，自定义端点用。空表示用通道自带的。 */
  baseUrl?: string;
  /** 覆盖从环境变量读到的 key。桌面版的 key 是界面上填的，不在环境里。 */
  apiKey?: string;
  /**
   * 推理档位，只对 OpenAI 推理模型有效：none / low / medium / high / xhigh。
   * 没有 max 这一档，想要最强思考就是 xhigh。
   */
  effort?: string;
}

/** 默认从环境变量取。CLI 走的就是这条。 */
function envVisionConfig(): VisionConfig {
  return {
    provider: (process.env.OMNISCI_VISION_PROVIDER ?? "anthropic") as ProviderName,
    model: process.env.OMNISCI_VISION_MODEL ?? "claude-sonnet-5",
    baseUrl: process.env.OMNISCI_VISION_BASE_URL || undefined,
    effort: process.env.OMNISCI_VISION_EFFORT || undefined,
  };
}

/**
 * 没显式给档位时的默认。只对 OpenAI 官方通道生效。
 *
 * 别只按模型名判：自定义端点上挂的 gpt-5.x（OpenRouter、公司网关、自建）
 * 不保证收 reasoning_effort，默认塞过去就是无缘无故 400。那边留空。
 */
function withDefaultEffort(config: VisionConfig): VisionConfig {
  if (config.effort || config.provider !== "openai" || !supportsEffort(config.model)) return config;
  return { ...config, effort: DEFAULT_EFFORT };
}

/**
 * 视觉侧车用哪个模型，是运行时问出来的，不是模块加载时定死的。
 *
 * 定死会有两个后果：桌面版在界面上改完设置要重启进程才生效；视觉通道和主模型
 * 通道被迫共用 OMNISCI_BASE_URL，配不出「主模型走 DeepSeek、眼睛走别家」。
 */
let resolveConfig: () => VisionConfig = envVisionConfig;

export function setVisionResolver(next: (() => VisionConfig) | null): void {
  resolveConfig = next ?? envVisionConfig;
  client = null;
  clientKey = "";
}

export function visionConfig(): VisionConfig {
  return withDefaultEffort(resolveConfig());
}

let client: ModelClient | null = null;
let clientKey = "";

/**
 * 视觉侧车的输出上限。默认 8000，`OMNISCI_VISION_MAX_TOKENS` 可调。
 *
 * 以前写死 1200，理由是"一段观察用不了那么多"。这忽略了推理模型：DeepSeek V4、GLM、Qwen
 * 这类模型的思考 token 也从这个上限里扣、而且先扣，1200 被想没了，正文一个字没有，
 * finish_reason=length，用户看到的是"视觉模型没有返回观察文本"（2026-09-02 在
 * deepseek-v4-flash-vision-exp 上实测）。之前给 gpt-5.x 单独加余量修过一次同样的坑，
 * 按模型名开口子，换一个模型就再漏一次。所以这里不认模型名：上限是天花板不是消费，
 * 不推理的模型说完就停、一个 token 不多花；推理的模型有地方想。
 */
export function visionMaxTokens(): number {
  const raw = (process.env.OMNISCI_VISION_MAX_TOKENS ?? "").trim();
  const n = Number(raw);
  return raw && Number.isInteger(n) && n > 0 ? n : 8000;
}

/** 配置变了就换一个客户端，别拿旧地址旧 key 继续发。 */
function clientFor(config: VisionConfig, maxTokens = visionMaxTokens()): ModelClient {
  // JSON.stringify 而不是 join：拼接符再巧也可能出现在值里，两个不同配置可以拼出同一个 key。
  const key = JSON.stringify([config.provider, config.model, config.baseUrl ?? "", config.apiKey ?? "", config.effort ?? "", maxTokens]);
  if (!client || clientKey !== key) {
    client = new ModelClient({
      provider: config.provider,
      model: config.model,
      maxTokens,
      ...(config.baseUrl ? { baseURL: config.baseUrl } : {}),
      ...(config.apiKey ? { apiKey: config.apiKey } : {}),
      ...(config.effort ? { effort: config.effort } : {}),
    });
    clientKey = key;
  }
  return client;
}

interface PendingVision {
  id: string | number;
  image: string;
  question: string;
}

interface EvidenceCall {
  call_id?: string | number;
  pending?: PendingVision[];
  receipts?: Record<string, PerceptionReceipt>;
}

export interface PerceptionReceipt {
  receipt_id: string;
  image_sha256: string;
  question_sha256: string;
  observation_sha256: string;
  observation: string;
  provider: string;
  model: string;
  viewed_at: string;
}

const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

/** Attach a trusted view_image observation to every matching pending evidence request. */
export function recordPerceptionReceipt(
  root: string,
  imagePath: string,
  question: string,
  observation: string,
  provider: string,
  model: string,
): { receiptId: string; receipt: PerceptionReceipt; matched: number } {
  const receiptId = randomUUID();
  const receipt: PerceptionReceipt = {
    receipt_id: receiptId,
    image_sha256: sha256(readFileSync(imagePath)),
    question_sha256: sha256(question),
    observation_sha256: sha256(observation),
    observation,
    provider,
    model,
    viewed_at: new Date().toISOString(),
  };
  const callsDir = join(root, "host", "calls");
  if (!existsSync(callsDir)) return { receiptId, receipt, matched: 0 };

  const viewed = realpathSync(imagePath);
  let matched = 0;
  for (const filename of readdirSync(callsDir).filter((name) => /^call_\d+\.json$/.test(name)).sort()) {
    const path = join(callsDir, filename);
    const call = JSON.parse(readFileSync(path, "utf-8")) as EvidenceCall;
    let changed = false;
    for (const pending of call.pending ?? []) {
      const candidate = resolve(root, String(pending.image));
      if (!existsSync(candidate) || realpathSync(candidate) !== viewed || String(pending.question) !== question) {
        continue;
      }
      call.receipts ??= {};
      call.receipts[String(pending.id)] = receipt;
      matched++;
      changed = true;
    }
    if (changed) {
      const tmp = `${path}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(call, null, 2), "utf-8");
      renameSync(tmp, path);
    }
  }
  return { receiptId, receipt, matched };
}

/**
 * 这张图上挂着哪些待处理的感知请求的问题（去重、保序）。
 *
 * 为什么需要：gate 校验回执时比的是 sha256(pending.question)，也就是**流水线
 * 记下的那句问题才是权威**。agent 自己另起一句问法，回执就绑不上，而且是静默
 * 绑不上——实测 agent 会把整轮预算烧在查"回执为什么没写进 call 文件"上。
 */
export function pendingQuestionsFor(root: string, imagePath: string): string[] {
  const callsDir = join(root, "host", "calls");
  if (!existsSync(callsDir)) return [];
  const viewed = realpathSync(imagePath);
  const out: string[] = [];
  for (const filename of readdirSync(callsDir).filter((name) => /^call_\d+\.json$/.test(name)).sort()) {
    let call: EvidenceCall;
    try {
      call = JSON.parse(readFileSync(join(callsDir, filename), "utf-8")) as EvidenceCall;
    } catch {
      continue;   // 半写的 call 文件不该让整个 view_image 崩掉
    }
    for (const pending of call.pending ?? []) {
      if (call.receipts?.[String(pending.id)]) continue;      // 已经有回执了
      const candidate = resolve(root, String(pending.image));
      if (!existsSync(candidate) || realpathSync(candidate) !== viewed) continue;
      const question = String(pending.question ?? "");
      if (question && !out.includes(question)) out.push(question);
    }
  }
  return out;
}

/**
 * 图片路径解析。case 目录优先，工作区根兜底。
 *
 * host/renders 在 case 目录下，evidence_cli.py 报的也是 case 相对路径，所以
 * caseRoot 是主基准。但模型也会写工作区相对路径（datasets/<名字>/host/...），
 * 那条同样合法，所以两个基准都试。越界检查在 ctx 里，两条路都过同一道。
 *
 * 两边都不存在就抛，并且把试过的路径写进错误里：以前只有一条裸 ENOENT，
 * agent 看不出自己少了 datasets/<名字> 那一层，会一直原地改路径试。
 */
function resolveImagePath(ctx: ToolContext, requested: string): string {
  const fromCase = ctx.resolveCase(requested);
  if (existsSync(fromCase)) return fromCase;

  const fromRoot = ctx.resolve(requested);
  if (existsSync(fromRoot)) return fromRoot;

  const tried = fromCase === fromRoot ? fromCase : `${fromCase}\n  ${fromRoot}`;
  throw new Error(
    `找不到图片 ${requested}。试过：\n  ${tried}\n`
    + `host/ 下的路径是相对 case 目录（${relative(ctx.root, ctx.caseRoot) || "."}）的。`,
  );
}

export function buildImageRequest(args: Record<string, unknown>, ctx: ToolContext) {
  const requested = String(args.path ?? "");
  if (!requested) throw new Error("view_image 需要 path");

  // host/ 下的图是 case 目录里的，python 那边（evidence_cli.py 的 renders）报的也是
  // case 相对路径，所以先按 caseRoot 解。但模型有时会给工作区相对路径
  // （datasets/<名字>/host/...），那条也得认，所以两个基准都试。
  // 不是吞错：两边都不存在就抛，而且把试过的两条路径都写出来，比裸 ENOENT 好查。
  const path = resolveImagePath(ctx, requested);
  const stat = statSync(path);
  if (!stat.isFile()) throw new Error(`不是图片文件: ${requested}`);
  if (stat.size > MAX_IMAGE_BYTES) {
    throw new Error(`图片 ${requested} 有 ${stat.size}B，超过 ${MAX_IMAGE_BYTES}B 上限，请先缩小后再看`);
  }

  const mime = MIME[extname(path).toLowerCase()];
  if (!mime) {
    throw new Error(`view_image 只支持 ${Object.keys(MIME).join(", ")}，收到 ${requested}`);
  }

  // 报给模型的相对路径也用 case 基准，跟 evidence_cli.py 说的是同一套坐标。
  // 以前用工作区基准，模型把它原样传回来就少了 datasets/<名字> 那一层。
  // 基准要先 realpath：path 是 realpath 过的，base 不过的话，只要路上有一个符号
  // 链接（macOS 的 /tmp -> /private/tmp 就是）算出来的就是一串 ../../..。
  const relBase = existsSync(ctx.caseRoot) ? realpathSync(ctx.caseRoot) : ctx.caseRoot;
  const rel = relative(relBase, path) || requested;
  const asked = String(args.question ?? "").trim();
  // 图上挂着待处理的感知请求时，用它记下的那句问题。这不是替 agent 改写意图：
  // 那句问题就是流水线要答的那一问，gate 也是按它校验回执的。agent 想问别的，
  // 等这一问答完再单独问一次即可。
  const pending = pendingQuestionsFor(ctx.caseRoot, path);
  const adopted = pending.length && !pending.includes(asked) ? pending[0]! : "";
  const question = adopted || asked || "请忠实描述图中可见的结构、异常和不确定之处。";
  const data = readFileSync(path).toString("base64");

  return {
    path,
    rel,
    size: stat.size,
    question,
    /** 用了 pending 里的问题而不是调用方给的，输出里要说清楚。 */
    adopted,
    pendingCount: pending.length,
    message: {
      role: "user",
      content: [
        {
          type: "text",
          text: `问题：${question}\n只报告图中实际可见的结构、差异和不确定性。不要根据文件名猜类别。`,
        },
        { type: "image_url", image_url: { url: `data:${mime};base64,${data}`, detail: "high" } },
      ],
    },
  };
}

const VISION_SYSTEM =
  "You are the visual perception sidecar for a scientific agent. Inspect the actual pixels. " +
  "Return a compact factual observation, distinguish observation from uncertainty, and do not propose a paper or analysis.";

/** 一次视觉调用，给多大的输出上限由调用方定。 */
async function askVision(config: VisionConfig, message: unknown, maxTokens: number) {
  return clientFor(config, maxTokens).streamTurn(
    [{ role: "system", content: VISION_SYSTEM }, message as never],
    [],
  );
}

/** 空正文的报错要把能诊断的都带上：是预算被推理吃光（length）还是服务端空回（stop）。 */
export function emptyObservationError(model: string, tries: Array<{ cap: number; finishReason: string | null; completion: number }>): Error {
  const detail = tries
    .map((t) => `cap=${t.cap} finish_reason=${t.finishReason ?? "?"} 输出 ${t.completion} token`)
    .join("；再试 ");
  const hint = tries.some((t) => t.finishReason === "length")
    ? "finish_reason=length 说明输出上限被推理吃光了，调大 OMNISCI_VISION_MAX_TOKENS。"
    : "上限没用完却是空的，是服务端返回了空回复，多半是瞬时故障，稍后重试。";
  return new Error(`视觉模型 ${model} 没有返回观察文本（${detail}）。${hint}`);
}

export async function viewImage(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const request = buildImageRequest(args, ctx);
  const config = visionConfig();
  const cap = visionMaxTokens();
  let turn = await askVision(config, request.message, cap);
  let observation = turn.message.content?.trim();
  const tries = [{ cap, finishReason: turn.finishReason, completion: turn.usage.completionTokens }];
  if (!observation) {
    // 空正文不看是哪家模型，一律换更大的预算再试一次：推理模型是预算被吃光，
    // 服务端偶发空回也靶不过重试。第一次的钱照样计入 usage，账要老实。
    const bigger = Math.max(cap * 3, 24_000);
    turn = await askVision(config, request.message, bigger);
    observation = turn.message.content?.trim();
    tries.push({ cap: bigger, finishReason: turn.finishReason, completion: turn.usage.completionTokens });
  }
  if (!observation) throw emptyObservationError(config.model, tries);
  if (turn.message.tool_calls?.length) throw new Error(`视觉模型 ${config.model} 意外返回了 tool call`);
  const receipt = recordPerceptionReceipt(
    // host/calls 在 case 目录下。用 ctx.root 的话，工作区里放了多个数据集时
    // callsDir 根本不存在，回执永远绑不上（matched=0），而且是静默的。
    ctx.caseRoot,
    request.path,
    request.question,
    observation,
    config.provider,
    config.model,
  );
  return {
    text:
      `OmniSci-Vision-Receipt: ${receipt.receiptId}\n` +
      `${VISION_META_PREFIX}${JSON.stringify(receipt.receipt)}\n` +
      `视觉侧车 ${config.provider}:${config.model} 对 ${request.rel}（${request.size}B）的像素观察：\n${observation}` +
      // 绑定结果必须每次都说，包括没绑上。之前只在绑上时才提一句，绑不上是静默的，
      // agent 只能自己猜，实测会把整轮预算烧在查这件事上。
      bindingNote(request, receipt.matched),
    meta: { provider: config.provider, model: config.model, usage: turn.usage },
  };
}

/** 每次都如实交代回执绑上了没有，绑不上就说清楚下一步该怎么做。 */
function bindingNote(
  request: { adopted: string; pendingCount: number },
  matched: number,
): string {
  if (matched) {
    return `\n已绑定 ${matched} 个待处理证据请求。`
      + (request.adopted ? `（用的是该请求记录的问题：${request.adopted}）` : "");
  }
  if (request.pendingCount) {
    return "\n注意：这张图有待处理的感知请求，但回执没能绑上去。"
      + "多半是问题对不上，用 evidence_cli.py 列出的原问题再调一次。";
  }
  return "\n这张图没有待处理的感知请求，回执只记在本次输出里。";
}

export const VISION_TOOLS: Tool[] = [
  {
    name: "view_image",
    description:
      "真正查看工作区内的 PNG/JPEG/WebP/GIF。DeepSeek 官方接口只收文本，因此像素由固定视觉侧车读取，观察结果回给 DeepSeek。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "工作区内的相对图片路径" },
        question: { type: "string", description: "希望从图中核实的具体问题" },
      },
      required: ["path"],
    },
    summarize: (args) => `查看 ${String(args.path ?? "")}`,
    run: viewImage,
  },
];
