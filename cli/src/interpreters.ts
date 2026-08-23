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

function dedupe(items: string[][]): string[][] {
  const seen = new Set<string>();
  return items.filter((argv) => {
    const key = argv.join("\u0000");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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
 * 候选自己说出 major 版本和 sys.executable 才算通过。
 * 商店占位符没有输出、退出码非零，这里自然出局。
 */
function probePython(argv: string[]): boolean {
  const r = spawnSync(
    argv[0]!,
    [...argv.slice(1), "-c", "import sys; sys.stdout.write('%d' % sys.version_info[0])"],
    { encoding: "utf-8", timeout: PROBE_MS },
  );
  return r.status === 0 && (r.stdout || "").trim() === "3";
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

function pythonCandidates(useVenv: boolean): string[][] {
  const out: string[][] = [];
  const override = (process.env.OMNISCI_PYTHON || "").trim();
  if (override) out.push([override]);

  // 受管的 venv 优先：依赖是装在它里面的，系统 python 不一定有 imageio/matplotlib。
  const venv = useVenv ? venvPython() : null;
  if (venv) out.push([venv]);

  for (const name of ["python3", "python"]) {
    for (const path of whichAll(name)) out.push([path]);
  }
  // py 启动器是 Windows 上最可靠的兜底，它知道真 python 装在哪。
  if (process.platform === "win32") out.push(["py", "-3"]);
  return dedupe(out);
}

function resolvePython(useVenv: boolean): string[] {
  const tried: string[] = [];
  for (const argv of pythonCandidates(useVenv)) {
    tried.push(argv.join(" "));
    if (probePython(argv)) return argv;
  }
  throw new Error(
    "找不到能用的 python 3。试过：" + (tried.join("、") || "（PATH 上一个都没有）")
    + "。装好 python 3 之后重开，或者设 OMNISCI_PYTHON 指到具体的可执行文件。"
    + (process.platform === "win32"
      ? " 注意 Windows 上的 python3 常常是微软商店的占位符（2 字节，跑起来退 49），那个不是 python。"
      : ""),
  );
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
export function pythonCommand(): string[] {
  if (pythonCache && !pythonCacheFinal && venvPython()) pythonCache = null;
  if (!pythonCache) {
    pythonCache = resolvePython(true);
    const venv = venvPython();
    pythonCacheFinal = Boolean((process.env.OMNISCI_PYTHON || "").trim())
      || (venv !== null && pythonCache[0] === venv);
  }
  return pythonCache;
}

/**
 * 不走受管 venv 的那份。给"建 venv"用：venv 还不存在的时候得先有个基础解释器，
 * 而它同样不能是商店占位符，否则 `python -m venv` 直接退 49，虚拟环境永远建不出来。
 */
export function basePythonCommand(): string[] {
  if (!basePythonCache) basePythonCache = resolvePython(false);
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
