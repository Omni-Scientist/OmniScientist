/**
 * 子 agent。
 *
 * **价值是上下文隔离，不是并行加速。** 主循环最怕被探索性的工具输出撑爆：
 * 读二十个文件为了回答一句话，那二十份原文会永久占着窗口。
 * 子 agent 有自己的上下文，读完只把结论带回来，本质上是压缩的另一种形式。
 *
 * 所以它只给只读工具。要改文件、跑命令，回主循环让人过审批门。
 * 子 agent 绕过审批去写东西是安全事故，不是功能。
 */

import { ApprovalPolicy } from "./approval.ts";
import { AgentLoop, type Gate, type Presenter } from "./loop.ts";
import type { ModelClient } from "./model.ts";
import { Registry, type Tool, type ToolContext } from "./tools/index.ts";

/** 子 agent 能用的工具，全部只读。 */
const READONLY = new Set(["list_dir", "read_file", "grep_files", "read_more", "list_artifacts", "recall"]);

const SYSTEM = `你是一个只读的探索 agent。上级 agent 派你去查清楚一件事。

规则：
- 你只有只读工具。不要试图改文件或执行命令，你没有那些工具。
- 查清楚就回答，不要为了显得努力多读文件。
- 回答要能直接被上级使用：给结论、给证据（文件路径加行号）、给不确定的地方。
- 不要复述你读了什么，只说你查到了什么。
- 查不到就明说查不到，不要编。`;

/** 一个什么都不打印的 presenter：子 agent 的过程不该刷主屏。 */
class SilentPresenter implements Presenter {
  toolCalls = 0;
  turnStart(): void {}
  textDelta(): void {}
  textDone(): void {}
  toolStart(): void {
    this.toolCalls++;
  }
  toolResult(): void {}
}

export interface ExploreResult {
  answer: string;
  turns: number;
  toolCalls: number;
  promptTokens: number;
  completionTokens: number;
}

export async function explore(
  task: string,
  model: ModelClient,
  registry: Registry,
  ctx: ToolContext,
  gate: Gate = {},
  maxTurns = 12,
): Promise<ExploreResult> {
  // 只挑只读工具，不是把主注册表整个给它
  const sub = new Registry();
  for (const t of registry.list()) {
    if (READONLY.has(t.name)) sub.add(t);
  }

  const presenter = new SilentPresenter();
  // autoApprove 只免掉「要不要问」，免不掉硬拦截：gate 照样传进去。
  // noAsk 让「需要单独点头」的调用（比如读受保护路径）在这里直接变拒绝，
  // 而不是从一个静默的子 agent 里弹出一个没头没尾的审批框。
  const loop = new AgentLoop(
    model, sub, ctx, new ApprovalPolicy(true), presenter, () => {}, { ...gate, noAsk: true },
  );

  const messages: unknown[] = [
    { role: "system", content: SYSTEM },
    { role: "user", content: task },
  ];
  const result = await loop.run(messages, maxTurns);

  const last = [...messages].reverse().find(
    (m) => (m as { role?: string; content?: unknown }).role === "assistant" &&
           typeof (m as { content?: unknown }).content === "string" &&
           (m as { content: string }).content.trim(),
  ) as { content: string } | undefined;

  if (!last) {
    throw new Error(`子 agent 跑完 ${result.turns} 轮没有给出任何文字结论，任务：${task.slice(0, 80)}`);
  }

  return {
    answer: last.content.trim(),
    turns: result.turns,
    toolCalls: presenter.toolCalls,
    promptTokens: result.usage.promptTokens,
    completionTokens: result.usage.completionTokens,
  };
}

/** 把 explore 包成主 agent 能调的工具。 */
export function makeExploreTool(
  model: ModelClient,
  registry: () => Registry,
  gate: () => Gate = () => ({}),
): Tool {
  return {
    name: "explore",
    description:
      "派一个只读子 agent 去查清楚一件事，只把结论带回来，中间读过的原文不占你的上下文。" +
      "适合「这个项目里 X 是怎么实现的」「哪些文件用到了 Y」这类要翻很多文件的问题。" +
      "任务要写具体，它看不到你的上下文。",
    parameters: {
      type: "object",
      properties: {
        task: { type: "string", description: "交给子 agent 的完整任务描述，要自足" },
      },
      required: ["task"],
    },
    summarize: (a) => String(a.task ?? "").slice(0, 120),
    run: async (args, ctx) => {
      const r = await explore(String(args.task), model, registry(), ctx, gate());
      return (
        `${r.answer}\n\n` +
        `[子 agent 用了 ${r.turns} 轮 ${r.toolCalls} 次工具调用，` +
        `${r.promptTokens}/${r.completionTokens} token，这些都没进你的上下文]`
      );
    },
  };
}
