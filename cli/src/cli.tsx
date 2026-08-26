#!/usr/bin/env bun
/**
 * 内联 REPL。
 *
 * 内联而不是全屏：输出留在正常滚动缓冲区，能往上翻、能鼠标选中复制、能重定向、
 * 能被别的程序管道读走。全屏 TUI（vim / htop 那种接管整屏的）这四条全废，
 * 而且重绘会把内联的公式图冲掉。
 *
 * 缓存纪律（实测见 README）：系统提示在一次会话里逐字节不变，
 * 所有随处境变化的内容一律追加到对话尾部。前缀一动，整段上下文重新计费。
 */

// 必须排在所有会在模块体里读 process.env 的 import 之前，理由见 bootstrap.ts
import "./bootstrap.ts";

import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";

import type { SessionUI } from "./ui.tsx";
import { ApprovalPolicy, setAsker } from "./approval.ts";
import { budgetOf, compact, setContextLimit } from "./context.ts";
import { checkCommand, commandClasses, describeConfig, loadGuardConfig } from "./guard.ts";
import { loadHooks } from "./hooks.ts";
import { AgentLoop, UNATTENDED_MAX_TURNS, type Presenter } from "./loop.ts";
import { fetchBalance, ModelClient, PROVIDERS, type ProviderName } from "./model.ts";
import { columns, detect, queryBackgroundColor, queryCellSize, rule as bannerRule } from "./render/caps.ts";
import { FormulaRenderer, RAW_MARK, RAW_SENTINEL, setCellAspect, splitFlushable } from "./render/formula.ts";
import { BLANK, MarkdownStream } from "./render/markdown.ts";
import { FRAME_COUNT, frame, setDark, Spinner } from "./render/spinner.ts";
import { Session } from "./session.ts";
import { buildSystemPrompt, findWorkspaceSoul, GLOBAL_SOUL, OMNI_HOME } from "./soul.ts";
import { DEFAULT_STANDARDS_DIR, StandardsEngine } from "./standards.ts";
import { BUILTIN_SKILLS_DIR, loadSkills, makeUseSkillTool, SKILLS_DIR, type Skill } from "./skills.ts";
import { skillsPromptBlock } from "./skills.ts";
import { SearchIndex } from "./search.ts";
import { makeRecallTool } from "./tools/recall.ts";
import { visionConfig } from "./tools/vision.ts";
import { makeExploreTool } from "./subagent.ts";
import { applyMerge, extractLessons, reviewInbox } from "./memory.ts";
import { defaultRegistry, makeContext } from "./tools/index.ts";
import { gatherSignals } from "./triggers.ts";
import { COMMANDS } from "./commands.ts";
import { safeChildEnvironment } from "./credentials.ts";
import { verifyPaperDelivery } from "./delivery.ts";
import { resolveInvocation } from "./invocation.ts";
import { checkForUpdate, updateCommand } from "./update.ts";

const VERSION = "0.1.6";
const OMNI_PROVIDER: ProviderName = "deepseek";
const OMNI_MODEL = "deepseek-v4-flash";

/**
 * 研究模型走哪个通道、哪个模型。
 *
 * 桌面版把用户在界面上选的那套写进 ~/.omnisci/env（OMNISCI_PROVIDER /
 * OMNISCI_MODEL / OMNISCI_BASE_URL），CLI 读同一份，两边就是一套配置。
 * 不认这两个变量的话，在桌面版把研究模型换成 OpenAI，命令行起来还是 DeepSeek，
 * 而 key 和模型明明都在文件里躺着。
 */
function researchChannel(): { provider: ProviderName; model: string } {
  const wanted = (process.env.OMNISCI_PROVIDER || "").trim();
  if (!(wanted in PROVIDERS)) return { provider: OMNI_PROVIDER, model: OMNI_MODEL };
  const provider = wanted as ProviderName;
  const model = (process.env.OMNISCI_MODEL || "").trim() || PROVIDERS[provider].defaultModel;
  return { provider, model };
}

/** 转一帧多少毫秒。UI 的重算间隔要跟它对齐，否则会跳帧。 */
const SPIN_MS = 170;

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const BLUE = "\x1b[34m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

/**
 * 所有输出的唯一出口。
 *
 * 挂了常驻 Ink 之后**绝对不能**直接写 stdout：Ink 用 previousLineCount 记着
 * 「我上一帧几行」，你插进去的行它不知道，下一帧擦除会把你刚写的吃掉。
 * 之前 /help /caps /trace 的输出闪一下就没，压缩提示和审批提示也一样，
 * 就是这个原因。
 */
let activeUI: SessionUI | null = null;
const out = (s: string) => {
  if (activeUI) {
    // 空行必须换成零宽空格才到得了屏幕。Ink 对每行 trimEnd()，
    // 空串行渲染出来高度为 0，整批只有空行时还会被 hasStaticOutput 判掉。
    for (const line of s.replace(/\n+$/, "").split("\n")) activeUI.print(line || BLANK);
    return;
  }
  process.stdout.write(s);
};
const HISTORY_FILE = join(OMNI_HOME, "history");

function loadHistory(): string[] {
  if (!existsSync(HISTORY_FILE)) return [];
  return readFileSync(HISTORY_FILE, "utf-8").split("\n").filter(Boolean).slice(-500);
}

function appendHistory(line: string): void {
  mkdirSync(OMNI_HOME, { recursive: true });
  appendFileSync(HISTORY_FILE, line + "\n", "utf-8");
}

/**
 * 按渲染器插的哨兵切开「文字 / 原始块」。
 *
 * 为什么不能按 kitty 转义序列逐个匹配：kittyEscape 把图按 4096 字节切成多块，
 * 每块都是独立的 \x1b_G...\x1b\\。逐块匹配就会对每一块调一次 printRaw，
 * 每次多写一个换行、多 clear 一次，换行插在分块中间会让图掉到下面好几行。
 * 3KB 以上的图全中，也就是绝大多数公式。
 *
 * 而且 overlay 的光标移动序列进了 Ink 的样式管线会被直接丢掉，
 * 所以整块（隐形源码 + 光标移动 + 图片）必须作为一个原始单元直写 stdout。
 */
