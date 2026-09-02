import {
  ArrowDown,
  ArrowUp,
  Check,
  CheckCircle2,
  ChevronDown,
  CircleAlert,
  ChevronRight,
  ChevronUp,
  Code2,
  Copy,
  Database,
  File,
  FileText,
  FlaskConical,
  Folder,
  Image,
  ListTree,
  LoaderCircle,
  Languages,
  PanelLeftOpen,
  Square,
  PanelRightOpen,
  Paperclip,
  ShieldCheck,
  Table2,
  X,
} from "lucide-react";
import { Highlight, themes, type Language } from "prism-react-renderer";
import {
  Children,
  isValidElement,
  useEffect,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import Markdown, { type Components } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { LANGS, t, useLang, type Lang } from "../lib/i18n";
import { cancelPick, importIntoWorkspace, pickFromComputer, PickUnavailableError, tauriDialog } from "../lib/workspace";
import type { Artifact, ChatMessage, ChatSession, MessageBlock, ResearchTrace, ToolStep } from "../types";
import { WorkspacePicker } from "./WorkspacePicker";
import { DependencyBanner } from "./DependencyBanner";
import { IconButton } from "./IconButton";

interface ChatPaneProps {
  session: ChatSession;
  draft: string;
  leftOpen: boolean;
  workbenchOpen: boolean;
  busy: boolean;
  onStop: () => void;
  /** 还没配研究模型的 key。输入框置灰，并指路到左下角。 */
  needsKey?: boolean;
  onToggleLeft: () => void;
  onToggleWorkbench: () => void;
  onDraftChange: (value: string) => void;
  onSend: (content: string, dataPath?: string) => void;
  onOpenArtifact: (artifact: Artifact) => void;
  onOpenTrace: (trace: ResearchTrace) => void;
}

const artifactIcon = {
  paper: FileText,
  figure: Image,
  code: Code2,
  table: Table2,
};

function textContent(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textContent).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return textContent(node.props.children);
  return "";
}

function MarkdownCodeBlock({ children }: ComponentPropsWithoutRef<"pre">) {
  const [copied, setCopied] = useState(false);
  const child = Children.toArray(children)[0];
  const className = isValidElement<{ className?: string }>(child) ? child.props.className ?? "" : "";
  const language = /language-([\w-]+)/.exec(className)?.[1] ?? "text";
  const code = textContent(child).replace(/\n$/, "");

  const copy = async () => {
    await navigator.clipboard?.writeText(code);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  };

  return (
    <div className="markdown-code-shell">
      <div className="markdown-code-head">
        <span>{language}</span>
        <button type="button" onClick={copy} aria-label={copied ? t("代码已复制") : t("复制代码")}>
          {copied ? <Check size={13} /> : <Copy size={13} />}
          {copied ? t("已复制") : t("复制")}
        </button>
      </div>
      <Highlight theme={themes.github} code={code} language={language as Language}>
        {({ className: prismClass, style, tokens, getLineProps, getTokenProps }) => (
          <pre className={`${prismClass} markdown-code-pre`} style={style}>
            <code>
              {tokens.map((line, lineIndex) => {
                const lineProps = getLineProps({ line });
                return (
                  <span
                    {...lineProps}
                    className={`markdown-code-line ${lineProps.className ?? ""}`}
                    key={lineIndex}
                  >
                    <span className="markdown-code-number" aria-hidden="true">{lineIndex + 1}</span>
                    <span className="markdown-code-source">
                      {line.map((token, tokenIndex) => (
                        <span {...getTokenProps({ token })} key={tokenIndex} />
                      ))}
                    </span>
                  </span>
                );
              })}
            </code>
          </pre>
        )}
      </Highlight>
    </div>
  );
}

const markdownComponents: Components = {
  pre: MarkdownCodeBlock,
  a({ node: _node, ...props }) {
    return <a {...props} target="_blank" rel="noreferrer" />;
  },
  table({ node: _node, ...props }) {
    return <div className="markdown-table-scroll"><table {...props} /></div>;
  },
};

