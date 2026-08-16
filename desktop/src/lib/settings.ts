import { t } from "./i18n";
/**
 * 模型设置。走的是 launcher 的 /api/settings，不经过 transport 那层抽象：
 * transport 抽的是"研究会话"，这是进程级配置，两回事。
 *
 * 认证靠首屏那次 ?t= 换来的 HttpOnly cookie，同源请求自动带上，前端代码里
 * 不出现也拿不到 token。
 */

export type ProviderId = "deepseek" | "anthropic" | "openai" | "custom";
export type Scope = "model" | "vision";

export interface ModelChoice {
  name: string;
  /** 用户自己加的才能删。 */
  removable: boolean;
}

/** 一条线（研究 / 视觉）上的一个通道。 */
export interface ChannelInfo {
  id: ProviderId;
  label: string;
  hint: string;
  keyEnv: string;
  keyPrefix: string;
  /** 自定义端点要用户自己填地址。 */
  needsEndpoint: boolean;
  baseUrl: string;
  /** 头三尾四的掩码，够认出是哪把 key，认不出完整值。没配就是 null。 */
  masked: string | null;
  models: ModelChoice[];
  selected: string;
  configured: boolean;
  active: boolean;
  /** 这条线实际在跑的模型，只有 active 的那个有意义。 */
  activeModel: string;
  /** 选中的模型收不收推理档位。 */
  supportsEffort: boolean;
  effort: string;
}

/** 推理档位。gpt-5.6 实测就这几个，没有 max，最强是 xhigh。 */
export const EFFORTS = ["none", "low", "medium", "high", "xhigh"] as const;

export interface SettingsState {
  active: ProviderId;
  ready: boolean;
  envFile: string;
  providers: ChannelInfo[];
  vision: ChannelInfo[];
  /** 眼睛配齐了没有。没配齐 view_image 会当场报错，不会静默瞎编。 */
  visionReady: boolean;
  /** 每天查一次有没有新版本。关掉之后 CLI 也不查，同一个开关。 */
  updateCheck: boolean;
  /** 测试通过时回传测的是哪个模型。 */
  tested?: string;
  saved?: boolean;
}

export interface SettingsPatch {
  scope?: Scope;
  provider: ProviderId;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  /** 删掉这个通道的 key。 */
  removeKey?: boolean;
  addModel?: string;
  removeModel?: string;
  effort?: string;
  updateCheck?: boolean;
  /** 缺省是 save。use 会被后端拦下，除非这套配置刚测过。 */
  action?: "test" | "save" | "use";
}

/** 有没有新版本。只查只报，绝不下载或替换任何东西。 */
export interface UpdateState {
  current: string;
  disabled: boolean;
  update: { latest: string; current: string; newer: boolean; url: string } | null;
  howTo: string | null;
}

export async function checkUpdate(force = false): Promise<UpdateState> {
  const response = await fetch(`/api/update${force ? "?force=1" : ""}`);
  if (!response.ok) throw new Error(t("本地后端返回 {0}", response.status));
  return await response.json() as UpdateState;
}

/** 演示版没有后端，界面上要说清楚，而不是转圈转到天荒地老。 */
export const settingsAvailable = import.meta.env.VITE_OMNISCI_LIVE === "1";

async function call(init?: RequestInit): Promise<SettingsState> {
  const response = await fetch("/api/settings", {
    ...init,
    headers: { ...(init?.body ? { "Content-Type": "application/json" } : {}), ...init?.headers },
  });
  const payload = (await response.json().catch(() => ({}))) as Partial<SettingsState> & { error?: string };
  if (!response.ok) {
    throw new Error(payload.error || t("本地后端返回 {0}", response.status));
  }
  return payload as SettingsState;
}

export function loadSettings(): Promise<SettingsState> {
  return call();
}

/** 真发一次请求验证这套配置能用，不落盘。失败时错误原文抛出来。 */
export function testSettings(patch: SettingsPatch): Promise<SettingsState> {
  return call({ method: "POST", body: JSON.stringify({ ...patch, action: "test" }) });
}

/** 存下来，但不切换当前在用的是谁。不发请求。 */
export function saveSettings(patch: SettingsPatch): Promise<SettingsState> {
  return call({ method: "POST", body: JSON.stringify({ ...patch, action: "save" }) });
}

/** 把这条线切到这套配置上。没测过的会被后端拒。 */
export function useSettings(patch: SettingsPatch): Promise<SettingsState> {
  return call({ method: "POST", body: JSON.stringify({ ...patch, action: "use" }) });
}
