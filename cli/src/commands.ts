/** 斜杠命令表。补全菜单和 /help 共用这一份，不许两处各写一遍。 */

export interface Command {
  name: string;
  hint: string;
}

export const COMMANDS: Command[] = [
  { name: "/standards", hint: "看规矩、当前命中情况、已注入哪些" },
  { name: "/soul", hint: "看这次带着哪些常驻指令文件" },
  { name: "/remember", hint: "把一条新规矩收进待合并区" },
  { name: "/recall", hint: "在历史会话和规矩库里检索" },
  { name: "/learn", hint: "从这次对话抽取值得长期记的规矩" },
  { name: "/merge", hint: "审查待合并区，收编新规矩" },
  { name: "/skills", hint: "看有哪些 skill 可用" },
  { name: "/formula", hint: "公式下面要不要跟一行可复制的源码：src / clean" },
  { name: "/tex", hint: "把渲染过的公式 LaTeX 源码复制到剪贴板" },
  { name: "/trace", hint: "展开这一轮被折叠的工具调用细节" },
  { name: "/model", hint: "当前通道和模型" },
  { name: "/balance", hint: "查 API 余额" },
  { name: "/update", hint: "查有没有新版本（只报不装）" },
  { name: "/caps", hint: "终端能力" },
  { name: "/guard", hint: "看硬拦截规则；带命令则试判一条不执行" },
  { name: "/session", hint: "当前会话 id，可用来续会话" },
  { name: "/help", hint: "命令列表" },
  { name: "/quit", hint: "退出" },
];

/** 输入以 / 开头时给补全候选。空的 / 就列全部。 */
export function completions(input: string): Command[] {
  if (!input.startsWith("/")) return [];
  // 已经打完命令加空格了，说明在填参数，不该再弹菜单
  if (input.includes(" ")) return [];
  const q = input.slice(1).toLowerCase();
  if (!q) return COMMANDS;
  return COMMANDS.filter((c) => c.name.slice(1).toLowerCase().startsWith(q));
}
