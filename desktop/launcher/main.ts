/**
 * OmniScientist Desktop：一个可执行文件，起本机服务，然后把浏览器拉起来。
 *
 * 不是原生 GUI，也不内嵌 WebView。窗口就是用户自己的浏览器，界面由这个进程从
 * 内嵌的静态资源里提供，后端就是 gateway 那套 AgentLoop。
 *
 * 认证：启动时生成一个随机 token，只在第一条 URL 上出现一次，服务端把它换成
 * HttpOnly cookie 再重定向掉，所以地址栏和前端代码都不留 token。
 *
 * 这个文件是 macOS 打包的契约来源，改动它就是改契约，见
 * 桌面版服务契约第 3 节。
 */
import { createHash, randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { accessSync, appendFileSync, chmodSync, constants as fsConstants, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { cp } from "node:fs/promises";
import { homedir, platform, tmpdir } from "node:os";
import { basename, delimiter, dirname, join, relative, resolve, sep } from "node:path";

import { ASSETS, SKILL_FILES } from "./assets.generated.ts";
import { UpdateDownloader, isInside } from "./update-download.ts";
import {
  autoDecision, missingNames, planFor, planIsEmpty, type Check, type InstallPlan,
} from "./deps-plan.ts";

const VERSION = "0.2.0";
const HOST = "127.0.0.1";
const TECTONIC_VERSION = "0.17.0";

// 缺 python 或 tectonic 不算启动失败：界面上要能引导用户装，所以照常起来。
const EXIT_OK = 0, EXIT_CONFIG = 1, EXIT_PORT = 2;

// ---------------------------------------------------------------- 路径与参数

const OMNI_HOME = join(homedir(), ".omnisci");
const LOG_DIR = join(OMNI_HOME, "logs");
const LOCK_FILE = join(OMNI_HOME, "desktop.lock");

import { harvestEnvAssignments } from "../../cli/src/shell-env.ts";
import {
  basePythonCommandAsync, captureCommand, ensureManagedToolsOnPath, FIND_SPEC_PROBE,
  missingModules, pythonCommandAsync, venvPython,
} from "../../cli/src/interpreters.ts";
// 数据目录必须跟 venvPython() 用的是同一个来源。这里以前自己抄了一份同样逻辑的
// dataDir()，两边碰巧一致所以看不出问题；一旦有了 OMNISCI_DATA_DIR 覆盖，
// bootstrap 会把 venv 建到一个地方，venvPython() 去另一个地方找，谁都不报错。
import { dataDir } from "../../cli/src/paths.ts";

/** 抛出来的东西不一定是 Error，直接模板拼会变成 [object Object]。 */
/** 把工作目录写进 ~/.omnisci/env，下次启动（以及重启）就认它。 */
function persistWorkspaceRoot(target: string): void {
  const file = process.env.OMNISCI_ENV_FILE || join(OMNI_HOME, "env");
  const line = `OMNISCI_WORKSPACE_ROOT=${target}`;
  let body = "";
  try { body = readFileSync(file, "utf-8"); } catch { /* 还没有这个文件 */ }
  const kept = body.split(/\r?\n/).filter((l) => !/^\s*OMNISCI_WORKSPACE_ROOT\s*=/.test(l));
  while (kept.length && !kept[kept.length - 1]!.trim()) kept.pop();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, [...kept, line, ""].join("\n"), { mode: 0o600 });
  log(`工作目录写入 ${file}`);
}

/**
 * 换目录之后原地重启。
 *
 * WORKSPACE_ROOT 在 gateway 里是模块级常量，还在初始化时被会话库捕获，热改要连带
 * 重建一串东西；重启是最不容易出错的做法，而且换工作区本来就该是干净的新开始。
 * 端口和令牌传给子进程，所以浏览器那一页刷新就能接着用。
 */
function restartWith(target: string): void {
  const port = server?.port ?? opts.port;

  // 编译成单文件之后 argv 的形状跟脚本模式不一样：argv[0] 是字符串 "bun"，
  // argv[1] 是虚拟路径 /$bunfs/root/…，两个都没法拿去 spawn。真正的可执行文件
  // 是 process.execPath，用户参数从 argv[2] 开始。踩过一次：照 argv[0] 重启，
  // 子进程根本起不来，端口空着，浏览器那一页直接死掉。
  const passthrough: string[] = [];
  const user = process.argv.slice(2);
  for (let i = 0; i < user.length; i++) {
    const arg = user[i]!;
    if (arg === "--workspace" || arg === "-w" || arg === "--port" || arg === "-p") { i++; continue; }
    if (arg === "--no-open") continue;
    passthrough.push(arg);
  }
  const argv = [...passthrough, "--workspace", target, "--port", String(port), "--no-open"];

  log(`重启到 ${target}，端口 ${port}`);
  try { server?.stop(true); } catch { /* 已经停了 */ }
  const child = spawn(process.execPath, argv, {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, OMNISCI_GATEWAY_TOKEN: TOKEN, OMNISCI_WORKSPACE_ROOT: target },
  });
  child.unref();
  setTimeout(() => process.exit(EXIT_OK), 200);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface Options { workspace: string; port: number; open: boolean; verbose: boolean }

function parseArgs(argv: string[]): Options {
  const opts: Options = {
    workspace: process.env.OMNISCI_WORKSPACE_ROOT || join(homedir(), "OmniScientist"),
    port: Number(process.env.OMNISCI_GATEWAY_PORT || 0),
    open: true,
    verbose: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--workspace" || arg === "-w") opts.workspace = argv[++i] ?? "";
    else if (arg === "--port" || arg === "-p") opts.port = Number(argv[++i]);
    else if (arg === "--no-open") opts.open = false;
    else if (arg === "--verbose" || arg === "-v") opts.verbose = true;
    else if (arg === "--version") { process.stdout.write(`${VERSION}\n`); process.exit(EXIT_OK); }
    else if (arg === "--help" || arg === "-h") { usage(); process.exit(EXIT_OK); }
    else { process.stderr.write(`不认识的参数: ${arg}\n`); usage(); process.exit(EXIT_CONFIG); }
  }
  if (!opts.workspace) { process.stderr.write("--workspace 需要一个目录\n"); process.exit(EXIT_CONFIG); }
  if (!Number.isInteger(opts.port) || opts.port < 0 || opts.port > 65535) {
    process.stderr.write("--port 必须是 0 到 65535 的整数（0 表示自动挑一个空闲端口）\n");
    process.exit(EXIT_CONFIG);
  }
  opts.workspace = resolve(opts.workspace);
  return opts;
}

function usage(): void {
  process.stdout.write(`OmniScientist Desktop ${VERSION}

  omnisci-desktop [选项]

  -w, --workspace <目录>  可读写的工作区，默认 ~/OmniScientist
  -p, --port <端口>       默认 0，自动挑一个空闲端口
      --no-open           不自动打开浏览器，只打印地址
  -v, --verbose           日志同时打到 stderr
      --version           打印版本
  -h, --help              这段

  凭据按这个顺序找，先找到的赢：
    1. 进程自己的环境变量（从终端启动，或 Windows 上 setx 设过的）
    2. ~/.omnisci/env（界面上填的存这儿）
    3. ~/.keys.env、~/.env、~/.zshrc、~/.bashrc、~/.bash_profile、~/.profile
       只从里面捡 *_API_KEY 那几个名字，只认字面值，绝不当 shell 执行。
       双击启动的进程继承不到 shell 环境，这一步就是为了让你不用再填一遍。
  一个都没有也能启动，界面上会给配置入口。
`);
}

// ---------------------------------------------------------------------- 日志

let VERBOSE = false;
/** 落盘后的 skill 目录，主流程里 installSkill() 赋值。 */
let SKILL_DIR = "";

function log(line: string): void {
  const stamp = new Date().toISOString();
  const text = `${stamp} ${line}\n`;
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    appendFileSync(join(LOG_DIR, `desktop-${stamp.slice(0, 10)}.log`), text);
  } catch { /* 日志写不进去也不该拦住启动 */ }
  if (VERBOSE) process.stderr.write(text);
}

// ---------------------------------------------------------------- skill 落盘

/**
 * skill 的 python 被嵌在二进制里，但 Bun 的虚拟文件系统只有本进程读得到：
 * 子进程执行不了，pip 也读不了 requirements.txt。所以第一次运行要真写到磁盘上。
 *
 * 用内容哈希做戳，升级了自动重装，没变就不重复写。
 */
function installSkill(): string {
  const dir = join(dataDir(), "skill", "omnisci");
  const names = Object.keys(SKILL_FILES).sort();
  const hash = createHash("sha256");
  for (const name of names) {
    hash.update(name);
    hash.update(readFileSync(SKILL_FILES[name]!));
  }
  const stamp = hash.digest("hex");
  const stampFile = join(dir, ".installed");

  if (existsSync(stampFile) && readFileSync(stampFile, "utf-8").trim() === stamp) return dir;

  log(`installing skill -> ${dir}`);
  rmSync(dir, { recursive: true, force: true });
  for (const name of names) {
    const target = join(dir, name);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, readFileSync(SKILL_FILES[name]!));
    if (name.endsWith(".py")) chmodSync(target, 0o755);
  }
  writeFileSync(stampFile, stamp);
  log(`installed ${names.length} skill files`);
  return dir;
}

// ------------------------------------------------------------------ 凭据加载

/**
 * 严格按 KEY=VALUE 解析，绝不 source。可选 export 前缀，可选成对引号。
 * 任何一行不合规就整个文件拒绝，免得"看起来读到了"。
 */
