import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

import { ApprovalPolicy } from "../../cli/src/approval.ts";
import { loadGuardConfig } from "../../cli/src/guard.ts";
import { loadHooks } from "../../cli/src/hooks.ts";
import {
  AgentLoop, UNATTENDED_MAX_TURNS, type Presenter,
} from "../../cli/src/loop.ts";
import { ModelClient } from "../../cli/src/model.ts";
import { Session } from "../../cli/src/session.ts";
import { loadSkills, makeUseSkillTool, skillsPromptBlock, type Skill } from "../../cli/src/skills.ts";
import { buildSystemPrompt, OMNI_HOME } from "../../cli/src/soul.ts";
import { StandardsEngine } from "../../cli/src/standards.ts";
import { makeExploreTool } from "../../cli/src/subagent.ts";
import { defaultRegistry, makeContext, type Registry } from "../../cli/src/tools/index.ts";
import { setVisionResolver } from "../../cli/src/tools/vision.ts";
import { ensureManagedToolsOnPath } from "../../cli/src/interpreters.ts";
import { gatherSignals } from "../../cli/src/triggers.ts";
import { discoverArtifacts, type ArtifactFile } from "./artifacts.ts";
import { runOutcome } from "./run-outcome.ts";
import { currentModelConfig, currentVisionConfig } from "./model-config.ts";
import { WebSessionStore } from "./session-store.ts";
import { hydrateToolOutputs, sanitizeToolOutput } from "./tool-output.ts";
import type {
  ChatMessage,
  ChatSession,
  MessageBlock,
  ResearchTrace,
  SessionSummary,
  ToolStep,
  TransportEvent,
} from "../src/types.ts";

const HOST = "127.0.0.1";
const PORT = Number(process.env.OMNISCI_GATEWAY_PORT ?? 4318);
const TOKEN = process.env.OMNISCI_WEB_TOKEN;
// 工作区必须由调用方明确给出。默认取 cwd 而不是仓库上级目录：后者会让一个
// 忘了传参的启动把整个上级目录暴露成可读写范围。
const WORKSPACE_ROOT = resolve(process.env.OMNISCI_WORKSPACE_ROOT ?? process.cwd());
/**
 * 桌面版的通道和模型由用户在界面上配，存在 model-config 里，所以这里不能写死。
 * 一个会话建起来之后用的是它自己那个 ModelClient，改配置不影响已经在跑的会话。
 */
function defaultModelName(): string {
  return currentModelConfig()?.model ?? "未配置";
}

/**
 * 眼睛也一样由界面配。vision.ts 默认从环境变量读，那对桌面版没用：它的 key 是
 * 用户在界面上填的，从来没进过环境。装一个解析器，让 view_image 每次现问。
 */
setVisionResolver(() => {
  const vision = currentVisionConfig();
  if (!vision) {
    throw new Error("还没有配置视觉模型。点左下角设置，在「视觉模型」里选一个并填上它的 key。");
  }
  return {
    provider: vision.provider,
    model: vision.model,
    apiKey: vision.apiKey,
    baseUrl: vision.baseUrl,
    ...(vision.effort ? { effort: vision.effort } : {}),
  };
});
const DB_PATH = join(OMNI_HOME, "web-sessions.db");
// CLI 那一份 skill，不是仓库根 skill/ 那份，两者不可互换。
const SKILL_BIN = resolve(
  process.env.OMNISCI ?? resolve(import.meta.dir, "../../cli/skills/omnisci/bin"),
);

if (!existsSync(join(SKILL_BIN, "gate_cli.py"))) {
  throw new Error(`OmniScientist CLI 缺失: ${join(SKILL_BIN, "gate_cli.py")}`);
}
process.env.OMNISCI = SKILL_BIN;

if (!TOKEN) {
  throw new Error("OMNISCI_WEB_TOKEN 未设置。请通过 bun run dev:local 启动本地工作区。");
}

interface WebRuntime {
  id: string;
  internalId: string;
  title: string;
  preview: string;
  updatedAtIso: string;
  status: "running" | "complete" | "idle";
  model: ModelClient;
  registry: Registry;
  session: Session;
  standards: StandardsEngine;
  skills: Skill[];
  messages: unknown[];
  chatMessages: ChatMessage[];
  injected: Set<string>;
  active: boolean;
  artifactFiles: Map<string, ArtifactFile>;
  /**
   * 用户在界面上选的数据目录，相对工作区根。空串表示就用根。
   * gate 拿它当 --task 去找 series.json，论文和 ledger 也写在那儿。
   */
  dataPath: string;
  persistTimer?: ReturnType<typeof setTimeout>;
  /**
   * 这一轮的中止闸。停止按钮、关掉浏览器、进程退出都拨它。
   * AgentLoop 只在"消息数组合法"的位置响应，所以停下来之后还能接着聊。
   */
  abort?: AbortController;
  /** 浏览器断开后的宽限定时器。页面在宽限期内回来就取消，真走了才拨闸。 */
  disconnectTimer?: ReturnType<typeof setTimeout>;
}

