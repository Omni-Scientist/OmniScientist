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

export const CONTEXT_LIMIT = Number(process.env.PH_CONTEXT_TOKENS) || 384_000;

/** 占到这个比例才压缩。定高一点，压缩是稀有事件不是每轮动作。 */
export const COMPACT_AT = Number(process.env.PH_COMPACT_AT) || 0.7;

/** 压缩时最近几个用户轮次原样保留，不进摘要。 */
export const KEEP_RECENT_TURNS = 6;

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

export function messagesTokens(messages: unknown[]): number {
  let total = 0;
  for (const m of messages) {
    // 直接量 JSON：工具调用的参数和结果也占窗口，不能只算 content
    total += estimateTokens(JSON.stringify(m));
  }
  return total;
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
    limit: CONTEXT_LIMIT,
    ratio: used / CONTEXT_LIMIT,
    shouldCompact: used / CONTEXT_LIMIT >= COMPACT_AT,
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
 * 从中间切会留下孤儿 tool_result，下一轮直接 400。所以只能切在 user 消息之前。
 */
function findCutPoint(messages: unknown[], keepTurns: number): number {
  const userIdx: number[] = [];
  for (let i = messages.length - 1; i >= 1; i--) {
    if ((messages[i] as { role?: string }).role === "user") {
      userIdx.push(i);
      if (userIdx.length > keepTurns) break;
    }
  }
  if (userIdx.length <= keepTurns) return -1; // 还没攒够，不值得压
  return userIdx[userIdx.length - 1]!;
}

/**
 * 原地压缩：系统提示不动，最近若干轮原样留，中间压成一份摘要。
 * 摘要失败就抛，不静默跳过：跳过意味着下一轮直接撞窗口，那才是灾难。
 */
export async function compact(
  messages: unknown[],
  model: ModelClient,
  keepTurns = KEEP_RECENT_TURNS,
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
      { role: "user", content: `${JSON.stringify(middle)}\n\n${SUMMARY_PROMPT}` },
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