function loadEnvFile(path: string): void {
  if (!existsSync(path)) return;
  const lines = readFileSync(path, "utf-8").split(/\r?\n/);
  const parsed: Array<[string, string]> = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
    if (!m) { log(`凭据文件格式错误 ${path}:${i + 1}，整个文件忽略`); return; }
    let value = m[2]!.trim();
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    parsed.push([m[1]!, value]);
  }
  for (const [k, v] of parsed) if (!process.env[k]) process.env[k] = v;
  log(`loaded ${parsed.length} credentials from ${path}`);
}

/**
 * 从用户 shell 配置里认领凭据时，只认这几个名字。
 * 跟 credentials.ts 里读的那几个对齐，多一个 DEEPSEEK_API 是历史别名。
 */
const ADOPTABLE_ENV_NAMES = [
  "DEEPSEEK_API_KEY",
  "DEEPSEEK_API",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "OMNISCI_API_KEY",
] as const;

/**
 * 按顺序扫的文件。越靠前越优先，先拿到就不再被后面的覆盖。
 *
 * 前三个是专门放 key 的文件，最可能是干净的 KEY=VALUE；后面几个是 shell 的 rc，
 * 放在后面是因为那里的 export 更可能是历史遗留或者被注释掉又改回来的。
 */
function credentialSearchPath(): string[] {
  const home = homedir();
  return [
    ".keys.env",
    ".env",
    ".zshrc",
    ".bashrc",
    ".bash_profile",
    ".profile",
  ].map((name) => join(home, name));
}

/**
 * 环境变量里没有的凭据，去用户的 shell 配置里找。
 *
 * 桌面版是双击起来的，**继承不到 shell 的环境变量**：macOS 上 Finder 启动的程序
 * 不走 .zshrc，Windows 上资源管理器启动的程序只认注册表里那份，git-bash 里
 * `export` 的它看不见。结果就是用户在 ~/.keys.env 里明明配好了 OPENAI_API_KEY，
 * 应用还在说"还没配 key"，只能在界面上再填一遍。2026-08-25 被这个问题骂过。
 *
 * 优先级：进程里已有的 > ~/.omnisci/env（界面上填的）> 这里扫出来的。所以这个函数
 * 必须在 loadEnvFile 之后调用，而且只填空缺，绝不覆盖。
 *
 * 解析和安全边界都在 harvestEnvAssignments 里，这里只负责走一遍文件。
 */
function adoptShellCredentials(): void {
  const missing = () => ADOPTABLE_ENV_NAMES.filter((name) => !process.env[name]);
  if (!missing().length) return;

  for (const path of credentialSearchPath()) {
    if (!missing().length) return;
    if (!existsSync(path)) continue;
    let text: string;
    try {
      text = readFileSync(path, "utf-8");
    } catch (error) {
      log(`读不了 ${path}：${errorMessage(error)}`);
      continue;
    }
    const found = harvestEnvAssignments(text, ADOPTABLE_ENV_NAMES);
    const taken: string[] = [];
    for (const [name, value] of Object.entries(found)) {
      if (process.env[name]) continue;
      process.env[name] = value;
      taken.push(name);
    }
    // 只记名字，绝不记值。
    if (taken.length) log(`从 ${path} 认领了 ${taken.join("、")}`);
  }
}

/**
 * 把当前配置写回 ~/.omnisci/env。
 *
 * 只覆盖自己管的那几个键，别人手写进去的东西原样留着——这个文件是用户的，不是
 * 程序的。先写临时文件再 rename，中途断电也不会留下半个文件把 loadEnvFile 卡住
 * （它遇到一行不合规就整个文件拒绝）。
 */
const ENV_HEADER = [
  "# OmniScientist 凭据。桌面版的设置界面会重写这个文件，只有你本人可读。",
  "# 每行 KEY=VALUE，不会被当 shell 执行。手写的其他键会被保留。",
];

/** 以前写过的抬头，去重时一并认出来，免得升级后旧抬头被当成用户注释留下。 */
const LEGACY_ENV_HEADERS = [
  "# OmniScientist 凭据。桌面版的设置界面会重写这个文件，权限 0600。",
];

function saveEnvFile(path: string, pairs: Record<string, string>, managedNames: string[]): void {
  // 管的键要整批覆盖：只按 pairs 里有的算，删掉的键会被当成用户手写的留下来。
  const managed = new Set([...managedNames, ...Object.keys(pairs)]);
  const kept: string[] = [];
  if (existsSync(path)) {
    for (const line of readFileSync(path, "utf-8").split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      // 保留用户自己写的注释，但别把我们上次写的抬头再叠一份进去。
      if (trimmed.startsWith("#")) {
        if (!ENV_HEADER.includes(trimmed) && !LEGACY_ENV_HEADERS.includes(trimmed)) kept.push(line);
        continue;
      }
      const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(trimmed);
      if (!m || managed.has(m[1]!)) continue;
      kept.push(line);
    }
  }
  const body = [
    ...ENV_HEADER,
    ...kept,
    ...Object.entries(pairs).map(([k, v]) => `${k}=${v}`),
    "",
  ].join("\n");

  writeSecret(path, body);
}

/** 0600、先写临时文件再 rename。带秘密的文件都走这里，别各写各的。 */
function writeSecret(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, body, { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, path);
  chmodSync(path, 0o600);
  restrictToOwner(path);
}

/**
 * 让凭据文件只有本人能读。
 *
 * chmod 0600 在 Windows 上是空操作：Node 的 chmod 只能切只读位，表达不了 POSIX
 * 权限，于是文件对本机其他用户是可读的——而抬头还写着"只有你本人可读"。
 * Windows 上改用 icacls 断掉继承、只给当前用户，让那句话成立。
 */
function restrictToOwner(path: string): void {
  if (platform() !== "win32") return;
  const user = process.env.USERNAME;
  if (!user) { log("USERNAME 为空，跳过 ACL 收紧"); return; }
  const done = spawnSync("icacls", [path, "/inheritance:r", "/grant:r", `${user}:F`], {
    stdio: "ignore",
    windowsHide: true,
  });
  // 收紧失败要说出来。默默失败等于让用户以为凭据是受保护的。
  if (done.error || done.status !== 0) {
    log(`ACL 收紧失败（${path}）：凭据文件对本机其他账户可能可读`);
  }
}

/**
 * 拿用户填的 key 真发一次最小请求，确认它能用。
 *
 * 不做这一步的话，填错的 key 要等到第一条消息才炸，而那时候错误混在 agent 的
 * 输出里，没人知道是 key 的问题。宁可在保存前多等两秒。
 */
/** 下载目录。产物只落在这里，reveal 也只认这里。 */
function updateDir(): string {
  return join(dataDir(), "updates");
}

const downloader = new UpdateDownloader(updateDir, log);
/** 最近一次检查报出来的最新版本号。用来判断手上那份下载是不是已经过期。 */
let latestOffered: string | null = null;

/**
 * 在系统文件管理器里选中这个文件。起不来就抛，别假装成功。
 *
 * 要等 spawn / error 事件落定再返回，不能起完就走。ENOENT 是异步来的（缺
 * xdg-open 的 Linux 机器上就是这样），不等的话接口已经回了 revealed: true，
 * 而错误只去了 stderr —— 打包好的桌面版 stderr 哪儿都不去。用户看到的是按钮
 * 点了没反应，日志里一个字都查不到。
 */
async function revealInFileManager(target: string): Promise<void> {
  const argv = platform() === "darwin"
    ? ["open", "-R", target]
    : platform() === "win32"
      ? ["explorer", `/select,${target}`]
      : ["xdg-open", dirname(target)];
  const child = spawn(argv[0]!, argv.slice(1), { stdio: "ignore", detached: true });
  try {
    await new Promise<void>((ok, fail) => {
      child.once("spawn", () => ok());
      child.once("error", fail);
    });
  } finally {
    child.unref();
  }
}

async function probeCredential(
  baseUrl: string, apiKey: string, model: string,
): Promise<{ ok: true } | { ok: false; detail: string }> {
  // 上限别抠。给 1 的话 gpt-5.6-luna 直接 400（"max_tokens or model output limit
  // was reached"）：它光打个招呼就要 12 个 token，推理模型还要先花一批在推理上。
  // 一次 64 token 的成本可以忽略，而抠出来的那点钱换来的是"key 明明是好的却报错"。
  return postProbe(baseUrl, apiKey, model, "hi", 64);
}

/**
 * 一张 64x64 的纯红 PNG，136 字节。视觉探测拿它当靶子。
 *
 * 用真图不用文本的原因：文本请求过了只能证明 key 和模型名对，证明不了这个模型
 * 收不收 image_url。DeepSeek 就是文本能过、给图直接拒的那种，而它恰恰是默认的
 * 研究模型，用户很容易顺手把它选成眼睛。
 */
const PROBE_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAT0lEQVR42u3PQQkAAAgEsKty/csYyQi+hcEKLNO+" +
  "FgEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQGBywJXaSEARj4twAAAAABJRU5ErkJggg==";

/**
 * 拿这套视觉配置真看一张图。返回它说看到了什么，界面原样显示给用户，
 * 让用户自己确认这只眼睛是真睁着的。
 */
async function probeVision(
  baseUrl: string, apiKey: string, model: string,
): Promise<{ ok: true; saw: string } | { ok: false; detail: string }> {
  const content = [
    { type: "text", text: "What is the single dominant colour of this image? Answer with one word." },
    { type: "image_url", image_url: { url: `data:image/png;base64,${PROBE_PNG_B64}` } },
  ];
  // 同样别抠：推理模型会先花掉一批 token 才开口。deepseek-v4-flash-vision-exp
  // 的 max_tokens 连推理链一起算，给 256 时推理话痨一点正文就被挤成空串，
  // 实测同一请求 256 偶发失败、1024 稳定。
  const result = await postProbe(baseUrl, apiKey, model, content, 1024, true);
  if (!result.ok) return result;
  const saw = (result.reply ?? "").trim().replace(/\s+/g, " ").slice(0, 60);
  if (!saw) return { ok: false, detail: `${model} 收下了图但没回任何文字，不能当视觉模型用` };
  return { ok: true, saw };
}

