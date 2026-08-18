/**
 * 中英双语。
 *
 * 词条**以中文原文为键**，不另造 key。这套代码的注释、提交、讨论全是中文，
 * 再发明一层 `settings.dialog.title` 只会让人对着 key 猜界面上是哪一句。
 * 中文那份天然就是源文，英文查不到就原样退回中文——缺翻译时界面还是能用的，
 * 不会变成一片空白或者裸 key。
 *
 * 占位符用 `{0}` `{1}`，按 t() 的参数顺序填。中英两边的编号必须对上，
 * 因为英文语序常常跟中文不一样。
 *
 * 组件里用 useT()（它订阅 context，切语言会重渲染）；
 * 非组件的模块直接 import t，读的是模块级的当前语言。
 */
import {
  createContext, useCallback, useContext, useEffect, useState, type ReactNode,
} from "react";

export type Lang = "zh" | "en";

const STORAGE_KEY = "omnisci.lang";

const EN: Record<string, string> = {
  " · 视觉未配置": " · vision not configured",
  "+ 添加模型": "+ Add model",
  "2 个步骤 · 演示模式": "2 steps · demo mode",
  "3 个 stages": "3 stages",
  "Loaded skill · OmniScientist（论文研究）": "Loaded skill · OmniScientist (paper research)",
  "Loading skill · OmniScientist（论文研究）": "Loading skill · OmniScientist (paper research)",
  "Matplotlib 输出": "Matplotlib output",
  "OmniScientist 正在处理当前任务…": "OmniScientist is working on the current task…",
  "Skill 已加载。完整说明仅用于 Agent 执行，不在界面中展示。": "Skill loaded. The full instructions drive agent execution and are not shown here.",
  "[输出较长，仅显示前 12,000 个字符]": "[output truncated to the first 12,000 characters]",
  "key 存在 {0}": "Keys are stored in {0}",
  "{0} · {1} 次调用": "{0} · {1} calls",
  "{0} 个图表": "{0} figures",
  "{0} 已复制": "{0} copied",
  "{0} 次调用 · 脱敏参数与关键输出": "{0} calls · redacted arguments and key output",
  "{0} 第 {1} 页": "{0} page {1}",
  "{0} 项": "{0} items",
  "{0} 项输出": "{0} outputs",
  "{0}/{1} 个工具完成": "{0}/{1} tools done",
  "{0}{1}输出": "{0} {1} output",
  "{0}输出已复制": "{0} output copied",
  "{0}，可横向滚动": "{0} (scrolls horizontally)",
  "上一层": "Up one level",
  "下载 Overleaf 包": "Download Overleaf bundle",
  "下载 {0}": "Download {0}",
  "不设置": "Off",
  "事件和工作区产物。": "events and workspace artifacts.",
  "产物关系": "Artifact graph",
  "今天": "Today",
  "今天研究什么？": "What are we investigating today?",
  "从工作台移除 {0}": "Remove from workbench: {0}",
  "代码": "Code",
  "代码已复制": "Code copied",
  "你": "You",
  "使用": "Use",
  "使用中": "In use",
  "保存": "Save",
  "保存中": "Saving",
  "修正": "Revised",
  "停止研究": "Stop the run",
  "先在左下角填一个模型 API key，然后就能开始研究": "Add a model API key in the bottom left corner, then you can start",
  "先点测试": "Run the test first",
  "全屏查看研究记录": "View research log full screen",
  "全屏查看运行轨迹": "View run trace full screen",
  "全部": "All",
  "关键节点": "Key steps",
  "关键输出": "Key outputs",
  "关闭": "Close",
  "关闭面板": "Close panel",
  "写入研究产物": "Write a research artifact",
  "准备研究上下文": "Preparing research context",
  "切换中": "Switching",
  "切换到英文": "Switch to Chinese",
  "刚刚": "just now",
  "删除": "Delete",
  "删除这个模型": "Remove this model",
  "加载研究 Skill": "Load the research skill",
  "发送消息": "Send message",
  "取消": "Cancel",
  "取消选择数据目录": "Clear selected data folder",
  "只能浏览工作区内部": "Browsing is limited to the workspace",
  "启用中": "Applying",
  "告诉 OmniScientist 接下来研究什么": "Tell OmniScientist what to investigate next",
  "回到家目录": "Go to the home directory",
  "回到最新消息": "Jump to latest",
  "图表": "Figure",
  "在新窗口打开 {0}": "Open in a new window: {0}",
  "复制": "Copy",
  "复制{0}输出": "Copy{0} output",
  "复制代码 {0}": "Copy code: {0}",
  "复制代码": "Copy code",
  "失败": "Failed",
  "完成": "Done",
  "定位与问题相关的论文、数据和最近产物": "Locate papers, data and recent artifacts related to the question",
  "审阅图像": "Review an image",
  "对话列表": "Conversations",
  "展开": "Expand",
  "展开其余 {0} 行": "Show remaining {0} lines",
  "展开运行过程": "Expand run",
  "工作区 {0}": "Workspace {0}",
  "工作区": "Workspace",
  "工具输出 · 已截断": "Tool output · truncated",
  "工具输出": "Tool output",
  "工具运行中": "Tool running",
  "已与 Stage 2 实验结果核对": "Checked against Stage 2 experiment results",
  "已保存": "Saved",
  "已修正": "Revised",
  "已同步": "Synced",
  "已启用": "Enabled",
  "已复制": "Copied",
  "已完成": "Complete",
  "已定位 8 个相关文件": "Located 8 related files",
  "已脱敏：不含内部提示词、绝对路径与原始数据": "Redacted: no internal prompts, absolute paths, or raw data",
  "已配置": "Configured",
  "开不了新会话：{0}": "Cannot start a new session: {0}",
  "引用来源": "Sources",
  "当前会话 · {0} 项输出": "This session · {0} outputs",
  "当前工作区": "Current workspace",
  "思考": "Reasoning",
  "我先检查当前工作区，再整理可用证据。": "Let me inspect the current workspace first, then gather the available evidence.",
  "打开 {0}": "Open {0}",
  "打开对话栏": "Open sidebar",
  "打开工作台": "Open workbench",
  "打开模型设置": "Open model settings",
  "执行失败": "Execution failed",
  "执行已脱敏的分析命令": "Run a redacted analysis command",
  "换一个": "Replace",
  "换一个工作目录": "Change the working directory",
  "换目录会重开本地服务，这一页会自动接回来": "Changing it restarts the local service; this page reconnects on its own",
  "接口地址": "Endpoint",
  "搜索对话": "Search conversations",
  "收起": "Collapse",
  "收起代码": "Collapse code",
  "收起对话栏": "Collapse sidebar",
  "收起工作台": "Collapse workbench",
  "收起运行过程": "Collapse run",
  "数据": "Data",
  "数据输出": "Data output",
  "整理当前工作区的图表和证据": "Organize the figures and evidence in this workspace",
  "新建研究会话": "New research session",
  "新研究会话": "New research session",
  "无法创建本地会话：{0}": "Could not create a local session: {0}",
  "无法连接本地后端：{0}": "Could not reach the local backend: {0}",
  "暂无产物": "No artifacts yet",
  "更新研究产物": "Update a research artifact",
  "最终论文": "Final paper",
  "有新版本 {0}": "New version {0}",
  "未知 Skill": "Unknown skill",
  "未配置": "Not configured",
  "未配置模型": "No model configured",
  "本地会话 ID 无效": "Invalid local session id",
  "本地后端没有可用的模型凭据，请先配置 DeepSeek API key。": "The local backend has no usable model credentials. Configure a DeepSeek API key first.",
  "本地后端没有返回事件流": "The local backend returned no event stream",
  "本地后端返回 {0}": "Local backend returned {0}",
  "本地实时运行": "Running locally",
  "本地工作区": "Local workspace",
  "本地研究运行失败：{0}": "Local research run failed: {0}",
  "本地运行失败": "Local run failed",
  "本轮产物": "Artifacts this turn",
  "本轮工具轨迹": "Tool trace for this turn",
  "本轮研究已完成": "This research run is complete",
  "查看完整轨迹": "View full trace",
  "查看目录结构": "List directory",
  "校验研究结果": "Verify results",
  "检查中…": "Checking…",
  "检查当前工作区": "Inspect the current workspace",
  "检查数据并提出可验证的研究假设": "Inspect the data and propose a testable hypothesis",
  "检查更新": "Check for updates",
  "检查相关上下文": "Inspect context",
  "检索工作区": "Search workspace",
  "检索工作区中的相关内容": "Searching the workspace",
  "模型 ID": "Model ID",
  "模型": "Model",
  "模型设置": "Model settings",
  "模型跑着跑着忘了 case 在哪": "The model lost track of the case directory mid-run",
  "模型通道设置": "Model provider settings",
  "正在分析下一步": "Planning the next step",
  "正在分析请求": "Analyzing request",
  "正在打开研究工作区": "Opening the research workspace",
  "正在整理结果": "Organizing results",
  "正在用": "Active",
  "正在研究": "Researching",
  "正在读取…": "Loading…",
  "正在读取上下文": "Reading the context",
  "正在读取当前配置…": "Loading current settings…",
  "正在输出结果": "Writing results",
  "正在运行工具": "Running tools",
  "正在连接本地研究进程…": "Connecting to the local research process…",
  "此步骤没有可展示的额外输出。": "This step produced no additional output.",
  "此步骤生成的产物": "Artifacts from this step",
  "此类型暂无产物": "No artifacts of this kind yet",
  "每天检查": "Check daily",
  "没有匹配的对话": "No matching conversations",
  "没通过": "Failed",
  "测试": "Test",
  "测试中": "Testing",
  "测试成功": "Test passed",
  "测试通过之后才能启用": "Test must pass before this can be enabled",
  "浏览工作区顶层": "Browsing the workspace root",
  "消息输入": "Message input",
  "清空搜索": "Clear search",
  "演示模式": "Demo mode",
  "演示版没有本机后端可配。": "The demo build has no local backend to configure.",
  "点文件夹进去，点文件直接选": "Open a folder, or click a file to select it",
  "点这里填 API key": "Click here to add an API key",
  "版本 {0}": "Version {0}",
  "生成产物": "Artifacts",
  "用这个文件夹": "Use this folder",
  "用这个目录": "Use this directory",
  "界面演示，未接本机后端": "UI demo, no local backend connected",
  "目录路径": "Directory path",
  "研究产物": "artifact",
  "研究会话、数据和产物都放在这个目录下": "Sessions, data and artifacts all live under this directory",
  "研究工作台": "Research workbench",
  "研究工作台已就绪": "Research workbench ready",
  "研究文件": "research file",
  "研究模型": "Research model",
  "研究记录": "Research log",
  "研究运行中": "Research running",
  "研究运行完成": "Run complete",
  "确定": "Confirm",
  "确认删除": "Confirm delete",
  "空闲": "Idle",
  "等待你的问题": "Waiting for your question",
  "筛选研究产物": "Filter artifacts",
  "筛选运行轨迹": "Filter run trace",
  "继续分析中": "Still analyzing",
  "继续现有论文，先审阅最近的 PDF": "Continue the current paper, starting from the latest PDF",
  "编译论文": "Compile paper",
  "视觉模型": "Vision model",
  "论文": "Paper",
  "语言": "Language",
  "请求 JSON 无效": "Invalid request JSON",
  "读取研究文件": "Read research file",
  "读取配置中…": "Loading settings…",
  "调整工作台宽度": "Resize workbench",
  "路径": "Path",
  "过去 7 天": "Previous 7 days",
  "运行 Python 分析": "Run Python analysis",
  // 后端产出的运行状态串。它们走 t()，查不到就回落成中文原文，
  // 所以这几条缺一条就是英文界面上冒出一句中文。
  "已停止": "Stopped",
  "这一轮没跑完": "This run did not finish",
  "没跑完，可继续": "Unfinished, can resume",
  "运行中": "Running",
  "运行分析命令": "Run analysis command",
  "运行摘要": "Run summary",
  "运行轨迹": "Run trace",
  "返回研究记录": "Back to research log",
  "还差一步：选一个模型通道并填上 API key，就可以开始第一个研究会话。": "One more step: pick a model provider and add an API key to start your first research session.",
  "还有 {0} 项没列出来": "{0} more items not listed",
  "还没有模型": "No models yet",
  "还没有研究会话。新建一个，把数据交给它，然后说清楚你想研究什么。": "No research sessions yet. Create one, hand it your data, and say what you want to investigate.",
  "还没有配置模型 API key。点左下角的设置填一个，再开始研究。": "No model API key configured yet. Open settings at the bottom left, add one, then start researching.",
  "还没有配置视觉模型。点左下角设置，在「视觉模型」里选一个并填上它的 key。": "No vision model configured yet. Open settings at the bottom left, pick one under \\u201cVision model\\u201d and add its key.",
  "这个目录下没有子目录": "No subdirectories here",
  "这个目录是空的": "This folder is empty",
  "选中：{0}": "Selected: {0}",
  "选择工作目录": "Choose a working directory",
  "选择数据": "Select data",
  "（不推理）": "(no reasoning)",
  "（最强）": "(highest)",
  "，已是最新": " · up to date",
};

