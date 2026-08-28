/**
 * 找到真的能跑的 python 和 shell。
 *
 * 为什么不能直接 spawn("python3") 或者 spawn("bash")：
 *
 *   1. Windows 上 `python3` 通常解析到微软商店的应用执行别名
 *      （%LOCALAPPDATA%\Microsoft\WindowsApps\python3.exe，一个 2 字节的重解析点）。
 *      它不是 python，跑起来只会弹商店然后**退出码 49**。真机上实测过：所有
 *      omnisci_* 工具连着十次全挂在这个 49 上，而 `where python` 的第一条是个好好的
 *      python。也就是说"文件存在"完全不等于"能跑"，用 which/where 判存在必然踩雷。
 *
 *   2. Windows 上 `bash` 解析到 C:\Windows\System32\bash.exe，那是 **WSL 启动器**。
 *      命令会跑进一个 Linux 虚拟机：文件系统变成 /mnt/c/...，宿主进程的环境变量
 *      一个都不继承（OMNISCI 在宿主里设好了，在那边是空的）。模型据此判断"工具坏了"，
 *      于是绕开工具在 WSL 里手工干活，产出是真的，回执一条没有，工作台一片空白。
 *      静默跑进另一个操作系统比直接报错糟糕得多。
 *
 * 所以这里一律**执行一次候选**，让它自报身份，通过了才用。探测结果按进程缓存。
 *
 * 想手动指定就设 OMNISCI_PYTHON / OMNISCI_SHELL，绕过全部探测。
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";

import { dataDir } from "./paths.ts";

const PROBE_MS = 8000;

/**
 * PATH 上同名的**所有**可执行文件，按 PATH 顺序。
 *
 * 只取第一条是不够的：Windows 上那个商店占位符经常排在真 python 前面，
 * 而后面就跟着一个能用的。要能跳过坏的接着试下一个。
 */
