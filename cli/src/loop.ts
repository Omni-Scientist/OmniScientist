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
import {
  ContextOverflowError, emptyUsage, MALFORMED_KEY, type ModelClient, type ToolCall, type Usage,
} from "./model.ts";
import { approvalKeys, normalizeToolResult, type Registry, type ToolContext, wantsApproval } from "./tools/index.ts";
import { budgetOf, calibrateTokens, compact, keepRecentTurns, messagesTokens } from "./context.ts";

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
  /** 人按了停止（或者浏览器断开），不是模型自己说完了。 */
  aborted?: boolean;
}

/** 停止时给没来得及执行的那些 tool_call 补的回执。 */
export const STOPPED_TOOL_RESULT = "已停止：这一步没有执行。";

/** 这一轮中途抛异常时，给剩下的 tool_call 补的回执。 */
export const ABORTED_TOOL_RESULT = "这一轮中断了：这一步没有执行结果。";

/**
 * 把历史消息里"有 tool_calls 却缺回执"的洞补上，就地修改并返回补了几条。
 *
 * 写入侧的不变量现在由 run() 的 finally 保证，但**已经存在的会话可能已经坏了**：
 * 真机上有一个跑了 303 次工具调用的会话，其中 1 个 call 没有回执，于是它每次
 * 发消息都被判 400，整个会话永久卡死，换新版本也救不回来。
 * 所以恢复会话时也过一遍这里，把旧伤补掉。
 */
export function repairToolCallGaps(messages: unknown[]): number {
  const answered = new Set<string>();
  for (const message of messages) {
    const m = message as { role?: string; tool_call_id?: string };
    if (m?.role === "tool" && m.tool_call_id) answered.add(m.tool_call_id);
  }

  let added = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { tool_calls?: Array<{ id?: string }> };
    const calls = m?.tool_calls ?? [];
    const missing = calls.filter((c) => c.id && !answered.has(c.id));
    if (!missing.length) continue;
    // 插在这条 assistant 已有的那串 tool 回执之后，读起来才是自然顺序。
    let at = i + 1;
    while (at < messages.length && (messages[at] as { role?: string })?.role === "tool") at++;
    messages.splice(at, 0, ...missing.map((c) => ({
      role: "tool", tool_call_id: c.id, content: ABORTED_TOOL_RESULT,
    })));
    added += missing.length;
  }
  return added;
}

/**
 * 中止只在三个地方生效，都是"消息数组处于合法状态"的位置：
 *
 *   轮次之间          最干净，什么都不用补
 *   模型流式返回途中  SDK 抛 abort，那一轮的 assistant 消息压根没入队
 *   每个工具调用之前  已跑的留真回执，没跑的补一条 STOPPED_TOOL_RESULT
 *
 * 第三条是必须的：assistant 消息带着 tool_calls 入队之后，**每一个** call 都必须有
 * 对应的 tool 消息，否则下一次请求会被 OpenAI 兼容接口判 400，用户"接着聊"就永远
 * 卡住。这个坑本会话前面已经踩过一次（空 assistant 消息那次）。
 */
/**
 * 网络抖动、5xx、限流这类瞬时错误。鉴权（401/403）、余额（402）、请求本身不对（400）不算，
 * 那些重试也不会好。ModelClient 故意 maxRetries: 0（网络层静默重试是吞错），所以重试放在
 * 这里，每次都通过 presenter.note 说出来，人和日志都看得见。
 */
export function isTransientModelError(error: unknown): boolean {
  const status = (error as { status?: number } | null)?.status;
  if (typeof status === "number") return [408, 409, 425, 429, 500, 502, 503, 504].includes(status);
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : String(error);
  return /APIConnection|Timeout/i.test(name)
    || /fetch failed|ECONNRESET|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|socket hang up|timed? ?out|overloaded|Connection error/i.test(message);
}

const TRANSIENT_RETRY_DELAYS_MS = [1_000, 3_000, 8_000];

