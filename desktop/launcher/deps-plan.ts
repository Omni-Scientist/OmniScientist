/**
 * 依赖体检结果 → 要补哪几样。
 *
 * 单独放一个模块是为了能测。main.ts 是个带顶层 await 的启动脚本，一 import 就
 * 把服务起起来了，测不了；这里全是纯函数，没有副作用，也不碰文件系统。
 */

export interface Check {
  ok: boolean;
  /** 给人看的一句话，中文。终端和日志用它。 */
  detail: string;
  /**
   * 给界面看的清单，比如缺了哪几个包。
   *
   * detail 是中文写死的，界面拿它去填英文句子会拼出「Missing python packages
   * (缺 imageio、soundfile)」这种半中半英的东西。名字这类内容本来就不该翻译，
   * 所以单独给一份纯数据，让界面自己组句。
   */
  items?: string[];
}

/** 体检项的固定顺序。界面上和日志里都按这个顺序说，别一次一个样。 */
export const CHECK_ORDER = ["python", "packages", "tectonic"] as const;

export interface InstallPlan {
  /** 建虚拟环境 + pip 装包。python 或 packages 任一不过就要做。 */
  python: boolean;
  /** 下 tectonic。缺它一轮研究会停在 .tex 不出 PDF。 */
  tectonic: boolean;
}

/** 没过的项，按 CHECK_ORDER 排。全过就是空数组。 */
export function missingNames(checks: Record<string, Check>): string[] {
  const known = CHECK_ORDER.filter((name) => checks[name] && !checks[name]!.ok) as string[];
  // 将来体检加了新项，忘了往 CHECK_ORDER 里补也不能漏报，所以额外的项接在后面。
  const extra = Object.keys(checks).filter((name) => !CHECK_ORDER.includes(name as never) && !checks[name]!.ok);
  return [...known, ...extra];
}

/**
 * 缺什么补什么。
 *
 * 以前 bootstrap 一上来就无条件建 venv、pip install 一整份 requirements、再看
 * tectonic。只缺 tectonic 的人也要陪着跑一遍 pip，几百 MB 的索引和轮子白拉。
 */
export function planFor(checks: Record<string, Check>): InstallPlan {
  return {
    python: !checks.python?.ok || !checks.packages?.ok,
    tectonic: !checks.tectonic?.ok,
  };
}

/** 什么都不用做的计划。用来判断「体检没过但没有一样是我能装的」。 */
export function planIsEmpty(plan: InstallPlan): boolean {
  return !plan.python && !plan.tectonic;
}

export interface AutoDecision { run: boolean; reason: string }

/**
 * 要不要自动补。
 *
 * 三件事必须同时成立才动手，缺一样都把原因说出来，不做无声跳过。
 * 上次失败后要冷却，是因为 pip 那一趟要拉几百 MB，网不通的机器上每次开机
 * 重来一遍纯属白烧流量和 CPU。冷却只管自动那条路，用户在界面上手点的
 * 「安装依赖」任何时候都立刻执行。
 */
export function autoDecision(input: {
  checks: Record<string, Check>;
  disabled: boolean;
  failedAt: number | null;
  now: number;
  retryAfterMs: number;
}): AutoDecision {
  const missing = missingNames(input.checks);
  if (!missing.length) return { run: false, reason: "依赖齐全" };
  if (input.disabled) return { run: false, reason: "OMNISCI_AUTO_INSTALL=0，自动补依赖关着" };
  if (planIsEmpty(planFor(input.checks))) {
    return { run: false, reason: `缺 ${missing.join("、")}，但没有一样是能自动装的` };
  }
  if (input.failedAt !== null && input.now - input.failedAt < input.retryAfterMs) {
    const hours = Math.max(1, Math.round((input.retryAfterMs - (input.now - input.failedAt)) / 3600_000));
    return { run: false, reason: `上次自动补依赖没成，${hours} 小时内不重试。界面上点「安装依赖」可以立刻重来` };
  }
  return { run: true, reason: `缺 ${missing.join("、")}` };
}
