import { useEffect, useRef, useState } from "react";
import { CornerLeftUp, Folder, House, LoaderCircle, X } from "lucide-react";

import { t } from "../lib/i18n";

interface Listing {
  path: string;
  parent: string | null;
  home: string;
  entries: string[];
}

/**
 * 选工作目录。可以走到盘上任何地方。
 *
 * 这跟旁边那个"选数据"的选择器不是一回事：那个在工作目录**内部**挑数据，边界是
 * 有意的；这个是挑工作目录本身，本来就得能出去。只列目录名、不返回任何文件内容，
 * 而且要拿着一次性令牌换来的 cookie 才调得动 —— 也就是只有本机上开这个程序的人。
 */
export function WorkspaceRootPicker({
  open, current, onClose, onPicked,
}: {
  open: boolean;
  current: string;
  onClose: () => void;
  onPicked: (path: string) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [listing, setListing] = useState<Listing | null>(null);
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  async function browse(path: string) {
    setError(null);
    try {
      const response = await fetch(`/api/browse?path=${encodeURIComponent(path)}`);
      const payload = await response.json() as Listing & { error?: string };
      if (!response.ok) throw new Error(payload.error || String(response.status));
      setListing(payload);
      setTyped(payload.path);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  useEffect(() => {
    if (open) void browse(current || "");
  }, [open, current]);

  async function use(path: string) {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/workspace", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path }),
      });
      const payload = await response.json() as { error?: string; changed?: boolean };
      if (!response.ok) throw new Error(payload.error || String(response.status));
      onPicked(path);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <dialog className="settings-dialog picker-dialog" ref={ref} onClose={onClose} onCancel={onClose}>
      <header className="settings-head">
        <div>
          <h2>{t("选择工作目录")}</h2>
          <p>{t("研究会话、数据和产物都放在这个目录下")}</p>
        </div>
        <button className="settings-close" type="button" onClick={onClose} aria-label={t("关闭")}>
          <X size={16} />
        </button>
      </header>

      <nav className="picker-crumbs">
        <button type="button" onClick={() => void browse(listing?.home ?? "")} title={t("回到家目录")}>
          <House size={14} />
        </button>
        <button
          type="button"
          disabled={!listing?.parent}
          onClick={() => listing?.parent && void browse(listing.parent)}
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

      <div className="picker-body">
        {error ? <p className="picker-empty">{error}</p> : null}
        {!listing ? (
          <p className="picker-empty"><LoaderCircle className="spin" size={14} /> {t("正在读取…")}</p>
        ) : !listing.entries.length ? (
          <p className="picker-empty">{t("这个目录下没有子目录")}</p>
        ) : (
          <ul className="picker-list">
            {listing.entries.map((name) => (
              <li key={name}>
                <button
                  type="button"
                  className="picker-row"
                  onClick={() => void browse(`${listing.path.replace(/[/\\]$/, "")}/${name}`)}
                >
                  <Folder size={15} />
                  <span>{name}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <footer className="settings-foot">
        <span className="settings-foot-note">{t("换目录会重开本地服务，这一页会自动接回来")}</span>
        <div className="settings-actions">
          <button type="button" className="settings-btn" onClick={onClose}>{t("取消")}</button>
          <button
            type="button"
            className="settings-btn is-primary"
            disabled={busy || !typed.trim()}
            onClick={() => void use(typed.trim())}
          >
            {busy ? <><LoaderCircle className="spin" size={14} /> {t("切换中")}</> : t("用这个目录")}
          </button>
        </div>
      </footer>
    </dialog>
  );
}
