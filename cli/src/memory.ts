/**
 * 记忆闭环。
 *
 * **关键判断：记忆不需要新造系统，它就是 standards 的另一半。**
 * 条件触发注入那套已经在跑，缺的只是自动往里写。所以这里只做两件事：
 *   抽取：从一段对话里挑出「值得长期记住的规矩」，进 _inbox
 *   合并：把 _inbox 的新条目跟正式库比对，去重、消解冲突
 *
 * 铁律：合并**绝不自动改写已经在生效的规矩**。冲突只列出来等人拍板。
 * 一条被偷偷改掉的规矩比没有规矩更危险，你以为它在管着，其实管的是别的事。
 */

import { existsSync, readdirSync, readFileSync, renameSync, unlinkSync } from "node:fs";
import { basename, join } from "node:path";
import { stringify as stringifyYaml } from "yaml";

import type { ModelClient } from "./model.ts";
import type { StandardsEngine } from "./standards.ts";
import { sideRequestBudget } from "./context.ts";

const EXTRACT_PROMPT = `从上面这段对话里挑出**值得长期记住的规矩**。

只挑这几类：
- 用户明确纠正过你的做法（「不要这样」「应该那样」）
- 用户表达过的固定偏好（文风、工具、流程）
- 这次踩过的坑和它的正确做法，下次还会遇到的那种

不要挑：
- 只跟这一次任务有关的事实（具体文件名、这次的数字）
- 代码里已经写着的东西
- 你自己的推测

输出严格的 JSON 数组，不要 markdown 代码块包裹：
[{"name":"短名字","description":"一句话","body":"规矩正文，写清楚做什么和为什么","keywords":["触发词"]}]

name、description、body 一律用中文写，跟现有规矩库保持一致。
keywords 里中英文都可以放，因为触发靠的是用户实际会说的词。

没有值得记的就输出 []。宁可少记也不要记一堆废话。`;

export interface Lesson {
  name: string;
  description: string;
  body: string;
  keywords: string[];
}

function parseJsonArray(raw: string): Lesson[] {
  // 模型经常裹一层 ```json，剥掉再解析。解析失败原样抛，不静默当空数组：
  // 静默返回空会让人以为「这次没啥可记的」，其实是坏了。
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/, "").trim();
  const start = cleaned.indexOf("[");
  const end = cleaned.lastIndexOf("]");
  if (start < 0 || end < start) {
    throw new Error(`抽取失败：模型没有返回 JSON 数组。原文开头：${cleaned.slice(0, 200)}`);
  }
  const parsed = JSON.parse(cleaned.slice(start, end + 1)) as Lesson[];
  if (!Array.isArray(parsed)) throw new Error("抽取失败：解析出来不是数组");
  return parsed;
}

/** 从对话里抽取值得长期记的规矩，写进 _inbox。返回写了几条。 */
export async function extractLessons(
  messages: unknown[],
  model: ModelClient,
  engine: StandardsEngine,
): Promise<Lesson[]> {
  // 只喂用户和助手的正文，工具原始输出噪声大又占量
  const digest = messages
    .filter((m) => {
      const r = (m as { role?: string }).role;
      return r === "user" || r === "assistant";
    })
    .map((m) => {
      const x = m as { role: string; content?: unknown };
      return `${x.role}: ${typeof x.content === "string" ? x.content : "(工具调用)"}`;
    })
    .join("\n")
    .slice(-sideRequestBudget());

  const turn = await model.streamTurn(
    [
      { role: "system", content: "你在从对话里提炼可复用的工作规矩。只输出 JSON。" },
      { role: "user", content: `${digest}\n\n${EXTRACT_PROMPT}` },
    ],
    [],
  );

  const lessons = parseJsonArray(turn.message.content ?? "");
  for (const l of lessons) {
    engine.capture(l.body, l.name, l.description);
  }
  return lessons;
}

export interface MergeVerdict {
  file: string;
  name: string;
  action: "new" | "duplicate" | "conflict" | "extends";
  target?: string; // 跟哪条正式规矩有关系
  reason: string;
}

