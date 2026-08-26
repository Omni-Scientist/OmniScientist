/**
 * 上下文账本与原地压缩。
 *
 * 2026-08-05 实测的两个数：
 *   窗口：deepseek-v4-flash 吃下 360083 token 没报错，max_tokens 合法上限 393216，
 *         所以窗口约 384k。
 *   单价：¥0.11 / 百万未缓存 prompt token。
 *
 * 所以**压缩不是为了省钱，是为了不撞天花板和控制延迟**。这个价位上钱不是约束，
 * 别为了省几分钱把上下文压碎，那样丢的信息比省下的钱值钱得多。
 * 阈值定得高，压缩是稀有事件。
 *
 * 压缩跟缓存的关系：压缩会重写前缀，那一轮缓存必然掉到 0。但压缩过阈值才触发，
 * 压完新的短前缀立刻又变成被缓存的前缀，成本是摊薄的。状态行会如实显示这次掉到 0，
 * 不藏。
 */

import type { ModelClient } from "./model.ts";

/**
 * 窗口默认值。这个数是 2026-08-05 拿 deepseek-v4-flash 实测出来的，只对它成立。
 *
 * **自建部署上它是错的，而且错得很危险**：vLLM 为省显存普遍把 --max-model-len 开到
 * 32k 到 64k，而压缩要等 384k×0.7=268k 才触发，于是压缩**一次都不会发生**，
 * 历史一路涨到撑爆窗口，最后以一句看不懂的 400 收场。2026-08-26 在真 vLLM 上
 * 实测撞到：输入 65513 / 上限 65536，占了 99.96%，压缩器还在等 268k 那条线。
 *
 * 所以这只是「问不出来时的兜底」，真实窗口由 setContextLimit() 在启动时从服务端
 * 报上来的值覆盖。
 */
export const CONTEXT_LIMIT = Number(process.env.PH_CONTEXT_TOKENS) || 384_000;

/** 服务端报上来的真实窗口，没问到就是 null。 */
let discovered: number | null = null;

/**
 * 记下这个端点的真实窗口。vLLM / sglang 的 /v1/models 会给 max_model_len。
 *
 * 环境变量优先级最高：用户显式写了 PH_CONTEXT_TOKENS 就听他的，不被探测覆盖 ——
 * 他可能是故意压小来提前触发压缩的。
 */
export function setContextLimit(tokens: number): void {
  if (process.env.PH_CONTEXT_TOKENS) return;
  if (!Number.isFinite(tokens) || tokens <= 0) return;
  discovered = tokens;
}

/** 当前该按多大的窗口来算预算。 */
export function contextLimit(): number {
  return discovered ?? CONTEXT_LIMIT;
}

/** 占到这个比例才压缩。定高一点，压缩是稀有事件不是每轮动作。 */
export const COMPACT_AT = Number(process.env.PH_COMPACT_AT) || 0.7;

/**
 * 单条工具结果最多允许占窗口的多大一块。
 *
 * 超出的部分不会丢，存进 ArtifactStore 留个句柄，模型要就 read_more 续取
 * （见 artifacts.ts）。这里定的只是「一次能往上下文里塞多少」。
 *
 * 定成比例而不是常数，是因为常数在小窗口上是灾难：read_file 的上限原本写死
 * 60000 字符，在 DeepSeek 的 384k 窗口上只占 4%，换到 --max-model-len=40960 的
 * 自建部署上就占 37%，连读两次就过半，压缩刚压完立刻被顶回去。
 * 2026-08-26 实测：一条 60104 字符的 read_file 让输入从 29591 直接跳到 73438。
 */
export const TOOL_RESULT_SHARE = 0.08;

/**
 * 现在单条工具结果最多给多少字符。
 *
 * 按 4 字符 1 token 折算（estimateTokens 对拉丁文就是这么算的，中文会更省）。
 * 给个下限，免得窗口特别小的时候把工具结果砍到没法用。
 */
export function toolResultBudget(fallback: number): number {
  const chars = Math.floor(contextLimit() * TOOL_RESULT_SHARE * 4);
  return Math.max(8_000, Math.min(fallback, chars));
}

/** 压缩时最近几轮原样保留，不进摘要。 */
export const KEEP_RECENT_TURNS = 6;

/**
 * 这个窗口下该留几轮。
 *
 * 384k 上留 6 轮很轻松，40k 上留 6 轮可能把压缩的收益吃光：摘要才腾出来的位置，
 * 立刻被原样留下的近几轮填回去，压完跟没压一样。窗口小就少留。
 */