/**
 * 界面语言。**当前一律英文**，包括中文浏览器。
 *
 * 这是有意的（面向英文受众发布），不是漏了分支。原来的浏览器嗅探留在下面那行里，
 * 想恢复就是把 `? "en"` 改回 `? "zh"`。手动存过 localStorage 的仍然按存的来。
 *
 * 注释写"中文环境给中文"而代码返回英文，曾经让审计把它当成 bug 报上来，
 * 所以这里把意图写清楚。
 */
function detect(): Lang {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === "zh" || saved === "en") return saved;
  } catch {
    // 隐私模式下 localStorage 会抛，那就当没存过
  }
  const nav = typeof navigator === "undefined" ? "" : navigator.language || "";
  return nav.toLowerCase().startsWith("zh") ? "en" : "en";
}

let current: Lang = detect();

/** 翻译 + 填占位符。查不到就用中文原文。 */
const PREFIX: Array<[RegExp, (m: RegExpMatchArray) => string]> = [
  [/^读取 (.+)$/u, (m) => `Reading ${m[1]}`],
  [/^浏览 (.+)$/u, (m) => `Browsing ${m[1]}`],
  [/^更新 (.+)$/u, (m) => `Updating ${m[1]}`],
  [/^正在执行(.+)$/u, (m) => `Running ${EN[m[1]] ?? m[1]}`],
  [/^([\d,]+) 字符$/u, (m) => `${m[1]} chars`],
];

