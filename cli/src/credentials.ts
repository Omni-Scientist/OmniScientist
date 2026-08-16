import { closeSync, readFileSync } from "node:fs";

type CredentialProvider = "deepseek" | "anthropic" | "custom" | "openai";

const SECRET_NAME = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|COOKIE)/i;
const MODEL_SECRET_NAMES = [
  "DEEPSEEK_API",
  "DEEPSEEK_API_KEY",
  "ANTHROPIC_API_KEY",
  "OMNISCI_API_KEY",
  "OPENAI_API_KEY",
];

/**
 * 载荷是按行定位的，顺序就是协议，只能往后追加，不能插队。
 * 少给几行等于后面的通道没配（读到 ""），不是错误：老的封装脚本只写三行。
 */
export function parseCredentialPayload(raw: string): Record<CredentialProvider, string> {
  const [deepseek = "", anthropic = "", custom = "", openai = ""] = raw.replace(/\r/g, "").split("\n");
  return { deepseek, anthropic, custom, openai };
}

function loadCredentials(): Record<CredentialProvider, string> {
  const fdRaw = process.env.OMNISCI_CREDENTIAL_FD;
  if (fdRaw) {
    const fd = Number(fdRaw);
    if (!Number.isInteger(fd) || fd < 0) throw new Error(`OMNISCI_CREDENTIAL_FD 非法: ${fdRaw}`);
    try {
      return parseCredentialPayload(readFileSync(fd, "utf-8"));
    } finally {
      closeSync(fd);
    }
  }

  return {
    deepseek: process.env.DEEPSEEK_API || process.env.DEEPSEEK_API_KEY || "",
    anthropic: process.env.ANTHROPIC_API_KEY || "",
    custom: process.env.OMNISCI_API_KEY || "",
    openai: process.env.OPENAI_API_KEY || "",
  };
}

const CREDENTIALS = loadCredentials();
delete process.env.OMNISCI_CREDENTIAL_FD;
for (const name of MODEL_SECRET_NAMES) delete process.env[name];

export function credentialFor(provider: CredentialProvider): string | undefined {
  return CREDENTIALS[provider] || undefined;
}

/** Child processes never need the model credentials or unrelated host secrets. */
export function safeChildEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined || SECRET_NAME.test(name) || MODEL_SECRET_NAMES.includes(name)) continue;
    out[name] = value;
  }
  return out;
}