async function postProbe(
  baseUrl: string,
  apiKey: string,
  model: string,
  content: unknown,
  cap: number,
  wantReply = false,
): Promise<{ ok: true; reply?: string } | { ok: false; detail: string }> {
  const url = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        ...tokenCapField(model, cap),
        messages: [{ role: "user", content }],
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (res.ok) {
      if (!wantReply) return { ok: true };
      const body = (await res.json().catch(() => null)) as
        | { choices?: Array<{ message?: { content?: unknown } }> }
        | null;
      const raw = body?.choices?.[0]?.message?.content;
      // 有的端点把正文拆成 [{type:"text",text:"..."}]，两种形状都收。
      const reply = typeof raw === "string"
        ? raw
        : Array.isArray(raw)
          ? raw.map((p) => (typeof p === "object" && p && "text" in p ? String((p as { text: unknown }).text) : "")).join("")
          : "";
      return { ok: true, reply };
    }
    const text = (await res.text()).slice(0, 300);
    if (res.status === 401 || res.status === 403) return { ok: false, detail: "key 被拒绝了（401/403），检查是不是复制错了或者已失效" };
    if (res.status === 402) return { ok: false, detail: "这个 key 余额不足（402）" };
    if (res.status === 404) return { ok: false, detail: `端点或模型不存在（404）：${model}` };
    return { ok: false, detail: `HTTP ${res.status}：${text}` };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, detail: `连不上 ${url}：${detail}` };
  }
}

// ------------------------------------------------------------------ 单实例锁

interface Lock { pid: number; port: number; token: string; started: string }

function readLock(): Lock | null {
  try {
    const lock = JSON.parse(readFileSync(LOCK_FILE, "utf-8")) as Lock;
    if (typeof lock.pid !== "number" || typeof lock.port !== "number" || typeof lock.token !== "string") return null;
    return lock;
  } catch { return null; }
}

/** 锁文件可能是上次崩溃留下的，所以真去问一次 /api/health，不光看 pid。 */
async function liveInstance(): Promise<Lock | null> {
  const lock = readLock();
  if (!lock) return null;
  try {
    const res = await fetch(`http://${HOST}:${lock.port}/api/health`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return null;
    const body = await res.json() as { ok?: boolean };
    return body?.ok ? lock : null;
  } catch { return null; }
}

// ------------------------------------------------------------------ 打开浏览器

function openBrowser(url: string): void {
  const cmd = platform() === "darwin" ? ["open", url]
    : platform() === "win32" ? ["cmd", "/c", "start", "", url]
    : ["xdg-open", url];
  try {
    spawn(cmd[0]!, cmd.slice(1), { detached: true, stdio: "ignore" }).unref();
  } catch (error) {
    log(`打开浏览器失败: ${String(error)}`);
  }
}

// ------------------------------------------------------------ 数据进工作区

/** 人在系统面板里挑文件不该被催，给足时间；超时按取消算。 */
const PICK_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * 对话框的宿主窗口。后台进程弹的窗口抢不到前台，会压在浏览器底下让用户以为
 * 没反应（2026-08-27 实测踩过：三个对话框全开在浏览器后面，任务栏还没图标）。
 * 所以宿主必须真的 Show 出来（不 Show 的窗口 TopMost 不生效），挪到屏幕外用户
 * 看不见，但 TopMost 会带着它拥有的模态对话框一起置顶；任务栏上留一个
 * OmniScientist 入口，点它激活的是对话框（宿主被模态禁用，激活会转给对话框）。
 */
const WIN_OWNER_PS = `Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$owner=New-Object System.Windows.Forms.Form
$owner.Text='OmniScientist'
$owner.TopMost=$true
$owner.ShowInTaskbar=$true
$owner.FormBorderStyle='None'
$owner.StartPosition='Manual'
$owner.Location=New-Object System.Drawing.Point(-32000,-32000)
$owner.Size=New-Object System.Drawing.Size(1,1)
$owner.Show()
$owner.Activate()
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class OmniFront {
  delegate bool EnumThreadDelegate(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool EnumThreadWindows(uint tid, EnumThreadDelegate fn, IntPtr lp);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int hh, uint flags);
  static IntPtr found;
  static IntPtr skip;
  static bool OnWnd(IntPtr h, IntPtr lp) { if (h != skip && IsWindowVisible(h)) { found = h; return false; } return true; }
  // 后台进程的窗口抢不到前台，Windows 只给闪任务栏。把自己挂到当前前台线程的
  // 输入队列上（AttachThreadInput），系统就认为我们有输入权，SetForegroundWindow
  // 才会真的生效；再钉成 TOPMOST，保证对话框开着期间一直看得见。
  public static bool ForceFront(IntPtr owner) {
    found = IntPtr.Zero; skip = owner;
    EnumThreadWindows(GetCurrentThreadId(), OnWnd, IntPtr.Zero);
    if (found == IntPtr.Zero) return false;
    uint pid; uint fg = GetWindowThreadProcessId(GetForegroundWindow(), out pid);
    uint me = GetCurrentThreadId();
    AttachThreadInput(me, fg, true);
    try {
      SetWindowPos(found, new IntPtr(-1), 0, 0, 0, 0, 0x0001 | 0x0002);   // HWND_TOPMOST, NOSIZE|NOMOVE
      SetForegroundWindow(found);
      BringWindowToTop(found);
    } finally { AttachThreadInput(me, fg, false); }
    return true;
  }
}
"@
$state=@{tries=0}
$front=New-Object System.Windows.Forms.Timer
$front.Interval=250
$front.Add_Tick({
  $state.tries++
  if([OmniFront]::ForceFront($owner.Handle) -or $state.tries -gt 40){$front.Stop()}
})
$front.Start()
`;

/** Windows 的文件选择框。 */
const WIN_PICK_FILE_PS = `$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.Encoding]::UTF8
${WIN_OWNER_PS}
$dlg=New-Object System.Windows.Forms.OpenFileDialog
if($dlg.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK){[Console]::Out.Write($dlg.FileName)}
`;

/**
 * Windows 的文件夹选择框。WinForms 那个 FolderBrowserDialog 在 .NET Framework
 * 上还是九十年代的树形控件，所以直接调 shell 的 IFileOpenDialog（就是资源管理
 * 器打开文件那个面板，加 FOS_PICKFOLDERS 变成选文件夹）。
 */
const WIN_PICK_FOLDER_PS = `$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.Encoding]::UTF8
${WIN_OWNER_PS}
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class OmniFolderPick {
  [ComImport, Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")]
  private class FileOpenDialog { }
  [ComImport, Guid("42f85136-db7e-439c-85f1-e4075d135fc8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  private interface IFileOpenDialog {
    [PreserveSig] int Show(IntPtr parent);
    void SetFileTypes(uint cFileTypes, IntPtr rgFilterSpec);
    void SetFileTypeIndex(uint iFileType);
    void GetFileTypeIndex(out uint piFileType);
    void Advise(IntPtr pfde, out uint pdwCookie);
    void Unadvise(uint dwCookie);
    void SetOptions(uint fos);
    void GetOptions(out uint pfos);
    void SetDefaultFolder(IntPtr psi);
    void SetFolder(IntPtr psi);
    void GetFolder(out IntPtr ppsi);
    void GetCurrentSelection(out IntPtr ppsi);
    void SetFileName(string pszName);
    void GetFileName(out string pszName);
    void SetTitle(string pszTitle);
    void SetOkButtonLabel(string pszText);
    void SetFileNameLabel(string pszLabel);
    void GetResult(out IShellItem ppsi);
    void AddPlace(IntPtr psi, int fdap);
    void SetDefaultExtension(string pszDefaultExtension);
    void Close(int hr);
    void SetClientGuid(ref Guid guid);
    void ClearClientData();
    void SetFilter(IntPtr pFilter);
    void GetResults(out IntPtr ppenum);
    void GetSelectedItems(out IntPtr ppsai);
  }
  [ComImport, Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  private interface IShellItem {
    void BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
    void GetParent(out IShellItem ppsi);
    void GetDisplayName(uint sigdnName, out IntPtr ppszName);
    void GetAttributes(uint sfgaoMask, out uint psfgaoAttribs);
    void Compare(IShellItem psi, uint hint, out int piOrder);
  }
  public static string Pick(IntPtr parent) {
    var dlg = (IFileOpenDialog)new FileOpenDialog();
    dlg.SetOptions(0x20 | 0x40);   // FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM
    if (dlg.Show(parent) != 0) return "";
    IShellItem item;
    dlg.GetResult(out item);
    IntPtr ptr;
    item.GetDisplayName(0x80058000, out ptr);   // SIGDN_FILESYSPATH
    var path = Marshal.PtrToStringUni(ptr);
    Marshal.FreeCoTaskMem(ptr);
    return path;
  }
}
"@
$picked=[OmniFolderPick]::Pick($owner.Handle)
if($picked){[Console]::Out.Write($picked)}
`;

/** 正在开着的选择框。同一时刻最多一个：看不见旧框的用户会再点一次，不收掉会越积越多。 */
let activePick: { proc: ReturnType<typeof Bun.spawn>; closed: boolean } | null = null;

/** 收掉当前开着的选择框（被新框顶掉，或用户点了界面上的取消）。 */
function closeActivePick(): void {
  if (!activePick) return;
  activePick.closed = true;
  try { activePick.proc.kill(); } catch { /* 已经退了 */ }
}

/** 跑一个对话框子进程。被顶掉/取消/超时都按用户取消算。 */
async function runPickCommand(
  bin: string,
  args: string[],
): Promise<{ cancelled: boolean; code: number; stdout: string; stderr: string }> {
  closeActivePick();
  const proc = Bun.spawn([bin, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true });
  const mine = { proc, closed: false };
  activePick = mine;
  const timer = setTimeout(() => { mine.closed = true; try { proc.kill(); } catch { /* 已经退了 */ } }, PICK_TIMEOUT_MS);
  try {
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const code = await proc.exited;
    return { cancelled: mine.closed, code, stdout, stderr };
  } finally {
    clearTimeout(timer);
    if (activePick === mine) activePick = null;   // 被顶掉时 activePick 已指向新框，别误清
  }
}

/**
 * 弹系统原生的文件/文件夹选择框，返回选中的绝对路径；用户点取消返回 null。
 *
 * 浏览器不给网页真实路径，但这个进程就跑在用户机器上，让操作系统自己出面板
 * （Finder / 资源管理器），比在网页里画目录树好用得多。不传起始目录：三个平台
 * 的原生面板都自己记住上次的位置，比每次拽回工作区贴心。
 *
 * 平台弹不出来（无 GUI 的 Linux、没装 zenity）就抛错，前端退回目录树。
 */
async function pickNative(kind: "file" | "folder"): Promise<string | null> {
  if (platform() === "darwin") {
    const expr = kind === "folder"
      ? 'choose folder with prompt "选择要导入工作区的文件夹"'
      : 'choose file with prompt "选择要导入工作区的文件"';
    const r = await runPickCommand("osascript", ["-e", "tell me to activate", "-e", `POSIX path of (${expr})`]);
    if (r.cancelled) return null;
    if (r.code === 0 && r.stdout.trim()) return r.stdout.trim().replace(/\/+$/, "");
    if (r.code !== 0 && !/-128/.test(r.stderr)) throw new Error(r.stderr.trim() || "osascript 失败");
    return null;   // -128 就是用户按了取消
  }
  if (platform() === "win32") {
    // 脚本走临时文件而不是 -Command 内联：PowerShell 给原生参数转双引号的规则
    // 是出了名的坑，多行脚本内联必挂。带 BOM 让 5.1 按 UTF-8 读。
    const script = join(tmpdir(), `omnisci-pick-${kind}.ps1`);
    writeFileSync(script, "\ufeff" + (kind === "folder" ? WIN_PICK_FOLDER_PS : WIN_PICK_FILE_PS));
    const r = await runPickCommand("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-STA", "-File", script]);
    if (r.cancelled) return null;
    if (r.code !== 0) throw new Error(r.stderr.trim() || `powershell 退出码 ${r.code}`);
    const picked = r.stdout.trim();
    return picked || null;   // 没输出就是取消
  }
  const zenity = await which("zenity");
  if (!zenity) throw new Error("没有可用的系统选择框");
  const args = kind === "folder" ? ["--file-selection", "--directory"] : ["--file-selection"];
  const r = await runPickCommand(zenity, args);
  if (r.cancelled) return null;
  if (r.code === 0 && r.stdout.trim()) return r.stdout.trim();
  return null;   // zenity 取消退 1
}