/** 表里查不到时，按前缀规则兜一层，专治后端拼好的动态串。 */
function byPrefix(zh: string): string | null {
  for (const [re, fn] of PREFIX) {
    const m = zh.match(re);
    if (m) return fn(m);
  }
  return null;
}

export function t(zh: string, ...args: unknown[]): string {
  const raw = current === "en" ? EN[zh] ?? byPrefix(zh) ?? zh : zh;
  if (!args.length) return raw;
  return raw.replace(/\{(\d+)\}/g, (whole, index: string) => {
    const value = args[Number(index)];
    return value === undefined || value === null ? whole : String(value);
  });
}

export function currentLang(): Lang {
  return current;
}

const LangContext = createContext<{ lang: Lang; setLang: (next: Lang) => void }>({
  lang: current,
  setLang: () => {},
});

export function LangProvider({ children }: { children: ReactNode }) {
  const [lang, setState] = useState<Lang>(current);

  const setLang = useCallback((next: Lang) => {
    current = next;                       // 先改模块级的，t() 立刻就按新语言算
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // 存不下最多是下次重开回到默认，不值得打扰用户
    }
    setState(next);
  }, []);

  // lang 属性要跟着走：CJK 和拉丁文的断行、字体回退规则不一样。
  useEffect(() => {
    document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
  }, [lang]);

  return <LangContext.Provider value={{ lang, setLang }}>{children}</LangContext.Provider>;
}

/** 组件里取 t。用 context 是为了切语言时这个组件会重渲染。 */
export function useT(): typeof t {
  useContext(LangContext);
  return t;
}

export function useLang(): [Lang, (next: Lang) => void] {
  const ctx = useContext(LangContext);
  return [ctx.lang, ctx.setLang];
}
