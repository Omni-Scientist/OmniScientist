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
type Block = Anthropic.Beta.BetaContentBlockParam;
type Thinking = Anthropic.Beta.BetaThinkingBlockParam | Anthropic.Beta.BetaRedactedThinkingBlockParam;
type ImageMime = Anthropic.Beta.BetaBase64ImageSource["media_type"];

/**
 * 一条 assistant 回复里各块的原始顺序：thinking 原样存下，正文存原文，工具调用只记 id。
 *
 * thinking 块必须原样、按原来的位置传回去（SDK 类型注释原话：passed back unmodified and
 * in their original order）。开了交错思考的模型会在两次工具调用之间再想一段，所以不能
 * 一股脑全堆到开头。正文和工具调用在回放时从当前那条消息取，不用这里存的值。
 */
type Skeleton = Array<{ kind: "thinking"; block: Thinking } | { kind: "text"; text: string } | { kind: "tool"; id: string }>;

/**
 * 按消息对象记，不往消息里加字段：消息会原样发给别家通道、塞进压缩摘要、写进桌面版存档，
 * 多一个字段哪儿都可能出事。桌面版重启后消息是从磁盘重建的新对象，这里查不到，
 * 就是不回传 thinking，原生接口照样接受。
 */
const skeletons = new WeakMap<object, Skeleton>();

export function rememberSkeleton(message: object, skeleton: Skeleton): void {
  if (skeleton.some((e) => e.kind === "thinking")) skeletons.set(message, skeleton);
}

/**
 * thinking 块跟产生它的那段对话绑定：它前面的 system、工具和每一条消息都得跟当时一字不差，
 * 否则算改过历史。桌面版的上下文压缩是「前面换成摘要、最近几轮原样保留」，保留下来那几轮的
 * thinking 前面就变了。会查这一条的模型（Opus 5.5、Fable 5.1），在 2026-08-31 之后注册的
 * 账号上默认直接 400。drop_block 让服务端把对不上的块丢掉、请求照常跑，只少了那几段思路。
 */
const BINDING_CHECKED = /^claude-(opus-5-5|fable-5-1)/;
const BINDING_BETA = "thinking-binding-controls-2026-08-01";

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