const MERGE_PROMPT = `判断这条**待合并的新规矩**和现有正式规矩的关系。

只输出一个 JSON 对象，不要代码块包裹：
{"action":"new|duplicate|conflict|extends","target":"相关的正式规矩名或空","reason":"一句话理由"}

判据：
- new：现有规矩里没有覆盖这件事
- duplicate：已经有一条说的是同一件事，加了也是重复
- extends：现有某条讲的是同一主题，这条是补充，应该并进去
- conflict：跟现有某条**互相矛盾**，照这条做就违反那条

拿不准就报 conflict，让人来看。宁可多问一次也不要悄悄改掉在生效的规矩。`;

/**
 * 审 _inbox，给出每条的判定。
 * **只判定不落地**：new 的自动收编，其余一律列出来等人拍板。
 */
export async function reviewInbox(
  engine: StandardsEngine,
  model: ModelClient,
): Promise<MergeVerdict[]> {
  const inbox = join(engine.dir, "_inbox");
  if (!existsSync(inbox)) return [];

  const files = readdirSync(inbox).filter((f) => f.endsWith(".md"));
  if (!files.length) return [];

  const existing = engine.standards
    .map((s) => `## ${s.name}\n${s.description}\n${s.body.slice(0, 600)}`)
    .join("\n\n") || "（正式库是空的）";

  const out: MergeVerdict[] = [];
  for (const f of files) {
    const raw = readFileSync(join(inbox, f), "utf-8");
    const turn = await model.streamTurn(
      [
        { role: "system", content: "你在做规矩库的合并审查。只输出 JSON 对象。" },
        { role: "user", content: `现有正式规矩：\n${existing}\n\n待合并的新规矩：\n${raw}\n\n${MERGE_PROMPT}` },
      ],
      [],
    );
    const text = (turn.message.content ?? "").trim()
      .replace(/^```(?:json)?\s*/i, "").replace(/```$/, "").trim();
    const s = text.indexOf("{");
    const e = text.lastIndexOf("}");
    if (s < 0 || e < s) {
      throw new Error(`合并审查失败：模型没返回 JSON。文件 ${f}，原文：${text.slice(0, 200)}`);
    }
    const v = JSON.parse(text.slice(s, e + 1)) as Omit<MergeVerdict, "file" | "name">;
    const name = /^name:\s*(.+)$/m.exec(raw)?.[1]?.trim() ?? f.replace(/\.md$/, "");
    out.push({ file: f, name, action: v.action, target: v.target, reason: v.reason });
  }
  return out;
}

/** 把判定为 new 的收编进正式库；duplicate 直接删掉；其余原地不动等人处理。 */
export function applyMerge(
  engine: StandardsEngine,
  verdicts: MergeVerdict[],
): { adopted: string[]; dropped: string[]; collided: string[] } {
  const inbox = join(engine.dir, "_inbox");
  const adopted: string[] = [];
  const dropped: string[] = [];
  const collided: string[] = [];

  for (const v of verdicts) {
    const src = join(inbox, v.file);
    if (!existsSync(src)) continue;
    if (v.action === "new") {
      const dest = join(engine.dir, basename(v.file));
      // 绝不覆盖已有规矩。同名就留在 _inbox 等人处理。
      // 之前直接 renameSync 覆盖，实测能把一条 always:true 的铁律
      // 换成一条 keywords 为空、永远匹配不上的哑规矩，等于把规矩静默删了。
      // 这正是本模块开头写死的那条铁律。
      if (existsSync(dest)) {
        collided.push(v.name);
        continue;
      }
      renameSync(src, dest);
      adopted.push(v.name);
    } else if (v.action === "duplicate") {
      unlinkSync(src);
      dropped.push(v.name);
    }
    // conflict / extends 一律留在 _inbox，等人看过再说
  }
  engine.reload();
  return { adopted, dropped, collided };
}

export { stringifyYaml };