function isAbortError(error: unknown): boolean {
  const name = (error as { name?: string } | null)?.name;
  return name === "AbortError" || name === "APIUserAbortError";
}

/** 同样的调用同样的结果，重复到第几次开始只回一句提醒而不是再贴一遍。 */
const REPEAT_LIMIT = 2;

/**
 * 只读的工具不受硬闸管。
 *
 * 反复读同一个没变过的文件只是低效，不是空转 —— 模型往往是在确认自己刚写进去的
 * 东西，读完就会接着干活。2026-08-27 实测：硬闸把 read_file 也拦了，模型想看
 * sections.json 看不到，于是一遍遍重试、一遍遍被拒，反而造出一个新的死循环。
 *
 * 软折叠（只压回显）对这类工具已经够了：省窗口，又不挡路。
 */
const READ_ONLY_TOOLS = new Set([
  "read_file", "read_more", "list_dir", "list_artifacts", "grep_files", "view_image",
]);

/**
 * 重复到第几次干脆不执行了。
 *
 * 折叠只是把回显压短，工具照样在跑，模型不理会提示就能一直转到轮次上限。
 * 2026-08-26 实测：30B 连着七次写同一个文件、内容一字不差，折叠每次都如实报了，
 * 它一次都没换路，十七分钟只产出一个脚本。到这一步就不能再只是「提醒」了。
 *
 * 定在 6：前面已经放行五次，真有正当理由重复的早该做完了。
 */
const REPEAT_HARD_STOP = 6;

/** 内容指纹。带长度前缀，碰撞概率低到可以忽略，而且不用把几十 KB 的原文留在内存里。 */
function digestOf(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0;
  return `${text.length}:${h.toString(36)}`;
}

/** 键顺序无关的 JSON。`{a,b}` 和 `{b,a}` 是同一次调用，不该算成两次。 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

/**
 * 盯着「同一个工具 + 同一份参数 + 同一份结果」重复了几次。
 *
 * **判据里必须带上结果**，不能只看工具和参数。`bash("git status")` 连调三次、
 * 每次输出不同，那是在盯状态变化，完全正常；输出一字不差才是空转。
 * 只看参数会把前者一起误伤。
 *
 * 2026-08-26 真机实测的场景：一个 8B 模型对着 12 个数据文件调了 79 次
 * look_at_table，同一个文件看了 10 次，全程没写过一行代码。轮数上限拦不住这个
 * （260 轮够它转很久），而每次几千字符的重复结果还在不停吃窗口。
 */
export class RepeatTracker {
  private readonly seen = new Map<string, { digest: string; count: number }>();

  /** 记一次「被硬闸拦下」，返回累计次数。见调用处的注释。 */
  noteBlocked(name: string, args: Record<string, unknown>): number {
    const key = `${name}\u0000${stableStringify(args)}`;
    const prev = this.seen.get(key);
    if (prev) { prev.count += 1; return prev.count; }
    this.seen.set(key, { digest: "", count: 1 });
    return 1;
  }

  /** 这个「工具 + 参数」到目前为止连着返回了几次相同结果。没记录过就是 0。 */
  repeatsFor(name: string, args: Record<string, unknown>): number {
    return this.seen.get(`${name}\u0000${stableStringify(args)}`)?.count ?? 0;
  }

  /** 返回 0 表示不是打转；非 0 是这次已经重复到第几次了。 */
  note(name: string, args: Record<string, unknown>, text: string): number {
    const key = `${name}\u0000${stableStringify(args)}`;
    const digest = digestOf(text);
    const prev = this.seen.get(key);
    if (!prev || prev.digest !== digest) {
      this.seen.set(key, { digest, count: 1 });
      return 0;
    }
    prev.count += 1;
    // 第二次原样放行：模型可能只是在确认一遍，这很正常。第三次起才算打转。
    return prev.count > REPEAT_LIMIT ? prev.count : 0;
  }
}

