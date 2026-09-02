/**
 * 把一次运行失败翻译成用户能看懂、也能据此行动的一句话。
 *
 * 以前的版本是 `raw.includes("API")` 就说「没配 API key」。OpenAI SDK 的错误类名全带 API
 * （APIConnectionError、APIError、APIConnectionTimeoutError），loop 又把错误格式化成
 * `${name}: ${message}`，于是一次网络抖动、一次 5xx、一次限流，到用户眼前都成了「没配 key」。
 * 2026-09-02 实测：一轮跑了 64 步、引用都拿到了，最后一句是「请先配置 DeepSeek API key」，
 * 而 key 明明是好的，余额也够。所以这里只认真实信号，其余原样透出并保留错误类名。
 */
export function classifyRunError(
  error: unknown,
  provider: string,
  redact: (value: string, limit?: number) => string,
): string {
  const name = error instanceof Error ? error.name : "";
  const raw = error instanceof Error ? error.message : String(error);
  const text = name && name !== "Error" ? `${name}: ${raw}` : raw;

  // 真正的鉴权失败：401、invalid_api_key、Incorrect API key、DeepSeek 的 "Authentication Fails"、
  // 以及我们自己抛的 "needs XXX_API_KEY in the environment"。
  if (/\b401\b|invalid[_ ]?api[_ ]?key|incorrect api key|authentication (?:fails|failed|error)|needs [A-Z_]*API_KEY|没有可用的模型凭据/i.test(text)) {
    return `模型通道 ${provider} 鉴权失败，请到设置里检查这个通道的 API key。`;
  }
  if (/\b402\b|insufficient balance|余额不足/i.test(text)) {
    return `模型通道 ${provider} 账户余额不足，请到服务商控制台充值后重试。`;
  }
  if (/fetch failed|timed? ?out|ECONNRESET|ENOTFOUND|ECONNREFUSED|EAI_AGAIN|APIConnection|Connection error/i.test(text)) {
    return "模型服务暂时无法连接，请检查本机网络后重试。";
  }
  if (/\b429\b|rate ?limit/i.test(text)) {
    return "模型服务限流（429），稍等再试。";
  }
  if (/\b50[0-4]\b|InternalServerError|server error|overloaded|bad gateway/i.test(text)) {
    return "模型服务端出错（5xx），稍等再试。";
  }
  return redact(text, 300) || "本地研究运行失败。";
}
