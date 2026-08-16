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
