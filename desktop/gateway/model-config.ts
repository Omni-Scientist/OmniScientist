/**
 * 桌面版的"当前用哪个通道、哪个 key、哪个模型"。
 *
 * 为什么要这么一个东西：cli/src/credentials.ts 在模块加载时就把 key 从环境变量里
 * 读走并删掉，之后再改环境变量没有任何作用。而桌面版要让用户在界面上填 key，
 * 填完就能用。所以这里存一份进程内的可变状态，launcher 在保存时更新它，gateway
 * 建会话时读它——ModelClient 本来就是每个会话新建一次的，所以新会话立刻生效，
 * 不需要重启服务。
 *
 * 两条独立的线：
 *   研究模型（脑子）负责推理和写作
 *   视觉模型（眼睛）负责读像素
 * 分开是因为 DeepSeek 官方接口只收文本，脑子用它的时候眼睛必须是别人。
 *
 * 三个动作，各管各的：
 *   test  真发一次请求，什么都不改，通过了就记一笔"这套配置验过"
 *   save  把 key / 模型 / 地址存下来，但不切换当前在用的是谁
 *   use   把这条线切到这套配置上。没验过的配置切不过去。
 */
import { createHash } from "node:crypto";

import { credentialFor } from "../../cli/src/credentials.ts";
import { DEFAULT_EFFORT, EFFORT_LEVELS, PROVIDERS, supportsEffort, type ProviderName } from "../../cli/src/model.ts";

export type ProviderId = ProviderName;
export type Scope = "model" | "vision";
export type Action = "test" | "save" | "use";

export interface ModelChoice {
  name: string;
  /** 用户自己加的才能删。 */
  removable: boolean;
}

export interface ChannelInfo {
  id: ProviderId;
  label: string;
  /** 界面上写在标题下面的一句话。只写去哪儿拿 key，别写成说明书。 */
  hint: string;
  keyEnv: string;
  /** 期望的 key 前缀，用来挡住明显填错的。空表示不检查。 */
  keyPrefix: string;
  /** 自定义端点要用户自己填地址。 */
  needsEndpoint: boolean;
  baseUrl: string;
  /**
   * 给界面看的掩码，形如 sk-•••••••••••ab12，没配就是 null。
   * 只露头三尾四，够用户认出"这是哪一把"，认不出完整值。key 本体不出这个进程。
   */
  masked: string | null;
  models: ModelChoice[];
  /** 这条线上这个通道选中的模型。 */
  selected: string;
  /** key、模型、地址都齐了。 */
  configured: boolean;
  /** 这条线当前跑的就是它。 */
  active: boolean;
  /** 这条线当前实际在用的模型，只有 active 的那个有意义。 */
  activeModel: string;
}

export interface ModelConfig {
  provider: ProviderId;
  model: string;
  apiKey: string;
  baseUrl: string;
  /** 只在模型收这个字段时才有值。 */
  effort?: string;
}

export interface SettingsPatch {
  /** 改哪条线。缺省是研究模型。 */
  scope?: Scope;
  provider: ProviderId;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  /** 删掉这个通道的 key。 */
  removeKey?: boolean;
  addModel?: string;
  removeModel?: string;
  /** 每日更新检查的开关。跟模型配置无关，但共用同一个设置面板和同一个 env 文件。 */
  updateCheck?: boolean;
  /** 推理档位，见 EFFORTS。 */
  effort?: string;
  /** 缺省是 save。 */
  action?: Action;
}

const META: Record<
  ProviderId,
  { label: string; hint: string; keyEnv: string; keyPrefix: string; needsEndpoint: boolean; autoSelect: boolean }
