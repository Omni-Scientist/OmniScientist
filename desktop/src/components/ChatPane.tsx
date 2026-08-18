import {
  ArrowDown,
  ArrowUp,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Code2,
  Copy,
  Database,
  FileText,
  FlaskConical,
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
import { t, useLang } from "../lib/i18n";
import type { Artifact, ChatMessage, ChatSession, MessageBlock, ResearchTrace, ToolStep } from "../types";
import { WorkspacePicker } from "./WorkspacePicker";
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
        <span>{t(step.detail)}</span>
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
          <small>{run.summary}</small>
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
        <small>{artifact.detail}</small>
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
                {citation.label}
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
 * 中英切换。只有两种语言，所以不做下拉，点一下就换过去，
 * 按钮上直接写要切到哪一种（"EN" / "中"），不用猜。
 */
function LanguageToggle() {
  const [lang, setLang] = useLang();
  const next = lang === "zh" ? "en" : "zh";
  return (
    <button
      type="button"
      className="lang-toggle"
      onClick={() => setLang(next)}
      title={lang === "zh" ? "Switch to English" : "切换到中文"}
      aria-label={lang === "zh" ? "Switch to English" : "切换到中文"}
    >
      <Languages size={15} />
      <span>{lang === "zh" ? "EN" : "中"}</span>
    </button>
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
              <IconButton label={t("选择数据")} tone="quiet" onClick={() => setPickerOpen(true)}>
                <Paperclip size={17} />
              </IconButton>
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