function emitTo(ui: SessionUI | null, text: string): void {
  if (!ui) { out(text); return; }
  for (const part of text.split(RAW_SENTINEL)) {
    if (!part) continue;
    if (part.startsWith(RAW_MARK)) ui.printRaw(part.slice(RAW_MARK.length));
    else if (part.trim()) ui.print(part);
  }
}

class TerminalPresenter implements Presenter {
  /** 挂上常驻 UI 之后，输出走它的静态区，而不是直接写 stdout。 */
  ui: SessionUI | null = null;

  private spinner = new Spinner();
  private held = "";          // 落在未闭合公式里、暂时不能吐的那一段
  private wroteThisTurn = false;
  private turnNo = 0;
  private toolCount = 0;
  private startedAt = Date.now();

  // 常驻 UI 下的行缓冲。流式回来的每一小块只有几个字，
  // 直接 push 就是一块一行，屏幕上变成「要 / 核实 / 人物 / 信息」这样竖着排。
  // 必须攒够整行再推，最后一截在 textDone 时收尾。
  private lineBuf = "";
  // 这一轮的思考行有没有落定成历史。落定之后正文接在它下面，
  // 而不是把它顶掉。见 settleThinking。
  private settled = false;
  // markdown 渲染器。按行喂，块级状态（在不在代码围栏里）它自己存着。
  private md = new MarkdownStream(columns());
  // 上一段输出是哪一类。只用来决定要不要插一个空行分隔，
  // 连着几条工具行不该互相隔开，工具行和正文之间该隔开。
  private lastKind = "";

  // 连续同名工具折叠成一行。四条 bash 挨着刷屏没意义，
  // 想看每一条的细节用 /trace 从会话库里翻，全都存着。
  private run: { name: string; count: number; ok: number; fail: number; last: string } | null = null;

  constructor(private renderer: FormulaRenderer) {}

  /**
   * 把思考行钉成历史的一行，正文接在它下面。
   *
   * 不这么做的话：思考行在 Ink 的活动区（永远贴着底部），正文进静态区（在它上面），
   * 于是思考一结束那行就消失、正文从它头上冒出来，很跳。
   * 现在第一段正文到达时（也就是模型真正开始答的那一刻）把思考行固化，
   * 位置不动，正文自然接在下面。
   */
  private settleThinking(): void {
    if (this.settled || !this.ui) return;
    this.settled = true;
    this.ui.print(BLANK);
    this.ui.print(`  ${GREEN}✓${RESET} ${DIM}思考 ${this.elapsed()}${RESET}`);
    this.ui.print(BLANK);
    this.lastKind = "think";
  }

  newRound(): void {
    this.md.setWidth(columns());
    this.md.reset();
    this.lastKind = "";
    this.settled = false;
    this.turnNo = 0;
    this.toolCount = 0;
    this.startedAt = Date.now();
  }

  private elapsed(): string {
    return `${((Date.now() - this.startedAt) / 1000).toFixed(1)}s`;
  }

  private progress(extra = ""): string {
    // 按墙上时间算当前帧，所以只要 UI 在定时重算这行字，点就一直在转。
    // 之前圆点只接在非常驻路径的 Spinner 上，改成常驻 UI 之后忙碌行只剩文字。
    const spin = frame(Math.floor(Date.now() / SPIN_MS) % FRAME_COUNT);
    const bits = [`第 ${this.turnNo} 轮`];
    if (this.toolCount) bits.push(`工具 ${this.toolCount}`);
    bits.push(this.elapsed());
    // 用 \u0000 把「自带颜色的圆点」和「交给 Ink 上色的文字」分开。
    // 圆点里有 \x1b[0m 全量重置，跟文字混在一条字符串里的话，
    // Ink 加在开头的青色和粗体会被那个重置清掉，后面的字就变回普通文本。
    return `${spin}\u0000 ` + (extra ? `${extra}  ·  ` : "") + bits.join("  ·  ");
  }

  turnStart(): void {
    this.turnNo++;
    this.held = "";
    this.lineBuf = "";
    this.wroteThisTurn = false;
    if (this.ui) { this.ui.setBusy(() => this.progress("思考")); return; }
    this.spinner.setLabel(() => this.progress("思考"));
    this.spinner.start();
  }

  textDelta(chunk: string): void {
    this.held += chunk;
    const [flush, held] = splitFlushable(this.held);
    this.held = held;
    if (this.ui) this.ui.setBusy(() => this.progress("思考"));
    if (flush) this.emit(flush);
  }

  textDone(): void {
    if (this.held) {
      this.emit(this.held);
      this.held = "";
    }
    if (this.ui) {
      // 最后不满一行的那截也要吐出去
      if (this.lineBuf) { this.flushLine(this.lineBuf); this.lineBuf = ""; }
      for (const r of this.md.end()) this.ui.print(r);
      return;
    }
    this.spinner.stop();
    if (this.wroteThisTurn) out("\n");
  }

  toolStart(name: string, summary: string): void {
    this.toolCount++;
    const label = () => this.progress(`${name} ${DIM}${summary.slice(0, 60)}${RESET}`);
    if (this.ui) { this.ui.setBusy(label); return; }
    this.spinner.setLabel(label);
    this.spinner.start();
  }

  /** 旁白。目前只有钩子的非零退出警告走这儿，不该被折叠进工具行。 */
  note(text: string): void {
    if (this.ui) {
      for (const line of text.split("\n")) this.ui.print(`  ${YELLOW}⚠ ${line}${RESET}`);
      this.lastKind = "note";
      return;
    }
    this.spinner.stop();
    this.closeRun();
    out(`  ${YELLOW}⚠ ${text}${RESET}\n`);
  }