function whichAll(bin: string): string[] {
  const win = process.platform === "win32";
  const r = spawnSync(win ? "where" : "which", win ? [bin] : ["-a", bin], {
    encoding: "utf-8",
    timeout: PROBE_MS,
  });
  if (r.status !== 0) return [];
  return (r.stdout || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

export interface CapturedCommand { code: number; stdout: string; stderr: string }

/**
 * 起一个子进程收走输出，**不堵事件循环**。
 *
 * 桌面版的 HTTP 服务跟这些探测跑在同一条事件循环上，spawnSync 一进去，所有还没
 * 答复的请求就地排队。2026-08-25 在 Windows 上量过两次代价：那发依赖体检堵了
 * 13.7 秒，解释器探测本身堵了 1.3 秒。CLI 那边是一次性进程，没这个约束，
 * 所以同步的那几个照旧留着。
 *
 * 找不到可执行文件时 Bun.spawn 是**抛**不是返回非零，这里统一收成 code 127。
 * windowsHide：GUI 版自己没有控制台，不说一声就可能闪黑窗。
 */
export async function captureCommand(
  bin: string,
  args: string[],
  timeoutMs = PROBE_MS,
): Promise<CapturedCommand> {
  try {
    const proc = Bun.spawn([bin, ...args], {
      stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true,
    });
    const timer = setTimeout(() => { try { proc.kill(); } catch { /* 已经结束了 */ } }, timeoutMs);
    try {
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      return { code: await proc.exited, stdout, stderr };
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    return { code: 127, stdout: "", stderr: String(error) };
  }
}

/** whichAll 的异步版，语义完全一样。 */
async function whichAllAsync(bin: string): Promise<string[]> {
  const win = process.platform === "win32";
  const r = await captureCommand(win ? "where" : "which", win ? [bin] : ["-a", bin]);
  if (r.code !== 0) return [];
  return r.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

/** 同一个 argv 只试一次：python3 和 python 两轮 which 经常指到同一个文件。 */
function firstTimeSeen(seen: Set<string>, argv: string[]): boolean {
  const key = argv.join("\u0000");
  if (seen.has(key)) return false;
  seen.add(key);
  return true;
}

// ------------------------------------------------------------------ python

let pythonCache: string[] | null = null;
/**
 * 缓存的这个结果还会不会变。
 *
 * 受管 venv 和 OMNISCI_PYTHON 是最优先的两个来源，选中它们就到顶了，可以焊死。
 * 选中的是系统 python 则只是「此刻没有更好的」，venv 一旦建出来就该让位。
 */
let pythonCacheFinal = false;
let basePythonCache: string[] | null = null;

/**
 * 让候选自己报 major 版本和它认为自己跑在什么平台上。
 *
 * 平台那一段是 Windows 上的关键：`WindowsApps\\python3.exe` 是 WSL 的转发器，
 * 跑起来是另一个操作系统里的解释器，`sys.version_info[0]` 一样返回 3，光看版本
 * 根本分不出来。选中它之后 `$OMNISCI` 展开成空、路径按 /mnt/c 解析、tectonic 找不到，
 * 报错还全是 `wsl: Failed to translate` 这种跟真正原因毫无关系的噪音。
 * 2026-08-27 在一台装了 WSL 的 Windows 上实测撞到，整场跑不出论文。
 *
 * shellCommand() 那边早就用 $OSTYPE 挡住了 WSL 的 bash，这里缺的是同一道闸。
 */
const PROBE_SRC = "import sys; sys.stdout.write('%d|%s' % (sys.version_info[0], sys.platform))";

export function acceptProbe(out: string): boolean {
  const [major, platform] = out.trim().split("|");
  if (major !== "3") return false;
  // 只有 Windows 上需要挑平台：那儿才有 WSL 和 msys 两种「看着能跑」的假解释器。
  if (process.platform !== "win32") return true;
  return platform === "win32";
}

function probePython(argv: string[]): boolean {
  const r = spawnSync(
    argv[0]!,
    [...argv.slice(1), "-c", PROBE_SRC],
    { encoding: "utf-8", timeout: PROBE_MS },
  );
  return r.status === 0 && acceptProbe(r.stdout || "");
}

/** probePython 的异步版，判据完全一样。 */
async function probePythonAsync(argv: string[]): Promise<boolean> {
  const r = await captureCommand(argv[0]!, [...argv.slice(1), "-c", PROBE_SRC]);
  return r.code === 0 && acceptProbe(r.stdout);
}

/**
 * 受管虚拟环境里的解释器，没建就是 null。
 *
 * base 只给测试注入用：os.homedir() 不看 process.env.HOME，dataDir() 也就没法
 * 靠改环境变量支开。不注入的话，测试结果取决于跑测试这台机器上到底有没有建过
 * venv —— 本机建了就红、没建就绿，这种测试等于没有。
 */
export function venvPython(base: string = dataDir()): string | null {
  const path = process.platform === "win32"
    ? join(base, "venv", "Scripts", "python.exe")
    : join(base, "venv", "bin", "python3");
  return existsSync(path) ? path : null;
}

/**
 * 问 python「这些包在不在」的探测脚本。模块名从 argv 传进去，stdout 回缺的那几个，
 * 逗号分隔；一个都不缺就是空输出。
 *
 * 用 importlib.util.find_spec 而不是真 `import`：find_spec 只走 import 系统的
 * 「查找」那一半，跳过「执行」那一半。同样 9 个包，Windows 上 560 毫秒，真 import
 * 要 13 秒（2026-08-25 实测，差 23 倍），而后者曾经就长在桌面版的启动路径上。
 *
 * 换来的代价要认：find_spec 只知道文件在不在，抓不到「装了但坏了」（典型是 numpy
 * 和 pandas 的 ABI 对不上）。所以装完依赖那一次仍然要真 import 一遍验收，
 * 见 desktop/launcher/main.ts 里 doctor(deep)。
 *
 * 模块名走 argv 不拼进代码，省得名字里有引号之类的东西时把脚本拼坏。
 */
export const FIND_SPEC_PROBE = [
  "import importlib.util as u, sys",
  "miss = []",
  "for m in sys.argv[1:]:",
  "    try:",
  "        if u.find_spec(m) is None: miss.append(m)",
  "    except Exception: miss.append(m)",
  "sys.stdout.write(','.join(miss))",
].join("\n");

/** 解析 FIND_SPEC_PROBE 的 stdout。空输出（含只有空白）就是一个都不缺。 */
export function missingModules(stdout: string): string[] {
  return stdout.split(",").map((name) => name.trim()).filter(Boolean);
}

/** 候选的来源：要么是现成的 argv，要么是「去 PATH 上找这个名字」。 */
type PythonSource = { argv: string[] } | { lookup: string };

/**
 * 候选按什么顺序来。**这里只描述顺序，不做任何探测**，所以同步和异步两条解析路径
 * 能共用同一份，不会哪天改了一处忘了另一处；而顺序恰恰是这个文件里最不能错的东西。
 *
 * lookup 那两条要真去 PATH 上查，在 Windows 上一次 240 到 400 毫秒（2026-08-25
 * 实测 where.exe）。受管 venv 排在它们前面，只要建过就必然胜出，所以走到那里
 * 才付这笔钱，别一上来就把候选全建出来。
 */
function* pythonSources(useVenv: boolean): Generator<PythonSource> {
  const override = (process.env.OMNISCI_PYTHON || "").trim();
  if (override) yield { argv: [override] };

  // 受管的 venv 优先：依赖是装在它里面的，系统 python 不一定有 imageio/matplotlib。
  const venv = useVenv ? venvPython() : null;
  if (venv) yield { argv: [venv] };

  yield { lookup: "python3" };
  yield { lookup: "python" };

  // py 启动器是 Windows 上最可靠的兜底，它知道真 python 装在哪。
  if (process.platform === "win32") yield { argv: ["py", "-3"] };
}

/** 官方下载页。报错里给了地址，用户才不用自己去搜。 */
const PYTHON_DOWNLOAD: Record<string, string> = {
  win32: "https://www.python.org/downloads/windows/（装的时候勾上 Add python.exe to PATH）",
  darwin: "https://www.python.org/downloads/macos/ 或者 brew install python@3.12",
  linux: "用发行版的包管理器，比如 apt install python3 python3-venv",
};

function noPythonError(tried: string[]): Error {
  const where = PYTHON_DOWNLOAD[process.platform] ?? "https://www.python.org/downloads/";
  return new Error(
    "找不到能用的 python 3。试过：" + (tried.join("、") || "（PATH 上一个都没有）")
    + `。去这里装一个：${where}。装好之后重开，或者设 OMNISCI_PYTHON 指到具体的可执行文件。`
    + (process.platform === "win32"
      ? " Windows 上有两种「看着是 python 其实不是」的东西：微软商店的占位符"
        + "（2 字节，跑起来退 49），以及 WSL 的转发器（那是另一个操作系统里的解释器，"
        + "路径和环境变量都跟这边对不上）。两种都会被拒掉，装原生的那个。"
      : ""),
  );
}

function resolvePython(useVenv: boolean): string[] {
  const tried: string[] = [];
  const seen = new Set<string>();
  for (const source of pythonSources(useVenv)) {
    const argvs = "argv" in source ? [source.argv] : whichAll(source.lookup).map((path) => [path]);
    for (const argv of argvs) {
      if (!firstTimeSeen(seen, argv)) continue;
      tried.push(argv.join(" "));
      if (probePython(argv)) return argv;
    }
  }
  throw noPythonError(tried);
}

/** resolvePython 的异步版。顺序、去重、判据、报错文案全部跟同步那份一致。 */
async function resolvePythonAsync(useVenv: boolean): Promise<string[]> {
  const tried: string[] = [];
  const seen = new Set<string>();
  for (const source of pythonSources(useVenv)) {
    const argvs = "argv" in source
      ? [source.argv]
      : (await whichAllAsync(source.lookup)).map((path) => [path]);
    for (const argv of argvs) {
      if (!firstTimeSeen(seen, argv)) continue;
      tried.push(argv.join(" "));
      if (await probePythonAsync(argv)) return argv;
    }
  }
  throw noPythonError(tried);
}

/**
 * 跑 python 用的 argv 前缀，比如 `["/usr/bin/python3"]` 或者 `["py", "-3"]`。
 * 一个能用的都没有就抛，错误里带上试过哪些，不然用户无从下手。
 *
 * **受管 venv 是应用跑起来之后才建的**，而这个缓存在启动体检时就已经填好了。
 * 只算一次的话：用户在界面上点「安装依赖」，bootstrap 把 numpy 装进 venv，
 * 论文工具却继续用启动时那个系统 python，界面报「依赖就绪」，实际 import 不到，
 * 干净机器上第一次装完等于没装。桌面版的 launcher 和 gateway 还是同一个进程，
 * 躲不掉。实测：before=/usr/bin/python3 → 建 venv → after 还是 /usr/bin/python3。
 *
 * 所以选中系统 python 时缓存只算暂定，venv 一出现就重算。重算最多发生一次
 * （venv 不会再变回不存在），不是每次调用都掏钱。
 */
function cachedPython(): string[] | null {
  if (pythonCache && !pythonCacheFinal && venvPython()) pythonCache = null;
  return pythonCache;
}

function rememberPython(argv: string[]): string[] {
  pythonCache = argv;
  const venv = venvPython();
  pythonCacheFinal = Boolean((process.env.OMNISCI_PYTHON || "").trim())
    || (venv !== null && argv[0] === venv);
  return argv;
}

/** 跑 python 用的 argv 前缀，比如 `["/usr/bin/python3"]` 或者 `["py", "-3"]`。 */
export function pythonCommand(): string[] {
  return cachedPython() ?? rememberPython(resolvePython(true));
}

/**
 * pythonCommand() 的异步版：同一套候选、同一份缓存，只是探测不堵事件循环。
 *
 * 桌面版的网关跟 HTTP 服务共用一条事件循环，同步探一次在 Windows 上要 1.3 秒
 * （2026-08-25 实测），那 1.3 秒里所有请求都在排队，正好撞上浏览器加载首屏。
 * CLI 那边是一次性进程，继续用上面那个同步的就行。
 *
 * 谁先算完谁填缓存，另一个直接命中；两边算出来的必然是同一个（配方是同一份）。
 */
export async function pythonCommandAsync(): Promise<string[]> {
  return cachedPython() ?? rememberPython(await resolvePythonAsync(true));
}

/**
 * 该往 agent 子进程的 PATH 前面塞哪个目录，不用塞就是 null。
 *
 * 治的是一个诊断和现实对不上的坑：agent 在 shell 里跑的命令写的是 `python3 xxx.py`，
 * 走 PATH，**完全看不见**我们精挑细选出来的那个解释器。于是启动体检拿受管 venv
 * （或者 OMNISCI_PYTHON）逐个 import，报「依赖就绪」，agent 一跑 `python3` 却落到
 * 系统解释器上，numpy 都没有。诊断说好，实际跑不了，而且报错离原因十万八千里。
 *
 * 把选中那个解释器的目录前置到子进程的 PATH，`python3` 就指向体检时验过的那个。
 * 这正是 venv activate 干的事，区别是只对 agent 的子进程干，不碰用户自己的 shell。
 *
 * 已经指向同一个文件就返回 null：那种情况下前置只是把系统目录往前挪一格，
 * 平白改变别的命令的优先级，没有收益。
 *
 * 缓存挂在解析结果上而不是算一次就焊死：受管 venv 是应用跑起来之后才建的，
 * pythonCommand() 会在 venv 出现后改口，这里得跟着改（跟 cachedPython 同一个道理）。
 */
export function pythonPathPrefix(): string | null {
  let argv: string[];
  try {
    argv = pythonCommand();
  } catch {
    return null; // 一个 python 都没有，PATH 怎么排都救不了
  }
  const key = argv.join("\u0000");
  if (pathPrefixKey === key) return pathPrefixValue;
  pathPrefixKey = key;
  pathPrefixValue = computePathPrefix(argv);
  return pathPrefixValue;
}

/**
 * 把选中的 python 所在目录前置到一份环境变量里，返回新的一份（不改原对象）。
 *
 * 给 agent 会执行的子进程用：shell 工具、论文工具链。用户的 hook 脚本里写 `python3`
 * 也是同一个道理，一并受益。
 *
 * 不去重、不做别的清理：PATH 里出现重复目录只是多查一次，无害；而想在这里做得更聪明
 * 就要解析整条 PATH，跨平台的坑比收益多。
 */
export function withPythonPath(
  env: Record<string, string>,
): Record<string, string> {
  const dir = pythonPathPrefix();
  if (!dir) return env;
  // Windows 上环境变量名不分大小写，实际拿到的键可能是 Path 或 PATH
  const key = Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
  const current = env[key] ?? "";
  return { ...env, [key]: current ? dir + delimiter + current : dir };
}

let pathPrefixKey: string | null = null;
let pathPrefixValue: string | null = null;

function computePathPrefix(argv: string[]): string | null {
  // `py -3` 那种是启动器加参数，没有「那个 python 的目录」可言
  if (argv.length !== 1) return null;
  const exe = argv[0]!;
  const dir = dirname(exe);
  if (!dir || dir === "." || dir === exe) return null;
  // PATH 上排第一的已经是它了，就不用动
  for (const name of ["python3", "python"]) {
    const first = whichAll(name)[0];
    if (first && samePathText(first, exe)) return null;
    if (first) break; // 只看排最前面那个 python，后面的本来就轮不到
  }
  return dir;
}

/** 路径比对。Windows 大小写不敏感，斜杠两种都认。 */
function samePathText(a: string, b: string): boolean {
  const norm = (v: string) => {
    const t = v.trim().replace(/[\\/]+/g, "/");
    return process.platform === "win32" ? t.toLowerCase() : t;
  };
  return norm(a) === norm(b);
}

/**
 * 不走受管 venv 的那份。给"建 venv"用：venv 还不存在的时候得先有个基础解释器，
 * 而它同样不能是商店占位符，否则 `python -m venv` 直接退 49，虚拟环境永远建不出来。
 */
export function basePythonCommand(): string[] {
  if (!basePythonCache) basePythonCache = resolvePython(false);
  return basePythonCache;
}

/** basePythonCommand 的异步版，同样共用缓存。bootstrap 在事件循环上跑，要用这个。 */
export async function basePythonCommandAsync(): Promise<string[]> {
  if (!basePythonCache) basePythonCache = await resolvePythonAsync(false);
  return basePythonCache;
}

// ------------------------------------------------------------------- shell

let shellCache: string | null = null;

/** 让 shell 自报家门。msys/cygwin 是 Windows 原生的，linux-gnu 说明这是 WSL。 */
function probeShellOsType(path: string): string | null {
  const r = spawnSync(path, ["-c", "printf %s \"$OSTYPE\""], {
    encoding: "utf-8",
    timeout: PROBE_MS,
  });
  if (r.status !== 0) return null;
  return (r.stdout || "").trim();
}

function shellCandidates(): string[] {
  const out: string[] = [];
  const override = (process.env.OMNISCI_SHELL || "").trim();
  if (override) out.push(override);

  if (process.platform === "win32") {
    // Git for Windows 自带的 bash：POSIX 语法、Windows 路径、继承宿主环境变量。
    const roots = [
      process.env.ProgramFiles,
      process.env["ProgramFiles(x86)"],
      process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Programs"),
    ].filter((v): v is string => Boolean(v));
    for (const root of roots) {
      for (const rel of [["Git", "bin", "bash.exe"], ["Git", "usr", "bin", "bash.exe"]]) {
        const path = join(root, ...rel);
        if (existsSync(path)) out.push(path);
      }
    }
  }
  out.push(...whichAll("bash"));
  if (!out.length) out.push("bash");
  return [...new Set(out)];
}

/**
 * 跑 shell 命令用的可执行文件。
 *
 * Windows 上只接受原生 bash（msys/cygwin）。只找得到 WSL 那个的话宁可抛，
 * 也不把命令送进另一个操作系统：那边的路径和环境变量跟宿主对不上，
 * 跑出来的东西全是错的，而且错得很隐蔽。
 */
export function shellCommand(): string {
  if (shellCache) return shellCache;
  const wsl: string[] = [];
  for (const path of shellCandidates()) {
    const osType = probeShellOsType(path);
    if (osType === null) continue;
    if (process.platform === "win32" && !/^(msys|cygwin)/.test(osType)) {
      wsl.push(`${path}（$OSTYPE=${osType}）`);
      continue;
    }
    shellCache = path;
    return path;
  }
  if (wsl.length) {
    throw new Error(
      "Windows 上只找到 WSL 的 bash：" + wsl.join("、")
      + "。它跑在另一个操作系统里，看到的是 /mnt/c/… 而不是 C:\\…，也拿不到本进程的环境变量，"
      + "命令会以难以察觉的方式出错。请装 Git for Windows（自带原生 bash），"
      + "或者设 OMNISCI_SHELL 指到一个原生 bash。",
    );
  }
  throw new Error("找不到 bash。装一个之后重开，或者设 OMNISCI_SHELL 指到具体的可执行文件。");
}

/** 只给测试用：清掉本进程的探测缓存。 */
export function resetInterpreterCache(): void {
  pythonCache = null;
  pythonCacheFinal = false;
  basePythonCache = null;
  shellCache = null;
}

/**
 * 把受管的 tectonic 和 venv 挂到 PATH 前面。**每次要用之前都调一遍。**
 *
 * 只在启动时算一次是不够的：安装文档让 agent 把 tectonic 直接放进
 * <dataDir>/bin，那通常发生在应用已经跑起来之后。启动时那个目录还不存在，
 * PATH 就永远没有它，于是 paper_cli 的 shutil.which("tectonic") 查不到，
 * 一轮跑完停在 .tex 不出 PDF —— 而 tectonic 明明就躺在盘上。
 * 实测踩过：应用 19:40 起，tectonic 19:42 装，21:00 跑出来的还是 tex_only。
 *
 * 代价只有两次 existsSync，可以随便调。
 */
/**
 * 用户自己装工具的那几个常规目录。
 *
 * 从 Finder / Launchpad 启动的 macOS 应用拿到的 PATH 只有
 * /usr/bin:/bin:/usr/sbin:/sbin，登录 shell 的 PATH 一点都继承不到。于是
 * brew 装的 poppler、~/.local/bin 里的 tectonic，从终端跑好好的，双击图标
 * 起来就"不存在"，而 doctor 和 shutil.which 都只会说找不到，不会说为什么。
 * 实测踩过两次：tectonic 装在 ~/.local/bin 却报 missing；poppler 装在
 * /opt/homebrew/bin，论文编译完卡在渲染审阅页。
 *
 * 只补公认的用户工具目录，且必须真实存在才加，PATH 顺序仍然是受管的在最前。
 */
export function userToolDirs(): string[] {
  // Windows 上没有这个问题：资源管理器启动的程序照常继承注册表里那份用户 PATH，
  // scoop / choco / winget 装的东西本来就在里面。所以这里不需要补。
  if (process.platform === "win32") return [];
  return [
    join(homedir(), ".local", "bin"),
    "/opt/homebrew/bin",   // Apple silicon 的 brew
    "/usr/local/bin",      // Intel mac 的 brew，以及 Linux 上手装的东西
  ];
}

export function ensureManagedToolsOnPath(
  base: string = dataDir(),
  extraDirs: string[] = userToolDirs(),
): void {
  const wanted = [join(base, "bin")];
  const venv = venvPython(base);
  if (venv) wanted.push(dirname(venv));
  // extraDirs 只给测试注入。它默认是 /opt/homebrew/bin 这类绝对路径，
  // 跑测试那台机器上真实存在，不让测试换掉的话断言测的就不是被测行为了。
  wanted.push(...extraDirs);

  const current = (process.env.PATH || "").split(delimiter).filter(Boolean);
  const missing = wanted.filter((dir) => existsSync(dir) && !current.includes(dir));
  if (!missing.length) return;
  process.env.PATH = [...missing, ...current].join(delimiter);
}
