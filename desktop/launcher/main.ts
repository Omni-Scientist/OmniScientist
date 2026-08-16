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
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";

import { ASSETS, SKILL_FILES } from "./assets.generated.ts";

const VERSION = "0.1.0";
const HOST = "127.0.0.1";
const TECTONIC_VERSION = "0.17.0";

// 缺 python 或 tectonic 不算启动失败：界面上要能引导用户装，所以照常起来。
const EXIT_OK = 0, EXIT_CONFIG = 1, EXIT_PORT = 2;

// ---------------------------------------------------------------- 路径与参数

const OMNI_HOME = join(homedir(), ".omnisci");
const LOG_DIR = join(OMNI_HOME, "logs");
const LOCK_FILE = join(OMNI_HOME, "desktop.lock");

/** 应用数据目录，按平台惯例。venv 和 tectonic 装在这里，不污染工作区。 */
import {
  basePythonCommand, pythonCommand, venvPython,
} from "../../cli/src/interpreters.ts";

function dataDir(): string {
  if (platform() === "darwin") return join(homedir(), "Library", "Application Support", "OmniScientist");
  if (platform() === "win32") return join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "OmniScientist");
  return join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "omniscientist");
}

/** 抛出来的东西不一定是 Error，直接模板拼会变成 [object Object]。 */
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

  凭据从 ~/.omnisci/env 读，格式是每行 KEY=VALUE，不会被当 shell 执行。
  没有凭据也能启动，界面上会给配置入口。
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
  // 同样别抠：推理模型会先花掉一批 token 才开口。
  const result = await postProbe(baseUrl, apiKey, model, content, 256, true);
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

// -------------------------------------------------------------------- 依赖体检

interface Check { ok: boolean; detail: string }