function MessageBody({ content }: { content: string }) {
  if (!content) return null;
  return (
    <div className="message-body">
      <Markdown remarkPlugins={[remarkGfm, remarkBreaks]} components={markdownComponents}>
        {content}
      </Markdown>
    </div>
  );
}

/**
 * 等待指示器：项目那个点阵 logo 在转。
 *
 * 用 logo 而不是通用的 loader 图标，是因为等待窗口有时候很长（会话一长，
 * 模型吐第一个字可能要几十秒），这段时间里屏幕上唯一在动的东西就是它，
 * 它得让人一眼认出"是这个程序在想，不是卡死了"。
 */
function LogoSpinner({ size = 15 }: { size?: number }) {
  return (
    <img
      src="/assets/omni-logo.svg"
      className="logo-spinner"
      style={{ width: size, height: size }}
      alt=""
      aria-hidden="true"
    />
  );
}

function WaitingLine({ label }: { label: string }) {
  return (
    <div className="thinking-line" role="status">
      <LogoSpinner size={14} />
      <span>{label}</span>
    </div>
  );
}

function TraceButton({ trace, onOpen }: { trace: ResearchTrace; onOpen: (trace: ResearchTrace) => void }) {
  return (
    <button className="tool-trace-open" type="button" onClick={() => onOpen(trace)}>
      <span className="tool-trace-open-icon"><ListTree size={16} /></span>
      <span>
        <strong>{t("查看完整轨迹")}</strong>
        <small>{t("{0} 次调用 · 脱敏参数与关键输出", trace.entries.length)}</small>
      </span>
      <PanelRightOpen size={16} />
    </button>
  );
}

function ToolStepRow({ step }: { step: ToolStep }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const expandable = step.status !== "running";
  const visibleOutput = step.output
    ?? (step.tool === "use_skill"
      ? t("Skill 已加载。完整说明仅用于 Agent 执行，不在界面中展示。")
      : t("此步骤没有可展示的额外输出。"));
  const outputId = `${step.id}-output`;

  const copyOutput = async () => {
    if (!step.output) return;
    await navigator.clipboard?.writeText(step.output);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  };

  const row = (
    <>
      <span className="tool-step-mark">
        {step.status === "complete"
          ? <Check size={11} />
          : step.status === "failed"
            ? <X size={11} />
            : <LoaderCircle size={12} />}
      </span>
      <span className="tool-step-copy">
        <span>
          <strong>{t(step.label)}</strong>
          <code>{step.tool}</code>
        </span>
        <span>{t(step.detail, ...(step.detailArgs ?? []))}</span>
      </span>
      <span className="tool-step-tail">
        {step.duration ? <time>{step.duration}</time> : null}
        {expandable ? (open ? <ChevronDown size={14} /> : <ChevronRight size={14} />) : null}
      </span>
    </>
  );

  return (
    <div className={`tool-step-shell tool-step-shell--${step.status} ${open ? "is-open" : ""}`}>
      {expandable ? (
        <button
          className={`tool-step tool-step--${step.status} tool-step-trigger`}
          type="button"
          aria-expanded={open}
          aria-controls={outputId}
          aria-label={t("{0}{1}输出", t(open ? "收起" : "展开"), step.label)}
          onClick={() => setOpen((value) => !value)}
        >
          {row}
        </button>
      ) : (
        <div className={`tool-step tool-step--${step.status}`}>{row}</div>
      )}
      {open ? (
        <div className="tool-step-output" id={outputId}>
          <div className="tool-step-output-head">
            <span>{step.outputTruncated ? t("工具输出 · 已截断") : t("工具输出")}</span>
            {step.output ? (
              <button
                type="button"
                onClick={copyOutput}
                aria-label={copied ? t("{0}输出已复制", step.label) : t("复制{0}输出", step.label)}
              >
                {copied ? <Check size={13} /> : <Copy size={13} />}
                {copied ? t("已复制") : t("复制")}
              </button>
            ) : null}
          </div>
          <pre>{visibleOutput}{step.outputTruncated ? "\n\n" + t("[输出较长，仅显示前 12,000 个字符]") : ""}</pre>
        </div>
      ) : null}
    </div>
  );
}