/** 在 dir 下找一个不撞名的子名：a、a-2、a-3…（带扩展名的插在扩展名前）。 */
function uniqueChildName(dir: string, wanted: string): string {
  const base = wanted || "data";
  if (!existsSync(join(dir, base))) return base;
  const dot = base.startsWith(".") ? -1 : base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : "";
  for (let i = 2; ; i++) {
    const candidate = `${stem}-${i}${ext}`;
    if (!existsSync(join(dir, candidate))) return candidate;
  }
}

// -------------------------------------------------------------------- 依赖体检

/** 探测类子进程的上限。一个卡住的解释器不该把整个体检拖死。 */
const PROBE_TIMEOUT_MS = 20_000;
/** 真 import 一遍那次的上限。Windows 冷启动实测到过 25 秒，留足余量。 */
const DEEP_PROBE_TIMEOUT_MS = 180_000;

async function which(bin: string): Promise<string | null> {
  const probe = platform() === "win32" ? "where" : "which";
  const r = await captureCommand(probe, [bin], PROBE_TIMEOUT_MS);
  const first = (r.stdout || "").split(/\r?\n/)[0]?.trim();
  return r.code === 0 && first ? first : null;
}

/**
 * 把自己装的东西挂进 PATH，让所有子进程找得到。
 *
 * 不做这一步的后果很隐蔽：bootstrap 把 tectonic 装进应用数据目录，doctor 也报
 * "ok"，但论文编译走的是 paper_cli.py 里的 `shutil.which("tectonic")`，那是子进程
 * 的 PATH。查不到就退回引擎里写死的 ~/.local/bin/tectonic，也不存在，于是 compile
 * 返回 tex_only：只出 .tex 不出 PDF，还不报错。装了却用不上，最难查。
 */
function exposeManagedTools(): void {
  const before = process.env.PATH;
  ensureManagedToolsOnPath();          // 逻辑只有一份，见 cli/src/interpreters.ts
  if (process.env.PATH !== before) log("PATH 前置了受管工具目录");
}

function requirementsPath(): string {
  return join(SKILL_DIR, "requirements.txt");
}