/**
 * 硬闸的说法。跟软提醒不同，这里要说清楚「这次没有执行」，否则模型会以为做过了。
 */
function hardStopNotice(name: string, times: number): string {
  return `这次 ${name} 的调用**没有执行**。同样的参数你已经连着调了 ${times} 次，`
    + `每次结果都一字不差，再调一次也不会有任何变化。\n`
    + `继续重复只会耗光剩下的轮次，什么也做不成。现在必须换一件事做：`
    + `改用别的工具、换个目标文件、或者拿已经得到的结果推进到下一步。`
    + `如果是卡在某个错误上，先把错误信息原文读一遍，照它说的改，而不是把同样的内容再写一遍。`;
}

/**
 * 告诉模型它在打转。说清三件事：重复了几次、结果没变、下一步可以往哪走。
 * 只说"别重复了"没用，得给出口。
 */
function repeatNotice(name: string, times: number): string {
  return `这次 ${name} 的调用（参数跟前面完全一样）已经是第 ${times} 次，`
    + `每次返回的结果一字不差，所以这里不再贴一遍。\n`
    + `你正在原地打转。换条路：换个文件或参数、改用别的工具、`
    + `或者直接根据已经看到的信息往下做（写代码、出图、动笔）。`;
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
  async run(messages: unknown[], maxTurns = MAX_TURNS, signal?: AbortSignal): Promise<LoopResult> {
    const schemas = this.registry.schemas();
    const total = emptyUsage();
    const halted = (turn: number): LoopResult => ({
      turns: turn, stoppedBecause: "已停止", usage: total, aborted: true,
    });
    // 不再往 MAX_TURNS 上夹：夹了的话 maxTurns 这个参数就是一句空话，
    // 调用方永远抬不高，无人值守跑论文必然半路被砍。
    const turnLimit = Math.max(1, Math.floor(maxTurns) || 1);

    // 这一轮是不是已经为了撑破窗口抢救过一次。防的是压完还超、压完还超的死循环。
    let rescued = false;
    let transientRetries = 0;

    for (let turn = 0; turn < turnLimit; turn++) {
      if (signal?.aborted) return halted(turn);

      // **每轮都过一次上下文的闸。**
      //
      // 以前压缩只在 cli.tsx 里、用户每次说话之前查一次。交互式没问题，一问一答
      // 天然会回到那儿。可 `-d` 无人值守跑论文**只有一次用户输入**，然后就一头扎进
      // 这个循环跑最多 260 轮，历史在里面疯长，而压缩器一次都不会被调用。
      //
      // 后果是撞穿窗口，报出来的还是一句看不懂的 400（2026-08-26 在真 vLLM 上撞到
      // 两次：输入 65513/上限 65536，输入 73043/上限 40960）。轮数上限拦得住"跑太久"，
      // 拦不住"历史涨太大"，这是两回事。
      //
      // 压缩失败就抛，不静默跳过：跳过意味着下一轮必然撞窗口，那才是灾难。
      const budget = budgetOf(messages);
      if (budget.shouldCompact) {
        this.presenter.note?.(
          `上下文占用 ${Math.round(budget.ratio * 100)}%（${budget.used}/${budget.limit}），压缩中`,
        );
        const r = await compact(messages, this.model);
        if (r.summarized) {
          messages.length = 0;
          messages.push(...r.messages);
          this.presenter.note?.(`压掉 ${r.summarized} 条消息，${r.before} -> ${r.after} token`);
        } else {
          // 一条都没压掉还继续跑，下一轮只会更满。说出来，别让「压缩中」后面没有下文 ——
          // 那正是 2026-08-26 那次空转最难查的地方：日志看着一切正常，占用一路涨到撑爆。
          this.presenter.note?.("这次没能压掉任何消息（能压的部分太短），继续跑");
        }
      }

      this.presenter.turnStart();

      // 记下发出去那一刻我们估的是多少，等服务端把真账带回来好对一次。
      // 必须在这里取：压缩之后、追加新消息之前，跟真正发出去的是同一份。
      const estimatedBefore = messagesTokens(messages);

      let result: Awaited<ReturnType<ModelClient["streamTurn"]>>;
      try {
        result = await this.model.streamTurn(messages, schemas, (chunk) => {
          this.presenter.textDelta(chunk);
        }, signal);
      } catch (error) {
        // 被掐断的请求不是故障，也没有半条消息留在数组里，直接干净收工。
        if (signal?.aborted || isAbortError(error)) return halted(turn);
        // 瞬时错误（网络抖动 / 5xx / 429）不该让一场跑了几十步的研究整场作废。
        // 2026-09-02 实测：64 步之后一次连接错误，整轮中断，界面还把它说成"没配 key"。
        // 有上限（3 次）、有退避、每次都说出来，这不是静默重试。
        if (isTransientModelError(error) && transientRetries < TRANSIENT_RETRY_DELAYS_MS.length) {
          const delay = TRANSIENT_RETRY_DELAYS_MS[transientRetries]!;
          transientRetries += 1;
          const what = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
          this.presenter.note?.(`模型服务瞬时错误（${what.slice(0, 120)}），${delay / 1000}s 后第 ${transientRetries}/${TRANSIENT_RETRY_DELAYS_MS.length} 次重试`);
          await new Promise((r) => setTimeout(r, delay));
          if (signal?.aborted) return halted(turn);
          continue;
        }
        // 光输入就撑破窗口，但手里有完整历史，压一轮还能救。预算闸是拿估算算的，
        // 估算再准也可能差那么几十个 token（实测差过 53 和 83），差一点就整场作废
        // 太亏了。压到只剩最近一轮，这是最后一次机会，所以下狠手。
        if (error instanceof ContextOverflowError && !rescued) {
          rescued = true;
          this.presenter.note?.("输入撑破了窗口，强制压缩后重试这一轮");
          const r = await compact(messages, this.model, 1);
          if (!r.summarized) throw error; // 压不动就是真没救了，把原话抛出去
          messages.length = 0;
          messages.push(...r.messages);
          this.presenter.note?.(`压掉 ${r.summarized} 条消息，${r.before} -> ${r.after} token`);
          continue;
        }
        throw error;
      }
      // 这一轮活着回来了，救援额度还回去：下次再撞窗口还能再救一次。
      // 不还的话，一场长研究里只要早期救过一次，后面就再也救不了了。
      rescued = false;
      transientRetries = 0;
      // SDK 被 abort 时不保证抛异常：实测有时只是把流悄悄结束掉，于是这一轮
      // 看起来像正常收尾，界面就写成"研究运行完成"。只认信号，不猜 SDK 的行为。
      if (signal?.aborted) return halted(turn);

      // 服务端报的 prompt token 是真账，拿它校准估算器。估算对 JSON 和源码会低估，
      // 而 agent 的历史里全是这两样，不校准的话压缩总是慢半拍（见 calibrateTokens）。
      calibrateTokens(estimatedBefore, result.usage.promptTokens);

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
          // 两种截断，给的话必须不一样。
          //
          // 正文被截：内容还在历史里，接着写就行。
          // tool_call 的参数被截：那半截参数**整个被丢掉了**，历史里根本没有，
          //   叫它「接着上次写」它无从接起，只会原样重来一遍 —— 而重来必然还是
          //   那么长、还是被截，就此死循环。唯一的出路是换个写法：分几次写。
          // 2026-08-26 实测：30B 写论文 tex 时单个 write_file 的参数就超过了
          // 8000 的输出上限。
          const nudge = {
            role: "user",
            content: result.truncatedToolCall
              ? "你刚才那次工具调用的参数太长，超过了单次输出上限，只到一半就断了，"
                + "所以整个调用已经作废，没有留下任何半成品。原样再写一遍还是会断。\n"
                + "改成分几次写：先写开头一部分落盘，再一段一段追加到同一个文件后面，"
                + "每次都控制在几百行以内。"
              : "你上一条回复被输出长度上限截断了。接着上次断掉的地方写完，别从头重来。",
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
      const answered = new Set<string>();
      let stoppedHere = false;
      try {
        for (const call of calls) {
          if (stoppedHere || signal?.aborted) {
            stoppedHere = true;
            continue;                       // 回执统一在 finally 里补
          }
          const executed = await this.runOne(call);
          toolMessages.push(executed.message);
          followupMessages.push(...executed.followupMessages);
          answered.add(call.id);
        }
      } finally {
        // **所有退出路径都要走到这里**：正常跑完、被停止、或者中间抛了异常
        // （钩子、拦截表、审批门都可能抛，runOne 只兜住了 JSON 和工具自身的错）。
        //
        // assistant 消息带着 tool_calls 已经入队了，只要有一个 call 没有对应的
        // tool 消息，下一次请求就会被判：
        //   400 An assistant message with 'tool_calls' must be followed by tool
        //       messages responding to each 'tool_call_id'.
        // 那会让整个会话再也发不出消息。真机上已经踩过一次。
        for (const call of calls) {
          if (answered.has(call.id)) continue;
          toolMessages.push({
            role: "tool",
            tool_call_id: call.id,
            content: stoppedHere || signal?.aborted ? STOPPED_TOOL_RESULT : ABORTED_TOOL_RESULT,
          });
        }
        for (const message of [...toolMessages, ...followupMessages]) {
          messages.push(message);
          this.onMessage(message);
        }
      }
      if (stoppedHere) return halted(turn + 1);
    }

    // 数的是模型轮次，不是工具调用次数。之前那句写成"工具调用上限"，
    // 看日志的人会以为是工具太多，其实是轮次预算用完了。
    return { turns: turnLimit, stoppedBecause: `到达轮次上限 ${turnLimit}`, usage: total };
  }

  private readonly repeats = new RepeatTracker();

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

    // 参数根本没成形（模型吐了坏 JSON），把原因原样回给它，别拿空参数去跑工具 ——
    // 那样模型收到的是「缺少 path」这种跟真正原因毫无关系的错误，只会照原样再写一遍。
    const malformed = args[MALFORMED_KEY];
    if (typeof malformed === "string") {
      this.presenter.toolResult(name, false, "参数不是合法 JSON，已让模型重写");
      return reply(`ERROR: ${malformed}`);
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

    // 已经重复到硬闸线，这次连跑都不跑了。必须在执行**前**判断：执行后再拦，
    // 副作用已经发生，而这类死循环恰恰是「做了也没用」的那种。
    const priorRepeats = this.repeats.repeatsFor(name, args);
    if (priorRepeats >= REPEAT_HARD_STOP && !READ_ONLY_TOOLS.has(name)) {
      // 被拒也要记一笔。不记的话计数永远停在原地，模型可以对着同一堵墙无限撞，
      // 每次都收到一模一样的话 —— 那就从「拦住空转」变成「造出新的空转」了。
      const blocked = this.repeats.noteBlocked(name, args);
      this.presenter.toolResult(name, false, `连着第 ${blocked} 次重复，这次不执行了`);
      return reply(hardStopNotice(name, blocked));
    }

    this.presenter.toolStart(name, summary);

    try {
      const output = normalizeToolResult(await tool.run(args, this.toolCtx));
      // 先跑再判断：副作用该发生的照样发生，折叠的只是回给模型的那段文字。
      const seen = this.repeats.note(name, args, output.text);
      if (seen) {
        this.presenter.toolResult(name, true, `跟前面 ${seen} 次结果一模一样，已折叠`);
        return reply(repeatNotice(name, seen));
      }
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