export function keepRecentTurns(): number {
  const limit = contextLimit();
  if (limit >= 200_000) return KEEP_RECENT_TURNS;
  if (limit >= 100_000) return 4;
  return 3;
}

const CJK_RE = /[⺀-鿿豈-﫿＀-￯]/;

/**
 * 估 token 数。中文基本一字一 token，拉丁文按四个字符一个 token。
 *
 * **刻意保守，会高估。** 拿真值比过：960000 字符的「数据 data 」实测 360083 token，
 * 本估算器给 420000，高估 16.6%。预算闸高估是安全方向（提前压缩），
 * 低估才会撞窗口。所以不去调准它。
 *
 * 只用来做预算判断，不用来计费。计费一律以 API 返回的 usage 为准。
 */
export function estimateTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if (CJK_RE.test(ch)) cjk++;
    else other++;
  }
  return Math.ceil(cjk + other / 4);
}

/**
 * 估算的校准系数，由服务端的真账推出来。1 表示还没校准过。
 */
let calibration = 1;

/**
 * 拿服务端返回的真实 prompt token 数，校准我们的估算。
 *
 * estimateTokens 按「中文 1 字 1 token、其它 4 字符 1 token」估。这个假设对中文
 * 散文是**高估**的（注释里那个 16.6% 实测），但对 **JSON 和源码是低估**：符号密集，
 * 真实密度接近 2 到 3 字符 1 token。而 agent 的历史里塞满了工具调用的 JSON 和
 * 代码，正好是低估最厉害的那种内容。
 *
 * 低估的后果是压缩来不及。2026-08-26 实测：估算说还没到阈值，服务端那边已经
 * 41013 tokens，超了 40960 的窗口 53 个。差一点点，但结果是整轮 400 挂掉。
 *
 * 所以每轮拿真账回来对一次。用滑动平均而不是直接替换：单轮的比值会因为缓存、
 * 系统提示的固定开销而抖动，跟着抖会让阈值忽高忽低。
 * 只往「更保守」的方向快速收敛（系数变大立刻跟上），往回放则慢慢来。
 */
export function calibrateTokens(estimated: number, actual: number): void {
  if (!Number.isFinite(estimated) || !Number.isFinite(actual)) return;
  if (estimated <= 0 || actual <= 0) return;
  const ratio = actual / estimated;
  // 离谱的比值不要：多半是这一轮的 messages 跟我们算的不是同一份
  if (ratio < 0.2 || ratio > 5) return;
  calibration = ratio > calibration
    ? Math.max(calibration, ratio)          // 低估了，立刻补上，宁可早压
    : calibration * 0.8 + ratio * 0.2;      // 高估了，慢慢放松
}

/** 只给测试用。 */
export function resetCalibration(): void {
  calibration = 1;
}

/** 当前的校准系数，状态行想显示就取这个。 */
export function tokenCalibration(): number {
  return calibration;
}

export function messagesTokens(messages: unknown[]): number {
  let total = 0;
  for (const m of messages) {
    // 直接量 JSON：工具调用的参数和结果也占窗口，不能只算 content
    total += estimateTokens(JSON.stringify(m));
  }
  // 乘上服务端真账校准出来的系数，见 calibrateTokens
  return Math.ceil(total * calibration);
}

export interface Budget {
  used: number;
  limit: number;
  ratio: number;
  shouldCompact: boolean;
}

export function budgetOf(messages: unknown[]): Budget {
  const used = messagesTokens(messages);
  return {
    used,
    limit: contextLimit(),
    ratio: used / contextLimit(),
    shouldCompact: used / contextLimit() >= COMPACT_AT,
  };
}

const SUMMARY_PROMPT = `把上面这段对话压缩成一份交接摘要，供同一个 agent 继续干活用。

必须包含：
1. 用户到底要什么（原始意图，别被中间的弯路带跑）
2. 已经做完什么，结论是什么
3. 碰过、改过哪些文件和路径，写绝对路径
4. 已经试过但不行的路子，以及为什么不行（防止重蹈）
5. 还没解决的、下一步要做的

要求：只写事实，不写客套。数字和路径原样保留，不许概括成「若干」「一些」。
不确定的标成不确定，不要编。`;

export interface CompactResult {
  messages: unknown[];
  before: number;
  after: number;
  summarized: number;
}

