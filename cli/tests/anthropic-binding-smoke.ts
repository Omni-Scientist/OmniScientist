/**
 * 压缩之后回传 thinking 会不会 400：模拟桌面版的「前面换成摘要、最近几轮原样保留」。
 *
 * 1. Opus 5.5 跑一段带工具的对话，攒出带 thinking 的 assistant 消息。
 * 2. 把它前面的历史换成一条摘要，这条 assistant 原样保留，thinking 的前文就变了。
 * 3. 显式要求 "error"：应当 400，证明这道检查真在查。
 * 4. 走 ModelClient（带 drop_block）：应当照常返回，服务端报告丢了哪几块。
 *
 *   ANTHROPIC_API_KEY=... bun tests/anthropic-binding-smoke.ts [model]
 */
import Anthropic from "@anthropic-ai/sdk";

import { toNativeRequest } from "../src/anthropic.ts";
import { credentialFor } from "../src/credentials.ts";
import { ModelClient } from "../src/model.ts";

const modelId = process.argv[2] ?? "claude-opus-5-5";
// credentials.ts 一加载就把 key 从环境变量里挪走（免得漏给子进程），只能从它那儿取。
const apiKey = credentialFor("anthropic")!;
const tools = [{
  type: "function",
  function: { name: "lookup", description: "Look up a value", parameters: { type: "object", properties: { key: { type: "string" } } } },
}];
const table: Record<string, string> = { "116": "42" };

// 题面别写成「拿到值再用值去查下一个」那种链式查询：2026-09-27 实测 Opus 5.5 把它判成 cyber
// 连拒三次（跟请求怎么配无关，最朴素的请求也拒），拒了就没有 thinking 可测。
const system = { role: "system", content: "You are a careful assistant. Use the lookup tool when asked." };
const messages: unknown[] = [
  system,
  { role: "user", content: "Let n be (the number of primes below 60) times 7 minus 3. Work it out carefully, then call lookup with key = n." },
];

const model = new ModelClient({ provider: "anthropic", model: modelId });
for (let i = 0; i < 4; i++) {
  const turn = await model.streamTurn(messages, tools);
  messages.push(turn.message);
  const calls = turn.message.tool_calls ?? [];
  if (!calls.length) break;
  for (const c of calls) {
    const key = String((JSON.parse(c.function.arguments || "{}") as { key?: unknown }).key ?? "");
    messages.push({ role: "tool", tool_call_id: c.id, content: table[key] ?? "not found" });
  }
}

const hasThinking = (m: unknown) => {
  const req = toNativeRequest([{ role: "user", content: "x" }, m], []);
  return (req.messages[1]?.content as Array<{ type: string }> | undefined ?? [])
    .some((b) => b.type === "thinking" || b.type === "redacted_thinking");
};
const at = messages.findIndex((m) => (m as { role: string }).role === "assistant" && hasThinking(m));
if (at < 0) throw new Error("这段对话没产生 thinking 块，测不了，换道更难的题");
console.log(`第 ${at} 条消息带 thinking，拿它做保留下来的那一轮`);

// 保留这条 assistant 和它之后的全部，前面换成一条摘要
const compacted: unknown[] = [
  system,
  { role: "user", content: "[Summary of earlier conversation] The user asked you to compute a key and look it up." },
  ...messages.slice(at),
];
// 必须以 user 结尾，以 assistant 结尾会被当成预填充直接 400，那就测不到绑定检查了。
if ((compacted[compacted.length - 1] as { role: string }).role === "assistant") {
  compacted.push({ role: "user", content: "Repeat the value you got, nothing else." });
}

const req = toNativeRequest(compacted, tools);
const raw = new Anthropic({ apiKey, authToken: null, maxRetries: 0 });
try {
  await raw.beta.messages.create({
    model: modelId,
    max_tokens: 256,
    system: req.system,
    messages: req.messages,
    tools: req.tools,
    betas: ["thinking-binding-controls-2026-08-01"],
    thinking: { type: "adaptive", block_binding: { prefix_mismatch_behavior: "error" } },
  });
  console.log("error 模式没有 400：这个账号 / 模型上检查没触发");
} catch (error) {
  if (!(error instanceof Anthropic.BadRequestError)) throw error;
  // 别的 400（比如预填充）不算数，必须是 thinking 对不上这一条。
  if (!/thinking|block|prefix|conversation/i.test(error.message) || /prefill/i.test(error.message)) throw error;
  console.log(`error 模式 400（预期）：${error.message.slice(0, 260)}`);
}

const probe = await raw.beta.messages.create({
  model: modelId,
  max_tokens: 256,
  system: req.system,
  messages: req.messages,
  tools: req.tools,
  betas: ["thinking-binding-controls-2026-08-01"],
  thinking: { type: "adaptive", block_binding: { prefix_mismatch_behavior: "drop_block" } },
});
console.log(`drop_block 模式照常返回，服务端报告：${JSON.stringify(probe.input_transformations)}`);

const turn = await model.streamTurn(compacted, tools);
console.log(`OK 桌面版这条路照常返回：finish=${turn.finishReason} 正文=${JSON.stringify(turn.message.content)}`);

// 压缩之后缓存还接不接得上：再接着聊两轮，看每轮读到多少缓存。
compacted.push(turn.message);
for (const ask of ["Say the value again.", "And once more."]) {
  compacted.push({ role: "user", content: ask });
  const next = await model.streamTurn(compacted, tools);
  compacted.push(next.message);
  console.log(`压缩后续聊：prompt=${next.usage.promptTokens} cached=${next.usage.cachedTokens}`);
}
