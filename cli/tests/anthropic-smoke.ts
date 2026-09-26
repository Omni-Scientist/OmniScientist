/**
 * Claude 原生通道的真机冒烟：真 AgentLoop、真工具、真 API，看图走的也是原生通道。
 *
 * 验两件事：多轮工具循环能跑通、答案对；从第 2 轮起每轮都读到缓存，而且读数一路涨。
 *
 *   ANTHROPIC_API_KEY=... bun tests/anthropic-smoke.ts [model]
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";

import { toNativeRequest } from "../src/anthropic.ts";
import { ApprovalPolicy } from "../src/approval.ts";
import { AgentLoop, type Presenter } from "../src/loop.ts";
import { ModelClient, type Turn } from "../src/model.ts";
import { buildSystemPrompt } from "../src/soul.ts";
import { defaultRegistry, makeContext } from "../src/tools/index.ts";

const modelId = process.argv[2] ?? "claude-sonnet-5";
const root = mkdtempSync("/tmp/omnisci-anthropic-smoke-");
const values = { "a.txt": 17, "b.txt": 25, "c.txt": 58 };
for (const [name, n] of Object.entries(values)) writeFileSync(`${root}/${name}`, `value=${n}\n`);
const digit = 4;
const draw = spawnSync("python3", ["-c", `
from PIL import Image, ImageDraw, ImageFont
img = Image.new("RGB", (240, 240), "white")
d = ImageDraw.Draw(img)
d.text((70, 20), "${digit}", fill="black", font=ImageFont.load_default(size=180))
img.save("${root}/digit.png")
`]);
if (draw.status !== 0) throw new Error(`画测试图失败：${draw.stderr}`);

const presenter: Presenter = {
  turnStart() {},
  textDelta() {},
  textDone() {},
  toolStart(name, summary) { process.stdout.write(`  tool ${name}: ${summary}\n`); },
  toolResult(name, ok) { process.stdout.write(`  ${name} ${ok ? "ok" : "FAILED"}\n`); },
  note(text) { process.stdout.write(`  note: ${text}\n`); },
};

const model = new ModelClient({ provider: "anthropic", model: modelId });
const turns: Turn["usage"][] = [];
const original = model.streamTurn.bind(model);
model.streamTurn = async (messages, tools, onText, signal) => {
  const turn = await original(messages, tools, onText, signal);
  if (tools.length) {
    turns.push(turn.usage);
    const u = turn.usage;
    console.log(`turn ${turns.length}: prompt=${u.promptTokens} cached=${u.cachedTokens} `
      + `out=${u.completionTokens} finish=${turn.finishReason} calls=${turn.message.tool_calls?.length ?? 0}`);
  }
  return turn;
};

const messages: unknown[] = [
  { role: "system", content: buildSystemPrompt(modelId, root).systemPrompt },
  {
    role: "user",
    content: "一次只调一个工具，依次读 a.txt、b.txt、c.txt，再用 view_image 看 digit.png 上写的是几。"
      + "最后把三个 value 和图上的数字加起来，只回答那个和，一个数字。",
  },
];
const loop = new AgentLoop(model, await defaultRegistry(), makeContext(root), new ApprovalPolicy(true), presenter);
const result = await loop.run(messages);

const last = messages[messages.length - 1] as { role: string; content: string | null };
const expected = Object.values(values).reduce((a, b) => a + b, 0) + digit;
console.log(`final: ${JSON.stringify(last.content)}  (expected ${expected}), stopped: ${result.stoppedBecause}`);

if (last.role !== "assistant" || !String(last.content).includes(String(expected))) throw new Error("答案不对");
if (turns.length < 3) throw new Error(`只跑了 ${turns.length} 轮，没测到多轮缓存`);
const later = turns.slice(1);
if (!later.every((u) => u.cachedTokens > 0)) throw new Error("第 2 轮起有一轮没读到缓存");
if (!later.every((u, i) => i === 0 || u.cachedTokens >= later[i - 1]!.cachedTokens)) {
  throw new Error("缓存读数没有一路涨，前缀在中途被改了");
}
const replayed = toNativeRequest(messages, []).messages
  .flatMap((m) => (m.role === "assistant" ? m.content as Array<{ type: string }> : []))
  .filter((b) => b.type === "thinking" || b.type === "redacted_thinking").length;
console.log(`回传的 thinking 块：${replayed}`);
const sent = turns.reduce((s, u) => s + u.promptTokens, 0);
const cached = turns.reduce((s, u) => s + u.cachedTokens, 0);
console.log(`OK ${modelId}: ${turns.length} 轮，发出 ${sent} token，其中缓存命中 ${cached}（${Math.round(100 * cached / sent)}%）`);
