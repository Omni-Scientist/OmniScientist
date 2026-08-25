/**
 * 版本检查。只查、只报，永不自己安装。
 *
 * 三条硬规矩，写在最前面免得以后有人"顺手优化"掉：
 *
 *   1. 绝不下载、绝不替换任何文件。桌面应用在用户不知情时换掉自己的二进制，
 *      一旦某个版本有问题，用户会在毫无察觉的情况下被换掉。要不要更新是用户的决定。
 *   2. 一天最多查一次，按"当天第一次启动"算。每次启动都查等于给每个用户的每次启动
 *      都加一次对 GitHub 的请求，也是一个可被观测的"谁在用"信号。
 *   3. 查失败一律当没有新版本。网络不通、GitHub 挂了、限流了，都不该让研究流程
 *      卡住或者报错——更新检查是锦上添花，不是前置条件。
 *
 * 关掉：~/.omnisci/env 里写 OMNISCI_UPDATE_CHECK=off，或者设同名环境变量。
 * 界面上的开关写的就是这个值。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export const REPO = "Omni-Scientist/OmniScientist";
const LATEST = `https://api.github.com/repos/${REPO}/releases/latest`;

/** 查过一次就记在这儿，用来算"今天查过没有"。 */
const STATE_FILE = join(homedir(), ".omnisci", "update-check.json");

export interface UpdateInfo {
  /** 远端最新的版本号，去掉了 v 前缀。 */
  latest: string;
  current: string;
  /** 远端确实比本地新。相等或更旧都是 false。 */
  newer: boolean;
  /** release 页面，提示里给用户点的就是它。 */
  url: string;
  /** 这个平台对应的产物，没有匹配的就是 undefined。sumsUrl 是整个 release 共用的 SHA256SUMS。 */
  asset?: { name: string; url: string; sumsUrl?: string };
}

interface State {
  /** 上次检查的日期，YYYY-MM-DD，按本地时区。 */
  checkedOn?: string;
  /** 上次查到的版本，用来在跳过检查的那些天里仍然能提示。 */
  latest?: string;
}

export function updateCheckDisabled(): boolean {
  const raw = (process.env.OMNISCI_UPDATE_CHECK ?? "").trim().toLowerCase();
  return raw === "off" || raw === "0" || raw === "false" || raw === "no";
}

function today(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function readState(): State {
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf-8")) as State;
  } catch {
    return {};
  }
}

