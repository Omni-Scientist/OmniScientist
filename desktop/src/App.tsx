import { GripVertical, LoaderCircle } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { ChatPane } from "./components/ChatPane";
import { ConversationSidebar } from "./components/ConversationSidebar";
import { SettingsDialog } from "./components/SettingsDialog";
import { Workbench } from "./components/Workbench";
import { transport } from "./lib/transport";
import type { Artifact, ChatMessage, ChatSession, MessageBlock, ResearchTrace, SessionSummary, ToolStep } from "./types";
import { t, useLang } from "./lib/i18n";

const MIN_WORKBENCH_WIDTH = 420;
const MAX_WORKBENCH_VIEWPORT_SHARE = 0.5;
/** createSession 的参数：桌面版由 launcher 决定真实工作区，这里只是个中性占位。 */
const WORKSPACE_LABEL = "OmniScientist";

const SELECTED_SESSION_KEY = "omnisci.web.selected-session.v1";
const DRAFT_KEY_PREFIX = "omnisci.web.draft.v1.";

function readLocalStorage(key: string): string {
  try {
    return window.localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

function writeLocalStorage(key: string, value: string): void {
  try {
    if (value) window.localStorage.setItem(key, value);
    else window.localStorage.removeItem(key);
  } catch {
    // The workspace remains usable when storage is disabled by the browser.
  }
}

function draftKey(sessionId: string): string {
  return `${DRAFT_KEY_PREFIX}${encodeURIComponent(sessionId)}`;
}

function messageTime() {
  return new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}

function uniqueArtifacts(messages: ChatMessage[]): Artifact[] {
  const seen = new Set<string>();
  return messages.flatMap((message) => message.artifacts ?? []).filter((artifact) => {
    if (seen.has(artifact.id)) return false;
    seen.add(artifact.id);
    return true;
  });
}

function primaryArtifact(artifacts: Artifact[]): Artifact | undefined {
  return artifacts.find((artifact) => artifact.kind === "paper") ?? artifacts[0];
}

function updateAssistant(
  session: ChatSession,
  id: string,
  update: (message: ChatMessage) => ChatMessage,
): ChatSession {
  return {
    ...session,
    messages: session.messages.map((message) => message.id === id ? update(message) : message),
  };
}

function appendMarkdownBlock(message: ChatMessage, delta: string): MessageBlock[] {
  const blocks = [...(message.blocks ?? [])];
  const last = blocks.at(-1);
  if (last?.type === "markdown") {
    blocks[blocks.length - 1] = { ...last, content: last.content + delta };
  } else {
    blocks.push({
      id: `${message.id}-markdown-${blocks.length + 1}`,
      type: "markdown",
      content: delta,
    });
  }
  return blocks;
}

function markdownContent(blocks: MessageBlock[]): string {
  return blocks
    .filter((block): block is Extract<MessageBlock, { type: "markdown" }> => block.type === "markdown")
    .map((block) => block.content)
    .join("\n\n");
}

function sessionSummary(value: ChatSession): SessionSummary {
  const { messages: _messages, ...summary } = value;
  return summary;
}

export default function App() {
  // 订阅语言。整棵树没有 memo，所以这里一变，下面所有 t() 都会重算。
  useLang();
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [session, setSession] = useState<ChatSession | null>(null);
  // 干净安装第一次打开时没有任何会话，这两个状态决定是转圈、进工作台，还是给一屏引导。
  const [booting, setBooting] = useState(true);
  const [bootError, setBootError] = useState<string | null>(null);
  const [bootSettingsOpen, setBootSettingsOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  const [leftOpen, setLeftOpen] = useState(() => window.innerWidth >= 1360);
  const [workbenchOpen, setWorkbenchOpen] = useState(() => window.innerWidth >= 1024);
  const [workbenchWidth, setWorkbenchWidth] = useState(() => Math.min(560, Math.max(440, window.innerWidth * 0.36)));
  const [openArtifacts, setOpenArtifacts] = useState<Artifact[]>([]);
  const [activeArtifactId, setActiveArtifactId] = useState<string | null>(null);
  const [activeTrace, setActiveTrace] = useState<ResearchTrace | null>(null);
  const [busy, setBusy] = useState(false);
  const [resizingWorkbench, setResizingWorkbench] = useState(false);
  const overlayReturnFocus = useRef<HTMLElement | null>(null);
  const overlayWasOpen = useRef(false);
  const selectedIdRef = useRef("");
  const activeSendRef = useRef(false);
  const sidebarOverlay = viewportWidth < 1360;
  const workbenchOverlay = viewportWidth < 1024;
  const overlayOpen = (sidebarOverlay && leftOpen) || (workbenchOverlay && workbenchOpen);
  const maxWorkbenchWidth = Math.max(MIN_WORKBENCH_WIDTH, viewportWidth * MAX_WORKBENCH_VIEWPORT_SHARE);
  const clampWorkbenchWidth = (value: number) => Math.max(MIN_WORKBENCH_WIDTH, Math.min(maxWorkbenchWidth, value));

  const activateSession = useCallback((loaded: ChatSession, restoreDraft = true) => {
    selectedIdRef.current = loaded.id;
    setSelectedId(loaded.id);
    writeLocalStorage(SELECTED_SESSION_KEY, loaded.id);
    setSession(loaded);
    if (restoreDraft) setDraft(readLocalStorage(draftKey(loaded.id)));
    const artifacts = uniqueArtifacts(loaded.messages);
    setOpenArtifacts(artifacts);
    setActiveArtifactId(primaryArtifact(artifacts)?.id ?? null);
    setActiveTrace(null);
    setBusy(loaded.id.startsWith("local-") && loaded.status === "running");
    if (artifacts.length && window.innerWidth >= 1024) setWorkbenchOpen(true);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const listed = await transport.listSessions();
      if (cancelled) return;
      setSessions(listed);
      const remembered = readLocalStorage(SELECTED_SESSION_KEY);
      const remembered2 = remembered && listed.some((item) => item.id === remembered) ? remembered : undefined;
      const preferredId = remembered2
        ?? listed.find((item) => item.id.startsWith("local-"))?.id
        ?? listed[0]?.id;

      if (!preferredId) {
        // 一条会话都没有：直接开一个空的，落地就能打字。开不出来通常是还没配 key，
        // 那就把原因摆出来，而不是永远转圈。
        try {
          const created = await transport.createSession(WORKSPACE_LABEL);
          if (cancelled) return;
          setSessions([created]);
          activateSession(created);
        } catch (error) {
          if (!cancelled) setBootError(error instanceof Error ? error.message : String(error));
        } finally {
          if (!cancelled) setBooting(false);
        }
        return;
      }

      try {
        const loaded = await transport.getSession(preferredId);
        if (!cancelled) activateSession(loaded);
      } catch {
        const fallbackId = listed.find((item) => item.id !== preferredId)?.id;
        if (fallbackId) {
          try {
            const fallback = await transport.getSession(fallbackId);
            if (!cancelled) activateSession(fallback);
          } catch (error) {
            if (!cancelled) setBootError(error instanceof Error ? error.message : String(error));
          }
        }
      } finally {
        if (!cancelled) setBooting(false);
      }
    })();
    return () => { cancelled = true; };
  }, [activateSession]);

  const updateDraft = useCallback((value: string) => {
    setDraft(value);
    const id = selectedIdRef.current;
    if (id) writeLocalStorage(draftKey(id), value);
  }, []);

  useEffect(() => {
    if (!session?.id.startsWith("local-") || session.status !== "running" || activeSendRef.current) return;
    let cancelled = false;
    let timer: number | undefined;
    const poll = async () => {
      try {
        const loaded = await transport.getSession(session.id);
        if (cancelled || selectedIdRef.current !== loaded.id) return;
        setSession(loaded);
        setSessions((current) => current.map((item) => item.id === loaded.id
          ? sessionSummary(loaded)
          : item));
        if (loaded.status === "running") {
          timer = window.setTimeout(poll, 800);
        } else {
          setBusy(false);
        }
      } catch {
        if (!cancelled) setBusy(false);
      }
    };
    timer = window.setTimeout(poll, 500);
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [session?.id, session?.status]);

  useEffect(() => {
    const onResize = () => {
      const width = window.innerWidth;
      setViewportWidth(width);
      if (width < 1024) {
        setLeftOpen(false);
        setWorkbenchOpen(false);
      } else if (width < 1360) {
        setLeftOpen(false);
      }
      if (width < 1024) setWorkbenchWidth(Math.min(720, width * 0.94));
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    if (workbenchOverlay) return;
    setWorkbenchWidth((current) => Math.max(420, Math.min(maxWorkbenchWidth, current)));
  }, [maxWorkbenchWidth, workbenchOverlay]);

  useEffect(() => {
    const chat = document.querySelector<HTMLElement>(".chat-pane");
    const sidebar = document.querySelector<HTMLElement>(".conversation-sidebar");
    const workbench = document.querySelector<HTMLElement>(".workbench");
    const resizer = document.querySelector<HTMLElement>(".workbench-resizer");
    const sidebarModal = sidebarOverlay && leftOpen;
    const workbenchModal = workbenchOverlay && workbenchOpen;

    if (chat) chat.inert = sidebarModal || workbenchModal;
    if (sidebar) sidebar.inert = workbenchModal;
    if (workbench) workbench.inert = sidebarModal;
    if (resizer) resizer.inert = sidebarModal || workbenchModal;

    return () => {
      if (chat) chat.inert = false;
      if (sidebar) sidebar.inert = false;
      if (workbench) workbench.inert = false;
      if (resizer) resizer.inert = false;
    };
  }, [leftOpen, sidebarOverlay, workbenchOpen, workbenchOverlay]);

  useEffect(() => {
    if (!overlayOpen) return;
    const panel = workbenchOverlay && workbenchOpen
      ? document.querySelector<HTMLElement>(".workbench")
      : document.querySelector<HTMLElement>(".conversation-sidebar");
    if (!panel) return;
    const focusableSelector = "button:not([disabled]), a[href], input:not([disabled]), textarea:not([disabled]), [tabindex='0']";
    const focusFirst = () => panel.querySelector<HTMLElement>(focusableSelector)?.focus();
    const trapFocus = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const focusable = [...panel.querySelectorAll<HTMLElement>(focusableSelector)]
        .filter((element) => !element.inert && element.getClientRects().length > 0);
      if (!focusable.length) {
        event.preventDefault();
        return;
      }
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (event.shiftKey && (document.activeElement === first || !panel.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    panel.addEventListener("keydown", trapFocus);
    window.setTimeout(focusFirst, 0);
    return () => panel.removeEventListener("keydown", trapFocus);
  }, [leftOpen, overlayOpen, workbenchOpen, workbenchOverlay]);

  useEffect(() => {
    if (overlayOpen) {
      overlayWasOpen.current = true;
      return;
    }
    if (!overlayWasOpen.current) return;
    overlayWasOpen.current = false;
    window.setTimeout(() => overlayReturnFocus.current?.focus(), 0);
  }, [overlayOpen]);

  const selectSession = async (id: string) => {
    if (busy || id === selectedId) {
      if (sidebarOverlay) setLeftOpen(false);
      return;
    }
    const loaded = await transport.getSession(id);
    activateSession(loaded);
    if (sidebarOverlay) setLeftOpen(false);
  };

  const createNewSession = useCallback(async () => {
    if (busy) return;
    const created = await transport.createSession(WORKSPACE_LABEL);
    setSessions((current) => [created, ...current]);
    activateSession(created);
    setWorkbenchOpen(false);
    if (sidebarOverlay) setLeftOpen(false);
  }, [activateSession, busy, sidebarOverlay]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "n") {
        event.preventDefault();
        void createNewSession();
      }
      if (event.key === "Escape" && overlayOpen) {
        setLeftOpen(false);
        setWorkbenchOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [createNewSession, overlayOpen]);

  const openArtifact = (artifact: Artifact) => {
    if (workbenchOverlay && !workbenchOpen) {
      overlayReturnFocus.current = document.activeElement as HTMLElement | null;
    }
    setOpenArtifacts((current) => current.some((item) => item.id === artifact.id) ? current : [...current, artifact]);
    setActiveTrace(null);
    setActiveArtifactId(artifact.id);
    setWorkbenchOpen(true);
    if (workbenchOverlay) setLeftOpen(false);
  };

  const openTrace = (trace: ResearchTrace) => {
    if (workbenchOverlay && !workbenchOpen) {
      overlayReturnFocus.current = document.activeElement as HTMLElement | null;
    }
    setActiveTrace(trace);
    setWorkbenchOpen(true);
    if (workbenchOverlay) setLeftOpen(false);
  };

  const closeArtifact = (id: string) => {
    setOpenArtifacts((current) => {
      const index = current.findIndex((artifact) => artifact.id === id);
      const next = current.filter((artifact) => artifact.id !== id);
      if (activeArtifactId === id) {
        setActiveArtifactId(next[Math.min(index, next.length - 1)]?.id ?? null);
      }
      return next;
    });
  };

  const sendMessage = async (content: string, dataPath?: string) => {
    if (!session || busy) return;
    const draftOwnerId = session.id;
    let targetSession = session;
    if (!targetSession.id.startsWith("local-")) {
      try {
        targetSession = await transport.createSession(WORKSPACE_LABEL);
        setSessions((current) => [targetSession, ...current]);
        activateSession(targetSession, false);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        const failureId = `assistant-error-${Date.now()}`;
        const failure: ChatMessage = {
          id: failureId,
          role: "assistant",
          author: "OmniScientist",
          time: messageTime(),
          content: t("无法创建本地会话：{0}", detail),
          blocks: [{
            id: `${failureId}-error`,
            type: "markdown",
            content: t("无法创建本地会话：{0}", detail),
          }],
          progress: "complete",
        };
        setSession((current) => current ? { ...current, messages: [...current.messages, failure] } : current);
        return;
      }
    }
    const targetSessionId = targetSession.id;
    const isFirstUserMessage = !targetSession.messages.some((message) => message.role === "user");
    const nextTitle = content.replace(/\s+/g, " ").trim().slice(0, 42) || targetSession.title;
    const userMessage: ChatMessage = {
      id: `user-${Date.now()}`,
      role: "user",
      author: t("你"),
      time: messageTime(),
      content,
    };
    setSession((current) => current ? {
      ...current,
      title: isFirstUserMessage ? nextTitle : current.title,
      status: "running",
      messages: [...current.messages, userMessage],
    } : current);
    setSessions((current) => current.map((item) => item.id === targetSessionId
      ? {
          ...item,
          title: isFirstUserMessage ? nextTitle : item.title,
          status: "running",
          preview: content,
          updatedAt: t("刚刚"),
        }
      : item));
    activeSendRef.current = true;
    setBusy(true);

    let assistantId = "";
    let accepted = false;
    let runFailed = false;
    try {
      for await (const event of transport.sendMessage(targetSessionId, content, dataPath)) {
        if (event.type === "assistant.started") {
          if (!accepted) {
            accepted = true;
            writeLocalStorage(draftKey(draftOwnerId), "");
            writeLocalStorage(draftKey(targetSessionId), "");
            if (selectedIdRef.current === targetSessionId) setDraft("");
          }
          assistantId = event.messageId;
          const placeholder: ChatMessage = {
            id: assistantId,
            role: "assistant",
            author: "OmniScientist",
            time: messageTime(),
            content: "",
            blocks: [],
            progress: "thinking",
          };
          setSession((current) => current ? { ...current, messages: [...current.messages, placeholder] } : current);
        }
        if (event.type === "assistant.phase") {
          setSession((current) => current ? updateAssistant(current, event.messageId, (message) => ({
            ...message,
            progress: event.phase,
          })) : current);
        }
        if (event.type === "tool.started") {
          setSession((current) => current ? updateAssistant(current, event.messageId, (message) => ({
            ...message,
            progress: "tool",
            blocks: [
              ...(message.blocks ?? []),
              { id: `${event.step.id}-block`, type: "tool", step: event.step },
            ],
            toolRun: {
              title: t("正在研究"),
              summary: t("工具运行中"),
              steps: [...(message.toolRun?.steps ?? []), event.step],
            },
          })) : current);
        }
        if (event.type === "tool.finished") {
          setSession((current) => current ? updateAssistant(current, event.messageId, (message) => ({
            ...message,
            blocks: (message.blocks ?? []).map((block) =>
              block.type === "tool" && block.step.id === event.step.id
                ? { ...block, step: event.step }
                : block,
            ),
            toolRun: {
              title: t("正在研究"),
              summary: t("正在整理结果"),
              steps: (message.toolRun?.steps ?? []).map((step: ToolStep) => step.id === event.step.id ? event.step : step),
            },
          })) : current);
        }
        if (event.type === "assistant.delta") {
          setSession((current) => current ? updateAssistant(current, event.messageId, (message) => {
            const blocks = appendMarkdownBlock(message, event.delta);
            return {
              ...message,
              content: markdownContent(blocks),
              blocks,
              progress: "writing",
            };
          }) : current);
        }
        if (event.type === "artifact.created") {
          openArtifact(event.artifact);
          setSession((current) => current ? updateAssistant(current, event.messageId, (message) => ({
            ...message,
            artifacts: [...(message.artifacts ?? []), event.artifact],
          })) : current);
        }
        if (event.type === "artifacts.updated") {
          setSession((current) => current ? updateAssistant(current, event.messageId, (message) => ({
            ...message,
            artifacts: event.artifacts,
          })) : current);
          setOpenArtifacts(event.artifacts);
          setActiveTrace(null);
          setActiveArtifactId(primaryArtifact(event.artifacts)?.id ?? null);
          if (event.artifacts.length && window.innerWidth >= 1024) setWorkbenchOpen(true);
        }
        if (event.type === "run.failed") {
          runFailed = true;
          const failureId = assistantId || event.messageId;
          const failure: ChatMessage = {
            id: failureId,
            role: "assistant",
            author: "OmniScientist",
            time: messageTime(),
            content: t("本地研究运行失败：{0}", event.error),
            blocks: [{
              id: `${failureId}-error`,
              type: "markdown",
              content: t("本地研究运行失败：{0}", event.error),
            }],
            progress: "complete",
          };
          setSession((current) => {
            if (!current) return current;
            const exists = current.messages.some((message) => message.id === failureId);
            return {
              ...current,
              status: "idle",
              messages: exists
                ? current.messages.map((message) => message.id === failureId ? failure : message)
                : [...current.messages, failure],
            };
          });
        }
        if (event.type === "assistant.completed") {
          setSession((current) => current ? {
            ...updateAssistant(current, event.message.id, (message) => ({
              ...event.message,
              blocks: event.message.blocks ?? message.blocks,
              progress: "complete",
            })),
            status: "complete",
          } : current);
        }
      }
      setSessions((current) => current.map((item) => item.id === targetSessionId
        ? {
            ...item,
            status: runFailed ? "idle" : "complete",
            preview: runFailed ? t("本地运行失败") : t("本轮研究已完成"),
            updatedAt: t("刚刚"),
          }
        : item));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const failureId = assistantId || `assistant-error-${Date.now()}`;
      setSession((current) => {
        if (!current) return current;
        const failure: ChatMessage = {
          id: failureId,
          role: "assistant",
          author: "OmniScientist",
          time: messageTime(),
          content: t("无法连接本地后端：{0}", detail),
          blocks: [{
            id: `${failureId}-error`,
            type: "markdown",
            content: t("无法连接本地后端：{0}", detail),
          }],
          progress: "complete",
        };
        const exists = current.messages.some((message) => message.id === failureId);
        return {
          ...current,
          status: "idle",
          messages: exists
            ? current.messages.map((message) => message.id === failureId ? { ...message, content: failure.content } : message)
            : [...current.messages, failure],
        };
      });
      setSessions((current) => current.map((item) => item.id === targetSessionId
        ? { ...item, status: "idle", preview: t("本地运行失败"), updatedAt: t("刚刚") }
        : item));
    } finally {
      activeSendRef.current = false;
      setBusy(false);
    }
  };

  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (workbenchOverlay) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = workbenchWidth;
    setResizingWorkbench(true);
    const resize = (pointerEvent: PointerEvent) => {
      setWorkbenchWidth(clampWorkbenchWidth(startWidth + startX - pointerEvent.clientX));
    };
    const stop = () => {
      window.removeEventListener("pointermove", resize);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
      document.body.classList.remove("is-resizing");
      setResizingWorkbench(false);
    };
    document.body.classList.add("is-resizing");
    window.addEventListener("pointermove", resize);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
  };

  const resetWorkbenchWidth = () => {
    setWorkbenchWidth(clampWorkbenchWidth(viewportWidth * 0.36));
  };

  const shellStyle = useMemo(() => ({ "--workbench-width": `${workbenchWidth}px` }) as React.CSSProperties, [workbenchWidth]);

  if (booting) {
    return (
      <div className="app-loading">
        <img src="/assets/omni-logo.svg" alt="" />
        <LoaderCircle size={17} />
        <span>{t("正在打开研究工作区")}</span>
      </div>
    );
  }

  if (!session) {
    const missingKey = /API key|api_key|通道/.test(bootError ?? "");
    return (
      <div className="app-empty">
        <img src="/assets/omni-logo.svg" alt="" />
        <h1>{t("研究工作台已就绪")}</h1>
        {missingKey ? (
          <p>{t("还差一步：选一个模型通道并填上 API key，就可以开始第一个研究会话。")}</p>
        ) : bootError ? (
          <p>{t("开不了新会话：{0}", bootError)}</p>
        ) : (
          <p>{t("还没有研究会话。新建一个，把数据交给它，然后说清楚你想研究什么。")}</p>
        )}
        <div className="app-empty-actions">
          <button type="button" className="settings-btn is-primary" onClick={() => setBootSettingsOpen(true)}>
            {t("打开模型设置")}
          </button>
          <button
            type="button"
            className="settings-btn"
            onClick={() => {
              setBootError(null);
              setBooting(true);
              void (async () => {
                try {
                  const created = await transport.createSession(WORKSPACE_LABEL);
                  setSessions([created]);
                  activateSession(created);
                } catch (error) {
                  setBootError(error instanceof Error ? error.message : String(error));
                } finally {
                  setBooting(false);
                }
              })();
            }}
          >
            {t("新建研究会话")}
          </button>
        </div>
        <SettingsDialog
          open={bootSettingsOpen}
          onClose={() => setBootSettingsOpen(false)}
          onSaved={() => setBootError(null)}
        />
      </div>
    );
  }

  const closeOverlays = () => {
    setLeftOpen(false);
    setWorkbenchOpen(false);
  };

  return (
    <div
      className={`app-shell ${leftOpen ? "has-sidebar" : ""} ${workbenchOpen ? "has-workbench" : ""}`}
      style={shellStyle}
    >
      {overlayOpen ? <button className="mobile-scrim" type="button" tabIndex={-1} onClick={closeOverlays} aria-label={t("关闭面板")} /> : null}
      {leftOpen ? (
        <ConversationSidebar
          sessions={sessions}
          selectedId={selectedId}
          onSelect={(id) => void selectSession(id)}
          onNew={() => void createNewSession()}
          onClose={() => setLeftOpen(false)}
        />
      ) : null}

      <ChatPane
        session={session}
        draft={draft}
        leftOpen={leftOpen}
        workbenchOpen={workbenchOpen}
        busy={busy}
        onToggleLeft={() => {
          if (!leftOpen && sidebarOverlay) overlayReturnFocus.current = document.activeElement as HTMLElement | null;
          setLeftOpen((value) => !value);
          if (workbenchOverlay) setWorkbenchOpen(false);
        }}
        onToggleWorkbench={() => {
          if (!workbenchOpen && workbenchOverlay) overlayReturnFocus.current = document.activeElement as HTMLElement | null;
          setWorkbenchOpen((value) => !value);
          if (workbenchOverlay) setLeftOpen(false);
        }}
        onDraftChange={updateDraft}
        onSend={(content, dataPath) => void sendMessage(content, dataPath)}
        onOpenArtifact={openArtifact}
        onOpenTrace={openTrace}
      />

      {workbenchOpen ? (
        <>
          <div
            className={`workbench-resizer ${resizingWorkbench ? "is-active" : ""}`}
            role="separator"
            aria-label={t("调整工作台宽度")}
            aria-orientation="vertical"
            aria-valuemin={MIN_WORKBENCH_WIDTH}
            aria-valuemax={Math.round(maxWorkbenchWidth)}
            aria-valuenow={Math.round(workbenchWidth)}
            tabIndex={0}
            onPointerDown={startResize}
            onDoubleClick={resetWorkbenchWidth}
            onKeyDown={(event) => {
              if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
              event.preventDefault();
              if (event.key === "ArrowLeft") setWorkbenchWidth((value) => clampWorkbenchWidth(value + 24));
              if (event.key === "ArrowRight") setWorkbenchWidth((value) => clampWorkbenchWidth(value - 24));
              if (event.key === "Home") setWorkbenchWidth(MIN_WORKBENCH_WIDTH);
              if (event.key === "End") setWorkbenchWidth(maxWorkbenchWidth);
            }}
          >
            <span className="resizer-handle"><GripVertical size={14} /></span>
          </div>
          <Workbench
            artifacts={openArtifacts}
            activeId={activeArtifactId}
            trace={activeTrace}
            onActivate={setActiveArtifactId}
            onCloseArtifact={closeArtifact}
            onCloseTrace={() => setActiveTrace(null)}
            onClosePanel={() => setWorkbenchOpen(false)}
          />
        </>
      ) : null}
    </div>
  );
}
