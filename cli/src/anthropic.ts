/**
 * Claude 官方通道：Anthropic 原生 Messages API（/v1/messages）。
 *
 * 为什么 Claude 不跟别家一起走 OpenAI 兼容格式：Anthropic 的兼容端点不做提示缓存，
 * 官方文档原话 "Prompt caching is not supported"。2026-09-26 实测：同一段 15.6k token
 * 的前缀连发两次，兼容端点两次都按全价计 15628，加了 cache_control 也一样；原生端点
 * 第二次 cache_read=15623。agent 每一轮都把整段历史重发一遍，没有缓存就是每轮全价。
 *
 * 会话历史照旧统一存成 OpenAI 格式，只在发请求这一刻转成原生格式、收回来再交给
 * model.ts 按原来的规矩组装。循环、压缩、工具层、桌面版的会话存档一行都不用动。
 */

import Anthropic from "@anthropic-ai/sdk";

import type { Usage } from "./model.ts";

type Json = Record<string, unknown>;
type Block = Anthropic.ContentBlockParam;
type ImageMime = Anthropic.Base64ImageSource["media_type"];

/**
 * PROVIDERS.anthropic.baseURL 是给 OpenAI SDK 用的，带着 /v1/；原生 SDK 自己拼
 * /v1/messages，不去掉就会打到 /v1/v1/messages 上 404。
 */
export function nativeBaseURL(url: string): string {
  return url.trim().replace(/\/+$/, "").replace(/\/v1$/, "");
}

/** 空白文本块原生接口直接 400（text content blocks must contain non-whitespace text）。 */
function textBlock(text: string): Block[] {
  return text.trim() ? [{ type: "text", text }] : [];
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((p) => ((p as Json)?.type === "text" ? String((p as Json).text ?? "") : ""))
    .join("");
}

