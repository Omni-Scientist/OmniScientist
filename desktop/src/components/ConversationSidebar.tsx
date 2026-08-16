import { useEffect, useMemo, useState } from "react";
import {
  Check,
  ChevronDown,
  FolderGit2,
  LoaderCircle,
  MoreHorizontal,
  PanelLeftClose,
  Plus,
  Search,
  Settings2,
} from "lucide-react";
import type { SessionSummary } from "../types";
import { IconButton } from "./IconButton";
import { SettingsDialog } from "./SettingsDialog";
import { loadSettings, settingsAvailable, type SettingsState } from "../lib/settings";
import { t } from "../lib/i18n";

interface ConversationSidebarProps {
  sessions: SessionSummary[];
  selectedId: string;
  onSelect: (id: string) => void;
  onNew: () => void;
  onClose: () => void;
}

function StatusMark({ status }: { status: SessionSummary["status"] }) {
  if (status === "running") {
    return (
      <span className="session-status is-running" title={t("运行中")}>
        <LoaderCircle size={12} />
      </span>
    );
  }
  if (status === "complete") {
    return (
      <span className="session-status is-complete" title={t("已完成")}>
        <Check size={11} strokeWidth={2.7} />
      </span>
    );
  }
  return <span className="session-status is-idle" title={t("空闲")} />;
}

export function ConversationSidebar({
  sessions,
  selectedId,
  onSelect,
  onNew,
  onClose,
}: ConversationSidebarProps) {
  const [query, setQuery] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settings, setSettings] = useState<SettingsState | null>(null);

  // 桌面版才有本机后端；演示版读不到，底部就退回一句中性的说明。
  useEffect(() => {
    if (!settingsAvailable) return;
    let cancelled = false;
    loadSettings()
      .then((next) => { if (!cancelled) setSettings(next); })
      .catch(() => { /* 读不到就按未配置显示，点开设置里会给出真正的错误 */ });
    return () => { cancelled = true; };
  }, []);

  // 工作区名由后端给（launcher 决定的真实目录），不写死在前端。
  const workspaceName =
    sessions.find((item) => item.id === selectedId)?.workspace ?? sessions[0]?.workspace ?? t("本地工作区");

  const activeProvider = settings?.providers.find((p) => p.id === settings.active);
  const activeLabel = !settingsAvailable
    ? t("演示模式")
    : settings
      ? settings.ready ? (activeProvider?.label ?? t("已配置")) : t("未配置模型")
      : t("本地工作区");
  const activeDetail = !settingsAvailable
    ? t("界面演示，未接本机后端")
    : settings
      ? settings.ready
        // 眼睛没配好也要在这儿露一句：不然要等 view_image 报错才知道。
        ? (activeProvider?.selected ?? "") + (settings.visionReady ? "" : t(" · 视觉未配置"))
        : t("点这里填 API key")
      : t("读取配置中…");
  const filtered = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return sessions;
    return sessions.filter((item) =>
      `${item.title} ${item.preview} ${item.workspace}`.toLocaleLowerCase().includes(normalized),
    );
  }, [query, sessions]);

  return (
    <aside className="conversation-sidebar" aria-label={t("对话列表")}>
      <div className="sidebar-brand-row">
        <div className="product-brand" aria-label="OmniScientist">
          <img src="/assets/omni-logo.svg" alt="" />
          <span>OmniScientist</span>
        </div>
        <IconButton label={t("收起对话栏")} tone="quiet" onClick={onClose}>
          <PanelLeftClose size={17} />
        </IconButton>
      </div>

      <button className="new-conversation-button" type="button" onClick={onNew}>
        <Plus size={17} />
        <span>{t("新建研究会话")}</span>
      </button>

      <label className="session-search">
        <Search size={15} />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t("搜索对话")}
          aria-label={t("搜索对话")}
        />
        {query ? (
          <button type="button" onClick={() => setQuery("")} aria-label={t("清空搜索")}>
            ×
          </button>
        ) : null}
      </label>

      <div className="workspace-switcher">
        <div className="workspace-icon">
          <FolderGit2 size={16} />
        </div>
        <div>
          <span>{t("当前工作区")}</span>
          <strong>{workspaceName}</strong>
        </div>
        <ChevronDown size={15} />
      </div>

      <nav className="session-list">
        {/* 这两个是**判等用的键**，服务器就是按这个字面量分组的，不能翻。
            要翻的是下面 <h2> 里显示的那一份。翻了键，英文下列表恒为空。 */}
        {(["今天", "过去 7 天"] as const).map((group) => {
          const items = filtered.filter((item) => item.group === group);
          if (!items.length) return null;
          return (
            <section className="session-group" key={group}>
              <h2>{t(group)}</h2>
              {items.map((session) => (
                <button
                  type="button"
                  className={`session-row ${selectedId === session.id ? "is-selected" : ""}`}
                  key={session.id}
                  onClick={() => onSelect(session.id)}
                >
                  <span className="session-row-topline">
                    <span className="session-title">{t(session.title)}</span>
                    <span className="session-time">{session.updatedAt}</span>
                  </span>
                  <span className="session-row-bottomline">
                    <StatusMark status={session.status} />
                    <span className="session-preview">{session.preview}</span>
                  </span>
                  <span className="session-more" aria-hidden="true">
                    <MoreHorizontal size={15} />
                  </span>
                </button>
              ))}
            </section>
          );
        })}
        {!filtered.length ? (
          <div className="session-empty">
            <Search size={18} />
            <span>{t("没有匹配的对话")}</span>
          </div>
        ) : null}
      </nav>

      <div className="sidebar-footer">
        <button
          className={`account-row${settings && !settings.ready ? " needs-setup" : ""}`}
          type="button"
          onClick={() => setSettingsOpen(true)}
          title={t("模型通道设置")}
        >
          <span className="account-avatar">{activeLabel.slice(0, 1)}</span>
          <span className="account-copy">
            <strong>{activeLabel}</strong>
            <small>{activeDetail}</small>
          </span>
          <Settings2 size={16} />
        </button>
      </div>

      <SettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onSaved={setSettings}
      />
    </aside>
  );
}
