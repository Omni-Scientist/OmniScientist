import {
  AlertTriangle,
  ArrowLeft,
  BarChart3,
  BookOpenText,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Code2,
  Copy,
  Download,
  ExternalLink,
  FileText,
  FlaskConical,
  Image as ImageIcon,
  Link2,
  Maximize2,
  PanelRightClose,
  Rows3,
  Table2,
  Terminal,
  X,
  XCircle,
} from "lucide-react";
import { Highlight, themes } from "prism-react-renderer";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Artifact, ArtifactKind, ResearchTrace, TraceEntry } from "../types";
import "../notebook.css";
import { t } from "../lib/i18n";

interface WorkbenchProps {
  artifacts: Artifact[];
  activeId: string | null;
  trace: ResearchTrace | null;
  onActivate: (id: string) => void;
  onCloseArtifact: (id: string) => void;
  onCloseTrace: () => void;
  onClosePanel: () => void;
}

type NotebookFilter = "all" | ArtifactKind;
type TraceFilter = "all" | "milestone" | "issue";

const kindOrder: Record<ArtifactKind, number> = {
  code: 1,
  table: 2,
  figure: 3,
  paper: 4,
};

const kindMeta = {
  code: { label: t("代码"), icon: Code2 },
  table: { label: t("数据"), icon: Table2 },
  figure: { label: t("图表"), icon: ImageIcon },
  paper: { label: t("论文"), icon: BookOpenText },
};

function fileName(path: string) {
  return path.split("/").filter(Boolean).at(-1) ?? path;
}

function artifactHref(artifact: Artifact) {
  if (artifact.fileUrl) return artifact.fileUrl;
  if (artifact.imageUrl) return artifact.imageUrl;
  return null;
}

function NotebookAction({
  label,
  children,
  onClick,
}: {
  label: string;
  children: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button className="nb-action" type="button" aria-label={label} title={label} onClick={onClick}>
      {children}
    </button>
  );
}

function CellRail({ step, state = "complete" }: { step: string; state?: "complete" | "linked" }) {
  return (
    <div className={`nb-cell-rail nb-cell-rail--${state}`} aria-hidden="true">
      <span className="nb-step-number">{step}</span>
      <span className="nb-rail-dot">{state === "complete" ? <Check size={12} /> : <Link2 size={11} />}</span>
    </div>
  );
}

function CellHeader({
  artifact,
  title,
  label,
  active,
  onFocus,
  onRemove,
  actions,
}: {
  artifact?: Artifact;
  title: string;
  label: string;
  active?: boolean;
  onFocus?: () => void;
  onRemove?: () => void;
  actions?: React.ReactNode;
}) {
  const KindIcon = artifact ? kindMeta[artifact.kind].icon : FlaskConical;
  return (
    <header className="nb-cell-header">
      <div className="nb-cell-heading">
        <span className="nb-cell-kind"><KindIcon size={14} /> {label}</span>
        {onFocus ? (
          <button
            className={`nb-cell-title ${active ? "is-active" : ""}`}
            type="button"
            onClick={onFocus}
          >
            {title}
          </button>
        ) : <h2 className="nb-cell-title-text">{title}</h2>}
      </div>
      <div className="nb-cell-actions">
        {actions}
        {artifact && onRemove ? (
          <NotebookAction label={t("从工作台移除 {0}", artifact.title)} onClick={onRemove}><X size={17} /></NotebookAction>
        ) : null}
      </div>
    </header>
  );
}