> = {
  deepseek: {
    label: "DeepSeek",
    hint: "platform.deepseek.com",
    keyEnv: "DEEPSEEK_API_KEY",
    keyPrefix: "sk-",
    needsEndpoint: false,
    autoSelect: true,
  },
  anthropic: {
    label: "Claude",
    hint: "console.anthropic.com",
    keyEnv: "ANTHROPIC_API_KEY",
    keyPrefix: "sk-ant-",
    needsEndpoint: false,
    autoSelect: true,
  },
  openai: {
    label: "OpenAI",
    hint: "platform.openai.com",
    keyEnv: "OPENAI_API_KEY",
    keyPrefix: "sk-",
    needsEndpoint: false,
    // 不参与"没指定就挑第一个有 key 的"。OPENAI_API_KEY 在很多人机器上本来就
    // 躺着，自动选中等于把研究模型悄悄换成一个关掉推理的 gpt-5.6。要用就明着点。
    autoSelect: false,
  },
  custom: {
    label: "自定义端点",
    hint: "任何 OpenAI 兼容地址",
    keyEnv: "OMNISCI_API_KEY",
    keyPrefix: "",
    needsEndpoint: true,
    autoSelect: true,
  },
};

export const PROVIDER_IDS = Object.keys(META) as ProviderId[];

/**
 * 每条线上每个通道内置的模型。故意只给两三个：列全了反而要用户挑，
 * 想要别的自己加。
 */
const PRESETS: Record<Scope, Record<ProviderId, string[]>> = {
  model: {
    deepseek: ["deepseek-v4-flash", "deepseek-v4-pro"],
    anthropic: ["claude-sonnet-5"],
    openai: ["gpt-5.6-luna", "gpt-5.6-terra"],
    custom: [],
  },
  vision: {
    // 2026-08 官方上了 deepseek-v4-flash-vision-exp：OpenAI 格式的 image_url，
    // base64 data URI 和外链都收，图只能出现在 user 消息里。文本主干仍然不收图。
    deepseek: ["deepseek-v4-flash-vision-exp"],
    anthropic: ["claude-sonnet-5"],
    openai: ["gpt-5.6-luna", "gpt-5.6-terra"],
    custom: [],
  },
};

/** 视觉这条线上出现哪些通道。收不了图的不列，免得用户选进去再被拒。 */
export const VISION_PROVIDER_IDS = PROVIDER_IDS.filter(
  (id) => PRESETS.vision[id].length > 0 || META[id].needsEndpoint,
);

export const MANAGED_ENV_NAMES: string[] = [
  "OMNISCI_PROVIDER",
  "OMNISCI_BASE_URL",
  "OMNISCI_MODEL",
  "OMNISCI_VISION_PROVIDER",
  "OMNISCI_VISION_MODEL",
  "OMNISCI_VISION_BASE_URL",
  "OMNISCI_VISION_EFFORT",
  "OMNISCI_EXTRA_MODELS",
  "OMNISCI_UPDATE_CHECK",
  ...PROVIDER_IDS.map((id) => META[id].keyEnv),
];

/**
 * 每日更新检查的开关。写进同一个 env 文件，所以界面上关掉之后 CLI 也跟着不查——
 * 一个开关管两端，不然用户以为关了，命令行还在偷偷查。
 */
let updateCheck = (process.env.OMNISCI_UPDATE_CHECK ?? "").trim().toLowerCase() !== "off";

export function updateCheckEnabled(): boolean {
  return updateCheck;
}

export function setUpdateCheck(on: boolean): void {
  updateCheck = on;
  // 进程内也要立刻生效：update.ts 读的是 process.env，不是这里的变量。
  process.env.OMNISCI_UPDATE_CHECK = on ? "on" : "off";
}

function mask(key: string): string | null {
  if (!key) return null;
  if (key.length <= 12) return "•".repeat(10);
  return `${key.slice(0, 3)}${"•".repeat(11)}${key.slice(-4)}`;
}

const keys: Record<ProviderId, string> = {
  deepseek: credentialFor("deepseek") ?? "",
  anthropic: credentialFor("anthropic") ?? "",
  openai: credentialFor("openai") ?? "",
  custom: credentialFor("custom") ?? "",
};

