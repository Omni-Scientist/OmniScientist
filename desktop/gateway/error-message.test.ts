import { describe, expect, test } from "bun:test";

import { classifyRunError } from "./error-message.ts";

const redact = (v: string, limit = 300) => v.slice(0, limit);
const named = (name: string, message: string) => { const e = new Error(message); e.name = name; return e; };

describe("运行失败的归类", () => {
  test("网络抖动不能被说成没配 key（错误类名带 API 的那一类）", () => {
    // 2026-09-02 实测：64 步之后一次 APIConnectionError，界面说「请先配置 DeepSeek API key」
    expect(classifyRunError(named("APIConnectionError", "Connection error."), "deepseek", redact)).toMatch(/无法连接/);
    expect(classifyRunError(named("APIConnectionTimeoutError", "Request timed out."), "deepseek", redact)).toMatch(/无法连接/);
    expect(classifyRunError(named("APIError", "502 Bad Gateway"), "deepseek", redact)).toMatch(/5xx/);
  });
  test("只有真实鉴权信号才说 key 的事，并点名通道", () => {
    expect(classifyRunError(named("AuthenticationError", "401 Incorrect API key provided: sk-abc"), "openai", redact)).toMatch(/openai.*API key/);
    expect(classifyRunError(new Error("Authentication Fails, Your api key: ****** is invalid"), "deepseek", redact)).toMatch(/deepseek.*API key/);
    expect(classifyRunError(new Error("model 'x' needs DEEPSEEK_API_KEY in the environment (not set)"), "deepseek", redact)).toMatch(/API key/);
  });
  test("余额、限流、服务端错各说各的", () => {
    expect(classifyRunError(new Error("402 Insufficient Balance"), "deepseek", redact)).toMatch(/余额/);
    expect(classifyRunError(named("RateLimitError", "429 Too Many Requests"), "deepseek", redact)).toMatch(/429/);
    expect(classifyRunError(named("InternalServerError", "503 Service Unavailable"), "deepseek", redact)).toMatch(/5xx/);
  });
  test("认不出的原样透出，保留类名，不再兜底成「没配 key」", () => {
    expect(classifyRunError(named("TypeError", "Cannot read properties of undefined"), "deepseek", redact)).toBe("TypeError: Cannot read properties of undefined");
    expect(classifyRunError(new Error("paper_cli.py 退出码 1"), "deepseek", redact)).toBe("paper_cli.py 退出码 1");
  });
});
