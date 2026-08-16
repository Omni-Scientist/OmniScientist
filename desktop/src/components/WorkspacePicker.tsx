import { useEffect, useRef, useState } from "react";
import { ChevronRight, CircleAlert, File, Folder, LoaderCircle, X } from "lucide-react";

import { listWorkspace, type WorkspaceListing } from "../lib/workspace";
import { t } from "../lib/i18n";

interface WorkspacePickerProps {
  open: boolean;
  onClose: () => void;
  /** 选中之后回传工作区内的相对路径。 */
  onPick: (path: string) => void;
}

function readable(entry: { kind: "dir" | "file"; size: number }): string {
  if (entry.kind === "dir") return t("{0} 项", entry.size);
  if (entry.size < 1024) return `${entry.size} B`;
  if (entry.size < 1024 * 1024) return `${(entry.size / 1024).toFixed(0)} KB`;
  return `${(entry.size / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * 工作区目录浏览器。
 *
 * 为什么不用 <input type="file">：浏览器只给文件名和内容，不给路径，而 agent 要的
 * 是工作区内的相对路径——它自己去读盘，不需要浏览器把几百兆传一遍。所以目录树由
 * 本机服务列，这里只负责走一走、选一个。
 */
export function WorkspacePicker({ open, onClose, onPick }: WorkspacePickerProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const [listing, setListing] = useState<WorkspaceListing | null>(null);
  const [path, setPath] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  useEffect(() => {
    if (open) setPath("");
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    listWorkspace(path)
      .then((next) => {
        if (!cancelled) setListing(next);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, path]);

  const crumbs = path ? path.split("/") : [];

  function choose(target: string) {
    onPick(target);
    onClose();
  }

  return (
    <dialog className="picker-dialog" ref={ref} onClose={onClose} onCancel={onClose}>
      <header className="settings-head">
        <div>
          <h2>{t("选择数据")}</h2>
          <p>{t("工作区 {0}", listing?.root ?? "…")}</p>
        </div>
        <button className="settings-close" type="button" onClick={onClose} aria-label={t("关闭")}>
          <X size={16} />
        </button>
      </header>

      <nav className="picker-crumbs" aria-label={t("路径")}>
        <button type="button" onClick={() => setPath("")} disabled={!path}>
          {listing?.root ?? t("工作区")}
        </button>
        {crumbs.map((name, index) => (
          <span key={`${name}-${index}`}>
            <ChevronRight size={13} />
            <button
              type="button"
              onClick={() => setPath(crumbs.slice(0, index + 1).join("/"))}
              disabled={index === crumbs.length - 1}
            >
              {name}
            </button>
          </span>
        ))}
      </nav>

      <div className="picker-body">
        {error ? (
          <p className="picker-empty">
            <CircleAlert size={14} /> {error}
          </p>
        ) : loading && !listing ? (
          <p className="picker-empty">
            <LoaderCircle className="spin" size={14} /> {t("正在读取…")}
          </p>
        ) : !listing?.entries.length ? (
          <p className="picker-empty">{t("这个目录是空的")}</p>
        ) : (
          <ul className="picker-list">
            {listing.entries.map((entry) => {
              const full = path ? `${path}/${entry.name}` : entry.name;
              return (
                <li key={entry.name}>
                  <button
                    type="button"
                    className="picker-row"
                    onDoubleClick={() => entry.kind === "dir" && setPath(full)}
                    onClick={() => (entry.kind === "dir" ? setPath(full) : choose(full))}
                  >
                    {entry.kind === "dir" ? <Folder size={15} /> : <File size={15} />}
                    <span className="picker-name">{entry.name}</span>
                    <span className="picker-meta">{readable(entry)}</span>
                    {entry.kind === "dir" ? <ChevronRight size={14} /> : null}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {listing?.truncated ? (
          <p className="picker-empty">{t("还有 {0} 项没列出来", listing.truncated)}</p>
        ) : null}
      </div>

      <footer className="settings-foot">
        <span className="settings-foot-note">
          {path ? t("选中：{0}", path) : t("点文件夹进去，点文件直接选")}
        </span>
        <div className="settings-actions">
          <button type="button" className="settings-btn" onClick={onClose}>
            {t("取消")}
          </button>
          <button
            type="button"
            className="settings-btn is-primary"
            disabled={!path}
            onClick={() => choose(path)}
          >
            {t("用这个文件夹")}
          </button>
        </div>
      </footer>
    </dialog>
  );
}