/** 自定义端点的地址。只有 needsEndpoint 的通道用得上。 */
const endpoints: Record<ProviderId, string> = {
  deepseek: "", anthropic: "", openai: "", custom: "",
};

/**
 * 用户自己加的模型，按通道存，两条线共用一份。
 * 落盘成一行：OMNISCI_EXTRA_MODELS=openai:gpt-5.4|custom:qwen/qwen3-vl-8b:free
 * 按第一个冒号切，因为模型名里本来就可能有冒号（OpenRouter 的 :free 之类）。
 */
const extraModels: Record<ProviderId, string[]> = {
  deepseek: [], anthropic: [], openai: [], custom: [],
};

function loadExtraModels(): void {
  for (const entry of (process.env.OMNISCI_EXTRA_MODELS || "").split("|")) {
    const at = entry.indexOf(":");
    if (at <= 0) continue;
    const id = entry.slice(0, at).trim() as ProviderId;
    const name = entry.slice(at + 1).trim();
    if (!PROVIDER_IDS.includes(id) || !name) continue;
    if (!extraModels[id].includes(name)) extraModels[id].push(name);
  }
}
loadExtraModels();

/** 一个通道在某条线上的全部候选：内置的在前，用户加的在后。 */
function modelsOf(scope: Scope, id: ProviderId): ModelChoice[] {
  const preset = PRESETS[scope][id].map((name) => ({ name, removable: false }));
  const mine = extraModels[id]
    .filter((name) => !PRESETS[scope][id].includes(name))
    .map((name) => ({ name, removable: true }));
  return [...preset, ...mine];
}

function firstModel(scope: Scope, id: ProviderId): string {
  return modelsOf(scope, id)[0]?.name ?? "";
}

/**
 * 两层状态，别混：
 *   picked  每条线上每个通道"选好了但不一定在用"的模型，save 写它
 *   lines   每条线真正在跑的那套，只有 use 写它
 * 分开才能做到「保存不等于生效」。
 */
const picked: Record<Scope, Record<ProviderId, string>> = {
  model: { deepseek: "", anthropic: "", openai: "", custom: "" },
  vision: { deepseek: "", anthropic: "", openai: "", custom: "" },
};

/** 推理档位，跟模型一样按线按通道记。空表示用模型自己的默认。 */
const efforts: Record<Scope, Record<ProviderId, string>> = {
  model: { deepseek: "", anthropic: "", openai: "", custom: "" },
  vision: { deepseek: "", anthropic: "", openai: "", custom: "" },
};

interface Line {
  provider: ProviderId;
  model: string;
  baseUrl: string;
  effort: string;
}

const lines: Record<Scope, Line> = {
  model: { provider: "deepseek", model: "", baseUrl: "", effort: "" },
  vision: { provider: "anthropic", model: "", baseUrl: "", effort: "" },
};

function boot(): void {
  for (const scope of ["model", "vision"] as Scope[]) {
    const pool = scope === "vision" ? VISION_PROVIDER_IDS : PROVIDER_IDS;
    for (const id of pool) {
      picked[scope][id] = firstModel(scope, id);
      // 只有 OpenAI 官方通道给默认档位。别按模型名判：自定义端点上挂一个叫
      // gpt-5.x 的模型（OpenRouter、公司网关）不保证收 reasoning_effort，
      // 默认塞过去就是无缘无故 400。那边留空，要用自己明着选。
      if (id === "openai" && supportsEffort(picked[scope][id])) efforts[scope][id] = DEFAULT_EFFORT;
    }

    const prefix = scope === "vision" ? "OMNISCI_VISION_" : "OMNISCI_";
    const wanted = (process.env[`${prefix}PROVIDER`] || "").trim() as ProviderId;
    const model = (process.env[`${prefix}MODEL`] || "").trim();
    const baseUrl = (process.env[scope === "vision" ? "OMNISCI_VISION_BASE_URL" : "OMNISCI_BASE_URL"] || "").trim();

    const provider = pool.includes(wanted)
      ? wanted
      // 没指定就用第一个有 key 的。autoSelect=false 的不参与，见 META 里 openai 那条。
      : (pool.find((id) => keys[id] && META[id].autoSelect) ?? pool[0]!);
    const effort = (process.env[scope === "vision" ? "OMNISCI_VISION_EFFORT" : "OMNISCI_EFFORT"] || "").trim();
    if (model) picked[scope][provider] = model;
    if (baseUrl) endpoints[provider] = baseUrl;
    if (effort) efforts[scope][provider] = effort;
    lines[scope] = {
      provider,
      model: model || picked[scope][provider],
      baseUrl: META[provider].needsEndpoint ? baseUrl : PROVIDERS[provider].baseURL,
      effort,
    };
  }
}
boot();