function writeState(state: State): void {
  try {
    mkdirSync(dirname(STATE_FILE), { recursive: true });
    const temp = `${STATE_FILE}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(state), "utf-8");
    renameSync(temp, STATE_FILE);
  } catch {
    // 记不下来最多是明天多查一次，不值得打扰用户
  }
}

/**
 * 比较两个版本号。左边更新返回正数。
 *
 * 只认 x.y.z 这种；带后缀的（1.2.0-rc1）按数字段比，后缀忽略——预发布版本
 * 不该把正式版盖过去，但也不值得为它引一个 semver 依赖。
 */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => v.replace(/^v/, "").split(/[.\-+]/).map((x) => Number(x) || 0);
  const left = parts(a);
  const right = parts(b);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const delta = (left[i] ?? 0) - (right[i] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

/**
 * 这个平台该下哪个产物。
 *
 * 名字在 2026-08-25 统一过一次，三条规矩：一律 `<产品>-<平台>[-<架构>].<扩展名>`，
 * 一律**不带版本号**（这样 releases/latest/download/<name> 是永远有效的链接），
 * 一律用人话而不是 uname 的黑话（macOS 不是 darwin，x64 不是 x86_64）。
 *
 * 在那之前是三套规则打架：CLI 是没有扩展名的裸二进制（omnisci-darwin-arm64），
 * 桌面 Linux / macOS 包不带版本号，唯独桌面 Windows 包带（那个名字由
 * build-windows.ps1 自己拼），所以这里以前得留一段可选的 `-1.2.3` 去兜它。
 *
 * 仍然返回正则而不是直接给字符串：调用方拿它去 release 的资产列表里找，匹配比
 * 相等更禁得起将来再加东西。check_parity 会拿工作流里真实的产物名回来对这几条。
 *
 * **跨版本的一次性代价**：0.1.5 及更早的客户端里编译进去的是旧正则，它们在新名字
 * 的资产列表里找不到匹配，"检查更新"会报找不到产物。手动去 release 页面下一次
 * 之后就正常了。这是改名换来的，明知的取舍，不是漏了。
 */
export function assetPatternFor(platform: string, arch: string, kind: "cli" | "desktop"): RegExp {
  const product = kind === "cli" ? "omnisci-CLI" : "OmniSci-Desktop";
  let name: string;
  if (platform === "win32") {
    name = `${product}-Windows-x64.zip`;
  } else if (platform === "darwin") {
    // macOS 只出 arm64（2026-08-18 决定），所以名字里没有架构那一段。
    // 桌面版是 zip（.app 双击是 Mac 用户的预期，也是 Apple 文档里发 .app 的形式），
    // CLI 是 tar.gz（tar 天然保执行位，不依赖解压工具的实现）。
    name = kind === "cli" ? `${product}-macOS.tar.gz` : `${product}-macOS.zip`;
  } else {
    name = `${product}-Linux-${arch === "arm64" ? "ARM64" : "x64"}.tar.gz`;
  }
  return new RegExp(`^${name.replace(/\./g, "\\.")}$`);
}

interface Release {
  tag_name?: string;
  html_url?: string;
  assets?: Array<{ name?: string; browser_download_url?: string }>;
}

/**
 * 问一次 GitHub。`force` 跳过每日节流，给用户手动触发的那条路用。
 * 返回 null 表示"这次不该提示"：关掉了、今天查过了、或者查失败了。
 *
 * 这四种情况都是 null，对后台那次检查来说够了（不提示就完了）。但用户亲手点
 * "检查更新"的时候不够：查失败也回 null，界面就只能说"已是最新"，把一次没查成
 * 说成了一次查过。要区分的调用方传 onError，失败时会拿到原因。
 */
export async function checkForUpdate(
  currentVersion: string,
  kind: "cli" | "desktop",
  options: { force?: boolean; timeoutMs?: number; onError?: (reason: string) => void } = {},
): Promise<UpdateInfo | null> {
  if (!options.force && updateCheckDisabled()) return null;

  const state = readState();
  if (!options.force && state.checkedOn === today()) {
    // 今天查过了。上次的结果还在，仍然可以提示，但不再打扰 GitHub。
    if (state.latest && compareVersions(state.latest, currentVersion) > 0) {
      return {
        latest: state.latest,
        current: currentVersion,
        newer: true,
        url: `https://github.com/${REPO}/releases/latest`,
      };
    }
    return null;
  }

  let release: Release;
  try {
    const response = await fetch(LATEST, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": `OmniScientist/${currentVersion}` },
      signal: AbortSignal.timeout(options.timeoutMs ?? 4000),
    });
    if (!response.ok) {                  // 404（还没发过 release）、403（限流）
      options.onError?.(`GitHub 返回 ${response.status}`);
      return null;
    }
    release = (await response.json()) as Release;
  } catch (error) {
    // 网络不通不该让任何东西失败，但也不该被当成"已是最新"
    options.onError?.(error instanceof Error ? error.message : String(error));
    return null;
  }

  const latest = String(release.tag_name ?? "").replace(/^v/, "");
  if (!latest) return null;
  writeState({ checkedOn: today(), latest });

  if (compareVersions(latest, currentVersion) <= 0) return null;

  const wanted = assetPatternFor(process.platform, process.arch, kind);
  const assets = release.assets ?? [];
  const hit = assets.find((a) => a.name && wanted.test(a.name));
  // 校验和只有一个文件：以前每个产物旁边挂一个同名 .sha256，release 列表被撑成两倍长。
  const sums = assets.find((a) => a.name === "SHA256SUMS");

  return {
    latest,
    current: currentVersion,
    newer: true,
    url: release.html_url || `https://github.com/${REPO}/releases/latest`,
    asset: hit?.browser_download_url && hit.name
      ? { name: hit.name, url: hit.browser_download_url, sumsUrl: sums?.browser_download_url }
      : undefined,
  };
}

/**
 * 用户该怎么更新。**只是一句话**，这里不执行任何东西。
 * 装的那一步由 install.sh / install.ps1 做，它们本来就核对 sha256。
 */
export function updateCommand(kind: "cli" | "desktop", platform = process.platform): string {
  if (kind === "cli") {
    return platform === "win32"
      ? `irm https://raw.githubusercontent.com/${REPO}/main/install.ps1 | iex`
      : `curl -fsSL https://raw.githubusercontent.com/${REPO}/main/install.sh | sh`;
  }
  return `到 https://github.com/${REPO}/releases/latest 下载新版本`;
}