function requiredPackages(): string[] {
  try {
    return readFileSync(requirementsPath(), "utf-8")
      .split(/\r?\n/)
      .map((l) => l.replace(/#.*/, "").trim())
      .filter(Boolean)
      .map((l) => l.split(/[<>=!\[]/)[0]!.trim())
      .map((name) => (name === "scikit-learn" ? "sklearn" : name === "pillow" ? "PIL" : name));
  } catch { return []; }
}

/**
 * 依赖体检。
 *
 * `deep=false`（默认）用 find_spec 查包在不在，快。
 * `deep=true` 真的 import 一遍，能抓到"装了但坏了"（典型是 numpy 和 pandas 的
 * ABI 对不上，find_spec 照样说有），代价是 Windows 13 秒、Mac 1.5 秒。
 *
 * 所以启动和 /api/doctor 一律走快检，深检只在 bootstrap 刚装完那一次跑：那本来
 * 就是个以分钟计的操作，也正是最该确认"真的能用"的时刻。两档都在这个函数里，
 * 是为了让"体检"只有一个定义，别出现两处判断口径不一样。
 */
async function doctor(deep = false): Promise<Record<string, Check>> {
  const checks: Record<string, Check> = {};

  // 走跟论文工具完全同一条解析。之前这里只判可执行文件在不在，
  // 于是在 Windows 上选中微软商店那个 2 字节占位符，体检显示"有 python"，
  // 而真正跑工具时它退 49。体检说好、工具全挂，是最难查的一种。
  let python: string[] | null = null;
  try {
    python = await pythonCommandAsync();
    const v = await captureCommand(python[0]!, [...python.slice(1), "-V"]);
    checks.python = { ok: v.code === 0, detail: `${python.join(" ")} ${(v.stdout || v.stderr || "").trim()}` };
  } catch (error) {
    checks.python = { ok: false, detail: errorMessage(error) };
  }

  const packages = requiredPackages();
  if (!python || !packages.length) {
    checks.packages = { ok: false, detail: python ? "读不到依赖清单" : "没有 python，无法检查" };
  } else if (deep) {
    const probe = await captureCommand(
      python[0]!,
      [...python.slice(1), "-c", packages.map((p) => `import ${p}`).join("; ")],
      DEEP_PROBE_TIMEOUT_MS,
    );
    checks.packages = probe.code === 0
      ? { ok: true, detail: `${packages.length} 个包导入通过` }
      : { ok: false, detail: (probe.stderr || "").trim().split("\n").pop() || "导入失败" };
  } else {
    const probe = await captureCommand(python[0]!, [...python.slice(1), "-c", FIND_SPEC_PROBE, ...packages]);
    const missing = missingModules(probe.stdout);
    // 探测脚本自己没跑成（解释器坏了、被 kill 了）跟"包缺了"是两回事，
    // 分开报，否则用户会被指去装一堆本来就装着的包。
    checks.packages = probe.code !== 0
      ? { ok: false, detail: (probe.stderr || "").trim().split("\n").pop() || "查不了依赖" }
      : missing.length
        ? { ok: false, detail: `缺 ${missing.join("、")}`, items: missing }
        : { ok: true, detail: `${packages.length} 个包齐全` };
  }

  const bundledTectonic = join(dataDir(), "bin", platform() === "win32" ? "tectonic.exe" : "tectonic");
  const tectonic = existsSync(bundledTectonic) ? bundledTectonic : await which("tectonic");
  if (!tectonic) {
    checks.tectonic = { ok: false, detail: "找不到 tectonic，流程会停在 .tex 不出 PDF" };
  } else {
    const v = await captureCommand(tectonic, ["--version"]);
    checks.tectonic = { ok: v.code === 0, detail: `${tectonic} ${(v.stdout || "").trim()}` };
  }
  return checks;
}

/** 体检结果记多久。够短，装完东西不用等太久才认；够长，挡得住轮询。 */
const DOCTOR_TTL_MS = 30_000;
let doctorCache: { at: number; checks: Record<string, Check> } | null = null;
let doctorInflight: Promise<Record<string, Check>> | null = null;

/**
 * 带缓存、且同时进来的请求只探一次的体检。
 *
 * 以前 /api/doctor 每问一次就重跑一整套，而 macOS 的菜单栏宿主是**轮询**这个
 * 接口的（packaging/macos/host/main.swift），等于每隔几秒把网关按住一次。
 */
async function cachedDoctor(): Promise<Record<string, Check>> {
  if (doctorCache && Date.now() - doctorCache.at < DOCTOR_TTL_MS) return doctorCache.checks;
  if (doctorInflight) return doctorInflight;
  doctorInflight = doctor()
    .then((checks) => {
      doctorCache = { at: Date.now(), checks };
      return checks;
    })
    .finally(() => { doctorInflight = null; });
  return doctorInflight;
}

// -------------------------------------------------------------------- 依赖引导

interface Bootstrap {
  running: boolean;
  done: boolean;
  ok: boolean;
  /** 这一趟是启动后自动发起的，还是用户在界面上点的。界面靠它决定说「正在自动补」还是「正在安装」。 */
  auto: boolean;
  /** 这一趟打算补哪几样。界面上要能说清楚在装什么，而不是一个转圈。 */
  plan: InstallPlan;
  log: string[];
}
const bootstrapState: Bootstrap = {
  running: false, done: false, ok: false, auto: false,
  plan: { python: false, tectonic: false }, log: [],
};

function note(line: string): void {
  bootstrapState.log.push(line);
  if (bootstrapState.log.length > 400) bootstrapState.log.shift();
  log(`bootstrap: ${line}`);
}

/** 装依赖单步的上限。pip 要拉 400 多 MB，网慢的时候十几分钟是正常的，别掐早了。 */
const INSTALL_TIMEOUT_MS = 30 * 60_000;

/**
 * 把一条输出流逐行记进引导日志。
 *
 * \r 也当行分隔：进度类输出用 \r 原地刷新，不切开会攒成一条巨行。
 */
async function noteLines(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  const decoder = new TextDecoder();
  let rest = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    rest += decoder.decode(value, { stream: true });
    const lines = rest.split(/\r\n|\r|\n/);
    rest = lines.pop() ?? "";
    for (const line of lines) if (line.trim()) note(line);
  }
  rest += decoder.decode();
  if (rest.trim()) note(rest);
}

/** 超时 kill 后等流自己收尾的宽限。过了这个点就不等 EOF，直接撤 reader。 */
const KILL_GRACE_MS = 5_000;

/**
 * 跑 bootstrap 的一步，把输出边跑边记进引导日志。
 *
 * 这里同样不能用 spawnSync：pip install 以分钟计，以前那几分钟里整个网关一句话
 * 都答不出来，/api/doctor 和 /api/bootstrap 一起超时，界面看着就像死了。
 * 也不能像 captureCommand 那样攒到跑完一次性记：装整套依赖那步在 Windows 上
 * 实测 7 分多钟，界面横幅拿日志末行当心跳，攒着记的话它整段静止，像装挂了。
 */
async function run(bin: string, args: string[]): Promise<boolean> {
  note(`$ ${bin} ${args.join(" ")}`);
  try {
    const proc = Bun.spawn([bin, ...args], {
      stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true,
      // Windows 上 python 接管道时 stdout 走 ANSI 代码页（简中是 GBK），中文
      // 用户名的路径会被下面的 UTF-8 解码搅成一串替换符。对 tar 无害。
      env: { ...process.env, PYTHONIOENCODING: "utf-8" },
    });
    const readers = [proc.stdout.getReader(), proc.stderr.getReader()];
    let timedOut = false;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      note(`这一步超过 ${INSTALL_TIMEOUT_MS / 60_000} 分钟还没结束，中止`);
      try { proc.kill("SIGKILL"); } catch { /* 已经结束了 */ }
      // kill 只打得到直接子进程。孙进程（pip 的构建隔离会嵌套起 python）若还
      // 握着管道写端，流就永远不 EOF，读循环会一直挂着。宽限期后把 reader
      // 撤掉，pending 的 read 以 done 收场，这一步才能真正结束。
      graceTimer = setTimeout(() => {
        for (const reader of readers) reader.cancel().catch(() => { /* 流已经关了 */ });
      }, KILL_GRACE_MS);
    }, INSTALL_TIMEOUT_MS);
    try {
      const reads = readers.map((reader) => noteLines(reader));
      // Promise.all 在第一个 reject 后会抛弃另一个，这里接住免得成 unhandled rejection
      for (const read of reads) read.catch(() => { /* 由 Promise.all 统一报 */ });
      await Promise.all(reads);
      if (timedOut) return false;   // 进程是被掐掉的，不看退出码，也不去等一个可能杀不干净的 exited
      return await proc.exited === 0;
    } catch (error) {
      // 流读挂了不代表进程死了，不补一刀会留下没人读管道的僵尸
      try { proc.kill(); } catch { /* 已经结束了 */ }
      throw error;
    } finally {
      clearTimeout(timer);
      if (graceTimer !== undefined) clearTimeout(graceTimer);
    }
  } catch (error) {
    // Bun.spawn 找不到可执行文件时是抛，不是返回非零码
    note(errorMessage(error));
    return false;
  }
}

/**
 * 这个平台的 tectonic 下载地址，没有现成构建就是 null。
 *
 * Windows 只有 x86_64 的包，而且是 **.zip** 不是 .tar.gz。上游发布的资产名单
 * （tectonic@0.17.0）里 windows 那两条是 -pc-windows-msvc.zip 和 -gnu.zip，
 * 取 msvc 那个：它是官方 CI 的主构建。
 *
 * ARM64 Windows 上游没出包，返回 null，走"请自行安装"那条路。
 */
function tectonicUrl(): { url: string; zip: boolean } | null {
  const arch = process.arch === "arm64" ? "aarch64" : process.arch === "x64" ? "x86_64" : null;
  if (!arch) return null;
  const base = `https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%40${TECTONIC_VERSION}`;
  if (platform() === "win32") {
    if (arch !== "x86_64") return null; // 上游没有 Windows ARM64 的构建
    return { url: `${base}/tectonic-${TECTONIC_VERSION}-x86_64-pc-windows-msvc.zip`, zip: true };
  }
  const target = platform() === "darwin" ? `${arch}-apple-darwin`
    : platform() === "linux" ? `${arch}-unknown-linux-musl`
    : null;
  if (!target) return null;
  return { url: `${base}/tectonic-${TECTONIC_VERSION}-${target}.tar.gz`, zip: false };
}

/** 建 venv 并装 python 依赖。失败返回 false，原因已经记进引导日志。 */
async function installPython(data: string): Promise<boolean> {
  let base: string[];
  try {
    base = await basePythonCommandAsync();
  } catch (error) {
    note(errorMessage(error));
    return false;
  }
  note(`基础解释器 ${base.join(" ")}`);

  const venv = join(data, "venv");
  if (!venvPython()) {
    note(`建虚拟环境 ${venv}`);
    if (!await run(base[0]!, [...base.slice(1), "-m", "venv", venv])) { note("建虚拟环境失败"); return false; }
  }
  const py = venvPython();
  if (!py) { note("虚拟环境建出来了但找不到解释器"); return false; }

  // -u 关掉 python 端的块缓冲，否则管道模式下 pip 的输出还是会攒一批一批出
  if (!await run(py, ["-u", "-m", "pip", "install", "--upgrade", "pip"])) note("升级 pip 失败，继续");
  // pip 见 stdout 不是终端就完全不渲染下载进度，大 wheel 下载那几分钟一行不出，
  // 心跳还是会僵住。25.1 起的 --progress-bar raw 是给非交互场景的限频纯文本
  // 进度；更旧的 pip 不认这个值会整条命令拒跑，所以探过版本才敢带。
  const pipVersion = await captureCommand(py, ["-m", "pip", "--version"], PROBE_TIMEOUT_MS);
  const match = /^pip (\d+)\.(\d+)/.exec(pipVersion.stdout.trim());
  const rawBar = match !== null && (Number(match[1]) > 25 || (Number(match[1]) === 25 && Number(match[2]) >= 1));
  const install = ["-u", "-m", "pip", "install", ...(rawBar ? ["--progress-bar", "raw"] : []), "-r", requirementsPath()];
  if (!await run(py, install)) { note("装 python 依赖失败"); return false; }
  return true;
}

/** 下 tectonic 放进受管的 bin。上游没出这个平台的包时如实说明，不算失败。 */
async function installTectonic(data: string): Promise<boolean> {
  const exe = platform() === "win32" ? "tectonic.exe" : "tectonic";
  const bundled = join(data, "bin", exe);
  if (existsSync(bundled) || await which("tectonic")) return true;

  const target = tectonicUrl();
  if (!target) {
    note(`这个平台（${platform()}/${process.arch}）上游没有现成的 tectonic，需要自己装。`
      + "在那之前，一轮研究会停在 .tex，不出 PDF");
    return false;
  }
  note(`下载 tectonic ${TECTONIC_VERSION}`);
  let bytes: ArrayBuffer;
  try {
    const res = await fetch(target.url);
    if (!res.ok) { note(`下载失败 HTTP ${res.status}`); return false; }
    bytes = await res.arrayBuffer();
  } catch (error) {
    // 断网时 fetch 是抛不是返回非 ok。以前没接住，整个 bootstrap 掉进外层
    // catch，日志里只剩一行「引导异常」，看不出是网络问题。
    note(`下载失败 ${errorMessage(error)}`);
    return false;
  }
  const archive = join(data, target.zip ? "tectonic.zip" : "tectonic.tar.gz");
  writeFileSync(archive, Buffer.from(bytes));
  // Windows 10 1803 起自带 bsdtar，zip 和 tar.gz 都认；-xf 让它自己判类型。
  const ok = await run("tar", ["-xf", archive, "-C", join(data, "bin"), exe]);
  rmSync(archive, { force: true });
  if (!ok) { note("解压 tectonic 失败"); return false; }
  return true;
}

