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

export class ModelClient {
  readonly provider: ProviderName;
  readonly model: string;
  private client: OpenAI;
  private maxTokens: number;
  private effort?: string;

  constructor(opts: {
    provider?: ProviderName;
    model?: string;
    apiKey?: string;
    /** 覆盖通道的默认地址。桌面版要让用户在界面上改自定义端点，
     *  而 PROVIDERS.custom.baseURL 是模块加载时从环境变量读死的。 */
    baseURL?: string;
    maxTokens?: number;
    /** 推理档位，只对 OpenAI 推理模型有效，见 EFFORT_LEVELS。 */
    effort?: string;
  } = {}) {
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
  async streamTurn(
    messages: unknown[],
    tools: unknown[],
    onText?: (chunk: string) => void,
  ): Promise<Turn> {
    const stream = await this.client.chat.completions.create({
      model: this.model,
      messages: messages as never,
      ...(tools.length ? { tools: tools as never } : {}),
      stream: true,
      stream_options: { include_usage: true },
      ...tokenCapField(this.model, this.maxTokens, this.effort),
      ...quirks(this.provider, this.model, tools.length > 0, this.effort),
    } as never);

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

    const message: AssistantMessage = { role: "assistant", content: parts.join("") || null };
    if (acc.size) {
      message.tool_calls = [...acc.entries()]
        .sort(([a], [b]) => a - b)
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

    return { message, finishReason, usage };
  }
}