function TimelineBlock({ block }: { block: MessageBlock }) {
  if (block.type === "markdown") return <MessageBody content={block.content} />;
  return (
    <div className="timeline-tool">
      <ToolStepRow step={block.step} />
    </div>
  );
}

function AssistantTimeline({
  message,
  streaming,
  onOpenTrace,
}: {
  message: ChatMessage;
  streaming: boolean;
  onOpenTrace: (trace: ResearchTrace) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const blocks = message.blocks ?? [];
  const blockSteps = blocks
    .filter((block): block is Extract<MessageBlock, { type: "tool" }> => block.type === "tool")
    .map((block) => block.step);
  const steps = message.toolRun?.steps ?? blockSteps;
  const runningStep = steps.find((step) => step.status === "running");
  const completeCount = steps.filter((step) => step.status !== "running").length;
  const phase = message.progress ?? (streaming ? "thinking" : "complete");
  const statusLabel = runningStep?.label
    ?? (phase === "writing" ? t("正在输出结果")
      : phase === "thinking" ? (blocks.length ? t("正在分析下一步") : t("正在分析请求"))
        : phase === "tool" ? t("正在运行工具")
          : t("研究运行完成"));
  const showProgress = streaming || steps.length > 0;
  const finalAnswer = [...blocks].reverse().find((block) => block.type === "markdown");
  const visibleBlocks = expanded
    ? blocks
    : (!streaming && finalAnswer ? [finalAnswer] : []);

  return (
    <div className={`assistant-timeline ${expanded ? "is-expanded" : "is-collapsed"}`}>
      {showProgress ? (
        <button
          className={`live-run-head ${streaming ? "is-running" : "is-complete"}`}
          type="button"
          aria-expanded={expanded}
          aria-label={expanded ? t("收起运行过程") : t("展开运行过程")}
          onClick={() => setExpanded((value) => !value)}
        >
          <span className="live-run-icon">
            {streaming ? <LogoSpinner size={15} /> : <Check size={13} />}
          </span>
          <strong>{statusLabel}</strong>
          <small>{steps.length ? t("{0}/{1} 个工具完成", completeCount, steps.length) : t("准备研究上下文")}</small>
          <span className="live-run-collapse" aria-hidden="true">
            {expanded ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
          </span>
        </button>
      ) : null}
      <div className="message-timeline">
        {visibleBlocks.map((block) => <TimelineBlock block={block} key={block.id} />)}
        {expanded && streaming && phase === "thinking" ? (
          <WaitingLine label={blocks.length ? t("继续分析中") : t("正在读取上下文")} />
        ) : null}
        {expanded && streaming && phase === "writing" ? <span className="streaming-caret" aria-hidden="true" /> : null}
      </div>
      {!streaming && message.toolRun?.trace ? (
        <div className="timeline-trace-link">
          <TraceButton trace={message.toolRun.trace} onOpen={onOpenTrace} />
        </div>
      ) : null}
    </div>
  );
}

function ToolRun({
  run,
  onOpenTrace,
}: {
  run: NonNullable<ChatMessage["toolRun"]>;
  onOpenTrace?: (trace: ResearchTrace) => void;
}) {
  const running = run.steps.some((step) => step.status === "running");
  const [open, setOpen] = useState(running);

  useEffect(() => {
    if (running) setOpen(true);
  }, [running]);

  return (
    <section className={`tool-run ${running ? "is-running" : ""}`}>
      <button className="tool-run-summary" type="button" onClick={() => setOpen((value) => !value)}>
        <span className="tool-run-icon">
          {running ? <LoaderCircle size={15} /> : <CheckCircle2 size={15} />}
        </span>
        {/* title 是后端给的（"研究运行完成" / "已停止" / "这一轮没跑完"），
            以前直接裸渲染，英文界面上就露出一句中文。 */}
        <span className="tool-run-title">
          <strong>{t(run.title)}</strong>
          <small>{t(run.summary)}</small>
        </span>
        {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
      </button>
      {open ? (
        <>
          <div className="tool-step-list">
            {run.steps.map((step) => <ToolStepRow step={step} key={step.id} />)}
          </div>
          {run.trace && onOpenTrace ? <TraceButton trace={run.trace} onOpen={onOpenTrace} /> : null}
        </>
      ) : null}
    </section>
  );
}

function ArtifactRow({ artifact, onOpen }: { artifact: Artifact; onOpen: () => void }) {
  const KindIcon = artifactIcon[artifact.kind];
  return (
    <button className="artifact-row" type="button" onClick={onOpen}>
      <span className={`artifact-kind artifact-kind--${artifact.kind}`}>
        <KindIcon size={17} />
      </span>
      <span className="artifact-copy">
        <strong>{artifact.title}</strong>
        <small>{t(artifact.detail, ...(artifact.detailArgs ?? []))}</small>
      </span>
      <span className="artifact-path">{artifact.path}</span>
      <PanelRightOpen size={16} className="artifact-open-icon" />
    </button>
  );
}

function AssistantMessage({
  message,
  streaming,
  onOpenArtifact,
  onOpenTrace,
}: {
  message: ChatMessage;
  streaming: boolean;
  onOpenArtifact: (artifact: Artifact) => void;
  onOpenTrace: (trace: ResearchTrace) => void;
}) {
  const [copied, setCopied] = useState(false);

  const copyMessage = async () => {
    await navigator.clipboard?.writeText(message.content);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  };

  return (
    <article className="chat-message assistant-message">
      <div className="assistant-avatar">
        <img src="/assets/omni-logo.svg" alt="" />
      </div>
      <div className="assistant-content">
        <header className="message-meta">
          <strong>{message.author}</strong>
          <span className="workflow-name">OmniScientist</span>
          <time>{message.time}</time>
        </header>
        {message.blocks ? (
          <AssistantTimeline message={message} streaming={streaming} onOpenTrace={onOpenTrace} />
        ) : (
          <>
            {message.toolRun ? <ToolRun run={message.toolRun} onOpenTrace={onOpenTrace} /> : null}
            {message.content ? <MessageBody content={message.content} /> : <WaitingLine label={t("正在分析请求")} />}
          </>
        )}
        {message.citations?.length ? (
          <div className="citation-strip" aria-label={t("引用来源")}>
            {message.citations.map((citation) => (
              <span className="citation-chip" key={citation.id} title={citation.source}>
                <span>{citation.id}</span>
                {t(citation.label)}
              </span>
            ))}
          </div>
        ) : null}
        {message.artifacts?.length ? (
          <div className="message-artifacts">
            <div className="artifact-section-label">
              <span>{t("本轮产物")}</span>
              <small>{t("{0} 项", message.artifacts.length)}</small>
            </div>
            {message.artifacts.map((artifact) => (
              <ArtifactRow
                artifact={artifact}
                key={artifact.id}
                onOpen={() => onOpenArtifact(artifact)}
              />
            ))}
          </div>
        ) : null}
        {message.content && !streaming ? (
          <div className="message-actions">
            <button type="button" onClick={copyMessage}>
              {copied ? <Check size={14} /> : <Copy size={14} />}
              {copied ? t("已复制") : t("复制")}
            </button>
          </div>
        ) : null}
      </div>
    </article>
  );
}

function EmptyConversation({ onPrompt, workspace }: { onPrompt: (prompt: string) => void; workspace: string }) {
  const prompts = [
    t("检查数据并提出可验证的研究假设"),
    t("继续现有论文，先审阅最近的 PDF"),
    t("整理当前工作区的图表和证据"),
  ];
  return (
    <div className="empty-conversation">
      <div className="empty-mark"><img src="/assets/omni-logo.svg" alt="" /></div>
      <h2>{t("今天研究什么？")}</h2>
      <p>{workspace}</p>
      <div className="prompt-suggestions">
        {prompts.map((prompt) => (
          <button type="button" key={prompt} onClick={() => onPrompt(prompt)}>{prompt}</button>
        ))}
      </div>
    </div>
  );
}

/**
 * 语言切换。
 *
 * 自绘下拉，不用原生 <select>。原生的省事，但有两处忍不了：
 *
 *   1. 弹出层是系统画的，跟这套界面的底色、圆角、字号全对不上。
 *   2. macOS 的 popup button 会把**当前选中项**对齐到鼠标位置。选到列表末尾的
 *      俄语时，整个菜单翻到按钮上方去了，同一个控件每次弹的位置都不一样。
 *
 * 所以这里自己画，永远贴着按钮下沿展开，位置跟选中谁无关。代价是键盘、点外面
 * 关闭、无障碍要自己接，下面都接了。
 *
 * 选项名一律用该语言自己的写法（日本語 / Русский），看得懂那个名字的人
 * 正是要选它的人。语言是全局状态（见 i18n 的 LangProvider），整个界面只此一个
 * 开关，切了之后所有组件跟着重渲染。
 */
function LanguageToggle() {
  const [lang, setLang] = useLang();
  const [open, setOpen] = useState(false);
  /** 键盘焦点停在第几项。roving tabindex：只有它是 tab 停靠点。 */
  const [active, setActive] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const options = useRef<Array<HTMLButtonElement | null>>([]);
  /** 首字母连打的缓冲，跟原生 select 一样，停顿一下就重新开始。 */
  const typed = useRef({ text: "", at: 0 });

  const index = Math.max(0, LANGS.findIndex((entry) => entry.code === lang));
  const current = LANGS[index];

  function close(focusTrigger: boolean) {
    setOpen(false);
    // 关掉之后焦点必须回到按钮上。不回的话它跟着被卸载的选项一起消失，
    // 键盘用户被扔回文档顶部，每切一次语言就要重新 Tab 一遍整页。
    if (focusTrigger) trigger.current?.focus();
  }

  function choose(next: number) {
    setLang(LANGS[next]!.code);
    close(true);
  }

  // 点外面关掉。用 pointerdown 不用 mousedown：iOS Safari 点在非可点击元素上
  // 不会合成 mouse 事件，用 mousedown 的话在手机上点空白处关不掉菜单。
  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => {
      if (!box.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open]);

  // 焦点跟着 active 走。菜单一开就落在当前语言那一项上，方向键再挪。
  useEffect(() => {
    if (open) options.current[active]?.focus();
  }, [open, active]);

  function onMenuKey(event: KeyboardEvent<HTMLUListElement>) {
    const last = LANGS.length - 1;
    const go = (to: number) => {
      event.preventDefault();
      setActive(Math.min(last, Math.max(0, to)));
    };
    if (event.key === "ArrowDown") return go(active === last ? 0 : active + 1);
    if (event.key === "ArrowUp") return go(active === 0 ? last : active - 1);
    if (event.key === "Home") return go(0);
    if (event.key === "End") return go(last);
    if (event.key === "Escape") { event.preventDefault(); return close(true); }
    if (event.key === "Tab") return setOpen(false);   // Tab 走人就关掉，别留个孤菜单
    // 首字母连打。原生 select 有这个，拆掉了就得补。
    if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
      const now = Date.now();
      typed.current.text = now - typed.current.at > 800 ? event.key : typed.current.text + event.key;
      typed.current.at = now;
      const want = typed.current.text.toLowerCase();
      let hit = LANGS.findIndex((entry) => entry.native.toLowerCase().startsWith(want));
      // 连打没匹配上就拿最后一个字母重新起头。English 和 Español 都是 E 开头，
      // 所以缓冲区有用；但接着打 "d" 再打 "p" 是想去 Português，不是想找
      // "dp" 开头的语言，卡住不动会让人以为键盘失灵。
      if (hit < 0 && want.length > 1) {
        typed.current.text = event.key;
        const one = event.key.toLowerCase();
        hit = LANGS.findIndex((entry) => entry.native.toLowerCase().startsWith(one));
      }
      if (hit >= 0) go(hit);
    }
  }

  return (
    <div
      className="lang-toggle-box"
      ref={box}
      onBlur={(event) => {
        // 焦点跑到这个部件外面就关掉。不关的话 Tab 出去之后菜单还开着，
        // 一个没人管的浮层挂在那儿。
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      <button
        type="button"
        ref={trigger}
        className="lang-toggle"
        // 名字里要带上当前语言。只写"切换界面语言"的话，屏幕阅读器把可见文字
        // 盖掉了，用户听不到现在是哪一种（WCAG 2.5.3 也要求可访问名包含可见标签）。
        aria-label={`${t("切换界面语言")}: ${current?.native ?? "English"}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls="lang-menu"
        onClick={() => {
          setActive(index);
          setOpen((was) => !was);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setActive(index);
            setOpen(true);
          }
        }}
      >
        <Languages size={15} aria-hidden="true" />
        <span className="lang-toggle-current">{current?.native ?? "English"}</span>
        <ChevronDown size={13} aria-hidden="true" className="lang-toggle-caret" />
      </button>

      {open ? (
        <ul
          id="lang-menu"
          className="lang-menu"
          role="listbox"
          aria-label={t("切换界面语言")}
          onKeyDown={onMenuKey}
        >
          {LANGS.map((entry, i) => (
            // role="presentation" 不能省。<ul> 一旦被 role="listbox" 顶掉隐式的
            // list 角色，里面的 <li> 就不再是 listitem，浏览器会连带把它内部的
            // option 角色一起作废——实测无障碍树里十个全变成 button，
            // aria-selected 整个丢掉，等于一个不含任何选项的 listbox。
            <li key={entry.code} role="presentation">
              <button
                type="button"
                ref={(node) => { options.current[i] = node; }}
                role="option"
                aria-selected={entry.code === lang}
                tabIndex={i === active ? 0 : -1}
                lang={entry.html}
                className={entry.code === lang ? "is-current" : undefined}
                onClick={() => choose(i)}
                onFocus={() => setActive(i)}
              >
                <span>{entry.native}</span>
                {entry.code === lang ? <Check size={13} aria-hidden="true" /> : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function ChatPane({
  session,
  draft,
  leftOpen,
  workbenchOpen,
  busy,
  onStop,
  needsKey = false,
  onToggleLeft,
  onToggleWorkbench,
  onDraftChange,
  onSend,
  onOpenArtifact,
  onOpenTrace,
}: ChatPaneProps) {
  const [awayFromBottom, setAwayFromBottom] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  /** 界面上选的数据目录。它不是用户打的字，所以不进输入框，单独当一个选项挂着。 */
  const [dataPath, setDataPath] = useState("");
  const [pickMenu, setPickMenu] = useState(false);
  /** dialog = 系统选择框开着等用户选；copy = 后端正在往工作区复制。 */
  const [pickPhase, setPickPhase] = useState<null | "dialog" | "copy">(null);
  const [importProgress, setImportProgress] = useState<{ copied: number; total: number } | null>(null);
  const [importHint, setImportHint] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const followOutputRef = useRef(true);

  useEffect(() => {
    const node = scrollRef.current;
    if (!node || !followOutputRef.current) return;
    node.scrollTo({ top: node.scrollHeight, behavior: "auto" });
  }, [session.messages]);

  useEffect(() => {
    followOutputRef.current = true;
    setAwayFromBottom(false);
    window.requestAnimationFrame(() => {
      const node = scrollRef.current;
      if (node) node.scrollTop = node.scrollHeight;
    });
  }, [session.id]);

  useEffect(() => {
    if (!textareaRef.current) return;
    textareaRef.current.style.height = "0";
    textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 144)}px`;
  }, [draft]);

  const submit = () => {
    const content = draft.trim();
    if (!content || busy || needsKey) return;
    followOutputRef.current = true;
    setAwayFromBottom(false);
    onSend(content, dataPath || undefined);
  };

  const handleConversationScroll = () => {
    const node = scrollRef.current;
    if (!node) return;
    const atBottom = node.scrollHeight - node.scrollTop - node.clientHeight <= 72;
    followOutputRef.current = atBottom;
    setAwayFromBottom(!atBottom);
  };

  const jumpToLatest = () => {
    const node = scrollRef.current;
    if (!node) return;
    followOutputRef.current = true;
    setAwayFromBottom(false);
    node.scrollTop = node.scrollHeight;
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };

  /** 系统面板选一个文件/文件夹，后端原生复制进工作区。数据不过浏览器，多大都行。 */
  async function pickData(kind: "file" | "folder") {
    setPickMenu(false);
    setPickPhase("dialog");
    setImportError(null);
    try {
      // Tauri 壳里直接用壳的原生对话框：秒弹、焦点天然正确。浏览器模式退回
      // 后端代弹（osascript / PowerShell），那条路慢且在 Windows 上抢不到前台。
      let picked: string | null;
      const dialog = tauriDialog();
      if (dialog) {
        const chosen = await dialog.open({ directory: kind === "folder", multiple: false });
        picked = typeof chosen === "string" ? chosen : null;
      } else {
        picked = await pickFromComputer(kind);
      }
      if (picked === null) return;   // 用户在面板里点了取消
      setPickPhase("copy");
      setImportProgress(null);
      setImportHint(null);
      const rel = await importIntoWorkspace(picked, {
        onProgress: (copied, total) => setImportProgress({ copied, total }),
        // 文件太多或太大：复制会慢，直接告诉用户可以把文件夹放进工作区目录再选，跳过复制
        onStart: (info) => setImportHint(info.hint ? info.workspace : null),
      });
      setDataPath(rel);
      textareaRef.current?.focus();
    } catch (e) {
      // 这台机器弹不出系统面板（无 GUI 的 Linux 等），退回目录树弹窗
      if (e instanceof PickUnavailableError) { setPickerOpen(true); return; }
      setImportError(e instanceof Error ? e.message : String(e));
    } finally {
      setPickPhase(null);
      setImportProgress(null);
      setImportHint(null);
    }
  }

  return (
    <main className="chat-pane">
      <header className="chat-header">
        <div className="chat-header-leading">
          {!leftOpen ? (
            <IconButton label={t("打开对话栏")} tone="quiet" onClick={onToggleLeft}>
              <PanelLeftOpen size={18} />
            </IconButton>
          ) : null}
          <div className="chat-title-block">
            <div className="chat-breadcrumb"><span>{session.workspace}</span></div>
            <h1>{t(session.title)}</h1>
          </div>
        </div>
        <div className="chat-header-actions">
          <LanguageToggle />
          <span className={`session-health session-health--${session.status}`}>
            <span />
            {session.status === "running" ? t("运行中") : t("已同步")}
          </span>
          <IconButton
            label={workbenchOpen ? t("收起工作台") : t("打开工作台")}
            active={workbenchOpen}
            onClick={onToggleWorkbench}
          >
            <PanelRightOpen size={18} />
          </IconButton>
        </div>
      </header>

      <DependencyBanner />

      <div className="conversation-scroll" ref={scrollRef} onScroll={handleConversationScroll}>
        <div className="conversation-inner">
          {!session.messages.length ? <EmptyConversation onPrompt={onDraftChange} workspace={session.workspace} /> : null}
          {session.messages.map((message, index) =>
            message.role === "user" ? (
              <article className="chat-message user-message" key={message.id}>
                <div className="user-bubble"><MessageBody content={message.content} /></div>
                <div className="user-meta"><span>{message.author}</span><time>{message.time}</time></div>
              </article>
            ) : (
              <AssistantMessage
                message={message}
                streaming={busy && index === session.messages.length - 1}
                key={message.id}
                onOpenArtifact={onOpenArtifact}
                onOpenTrace={onOpenTrace}
              />
            ),
          )}

          {/* 点了发送但服务端还没回第一个事件的那段空窗。以前这里什么都没有，
              网络稍慢就像卡死了；现在至少有个转的 logo 说明请求已经出去了。 */}
          {busy && session.messages[session.messages.length - 1]?.role === "user" ? (
            <div className="pending-turn" role="status">
              <LogoSpinner size={16} />
              <span>{t("正在连接本地研究进程…")}</span>
            </div>
          ) : null}
        </div>
      </div>
      {awayFromBottom ? (
        <button
          className="jump-to-latest"
          type="button"
          aria-label={t("回到最新消息")}
          title={t("回到最新消息")}
          onClick={jumpToLatest}
        >
          <ArrowDown size={17} />
        </button>
      ) : null}

      <footer className="composer-wrap">
        <div className={`composer ${busy ? "is-busy" : ""}`}>
          {pickPhase || importError ? (
            <div className="composer-context">
              <span className="context-chip">
                {pickPhase ? <LoaderCircle size={13} className="spin" /> : <CircleAlert size={13} />}
                <span>
                  {pickPhase === "dialog"
                    ? t("在系统弹出的窗口里选…")
                    : pickPhase === "copy"
                      ? (importProgress && importProgress.total > 0
                        ? t("正在导入… {0} / {1}", importProgress.copied, importProgress.total)
                        : t("正在导入…"))
                        + (importHint ? " " + t("文件较多，复制会慢。也可以直接把它放进 {0} 目录里，再从「选择数据」里选。", importHint) : "")
                      : t("导入失败 {0}", importError ?? "")}
                </span>
                {pickPhase === "dialog" && !tauriDialog() ? (
                  <button type="button" className="context-link" onClick={() => cancelPick()}>
                    {t("取消")}
                  </button>
                ) : null}
                {!pickPhase ? (
                  <button type="button" onClick={() => setImportError(null)} aria-label={t("关闭")}>
                    <X size={12} />
                  </button>
                ) : null}
              </span>
            </div>
          ) : null}
          {dataPath ? (
            <div className="composer-context">
              <span className="context-chip">
                <Database size={13} />
                <code>{dataPath}</code>
                <button type="button" onClick={() => setDataPath("")} aria-label={t("取消选择数据目录")}>
                  <X size={12} />
                </button>
              </span>
            </div>
          ) : null}
          <textarea
            ref={textareaRef}
            value={draft}
            onChange={(event) => onDraftChange(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder={needsKey
              ? t("先在左下角填一个模型 API key，然后就能开始研究")
              : busy ? t("OmniScientist 正在处理当前任务…") : t("告诉 OmniScientist 接下来研究什么")}
            disabled={needsKey}
            aria-label={t("消息输入")}
            rows={1}
          />
          <div className="composer-toolbar">
            <div className="composer-tools">
              <span className="pick-menu-wrap">
                <IconButton
                  label={t("选择数据")}
                  tone="quiet"
                  onClick={() => setPickMenu((open) => !open)}
                >
                  <Paperclip size={17} />
                </IconButton>
                {pickMenu ? (
                  <>
                    {/* 点外面关掉菜单。透明层压在页面上，菜单本体 z 序更高。 */}
                    <div className="pick-menu-backdrop" onClick={() => setPickMenu(false)} />
                    <div className="pick-menu" role="menu">
                      <button type="button" role="menuitem" disabled={pickPhase !== null} onClick={() => void pickData("file")}>
                        <File size={14} /> {t("选文件…")}
                      </button>
                      <button type="button" role="menuitem" disabled={pickPhase !== null} onClick={() => void pickData("folder")}>
                        <Folder size={14} /> {t("选文件夹…")}
                      </button>
                    </div>
                  </>
                ) : null}
              </span>
              <span className="skill-selector">
                <FlaskConical size={14} />
                OmniScientist
              </span>
            </div>
            {busy ? (
              <button
                className="send-button is-stop"
                type="button"
                aria-label={t("停止研究")}
                title={t("停止研究")}
                onClick={onStop}
              >
                <Square size={15} />
              </button>
            ) : (
              <button
                className="send-button"
                type="button"
                onClick={submit}
                disabled={!draft.trim()}
                aria-label={t("发送消息")}
                title={t("发送消息")}
              >
                <ArrowUp size={18} strokeWidth={2.4} />
              </button>
            )}
          </div>
        </div>
        <div className="composer-status">
          <span><span className="status-dot" /> {session.model}</span>
          <span>{session.workspace}</span>
          <span className="status-security"><ShieldCheck size={12} /> {t("本地工作区")}</span>
        </div>
      </footer>

      {/* 选完之后把相对路径接到输入框里，agent 自己去读盘。 */}
      <WorkspacePicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onPick={(path) => {
          setDataPath(path);
          textareaRef.current?.focus();
        }}
      />
    </main>
  );
}