const runtimes = new Map<string, WebRuntime>();
const guardConfig = loadGuardConfig();
const preToolUseHooks = loadHooks();

function nowLabel(): string {
  return new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}

function publicContent(value: string, limit = 200_000): string {
  return value
    .replaceAll(WORKSPACE_ROOT, "$WORKSPACE")
    .replaceAll(OMNI_HOME, "~/.omnisci")
    .replace(/\b(sk-[A-Za-z0-9_-]{8})[A-Za-z0-9_-]+\b/g, "$1...")
    .replace(/\b((?:OPENAI|ANTHROPIC|DEEPSEEK|GEMINI|GOOGLE)_API_KEY)\s*=\s*\S+/gi, "$1=[redacted]")
    .replace(/\/(?:home|Users|tmp|var\/folders)\/[^\s`"'()<>{}\[\]]+/g, "$LOCAL_PATH")
    .trim()
    .slice(0, limit);
}

function publicText(value: string, limit = 240): string {
  return publicContent(value, Math.max(limit * 4, limit))
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);
}

function publicToolStep(step: ToolStep): ToolStep {
  const { output, outputTruncated: _outputTruncated, ...visible } = step;
  const sanitized = sanitizeToolOutput(output, step.tool, "", publicContent);
  return {
    ...visible,
    detail: publicText(step.detail),
    ...sanitized,
    ...(step.outputTruncated && sanitized.output ? { outputTruncated: true } : {}),
  };
}

const webSessions = new WebSessionStore(
  DB_PATH,
  WORKSPACE_ROOT,
  basename(WORKSPACE_ROOT),
  defaultModelName(),
  publicContent,
);

function toolLabel(name: string): string {
  const labels: Record<string, string> = {
    list_dir: "查看目录结构",
    read_file: "读取研究文件",
    grep_files: "检索工作区",
    write_file: "写入研究产物",
    edit_file: "更新研究产物",
    bash: "运行分析命令",
    run_python: "运行 Python 分析",
    use_skill: "加载研究 Skill",
    explore: "检查相关上下文",
    look_at_image: "审阅图像",
    compile_paper: "编译论文",
    finalize_results: "校验研究结果",
  };
  return labels[name] ?? name.replaceAll("_", " ");
}

function skillDisplayName(raw: string): string {
  const name = publicText(raw, 80) || "未知 Skill";
  return name.toLowerCase() === "omnisci" || name.toLowerCase() === "omniscientist"
    ? "OmniScientist（论文研究）"
    : name;
}

function toolDetail(name: string, summary: string): string {
  if (name === "bash") return "执行已脱敏的分析命令";
  if (name === "use_skill") return `Loading skill · ${skillDisplayName(summary)}`;
  try {
    const args = JSON.parse(summary) as Record<string, unknown>;
    if (name === "list_dir") {
      const path = String(args.path ?? ".");
      return path === "." ? "浏览工作区顶层" : `浏览 ${publicText(path, 100)}`;
    }
    if (name === "read_file") return `读取 ${publicText(String(args.path ?? "研究文件"), 100)}`;
    if (name === "grep_files") return "检索工作区中的相关内容";
    if (name === "write_file" || name === "edit_file") {
      return `更新 ${publicText(String(args.path ?? "研究产物"), 100)}`;
    }
    return `正在执行${toolLabel(name)}`;
  } catch {
    return publicText(summary) || `正在执行${toolLabel(name)}`;
  }
}

function summaryOf(runtime: WebRuntime): SessionSummary {
  return webSessions.summary({
    internalId: runtime.internalId,
    dataPath: runtime.dataPath,
    title: runtime.title,
    preview: runtime.preview,
    updatedAt: runtime.updatedAtIso,
    status: runtime.status,
    workspace: basename(WORKSPACE_ROOT),
    model: runtime.model.model,
    messages: runtime.chatMessages,
  });
}

function chatOf(runtime: WebRuntime): ChatSession {
  return { ...summaryOf(runtime), messages: persistedMessages(runtime) };
}

function persistedMessages(runtime: WebRuntime): ChatMessage[] {
  return runtime.chatMessages.map((message) => ({
    ...message,
    content: publicContent(message.content),
    blocks: message.blocks?.map((block) => block.type === "markdown"
      ? { ...block, content: publicContent(block.content) }
      : { ...block, step: publicToolStep(block.step) }),
    toolRun: message.toolRun
      ? {
          ...message.toolRun,
          steps: message.toolRun.steps.map(publicToolStep),
        }
      : undefined,
    artifacts: message.artifacts?.map((artifact) => ({
      ...artifact,
      path: publicText(artifact.path, 240),
      detail: publicText(artifact.detail, 500),
      content: artifact.content ? publicContent(artifact.content) : undefined,
      caption: artifact.caption ? publicContent(artifact.caption, 4_000) : undefined,
      altText: artifact.altText ? publicText(artifact.altText, 500) : undefined,
    })),
  }));
}

function persistRuntime(runtime: WebRuntime, touch = false): void {
  if (runtime.persistTimer) {
    clearTimeout(runtime.persistTimer);
    runtime.persistTimer = undefined;
  }
  if (touch) runtime.updatedAtIso = new Date().toISOString();
  webSessions.save(runtime.internalId, {
    title: runtime.title,
    preview: runtime.preview,
    updatedAt: runtime.updatedAtIso,
    status: runtime.status,
    messages: persistedMessages(runtime),
    dataPath: runtime.dataPath,
  });
}

function persistRuntimeSoon(runtime: WebRuntime): void {
  if (runtime.persistTimer) clearTimeout(runtime.persistTimer);
  runtime.persistTimer = setTimeout(() => persistRuntime(runtime), 180);
}

async function createRuntime(preferredId?: string): Promise<WebRuntime> {
  if (preferredId && runtimes.has(preferredId)) return runtimes.get(preferredId)!;

  const configured = currentModelConfig();
  if (!configured) {
    throw new Error("还没有配置模型 API key。点左下角的设置填一个，再开始研究。");
  }
  const model = new ModelClient({
    provider: configured.provider,
    model: configured.model,
    apiKey: configured.apiKey,
    baseURL: configured.baseUrl,
    ...(configured.effort ? { effort: configured.effort } : {}),
  });
  const requestedInternalId = preferredId?.startsWith("local-")
    ? preferredId.slice("local-".length)
    : undefined;
  if (preferredId && (!requestedInternalId || !/^[A-Za-z0-9]+$/.test(requestedInternalId))) {
    throw new Error("本地会话 ID 无效");
  }
  if (requestedInternalId && !webSessions.hasRawSession(requestedInternalId)) {
    throw new Error("没有这个本地会话");
  }
  const session = Session.open(DB_PATH, WORKSPACE_ROOT, model.model, requestedInternalId);
  const id = `local-${session.id}`;
  const stored = requestedInternalId ? webSessions.load(requestedInternalId) : undefined;
  const standards = new StandardsEngine();
  const skills = loadSkills();
  let registry: Registry;
  registry = await defaultRegistry([
    makeExploreTool(model, () => registry, () => ({
      guard: { root: WORKSPACE_ROOT, config: guardConfig },
      hooks: preToolUseHooks,
    })),
    makeUseSkillTool(() => skills),
  ]);

  const alwaysOn = standards.asPromptBlock(
    standards.active(gatherSignals(WORKSPACE_ROOT, "")).filter((item) => item.standard.always),
  );
  const { systemPrompt } = buildSystemPrompt(
    model.model,
    WORKSPACE_ROOT,
    alwaysOn,
    skillsPromptBlock(skills),
  );

  // 老会话可能带着"有 tool_calls 却缺回执"的旧伤，那种会话每次发消息都被判 400。
  // 补洞在 session.history() 里做（CLI 的 resume 走同一条路），这里只负责说出来。
  const history = requestedInternalId
    ? session.history((n) => console.log(`[omnisci] 修补了 ${n} 条缺失的工具回执`))
    : [];
  const messages = history.some((message) => (
    message as { role?: unknown }
  ).role === "system")
    ? history
    : [{ role: "system", content: systemPrompt }, ...history];

  const restoredStatus = stored?.status === "running" ? "idle" : stored?.status;

  const runtime: WebRuntime = {
    id,
    internalId: session.id,
    title: stored?.title ?? "新研究会话",
    preview: stored?.preview ?? "等待你的问题",
    updatedAtIso: stored?.updatedAt ?? new Date().toISOString(),
    status: restoredStatus ?? "idle",
    model,
    registry,
    session,
    standards,
    skills,
    messages,
    chatMessages: stored?.messages ?? [],
    injected: new Set(),
    active: false,
    artifactFiles: new Map(),
    dataPath: stored?.dataPath ?? "",
  };
  runtimes.set(id, runtime);
  hydrateToolOutputs(
    runtime.chatMessages,
    runtime.messages,
    publicContent,
    webSessions.toolResults(runtime.internalId),
  );
  syncRuntimeArtifacts(runtime);
  persistRuntime(runtime);
  return runtime;
}

type Emit = (event: TransportEvent) => void;

function syncRuntimeArtifacts(runtime: WebRuntime, messageId?: string, emit?: Emit): void {
  const discovered = discoverArtifacts(
    WORKSPACE_ROOT,
    runtime.dataPath ? resolve(WORKSPACE_ROOT, runtime.dataPath) : WORKSPACE_ROOT,
    runtime.id,
    runtime.messages,
  );
  runtime.artifactFiles = discovered.files;
  for (const message of runtime.chatMessages) message.artifacts = undefined;
  const target = messageId
    ? runtime.chatMessages.find((message) => message.id === messageId)
    : [...runtime.chatMessages].reverse().find((message) => message.role === "assistant");
  if (!target || !discovered.artifacts.length) return;
  target.artifacts = discovered.artifacts;
  emit?.({
    type: "artifacts.updated",
    messageId: target.id,
    artifacts: discovered.artifacts,
  });
}

interface PresenterSnapshot {
  content: string;
  steps: ToolStep[];
  blocks: MessageBlock[];
  progress: NonNullable<ChatMessage["progress"]>;
}

function makePresenter(
  messageId: string,
  emit: Emit,
  onChange: (snapshot: PresenterSnapshot, immediate: boolean) => void,
) {
  const steps: ToolStep[] = [];
  const blocks: MessageBlock[] = [];
  const startedAt = new Map<string, number[]>();
  const toolSources = new Map<string, string>();
  let content = "";
  let sequence = 0;
  let writing = false;
  let progress: PresenterSnapshot["progress"] = "thinking";

  const publish = (immediate: boolean) => onChange({
    content,
    steps: steps.map((step) => ({ ...step })),
    blocks: blocks.map((block) => block.type === "tool"
      ? { ...block, step: { ...block.step } }
      : { ...block }),
    progress,
  }, immediate);

  const appendText = (chunk: string) => {
    const last = blocks.at(-1);
    if (last?.type === "markdown") {
      last.content += chunk;
    } else {
      blocks.push({
        id: `${messageId}-markdown-${blocks.length + 1}`,
        type: "markdown",
        content: chunk,
      });
      if (content && !content.endsWith("\n\n")) content += content.endsWith("\n") ? "\n" : "\n\n";
    }
    content += chunk;
  };

  const presenter: Presenter = {
    turnStart() {
      writing = false;
      progress = "thinking";
      emit({ type: "assistant.phase", messageId, phase: "thinking" });
      publish(true);
    },
    textDelta(chunk) {
      if (!writing) {
        writing = true;
        progress = "writing";
        emit({ type: "assistant.phase", messageId, phase: "writing" });
      }
      appendText(chunk);
      emit({ type: "assistant.delta", messageId, delta: chunk });
      publish(false);
    },
    textDone() {},
    toolStart(name, summary) {
      const id = `${messageId}-tool-${++sequence}`;
      const step: ToolStep = {
        id,
        tool: name,
        label: toolLabel(name),
        detail: toolDetail(name, summary),
        status: "running",
      };
      steps.push(step);
      blocks.push({ id: `${id}-block`, type: "tool", step });
      toolSources.set(id, summary);
      const queue = startedAt.get(name) ?? [];
      queue.push(Date.now());
      startedAt.set(name, queue);
      progress = "tool";
      emit({ type: "assistant.phase", messageId, phase: "tool" });
      emit({ type: "tool.started", messageId, step: { ...step } });
      publish(true);
    },
    toolResult(name, ok, detail, output) {
      const step = [...steps].reverse().find((item) => item.tool === name && item.status === "running");
      if (!step) return;
      const queue = startedAt.get(name) ?? [];
      const start = queue.shift() ?? Date.now();
      step.status = ok ? "complete" : "failed";
      if (name === "use_skill") {
        const skill = step.detail.replace(/^Loading skill · /, "");
        step.detail = ok
          ? `Loaded skill · ${skill}`
          : `Skill 加载失败 · ${skill}`;
      } else {
        step.detail = publicText(detail) || (ok ? "已完成" : "执行失败");
      }
      Object.assign(step, sanitizeToolOutput(output, name, toolSources.get(step.id) ?? "", publicContent));
      step.duration = `${((Date.now() - start) / 1000).toFixed(1)}s`;
      emit({ type: "tool.finished", messageId, step: { ...step } });
      publish(true);
    },
    note(text) {
      const delta = `\n\n> ${publicText(text)}\n\n`;
      appendText(delta);
      emit({ type: "assistant.delta", messageId, delta });
      publish(false);
    },
  };

  return { presenter, steps, blocks, content: () => content };
}

function traceOf(messageId: string, steps: ToolStep[]): ResearchTrace | undefined {
  if (!steps.length) return undefined;
  return {
    id: `${messageId}-trace`,
    stage: "本地实时运行",
    title: "本轮工具轨迹",
    summary: `${steps.length} calls · 参数摘要与状态已脱敏`,
    entries: steps.map((step, index) => ({
      id: `${step.id}-trace`,
      sequence: index + 1,
      phase: "AgentLoop",
      tool: step.tool,
      label: step.label,
      detail: step.detail,
      output: `${step.status === "failed" ? "失败" : "完成"}${step.duration ? ` · ${step.duration}` : ""}`,
      status: step.status === "failed" ? "failed" : "complete",
      importance: step.status === "failed" ? "issue" : "normal",
    })),
  };
}

async function runMessage(runtime: WebRuntime, userText: string, emit: Emit): Promise<void> {
  // 每轮都刷一次：tectonic 常常是在应用起来之后才被装进 <dataDir>/bin 的
  // （安装文档就是这么写的），只在启动时算一次的话，装了也用不上，
  // 一轮跑完停在 .tex 不出 PDF。
  ensureManagedToolsOnPath();
  const messageId = `assistant-${crypto.randomUUID()}`;
  const userMessage: ChatMessage = {
    id: `user-${crypto.randomUUID()}`,
    role: "user",
    author: "你",
    time: nowLabel(),
    content: userText,
  };
  runtime.chatMessages.push(userMessage);
  if (!runtime.chatMessages.some((message) => message !== userMessage && message.role === "user")) {
    runtime.title = publicText(userText, 42) || "新研究会话";
  }
  runtime.preview = publicText(userText, 80);
  runtime.status = "running";
  persistRuntime(runtime, true);

  const draft: ChatMessage = {
    id: messageId,
    role: "assistant",
    author: "OmniScientist",
    time: nowLabel(),
    content: "",
    blocks: [],
    progress: "thinking",
  };
  runtime.chatMessages.push(draft);
  persistRuntime(runtime);
  emit({ type: "assistant.started", messageId });

  const fresh = runtime.standards
    .active(gatherSignals(WORKSPACE_ROOT, userText))
    .filter((item) => !item.standard.always && !runtime.injected.has(item.standard.name));
  let modelContent = userText;
  // 选中的数据目录只进模型看的那份，不进用户那条消息：它是界面上的一个选择，
  // 不是用户打的字。每轮都带一次，几十个 token 换掉"模型跑着跑着忘了 case 在哪"。
  if (runtime.dataPath) {
    modelContent = `${modelContent}\n\n<数据目录>${runtime.dataPath}</数据目录>\n` +
      `这一轮的 case 根目录就是它：series.json 在里面，omnisci_record / compile_paper 会以它为 --task，` +
      `产物写在 ${runtime.dataPath}/host 下。`;
  }
  if (fresh.length) {
    modelContent = `${modelContent}\n\n<适用规矩>\n${runtime.standards.asPromptBlock(fresh)}</适用规矩>`;
    for (const item of fresh) runtime.injected.add(item.standard.name);
    runtime.session.recordStandards(
      fresh.map((item) => [item.standard.name, item.reason] as [string, string]),
    );
  }

  runtime.session.turn += 1;
  const modelMessage = { role: "user", content: modelContent };
  runtime.messages.push(modelMessage);
  runtime.session.record("user", modelMessage);

  const live = makePresenter(messageId, emit, (snapshot, immediate) => {
    draft.content = snapshot.content.trim();
    draft.blocks = snapshot.blocks;
    draft.progress = snapshot.progress;
    draft.toolRun = snapshot.steps.length
      ? {
          title: "正在研究",
          summary: snapshot.steps.some((step) => step.status === "running")
            ? "工具运行中"
            : "正在整理结果",
          steps: snapshot.steps,
        }
      : undefined;
    if (immediate) persistRuntime(runtime, true);
    else persistRuntimeSoon(runtime);
  });
  const loop = new AgentLoop(
    runtime.model,
    runtime.registry,
    makeContext(WORKSPACE_ROOT, undefined, runtime.dataPath || undefined),
    new ApprovalPolicy(true),
    live.presenter,
    (message) => {
      runtime.session.record((message as { role?: string }).role ?? "?", message);
      syncRuntimeArtifacts(runtime, messageId, emit);
      persistRuntime(runtime, true);
    },
    {
      guard: { root: WORKSPACE_ROOT, config: guardConfig },
      hooks: preToolUseHooks,
      sessionId: runtime.session.id,
      noAsk: true,
    },
  );
  let result: Awaited<ReturnType<AgentLoop["run"]>>;
  try {
    // 跟 CLI 的 --data 一条路：浏览器里跑一篇论文同样是长流水线，没人会在
    // 中途打字说"继续"。用默认的 80 轮会在感知做完、论文没编时被砍断。
    result = await loop.run(runtime.messages, UNATTENDED_MAX_TURNS, runtime.abort?.signal);
  } catch (error) {
    const detail = errorMessage(error);
    const failure = `本地研究运行失败：${detail}`;
    const steps = live.steps.map((step) => step.status === "running"
      ? { ...step, status: "failed" as const, detail: "运行中断" }
      : { ...step });
    draft.content = failure;
    draft.blocks = [{ id: `${messageId}-error`, type: "markdown", content: failure }];
    draft.progress = "complete";
    draft.toolRun = steps.length
      ? {
          title: "研究运行中断",
          summary: `${steps.length} 个步骤 · 请检查本地配置`,
          steps,
          trace: traceOf(messageId, steps),
        }
      : undefined;
    runtime.status = "idle";
    runtime.preview = "本地运行失败";
    persistRuntime(runtime, true);
    emit({ type: "run.failed", messageId, error: detail });
    return;
  }
  const steps = live.steps.map((step) => step.status === "running"
    ? { ...step, status: "failed" as const, detail: "已停止" }
    : { ...step });
  const outcome = runOutcome(result);
  const answer: ChatMessage = {
    id: messageId,
    role: "assistant",
    author: "OmniScientist",
    time: nowLabel(),
    content: `${publicContent(live.content())}${outcome.note}`.trim(),
    blocks: live.blocks.map((block) => block.type === "tool"
      ? { ...block, step: { ...block.step } }
      : { ...block, content: publicContent(block.content) }),
    progress: "complete",
    ...(steps.length
      ? {
          toolRun: {
            title: outcome.title,
            summary: `${steps.length} 个步骤 · ${result.turns} 轮${outcome.summarySuffix}`,
            steps,
            trace: traceOf(messageId, steps),
          },
        }
      : {}),
  };
  const draftIndex = runtime.chatMessages.findIndex((message) => message.id === messageId);
  if (draftIndex >= 0) runtime.chatMessages[draftIndex] = answer;
  else runtime.chatMessages.push(answer);
  syncRuntimeArtifacts(runtime, messageId, emit);
  runtime.status = outcome.status;
  runtime.preview = outcome.preview;
  persistRuntime(runtime, true);
  emit({ type: "assistant.completed", message: answer });
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function errorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  if (raw.includes("API key") || raw.includes("API")) {
    return "本地后端没有可用的模型凭据，请先配置 DeepSeek API key。";
  }
  if (raw.includes("fetch failed") || raw.includes("timeout")) {
    return "模型服务暂时无法连接，请检查本机网络后重试。";
  }
  return publicText(raw, 300) || "本地研究运行失败。";
}

export const SESSION_COOKIE = "omnisci_session";

/**
 * 两条认证路径，都要有，别删其中一条：
 *   header  开发模式下 vite 代理注入，浏览器里根本看不到 token
 *   cookie  桌面版里浏览器直连本服务，token 在首次 URL 上兑换成 HttpOnly cookie
 * cookie 是 SameSite=Strict，所以别的站点发不出带凭据的跨站请求。
 */
function authorized(request: Request): boolean {
  if (request.headers.get("x-omnisci-token") === TOKEN) return true;
  const raw = request.headers.get("cookie");
  if (!raw) return false;
  for (const part of raw.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === SESSION_COOKIE && part.slice(eq + 1).trim() === TOKEN) return true;
  }
  return false;
}

export interface WorkspaceEntry {
  name: string;
  kind: "dir" | "file";
  /** 文件的字节数；目录的直接子项个数。 */
  size: number;
}

export interface WorkspaceListing {
  /** 相对工作区根的路径，根就是空串。 */
  path: string;
  /** 上一级；已经在根上就是 null。 */
  parent: string | null;
  root: string;
  entries: WorkspaceEntry[];
  /** 条目太多时截断了多少个，界面要如实说。 */
  truncated: number;
}

const MAX_ENTRIES = 500;

/**
 * 列工作区里的一层目录。
 *
 * 越界检查用 realpath 之后比前缀，不是拼字符串：符号链接、`..`、以及
 * `/root-evil` 这种同前缀不同目录的名字，都得挡住。
 */
/** 对外一律用正斜杠。Windows 上 relative() 给的是反斜杠，而界面按 "/" 拼路径。 */
const toPosix = (value: string): string => value.split(sep).join("/");

function listWorkspace(rel: string): WorkspaceListing {
  const rootReal = realpathSync(WORKSPACE_ROOT);
  // 界面传来的永远是正斜杠；Windows 的 resolve 两种分隔符都收，这里不用转。
  const target = resolve(WORKSPACE_ROOT, rel);
  if (!existsSync(target)) throw new Error(`没有这个目录：${rel || "."}`);
  const targetReal = realpathSync(target);
  if (targetReal !== rootReal && !targetReal.startsWith(rootReal + sep)) {
    throw new Error("只能浏览工作区内部");
  }
  if (!statSync(targetReal).isDirectory()) throw new Error("这不是目录");

  const all = readdirSync(targetReal).filter((name) => !name.startsWith(".")).sort();

  const entries: WorkspaceEntry[] = [];
  for (const name of all.slice(0, MAX_ENTRIES)) {
    const full = join(targetReal, name);
    try {
      // statSync 跟着符号链接走，不用 Dirent.isDirectory()：后者对"指向目录的
      // 链接"返回 false，于是链接过去的数据集会显示成文件，点了也进不去。
      // 链接指到工作区外面也无所谓，进去的时候上面那道 realpath 检查会拦。
      const stat = statSync(full);
      entries.push(
        stat.isDirectory()
          ? { name, kind: "dir", size: readdirSync(full).length }
          : { name, kind: "file", size: stat.size },
      );
    } catch {
      // 读不动的条目（权限、断链、竞态删除）跳过就好，不该让整个列表 500。
    }
  }
  entries.sort((a, b) => {
    const dirDelta = Number(b.kind === "dir") - Number(a.kind === "dir");
    return dirDelta !== 0 ? dirDelta : a.name.localeCompare(b.name);
  });

  const here = toPosix(relative(rootReal, targetReal));
  return {
    path: here,
    parent: here ? toPosix(dirname(here)).replace(/^\.$/, "") : null,
    root: basename(rootReal),
    entries,
    truncated: Math.max(0, all.length - MAX_ENTRIES),
  };
}

/**
 * 只处理 /api/v1/*，别的一律 404。桌面版启动器把静态资源和进程级接口叠在它外面，
 * 所以这里必须是个纯函数，不能在模块体里自己 listen。
 */
export const apiFetch = async (request: Request): Promise<Response> => {
  {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/v1/")) return new Response("Not found", { status: 404 });
    if (!authorized(request)) return json({ error: "Unauthorized" }, 401);

    if (request.method === "GET" && url.pathname === "/api/v1/health") {
      return json({
        ok: true,
        model: defaultModelName(),
        workspace: basename(WORKSPACE_ROOT),
        omnisci: { ready: true },
      });
    }

    // 浏览工作区，给"选数据"用。浏览器的 <input type=file> 只给文件名不给路径，
    // 而 agent 要的是工作区内的相对路径，所以目录树只能由这边列。
    if (request.method === "GET" && url.pathname === "/api/v1/workspace") {
      try {
        return json(listWorkspace(url.searchParams.get("path") ?? ""));
      } catch (error) {
        return json({ error: errorMessage(error) }, 400);
      }
    }

    if (request.method === "GET" && url.pathname === "/api/v1/sessions") {
      return json(webSessions.list().map((stored) => webSessions.summary(stored)));
    }

    if (request.method === "POST" && url.pathname === "/api/v1/sessions") {
      try {
        const runtime = await createRuntime();
        return json(chatOf(runtime), 201);
      } catch (error) {
        return json({ error: errorMessage(error) }, 503);
      }
    }

    const stopMatch = /^\/api\/v1\/sessions\/([^/]+)\/stop$/.exec(url.pathname);
    if (request.method === "POST" && stopMatch) {
      const runtime = runtimes.get(decodeURIComponent(stopMatch[1]!));
      if (!runtime) return json({ error: "没有这个本地会话" }, 404);
      if (!runtime.active) return json({ stopped: false, reason: "这个会话没有在跑" });
      runtime.abort?.abort();
      return json({ stopped: true });
    }

    const sessionMatch = /^\/api\/v1\/sessions\/([^/]+)$/.exec(url.pathname);
    if (request.method === "GET" && sessionMatch) {
      const id = decodeURIComponent(sessionMatch[1]!);
      // 刷新后的页面一定会先来拉这个会话。人回来了，取消断线宽限的拨闸。
      const reattached = runtimes.get(id);
      if (reattached?.disconnectTimer) {
        clearTimeout(reattached.disconnectTimer);
        reattached.disconnectTimer = undefined;
      }
      try {
        const runtime = runtimes.get(id) ?? await createRuntime(id);
        return json(chatOf(runtime));
      } catch (error) {
        return json({ error: errorMessage(error) }, 404);
      }
    }

    const artifactMatch = /^\/api\/v1\/sessions\/([^/]+)\/artifacts\/([^/]+)\/content$/.exec(url.pathname);
    if (request.method === "GET" && artifactMatch) {
      const id = decodeURIComponent(artifactMatch[1]!);
      const token = decodeURIComponent(artifactMatch[2]!);
      try {
        const runtime = runtimes.get(id) ?? await createRuntime(id);
        syncRuntimeArtifacts(runtime);
        const file = runtime.artifactFiles.get(token);
        if (!file) return json({ error: "没有这个会话产物" }, 404);
        return new Response(Bun.file(file.absolutePath), {
          headers: {
            "Cache-Control": "private, max-age=31536000, immutable",
            "Content-Type": file.contentType,
            "Content-Disposition": `inline; filename="${file.filename.replaceAll('"', "")}"`,
            "X-Content-Type-Options": "nosniff",
          },
        });
      } catch (error) {
        return json({ error: errorMessage(error) }, 404);
      }
    }

    const messageMatch = /^\/api\/v1\/sessions\/([^/]+)\/messages$/.exec(url.pathname);
    if (request.method === "POST" && messageMatch) {
      if (!request.headers.get("content-type")?.startsWith("application/json")) {
        return json({ error: "Content-Type 必须是 application/json" }, 415);
      }
      let body: { content?: unknown; dataPath?: unknown };
      try {
        body = await request.json() as { content?: unknown; dataPath?: unknown };
      } catch {
        return json({ error: "请求 JSON 无效" }, 400);
      }
      const content = typeof body.content === "string" ? body.content.trim() : "";
      if (!content || content.length > 20_000) return json({ error: "消息为空或过长" }, 400);
      const wantedData = typeof body.dataPath === "string" ? body.dataPath.trim() : "";
      // 界面传来的路径不能白信：一样按工作区边界校验，越界直接拒。
      if (wantedData) {
        try {
          listWorkspace(wantedData);
        } catch (error) {
          return json({ error: `数据目录用不了：${errorMessage(error)}` }, 400);
        }
      }

      let runtime: WebRuntime;
      try {
        const requestedId = decodeURIComponent(messageMatch[1]!);
        runtime = runtimes.get(requestedId) ?? await createRuntime(requestedId);
      } catch (error) {
        return json({ error: errorMessage(error) }, 503);
      }
      if (runtime.active) return json({ error: "这个会话已有一轮研究正在运行" }, 409);
      // 只有界面真的选了目录才覆盖。续聊时前端不一定重发，
      // 无条件赋值会把已经记住的 case 目录抹掉，产物又找不到了。
      if (wantedData) runtime.dataPath = wantedData;
      clearTimeout(runtime.disconnectTimer);
      runtime.disconnectTimer = undefined;
      runtime.abort = new AbortController();
      runtime.active = true;

      const encoder = new TextEncoder();
      let streamClosed = false;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const emit: Emit = (event) => {
            if (streamClosed) return;
            try {
              controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
            } catch {
              streamClosed = true;
            }
          };
          void runMessage(runtime, content, emit)
            .catch((error) => {
              const detail = errorMessage(error);
              const pending = [...runtime.chatMessages]
                .reverse()
                .find((message) => message.role === "assistant" && message.progress !== "complete");
              const messageId = pending?.id ?? `failed-${crypto.randomUUID()}`;
              const failure = `本地研究运行失败：${detail}`;
              const failureMessage: ChatMessage = {
                id: messageId,
                role: "assistant",
                author: "OmniScientist",
                time: nowLabel(),
                content: failure,
                blocks: [{ id: `${messageId}-error`, type: "markdown", content: failure }],
                progress: "complete",
              };
              if (pending) Object.assign(pending, failureMessage);
              else runtime.chatMessages.push(failureMessage);
              runtime.status = "idle";
              runtime.preview = "本地运行失败";
              persistRuntime(runtime, true);
              emit({ type: "run.failed", messageId, error: detail });
            })
            .finally(() => {
              clearTimeout(runtime.disconnectTimer);
              runtime.disconnectTimer = undefined;
              runtime.active = false;
              if (runtime.status === "running") {
                runtime.status = "idle";
                persistRuntime(runtime, true);
              }
              if (!streamClosed) {
                streamClosed = true;
                try { controller.close(); } catch { /* The browser already disconnected. */ }
              }
            });
        },
        cancel() {
          streamClosed = true;
          // 两个坑都踩过才有这段。最早断开只停推送，AgentLoop 在服务端跑到底，
          // 关掉标签页之后模型照调、钱照烧；改成立刻拨闸之后，一次无辜的刷新
          // 又会把跑了半小时的运行当场打死。所以给 30 秒宽限：页面回来
          //（重新拉会话）就取消，真没人回来才停。
          clearTimeout(runtime.disconnectTimer);
          runtime.disconnectTimer = setTimeout(() => {
            runtime.disconnectTimer = undefined;
            runtime.abort?.abort();
          }, 30_000);
        },
      });
      return new Response(stream, {
        headers: {
          "Content-Type": "application/x-ndjson; charset=utf-8",
          "Cache-Control": "no-store, no-transform",
          "X-Content-Type-Options": "nosniff",
        },
      });
    }

    return json({ error: "Not found" }, 404);
  }
};

/** 把还活着的会话落盘。桌面版启动器退出前也要调，别只挂在信号处理里。 */
export function closeSessions() {
  for (const runtime of runtimes.values()) {
    persistRuntime(runtime);
    runtime.session.close();
  }
  webSessions.close();
}

// 直接 `bun run gateway/server.ts` 时自己 listen（开发模式，vite 代理打到这里）。
// 桌面版把 apiFetch 叠进自己的服务器，不走这一段。
if (import.meta.main) {
  const server = Bun.serve({ hostname: HOST, port: PORT, idleTimeout: 255, fetch: apiFetch });
  process.stdout.write(
    `OmniScientist local gateway: http://${server.hostname}:${server.port} · ${WORKSPACE_ROOT}\n`,
  );
  const shutdown = () => {
    closeSessions();
    server.stop(true);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
