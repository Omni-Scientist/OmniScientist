/**
 * agent 循环。harness 的核心，跟画面无关。
 *
 * 一轮 = 把 messages 发给模型 -> 收到文本就流出去 -> 收到 tool_call 就过审批、
 * 执行、把结果回喂 -> 直到模型不再要工具为止。
 *
 * 铁律落到这里：模型返回不合协议、工具崩了、审批被拒，全部如实进 transcript，
 * 不静默重试，不把失败包装成成功。
 */

import { ApprovalPolicy, ask, canAsk, Denied } from "./approval.ts";
import { checkTool, type GuardContext } from "./guard.ts";
import { type HookMatcher, runPreToolUse } from "./hooks.ts";
import { emptyUsage, type ModelClient, type ToolCall, type Usage } from "./model.ts";
import { approvalKeys, normalizeToolResult, type Registry, type ToolContext, wantsApproval } from "./tools/index.ts";

// OmniScientist routinely needs perception, analysis iteration, literature, writing, compile,
// gate repair, and PDF inspection in one user turn. The usual coding-agent default of 40 stopped
// a real paper run at the literature stage with only 9% of the context window used.
/**
 * 交互式一轮对话的模型轮次上限。有人在旁边，撞上限说一句"继续"就行。
 */
export const MAX_TURNS = 80;

/**
 * 无人值守跑完整篇论文的轮次预算。
 *
 * 为什么要单独一个：一篇论文要走完探数据 -> 感知 -> 分析 -> record -> 找文献
 * -> 编译，实测远不止 80 轮，而这条路上没人能说"继续"，撞上限就是空手而归。
 * 实测 histopath 在 80 轮处被砍断，产物只有一个分析脚本。
 */
export const UNATTENDED_MAX_TURNS = 260;

/** 循环怎么把事情告诉人。UI 抽出去，循环本身不 import 任何渲染代码。 */
export interface Presenter {
  /** 开始等模型。UI 可以在这里起转圈。 */
  turnStart(): void;
  /** 收到一段正文。UI 自己决定立刻吐还是扣住（公式没闭合时要扣）。 */
  textDelta(chunk: string): void;
  /** 这一轮正文收完了，把扣住的都吐出来。 */
  textDone(): void;
  toolStart(name: string, summary: string): void;
  /**
   * `output` is optional so terminal presenters can stay compact while richer clients expose
   * the tool's result on demand. It is the same text recorded in the model transcript.
   */
  toolResult(name: string, ok: boolean, detail: string, output?: string): void;
  /** 旁白：钩子的警告之类，不属于任何一次工具结果，但人得看见。 */
  note?(text: string): void;
}

/**
 * 工具执行前的闸门。三样东西挂在同一个缝上，顺序是固定的：
 *
 *   硬拦截表 -> PreToolUse 钩子 -> 审批门
 *
 * 硬拦截跑在最前面而且**不受 --auto-approve 和子 agent 的 autoApprove 影响**。
 * 钩子说 allow 也推不翻它：钩子是用户加的策略，硬拦截是这个 harness 自己的地板。
 */
export interface Gate {
  guard?: GuardContext;
  hooks?: HookMatcher[];
  sessionId?: string;
  /**
   * 没人能应答的执行体（子 agent）设成 true：需要单独点头的一律当拒绝。
   * 子 agent 的 presenter 是静默的，让它去弹审批框，人看到的是一个没有上下文的问句。
   */
  noAsk?: boolean;
}

export interface LoopResult {
  turns: number;
  stoppedBecause: string;
  usage: Usage;
}

export class AgentLoop {
  constructor(
    private model: ModelClient,
    private registry: Registry,
    private toolCtx: ToolContext,
    private policy: ApprovalPolicy,
    private presenter: Presenter,
    private onMessage: (m: unknown) => void = () => {},
    private gate: Gate = {},
  ) {}

