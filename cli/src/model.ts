/**
 * 模型层：OpenAI 兼容的流式 tool-calling 客户端。
 *
 * 只做一件事：把 messages + tools 发出去，把流式返回累积成一条完整的 assistant 消息。
 * 各家的怪癖集中在 quirks() 里，不散落到别处。
 *
 * 铁律：不写吞错的 fallback。非法返回、协议错误、网络错误一律原样抛出去当场崩，
 * 不静默重试、不降级到「看起来正常」。
 */

import OpenAI from "openai";

import { credentialFor } from "./credentials.ts";

/**
 * 提示缓存实测对照（同一段 4000+ token 前缀连发四次）：
 *
 *   通道                        缓存命中   延迟        备注
 *   DeepSeek 官方               99%       1.1-1.5s    自动磁盘缓存，给 prompt_cache_hit_tokens
 *   OpenAI 兼容代理 / OpenAI 系  97%       1.1-1.5s    自动
 *   OpenAI 兼容代理 / OpenRouter 0%        3.3-5.0s    完全不缓存，还慢三倍
 *   OpenAI 兼容代理 / Claude 系  0%        1.2-2.5s    cache_control 透传不过去，加了也没用
 *
 * 结论：走代理转发 Claude 的话，缓存是拿不到的，长前缀任务要么直连要么认了这个成本。
 */
export const PROVIDERS = {
  deepseek: {
    baseURL: "https://api.deepseek.com/v1",
    keyEnvs: ["DEEPSEEK_API", "DEEPSEEK_API_KEY"],
    // 默认 flash，单价低。代价是同一个多轮任务比 pro 多绕三轮、
    // 多烧 2.6 倍 prompt token。要少绕路就 -m deepseek-v4-pro。
    defaultModel: "deepseek-v4-flash",
  },
  // 任何 OpenAI 兼容端点：自建 vLLM、公司网关、OpenRouter 之类。
  // 用 OMNISCI_BASE_URL 指地址，OMNISCI_MODEL 指默认模型。
  custom: {
    baseURL: process.env.OMNISCI_BASE_URL || "",
    keyEnvs: ["OMNISCI_API_KEY"],
    defaultModel: process.env.OMNISCI_MODEL || "",
  },
  anthropic: {
    baseURL: "https://api.anthropic.com/v1/",
    keyEnvs: ["ANTHROPIC_API_KEY"],
    defaultModel: "claude-sonnet-5",
  },
  openai: {
    baseURL: "https://api.openai.com/v1",
    keyEnvs: ["OPENAI_API_KEY"],
    // luna 是 5.6 里最便宜的一档（$0.20/$1.20），并且收图。terra 和 sol 同样收图但
    // 分别是 $2/$12 和 $5/$30，比 sonnet-5 还贵，所以默认不给它们。
    defaultModel: "gpt-5.6-luna",
  },
} as const;

export type ProviderName = keyof typeof PROVIDERS;
export const DEFAULT_PROVIDER: ProviderName = "deepseek";

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  cost: number;
}

export const emptyUsage = (): Usage => ({
  promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0,
});

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface AssistantMessage {
  role: "assistant";
  content: string | null;
  tool_calls?: ToolCall[];
}

export interface Turn {
  message: AssistantMessage;
  finishReason: string | null;
  usage: Usage;
  /**
   * 这一轮有 tool_call 因为撞上输出上限、参数只剩半截而被丢掉。
   *
   * 跟「正文写到一半被截断」是两回事，要分开告诉模型：正文那种可以接着写，
   * 而 tool_call 的参数是整个丢掉的，没有「上次」可接，只能重来一次。
   * 而重来必然还是那么长、还是会被截 —— 除非改成分几次写。
   */
  truncatedToolCall?: boolean;
}