  toolResult(name: string, ok: boolean, detail: string): void {
    if (this.ui) {
      // 常驻 UI 下没法就地改上一行，直接每次追加一行，简单可靠
      const mark = ok ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`;
      // 从正文切到工具行要空一行，工具行之间不空
      if (this.lastKind !== "tool") this.ui.print(BLANK);
      this.ui.print(`  ${BLUE}●${RESET} ${name}  ${mark} ${DIM}${detail.slice(0, 120)}${RESET}`);
      this.lastKind = "tool";
      return;
    }
    this.spinner.stop();

    if (this.run && this.run.name === name) {
      // 同一个工具接着又跑：把上一行就地改掉，不新起一行
      this.run.count++;
      ok ? this.run.ok++ : this.run.fail++;
      this.run.last = detail;
      out("\x1b[1A\r\x1b[K" + this.runLine());
    } else {
      this.closeRun();
      this.run = { name, count: 1, ok: ok ? 1 : 0, fail: ok ? 0 : 1, last: detail };
      out(this.runLine());
    }
  }

  private runLine(): string {
    const r = this.run!;
    const times = r.count > 1 ? `${DIM} ×${r.count}${RESET}` : "";
    const mark = r.fail === 0
      ? `${GREEN}✓${RESET}`
      : r.ok === 0
        ? `${RED}✗${RESET}`
        : `${GREEN}✓${r.ok}${RESET} ${RED}✗${r.fail}${RESET}`;
    return `  ${BLUE}●${RESET} ${r.name}${times}  ${mark}  ${DIM}${r.last.slice(0, 90)}${RESET}\n`;
  }

  /** 折叠段结束，后面要写别的东西了。 */
  private closeRun(): void {
    this.run = null;
  }

  /** 一整行原始 markdown 过渲染器，吐出来的显示行逐行推进静态区。 */
  private flushLine(line: string): void {
    // 工具行和图片之后接正文要隔开。lastKind 只在这里读，别的地方只写。
    if (this.lastKind === "tool" || this.lastKind === "raw") this.ui!.print(BLANK);
    // 宽度每行都重取。只在 newRound 取的话，会话中间把终端拉宽拉窄，
    // 这一轮剩下的输出还按老宽度折，跟 Ink 的实际宽度打架，版式错位。
    this.md.setWidth(columns());
    for (const rendered of this.md.push(line)) this.ui!.print(rendered);
    this.lastKind = "text";
  }

  /** 真正往终端写。写之前一定先把转圈那行擦掉，否则会跟正文串行。 */
  private emit(text: string): void {
    if (this.ui) {
      this.settleThinking();
      const rendered = this.renderer.render(text);
      for (const part of rendered.split(RAW_SENTINEL)) {
        if (!part) continue;
        if (part.startsWith(RAW_MARK)) {
          // 图片是独立单元：先把攒着的半行吐掉，再画图
          if (this.lineBuf) { this.flushLine(this.lineBuf); this.lineBuf = ""; }
          this.ui.printRaw(part.slice(RAW_MARK.length));
          this.lastKind = "raw";
          continue;
        }
        // 攒够整行才推，不然一个流式片段就是一行
        this.lineBuf += part;
        const nl = this.lineBuf.lastIndexOf("\n");
        if (nl >= 0) {
          for (const line of this.lineBuf.slice(0, nl).split("\n")) this.flushLine(line);
          this.lineBuf = this.lineBuf.slice(nl + 1);
        }
      }
      return;
    }
    this.spinner.stop();
    this.closeRun();
    if (!this.wroteThisTurn) {
      out("\n");
      this.wroteThisTurn = true;
    }
    out(this.renderer.render(text));
  }
}

/** 模型出自哪家。状态栏要显示机构，不是只有个模型串。 */
function vendorOf(model: string): string {
  const m = model.toLowerCase();
  if (m.includes("deepseek")) return "DeepSeek";
  if (m.includes("claude")) return "Anthropic";
  if (m.includes("gemini") || m.includes("gemma")) return "Google";
  if (m.startsWith("gpt") || /^o[1-9]/.test(m)) return "OpenAI";
  if (m.includes("qwen")) return "Alibaba";
  return "未知";
}

/** 终端显示宽度：中日韩和全角标点算两列，其余算一列。用来对齐横排状态。 */
function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s.replace(/\x1b\[[0-9;]*m/g, "")) {
    const c = ch.codePointAt(0)!;
    const wide =
      (c >= 0x1100 && c <= 0x115f) ||
      (c >= 0x2e80 && c <= 0xa4cf) ||
      (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xfe30 && c <= 0xfe6f) ||
      (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6);
    w += wide ? 2 : 1;
  }
  return w;
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      cwd: { type: "string", short: "C", default: "." },
      data: { type: "string", short: "d" },
      standards: { type: "string" },
      "auto-approve": { type: "boolean", default: false },
      resume: { type: "string" },
      "verbose-standards": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
      version: { type: "boolean", short: "v", default: false },
    },
    allowPositionals: true,
  });

  // 产物名里不再带版本号（2026-08-25 统一的），所以这是用户确认自己装了哪一版的
  // 唯一途径。桌面版一直有 --version，CLI 一直没有，补上。
  if (values.version) {
    out(`${VERSION}\n`);
    return 0;
  }

  if (values.help) {
    out(`用法: omnisci [选项] [一次性任务]

  -C, --cwd <目录>        工作区，默认当前目录
  -d, --data <目录>       以该数据目录为工作区并立即端到端产出候选论文
      --standards <目录>  标准库目录，默认 ~/.omnisci/standards
      --auto-approve      关掉审批门（只在受控目录用）
      --resume <会话id>   续会话，缓存跟着续
      --verbose-standards 每轮打印生效的规矩
  -v, --version           打印版本号
  -h, --help              这段

模型固定为 DeepSeek 官方 API 的 ${OMNI_MODEL}。
`);
    return 0;
  }

  const { dataArg, root, taskWords } = resolveInvocation(values.cwd!, values.data, positionals);
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    out(`数据或工作区目录不存在: ${root}\n`);
    return 2;
  }
  const { provider, model: modelName } = researchChannel();

  const caps = detect();
  const renderer = new FormulaRenderer(caps);
  // overlay 要把源码染成背景色才能隐身，开局先问终端背景色是多少
  let cell: { w: number; h: number } | null = null;
  // 背景色所有终端都要查，不能锁在「能显图」里面：
  // 转圈的明暗极性靠它决定，不查就一直用深色极性，
  // 浅色主题下彗星头是跟背景最接近的那个色，等于隐形。
  renderer.bgColor = await queryBackgroundColor();
  if (renderer.bgColor) {
    const [r, g, b] = renderer.bgColor.split(";").map(Number) as [number, number, number];
    // Rec. 601 亮度，够用了，只是要判深浅
    if (Number.isFinite(r + g + b)) setDark((0.299 * r + 0.587 * g + 0.114 * b) < 128);
  }
  if (caps.canShowImages) {
    // 真实格子宽高比，决定 overlay 时源码能铺多宽。估错就会露出来。
    cell = await queryCellSize();
    if (cell) setCellAspect(cell.w / cell.h);
  }
  const presenter = new TerminalPresenter(renderer);
  const engine = new StandardsEngine(values.standards ?? DEFAULT_STANDARDS_DIR);
  const model = new ModelClient({ provider, model: modelName });

  // 问一次这个端点的真实窗口，用来算压缩的触发线。
  // 默认那个 384k 是照 DeepSeek 量的，套在 --max-model-len 开成 64k 的自建部署上，
  // 压缩永远不触发，历史一路涨到撑爆窗口（2026-08-26 实测撞到 65513/65536）。
  // 问不到就沿用默认，最多是压缩晚一点，不影响别的。
  const window = await model.discoverContextWindow();
  if (window) setContextLimit(window);
  if (window) model.raiseOutputBudgetFor(window);

  const policy = new ApprovalPolicy(values["auto-approve"]);
  const session = Session.open(join(OMNI_HOME, "sessions.db"), root, model.model, values.resume);

  // 检索索引跟会话共用一个连接。增量灌入，不重建。
  const index = new SearchIndex(session.database);
  const indexed = index.indexNewMessages();
  index.indexStandards(engine.standards);

  // registry 要先建才能给子 agent 用，子 agent 又要 registry，用惰性引用打破循环
  let skills: Skill[] = loadSkills();
  let registry: Awaited<ReturnType<typeof defaultRegistry>>;
  registry = await defaultRegistry([
    makeRecallTool(() => index),
    makeExploreTool(model, () => registry, () => ({
      guard: { root: resolve(root), config: guardConfig },
      hooks: preToolUseHooks,
    })),
    makeUseSkillTool(() => skills),
  ]);

  // 防误伤三件套。规则文件或钩子配置写坏了在这里当场抛，
  // 不能等到某条 rm 冲过来才发现规则根本没编译。
  const guardConfig = loadGuardConfig();
  const preToolUseHooks = loadHooks();

  const loop = new AgentLoop(
    model, registry, makeContext(root), policy, presenter,
    (m) => session.record((m as { role?: string }).role ?? "?", m),
    { guard: { root: resolve(root), config: guardConfig }, hooks: preToolUseHooks, sessionId: session.id },
  );

  // 常驻规矩进系统提示，条件规矩不进。系统提示定下来就不再改，保住缓存前缀。
  const alwaysOn = engine.asPromptBlock(
    engine.active(gatherSignals(root, "")).filter((a) => a.standard.always),
  );
  const { systemPrompt, sources } = buildSystemPrompt(model.model, root, alwaysOn, skillsPromptBlock(skills));

  // 启动状态：左边字段名，右边值，两组一行，列对齐。
  // 之前挤成一串用 · 隔开，看着乱。
  const balance = await fetchBalance(provider);
  const branch = gatherSignals(root).gitBranch;
  const soulNames = sources.length
    ? sources.map((s) => (s.startsWith(OMNI_HOME) ? "全局" : "项目")).join(" + ")
    : "无";

  // 不 await：更新检查绝不能拖慢启动。查到了就在下一次空闲时打一行，查不到就当没这回事。
  void checkForUpdate(VERSION, "cli").then((info) => {
    if (!info?.newer) return;
    out(`\n${YELLOW}有新版本 ${info.latest}${RESET}（当前 ${info.current}）`
      + `${DIM}  更新：${updateCommand("cli")}${RESET}\n`);
  });

  const fields: Array<[string, string]> = [
    ["Vendor", vendorOf(model.model)],
    ["Session", session.id],
    ["Model", model.model],
    ["Perceiver", `${visionConfig().provider}:${visionConfig().model}（仅视觉）`],
    ["Workspace", root.replace(homedir(), "~")],
    ["Balance", balance ?? "查不到"],
    ["Git", branch ?? "非仓库"],
    ["Route", "DeepSeek 官方 API"],
    ["Context", `AGENTS.md ${soulNames}${skills.length ? `  ·  skill ${skills.length}` : ""}`],
  ];

  const labelW = Math.max(...fields.map(([k]) => k.length));
  const colW = 30;
  const rule = bannerRule();

  out(`\n ${BOLD}${BLUE}✻${RESET} ${BOLD}OmniScientist${RESET}${DIM}   v${VERSION}${RESET}\n`);
  out(` ${DIM}${rule}${RESET}\n`);
  for (let i = 0; i < fields.length; i += 2) {
    const cells: string[] = [];
    for (const pair of [fields[i], fields[i + 1]]) {
      if (!pair) continue;
      const [k, v] = pair;
      const cell = `${DIM}${k.padEnd(labelW)}${RESET}  ${v}`;
      cells.push(cell + " ".repeat(Math.max(1, colW - labelW - 2 - displayWidth(v))));
    }
    out(` ${cells.join("")}\n`.replace(/\s+$/, "\n"));
  }
  out(` ${DIM}${rule}${RESET}\n`);
  if (values["auto-approve"]) out(` ${YELLOW}审批门已关闭，工具会直接执行${RESET}\n`);

  const messages: unknown[] = values.resume ? session.history() : [];
  const first = messages[0] as { role?: string } | undefined;
  if (!first || first.role !== "system") {
    messages.unshift({ role: "system", content: systemPrompt });
  }

  const cellInfo = cell
    ? `${cell.w}x${cell.h}px，宽高比 ${(cell.w / cell.h).toFixed(2)}`
    : "没查到，用估算值 0.5";

  const injected = new Set<string>();
  let lastUsage = { prompt: 0, completion: 0, cached: 0, cost: 0 };

  /** 底部状态行。模型、窗口占用、缓存命中、花销，一行装下。 */
  const statusLine = (): string => {
    const b = budgetOf(messages);
    const bits = [
      `${model.model}`,
      `窗口 ${Math.round(b.ratio * 100)}%`,
    ];
    if (lastUsage.prompt) {
      bits.push(`${lastUsage.prompt}/${lastUsage.completion} tok`);
      if (lastUsage.cached) {
        bits.push(`缓存 ${Math.round((100 * lastUsage.cached) / lastUsage.prompt)}%`);
      }
    }
    if (lastUsage.cost) bits.push(`$${lastUsage.cost.toFixed(5)}`);
    bits.push(session.id);
    return "  " + bits.join("  ·  ");
  };

  async function oneRound(userText: string) {
    // 常驻的已经在系统提示里，这里只管条件触发的，而且一次会话只注入一次：
    // 已经在上下文里的东西重复发一遍既费 token 又打断追加式增长。
    const fresh = engine
      .active(gatherSignals(root, userText))
      .filter((a) => !a.standard.always && !injected.has(a.standard.name));

    let content = userText;
    if (fresh.length) {
      content = `${userText}\n\n<适用规矩>\n${engine.asPromptBlock(fresh)}</适用规矩>`;
      for (const a of fresh) injected.add(a.standard.name);
      session.recordStandards(fresh.map((a) => [a.standard.name, a.reason] as [string, string]));
      if (values["verbose-standards"]) {
        out(`  ${DIM}新生效：${fresh.map((a) => a.standard.name).join("、")}${RESET}\n`);
      }
    }

    // 上下文账本：过阈值才压缩，不是每轮动作。压缩会重写前缀，
    // 那一轮缓存必掉到 0，如实报出来不藏。
    const budget = budgetOf(messages);
    if (budget.shouldCompact) {
      out(`  ${YELLOW}上下文占用 ${Math.round(budget.ratio * 100)}%，压缩中${RESET}${DIM}（这一轮缓存会掉到 0）${RESET}\n`);
      const r = await compact(messages, model);
      if (r.summarized) {
        messages.length = 0;
        messages.push(...r.messages);
        out(`  ${DIM}压掉 ${r.summarized} 条消息，${r.before} -> ${r.after} token${RESET}\n`);
        // 记账**不能**写进 messages 表：那张表会被 history() 原样重放，
        // 一条没有 content 的记录会让 resume 直接 400。
      } else {
        out(`  ${DIM}还没攒够可压缩的轮次，跳过${RESET}\n`);
      }
    }

    presenter.newRound();
    session.turn += 1;
    messages.push({ role: "user", content });
    session.record("user", messages[messages.length - 1]);

    // Ctrl-C 停这一轮，不退整个进程：跑一篇论文动辄几分钟几十次工具调用，
    // 中途改主意只能杀进程的话，产出和会话都白扔。AgentLoop 只在消息数组合法的
    // 位置响应，所以停完还能接着聊。
    const abort = new AbortController();
    const onSigint = () => {
      if (abort.signal.aborted) process.exit(130);   // 再按一次才是真退出
      out(`\n${DIM}正在停止…（再按一次 Ctrl-C 直接退出）${RESET}\n`);
      abort.abort();
    };
    process.on("SIGINT", onSigint);

    // 无人值守跑论文给足预算，交互式还是默认。
    let result: Awaited<ReturnType<AgentLoop["run"]>>;
    try {
      result = await loop.run(messages, dataArg ? UNATTENDED_MAX_TURNS : undefined, abort.signal);
    } finally {
      process.off("SIGINT", onSigint);
    }
    const u = result.usage;
    // 详细用量挪到底部状态栏，这里只在不正常收尾时说一句
    lastUsage = { prompt: u.promptTokens, completion: u.completionTokens,
                  cached: u.cachedTokens, cost: u.cost };
    if (result.stoppedBecause !== "stop" && result.stoppedBecause !== "end_turn") {
      out(`\n${DIM}${result.turns} 轮 · ${result.stoppedBecause}${RESET}\n`);
    }
    out("\n");
    return result;
  }

  // 末尾那段「没人在看」不是客套，是必需的。2026-08-26 实测：模型把计划列得很完整，
  // 最后问一句「是否立即执行上述步骤？」就停下等回答，而无人值守模式下没有人能回答，
  // 于是整场以「缺少交付物」收场，一个字的论文都没写。
  /**
   * 交付没齐时最多把模型推回去几次。
   *
   * 有上限是因为模型和检查器可能互相拉锯：它补一点、检查器报另一样缺的，来回耗光
   * 预算。三次够覆盖「忘了编译」「忘了生成 manifest」这类真能补上的疏漏，
   * 补不上就该如实报失败，而不是无限重试假装还有希望。
   */
  const UNATTENDED_MAX_PUSHES = 3;

  const oneShotTask = dataArg
    ? `我的数据就在当前工作区 ${root}。请使用 omnisci skill 从检查数据开始，端到端产出一篇候选论文、PDF 或 Overleaf 包，并通过 gate。${taskWords.length ? `研究意图：${taskWords.join(" ")}` : "研究问题和方法请根据数据自行提出。"}\n\n`
      + `这是无人值守运行：屏幕前没有人，你问任何问题都不会有人回答，停下来等确认就等于失败。`
      + `不要征求同意，不要问「是否继续」，也不要只把计划列出来就交差。`
      + `每一步都自己直接做完，一路做到 PDF 产出、gate 通过为止。\n\n`
      + `写正文的时候一次只写一节，写完一节就编译一次，过了再写下一节。`
      + `一口气生成整篇的话，每一节都会被写得太短而过不了字数要求。`
      + `正文和其它大段内容不要手写 JSON，写个脚本用 json.dump 落盘，转义交给库去做。`
    : taskWords.join(" ");

  if (oneShotTask) {
    const deliveryStartedAt = Date.now();
    let result = await oneRound(oneShotTask);
    // 一次性任务没有常驻状态栏，收尾补一行用量
    out(`${DIM}${statusLine().trim()}${RESET}\n`);
    if (dataArg) {
      let delivery = await verifyPaperDelivery(root, messages, deliveryStartedAt);

      // **交付没齐就把「差什么」原样甩回给模型，让它接着补。**
      //
      // 无人值守下这是唯一的纠偏机会：没有人会看见它半途而废。而检查器攒的错误
      // 恰恰是最好的指令 —— 它精确说明缺哪个文件、哪个回执，比任何泛泛的「继续」
      // 都有用。2026-08-26 实测：模型把计划列得好好的，最后问一句「是否立即执行
      // 上述步骤？」就收工了，交付检查报「缺少 paper.manifest.json」，而那正是
      // 一句话就能让它自己走下去的信息。
      //
      // 只在模型是「自认为说完了」时推。它要是撞了轮次上限或者被 Ctrl-C 停了，
      // 那是另一回事，推了也没用，还会盖掉真正的原因。
      for (let push = 0; !delivery.ok && push < UNATTENDED_MAX_PUSHES; push++) {
        if (result.stoppedBecause !== "stop" && result.stoppedBecause !== "end_turn") break;
        if (result.aborted) break; // 用户 Ctrl-C 停的，别硬推
        out(`${YELLOW}交付还差东西，让它继续做（第 ${push + 1}/${UNATTENDED_MAX_PUSHES} 次）${RESET}\n`);
        result = await oneRound(
          `交付检查没通过，还差这些：${delivery.errors.join("；")}\n`
          + `接着把它们做完。不要从头重来，不要问我，也不要只说计划 —— 直接动手，`
          + `一路做到 PDF 产出、gate 通过。`,
        );
        delivery = await verifyPaperDelivery(root, messages, deliveryStartedAt);
      }

      if (result.stoppedBecause !== "stop" && result.stoppedBecause !== "end_turn") {
        delivery.errors.push(`agent 非正常结束: ${result.stoppedBecause}`);
        delivery.ok = false;
      }
      if (!delivery.ok) {
        out(`${RED}OmniScientist 交付检查失败：${delivery.errors.join("；")}${RESET}\n`);
        session.close();
        return 3;
      }
      out(`${GREEN}OmniScientist 交付检查通过：论文 manifest、PDF、Overleaf 包、可信分析/引用回执、gate 和全部视觉审阅均有效。${RESET}\n`);
    }
    session.close();
    return 0;
  }

  // Ink + React 加载要 96ms，只有进 REPL 才需要，一次性任务不该为它买单
  const { startSession } = await import("./ui.tsx");
  out(`\n${BOLD}请告诉我你想做什么。${RESET}\n`);
  out(`${DIM}打 / 弹命令菜单，Ctrl-D 退出${RESET}\n\n`);
  const history = loadHistory();
  const ui = startSession(history);
  presenter.ui = ui;
  activeUI = ui;

  // 审批必须走同一个输入框。直接读 stdin 会跟 Ink 抢同一次按键，
  // 用户在思考期间提前打的字会被当成对审批的回答，等于静默批准。
  setAsker(async (promptLine, toolName, note) => {
    ui.print(`  ${YELLOW}▸ 需要批准${RESET} ${BOLD}${toolName}${RESET}  ${DIM}${promptLine.slice(0, 160)}${RESET}`);
    if (note) {
      // 硬拦截层或钩子要求单独点头。这种情况「一直允许」不生效，说清楚免得他以为按了 a 就一劳永逸。
      for (const line of note.split("\n")) ui.print(`  ${YELLOW}${line}${RESET}`);
      ui.print(`  ${DIM}在下面输入 y 这次允许 / n 拒绝（这一条每次都会问，不吃「一直允许」）${RESET}`);
    } else {
      ui.print(`  ${DIM}在下面输入 y 这次允许 / a 本次会话一直允许 / n 拒绝${RESET}`);
    }
    for (;;) {
      ui.setBusy(`等你批准 ${toolName}`);
      const ans = (await ui.next())?.trim().toLowerCase();
      if (ans === null || ans === undefined) return "deny";
      if (ans === "y" || ans === "yes") return "once";
      if (ans === "a" || ans === "always") return "session";
      if (ans === "n" || ans === "no") return "deny";
      ui.print(`  ${RED}只认 y / a / n${RESET}`);
    }
  });
  for (;;) {
    ui.setStatus(statusLine());
    const text = await ui.next();
    if (text === null) break;
    const trimmed = text.trim();
    if (!trimmed) continue;
    history.push(trimmed);
    appendHistory(trimmed);
    if (trimmed.startsWith("/")) {
      try {
        const quit = await handleCommand(
          trimmed, engine, caps, root, session, injected,
          provider, model.model, renderer, index, model, messages, cellInfo,
          { config: guardConfig, hooks: preToolUseHooks, policy },
        );
        if (quit) break;
      } catch (e) {
        // 命令出错只报错，绝不能把整个会话带走。
        // 之前 /recall 里打个引号就能让 SqliteError 冒到顶，进程直接退出。
        ui.print(`  ${RED}${e instanceof Error ? e.message : String(e)}${RESET}`);
      }
      continue;
    }
    await oneRound(trimmed);
    ui.setBusy(null);
    ui.setStatus(statusLine());
  }

  ui.stop();
  session.close();
  return 0;
}

async function handleCommand(
  text: string,
  engine: StandardsEngine,
  caps: ReturnType<typeof detect>,
  root: string,
  session: Session,
  injected: Set<string>,
  provider: string,
  modelName: string,
  renderer: FormulaRenderer,
  index: SearchIndex,
  model: ModelClient,
  messages: unknown[],
  cellInfo: string,
  gate: { config: ReturnType<typeof loadGuardConfig>; hooks: ReturnType<typeof loadHooks>; policy: ApprovalPolicy },
): Promise<boolean> {
  const [cmd = "", ...restParts] = text.slice(1).split(" ");
  const rest = restParts.join(" ").trim();

  if (cmd === "q" || cmd === "quit" || cmd === "exit") return true;

  if (cmd === "help") {
    for (const c of COMMANDS) {
      out(`  ${DIM}${c.name.padEnd(12)}${RESET}${DIM}  ${c.hint}${RESET}\n`);
    }
    out(`  ${DIM}打 / 会弹补全菜单，上下键选，Tab 或回车确认${RESET}\n`);
    return false;
  }

  if (cmd === "guard") {
    // 带命令就试判一条，**不执行**。规则一般是被坑一次加一条，
    // 加完得能立刻验证它真的咬得住，不然只能等下次被坑才知道写错了。
    if (rest) {
      const d = checkCommand(rest, { root: resolve(root), config: gate.config });
      const tag = d.verdict === "deny" ? `${RED}拒${RESET}` : d.verdict === "ask" ? `${YELLOW}问${RESET}` : `${GREEN}放行${RESET}`;
      out(`  ${tag}  ${DIM}${rest}${RESET}\n`);
      out(`  ${DIM}拆成：${commandClasses(rest).join("  |  ")}${RESET}\n`);
      if (d.reason) out(`  ${DIM}[${d.rule}] ${d.reason}${RESET}\n`);
      return false;
    }
    out(`${describeConfig(gate.config)}\n`);
    const hookCount = gate.hooks.reduce((n, m) => n + m.hooks.length, 0);
    out(`\nPreToolUse 钩子 ${hookCount} 个${hookCount ? "：" : "（配在 ~/.omnisci/settings.json）"}\n`);
    for (const m of gate.hooks) {
      for (const h of m.hooks) out(`  ${DIM}${(m.matcher ?? "*").padEnd(10)} ${h.command}${RESET}\n`);
    }
    const allowed = gate.policy.allowed();
    out(`\n本次会话已放行的命令类 ${allowed.length} 个${allowed.length ? "：" + allowed.join("  ") : ""}\n`);
    return false;
  }

  if (cmd === "standards") {
    engine.reload();
    const active = new Map(engine.active(gatherSignals(root, rest)).map((a) => [a.standard.name, a.reason]));
    out(`  ${BOLD}规矩${RESET} ${DIM}${engine.dir.replace(homedir(), "~")}${RESET}\n`);
    if (!engine.standards.length) {
      out(`  ${DIM}（空。往这个目录放 .md 就行，仓库 examples/standards/ 有模板）${RESET}\n`);
    }
    for (const s of engine.standards) {
      if (injected.has(s.name)) out(`  ${GREEN}●${RESET} ${s.name}  ${DIM}已在上下文里${RESET}\n`);
      else if (active.has(s.name))
        out(`  ${YELLOW}◐${RESET} ${s.name}  ${DIM}命中（${active.get(s.name)}），下一轮注入${RESET}\n`);
      else out(`  ${DIM}○ ${s.name}${RESET}\n`);
    }
    return false;
  }

  if (cmd === "soul") {
    const w = findWorkspaceSoul(root);
    out(`  全局  ${existsSync(GLOBAL_SOUL) ? GLOBAL_SOUL.replace(homedir(), "~") : DIM + "（没有，建 ~/.omnisci/AGENTS.md 就会自动带上）" + RESET}\n`);
    out(`  项目  ${w ?? DIM + "（没有，工作区放 AGENTS.md 即可）" + RESET}\n`);
    return false;
  }

  if (cmd === "remember") {
    if (!rest) {
      out(`  ${RED}要记什么？/remember 后面跟内容${RESET}\n`);
      return false;
    }
    const path = engine.capture(rest, rest.split("。")[0]!.slice(0, 40));
    out(`  ${DIM}收进待合并区: ${path}${RESET}\n`);
    return false;
  }

  if (cmd === "caps") {
    out(`  kitty_graphics=${caps.kittyGraphics} tmux=${caps.inTmux} tty=${caps.isTty}\n`);
    out(`  ${DIM}${caps.note}${RESET}\n`);
    out(`  终端 ${process.stdout.columns ?? "未知"} 列 x ${process.stdout.rows ?? "未知"} 行  ·  字符格 ${cellInfo}`);
    out(`  公式模式 ${renderer.mode}  ·  背景色 ${
      renderer.bgColor ? `rgb(${renderer.bgColor.replaceAll(";", ",")})，源码染成它隐身`
                       : "没查到，源码退到 SGR 8 隐藏属性"}\n`);
    return false;
  }

  if (cmd === "skills") {
    const all = loadSkills();
    if (!all.length) {
      out(`  ${DIM}没有加载到 skill。内置目录 ${BUILTIN_SKILLS_DIR}，用户目录 ${SKILLS_DIR.replace(homedir(), "~")}${RESET}\n`);
      return false;
    }
    out(`  ${BOLD}Skill${RESET} ${DIM}内置 ${BUILTIN_SKILLS_DIR} · 用户 ${SKILLS_DIR.replace(homedir(), "~")}${RESET}\n`);
    for (const s of all) {
      out(`  ${GREEN}▸${RESET} ${s.name}  ${DIM}${s.description.slice(0, 70)}${RESET}\n`);
      if (s.resources.length) out(`      ${DIM}带 ${s.resources.length} 个资源文件${RESET}\n`);
    }
    return false;
  }

  if (cmd === "formula") {
    if (rest === "clean" || rest === "src" || rest === "overlay") {
      renderer.mode = rest;
      const desc = { clean: "只有图，靠 /tex 复制",
                     src: "图下面跟一行源码，可选中复制",
                     overlay: "源码垫在图底下，选中图片区域即复制成源码（实验）" }[rest];
      out(`  ${DIM}${desc}${RESET}\n`);
    } else {
      out(`  ${DIM}现在是 ${renderer.mode}。可选 clean / src / overlay${RESET}\n`);
      out(`  ${DIM}overlay 是实验模式：把源码文字垫在图片格子里，图画在文字之上，${RESET}\n`);
      out(`  ${DIM}这样终端自己的复制拿到的就是源码。能不能盖住取决于终端图层合成，你试试${RESET}\n`);
    }
    return false;
  }

  if (cmd === "recall") {
    if (!rest) { out(`  ${RED}查什么？/recall 后面跟关键词${RESET}\n`); return false; }
    const hits = index.search(rest, 10);
    if (!hits.length) { out(`  ${DIM}没查到「${rest}」${RESET}\n`); return false; }
    for (const h of hits) {
      out(`  ${BLUE}[${h.kind}]${RESET} ${h.title}\n`);
      out(`      ${DIM}${h.snippet.replace(/\s+/g, " ").slice(0, 150)}${RESET}\n`);
    }
    return false;
  }

  if (cmd === "learn") {
    out(`  ${DIM}从这次对话里抽取值得长期记的规矩…${RESET}\n`);
    const lessons = await extractLessons(messages, model, engine);
    if (!lessons.length) { out(`  ${DIM}这次没有值得长期记的${RESET}\n`); return false; }
    for (const l of lessons) out(`  ${GREEN}+${RESET} ${l.name}  ${DIM}${l.description}${RESET}\n`);
    out(`  ${DIM}已收进待合并区，用 /merge 审${RESET}\n`);
    return false;
  }

  if (cmd === "merge") {
    out(`  ${DIM}审查待合并区…${RESET}\n`);
    const verdicts = await reviewInbox(engine, model);
    if (!verdicts.length) { out(`  ${DIM}待合并区是空的${RESET}\n`); return false; }
    for (const v of verdicts) {
      const mark = v.action === "new" ? `${GREEN}收编${RESET}`
        : v.action === "duplicate" ? `${DIM}重复，删${RESET}`
        : v.action === "extends" ? `${YELLOW}应并入 ${v.target}${RESET}`
        : `${RED}与 ${v.target} 冲突${RESET}`;
      out(`  ${mark}  ${v.name}\n      ${DIM}${v.reason}${RESET}\n`);
    }
    const r = applyMerge(engine, verdicts);
    out(`  ${DIM}收编 ${r.adopted.length} 条，删掉重复 ${r.dropped.length} 条`);
    if (r.collided.length) out(`，${YELLOW}${r.collided.length} 条同名没动（不覆盖已生效的规矩）${RESET}${DIM}`);
    out(`；冲突和待并入的留在 _inbox 等你处理${RESET}\n`);
    return false;
  }

  if (cmd === "tex") {
    // 图片没法选中，源码从渲染器里取，走 pbcopy 进剪贴板
    const all = renderer.formulas;
    if (!all.length) {
      out(`  ${DIM}这个会话还没渲染过展示公式${RESET}\n`);
      return false;
    }
    const pick = rest === "all"
      ? all.join("\n\n")
      : all[(Number(rest) || all.length) - 1];
    if (!pick) {
      out(`  ${RED}没有第 ${rest} 条，一共 ${all.length} 条${RESET}\n`);
      return false;
    }
    const proc = Bun.spawn(["pbcopy"], { stdin: "pipe", env: safeChildEnvironment() });
    proc.stdin.write(pick);
    proc.stdin.end();
    await proc.exited;
    out(`  ${DIM}已复制${rest === "all" ? `全部 ${all.length} 条` : `第 ${Number(rest) || all.length} 条`}到剪贴板${RESET}\n`);
    out(`  ${DIM}${pick.slice(0, 100)}${pick.length > 100 ? "…" : ""}${RESET}\n`);
    return false;
  }

  if (cmd === "trace") {
    // 折叠掉的工具细节都在会话库里，这里原样翻出来
    const rows = session.toolTrace(Number(rest) || undefined);
    if (!rows.length) {
      out(`  ${DIM}这一轮没有工具调用${RESET}\n`);
      return false;
    }
    for (const r of rows) {
      out(`  ${DIM}第${r.turn}轮${RESET} ${BLUE}●${RESET} ${r.name}  ${DIM}${r.args.slice(0, 100)}${RESET}\n`);
      out(`       ${DIM}${r.result.replace(/\n/g, " ").slice(0, 140)}${RESET}\n`);
    }
    return false;
  }

  if (cmd === "balance") {
    const b = await fetchBalance(provider as ProviderName);
    out(b ? `  ${b}\n` : `  ${DIM}${provider} 这个通道没有余额接口${RESET}\n`);
    return false;
  }

  if (cmd === "model") {
    out(`  ${provider}:${modelName}\n`);
    return false;
  }

  if (cmd === "update") {
    // 手动查，跳过每日节流。仍然只报不装：真要装的是下面那条命令，由用户自己敲。
    out(`  ${DIM}正在查最新版本…${RESET}\n`);
    // 带上 onError。不带的话断网和限流也回 null，这里只能含糊地说"或者查不到
    // release"，把一次没查成和一次查过混为一谈。用户刚亲手敲了 /update，
    // 他要的是一个明确答复。
    let failed: string | null = null;
    const info = await checkForUpdate(VERSION, "cli", {
      force: true,
      onError: (reason) => { failed = reason; },
    });
    if (failed) {
      out(`  ${YELLOW}没查成${RESET}：${failed as string}，当前 ${VERSION}\n`);
    } else if (!info) {
      out(`  当前 ${VERSION}，已是最新\n`);
    } else {
      out(`  ${YELLOW}有新版本 ${info.latest}${RESET}，当前 ${info.current}\n`);
      out(`  ${info.url}\n`);
      out(`  ${DIM}更新命令：${updateCommand("cli")}${RESET}\n`);
      if (info.asset?.sumsUrl) out(`  ${DIM}校验和：${info.asset.sumsUrl}${RESET}\n`);
    }
    out(`  ${DIM}关掉每日检查：在 ~/.omnisci/env 里写 OMNISCI_UPDATE_CHECK=off${RESET}\n`);
    return false;
  }

  if (cmd === "session") {
    out(`  ${session.id}  ${DIM}续用: omnisci --resume ${session.id}${RESET}\n`);
    return false;
  }

  out(`  ${RED}不认识的命令 /${cmd}${RESET}  ${DIM}/help 看列表${RESET}\n`);
  return false;
}

process.exit(await main());