function RunSummary({ artifacts, outputCount }: { artifacts: Artifact[]; outputCount: number }) {
  const figures = artifacts.filter((artifact) => artifact.kind === "figure").length;
  const seismicRun = artifacts.some((artifact) => artifact.id.startsWith("seismic-"));
  return (
    <section className="nb-cell nb-run-cell" aria-labelledby="nb-run-title">
      <CellRail step="01" />
      <div className="nb-cell-main">
        <CellHeader title={t("研究运行完成")} label={t("运行摘要")} />
        <div className="nb-run-summary" id="nb-run-title">
          <strong>{seismicRun ? "STEAD noise-label audit" : "Research run"}</strong>
          {seismicRun ? <span>{t("3 个 stages")}</span> : null}
          <span>{t("{0} 项输出", outputCount)}</span>
          <span>{t("{0} 个图表", figures)}</span>
          {seismicRun ? <span className="nb-supported">Lead: SUPPORTED</span> : null}
          {seismicRun ? <span className="nb-verdict">Overall: MIXED</span> : null}
          {seismicRun ? <span className="nb-verified"><CheckCircle2 size={14} /> Trace gates passed</span> : null}
        </div>
      </div>
    </section>
  );
}

function codeLanguage(language?: string) {
  const normalized = language?.trim().toLowerCase() ?? "";
  const aliases: Record<string, string> = {
    js: "javascript",
    py: "python",
    sh: "bash",
    shell: "bash",
    ts: "typescript",
  };
  return aliases[normalized] ?? (normalized || "plain");
}

function CodeOutput({
  artifact,
  expanded,
  copied,
  onCopy,
}: {
  artifact: Artifact;
  expanded: boolean;
  copied: boolean;
  onCopy: () => void;
}) {
  const lines = (artifact.content ?? "").trimEnd().split("\n");
  const visibleLines = expanded ? lines : lines.slice(0, 14);
  const copyLabel = copied ? t("{0} 已复制", artifact.title) : t("复制代码 {0}", artifact.title);
  return (
    <div className="nb-code-output">
      <div className="nb-code-meta">
        <span>{artifact.language ?? "Text"}</span>
        <div className="nb-code-meta-actions">
          <span>{lines.length} lines</span>
          <button className="nb-code-copy" type="button" aria-label={copyLabel} title={copyLabel} onClick={onCopy}>
            {copied ? <Check size={14} /> : <Copy size={14} />}
            <span>{copied ? t("已复制") : t("复制")}</span>
          </button>
        </div>
      </div>
      <Highlight theme={themes.github} code={visibleLines.join("\n") || " "} language={codeLanguage(artifact.language)}>
        {({ tokens, getLineProps, getTokenProps }) => (
          <pre>
            {tokens.map((line, index) => (
              <span {...getLineProps({ line })} className="nb-code-line" key={`${index}-${visibleLines[index] ?? ""}`}>
                <span className="nb-line-number">{index + 1}</span>
                <code>
                  {line.map((token, tokenIndex) => (
                    <span {...getTokenProps({ token })} key={`${index}-${tokenIndex}`} />
                  ))}
                </code>
              </span>
            ))}
          </pre>
        )}
      </Highlight>
    </div>
  );
}