/**
 * 找一个能安全切开的位置。
 *
 * 关键约束：tool 消息必须跟它前面那条带 tool_calls 的 assistant 消息成对，
 * 从中间切会留下孤儿 tool_result，下一轮直接 400。所以切点只能落在**不是 tool**
 * 的消息上 —— user 可以，assistant 也可以（它开启新一轮，前面的必然是完整的）。
 *
 * 「最近几轮」必须按这个口径数，不能只数 user 消息。原来这里只认 user，交互模式下
 * 两者等价，但 `-d` 无人值守模式下是致命的：整场只有一条 user 消息，于是计数永远是
 * 1，永远 <= keepTurns，这个函数**永远返回 -1**，压缩器每轮都被叫醒、每轮都一条不压。
 * 2026-08-26 实测：占用 71% → 74% → 76% 一路涨，三次「压缩中」全是空转，
 * 最后 41043 撞穿 40960 的窗口。
 */
function findCutPoint(messages: unknown[], keepTurns: number): number {
  const cuts: number[] = [];
  for (let i = messages.length - 1; i >= 1; i--) {
    if ((messages[i] as { role?: string }).role === "tool") continue; // 回执不能跟它的 assistant 分家
    cuts.push(i);
    if (cuts.length > keepTurns) break;
  }
  if (cuts.length <= keepTurns) return -1; // 还没攒够，不值得压
  return cuts[cuts.length - 1]!;
}

/** 旁路请求最多占窗口的多大一块。剩下的留给系统提示、指令和它自己的输出。 */
const SUMMARY_INPUT_SHARE = 0.5;

/**
 * 旁路请求（压缩摘要、教训提炼）能塞多少字符。
 *
 * **这些请求也要过同一个窗口。** 它们容易被忘掉，因为不在主对话的账上，
 * 于是照着大模型的手感写死一个数（原来是 40000 字符），换到小窗口部署上
 * 光这一条就占掉四分之一。按 4 字符 1 token 折算。
 */
export function sideRequestBudget(): number {
  return Math.max(4_000, Math.floor(contextLimit() * SUMMARY_INPUT_SHARE) * 4);
}

/**
 * 把待摘要的内容裁到摘要请求本身放得进窗口。
 *
 * **压缩请求也要过同一个窗口。** 而且它最需要工作的时刻，恰恰是历史已经撑破窗口
 * 的时候（救援路径就是这么进来的）。原样发出去就是第二次 400，压缩反而成了压垮
 * 骆驼的最后一根稻草，整场研究陪葬。
 *
 * 裁的时候留头留尾、挖中间：开头有任务是什么、约束是什么，结尾有最近在干什么，
 * 这两头对交接最值钱；中间的过程细节丢一些，损失最小。
 */
function clipForSummary(payload: string): string {
  const room = sideRequestBudget();
  if (payload.length <= room) return payload;
  const side = Math.floor(room / 2);
  const dropped = payload.length - side * 2;
  return payload.slice(0, side)
    + `\n...（中间省略 ${dropped} 个字符，摘要请求本身也放不进窗口）...\n`
    + payload.slice(-side);
}

/**
 * 原地压缩：系统提示不动，最近若干轮原样留，中间压成一份摘要。
 * 摘要失败就抛，不静默跳过：跳过意味着下一轮直接撞窗口，那才是灾难。
 */
export async function compact(
  messages: unknown[],
  model: ModelClient,
  keepTurns = keepRecentTurns(),
): Promise<CompactResult> {
  const before = messagesTokens(messages);
  const cut = findCutPoint(messages, keepTurns);
  if (cut < 2) {
    return { messages, before, after: before, summarized: 0 };
  }

  const head = messages[0]; // system，永远不动
  const middle = messages.slice(1, cut);
  const tail = messages.slice(cut);

  const turn = await model.streamTurn(
    [
      { role: "system", content: "你在给一个终端 agent 做对话交接摘要。只输出摘要正文。" },
      { role: "user", content: `${clipForSummary(JSON.stringify(middle))}\n\n${SUMMARY_PROMPT}` },
    ],
    [],
  );

  const summary = turn.message.content?.trim();
  if (!summary) {
    throw new Error("压缩失败：模型没有返回摘要内容。上下文没有被改动，请手动处理。");
  }

  const marker = {
    role: "user",
    content:
      `<对话压缩摘要>\n这是本次会话早期 ${middle.length} 条消息的压缩结果，` +
      `原文已从上下文移除。把它当成已经发生过的事实。\n\n${summary}\n</对话压缩摘要>`,
  };

  const next = [head, marker, ...tail];
  return {
    messages: next,
    before,
    after: messagesTokens(next),
    summarized: middle.length,
  };
}
