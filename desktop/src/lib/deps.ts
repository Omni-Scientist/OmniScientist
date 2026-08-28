/**
 * 依赖体检和补装。走 launcher 的 /api/doctor 和 /api/bootstrap，跟 settings.ts
 * 一样不经过 transport 那层抽象：那层是给"跟研究会话说话"用的，演示版会换成 mock，
 * 而这两个接口只有真后端有。
 *
 * 缺 tectonic 时一轮研究照样跑完，只是停在 .tex 不出 PDF。它不报错，模型也认为
 * 自己做完了，所以必须由界面把这件事说出来，否则用户要等一小时才发现少个编译器。
 */

export interface DepCheck {
  ok: boolean;
  /** 后端写死的中文说明。只在没有 items 可用时兜底显示。 */
  detail: string;
  /** 缺了哪几个包这类纯数据。包名不翻译，界面自己组句，不去拼后端的中文。 */
  items?: string[];
}

export interface DoctorState {
  checks: Record<string, DepCheck>;
  dataDir: string;
}

export interface InstallState {
  running: boolean;
  done: boolean;
  ok: boolean;
  /** true 表示这趟是启动后自动发起的，不是用户点的。 */
  auto: boolean;
  plan: { python: boolean; tectonic: boolean };
  log: string[];
}

/** 演示版没有本地后端，这两个接口会 404，别去问。 */
export const depsAvailable = import.meta.env.VITE_OMNISCI_LIVE === "1";

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`${path} 返回 ${response.status}`);
  return await response.json() as T;
}

export function loadDoctor(): Promise<DoctorState> {
  return getJson<DoctorState>("/api/doctor");
}

export function loadInstall(): Promise<InstallState> {
  return getJson<InstallState>("/api/bootstrap");
}

/** 发起补装。后端立刻回 202，真正的进度要轮询 loadInstall。 */
export async function startInstall(): Promise<void> {
  const response = await fetch("/api/bootstrap", { method: "POST" });
  if (!response.ok) throw new Error(`安装请求返回 ${response.status}`);
}

/** 没过的项。顺序固定，界面上不能一次一个样。 */
export function missingChecks(checks: Record<string, DepCheck>): string[] {
  const order = ["python", "packages", "tectonic"];
  const known = order.filter((name) => checks[name] && !checks[name]!.ok);
  const extra = Object.keys(checks).filter((name) => !order.includes(name) && !checks[name]!.ok);
  return [...known, ...extra];
}
