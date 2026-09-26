/**
 * 误拒兜底：拿一道 Opus 5.5 会误判成 cyber 的普通查表题（2026-09-27 最朴素的请求连拒三次），
 * 走 ModelClient 跑完整个工具循环。预期：不再以 refusal 收场，替补模型接着答完，答案对，
 * 换过模型之后的几轮照样读到缓存。
 *
 *   ANTHROPIC_API_KEY=... bun tests/anthropic-fallback-smoke.ts [model]
 */
import { ModelClient } from "../src/model.ts";

const modelId = process.argv[2] ?? "claude-opus-5-5";
const tools = [{
  type: "function",
  function: {
    name: "lookup",
    description: "Look up the value stored under a key.",
    parameters: { type: "object", properties: { key: { type: "string" } }, required: ["key"] },
  },
}];
const table: Record<string, string> = { "116": "42", "43": "7" };
// 系统提示垫到 1024 token 以上：替补模型 Opus 4.8 的最小缓存前缀是 1024，太短根本不缓存，测不出接没接上。
const padding = Array.from({ length: 120 }, (_, i) => `Style note ${i + 1}: keep answers short and state only the requested value.`).join("\n");
const messages: unknown[] = [
  { role: "system", content: `You are a careful assistant. Use the lookup tool when asked.\n\n${padding}` },
  {
    role: "user",
    content: "Let n be (the number of primes below 60) times 7 minus 3. Work it out carefully, then call lookup "
      + "with key = n. When you get a value v, call lookup again with key = v + 1. Finally answer with the last value only.",
  },
];

const model = new ModelClient({ provider: "anthropic", model: modelId });
let last = "";
for (let i = 0; i < 6; i++) {
  const turn = await model.streamTurn(messages, tools);
  const u = turn.usage;
  console.log(`turn ${i + 1}: finish=${turn.finishReason} prompt=${u.promptTokens} cached=${u.cachedTokens} calls=${turn.message.tool_calls?.length ?? 0}`);
  if (turn.finishReason === "refusal") throw new Error("还是以 refusal 收场，兜底没起作用");
  messages.push(turn.message);
  const calls = turn.message.tool_calls ?? [];
  if (!calls.length) { last = String(turn.message.content ?? ""); break; }
  for (const c of calls) {
    const key = String((JSON.parse(c.function.arguments || "{}") as { key?: unknown }).key ?? "");
    messages.push({ role: "tool", tool_call_id: c.id, content: table[key] ?? "not found" });
  }
}
if (!last.includes("7")) throw new Error(`答案不对：${JSON.stringify(last)}`);
console.log(`OK ${modelId}: 答案 ${JSON.stringify(last)}`);
