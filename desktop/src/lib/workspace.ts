import { t } from "./i18n";
/**
 * 浏览工作区目录。走 gateway 的 /api/v1/workspace。
 *
 * 浏览器的 <input type="file"> 只给文件名和内容，不给路径；而 agent 要的是工作区
 * 内的相对路径（它自己去读盘）。所以目录树只能由本机服务列。
 */

export interface WorkspaceEntry {
  name: string;
  kind: "dir" | "file";
  /** 文件的字节数；目录的直接子项个数。 */
  size: number;
}

export interface WorkspaceListing {
  path: string;
  parent: string | null;
  root: string;
  entries: WorkspaceEntry[];
  truncated: number;
}

export async function listWorkspace(path: string): Promise<WorkspaceListing> {
  const response = await fetch(`/api/v1/workspace?path=${encodeURIComponent(path)}`);
  const payload = (await response.json().catch(() => ({}))) as Partial<WorkspaceListing> & { error?: string };
  if (!response.ok) throw new Error(payload.error || t("本地后端返回 {0}", response.status));
  return payload as WorkspaceListing;
}

// ---- 工作区之外：给「从电脑导入」用 ----

export interface ComputerEntry {
  name: string;
  kind: "dir" | "file";
}

export interface ComputerListing {
  path: string;
  parent: string | null;
  home: string;
  items: ComputerEntry[];
}

/** 浏览本机目录（连文件一起列）。走启动器的 /api/browse，只有本机 cookie 调得动。 */
export async function browseComputer(path: string): Promise<ComputerListing> {
  const response = await fetch(`/api/browse?files=1&path=${encodeURIComponent(path)}`);
  const payload = (await response.json().catch(() => ({}))) as Partial<ComputerListing> & { error?: string };
  if (!response.ok) throw new Error(payload.error || t("本地后端返回 {0}", response.status));
  return { ...payload, items: payload.items ?? [] } as ComputerListing;
}

/** Tauri 壳给远程页面注入的原生对话框 API（withGlobalTauri）。 */
interface TauriDialogApi {
  open(options: { directory?: boolean; multiple?: boolean; title?: string }): Promise<string | string[] | null>;
}

/** 跑在 Tauri 壳里就返回壳的原生对话框，浏览器模式返回 null。 */
export function tauriDialog(): TauriDialogApi | null {
  const injected = (window as { __TAURI__?: { dialog?: TauriDialogApi } }).__TAURI__;
  return injected?.dialog ?? null;
}

/** 后端弹不出系统选择框（无 GUI 的 Linux 等）。调用方退回目录树弹窗。 */
export class PickUnavailableError extends Error {}

/** 让后端弹系统原生选择框（Finder / 资源管理器）。返回选中的绝对路径，取消返回 null。 */
export async function pickFromComputer(kind: "file" | "folder"): Promise<string | null> {
  const response = await fetch(`/api/pick?kind=${kind}`, { method: "POST" });
  const payload = (await response.json().catch(() => ({}))) as
    { path?: string; cancelled?: boolean; error?: string };
  if (response.status === 501) throw new PickUnavailableError(payload.error || "");
  if (!response.ok) throw new Error(payload.error || t("本地后端返回 {0}", response.status));
  return payload.cancelled || !payload.path ? null : payload.path;
}

/** 收掉后端当前开着的系统选择框。挂着的那次 pickFromComputer 会以 null（取消）返回。 */
export function cancelPick(): void {
  void fetch("/api/pick?cancel=1", { method: "POST" });
}

/** 让后端把盘上一个文件/文件夹原生复制进工作区，返回工作区内的相对路径。数据不过浏览器。 */
export async function importIntoWorkspace(path: string): Promise<string> {
  const response = await fetch("/api/import", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });
  const payload = (await response.json().catch(() => ({}))) as { path?: string; error?: string };
  if (!response.ok || !payload.path) throw new Error(payload.error || t("本地后端返回 {0}", response.status));
  return payload.path;
}