  /** 就地修改 messages（追加 assistant / tool 消息）。 */
  async run(messages: unknown[], maxTurns = MAX_TURNS): Promise<LoopResult> {
    const schemas = this.registry.schemas();
    const total = emptyUsage();
    // 不再往 MAX_TURNS 上夹：夹了的话 maxTurns 这个参数就是一句空话，
    // 调用方永远抬不高，无人值守跑论文必然半路被砍。
    const turnLimit = Math.max(1, Math.floor(maxTurns) || 1);

    for (let turn = 0; turn < turnLimit; turn++) {
      this.presenter.turnStart();
      const result = await this.model.streamTurn(messages, schemas, (chunk) => {
        this.presenter.textDelta(chunk);
      });

      total.promptTokens += result.usage.promptTokens;
      total.completionTokens += result.usage.completionTokens;
      total.cachedTokens += result.usage.cachedTokens;
      total.cost += result.usage.cost;

      const calls = result.message.tool_calls ?? [];
      const hasText = typeof result.message.content === "string" && result.message.content.length > 0;
      // 既没正文又没工具调用的 assistant 消息，在 OpenAI 兼容接口上是非法的：
      // 回传下一轮会被直接 400（"content or tool_calls must be set"）。
      // 以前这种消息一入队就立刻结束循环，从没被发回去过，所以没暴露；
      // 现在被截断要继续跑，就必须挡住。空消息本来也没有任何信息可留。
      if (hasText || calls.length) {
        messages.push(result.message);
        this.onMessage(result.message);
      }

      this.presenter.textDone();

      if (!calls.length) {
        // finishReason 是 length 表示这条回复被输出上限截断了，不是说完了。
        // 当成正常结束就等于半句话收工：实测无人值守跑论文时，模型写到一半被截，
        // 整轮就此结束，ledger 和图都在、论文没编。让它接着写完。
        if (result.finishReason === "length") {
          const nudge = {
            role: "user",
            content: "你上一条回复被输出长度上限截断了。接着上次断掉的地方写完，别从头重来。",
          };
          messages.push(nudge);
          this.onMessage(nudge);
          continue;
        }
        return {
          turns: turn + 1,
          stoppedBecause: result.finishReason ?? "stop",
          usage: total,
        };
      }

      const toolMessages: unknown[] = [];
      const followupMessages: unknown[] = [];
      for (const call of calls) {
        const executed = await this.runOne(call);
        toolMessages.push(executed.message);
        followupMessages.push(...executed.followupMessages);
      }
      for (const message of [...toolMessages, ...followupMessages]) {
        messages.push(message);
        this.onMessage(message);
      }
    }

    // 数的是模型轮次，不是工具调用次数。之前那句写成"工具调用上限"，
    // 看日志的人会以为是工具太多，其实是轮次预算用完了。
    return { turns: turnLimit, stoppedBecause: `到达轮次上限 ${turnLimit}`, usage: total };
  }