async function bootstrap(): Promise<void> {
  bootstrapState.running = true;
  bootstrapState.done = false;
  bootstrapState.ok = false;
  bootstrapState.log = [];
  try {
    const data = dataDir();
    mkdirSync(join(data, "bin"), { recursive: true });

    // 现查一遍再决定补什么。缓存最长可能是 30 秒前的，而这中间用户完全可能自己
    // 装了 python，按旧结论去建 venv 就是白干一趟。
    const before = await doctor();
    const plan = planFor(before);
    bootstrapState.plan = plan;
    if (planIsEmpty(plan)) { note("依赖齐全，没什么要补的"); bootstrapState.ok = true; return; }
    note(`要补的：${[plan.python ? "python 依赖" : "", plan.tectonic ? "tectonic" : ""].filter(Boolean).join("、")}`);

    if (plan.python && !await installPython(data)) return;
    if (plan.tectonic) await installTectonic(data);

    // 刚装出来的目录启动时还不存在，这里再挂一次，不然要重启才用得上。
    exposeManagedTools();
    // 全场唯一一次深检：真 import 一遍。刚动过 python 环境的时候正是该确认
    // "不只是文件在，而是真的能用"的时刻（numpy 和 pandas 的 ABI 对不上，
    // find_spec 照样说有），而那一趟本来就跑了几分钟，多十几秒无所谓。
    // 只补 tectonic 那种情况没碰过包，深检纯属白等 Windows 上的十几秒，走快检。
    // 结果直接顶进缓存，深检通过意味着快检必然也通过，界面不用再等一次。
    const after = await doctor(plan.python);
    doctorCache = { at: Date.now(), checks: after };
    // tectonic 也要算进来。它缺席时论文流程会停在 .tex 不出 PDF，
    // 而以前这里只看 python 和 packages，界面照样报"依赖就绪"——
    // Windows 上尤其明显：那边根本没走过下载这条路，就绪永远是假的。
    bootstrapState.ok = Boolean(after.python?.ok && after.packages?.ok && after.tectonic?.ok);
    if (bootstrapState.ok) note("依赖就绪");
    else if (after.python?.ok && after.packages?.ok) {
      note("python 依赖就绪；tectonic 还缺，研究能跑完但只出 .tex 不出 PDF");
    } else note("依赖仍不完整，看上面的输出");
  } catch (error) {
    note(`引导异常: ${String(error)}`);
  } finally {
    bootstrapState.running = false;
    bootstrapState.done = true;
  }
}

/** 自动补失败后的冷却。pip 那一趟要拉几百 MB，网不通的机器上不该每次开机重来。 */
const AUTO_RETRY_MS = 6 * 3600_000;

function autoStampPath(): string { return join(dataDir(), "auto-install.json"); }

/** 上次自动补失败的时刻，没失败过是 null。文件读不了或者内容坏了都当没失败过。 */
function lastAutoFailure(): number | null {
  try {
    const raw = JSON.parse(readFileSync(autoStampPath(), "utf-8")) as { failedAt?: unknown };
    return typeof raw.failedAt === "number" ? raw.failedAt : null;
  } catch {
    return null;
  }
}

function stampAutoInstall(ok: boolean): void {
  try {
    if (ok) rmSync(autoStampPath(), { force: true });
    else writeFileSync(autoStampPath(), JSON.stringify({ failedAt: Date.now() }));
  } catch (error) {
    // 记不下来只是下次会多试一遍，不值得让引导失败。
    log(`记录自动补依赖结果失败: ${errorMessage(error)}`);
  }
}

/**
 * 发起一趟依赖引导。同一时刻只跑一趟，重复调用直接忽略。
 *
 * auto=true 是启动后自己发起的，成败要记账，好让下次开机知道要不要冷却；
 * auto=false 是用户在界面上按的，不看冷却也不记账，他按了就是要现在试。
 */
function startBootstrap(auto: boolean): void {
  if (bootstrapState.running) return;
  bootstrapState.auto = auto;
  void bootstrap().then(() => {
    if (auto) stampAutoInstall(bootstrapState.ok);
  });
}

// ------------------------------------------------------------------ 静态资源