function imageBlock(part: Json): Anthropic.Beta.BetaImageBlockParam {
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

type Call = { id: string; function: { name: string; arguments: string } };

function toolUse(call: Call): Block {
  return { type: "tool_use", id: call.id, name: call.function.name, input: toolInput(call.function.arguments) };
}

/**
 * assistant 消息转成原生块。记过原始顺序的，thinking 放回原位；正文没被改过就按原来的
 * 分块放，改过（剥了推理标签之类）就整段放在第一个正文的位置；被丢掉的工具调用跳过。
 */
function assistantBlocks(m: Json): Block[] {
  const text = textOf(m.content);
  const calls = (m.tool_calls ?? []) as Call[];
  const skeleton = skeletons.get(m);
  if (!skeleton) return [...textBlock(text), ...calls.map(toolUse)];

  const byId = new Map(calls.map((c) => [c.id, c]));
  const recorded = skeleton.flatMap((e) => (e.kind === "text" ? [e.text] : [])).join("");
  const textIntact = recorded.trim() === text.trim();
  let textPlaced = false;
  const out: Block[] = [];
  for (const e of skeleton) {
    if (e.kind === "thinking") out.push(e.block);
    else if (e.kind === "text") {
      if (textIntact) out.push(...textBlock(e.text));
      else if (!textPlaced) { out.push(...textBlock(text)); textPlaced = true; }
    } else {
      const call = byId.get(e.id);
      if (call) { out.push(toolUse(call)); byId.delete(e.id); }
    }
  }
  if (!textIntact && !textPlaced) out.push(...textBlock(text));
  for (const call of byId.values()) out.push(toolUse(call));
  // 只剩 thinking 没有正文和工具调用的，发出去会被当成没说完的 assistant 前缀填充。
  return out.some((b) => b.type !== "thinking" && b.type !== "redacted_thinking") ? out : [];
}

export interface NativeRequest {
  system: string;
  messages: Anthropic.Beta.BetaMessageParam[];
  tools: Anthropic.Beta.BetaTool[];
}

/**
 * OpenAI 格式的会话历史转成原生请求。
 *
 * 规则都是原生接口定死的：
 * - system 消息提到顶层 system（兼容端点自己也是这么做的，行为不变）。
 * - tool 消息变成 user 消息里的 tool_result；连着的几条并进同一条 user 消息，
 *   并行调用的回执必须放在一起，拆开会让模型学会不再并行。
 * - 同一角色连续出现就合并，保证 user / assistant 交替。
 * - assistant 消息带着它当时的 thinking 块原样回传，见 assistantBlocks。
 */
export function toNativeRequest(messages: unknown[], tools: unknown[]): NativeRequest {
  const system: string[] = [];
  const out: Anthropic.Beta.BetaMessageParam[] = [];

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
      case "assistant":
        push("assistant", assistantBlocks(m));
        break;
      case "tool": {
        const content = partsToBlocks(m.content) as Array<Anthropic.Beta.BetaTextBlockParam | Anthropic.Beta.BetaImageBlockParam>;
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
        input_schema: { ...((fn.parameters ?? {}) as Json), type: "object" } as Anthropic.Beta.BetaTool.InputSchema,
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
  /** 交给 rememberSkeleton，等组装好的消息进了历史，下一轮回传用。 */
  skeleton: Skeleton;
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
  // 这几个模型不写 thinking 也是 adaptive，显式写出来是为了带上 block_binding，思考行为不变。
  const binding = BINDING_CHECKED.test(opts.model);

  const stream = await client.beta.messages.create({
    model: opts.model,
    max_tokens: opts.maxTokens,
    messages: req.messages,
    ...(system ? { system } : {}),
    ...(req.tools.length ? { tools: req.tools } : {}),
    ...(opts.cache ? { cache_control: { type: "ephemeral" as const } } : {}),
    ...(binding
      ? {
          betas: [BINDING_BETA],
          thinking: { type: "adaptive" as const, block_binding: { prefix_mismatch_behavior: "drop_block" as const } },
        }
      : {}),
    stream: true,
  }, signal ? { signal } : undefined);

  const parts: string[] = [];
  const acc = new Map<number, { id: string; name: string; args: string }>();
  // 按块序号记，流结束后按序号排出原始顺序。
  const blocks = new Map<number, Skeleton[number]>();
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
      case "content_block_start": {
        const cb = event.content_block;
        if (cb.type === "tool_use") {
          acc.set(event.index, { id: cb.id, name: cb.name, args: "" });
          blocks.set(event.index, { kind: "tool", id: cb.id });
        } else if (cb.type === "text") {
          blocks.set(event.index, { kind: "text", text: cb.text ?? "" });
        } else if (cb.type === "thinking") {
          blocks.set(event.index, { kind: "thinking", block: { type: "thinking", thinking: cb.thinking ?? "", signature: cb.signature ?? "" } });
        } else if (cb.type === "redacted_thinking") {
          blocks.set(event.index, { kind: "thinking", block: { type: "redacted_thinking", data: cb.data } });
        }
        break;
      }
      case "content_block_delta": {
        const slot = blocks.get(event.index);
        const d = event.delta;
        if (d.type === "text_delta") {
          parts.push(d.text);
          onText?.(d.text);
          if (slot?.kind === "text") slot.text += d.text;
        } else if (d.type === "input_json_delta") {
          const call = acc.get(event.index);
          if (call) call.args += d.partial_json;
        } else if (slot?.kind === "thinking" && slot.block.type === "thinking") {
          if (d.type === "thinking_delta") slot.block.thinking += d.thinking;
          // 签名在块结束前一次给全，是整值不是增量。
          else if (d.type === "signature_delta") slot.block.signature = d.signature;
        }
        break;
      }
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
  const skeleton = [...blocks.entries()].sort(([a], [b]) => a - b).map(([, e]) => e);

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
    skeleton,
  };
}