/**
 * 上一次测通的是哪套。use 拿它当门禁：没验过的配置不许切过去。
 * 只在进程里活着，不落盘——重启之后本来就该重测。
 */
interface TestedMark {
  provider: ProviderId;
  model: string;
  baseUrl: string;
  keyHash: string;
}
const tested: Record<Scope, TestedMark | null> = { model: null, vision: null };

const hash = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 16);

function markOf(config: ModelConfig): TestedMark {
  return {
    provider: config.provider,
    model: config.model,
    baseUrl: config.baseUrl,
    keyHash: hash(config.apiKey),
  };
}

function sameMark(a: TestedMark | null, b: TestedMark): boolean {
  return Boolean(
    a && a.provider === b.provider && a.model === b.model && a.baseUrl === b.baseUrl && a.keyHash === b.keyHash,
  );
}

function baseUrlOf(id: ProviderId): string {
  return META[id].needsEndpoint ? endpoints[id] : PROVIDERS[id].baseURL;
}

function describe(scope: Scope, pool: ProviderId[]): ChannelInfo[] {
  const line = lines[scope];
  return pool.map((id) => ({
    id,
    ...META[id],
    baseUrl: baseUrlOf(id),
    masked: mask(keys[id]),
    models: modelsOf(scope, id),
    selected: picked[scope][id],
    configured: Boolean(keys[id] && picked[scope][id] && baseUrlOf(id)),
    active: line.provider === id,
    activeModel: line.provider === id ? line.model : "",
    supportsEffort: supportsEffort(picked[scope][id]),
    effort: efforts[scope][id],
  }));
}

export function describeProviders(): ChannelInfo[] {
  return describe("model", PROVIDER_IDS);
}

export function describeVision(): ChannelInfo[] {
  return describe("vision", VISION_PROVIDER_IDS);
}

export function activeProvider(): ProviderId {
  return lines.model.provider;
}

export function isReady(): boolean {
  return currentModelConfig() !== null;
}

function configOf(scope: Scope): ModelConfig | null {
  const line = lines[scope];
  const apiKey = keys[line.provider];
  if (!apiKey || !line.model || !line.baseUrl) return null;
  return {
    provider: line.provider,
    model: line.model,
    apiKey,
    baseUrl: line.baseUrl,
    ...(line.effort && supportsEffort(line.model) ? { effort: line.effort } : {}),
  };
}

/** 建会话时用。没配好就返回 null，调用方负责报一条人话错误。 */
export function currentModelConfig(): ModelConfig | null {
  return configOf("model");
}

/** 视觉侧车当前该用什么。 */
export function currentVisionConfig(): ModelConfig | null {
  return configOf("vision");
}

/** 这份改动指向的完整一套配置。凑不齐就是 null。 */
export function previewConfig(patch: SettingsPatch): ModelConfig | null {
  if (patch.updateCheck !== undefined) return null;
  if (patch.removeKey || patch.addModel !== undefined || patch.removeModel !== undefined) return null;
  const apiKey = patch.apiKey?.trim() || keys[patch.provider];
  const model = (patch.model ?? "").trim();
  const baseUrl = (META[patch.provider].needsEndpoint
    ? (patch.baseUrl ?? endpoints[patch.provider])
    : PROVIDERS[patch.provider].baseURL).trim();
  if (!apiKey || !model || !baseUrl) return null;
  const effort = (patch.effort ?? efforts[patch.scope === "vision" ? "vision" : "model"][patch.provider]).trim();
  return {
    provider: patch.provider, model, apiKey, baseUrl,
    ...(effort && supportsEffort(model) ? { effort } : {}),
  };
}