function DataTableOutput({ artifact }: { artifact: Artifact }) {
  const headers = artifact.tableHeaders ?? ["Field", "Value"];
  const rows = artifact.tableRows ?? [["Output", artifact.detail]];
  return (
    <div className="nb-table-output" tabIndex={0} aria-label={t("{0}，可横向滚动", artifact.title)}>
      <table>
        <thead>
          <tr>{headers.map((header) => <th key={header}>{header}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={`${row[0] ?? "row"}-${rowIndex}`}>
              {row.map((cell, cellIndex) => <td key={`${rowIndex}-${cellIndex}`}>{cell}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function FigureOutput({ artifact }: { artifact: Artifact }) {
  return (
    <figure className="nb-figure-output">
      <div className="nb-figure-stage">
        <img src={artifact.imageUrl} alt={artifact.altText ?? artifact.title} />
      </div>
      <figcaption>
        <strong>{artifact.caption ?? artifact.title}</strong>
        <span>{t(artifact.detail)} · {t(artifact.updatedAt)}</span>
      </figcaption>
    </figure>
  );
}

function PaperExcerpt({ artifact }: { artifact: Artifact }) {
  const paragraphs = artifact.content?.split(/\n\s*\n/).filter(Boolean) ?? [];
  const highlight = (text: string) => text
    .split(/(163 of these 750 traces|21\.7%|1\.07%|21\.73% to 2\.00%)/g)
    .map((part, index) => /^(163 of these 750 traces|21\.7%|1\.07%|21\.73% to 2\.00%)$/.test(part)
      ? <mark key={`${part}-${index}`}>{part}</mark>
      : part);
  return (
    <article className="nb-paper-excerpt">
      <div className="nb-paper-location">
        <FileText size={15} />
        <span>{artifact.title}</span>
        <ChevronRight size={14} />
        <strong>{artifact.location ?? "Paper excerpt"}</strong>
      </div>
      <h3>{artifact.sectionTitle ?? "Excerpt"}</h3>
      {paragraphs.map((paragraph, index) => <p key={`${artifact.id}-${index}`}>{highlight(paragraph)}</p>)}
      <div className="nb-paper-note"><CheckCircle2 size={15} /> {t("已与 Stage 2 实验结果核对")}</div>
    </article>
  );
}

function PaperOutput({ artifact }: { artifact: Artifact }) {
  if (!artifact.previewUrls?.length) return <PaperExcerpt artifact={artifact} />;
  return (
    <article className="nb-paper-document">
      <div className="nb-paper-document-meta">
        <span>Final PDF</span>
        <strong>{artifact.previewUrls.length} pages</strong>
      </div>
      <div className="nb-paper-pages">
        {artifact.previewUrls.map((url, index) => (
          <figure key={url}>
            <img src={url} alt={t("{0} 第 {1} 页", artifact.title, index + 1)} loading={index > 1 ? "lazy" : "eager"} />
            <figcaption>{index + 1}</figcaption>
          </figure>
        ))}
      </div>
    </article>
  );
}

function TraceStatus({ entry }: { entry: TraceEntry }) {
  if (entry.status === "failed") {
    return <span className="trace-status trace-status--failed" title={t("失败")}><XCircle size={15} /></span>;
  }
  if (entry.status === "revised") {
    return <span className="trace-status trace-status--revised" title={t("已修正")}><AlertTriangle size={15} /></span>;
  }
  return <span className="trace-status trace-status--complete" title={t("完成")}><Check size={14} /></span>;
}

function TraceEntryRow({
  entry,
  artifacts,
  expanded,
  onToggle,
  onOpenArtifact,
}: {
  entry: TraceEntry;
  artifacts: Artifact[];
  expanded: boolean;
  onToggle: () => void;
  onOpenArtifact: (id: string) => void;
}) {
  const linkedArtifacts = (entry.artifactIds ?? [])
    .map((id) => artifacts.find((artifact) => artifact.id === id))
    .filter((artifact): artifact is Artifact => Boolean(artifact));

  return (
    <article className={`trace-entry trace-entry--${entry.status}`}>
      <button
        className="trace-entry-summary"
        type="button"
        aria-expanded={expanded}
        onClick={onToggle}
      >
        <span className="trace-sequence">#{String(entry.sequence).padStart(2, "0")}</span>
        <TraceStatus entry={entry} />
        <span className="trace-entry-copy">
          <span><code>{entry.tool}</code>{entry.importance === "milestone" ? <small>{t("关键节点")}</small> : null}</span>
          <strong>{t(entry.label)}</strong>
          <small>{t(entry.detail)}</small>
        </span>
        <ChevronDown size={16} className={expanded ? "is-rotated" : ""} />
      </button>
      {expanded ? (
        <div className="trace-entry-detail">
          {entry.output ? (
            <div className="trace-output">
              <span>{t("关键输出")}</span>
              <code>{entry.output}</code>
            </div>
          ) : null}
          {linkedArtifacts.length ? (
            <div className="trace-artifacts" aria-label={t("此步骤生成的产物")}>
              <span>{t("生成产物")}</span>
              <div>
                {linkedArtifacts.map((artifact) => {
                  const ArtifactIcon = kindMeta[artifact.kind].icon;
                  return (
                    <button type="button" key={artifact.id} onClick={() => onOpenArtifact(artifact.id)}>
                      <ArtifactIcon size={14} />
                      <span>{artifact.title}</span>
                      <ChevronRight size={14} />
                    </button>
                  );
                })}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

function TraceWorkspace({
  trace,
  artifacts,
  onOpenArtifact,
}: {
  trace: ResearchTrace;
  artifacts: Artifact[];
  onOpenArtifact: (id: string) => void;
}) {
  const [filter, setFilter] = useState<TraceFilter>("all");
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    setFilter("all");
    setExpandedIds(new Set());
  }, [trace.id]);

  const counts = useMemo(() => ({
    all: trace.entries.length,
    milestone: trace.entries.filter((entry) => entry.importance === "milestone").length,
    issue: trace.entries.filter((entry) => entry.status !== "complete").length,
  }), [trace.entries]);

  const visibleEntries = trace.entries.filter((entry) => {
    if (filter === "milestone") return entry.importance === "milestone";
    if (filter === "issue") return entry.status !== "complete";
    return true;
  });
  const pythonCount = trace.entries.filter((entry) => entry.tool === "run_python").length;
  const failedCount = trace.entries.filter((entry) => entry.status === "failed").length;
  const revisedCount = trace.entries.filter((entry) => entry.status === "revised").length;

  const toggleEntry = (id: string) => {
    setExpandedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  let previousPhase = "";
  return (
    <>
      <nav className="nb-filterbar trace-filterbar" aria-label={t("筛选运行轨迹")}>
        <div className="nb-filter-control" role="tablist">
          {([
            { id: "all", label: t("全部") },
            { id: "milestone", label: t("关键节点") },
            { id: "issue", label: t("修正") },
          ] as const).map((item) => (
            <button
              className={`nb-filter ${filter === item.id ? "is-active" : ""}`}
              type="button"
              role="tab"
              aria-selected={filter === item.id}
              key={item.id}
              onClick={() => setFilter(item.id)}
            >
              <span>{item.label}</span>
              <small>{counts[item.id]}</small>
            </button>
          ))}
        </div>
      </nav>

      <div className="nb-scroll-region trace-scroll-region">
        <div className="trace-feed">
          <section className="trace-overview">
            <span className="trace-overview-stage"><Terminal size={14} /> {trace.stage}</span>
            <h2>{trace.title}</h2>
            <p>{trace.summary}</p>
            <div className="trace-stats">
              <span><strong>{trace.entries.length}</strong> calls</span>
              <span><strong>{pythonCount}</strong> Python</span>
              <span className="trace-stat-issue"><strong>{failedCount}</strong> recovered error</span>
              <span><strong>{revisedCount}</strong> revisions</span>
            </div>
            <div className="trace-privacy"><CheckCircle2 size={14} /> {t("已脱敏：不含内部提示词、绝对路径与原始数据")}</div>
          </section>

          <div className="trace-list">
            {visibleEntries.map((entry) => {
              const showPhase = entry.phase !== previousPhase;
              previousPhase = entry.phase;
              return (
                <Fragment key={entry.id}>
                  {showPhase ? <h3 className="trace-phase-heading">{entry.phase}</h3> : null}
                  <TraceEntryRow
                    entry={entry}
                    artifacts={artifacts}
                    expanded={expandedIds.has(entry.id)}
                    onToggle={() => toggleEntry(entry.id)}
                    onOpenArtifact={onOpenArtifact}
                  />
                </Fragment>
              );
            })}
          </div>
        </div>
      </div>
    </>
  );
}

export function Workbench({
  artifacts,
  activeId,
  trace,
  onActivate,
  onCloseArtifact,
  onCloseTrace,
  onClosePanel,
}: WorkbenchProps) {
  const [filter, setFilter] = useState<NotebookFilter>("all");
  const [expandedCode, setExpandedCode] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const panelRef = useRef<HTMLElement | null>(null);
  const cellRefs = useRef(new Map<string, HTMLElement>());
  const previousActiveId = useRef(activeId);
  const notebookScrollRef = useRef<HTMLDivElement | null>(null);
  const notebookScrollTop = useRef(0);
  const pendingTraceArtifactId = useRef<string | null>(null);

  const bindNotebookScroll = useCallback((node: HTMLDivElement | null) => {
    if (notebookScrollRef.current && !node) {
      notebookScrollTop.current = notebookScrollRef.current.scrollTop;
    }
    notebookScrollRef.current = node;
    if (node) {
      window.requestAnimationFrame(() => node.scrollTo({ top: notebookScrollTop.current }));
    }
  }, []);

  const sortedArtifacts = useMemo(
    () => [...artifacts].sort((left, right) => {
      const leftOrder = left.order ?? 100 + kindOrder[left.kind];
      const rightOrder = right.order ?? 100 + kindOrder[right.kind];
      return leftOrder - rightOrder;
    }),
    [artifacts],
  );
  const notebookArtifacts = sortedArtifacts;
  const outputCount = notebookArtifacts.length;

  const filterCounts = useMemo(() => ({
    all: outputCount,
    code: notebookArtifacts.filter((artifact) => artifact.kind === "code").length,
    table: notebookArtifacts.filter((artifact) => artifact.kind === "table").length,
    figure: notebookArtifacts.filter((artifact) => artifact.kind === "figure").length,
    paper: notebookArtifacts.filter((artifact) => artifact.kind === "paper").length,
  }), [notebookArtifacts, outputCount]);

  const filters: Array<{ id: NotebookFilter; label: string; icon: typeof Rows3 }> = [
    { id: "all", label: t("全部"), icon: Rows3 },
    { id: "code", label: t("代码"), icon: Code2 },
    { id: "table", label: t("数据"), icon: Table2 },
    { id: "figure", label: t("图表"), icon: BarChart3 },
    { id: "paper", label: t("论文"), icon: BookOpenText },
  ];

  const scrollToArtifact = (id: string, behavior: ScrollBehavior = "smooth") => {
    setFilter("all");
    window.setTimeout(() => {
      cellRefs.current.get(id)?.scrollIntoView({ behavior, block: "center" });
      setHighlightedId(id);
      window.setTimeout(() => setHighlightedId((current) => current === id ? null : current), 1500);
    }, 30);
  };

  const openTraceArtifact = (id: string) => {
    pendingTraceArtifactId.current = id;
    onActivate(id);
    onCloseTrace();
  };

  useEffect(() => {
    if (trace || !pendingTraceArtifactId.current) return;
    const id = pendingTraceArtifactId.current;
    pendingTraceArtifactId.current = null;
    scrollToArtifact(id);
  // Returning from Trace should focus the linked notebook artifact after it mounts.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trace]);

  useEffect(() => {
    if (previousActiveId.current === activeId) return;
    previousActiveId.current = activeId;
    if (!activeId || !artifacts.some((artifact) => artifact.id === activeId)) return;
    scrollToArtifact(activeId, "auto");
  // Opening an artifact should focus the corresponding notebook output.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

  const focusArtifact = (id: string) => {
    onActivate(id);
    scrollToArtifact(id);
  };

  const copyCode = async (artifact: Artifact) => {
    await navigator.clipboard.writeText(artifact.content ?? "");
    setCopiedId(artifact.id);
    window.setTimeout(() => setCopiedId((current) => current === artifact.id ? null : current), 1400);
  };

  const toggleFullscreen = async () => {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
      return;
    }
    await panelRef.current?.requestFullscreen();
  };

  const visibleArtifacts = notebookArtifacts.filter((artifact) => filter === "all" || artifact.kind === filter);
  const noFilteredResults = filter !== "all" && filterCounts[filter] === 0;

  return (
    <aside ref={panelRef} className="workbench notebook-workbench" aria-label={t("研究工作台")}>
      <header className="nb-topbar">
        <div className="nb-topbar-title">
          {trace ? (
            <NotebookAction label={t("返回研究记录")} onClick={onCloseTrace}><ArrowLeft size={18} /></NotebookAction>
          ) : (
            <span className="nb-topbar-icon"><FlaskConical size={18} /></span>
          )}
          <div>
            <strong>{trace ? t("运行轨迹") : t("研究记录")}</strong>
            <span>{trace ? t("{0} · {1} 次调用", trace.stage, trace.entries.length) : t("当前会话 · {0} 项输出", outputCount)}</span>
          </div>
        </div>
        <div className="nb-topbar-actions">
          <NotebookAction label={trace ? t("全屏查看运行轨迹") : t("全屏查看研究记录")} onClick={() => void toggleFullscreen()}><Maximize2 size={18} /></NotebookAction>
          <NotebookAction label={t("收起工作台")} onClick={onClosePanel}><PanelRightClose size={19} /></NotebookAction>
        </div>
      </header>

      {trace ? (
        <TraceWorkspace trace={trace} artifacts={artifacts} onOpenArtifact={openTraceArtifact} />
      ) : <>
        <nav className="nb-filterbar" aria-label={t("筛选研究产物")}>
        <div className="nb-filter-control" role="tablist">
          {filters.map((item) => {
            const FilterIcon = item.icon;
            const count = filterCounts[item.id];
            return (
              <button
                className={`nb-filter ${filter === item.id ? "is-active" : ""}`}
                type="button"
                role="tab"
                aria-selected={filter === item.id}
                key={item.id}
                onClick={() => setFilter(item.id)}
              >
                <FilterIcon size={15} />
                <span>{item.label}</span>
                <small>{count}</small>
              </button>
            );
          })}
        </div>
        </nav>

        <div className="nb-scroll-region" ref={bindNotebookScroll}>
        {artifacts.length === 0 ? (
          <div className="nb-empty"><FileText size={25} /><strong>{t("暂无产物")}</strong></div>
        ) : noFilteredResults ? (
          <div className="nb-empty"><Rows3 size={24} /><strong>{t("此类型暂无产物")}</strong></div>
        ) : (
          <div className="nb-feed">
            {filter === "all" ? <RunSummary artifacts={artifacts} outputCount={outputCount} /> : null}

            {visibleArtifacts.map((artifact) => {
              const cellStep = String(notebookArtifacts.findIndex((item) => item.id === artifact.id) + 2).padStart(2, "0");
              const href = artifactHref(artifact);
              const cellClass = [
                "nb-cell",
                `nb-cell--${artifact.kind}`,
                activeId === artifact.id ? "is-active" : "",
                highlightedId === artifact.id ? "is-highlighted" : "",
              ].filter(Boolean).join(" ");

              if (artifact.kind === "table") {
                return (
                  <section
                    className={cellClass}
                    key={artifact.id}
                    ref={(node) => {
                      if (node) cellRefs.current.set(artifact.id, node); else cellRefs.current.delete(artifact.id);
                    }}
                  >
                    <CellRail step={cellStep} />
                    <div className="nb-cell-main">
                      <CellHeader
                        artifact={artifact}
                        title={artifact.title}
                        label={t("数据输出")}
                        active={activeId === artifact.id}
                        onFocus={() => focusArtifact(artifact.id)}
                        onRemove={() => onCloseArtifact(artifact.id)}
                      />
                      <DataTableOutput artifact={artifact} />
                      <div className="nb-output-meta"><span>{artifact.path}</span><span>{t(artifact.detail)}</span></div>
                    </div>
                  </section>
                );
              }

              if (artifact.kind === "code") {
                const codeLines = (artifact.content ?? "").trimEnd().split("\n");
                return (
                  <section
                    className={cellClass}
                    key={artifact.id}
                    ref={(node) => { if (node) cellRefs.current.set(artifact.id, node); else cellRefs.current.delete(artifact.id); }}
                  >
                    <CellRail step={cellStep} />
                    <div className="nb-cell-main">
                      <CellHeader
                        artifact={artifact}
                        title={artifact.title}
                        label={t("代码")}
                        active={activeId === artifact.id}
                        onFocus={() => focusArtifact(artifact.id)}
                        onRemove={() => onCloseArtifact(artifact.id)}
                      />
                      <CodeOutput
                        artifact={artifact}
                        expanded={expandedCode}
                        copied={copiedId === artifact.id}
                        onCopy={() => void copyCode(artifact)}
                      />
                      {codeLines.length > 14 ? (
                        <button className="nb-expand-code" type="button" onClick={() => setExpandedCode((value) => !value)}>
                          <ChevronDown size={15} className={expandedCode ? "is-rotated" : ""} />
                          {expandedCode ? t("收起代码") : t("展开其余 {0} 行", codeLines.length - 14)}
                        </button>
                      ) : null}
                    </div>
                  </section>
                );
              }

              if (artifact.kind === "figure") {
                return (
                  <section
                    className={cellClass}
                    key={artifact.id}
                    ref={(node) => { if (node) cellRefs.current.set(artifact.id, node); else cellRefs.current.delete(artifact.id); }}
                  >
                    <CellRail step={cellStep} />
                    <div className="nb-cell-main">
                      <CellHeader
                        artifact={artifact}
                        title={artifact.title}
                        label={t("Matplotlib 输出")}
                        active={activeId === artifact.id}
                        onFocus={() => focusArtifact(artifact.id)}
                        onRemove={() => onCloseArtifact(artifact.id)}
                        actions={href ? <>
                          <a className="nb-action" href={href} download aria-label={t("下载 {0}", artifact.title)} title={t("下载 {0}", artifact.title)}><Download size={17} /></a>
                          <a className="nb-action" href={href} target="_blank" rel="noreferrer" aria-label={t("在新窗口打开 {0}", artifact.title)} title={t("在新窗口打开 {0}", artifact.title)}><ExternalLink size={17} /></a>
                        </> : null}
                      />
                      <FigureOutput artifact={artifact} />
                    </div>
                  </section>
                );
              }

              return (
                <section
                  className={cellClass}
                  key={artifact.id}
                  ref={(node) => { if (node) cellRefs.current.set(artifact.id, node); else cellRefs.current.delete(artifact.id); }}
                >
                  <CellRail step={cellStep} />
                  <div className="nb-cell-main">
                    <CellHeader
                      artifact={artifact}
                      title={artifact.title}
                      label={t("最终论文")}
                      active={activeId === artifact.id}
                      onFocus={() => focusArtifact(artifact.id)}
                      onRemove={() => onCloseArtifact(artifact.id)}
                      actions={<>
                        {artifact.bundleUrl ? <a className="nb-action" href={artifact.bundleUrl} download aria-label={t("下载 Overleaf 包")} title={t("下载 Overleaf 包")}><Download size={17} /></a> : null}
                        {href ? <a className="nb-action" href={href} download aria-label={t("下载 {0}", artifact.title)} title={t("下载 {0}", artifact.title)}><Download size={17} /></a> : null}
                        {href ? <a className="nb-action" href={href} target="_blank" rel="noreferrer" aria-label={t("打开 {0}", artifact.title)} title={t("打开 {0}", artifact.title)}><ExternalLink size={17} /></a> : null}
                      </>}
                    />
                    <PaperOutput artifact={artifact} />
                    <div className="nb-output-meta"><span>{artifact.path}</span><span>{t(artifact.detail)}</span></div>
                  </div>
                </section>
              );
            })}

            {filter === "all" ? (
              <section className="nb-cell nb-lineage-cell" aria-labelledby="nb-lineage-title">
                <CellRail step={String(notebookArtifacts.length + 2).padStart(2, "0")} state="linked" />
                <div className="nb-cell-main">
                  <CellHeader title={t("产物关系")} label="Lineage" />
                  <div className="nb-lineage" id="nb-lineage-title">
                    {sortedArtifacts.map((artifact, index) => (
                      <div className="nb-lineage-part" key={artifact.id}>
                        <button type="button" onClick={() => focusArtifact(artifact.id)}>
                          {(() => { const Icon = kindMeta[artifact.kind].icon; return <Icon size={15} />; })()}
                          <span>{fileName(artifact.path)}</span>
                        </button>
                        {index < sortedArtifacts.length - 1 ? <ChevronRight size={15} /> : null}
                      </div>
                    ))}
                  </div>
                </div>
              </section>
            ) : null}
          </div>
        )}
        </div>
      </>}
    </aside>
  );
}
