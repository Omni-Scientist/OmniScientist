import { t } from "./i18n";
import type { DownloadState } from "../types";
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
  /** 收的话认哪几档。不收就是空数组。 */
  effortLevels: string[];
  effort: string;
}

/**
 * 推理档位规则，后端下发。
 *
 * 为什么不是前端自己写死一个正则：各家认的档位不是一套（OpenAI 五档、GLM 三档
 * low/high/max），而且这一行要跟着用户正在敲的模型名实时出现或消失。唯一真值在
 * cli/src/model.ts 的 EFFORT_RULES，前端只负责套用。
 */
export interface EffortRule {
  /** 匹配模型名的正则源码。 */
  pattern: string;
  levels: string[];
  fallback: string;
  required: boolean;
}

export interface SettingsState {
  active: ProviderId;
  ready: boolean;
  envFile: string;
  providers: ChannelInfo[];
  vision: ChannelInfo[];
  /** 眼睛配齐了没有。没配齐 view_image 会当场报错，不会静默瞎编。 */
  visionReady: boolean;
  /** 哪些模型收推理档位、各认哪几档。见 EffortRule。 */
  effortRules: EffortRule[];
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
  /** 这次压根没查成（断网、限流）时的原因。查成了是 null。 */
  failed: string | null;
  howTo: string | null;
}

export async function checkUpdate(force = false): Promise<UpdateState> {
  const response = await fetch(`/api/update${force ? "?force=1" : ""}`);
  if (!response.ok) throw new Error(t("本地后端返回 {0}", response.status));
  return await response.json() as UpdateState;
}

/**
 * 下载进度。下载跑在本地服务里，不在这个页面里，所以刷新页面不会把它弄断，
 * 界面重新挂上来的时候拉一次就能接着显示。定义在 types.ts，跟启动器共用一份。
 */
export type { DownloadState } from "../types";

/**
 * 本地服务回的错误正文。
 *
 * errorKey 是中文原文（就是词条表里的键），errorArgs 填它的 {0}；error 是服务端
 * 已经拼好的那句，日志用。界面要用 key 那份，否则英文用户会在错误提示里看到中文。
 */
interface ApiError {
  error?: string;
  errorKey?: string;
  errorArgs?: Array<string | number>;
}

function apiError(payload: ApiError, status: number): Error {
  if (payload.errorKey) return new Error(t(payload.errorKey, ...(payload.errorArgs ?? [])));
  return new Error(payload.error || t("本地后端返回 {0}", status));
}

async function updateCall(path: string, init?: RequestInit): Promise<DownloadState> {
  const response = await fetch(path, init);
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as ApiError;
    throw apiError(payload, response.status);
  }
  // 成功那条路上不吞解析错误。吞了的话，一个 200 但正文坏掉的回复会变成 {}，
  // 而 {} 的 state 是 undefined：每个分支都当作"没有下载"来画，轮询也不会启动，
  // 但服务端那边下载正跑着。界面从此静止，没有任何提示。
  return await response.json() as DownloadState;
}

/** 开下载。已经在下了就返回当前进度，重复点不会下两遍。 */
export function startDownload(): Promise<DownloadState> {
  return updateCall("/api/update/download", { method: "POST" });
}

export function pollDownload(): Promise<DownloadState> {
  // 要超时。本地服务收下连接却不回（进程卡死）时，这个 promise 会一直挂着，
  // 于是"连丢五次就报错"那道保险永远数不到一，界面停在"正在下载"不动。
  return updateCall("/api/update/download", { signal: AbortSignal.timeout(5000) });
}

export function cancelDownload(): Promise<DownloadState> {
  return updateCall("/api/update/cancel", { method: "POST" });
}

/**
 * 在访达/资源管理器里选中下好的安装包。
 *
 * 后端会拒绝下载目录以外的路径，也会拒绝已经不存在的文件（用户自己挪走或删了
 * 就属于这种）。那是一个 400，而 fetch 对 400 照样 resolve，所以这里必须自己
 * 看 ok，否则点了没反应而且永远不知道为什么。
 */
export async function revealDownload(path: string): Promise<void> {
  const response = await fetch("/api/update/reveal", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as ApiError;
    throw apiError(payload, response.status);
  }
}

/** 演示版没有后端，界面上要说清楚，而不是转圈转到天荒地老。 */
export const settingsAvailable = import.meta.env.VITE_OMNISCI_LIVE === "1";

async function call(init?: RequestInit): Promise<SettingsState> {
  const response = await fetch("/api/settings", {
    ...init,
    headers: { ...(init?.body ? { "Content-Type": "application/json" } : {}), ...init?.headers },
  });
  if (!response.ok) {
    // 错误正文本来就可能不是 JSON（代理返回的 HTML 错误页），这里吞掉是对的，
    // 反正下一行会用状态码兜底。
    const payload = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(payload.error || t("本地后端返回 {0}", response.status));
  }
  // 成功那条路上不吞。吞了会返回 {}，而它的 providers 是 undefined，
  // 界面拿去排序当场崩，报的还是一个跟根因毫无关系的 TypeError。
  return await response.json() as SettingsState;
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