/** 各家的已知怪癖。每一条都必须是实测得来的，不许凭印象加。 */
export function quirks(
  provider: ProviderName,
  model: string,
  hasTools: boolean,
  effort?: string,
): Record<string, unknown> {
  const extra: Record<string, unknown> = {};

  // OpenAI->Anthropic 转换型代理在并行 tool_calls 上会丢 tool_use id，
  // 下一轮回传 tool_result 直接 400。关掉并行即可，实测 sonnet-4-5 /
  // sonnet-4-6 / opus-4-5 三个模型全部由崩溃转为一次跑通。
  // DeepSeek 官方通道没这个问题，别顺手一起关，那会白丢并行的速度。
  if (provider === "custom" && model.includes("claude")) {
    extra.parallel_tool_calls = false;
  }

  // gpt-5.6 在 /v1/chat/completions 上不许「function tools + 推理」并存：
  //   400 Function tools with reasoning_effort are not supported for gpt-5.6-luna
  //       in /v1/chat/completions. To use function tools, use /v1/responses or
  //       set reasoning_effort to 'none'.
  // 它默认就带推理，所以带 tools 的请求不显式关掉必崩。实测 2026-08-15：
  // 'none' 通过并正常回 tool_calls，'low' 仍然 400。
  //
  // 只在带 tools 时关。视觉侧车不带 tools，保留推理，看图更准。
  if (hasTools && /^gpt-5\.6/.test(model)) {
    extra.reasoning_effort = "none";
  } else if (effort && supportsEffort(model)) {
    extra.reasoning_effort = effort;
  }
  return extra;
}

/**
 * 只有 OpenAI 的推理模型收 reasoning_effort。给 Anthropic 的 OpenAI 兼容端点
 * 或 DeepSeek 塞这个字段会 400，所以按模型名判，别按"用户填了就发"。
 */
export function supportsEffort(model: string): boolean {
  return /^(gpt-5|o[1-9]([-.]|$))/.test(model);
}

/**
 * gpt-5.6 认这几档（2026-08-16 实测枚举，错的值 API 会把合法列表回给你）。
 * 没有 max：想要最强思考就是 xhigh。
 */
export const EFFORT_LEVELS = ["none", "low", "medium", "high", "xhigh"] as const;
export type Effort = (typeof EFFORT_LEVELS)[number];

/**
 * 收这个字段的模型，默认给中档。
 *
 * 不显式给的话用的是模型自带的默认，那一档实测很浅（同一张三分量波形，
 * 只花 0 个推理 token）。medium 是"明显在想但不至于等半天"的位置：
 * 实测 none 2.4s / medium 约 4s / high 5.7s / xhigh 14.3s。
 */
export const DEFAULT_EFFORT: Effort = "medium";

/**
 * 输出上限该用哪个字段名。
 *
 * OpenAI 的 gpt-5.x / o 系列在 chat.completions 上直接拒收 max_tokens：
 *   400 Unsupported parameter: 'max_tokens' is not supported with this model.
 *       Use 'max_completion_tokens' instead.
 * 别家（DeepSeek、Anthropic 的 OpenAI 兼容端点、自建 vLLM）只认 max_tokens。
 *
 * 按模型名判而不是按通道判：中转网关上挂的 gpt-5.x 最终也是转给 OpenAI，
 * 一样收不了 max_tokens。实测 2026-08-15，gpt-5.6-luna 两种字段各打一发。
 */
/**
 * 这段 arguments 拿去用会不会炸。
 *
 * 空串算能用：无参工具的 arguments 本来就是空的，loop.ts 的 runOne 也是这么判的
 * （`rawArgs.trim() ? JSON.parse(rawArgs) : {}`），两处口径必须一致。
 */
export function usableArguments(raw: string): boolean {
  if (!raw.trim()) return true;
  try {
    JSON.parse(raw);
    return true;
  } catch {
    return false;
  }
}

/**
 * 各家模型吐工具调用时的原始标记，以及它对应的解析规则名。
 *
 * 每个模型家族在训练时就固定了自己那套写法，所以规则不是随便选的，是被模型定死的。
 * 推理服务（sglang / vLLM）用 --tool-call-parser 指定用哪套去解析，选错等于没解析。
 *
 * 这张表的用处见 unparsedToolCallHint()：解析没生效时这些标记会原样出现在正文里，
 * 看见哪一个就能直接反推该配哪个规则，不用去猜模型名。
 */