function assetResponse(pathname: string): Response | null {
  const key = pathname === "/" ? "/index.html" : pathname;
  const asset = ASSETS[key] ?? ASSETS[`${key}/index.html`];
  if (!asset) return null;
  // 内容哈希在文件名里的可以长缓存，index.html 每次都要新的
  const immutable = /\/assets\/.*-[A-Za-z0-9_-]{8,}\./.test(key);
  return new Response(Bun.file(asset.path), {
    headers: {
      "Content-Type": asset.type,
      "Cache-Control": immutable ? "public, max-age=31536000, immutable" : "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

const DENIED = `<!doctype html><meta charset="utf-8"><title>OmniScientist</title>
<style>body{font:15px/1.6 system-ui;margin:16vh auto;max-width:34rem;padding:0 1.5rem;color:#1c1c1e}
code{background:#f2f2f7;padding:.15em .4em;border-radius:4px}</style>
<h1>需要从启动器打开</h1>
<p>这个页面用一次性令牌授权。请回到启动它的终端或菜单栏，用那里给出的地址打开。</p>
<p>地址长这样：<code>http://127.0.0.1:PORT/?t=...</code></p>`;

// ---------------------------------------------------------------------- 主流程

const opts = parseArgs(process.argv.slice(2));
VERBOSE = opts.verbose;

const running = await liveInstance();
if (running) {
  const url = `http://${HOST}:${running.port}/?t=${running.token}`;
  log(`已有实例在跑 pid=${running.pid} port=${running.port}，只打开它`);
  process.stdout.write(`OmniScientist 已经在运行: ${url}\n`);
  if (opts.open) openBrowser(url);
  process.exit(EXIT_OK);
}

mkdirSync(OMNI_HOME, { recursive: true });
mkdirSync(opts.workspace, { recursive: true });
loadEnvFile(process.env.OMNISCI_ENV_FILE || join(OMNI_HOME, "env"));
// 双击起来的进程继承不到 shell 环境，所以还要去用户的 ~/.keys.env、rc 文件里捡一遍。
// 必须在 loadEnvFile 之后、import gateway 之前：credentials.ts 在模块体里就把
// 环境变量读走并删掉了，晚一步就白捡。
adoptShellCredentials();

SKILL_DIR = installSkill();
process.env.OMNISCI = join(SKILL_DIR, "bin");
process.env.OMNISCI_SKILLS_DIR = dirname(SKILL_DIR);
exposeManagedTools();

// 换工作目录要重启进程。端口和令牌从环境里继承下来，浏览器那一页刷新就能接着用，
// 不然每换一次目录就得重新拿一个带令牌的地址。
const TOKEN = process.env.OMNISCI_GATEWAY_TOKEN || randomBytes(32).toString("hex");
process.env.OMNISCI_WEB_TOKEN = TOKEN;
process.env.OMNISCI_WORKSPACE_ROOT = opts.workspace;

// gateway 的模块体读上面这些环境变量并开数据库，所以必须在设好之后才 import
const { apiFetch, closeSessions, SESSION_COOKIE } = await import("../gateway/server.ts");
// 与 gateway 同一个模块实例：这边保存，那边建会话时就读到了。
const settings = await import("../gateway/model-config.ts");
// 同样得晚于 loadEnvFile：这个模块链上挂着 credentials.ts，它在模块体里就把 key
// 从环境变量读走并删掉，提前 import 会读到一片空。
const { tokenCapField } = await import("../../cli/src/model.ts");
// 同样晚于 loadEnvFile：它要读 OMNISCI_UPDATE_CHECK 这个开关。
const { checkForUpdate, compareVersions, updateCheckDisabled, updateCommand } = await import("../../cli/src/update.ts");
const ENV_FILE = process.env.OMNISCI_ENV_FILE || join(OMNI_HOME, "env");
// 界面上显示用的短路径：绝对路径在自定义 HOME 下能长到三行，纯噪音。
const ENV_FILE_LABEL = ENV_FILE.startsWith(homedir()) ? ENV_FILE.replace(homedir(), "~") : ENV_FILE;

/** GET 和 POST 回同一份形状，界面不用为两条路各写一套解析。 */
function settingsState() {
  return {
    active: settings.activeProvider(),
    ready: settings.isReady(),
    envFile: ENV_FILE_LABEL,
    providers: settings.describeProviders(),
    vision: settings.describeVision(),
    visionReady: settings.currentVisionConfig() !== null,
    updateCheck: settings.updateCheckEnabled(),
  };
}

let server: ReturnType<typeof Bun.serve>;
try {
  server = Bun.serve({
    hostname: HOST,
    port: opts.port,
    idleTimeout: 255,
    async fetch(request) {
      const url = new URL(request.url);

      // 活性探针：不校验，因为单实例检测要靠它，而那时候还没有凭据
      if (url.pathname === "/api/health") {
        return Response.json({ ok: true, version: VERSION, port: server.port, workspace: opts.workspace });
      }

      // 一次性令牌换 HttpOnly cookie，然后把 token 从地址栏里重定向掉
      if (url.pathname === "/" && url.searchParams.get("t")) {
        if (url.searchParams.get("t") !== TOKEN) return new Response(DENIED, { status: 401, headers: { "Content-Type": "text/html; charset=utf-8" } });
        return new Response(null, {
          status: 302,
          headers: {
            Location: "/",
            // Lax 而不是 Strict：桌面壳的开屏页在 tauri:// 起源上，跳到这里属于
            // 跨站导航，Strict 会让浏览器在重定向落到 / 时不带 cookie，用户看到
            // "请从启动器打开"（2026-08-28 实测）。Lax 只对顶层 GET 导航放行，
            // 跨站的 POST/fetch 照样不带，CSRF 面没有实质变化。
            "Set-Cookie": `${SESSION_COOKIE}=${TOKEN}; HttpOnly; SameSite=Lax; Path=/; Max-Age=86400`,
          },
        });
      }

      const cookie = request.headers.get("cookie") || "";
      const authed = cookie.split(";").some((part) => {
        const eq = part.indexOf("=");
        return eq > 0 && part.slice(0, eq).trim() === SESSION_COOKIE && part.slice(eq + 1).trim() === TOKEN;
      });

      if (url.pathname.startsWith("/api/v1/")) return apiFetch(request);

      if (!authed) {
        if (url.pathname.startsWith("/api/")) return Response.json({ error: "Unauthorized" }, { status: 401 });
        return new Response(DENIED, { status: 401, headers: { "Content-Type": "text/html; charset=utf-8" } });
      }

      // 给**人**用的目录浏览器，可以走到盘的任何地方。
      //
      // 这跟模型的文件访问是两回事：模型受 guard 和 ctx.resolve 约束，只能在工作目录里动。
      // 这个接口只列目录名，不返回任何文件内容，而且只有拿着一次性令牌换来的 cookie
      // 才调得动，也就是只有本机上启动这个程序的人。选自己的工作目录不该被拦。
      if (request.method === "GET" && url.pathname === "/api/browse") {
        const asked = url.searchParams.get("path") || "";
        // files=1 时连文件一起列（「从电脑导入」要能选单个文件），默认只列目录，
        // 老的 entries 形状不动，选工作目录那个弹窗不用改。
        const withFiles = url.searchParams.get("files") === "1";
        try {
          const target = asked ? resolve(asked) : homedir();
          const stat = statSync(target);
          if (!stat.isDirectory()) return Response.json({ error: "这不是目录" }, { status: 400 });
          const listed = readdirSync(target, { withFileTypes: true })
            .filter((e) => !e.name.startsWith("."))
            .map((e) => {
              try {
                const dir = e.isDirectory() || statSync(join(target, e.name)).isDirectory();
                return { name: e.name, kind: dir ? "dir" as const : "file" as const };
              } catch { return null; }       // 权限不够的、坏掉的链接，跳过就是
            })
            .filter((e): e is { name: string; kind: "dir" | "file" } => e !== null)
            .filter((e) => withFiles || e.kind === "dir")
            .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "dir" ? -1 : 1))
            .slice(0, 500);
          const up = dirname(target);
          return Response.json({
            path: target,
            parent: up === target ? null : up,
            home: homedir(),
            entries: listed.filter((e) => e.kind === "dir").map((e) => e.name),
            items: withFiles ? listed : undefined,
          });
        } catch (error) {
          return Response.json({ error: errorMessage(error) }, { status: 400 });
        }
      }

      // 「从电脑导入」：把盘上任意文件/文件夹由后端原生复制进工作区。数据不过
      // 浏览器，多大都行。agent 只认工作区内的路径，所以落点固定是工作区。
      if (request.method === "POST" && url.pathname === "/api/import") {
        let body: { path?: unknown };
        try { body = await request.json() as { path?: unknown }; }
        catch { return Response.json({ error: "请求 JSON 无效" }, { status: 400 }); }
        const asked = typeof body.path === "string" ? body.path.trim() : "";
        if (!asked) return Response.json({ error: "没有给路径" }, { status: 400 });
        const workspaceRoot = resolve(opts.workspace);
        let source: string;
        let sourceIsDir: boolean;
        try {
          source = resolve(asked);
          sourceIsDir = statSync(source).isDirectory();
          accessSync(source, fsConstants.R_OK);
        } catch (error) {
          return Response.json({ error: `读不了这个路径：${errorMessage(error)}` }, { status: 400 });
        }
        // 已经在工作区里的不拷第二份，直接回相对路径
        if (isInside(workspaceRoot, source)) {
          return Response.json({ path: relative(workspaceRoot, source).split(sep).join("/"), copied: false });
        }
        // 源包含工作区（或就是工作区）时，复制会把落点也拷进去，没完没了
        if (source === workspaceRoot || isInside(source, workspaceRoot)) {
          return Response.json({ error: "这个文件夹包含工作区本身，不能整个导入" }, { status: 400 });
        }
        const name = uniqueChildName(workspaceRoot, basename(source));
        const target = join(workspaceRoot, name);
        log(`importing ${source} -> ${name}`);
        try {
          await cp(source, target, { recursive: true });
        } catch (error) {
          rmSync(target, { recursive: true, force: true });   // 别留半份
          return Response.json({ error: `复制失败：${errorMessage(error)}` }, { status: 500 });
        }
        log(`imported ${source} -> ${name}`);
        return Response.json({ path: name, copied: true, kind: sourceIsDir ? "dir" : "file" });
      }

      // 弹系统原生选择框拿一个本机路径。前端拿到后再调 /api/import 复制进工作区。
      // 501 表示这台机器弹不出面板（无 GUI 的 Linux 等），前端退回目录树。
      // cancel=1 收掉当前开着的框（挂着的那个 /api/pick 请求会以 cancelled 返回）。
      if (request.method === "POST" && url.pathname === "/api/pick") {
        if (url.searchParams.get("cancel") === "1") {
          closeActivePick();
          return Response.json({ cancelled: true });
        }
        const kind = url.searchParams.get("kind") === "folder" ? ("folder" as const) : ("file" as const);
        log(`pick ${kind}: dialog opened`);
        try {
          const picked = await pickNative(kind);
          log(picked === null ? `pick ${kind}: cancelled` : `pick ${kind}: ${picked}`);
          return picked === null ? Response.json({ cancelled: true }) : Response.json({ path: picked });
        } catch (error) {
          log(`pick ${kind} failed: ${errorMessage(error)}`);
          return Response.json({ error: errorMessage(error) }, { status: 501 });
        }
      }

      if (request.method === "POST" && url.pathname === "/api/workspace") {
        let body: { path?: unknown };
        try { body = await request.json() as { path?: unknown }; }
        catch { return Response.json({ error: "请求 JSON 无效" }, { status: 400 }); }
        const wanted = typeof body.path === "string" ? body.path.trim() : "";
        if (!wanted) return Response.json({ error: "没有给目录" }, { status: 400 });
        let target: string;
        try {
          target = resolve(wanted);
          if (!statSync(target).isDirectory()) throw new Error("这不是目录");
          accessSync(target, fsConstants.R_OK | fsConstants.W_OK);
        } catch (error) {
          return Response.json({ error: `用不了这个目录：${errorMessage(error)}` }, { status: 400 });
        }
        if (resolve(opts.workspace) === target) return Response.json({ changed: false, path: target });

        persistWorkspaceRoot(target);
        // 先回话再重启，否则浏览器拿不到结果，只看到连接断了。
        setTimeout(() => restartWith(target), 150);
        return Response.json({ changed: true, path: target, restarting: true });
      }

      if (request.method === "GET" && url.pathname === "/api/doctor") {
        return Response.json({ checks: await cachedDoctor(), dataDir: dataDir() });
      }
      if (url.pathname === "/api/bootstrap") {
        if (request.method === "POST") {
          startBootstrap(false);
          return Response.json({ started: true }, { status: 202 });
        }
        if (request.method === "GET") return Response.json(bootstrapState);
      }
      if (request.method === "GET" && url.pathname === "/api/update") {
        // 只查、只报，绝不下载或替换任何东西。force=1 是用户手动点的那次，跳过每日节流。
        const forced = url.searchParams.get("force") === "1";
        // 查不成和没新版都是 null。不分开的话，断网时界面会说"已是最新"，
        // 等于拿一次没查成冒充一次查过。
        let failed: string | null = null;
        const info = await checkForUpdate(VERSION, "desktop", {
          force: forced,
          onError: (reason) => { failed = reason; },
        });
        if (info?.newer) latestOffered = info.latest;
        return Response.json({
          current: VERSION,
          disabled: updateCheckDisabled(),
          update: info,
          failed,
          howTo: info ? updateCommand("desktop") : null,
        });
      }
      // 下载新版本到本地并校验，不替换任何东西。
      //
      // 以前这里只给一个 release 页面的链接，用户点过去还要自己在十个产物里
      // 认出哪个是自己平台的。现在直接下对的那个。
      //
      // 校验是必须的，不是加分项：这一步产出的是一个用户接下来要双击运行的
      // 可执行文件，不核对 SHA256SUMS 就等于让他装一个来路没验过的东西。
      // 校验不过就删掉下载物并报错，绝不留在盘上。
      if (url.pathname === "/api/update/download") {
        // 下载在后台跑，进度记在 downloadState 里，前端轮询 GET。做成这样而不是
        // 让 POST 一直挂着，是因为 120 MB 的包要下好几分钟，而用户在这期间关掉
        // 设置面板、刷新页面都很正常，不该因此把下载弄没。
        if (request.method === "GET") {
          // 手上这份下载已经过期（下的是上一版，之后又发新版了）就扔掉。留着的话
          // 界面一直显示旧版本"已下载"，而新版本的下载按钮根本出不来。
          //
          // 判据是"比最新的旧"，不是"跟最新的不一样"。用不等的话，重新打过 tag
          // 让 latest 往回走的那一下，会把一份更新的、已经校验过的下载丢掉。
          const held = downloader.state;
          if (held.state === "done" && latestOffered
              && compareVersions(held.version, latestOffered) < 0) {
            downloader.forget();
          }
          return Response.json(downloader.state);
        }
        if (request.method === "POST") {
          // onError 不能省。省了的话断网和限流都回 null，下面那句就变成
          // "没有可下载的新版本"，把一次没查成说成了一次查过——cli/src/update.ts
          // 上加 onError 就是为了治这个，而这里是最该分清的一条路：用户刚亲手
          // 点了下载。
          let failed: string | null = null;
          const info = await checkForUpdate(VERSION, "desktop", {
            force: true,
            onError: (reason) => { failed = reason; },
          });
          if (failed) {
            return Response.json(
              { errorKey: "检查失败，{0}", errorArgs: [failed], error: `检查失败，${failed}` },
              { status: 502 },
            );
          }
          if (!info?.newer) {
            return Response.json(
              { errorKey: "没有可下载的新版本", error: "没有可下载的新版本" }, { status: 400 });
          }
          // 有新版但这个平台没有对应产物，跟"没有新版"是两回事。混在一起说的话，
          // 用户看到"没有可下载的新版本"，而发布页上明明摆着一个新版本。
          if (!info.asset) {
            return Response.json({
              errorKey: "{0} 没有适配本平台的产物，请到发布页手动获取",
              errorArgs: [info.latest],
              error: `${info.latest} 没有适配本平台的产物，请到发布页手动获取`,
            }, { status: 400 });
          }
          // 这里也要更新。只在 /api/update 里更新的话，两次检查之间发了新版时，
          // downloader 记的是新版本号而 latestOffered 还是旧的，上面那段会在下载
          // 刚完成的第一次轮询就把它 forget 掉：进度条从 99% 直接消失，
          // 那个已经校验过的包留在盘上没人认领。
          latestOffered = info.latest;
          downloader.start(info.asset, info.latest);
          return Response.json(downloader.state, { status: 202 });
        }
      }
      if (request.method === "POST" && url.pathname === "/api/update/cancel") {
        downloader.cancel();
        return Response.json(downloader.state);
      }

      // 在访达/资源管理器里选中刚下载的文件。下载完还要用户自己去翻文件夹
      // 就白下载了。
      if (request.method === "POST" && url.pathname === "/api/update/reveal") {
        const body = await request.json().catch(() => null) as { path?: string } | null;
        const target = typeof body?.path === "string" ? body.path : "";
        // 只允许指向我们自己下载目录里的东西，不做成一个任意路径的打开器
        if (!isInside(updateDir(), target)) {
          return Response.json(
            { errorKey: "路径不在下载目录里", error: "路径不在下载目录里" }, { status: 400 });
        }
        // 跟上一条分开说。最常见的情况是用户自己把下好的包挪走或删了，
        // 这时候告诉他"路径不在下载目录里"是句假话，路径明明就在里面。
        if (!existsSync(target)) {
          return Response.json({
            errorKey: "这个文件已经不在了，可能被移走或删除了",
            error: "这个文件已经不在了，可能被移走或删除了",
          }, { status: 400 });
        }
        // 等它真起来了再回。不等的话，缺 xdg-open 的机器上这里回的是
        // revealed: true，而用户面前什么都没发生。
        try {
          await revealInFileManager(target);
        } catch (error) {
          const detail = errorMessage(error);
          log(`打开文件管理器失败：${detail}`);
          return Response.json({
            errorKey: "打不开文件管理器：{0}", errorArgs: [detail],
            error: `打不开文件管理器：${detail}`,
          }, { status: 500 });
        }
        return Response.json({ revealed: true });
      }

      if (url.pathname === "/api/settings") {
        if (request.method === "GET") {
          // 只回名字和"配没配"，key 本身一个字节都不出这个进程。
          return Response.json(settingsState());
        }
        if (request.method === "POST") {
          // 三个动作各走各的：test 只发请求不落盘，save 只落盘不发请求，
          // use 切换当前在用的那套（validatePatch 会拦下没测过的）。
          let patch: import("../gateway/model-config.ts").SettingsPatch;
          try {
            patch = await request.json();
          } catch {
            return Response.json({ error: "请求体不是 JSON" }, { status: 400 });
          }
          const invalid = settings.validatePatch(patch);
          if (invalid) return Response.json({ error: invalid }, { status: 400 });
          const scope = patch.scope === "vision" ? "vision" : "model";

          if (patch.action === "test") {
            const probe = settings.previewConfig(patch);
            if (!probe) return Response.json({ error: "还凑不齐一次请求，key 和模型都要有" }, { status: 400 });
            // 视觉那条线用真图，因为「key 对」和「这个模型收图」是两回事。
            const result = scope === "vision"
              ? await probeVision(probe.baseUrl, probe.apiKey, probe.model)
              : await probeCredential(probe.baseUrl, probe.apiKey, probe.model);
            if (!result.ok) return Response.json({ error: result.detail }, { status: 400 });
            settings.markTested(scope, probe);
            log(`测试通过：${scope === "vision" ? "视觉" : "研究"} ${patch.provider} ${probe.model}`);
            return Response.json({ ...settingsState(), tested: probe.model });
          }

          settings.applyPatch(patch);
          try {
            saveEnvFile(ENV_FILE, settings.persistablePairs(), settings.MANAGED_ENV_NAMES);
          } catch (error) {
            log(`凭据写盘失败 ${ENV_FILE}: ${String(error)}`);
            return Response.json({ error: `写不进 ${ENV_FILE}：${String(error)}` }, { status: 500 });
          }
          log(
            `设置已更新（${patch.action ?? "save"}）：${scope === "vision" ? "视觉" : "研究"} ${patch.provider}` +
            `${patch.removeKey ? "（已删除 key）" : ""}（key 不记录）`,
          );
          return Response.json({ ...settingsState(), saved: true });
        }
      }

      if (request.method === "POST" && url.pathname === "/api/quit") {
        log("收到退出请求");
        // 必须让这条响应先发出去。microtask 或 queueMicrotask 都会在 Bun 把响应
        // 写进 socket 之前跑完，调用方只会看到连接被掐断，无从判断退出成没成功。
        setTimeout(() => shutdown(EXIT_OK), 150);
        return Response.json({ ok: true });
      }

      const asset = assetResponse(url.pathname);
      if (asset) return asset;
      // 单页应用的前端路由：非资源路径一律回首页
      if (request.method === "GET" && !url.pathname.startsWith("/api/")) {
        return assetResponse("/") ?? new Response("Not found", { status: 404 });
      }
      return new Response("Not found", { status: 404 });
    },
  });
} catch (error) {
  process.stderr.write(`端口 ${opts.port} 起不来: ${String(error)}\n`);
  log(`bind failed: ${String(error)}`);
  process.exit(EXIT_PORT);
}

const URL_WITH_TOKEN = `http://${HOST}:${server.port}/?t=${TOKEN}`;
writeFileSync(
  LOCK_FILE,
  JSON.stringify({ pid: process.pid, port: server.port, token: TOKEN, started: new Date().toISOString() }),
  { mode: 0o600 },
);

log(`started pid=${process.pid} port=${server.port} workspace=${opts.workspace}`);
process.stdout.write(`OmniScientist Desktop ${VERSION}\n  ${URL_WITH_TOKEN}\n  工作区 ${opts.workspace}\n`);

let shuttingDown = false;
function shutdown(code: number): void {
  if (shuttingDown) return;
  shuttingDown = true;
  log("shutting down");
  try { closeSessions(); } catch (error) { log(`closeSessions failed: ${String(error)}`); }
  try { rmSync(LOCK_FILE, { force: true }); } catch { /* 锁文件已经没了也行 */ }
  try { server.stop(true); } catch { /* 服务器已经停了也行 */ }
  process.exit(code);
}

// 信号处理器要在任何耗时的启动工作之前装好。锁文件一写出去，外面（菜单栏宿主、
// 终端里的 Ctrl-C）就认为这个进程已经可以指挥了；那之后到注册之间的每一毫秒，
// 收到的 SIGINT/SIGTERM 都是丢的。
process.on("SIGINT", () => shutdown(EXIT_OK));
process.on("SIGTERM", () => shutdown(EXIT_OK));

if (opts.open) openBrowser(URL_WITH_TOKEN);

/**
 * 启动后报一次依赖状况，缺什么就自己去补。**没有任何人在等这件事。**
 *
 * 以前是 `setTimeout(..., 0)` 里同步跑，那句"挪到下一个 tick 就不欠账"的注释是错的：
 * 一个 tick 是微秒级，而浏览器冷启动要一到三秒，第一批请求正好落在体检中间，
 * 被 spawnSync 按住。Windows 上实测因此白等 13.7 秒。
 *
 * 现在三道保险：体检和安装整个是异步的（captureCommand 走 Bun.spawn），堵不住 HTTP；
 * 往后压一秒，让首屏那几个请求先过去，别跟浏览器抢磁盘和杀毒软件的扫描配额；
 * 补依赖只在体检**之后**才发起，那时端口早 bind 完、浏览器早开了。
 * 这条路上一句同步子进程都不能加，加了就是把启动时间还回去。
 */
setTimeout(() => {
  void cachedDoctor().then(
    (health) => {
      for (const [name, check] of Object.entries(health)) {
        if (!check.ok) process.stdout.write(`  依赖待装 ${name}: ${check.detail}\n`);
        log(`doctor ${name}: ${check.ok ? "ok" : "missing"} ${check.detail}`);
      }
      const decision = autoDecision({
        checks: health,
        disabled: process.env.OMNISCI_AUTO_INSTALL === "0",
        failedAt: lastAutoFailure(),
        now: Date.now(),
        retryAfterMs: AUTO_RETRY_MS,
      });
      log(`auto-install ${decision.run ? "start" : "skip"}: ${decision.reason}`);
      if (!decision.run) {
        // 跳过的原因只在有东西缺的时候说。全齐的时候没人关心。
        if (missingNames(health).length) process.stdout.write(`  ${decision.reason}\n`);
        return;
      }
      process.stdout.write(`  ${decision.reason}，正在后台补，不影响现在用\n`);
      startBootstrap(true);
    },
    (error: unknown) => log(`doctor 失败: ${String(error)}`),
  );
}, 1000);
