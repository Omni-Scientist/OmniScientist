import { demoSessionSummaries, getDemoSession } from "../data/demo";
import type {
  ChatMessage,
  ChatSession,
  ResearchTransport,
  ToolStep,
  TransportEvent,
} from "../types";
import { t } from "./i18n";

const wait = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

export const mockTransport: ResearchTransport = {
  async listSessions() {
    return structuredClone(demoSessionSummaries);
  },

  async getSession(id: string) {
    await wait(120);
    return getDemoSession(id);
  },

  async createSession(workspace: string): Promise<ChatSession> {
    const id = `local-${Date.now()}`;
    return {
      id,
      title: t("新研究会话"),
      preview: t("等待你的问题"),
      updatedAt: t("刚刚"),
      group: "今天",
      status: "idle",
      workspace,
      model: "deepseek-v4-flash",
      messages: [],
    };
  },

  async *sendMessage(_sessionId: string, content: string): AsyncGenerator<TransportEvent> {
    const messageId = `assistant-${Date.now()}`;
    yield { type: "assistant.started", messageId };
    yield { type: "assistant.phase", messageId, phase: "thinking" };
    await wait(420);

    const intro = t("我先检查当前工作区，再整理可用证据。") + "\n\n";
    yield { type: "assistant.phase", messageId, phase: "writing" };
    yield { type: "assistant.delta", messageId, delta: intro };
    await wait(180);

    const skillStep: ToolStep = {
      id: `${messageId}-skill`,
      tool: "use_skill",
      label: t("加载研究 Skill"),
      detail: t("Loading skill · OmniScientist（论文研究）"),
      status: "running",
    };
    yield { type: "assistant.phase", messageId, phase: "tool" };
    yield { type: "tool.started", messageId, step: skillStep };
    await wait(320);
    const loadedSkillStep: ToolStep = {
      ...skillStep,
      status: "complete",
      detail: t("Loaded skill · OmniScientist（论文研究）"),
      duration: "0.3s",
    };
    yield { type: "tool.finished", messageId, step: loadedSkillStep };

    const inspectStep: ToolStep = {
      id: `${messageId}-inspect`,
      tool: "search_files",
      label: t("检查当前工作区"),
      detail: t("定位与问题相关的论文、数据和最近产物"),
      status: "running",
    };
    const inspectOutput = [
      "data/",
      "engine/examples/",
      "paper/main.tex  116275B",
      "release/papers/seismology.pdf  500105B",
    ].join("\n");
    yield { type: "assistant.phase", messageId, phase: "tool" };
    yield { type: "tool.started", messageId, step: inspectStep };
    await wait(620);
    yield {
      type: "tool.finished",
      messageId,
      step: {
        ...inspectStep,
        status: "complete",
        detail: t("已定位 8 个相关文件"),
        duration: "0.6s",
        output: inspectOutput,
      },
    };
    await wait(260);

    const answer = `### 请求已接收\n\n我已经收到你的要求：“${content.slice(0, 48)}${content.length > 48 ? "…" : ""}”。\n\n1. **运行模式**：演示 transport\n2. **联动位置**：本地 Bun gateway\n\n接入后，同一个位置会呈现真实 \`AgentLoop\` 事件和工作区产物。`;
    yield { type: "assistant.phase", messageId, phase: "writing" };
    for (const paragraph of answer.split("\n\n")) {
      yield { type: "assistant.delta", messageId, delta: `${paragraph}\n\n` };
      await wait(260);
    }

    const message: ChatMessage = {
      id: messageId,
      role: "assistant",
      author: "OmniScientist",
      time: new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }),
      content: `${intro}${answer}`,
      blocks: [
        { id: `${messageId}-intro`, type: "markdown", content: intro },
        { id: `${skillStep.id}-block`, type: "tool", step: loadedSkillStep },
        {
          id: `${inspectStep.id}-block`,
          type: "tool",
          step: {
            ...inspectStep,
            status: "complete",
            detail: t("已定位 8 个相关文件"),
            duration: "0.6s",
            output: inspectOutput,
          },
        },
        { id: `${messageId}-answer`, type: "markdown", content: answer },
      ],
      progress: "complete",
      toolRun: {
        title: t("研究运行完成"),
        summary: t("2 个步骤 · 演示模式"),
        steps: [
          loadedSkillStep,
          {
            ...inspectStep,
            status: "complete",
            detail: t("已定位 8 个相关文件"),
            duration: "0.6s",
            output: inspectOutput,
          },
        ],
      },
    };
    yield { type: "assistant.completed", message };
  },
};