function imageBlock(part: Json): Anthropic.ImageBlockParam {
  const url = String((part.image_url as Json | undefined)?.url ?? "");
  const data = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  if (data) {
    return { type: "image", source: { type: "base64", media_type: data[1] as ImageMime, data: data[2]! } };
  }
  if (/^https?:\/\//.test(url)) return { type: "image", source: { type: "url", url } };
  throw new Error(`图片地址既不是 data: URI 也不是 http(s) 链接，发不出去：${url.slice(0, 80)}`);
}

/** user / tool 消息里的正文：字符串，或者 text 与 image_url 两种片段。 */
function partsToBlocks(content: unknown): Block[] {
  if (typeof content === "string") return textBlock(content);
  if (content == null) return [];
  if (!Array.isArray(content)) throw new Error(`消息内容既不是字符串也不是数组：${typeof content}`);
  const out: Block[] = [];
  for (const raw of content) {
    const part = raw as Json;
    if (part?.type === "text") out.push(...textBlock(String(part.text ?? "")));
    else if (part?.type === "image_url") out.push(imageBlock(part));
    else throw new Error(`不认识的消息片段类型 ${String(part?.type)}，没有对应的原生格式。`);
  }
  return out;
}

/**
 * tool_calls 里的 arguments 是 JSON 字符串，原生格式要对象。
 *
 * model.ts 保证进了历史的都是合法 JSON（坏的已经洗成带原因的合法 JSON），所以这里
 * 解析失败就是真出了 bug，原样抛出去，不拿一个空对象蒙混过关。
 */
function toolInput(raw: string): Json {
  if (!raw.trim()) return {};
  const value = JSON.parse(raw) as unknown;
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {};
}

export interface NativeRequest {
  system: string;
  messages: Anthropic.MessageParam[];
  tools: Anthropic.Tool[];
}

/**
 * OpenAI 格式的会话历史转成原生请求。
 *
 * 规则都是原生接口定死的：
 * - system 消息提到顶层 system（兼容端点自己也是这么做的，行为不变）。
 * - tool 消息变成 user 消息里的 tool_result；连着的几条并进同一条 user 消息，
 *   并行调用的回执必须放在一起，拆开会让模型学会不再并行。
 * - 同一角色连续出现就合并，保证 user / assistant 交替。
 * - 不回传 thinking 块。兼容端点本来就回传不了，这里保持原样：桌面版的上下文压缩
 *   是「摘要 + 保留最近几轮」，回传 thinking 的话，保留下来那几轮在 2026-08-31
 *   之后注册的账号上会被判成改过历史，直接 400。
 */
export function toNativeRequest(messages: unknown[], tools: unknown[]): NativeRequest {
  const system: string[] = [];
  const out: Anthropic.MessageParam[] = [];

  const push = (role: "user" | "assistant", blocks: Block[]) => {
    if (!blocks.length) return;
    const last = out[out.length - 1];
    if (last && last.role === role) (last.content as Block[]).push(...blocks);
    else out.push({ role, content: blocks });
  };

  for (const raw of messages) {
    const m = raw as Json;
    switch (m.role) {
      case "system":
      case "developer": {
        const text = textOf(m.content);
        if (text.trim()) system.push(text);
        break;
      }
      case "user":
        push("user", partsToBlocks(m.content));
        break;
      case "assistant": {
        const blocks: Block[] = textBlock(textOf(m.content));
        for (const call of (m.tool_calls ?? []) as Array<{ id: string; function: { name: string; arguments: string } }>) {
          blocks.push({ type: "tool_use", id: call.id, name: call.function.name, input: toolInput(call.function.arguments) });
        }
        push("assistant", blocks);
        break;
      }
      case "tool": {
        const content = partsToBlocks(m.content) as Array<Anthropic.TextBlockParam | Anthropic.ImageBlockParam>;
        push("user", [{
          type: "tool_result",
          tool_use_id: String(m.tool_call_id),
          ...(content.length ? { content } : {}),
        }]);
        break;
      }
      default:
        throw new Error(`不认识的消息角色 ${String(m.role)}，没有对应的原生格式。`);
    }
  }

  return {
    system: system.join("\n\n"),
    messages: out,
    tools: tools.map((raw) => {
      const tool = raw as Json;
      const fn = tool.function as Json | undefined;
      if (tool.type !== "function" || !fn?.name) {
        throw new Error(`工具定义不是 OpenAI 的 function 格式：${JSON.stringify(tool).slice(0, 120)}`);
      }
      return {
        name: String(fn.name),
        description: String(fn.description ?? ""),
        input_schema: { ...((fn.parameters ?? {}) as Json), type: "object" } as Anthropic.Tool.InputSchema,
        // 工具参数边生成边流回来。写整篇 tex 那种大参数不开的话，服务端要攒完才一次性吐。
        // 开了之后服务端不再校验参数 JSON，而 model.ts 本来就会自己验、坏了告诉模型。
        eager_input_streaming: true,
      };
    }),
  };
}

/** 原生的 stop_reason 翻成 OpenAI 的 finish_reason，AgentLoop 只认后者。 */
const FINISH: Record<string, string> = {
  end_turn: "stop",
  stop_sequence: "stop",
  tool_use: "tool_calls",
  max_tokens: "length",
  model_context_window_exceeded: "length",
};

export interface NativeTurn {
  parts: string[];
  acc: Map<number, { id: string; name: string; args: string }>;
  finishReason: string | null;
  usage: Usage;
}

export interface NativeOptions {
  model: string;
  maxTokens: number;
  /** 只给多轮的 agent 循环开。一次性的调用（看图、摘要）开了只会白付 1.25 倍的写入价。 */
  cache: boolean;
}

/**
 * 发一轮，流式收回来，交给 model.ts 组装。
 *
 * 缓存按官方给 agent 循环的推荐放：system 末尾一个显式断点（工具定义排在 system
 * 前面，一起被盖住），再加顶层自动缓存跟着对话尾巴往前走。每一轮读到的是上一轮
 * 为止的全部历史，只为新追加的那点付写入价。
 *
 * 用 create({stream: true}) 拿原始事件，不用 messages.stream()：后者会自己去解析
 * 工具参数，开了 eager_input_streaming 之后参数可能是半截或坏的，它一解析就抛，
 * 而 model.ts 需要的正是原始字符串，好把坏在哪告诉模型。
 */
export async function streamNative(
  client: Anthropic,
  opts: NativeOptions,
  messages: unknown[],
  tools: unknown[],
  onText?: (chunk: string) => void,
  signal?: AbortSignal,
): Promise<NativeTurn> {
  const req = toNativeRequest(messages, tools);
  const system = req.system
    ? opts.cache
      ? [{ type: "text" as const, text: req.system, cache_control: { type: "ephemeral" as const } }]
      : req.system
    : undefined;

  const stream = await client.messages.create({
    model: opts.model,
    max_tokens: opts.maxTokens,
    messages: req.messages,
    ...(system ? { system } : {}),
    ...(req.tools.length ? { tools: req.tools } : {}),
    ...(opts.cache ? { cache_control: { type: "ephemeral" as const } } : {}),
    stream: true,
  }, signal ? { signal } : undefined);

  const parts: string[] = [];
  const acc = new Map<number, { id: string; name: string; args: string }>();
  let stopReason: string | null = null;
  let input = 0;
  let cacheWrite = 0;
  let cacheRead = 0;
  let output = 0;

  for await (const event of stream) {
    switch (event.type) {
      case "message_start": {
        const u = event.message.usage;
        input = u.input_tokens ?? 0;
        cacheWrite = u.cache_creation_input_tokens ?? 0;
        cacheRead = u.cache_read_input_tokens ?? 0;
        output = u.output_tokens ?? 0;
        break;
      }
      case "content_block_start":
        if (event.content_block.type === "tool_use") {
          acc.set(event.index, { id: event.content_block.id, name: event.content_block.name, args: "" });
        }
        break;
      case "content_block_delta":
        if (event.delta.type === "text_delta") {
          parts.push(event.delta.text);
          onText?.(event.delta.text);
        } else if (event.delta.type === "input_json_delta") {
          const slot = acc.get(event.index);
          if (slot) slot.args += event.delta.partial_json;
        }
        break;
      case "message_delta": {
        stopReason = event.delta.stop_reason ?? stopReason;
        const u = event.usage;
        // message_delta 里的是累计值；输入那几项有时为 null，表示没变。
        output = u.output_tokens ?? output;
        input = u.input_tokens ?? input;
        cacheWrite = u.cache_creation_input_tokens ?? cacheWrite;
        cacheRead = u.cache_read_input_tokens ?? cacheRead;
        break;
      }
    }
  }

  // acc 按块序号记，text / thinking 块也占序号，所以这里重排成 0,1,2… 交出去，
  // 跟 OpenAI 流里 tool_calls 的 index 同一个口径。
  const calls = new Map([...acc.values()].map((slot, i) => [i, slot]));

  return {
    parts,
    acc: calls,
    finishReason: stopReason ? (FINISH[stopReason] ?? stopReason) : null,
    usage: {
      // OpenAI 口径的 prompt_tokens 含缓存命中的部分，原生的 input_tokens 只是没命中的余数。
      // AgentLoop 拿 promptTokens 校准上下文估算，必须是发出去的总量。
      promptTokens: input + cacheWrite + cacheRead,
      completionTokens: output,
      cachedTokens: cacheRead,
      cost: 0,
    },
  };
}
