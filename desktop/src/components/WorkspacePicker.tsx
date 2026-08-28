import { useEffect, useRef, useState } from "react";
import {
  ChevronRight, CircleAlert, CornerLeftUp, File, Folder, HardDriveDownload, House, LoaderCircle, X,
} from "lucide-react";

import {
  browseComputer, importIntoWorkspace, listWorkspace,
  type ComputerListing, type WorkspaceListing,
} from "../lib/workspace";
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
 * 工作区目录浏览器 + 「从电脑导入」。
 *
 * 为什么不用 <input type="file">：浏览器只给文件名和内容，不给路径，而 agent 要的
 * 是工作区内的相对路径——它自己去读盘，不需要浏览器把几百兆传一遍。所以目录树由
 * 本机服务列，这里只负责走一走、选一个。
 *
 * 「从电脑导入」是给数据还不在工作区里的人的：浏览本机目录（从家目录起步，能上
 * 下走动），选中的文件/文件夹由后端原生复制进工作区，数据不过浏览器，多大都行。
 */
export function WorkspacePicker({ open, onClose, onPick }: WorkspacePickerProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const [view, setView] = useState<"workspace" | "computer">("workspace");

  const [listing, setListing] = useState<WorkspaceListing | null>(null);
  const [path, setPath] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [comp, setComp] = useState<ComputerListing | null>(null);
  const [typed, setTyped] = useState("");
  const [compError, setCompError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setPath("");
    setView("workspace");
    setCompError(null);
    setImporting(false);
  }, [open]);

  useEffect(() => {
    if (!open || view !== "workspace") return;
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
  }, [open, view, path]);

  async function browse(target: string) {
    setCompError(null);
    try {
      const next = await browseComputer(target);
      setComp(next);
      setTyped(next.path);
    } catch (e) {
      setCompError(e instanceof Error ? e.message : String(e));
    }
  }

  useEffect(() => {
    if (open && view === "computer" && !comp) void browse("");
  }, [open, view, comp]);

  const crumbs = path ? path.split("/") : [];

  function choose(target: string) {
    onPick(target);
    onClose();
  }

  async function doImport() {
    const wanted = typed.trim();
    if (!wanted || importing) return;
    setImporting(true);
    setCompError(null);
    try {
      const picked = await importIntoWorkspace(wanted);
      choose(picked);
    } catch (e) {
      setCompError(e instanceof Error ? e.message : String(e));
    } finally {
      setImporting(false);
    }
  }

  const joinChild = (name: string) => `${(comp?.path ?? "").replace(/[/\\]$/, "")}/${name}`;

  return (
    <dialog className="picker-dialog" ref={ref} onClose={onClose} onCancel={onClose}>
      <header className="settings-head">
        <div>
          <h2>{view === "workspace" ? t("选择数据") : t("从电脑导入")}</h2>
          <p>
            {view === "workspace"
              ? t("工作区 {0}", listing?.root ?? "…")
              : t("选中的内容会复制进工作区，研究用的是那份拷贝")}
          </p>
        </div>
        <button className="settings-close" type="button" onClick={onClose} aria-label={t("关闭")}>
          <X size={16} />
        </button>
      </header>

      {view === "workspace" ? (
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
      ) : (
        <nav className="picker-crumbs">
          <button type="button" onClick={() => void browse(comp?.home ?? "")} title={t("回到家目录")}>
            <House size={14} />
          </button>
          <button
            type="button"
            disabled={!comp?.parent}
            onClick={() => comp?.parent && void browse(comp.parent)}
            title={t("上一层")}
          >
            <CornerLeftUp size={14} />
          </button>
          <input
            className="picker-path"
            value={typed}
            spellCheck={false}
            onChange={(event) => setTyped(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter") void browse(typed); }}
            aria-label={t("目录路径")}
          />
        </nav>
      )}

      <div className="picker-body">
        {view === "workspace" ? (
          error ? (
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
          )
        ) : (
          compError ? (
            <p className="picker-empty">
              <CircleAlert size={14} /> {compError}
            </p>
          ) : !comp ? (
            <p className="picker-empty">
              <LoaderCircle className="spin" size={14} /> {t("正在读取…")}
            </p>
          ) : !comp.items.length ? (
            <p className="picker-empty">{t("这个目录是空的")}</p>
          ) : (
            <ul className="picker-list">
              {comp.items.map((entry) => {
                const full = joinChild(entry.name);
                return (
                  <li key={entry.name}>
                    <button
                      type="button"
                      className={`picker-row${typed === full ? " is-picked" : ""}`}
                      onClick={() => (entry.kind === "dir" ? void browse(full) : setTyped(full))}
                    >
                      {entry.kind === "dir" ? <Folder size={15} /> : <File size={15} />}
                      <span className="picker-name">{entry.name}</span>
                      {entry.kind === "dir" ? <ChevronRight size={14} /> : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          )
        )}
      </div>

      <footer className="settings-foot">
        {view === "workspace" ? (
          <>
            <span className="settings-foot-note">
              {path ? t("选中：{0}", path) : t("点文件夹进去，点文件直接选")}
            </span>
            <div className="settings-actions">
              <button type="button" className="settings-btn" onClick={() => setView("computer")}>
                <HardDriveDownload size={14} /> {t("从电脑导入")}
              </button>
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
          </>
        ) : (
          <>
            <span className="settings-foot-note">
              {t("点文件夹进去；选中文件或停在要导入的文件夹里")}
            </span>
            <div className="settings-actions">
              <button type="button" className="settings-btn" onClick={() => setView("workspace")} disabled={importing}>
                {t("返回")}
              </button>
              <button
                type="button"
                className="settings-btn is-primary"
                disabled={importing || !typed.trim()}
                onClick={() => void doImport()}
              >
                {importing
                  ? <><LoaderCircle className="spin" size={14} /> {t("正在导入…")}</>
                  : t("导入到工作区")}
              </button>
            </div>
          </>
        )}
      </footer>
    </dialog>
  );
}