  private async runOne(call: ToolCall): Promise<{ message: unknown; followupMessages: unknown[] }> {
    const name = call.function.name;
    const rawArgs = call.function.arguments;
    const reply = (content: string, followupMessages: unknown[] = []) => ({
      message: { role: "tool", tool_call_id: call.id, content },
      followupMessages,
    });
    /** 非 null 表示硬拦截层或钩子要求这次单独点头，理由就是它 */
    let forced: string | null = null;

    let args: Record<string, unknown>;
    try {
      args = rawArgs.trim() ? JSON.parse(rawArgs) : {};
    } catch (e) {
      // 参数不是合法 JSON 是模型的错，如实告诉它，让它自己改。
      // 不在这里替它猜参数。
      const msg = e instanceof Error ? e.message : String(e);
      this.presenter.toolResult(name, false, `参数不是合法 JSON: ${msg}`);
      return reply(`ERROR: arguments 不是合法 JSON: ${msg}\n原文: ${rawArgs.slice(0, 500)}`);
    }

    let tool;
    try {
      tool = this.registry.get(name);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.presenter.toolResult(name, false, msg);
      return reply(`ERROR: ${msg}`);
    }

    const summary = tool.summarize
      ? tool.summarize(args)
      : JSON.stringify(args).slice(0, 300);

    // 1. 硬拦截表。跑在最前面，任何模式下都不绕过。
    //    拒绝理由里带着改写好的安全命令，模型下一步就能自己改对，不会卡死也不会去找绕路方案。
    if (this.gate.guard) {
      const d = checkTool(name, args, this.gate.guard);
      if (d.verdict === "deny") {
        this.presenter.toolResult(name, false, `拦截 [${d.rule}]`);
        return reply(`BLOCKED [${d.rule}]: ${d.reason}`);
      }
      if (d.verdict === "ask") forced = d.reason ?? "需要单独确认";
    }

    // 2. PreToolUse 钩子。用户自己的策略，能拒能追问，但推不翻上面那一层。
    if (this.gate.hooks?.length) {
      const h = await runPreToolUse(this.gate.hooks, {
        tool_name: name,
        tool_input: args,
        cwd: this.toolCtx.root,
        session_id: this.gate.sessionId,
      });
      if (h.warning) this.presenter.note?.(h.warning);
      if (h.verdict === "deny") {
        this.presenter.toolResult(name, false, `钩子拒绝 [${h.rule}]`);
        return reply(`BLOCKED [${h.rule}]: ${h.reason}`);
      }
      if (h.verdict === "ask") forced = h.reason ?? forced ?? "钩子要求确认";
    }

    // 3. 审批门。forced 表示上面两层要求单独点头：每次都问，
    //    不吃会话放行，也不吃 --auto-approve，所以「a 本次会话一直」在这种情况下降级成「这次」。
    const keys = approvalKeys(tool, args);
    if (forced !== null && this.gate.noAsk) {
      this.presenter.toolResult(name, false, "需要人点头，但这里没人能应答");
      return reply(`BLOCKED: ${forced}\n这一步需要人单独点头，而你是子 agent，问不到人。把这件事交回上级去做。`);
    }
    if (forced !== null || this.policy.needsPrompt(keys, wantsApproval(tool, args))) {
      // 没人能应答就当被拒，回给模型让它换做法，别把整轮跑崩。
      // 无人值守跑论文时，模型顺手 cat 一个受保护路径是常事，
      // 那一下不该毁掉前面半小时的工作。
      if (!canAsk()) {
        const why = forced ?? "这一步需要人点头，而当前是无人值守模式";
        this.presenter.toolResult(name, false, "没人能应答审批");
        return reply(`BLOCKED: ${why}\n没人能应答审批，这条过不去。换个不碰它的做法继续，别重试同一条。`);
      }
      const decision = await ask(summary, name, forced ?? undefined);
      if (forced === null) this.policy.record(keys, decision);
      if (decision === "deny") {
        this.presenter.toolResult(name, false, "你拒绝了这次调用");
        return reply("用户拒绝执行这个工具调用。换个做法，或者问他想怎么办。");
      }
    }

    this.presenter.toolStart(name, summary);

    try {
      const output = normalizeToolResult(await tool.run(args, this.toolCtx));
      this.presenter.toolResult(name, true, `${output.text.length} 字符`, output.text);
      return reply(output.text, output.followupMessages);
    } catch (e) {
      if (e instanceof Denied) {
        const output = `用户拒绝: ${e.message}`;
        this.presenter.toolResult(name, false, e.message, output);
        return reply(output);
      }
      // 工具炸了要让模型和人同时看见真实错误，不吞、不改写、不假装成功
      const detail = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      const output = `ERROR: ${detail}`;
      this.presenter.toolResult(name, false, detail, output);
      return reply(output);
    }
  }
}
