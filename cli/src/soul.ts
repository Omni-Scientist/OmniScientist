/**
 * 灵魂：每次都带着的那份指令。
 *
 * 分两层，都进系统提示，都稳定不变：
 *   ~/.omnisci/AGENTS.md   全局，跨项目，放你个人的偏好
 *   <工作区>/AGENTS.md   项目级（也认 .omnisci/AGENTS.md、CLAUDE.md）
 *
 * 跟 standards/ 的区别：这里永远生效，standards 命中条件才生效。
 *
 * 为什么个人偏好必须在这里而不是仓库里：仓库要开源，使用者的名字、
 * 习惯、「git 作者恒为谁」这类规矩属于本人，不该跟着代码分发出去。
 * 所以仓库里一条个人规矩都没有，全部由用户自己在 AGENTS.md 里写。
 *
 * 缓存纪律：系统提示在一次会话里必须逐字节不变，否则缓存前缀被打掉，
 * 整段上下文重新计费。所以随处境变化的东西一律不许进这里。
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

export const OMNI_HOME = join(homedir(), ".omnisci");
export const GLOBAL_SOUL = join(OMNI_HOME, "AGENTS.md");

// 按顺序找，取第一个。认 CLAUDE.md 是为了让已有项目零成本接上。
const WORKSPACE_CANDIDATES = ["AGENTS.md", ".omnisci/AGENTS.md", "CLAUDE.md"];

// 这里只写工具自身的身份，绝不写使用者是谁。
// 使用者的名字、偏好、称呼方式全部属于 AGENTS.md，那是用户的文件，不是这个工具的代码。
// 把人名硬编进 system prompt 意味着它会跟着开源代码分发给所有人。
const IDENTITY = (model: string) => `你叫 OmniScientist，是一个跑在终端里的工作 agent。
你不是 Claude，不是 ChatGPT，也不是任何厂商的助手产品。这一轮的推理由 ${model} 提供。
被问到身份时就这么答。后面的指令里如果出现别的产品名，那是规矩的内容，不是你的身份。`;

// 放在系统提示的第一行，单独成段，不进任何列表。它以前是 BEHAVIOR 里的第七条，中文写的，
// 埋在中间，几十轮中文工具返回一冲就没了（2026-09-02 实测：英文界面、英文提问，第二轮起
// 全程中文）。前沿 harness 的做法是模型面向的脚手架一种语言、回复语言跟用户走、规则放最显眼处。
const REPLY_LANGUAGE = `# Reply language
Reply in the language the user writes in. Decide it from the user's own messages only.
This system prompt, the tool descriptions and the tool results are written in Chinese; that is never a
reason to switch. If the user writes in English, every reply and every progress note is in English, from
the first turn to the last.`;

const BEHAVIOR = `工作方式：
- 只在任务确实需要时才用工具。寒暄、闲聊、回答关于你自己的问题，直接说话，不要去翻目录。
- 只根据用户当前明确提出的目标决定要做什么。不要因为工作区里已有某类文件，就自行启动对应领域的流程。
- 当前请求与某个可用 skill 的描述匹配时，先调 use_skill 读取完整说明再执行；不匹配就把它当普通任务处理。
- 需要判断图片内容时必须调用 view_image 真正查看，不能根据文件名、标签或预期替图片编描述。
- 要动文件之前先读那个文件，不要凭猜测编辑。
- 需要执行命令时自己调工具，不要把命令贴出来让人自己跑。
- 简洁。不复述要求，不预告计划，不用列表堆砌。做完了说做完了什么。回复语言按上面那条，跟用户走。
- 数学公式用 LaTeX：行内用单个 $，独立成行的用 $$。终端会渲染出来，矩阵和多行对齐都支持。
- 不确定就去查，不要编。工具报错就如实说错在哪，不要绕过去假装成功。`;

export function findWorkspaceSoul(root: string): string | null {
  for (const name of WORKSPACE_CANDIDATES) {
    const p = join(root, name);
    if (existsSync(p)) return p;
  }
  return null;
}

export interface SoulResult {
  systemPrompt: string;
  sources: string[];
}

/**
 * 拼系统提示。只放不随处境变化的东西。
 * 条件触发的标准由调用方放到当轮 user 消息里，不许塞进这里。
 */
export function buildSystemPrompt(model: string, root: string, alwaysOn = "", skillsBlock = ""): SoulResult {
  const parts = [REPLY_LANGUAGE, "", IDENTITY(model), "", BEHAVIOR];
  const sources: string[] = [];

  if (existsSync(GLOBAL_SOUL)) {
    const text = readFileSync(GLOBAL_SOUL, "utf-8").trim();
    if (text) {
      parts.push("", "# 全局指令（始终生效）", text);
      sources.push(GLOBAL_SOUL);
    }
  }

  const ws = findWorkspaceSoul(root);
  if (ws) {
    const text = readFileSync(ws, "utf-8").trim();
    if (text) {
      parts.push("", `# 项目指令（来自 ${basename(ws)}，始终生效）`, text);
      sources.push(ws);
    }
  }

  if (alwaysOn.trim()) parts.push("", "# 常驻规矩", alwaysOn.trim());
  // skill 只放名字和描述，正文等 agent 调 use_skill 才取，别把上下文撑爆
  if (skillsBlock.trim()) parts.push("", skillsBlock.trim());

  return { systemPrompt: parts.join("\n"), sources };
}