/**
 * 校验一份改动。返回错误字符串表示不合格，返回 null 表示可以用。
 * 只做能在本地判定的检查，key 到底对不对要靠真发一次请求。
 */
export function validatePatch(patch: SettingsPatch): string | null {
  // 开关跟通道无关，别拿模型那套必填项去卡它。
  if (patch.updateCheck !== undefined) return null;
  const scope: Scope = patch.scope === "vision" ? "vision" : "model";
  const pool = scope === "vision" ? VISION_PROVIDER_IDS : PROVIDER_IDS;
  if (!pool.includes(patch.provider)) {
    return `${scope === "vision" ? "视觉" : "研究"}模型没有 ${patch.provider} 这个通道`;
  }
  const meta = META[patch.provider];

  if (patch.removeKey) return keys[patch.provider] ? null : `${meta.label} 本来就没有 key`;

  if (patch.addModel !== undefined) {
    const name = patch.addModel.trim();
    if (!name) return "模型名不能为空";
    if (/[\r\n|]/.test(name)) return "模型名里不能有换行或竖线";
    if (modelsOf(scope, patch.provider).some((m) => m.name === name)) return `${name} 已经在列表里了`;
    return null;
  }
  if (patch.removeModel !== undefined) {
    return extraModels[patch.provider].includes(patch.removeModel) ? null : "内置模型删不掉";
  }

  const key = patch.apiKey?.trim() ?? "";
  if (key) {
    if (/[\r\n]/.test(key)) return "key 里不能有换行";
    if (key.length < 8) return "这个 key 太短了，八成是贴漏了";
    if (meta.keyPrefix && !key.startsWith(meta.keyPrefix)) {
      return `${meta.label} 的 key 应该以 ${meta.keyPrefix} 开头，你填的不是`;
    }
  } else if (!keys[patch.provider]) {
    return `${meta.label} 还没有 key`;
  }

  if (patch.effort && !EFFORT_LEVELS.includes(patch.effort as never)) {
    return `推理档位只能是 ${EFFORT_LEVELS.join(" / ")}`;
  }

  const model = (patch.model ?? "").trim();
  if (!model) return "要选一个模型";
  if (/[\r\n]/.test(model)) return "模型名里不能有换行";

  if (meta.needsEndpoint) {
    const url = (patch.baseUrl ?? "").trim();
    if (!url) return "自定义端点要填地址";
    if (!/^https?:\/\//.test(url)) return "地址要以 http:// 或 https:// 开头";
    if (/[\r\n]/.test(url)) return "地址里不能有换行";
  }

  // 门禁：没验过的配置不许启用。避免"填错了也能设成当前"，那种错要等第一条
  // 消息才炸，而那时候错误混在 agent 输出里，没人知道是配置的问题。
  if (patch.action === "use") {
    const config = previewConfig(patch);
    if (!config) return "配置还不完整";
    if (!sameMark(tested[scope], markOf(config))) return "这套配置还没测过，先点测试";
  }
  return null;
}

/** 记一笔"这套验过了"。launcher 在探测成功之后调。 */
export function markTested(scope: Scope, config: ModelConfig): void {
  tested[scope] = markOf(config);
}

/** 这条线当前那套，是不是已经验过。界面拿它决定"使用"按钮亮不亮。 */
export function testedMatches(scope: Scope, patch: SettingsPatch): boolean {
  const config = previewConfig(patch);
  return config ? sameMark(tested[scope], markOf(config)) : false;
}

/** 某条线在用的通道被掏空了 key，就退到还配着的那个，别停在一个用不了的上面。 */
function rescueLines(): void {
  for (const scope of ["model", "vision"] as Scope[]) {
    if (keys[lines[scope].provider]) continue;
    const pool = scope === "vision" ? VISION_PROVIDER_IDS : PROVIDER_IDS;
    const next = pool.find((id) => keys[id] && META[id].autoSelect);
    if (next) {
      lines[scope] = { provider: next, model: picked[scope][next], baseUrl: baseUrlOf(next), effort: efforts[scope][next] };
    }
  }
}

/** 写进程内状态。落盘是 launcher 的事，两件事分开做。 */
export function applyPatch(patch: SettingsPatch): void {
  const scope: Scope = patch.scope === "vision" ? "vision" : "model";
  if (patch.updateCheck !== undefined) {
    setUpdateCheck(patch.updateCheck);
    return;
  }

  if (patch.removeKey) {
    keys[patch.provider] = "";
    rescueLines();
    return;
  }
  if (patch.addModel !== undefined) {
    const name = patch.addModel.trim();
    if (!extraModels[patch.provider].includes(name)) extraModels[patch.provider].push(name);
    return;
  }
  if (patch.removeModel !== undefined) {
    extraModels[patch.provider] = extraModels[patch.provider].filter((m) => m !== patch.removeModel);
    for (const s of ["model", "vision"] as Scope[]) {
      if (picked[s][patch.provider] === patch.removeModel) {
        picked[s][patch.provider] = firstModel(s, patch.provider);
      }
    }
    return;
  }

  // save 和 use 都先把填的东西存下来，区别只在于要不要切当前在用的。
  const key = patch.apiKey?.trim();
  if (key) keys[patch.provider] = key;
  if (META[patch.provider].needsEndpoint && patch.baseUrl !== undefined) {
    endpoints[patch.provider] = patch.baseUrl.trim();
  }
  const model = (patch.model ?? "").trim();
  if (model) picked[scope][patch.provider] = model;
  if (patch.effort !== undefined) efforts[scope][patch.provider] = patch.effort.trim();

  if (patch.action === "use") {
    lines[scope] = {
      provider: patch.provider,
      model: model || picked[scope][patch.provider],
      baseUrl: baseUrlOf(patch.provider),
      effort: efforts[scope][patch.provider],
    };
  } else if (lines[scope].provider === patch.provider) {
    // 改的正好是在跑的那个通道，地址得跟着走，否则自定义端点改完地址还在用旧的。
    lines[scope] = { ...lines[scope], baseUrl: baseUrlOf(patch.provider) };
  }
}

/** 要写进 ~/.omnisci/env 的键值对。不含空值。 */
export function persistablePairs(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const id of PROVIDER_IDS) {
    if (keys[id]) out[META[id].keyEnv] = keys[id];
  }
  out.OMNISCI_PROVIDER = lines.model.provider;
  if (lines.model.model) out.OMNISCI_MODEL = lines.model.model;
  if (META[lines.model.provider].needsEndpoint && lines.model.baseUrl) {
    out.OMNISCI_BASE_URL = lines.model.baseUrl;
  }

  out.OMNISCI_VISION_PROVIDER = lines.vision.provider;
  if (lines.vision.model) out.OMNISCI_VISION_MODEL = lines.vision.model;
  if (lines.vision.effort) out.OMNISCI_VISION_EFFORT = lines.vision.effort;
  if (META[lines.vision.provider].needsEndpoint && lines.vision.baseUrl) {
    out.OMNISCI_VISION_BASE_URL = lines.vision.baseUrl;
  }

  const extra = PROVIDER_IDS.flatMap((id) => extraModels[id].map((name) => `${id}:${name}`));
  if (extra.length) out.OMNISCI_EXTRA_MODELS = extra.join("|");
  // 只在关掉时落一行。默认开着就不写，免得每个人的 env 里都多一行无用的配置。
  if (!updateCheck) out.OMNISCI_UPDATE_CHECK = "off";
  return out;
}