function which(bin: string): string | null {
  const probe = platform() === "win32" ? "where" : "which";
  const r = spawnSync(probe, [bin], { encoding: "utf-8" });
  const first = (r.stdout || "").split(/\r?\n/)[0]?.trim();
  return r.status === 0 && first ? first : null;
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
  const dirs = [join(dataDir(), "bin")];
  const python = venvPython();
  if (python) dirs.push(dirname(python));
  const existing = (process.env.PATH || "").split(delimiter).filter(Boolean);
  const missing = dirs.filter((dir) => existsSync(dir) && !existing.includes(dir));
  if (!missing.length) return;
  process.env.PATH = [...missing, ...existing].join(delimiter);
  log(`PATH 前置 ${missing.join(delimiter)}`);
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

function doctor(): Record<string, Check> {
  const checks: Record<string, Check> = {};

  // 走跟论文工具完全同一条解析。之前这里只判可执行文件在不在，
  // 于是在 Windows 上选中微软商店那个 2 字节占位符，体检显示"有 python"，
  // 而真正跑工具时它退 49。体检说好、工具全挂，是最难查的一种。
  let python: string[] | null = null;
  try {
    python = pythonCommand();
    const v = spawnSync(python[0]!, [...python.slice(1), "-V"], { encoding: "utf-8" });
    checks.python = { ok: v.status === 0, detail: `${python.join(" ")} ${(v.stdout || v.stderr || "").trim()}` };
  } catch (error) {
    checks.python = { ok: false, detail: errorMessage(error) };
  }

  const packages = requiredPackages();
  if (!python || !packages.length) {
    checks.packages = { ok: false, detail: python ? "读不到依赖清单" : "没有 python，无法检查" };
  } else {
    const probe = spawnSync(python[0]!, [...python.slice(1), "-c", packages.map((p) => `import ${p}`).join("; ")], { encoding: "utf-8" });
    checks.packages = probe.status === 0
      ? { ok: true, detail: `${packages.length} 个包齐全` }
      : { ok: false, detail: (probe.stderr || "").trim().split("\n").pop() || "导入失败" };
  }

  const bundledTectonic = join(dataDir(), "bin", platform() === "win32" ? "tectonic.exe" : "tectonic");
  const tectonic = existsSync(bundledTectonic) ? bundledTectonic : which("tectonic");
  if (!tectonic) {
    checks.tectonic = { ok: false, detail: "找不到 tectonic，流程会停在 .tex 不出 PDF" };
  } else {
    const v = spawnSync(tectonic, ["--version"], { encoding: "utf-8" });
    checks.tectonic = { ok: v.status === 0, detail: `${tectonic} ${(v.stdout || "").trim()}` };
  }
  return checks;
}

// -------------------------------------------------------------------- 依赖引导

interface Bootstrap { running: boolean; done: boolean; ok: boolean; log: string[] }
const bootstrapState: Bootstrap = { running: false, done: false, ok: false, log: [] };

function note(line: string): void {
  bootstrapState.log.push(line);
  if (bootstrapState.log.length > 400) bootstrapState.log.shift();
  log(`bootstrap: ${line}`);
}

function run(bin: string, args: string[]): boolean {
  note(`$ ${bin} ${args.join(" ")}`);
  const r = spawnSync(bin, args, { encoding: "utf-8" });
  for (const line of `${r.stdout || ""}${r.stderr || ""}`.split(/\r?\n/)) if (line.trim()) note(line);
  return r.status === 0;
}

function tectonicUrl(): string | null {
  const arch = process.arch === "arm64" ? "aarch64" : process.arch === "x64" ? "x86_64" : null;
  if (!arch) return null;
  const target = platform() === "darwin" ? `${arch}-apple-darwin`
    : platform() === "linux" ? `${arch}-unknown-linux-musl`
    : null;
  if (!target) return null;
  return `https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%40${TECTONIC_VERSION}`
    + `/tectonic-${TECTONIC_VERSION}-${target}.tar.gz`;
}

async function bootstrap(): Promise<void> {
  bootstrapState.running = true;
  bootstrapState.done = false;
  bootstrapState.ok = false;
  bootstrapState.log = [];
  try {
    const data = dataDir();
    mkdirSync(join(data, "bin"), { recursive: true });

    let base: string[];
    try {
      base = basePythonCommand();
    } catch (error) {
      note(errorMessage(error));
      return;
    }
    note(`基础解释器 ${base.join(" ")}`);

    const venv = join(data, "venv");
    if (!venvPython()) {
      note(`建虚拟环境 ${venv}`);
      if (!run(base[0]!, [...base.slice(1), "-m", "venv", venv])) { note("建虚拟环境失败"); return; }
    }
    const py = venvPython();
    if (!py) { note("虚拟环境建出来了但找不到解释器"); return; }

    if (!run(py, ["-m", "pip", "install", "--upgrade", "pip"])) note("升级 pip 失败，继续");
    if (!run(py, ["-m", "pip", "install", "-r", requirementsPath()])) { note("装 python 依赖失败"); return; }

    const bundled = join(data, "bin", platform() === "win32" ? "tectonic.exe" : "tectonic");
    if (!existsSync(bundled) && !which("tectonic")) {
      const url = tectonicUrl();
      if (!url) {
        note(`这个平台（${platform()}/${process.arch}）没有现成的 tectonic，请自行安装`);
      } else {
        note(`下载 tectonic ${TECTONIC_VERSION}`);
        const res = await fetch(url);
        if (!res.ok) { note(`下载失败 HTTP ${res.status}`); return; }
        const tgz = join(data, "tectonic.tar.gz");
        writeFileSync(tgz, Buffer.from(await res.arrayBuffer()));
        const ok = run("tar", ["-xzf", tgz, "-C", join(data, "bin"), "tectonic"]);
        rmSync(tgz, { force: true });
        if (!ok) { note("解压 tectonic 失败"); return; }
      }
    }

    // 刚装出来的目录启动时还不存在，这里再挂一次，不然要重启才用得上。
    exposeManagedTools();
    const after = doctor();
    bootstrapState.ok = Boolean(after.python?.ok && after.packages?.ok);
    note(bootstrapState.ok ? "依赖就绪" : "依赖仍不完整，看上面的输出");
  } catch (error) {
    note(`引导异常: ${String(error)}`);
  } finally {
    bootstrapState.running = false;
    bootstrapState.done = true;
  }
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

SKILL_DIR = installSkill();
process.env.OMNISCI = join(SKILL_DIR, "bin");
process.env.OMNISCI_SKILLS_DIR = dirname(SKILL_DIR);
exposeManagedTools();

const TOKEN = randomBytes(32).toString("hex");
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
const { checkForUpdate, updateCheckDisabled, updateCommand } = await import("../../cli/src/update.ts");
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
            "Set-Cookie": `${SESSION_COOKIE}=${TOKEN}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400`,
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

      if (request.method === "GET" && url.pathname === "/api/doctor") {
        return Response.json({ checks: doctor(), dataDir: dataDir() });
      }
      if (url.pathname === "/api/bootstrap") {
        if (request.method === "POST") {
          if (!bootstrapState.running) void bootstrap();
          return Response.json({ started: true }, { status: 202 });
        }
        if (request.method === "GET") return Response.json(bootstrapState);
      }
      if (request.method === "GET" && url.pathname === "/api/update") {
        // 只查、只报，绝不下载或替换任何东西。force=1 是用户手动点的那次，跳过每日节流。
        const forced = url.searchParams.get("force") === "1";
        const info = await checkForUpdate(VERSION, "desktop", { force: forced });
        return Response.json({
          current: VERSION,
          disabled: updateCheckDisabled(),
          update: info,
          howTo: info ? updateCommand("desktop") : null,
        });
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

// 依赖体检要跑三次 spawnSync，其中 import numpy 那次能到几秒，同步跑会把事件循环
// 连同信号一起堵住。挪到下一个 tick，启动路径上不欠这笔账。
setTimeout(() => {
  const health = doctor();
  for (const [name, check] of Object.entries(health)) {
    if (!check.ok) process.stdout.write(`  依赖待装 ${name}: ${check.detail}\n`);
    log(`doctor ${name}: ${check.ok ? "ok" : "missing"} ${check.detail}`);
  }
}, 0);
