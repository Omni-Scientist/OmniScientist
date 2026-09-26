/**
 * 原生通道「输入超窗口」的报错能不能翻成 ContextOverflowError（AgentLoop 靠它强制压缩再试）。
 * 用 200K 窗口的 claude-haiku-4-5 发一段明显超长的输入；超窗口的请求被拒，不计费。
 *
 *   ANTHROPIC_API_KEY=... bun tests/anthropic-overflow-smoke.ts
 */
import { ContextOverflowError, ModelClient } from "../src/model.ts";

const model = new ModelClient({ provider: "anthropic", model: "claude-haiku-4-5", maxTokens: 16 });
try {
  await model.streamTurn([{ role: "user", content: "word ".repeat(260_000) }], []);
  throw new Error("超长输入居然没被拒");
} catch (error) {
  if (!(error instanceof ContextOverflowError)) throw error;
  console.log(`OK ContextOverflowError limit=${error.limit}\n${error.message}`);
}