const TOOL_CALL_MARKS: Array<{ mark: RegExp; shown: string; parser: string }> = [
  // Qwen3.5 / Qwen3-Coder / GLM-4.5 这一系用 XML 标签
  { mark: /<function\s*=/, shown: "<function=…>", parser: "qwen3_coder" },
  // Qwen2.5 / Hermes 这一系在 <tool_call> 里放 JSON
  { mark: /<tool_call>\s*\{/, shown: '<tool_call>{"name":…}', parser: "qwen25（或 hermes）" },
  { mark: /\[TOOL_CALLS\]/, shown: "[TOOL_CALLS]", parser: "mistral" },
  { mark: /<\|python_tag\|>/, shown: "<|python_tag|>", parser: "llama3" },
  { mark: /<｜tool▁calls▁begin｜>/, shown: "<｜tool▁calls▁begin｜>", parser: "deepseekv3" },
  { mark: /<\|tool_call_start\|>/, shown: "<|tool_call_start|>", parser: "lfm2" },
];

/**
 * 正文里有没有"没被解析的工具调用"的痕迹，有的话该配哪个规则。
 *
 * 症状是这样的：推理服务没开 tool-call 解析、或者规则选错了，模型明明在调工具，
 * 服务端却把 `<tool_call><function=…>` 整段当普通文本原样返回。于是我们收到一条
 * 有正文、没有 tool_calls 的消息，agent 以为模型在闲聊，一轮轮空转到超时，
 * 用户完全看不出发生了什么，只觉得"这软件用不了"。
 *
 * 2026-08-26 我自己在 Qwen3.5 上踩过：想当然配了 qwen25（Qwen2.5 那套 JSON 写法），
 * 而 Qwen3.5 吐的是 XML 标签，实测解析出 0 个。查到 Qwen 官方 issue 才搞明白要用
 * qwen3_coder。我尚且要查 issue，普通用户撞上只会放弃。
 *
 * 返回 null 表示看不出痕迹，那就是模型真的在说话，不要报错。
 */
export function unparsedToolCallHint(text: string): { shown: string; parser: string } | null {
  for (const { mark, shown, parser } of TOOL_CALL_MARKS) {
    if (mark.test(text)) return { shown, parser };
  }
  return null;
}

/** 重试时至少也要给模型这么多输出预算，比这还少不如直接报错。 */
const MIN_USABLE_CAP = 512;
/** 从服务端算出来的余量里再让出这些，挡住 token 计数的零头差异。 */
const CAP_SAFETY_MARGIN = 64;

/**
 * 从「输出上限要得太多」这类 400 里，解析出服务端实际能给的额度。
 *
 * 我们默认要 8000 输出。OpenAI 和 DeepSeek 不计较，vLLM 会**严格**校验
 * `max_tokens <= 上下文 - 输入`，超一个 token 都直接 400：
 *
 *   'max_tokens' or 'max_completion_tokens' is too large: 8000. This model's maximum
 *   context length is 32768 tokens and your request has 25201 input tokens
 *   (8000 > 32768 - 25201)
 *
 * 自建部署为了省显存普遍把 --max-model-len 开得小，对话一长必撞，而症状是
 * 一句用户看不懂的 400（2026-08-26 在真 vLLM 上实测撞到）。
 *
 * 不去猜输入有多少 token：服务端已经把上下文和输入两个准数写在消息里了，
 * 照它给的算，比我们自己按字符数估准得多。解析不出来就返回 null，让错误
 * 原样抛出去，绝不吞。
 */
export function tokenCapFromError(message: string): number | null {
  // vLLM 那句括号里的算式最直接：(要的 > 上下文 - 输入)
  const arith = /\(\s*\d+\s*>\s*(\d+)\s*-\s*(\d+)\s*\)/.exec(message);
  if (arith) return usableCap(Number(arith[1]) - Number(arith[2]));

  // 换个说法的实现：把两个数分开写在句子里
  const ctx = /(?:maximum context length is|context length of)\s*(\d+)/i.exec(message);
  const used = /(?:request has|prompt is|input has)\s*(\d+)\s*(?:input\s*)?tokens/i.exec(message);
  if (ctx && used) return usableCap(Number(ctx[1]) - Number(used[1]));

  return null;
}

function usableCap(room: number): number | null {
  const cap = room - CAP_SAFETY_MARGIN;
  return Number.isFinite(cap) && cap >= MIN_USABLE_CAP ? cap : null;
}

/** 这个错误是不是在说「输出上限要多了」。 */
function isTokenCapError(error: unknown): boolean {
  const status = (error as { status?: number } | null)?.status;
  const msg = (error as { message?: string } | null)?.message ?? "";
  return status === 400 && /max_tokens|max_completion_tokens/.test(msg) && /too large|exceed/i.test(msg);
}

/**
 * 这个错误是不是在说「光输入就已经超过窗口了」。
 *
 * 跟上面那个是两回事，措辞里根本没有 max_tokens：
 *   This model's maximum context length is 40960 tokens. However, your request
 *   has 73043 input tokens. Please reduce the length of the input messages.
 * 到这一步已经没有任何余量可协商，只能告诉用户怎么办。2026-08-26 实测撞到。
 */
/**
 * 光输入就撑破了窗口。
 *
 * 单独立一个类型，是因为**它是可以抢救的**：调用方手里有完整的 messages，压一轮
 * 再发就行，不必把整场跑了半小时的研究直接判死。model.ts 自己做不了这件事
 * （压缩要反过来调模型），所以只负责认出来并往上抛。
 * 带上 limit，让上层知道真实窗口是多少，好决定压到什么程度。
 */
/** 会把思考过程写进正文的那几种标签。 */
const REASONING_TAGS = ["think", "thinking", "reasoning"];

/**
 * 剥掉推理块，只留结论。
 *
 * 本地推理模型（Qwen3、DeepSeek-R1 一系）会把思考过程原样写进 content：
 *   <think>...一大段...</think>真正的回答
 * vLLM 要加了 --reasoning-parser 才会把它拆到单独的 reasoning_content 字段去，
 * 而自建部署十有八九没加。
 *
 * 这些内容**不该留在历史里**：它们只对产生当轮回答有用，下一轮再发回去纯属白占
 * 窗口，而思考往往比回答本身长得多。2026-08-26 在 40960 的窗口上实测，这是
 * 压缩之外最大的一笔浪费。
 *
 * 流式显示不受影响：那走的是 textDelta，用户照样实时看得见模型在想什么。
 * 剥的只是存进消息历史的那一份。
 *
 * 未闭合的标签只在**开头**剥。开头未闭合是输出被截断，后面整段都是思考；
 * 而出现在中间的未闭合标签更可能是正文在讨论这个标签本身，剥了就是丢正文。
 */
export function stripReasoning(text: string): string {
  let out = text;
  for (const tag of REASONING_TAGS) {
    out = out.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}>`, "gi"), "");
  }
  const head = out.trimStart();
  for (const tag of REASONING_TAGS) {
    if (new RegExp(`^<${tag}\\b[^>]*>`, "i").test(head)) return "";
  }
  return out.trim();
}

/**
 * 参数坏掉时塞进 arguments 的键。工具层看见它就知道这次调用根本没成形，
 * 该做的是把原因告诉模型，而不是拿着空参数去跑。
 */
export const MALFORMED_KEY = "__omnisci_malformed_arguments__";

/**
 * 说清楚 JSON 坏在哪，好让模型能自己改对。
 *
 * 三件事都要有：解析器的原话（定位）、原文开头（模型能认出是自己写的哪一段）、
 * 以及最常见的那个原因。光说「不是合法 JSON」等于没说，模型多半原样再写一遍。
 *
 * 原文只截前 300 字符：够认出是哪次调用了，全贴上来反而把窗口填满 ——
 * 而参数写坏的时候，那段内容往往正是一整个源文件。
 */
function describeBadJson(raw: string): string {
  let reason = "未知";
  try {
    JSON.parse(raw);
  } catch (e) {
    reason = e instanceof Error ? e.message : String(e);
  }
  const head = raw.slice(0, 300);
  return `你这次调用的 arguments 不是合法 JSON，所以工具没有执行。\n`
    + `解析器说：${reason}\n`
    + `你发出来的原文开头是：${head}${raw.length > 300 ? " …（后面省略）" : ""}\n`
    + `最常见的原因是字符串里的换行、双引号、反斜杠没有转义 —— 写代码文件时尤其容易踩。`
    + `换行要写成 \\n，双引号要写成 \\"，反斜杠要写成两个。请重新发一次这次调用。`;
}

export class ContextOverflowError extends Error {
  constructor(message: string, readonly limit: number) {
    super(message);
    this.name = "ContextOverflowError";
  }
}

export function overlongInputFrom(message: string): { limit: number; used: number } | null {
  const m = /maximum context length is (\d+) tokens.{0,40}?request has (\d+) input tokens/is.exec(message);
  if (!m) return null;
  return { limit: Number(m[1]), used: Number(m[2]) };
}

export function tokenCapField(model: string, cap: number, effort?: string): Record<string, number> {
  if (!/^(gpt-5|o[1-9]([-.]|$))/.test(model)) return { max_tokens: cap };
  // 推理 token 也从这个预算里扣，而且先扣。不留余量的话，档位一开高，
  // 预算全被推理吃掉，正文返回空串——实测 gpt-5.6-luna 在 effort=xhigh、
  // cap=1200 时正文为空，视觉侧车当场报"没有返回观察文本"。
  const thinking = Boolean(effort) && effort !== "none";
  return { max_completion_tokens: thinking ? cap + REASONING_HEADROOM : cap };
}

/** 开了推理之后额外留给正文的预算。 */
export const REASONING_HEADROOM = 6000;

function readUsage(raw: unknown): Usage {
  const u = raw as Record<string, unknown> | null | undefined;
  if (!u) return emptyUsage();
  const details = u.prompt_tokens_details as Record<string, unknown> | undefined;
  // DeepSeek 官方额外给一个更权威的字段，两者实测一致，取大的
  const cached = Math.max(
    Number(details?.cached_tokens ?? 0) || 0,
    Number(u.prompt_cache_hit_tokens ?? 0) || 0,
  );
  return {
    promptTokens: Number(u.prompt_tokens ?? 0) || 0,
    completionTokens: Number(u.completion_tokens ?? 0) || 0,
    cachedTokens: cached,
    // OpenRouter 通道会带真实计费金额，有就用，不用自己估
    cost: Number(u.cost ?? 0) || 0,
  };
}

/**
 * 查余额。只有 DeepSeek 官方给这个接口（GET /user/balance，注意不带 /v1）。
 * 别家没有对应端点，返回 null，调用方自己决定怎么显示。
 * 查不到就是查不到，不编一个数字出来。
 */
export async function fetchBalance(provider: ProviderName): Promise<string | null> {
  if (provider !== "deepseek") return null;
  const key = credentialFor("deepseek");
  if (!key) return null;

  try {
    const res = await fetch("https://api.deepseek.com/user/balance", {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;

    const data = (await res.json()) as {
      is_available?: boolean;
      balance_infos?: Array<{ currency?: string; total_balance?: string }>;
    };
    const info = data.balance_infos?.[0];
    if (!info?.total_balance) return null;
    const symbol = info.currency === "CNY" ? "¥" : `${info.currency} `;
    return `${symbol}${info.total_balance}${data.is_available === false ? "（余额不足）" : ""}`;
  } catch {
    // Balance is advisory. DNS, timeout, and malformed-response failures must not block research startup.
    return null;
  }
}

export interface ModelClientOptions {
  provider?: ProviderName;
  model?: string;
  apiKey?: string;
  /** 覆盖通道的默认地址。桌面版要让用户在界面上改自定义端点，
   *  而 PROVIDERS.custom.baseURL 是模块加载时从环境变量读死的。 */
  baseURL?: string;
  maxTokens?: number;
  /** 推理档位，只对 OpenAI 推理模型有效，见 EFFORT_LEVELS。 */
  effort?: string;
}

export class ModelClient {
  /** 只由构造函数和 reconfigure() 写，外面当只读的看。 */
  provider!: ProviderName;
  model!: string;
  private client!: OpenAI;
  private maxTokens!: number;
  private effort?: string;

  constructor(opts: ModelClientOptions = {}) {
    this.apply(opts);
  }

  /**
   * 原地换掉通道、模型和凭据，整份配置照 opts 重来一遍（没给的字段回到默认，
   * 跟 new 一个是一样的语义）。
   *
   * 为什么不能 new 一个新的顶上：会话建起来的那一刻，这个 client 的引用已经被
   * registry 里的 explore 工具和 AgentLoop 各存了一份。换掉外面那个变量，那些
   * 副本还攥着旧的，于是主循环用新 key、探索工具用旧 key。原地改是唯一一次能
   * 改全的做法。
   */
  reconfigure(opts: ModelClientOptions): void {
    this.apply(opts);
  }

  private apply(opts: ModelClientOptions): void {
    const provider = opts.provider ?? DEFAULT_PROVIDER;
    const conf = PROVIDERS[provider];
    if (!conf) throw new Error(`不认识的通道 ${provider}，可选: ${Object.keys(PROVIDERS).join(", ")}`);

    const key = opts.apiKey ?? credentialFor(provider);
    if (!key) {
      throw new Error(
        `通道 ${provider} 没有 API key。设置 ${conf.keyEnvs.join(" 或 ")}，也可以写进 ~/.omnisci/env。`,
      );
    }

    this.provider = provider;
    this.model = opts.model ?? conf.defaultModel;
    this.maxTokens = opts.maxTokens ?? 8000;
    this.effort = opts.effort;
    // maxRetries: 0，网络层的静默重试也是一种吞错，出问题要立刻看见
    this.client = new OpenAI({
      baseURL: opts.baseURL || conf.baseURL,
      apiKey: key,
      timeout: 180_000,
      maxRetries: 0,
    });
  }

  /** 跑一轮，流式。onText 每收到一段正文就回调一次，供 UI 实时反馈。 */
  /**
   * 问服务端这个模型的窗口有多大，问不到返回 null。
   *
   * vLLM 和 sglang 的 /v1/models 会在每个条目里给 max_model_len，OpenAI 不给。
   * 上下文压缩的触发线要按这个数算：默认那个 384k 是照 DeepSeek 量的，套在
   * --max-model-len 开成 64k 的自建部署上，压缩永远不触发，历史一路涨到撑爆
   * （2026-08-26 实测撞到 65513/65536）。
   *
   * 只在启动时问一次，失败不影响任何事：退回默认值，最多是压缩晚一点。
   */
  /**
   * 窗口大的部署上把输出预算放开一些。
   *
   * 8000 这个默认值是照 DeepSeek 来的（它的 max_tokens 硬上限就是 8192）。
   * 换到 --max-model-len=131072 的自建部署上，这个数小得毫无道理，而且会真的挡住
   * 活：写一整篇论文的 tex 是**一次** write_file 调用，参数装不下就整个被截断丢弃，
   * 模型原样重写还是超，来回耗光轮次（2026-08-26 实测撞到）。
   *
   * 只放开到窗口的八分之一，且不超过 32k：输出预算是从输入那边借来的，
   * 借太多会让长对话提前撞窗口，得不偿失。
   * 服务端要是不接受这个数，usableCap 那条重试路会自动往下砍，所以往大了给是安全的。
   */
  raiseOutputBudgetFor(window: number): void {
    if (!Number.isFinite(window) || window <= 0) return;
    const target = Math.min(32_000, Math.floor(window / 8));
    if (target > this.maxTokens) this.maxTokens = target;
  }

  async discoverContextWindow(): Promise<number | null> {
    try {
      const list = await this.client.models.list();
      for (const m of list.data ?? []) {
        if (m.id !== this.model) continue;
        const len = (m as unknown as { max_model_len?: number }).max_model_len;
        if (typeof len === "number" && len > 0) return len;
      }
    } catch {
      // 问不到就问不到：这只是让压缩早点触发的优化，不是必需品。
    }
    return null;
  }

  async streamTurn(
    messages: unknown[],
    tools: unknown[],
    onText?: (chunk: string) => void,
    signal?: AbortSignal,
  ): Promise<Turn> {
    const send = (cap: number) => this.client.chat.completions.create({
      model: this.model,
      messages: messages as never,
      ...(tools.length ? { tools: tools as never } : {}),
      stream: true,
      stream_options: { include_usage: true },
      ...tokenCapField(this.model, cap, this.effort),
      ...quirks(this.provider, this.model, tools.length > 0, this.effort),
    } as never, signal ? { signal } : undefined);

    let stream;
    try {
      stream = await send(this.maxTokens);
    } catch (error) {
      // 上下文不够放下我们要的输出预算时，服务端会把上下文和输入两个准数一起告诉我们。
      // 照它给的重来一次，只重一次；解析不出来就原样抛，不吞。见 tokenCapFromError。
      const capError = isTokenCapError(error);
      const message = (error as { message?: string }).message ?? "";
      const room = capError ? tokenCapFromError(message) : null;
      if (room === null) {
        // 是这个错、却算不出可用余量，只有一种情况：历史已经把上下文占满了
        // （2026-08-26 实测撞到 65513/65536，只剩 23 个 token）。原样抛出去的话
        // 用户看到的是一句 400 加一串数字，完全不知道该干什么，所以在这儿翻译一次。
        // 光输入就超窗口：连协商的余地都没有了
        const over = overlongInputFrom(message);
        if (over) {
          throw new ContextOverflowError(
            `输入已经超过模型窗口：${over.used} tokens，上限 ${over.limit}，超了 ` +
            `${over.used - over.limit}。对话历史涨得比压缩能压掉的还快。\n` +
            `  三条路：把服务端的 --max-model-len 开大、换上下文更大的模型、` +
            `或者开一个新会话重头来。\n  原始报错：${message}`,
            over.limit,
          );
        }
        const seen = /context length is (\d+) tokens and your request has (\d+)/.exec(message);
        if (capError && seen) {
          throw new Error(
            `对话历史已经占满模型的上下文：输入 ${seen[2]} tokens，上限 ${seen[1]}，` +
            `只剩 ${Number(seen[1]) - Number(seen[2])} 个 token，没有空间再生成回复了。\n` +
            `  三条路：把服务端的 --max-model-len 开大（这个模型往往支持得比现在配的多）、` +
            `换上下文更大的模型、或者开一个新会话重头来。\n` +
            `  原始报错：${message}`,
          );
        }
        throw error;
      }
      console.error(
        `[omnisci] 服务端放不下 ${this.maxTokens} 的输出预算（上下文被输入占掉了大半），` +
        `这一轮改用 ${room} 重试。对话越长这个数越小，短了就该开大服务端的 --max-model-len。`,
      );
      stream = await send(room);
    }

    const parts: string[] = [];
    const acc = new Map<number, { id: string; name: string; args: string }>();
    let usage = emptyUsage();
    let finishReason: string | null = null;

    // 因为 quirks() 是展开进去的，TS 没法静态确定走的是 stream 重载，
    // 这里明确断言。stream: true 是上面写死的，不是运行时才知道的。
    const chunks = stream as unknown as AsyncIterable<Record<string, unknown>>;

    for await (const chunk of chunks) {
      if (chunk.usage) {
        const u = readUsage(chunk.usage);
        usage = {
          promptTokens: usage.promptTokens + u.promptTokens,
          completionTokens: usage.completionTokens + u.completionTokens,
          cachedTokens: usage.cachedTokens + u.cachedTokens,
          cost: usage.cost + u.cost,
        };
      }
      const choices = chunk.choices as Array<Record<string, unknown>> | undefined;
      const choice = choices?.[0];
      if (!choice) continue;
      if (choice.finish_reason) finishReason = String(choice.finish_reason);

      const delta = choice.delta as Record<string, unknown> | undefined;
      if (!delta) continue;
      if (typeof delta.content === "string" && delta.content) {
        parts.push(delta.content);
        onText?.(delta.content);
      }
      for (const tc of (delta.tool_calls ?? []) as Array<Record<string, unknown>>) {
        const idx = Number(tc.index ?? 0);
        const slot = acc.get(idx) ?? { id: "", name: "", args: "" };
        if (tc.id) slot.id = String(tc.id);
        const fn = tc.function as Record<string, unknown> | undefined;
        if (fn?.name) slot.name += String(fn.name);
        if (fn?.arguments) slot.args += String(fn.arguments);
        acc.set(idx, slot);
      }
    }

    let truncatedToolCall = false;
    const raw = parts.join("");
    const visible = stripReasoning(raw);
    // 剥完什么都不剩、又没有工具调用，那就把原文留着：这一轮唯一的产出就是它，
    // 再删这一轮就完全空白，循环会误以为该收尾了。
    const message: AssistantMessage = {
      role: "assistant",
      content: (visible || (acc.size ? "" : raw)) || null,
    };
    if (acc.size) {
      const sorted = [...acc.entries()].sort(([a], [b]) => a - b);

      // **不合法的 arguments 一个都不能留在消息历史里。**
      //
      // 下一轮整份历史会原样发回上游，而很多服务端**必须** json.loads 这个字段：
      // vLLM / sglang 套 chat template 时要把它当字典遍历（Qwen 的模板里就是
      // `tool_call.arguments|items`），OpenAI 转 Anthropic 的网关要转成
      // tool_use.input（那是对象不是字符串）。坏 JSON 一进去，整轮以一句服务端的
      // Python 报错收场，而且报的是**下一轮**，现场早就不在了：
      //   400 Unterminated string starting at: line 1 column 32 (char 31)   <- issue #5
      //   400 Expecting ':' delimiter: line 1 column 42 (char 41)
      // DeepSeek 官方通道透传不校验，所以这一族坑只在自建部署上现形。
      //
      // 坏的原因有两种，处置不同（2026-08-26 在真 vLLM 上两种都撞到过）：
      //
      //   被输出上限掐断（finishReason=length）：模型没说完，不是说错。丢掉整个
      //   调用，finishReason 保持不变，AgentLoop 会让它接着说完。
      //
      //   模型自己吐了坏 JSON：调用意图是真的，只是参数写坏了。留下调用、把参数
      //   洗成 {}，工具那边会因为缺必填参数而报错，模型照样能收到反馈自己改。
      //   丢掉整个调用反而更糟：它和它的 tool 回执必须成对，少一个是另一种 400。
      const entries: typeof sorted = [];
      for (const [idx, slot] of sorted) {
        if (usableArguments(slot.args)) { entries.push([idx, slot]); continue; }
        const who = `第 ${idx} 个 tool_call（${slot.name || "未命名"}）`;
        if (finishReason === "length") {
          console.error(`[omnisci] ${who}被输出上限截断，arguments 只有半截，已丢弃，让模型改成分几次写。`);
          truncatedToolCall = true;
          continue;
        }
        // 换成一个**合法**的 JSON，里面装着「坏在哪」。工具层认出这个键就直接把原因
        // 回给模型，不去执行。
        //
        // 以前这里换的是空的 {}，工具那边只会报「缺少 path」，模型看到的是一个跟真正
        // 原因毫无关系的错误，于是原样再写一遍、再坏一次。2026-08-26 实测：30B 模型
        // 写 python 分析脚本时 write_file 的 arguments 就坏在这上面（代码里的换行和
        // 引号没转义），而写脚本是产出论文的必经一步，卡在这儿整条链就断了。
        console.error(`[omnisci] ${who}的 arguments 不是合法 JSON，已经把原因回给模型让它重写。`);
        entries.push([idx, { ...slot, args: JSON.stringify({ [MALFORMED_KEY]: describeBadJson(slot.args) }) }]);
      }

      // 全被丢光时不要留一个空数组：空的 tool_calls 有的上游会拒收，而且
      // AgentLoop 判的是 calls.length，没有这个字段它自然走"接着说完"那条路。
      if (entries.length) message.tool_calls = entries
        .map(([idx, slot]) => {
          if (!slot.id) {
            // id 缺失说明流被截断或 provider 违反协议。不给它编一个假 id 蒙混过关，
            // 否则下一轮 tool_result 对不上，错误会以完全无关的形式出现在别处。
            throw new Error(
              `provider 返回的 tool_call 缺少 id（index=${idx}, name=${slot.name}）。` +
              `模型 ${this.model} 的流式 tool-calling 不合协议。`,
            );
          }
          return { id: slot.id, type: "function" as const,
                   function: { name: slot.name, arguments: slot.args } };
        });
    }

    // 发了工具、却一个 tool_call 都没解析出来，而正文里带着工具调用的原始标记：
    // 这不是模型不想调工具，是服务端根本没把它解析出来。当场说清楚，别让 agent
    // 对着一条"闲聊"消息空转到超时 —— 那种失败什么线索都不留。
    if (tools.length && !message.tool_calls && message.content) {
      const hint = unparsedToolCallHint(message.content);
      if (hint) {
        throw new Error(
          `服务端没有把模型的工具调用解析出来：正文里带着 ${hint.shown} 这样的原始标记，` +
          `而 tool_calls 是空的。这是推理服务的 tool-call 解析没开，或者规则选错了。\n` +
          `  sglang: 启动时加 --tool-call-parser ${hint.parser}\n` +
          `  vLLM:   启动时加 --enable-auto-tool-choice --tool-call-parser ${hint.parser}\n` +
          `规则由模型定死，不是随便选的：同是 Qwen，3.5 吐 XML 标签要 ${hint.parser}，` +
          `2.5 吐 JSON 要 qwen25，配错的表现就是解析出 0 个而服务端不报任何错。`,
        );
      }
    }

    return { message, finishReason, usage, truncatedToolCall };
  }
}
