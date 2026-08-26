/**
 * PreToolUse 钩子。外部可执行脚本，工具跑之前过一遍。
 *
 * 配置格式照抄 Claude Code 的 settings.json，现成的钩子可以直接搬过来，
 * 不用为这个 harness 重写一份。
 *
 *   ~/.omnisci/settings.json
 *   {
 *     "hooks": {
 *       "PreToolUse": [
 *         { "matcher": "bash", "hooks": [{ "type": "command", "command": "~/.claude/hooks/block_latex.sh" }] }
 *       ]
 *     }
 *   }
 *
 * 退出码语义**两套都认**，这一条很关键：
 *
 *   - `exit 2`：硬拒，stderr 当理由回喂给模型。这是 GUARD.md 里写的那套。
 *   - `exit 0` + stdout 里一段 JSON（`hookSpecificOutput.permissionDecision`）：也认。
 *     实际用的钩子多半走的是这套，原因值得记一下：
 *     Claude Code 在 exit 2 时会丢掉 stdout 只读 stderr，理由传不到模型，
 *     模型拿不到理由就会去找绕路方案。
 *     只认 exit 2 的话，他那个脚本搬过来会 exit 0 被当成放行，钩子静默失效。
 *   - 其他非零：当警告，放行但把 stderr 报出来。
 *   - 超时：当硬拒。这是安全闸，卡住的时候放行比拒绝危险。
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve as resolvePath } from "node:path";

import { expandHome, type GuardDecision } from "./guard.ts";
import { safeChildEnvironment } from "./credentials.ts";
import { shellCommand, withPythonPath } from "./interpreters.ts";

export const DEFAULT_SETTINGS_FILE = resolvePath(homedir(), ".omnisci/settings.json");

const DEFAULT_TIMEOUT_MS = 10_000;

export interface HookCommand {
  type?: "command";
  command: string;
  /** 秒 */
  timeout?: number;
}

export interface HookMatcher {
  /** 工具名正则，不分大小写。不写就是全部工具。 */
  matcher?: string;
  hooks: HookCommand[];
}

export interface HookResult extends GuardDecision {
  /** 非零但不是 2 的退出码，放行但要让人看见 */
  warning?: string;
}

/**
 * 读钩子配置。文件坏了直接抛：一个配错的安全钩子和没有钩子，
 * 危险程度不一样的地方在于前者会让人以为自己有防护。
 */
export function loadHooks(file = DEFAULT_SETTINGS_FILE): HookMatcher[] {
  if (!existsSync(file)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf-8"));
  } catch (e) {
    throw new Error(`钩子配置 ${file} 不是合法 JSON：${e instanceof Error ? e.message : e}`);
  }
  const hooks = (parsed as { hooks?: { PreToolUse?: HookMatcher[] } }).hooks?.PreToolUse ?? [];
  for (const m of hooks) {
    if (!Array.isArray(m.hooks)) throw new Error(`钩子配置 ${file}：PreToolUse 条目缺 hooks 数组`);
    for (const h of m.hooks) {
      if (!h.command) throw new Error(`钩子配置 ${file}：有个 hook 缺 command`);
    }
    if (m.matcher) new RegExp(m.matcher); // 正则写错当场炸，别等危险命令来了才发现
  }
  return hooks;
}

export function matchingHooks(hooks: HookMatcher[], toolName: string): HookCommand[] {
  const out: HookCommand[] = [];
  for (const m of hooks) {
    // 不分大小写：Claude Code 里写的是 "Bash"，我们的工具名是 "bash"
    if (m.matcher && !new RegExp(m.matcher, "i").test(toolName)) continue;
    out.push(...m.hooks);
  }
  return out;
}

/** 从 stdout 里那段 JSON 抠决定。抠不出来就返回 null，交给退出码判。 */
function decisionFromStdout(stdout: string): GuardDecision | null {
  const text = stdout.trim();
  if (!text.startsWith("{")) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null; // 钩子打印了别的东西，不是决定，按退出码走
  }
  const o = parsed as {
    hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
    decision?: string;
    reason?: string;
  };
  const d = o.hookSpecificOutput?.permissionDecision ?? o.decision;
  const reason = o.hookSpecificOutput?.permissionDecisionReason ?? o.reason;
  if (d === "deny" || d === "block") return { verdict: "deny", reason: reason ?? "钩子拒绝了这次调用" };
  if (d === "ask") return { verdict: "ask", reason: reason ?? "钩子要求人工确认" };
  if (d === "allow") return { verdict: "allow", reason };
  return null;
}

export interface HookPayload {
  tool_name: string;
  tool_input: Record<string, unknown>;
  cwd: string;
  session_id?: string;
}

/** 跑一个钩子。 */
export async function runHook(hook: HookCommand, payload: HookPayload): Promise<HookResult> {
  const timeout = (hook.timeout ?? DEFAULT_TIMEOUT_MS / 1000) * 1000;
  const cmd = expandHome(hook.command);

  const proc = Bun.spawn([shellCommand(), "-c", cmd], {
    cwd: payload.cwd,
    env: withPythonPath(safeChildEnvironment()),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  proc.stdin.write(JSON.stringify({ hook_event_name: "PreToolUse", ...payload }));
  await proc.stdin.end();

  let timedOut = false;
  const collect = Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const raced = await Promise.race([
    collect,
    new Promise<null>((res) => setTimeout(() => { timedOut = true; res(null); }, timeout)),
  ]);

  if (timedOut) {
    try { proc.kill("SIGKILL"); } catch { /* 已退出 */ }
    // 安全闸卡住的时候放行比拒绝危险，所以 fail closed
    return {
      verdict: "deny",
      rule: "hook-timeout",
      reason: `PreToolUse 钩子 ${hook.command} 超过 ${timeout / 1000} 秒没返回，按拒绝处理。修好钩子或者把它从配置里去掉。`,
    };
  }

  const [stdout, stderr, code] = raced as [string, string, number];

  const fromJson = decisionFromStdout(stdout);
  if (fromJson && fromJson.verdict !== "allow") {
    return { ...fromJson, rule: `hook:${hook.command}` };
  }

  if (code === 2) {
    return {
      verdict: "deny",
      rule: `hook:${hook.command}`,
      reason: stderr.trim() || stdout.trim() || `钩子 ${hook.command} 以 exit 2 拒绝了这次调用（没给理由）`,
    };
  }

  if (code !== 0) {
    return {
      verdict: "allow",
      rule: `hook:${hook.command}`,
      warning: `PreToolUse 钩子 ${hook.command} 退出码 ${code}（当警告，已放行）：${stderr.trim().slice(0, 300)}`,
    };
  }

  return fromJson ? { ...fromJson, rule: `hook:${hook.command}` } : { verdict: "allow" };
}

/**
 * 依次跑所有匹配的钩子，取最严的结果。
 * deny 立刻短路，后面的不用跑了。
 */
export async function runPreToolUse(
  hooks: HookMatcher[],
  payload: HookPayload,
): Promise<HookResult> {
  const matched = matchingHooks(hooks, payload.tool_name);
  const warnings: string[] = [];
  let strongest: HookResult = { verdict: "allow" };

  for (const h of matched) {
    const r = await runHook(h, payload);
    if (r.warning) warnings.push(r.warning);
    if (r.verdict === "deny") return { ...r, warning: warnings.join("\n") || undefined };
    if (r.verdict === "ask" && strongest.verdict === "allow") strongest = r;
    // 钩子说 allow 只是「钩子不反对」，不能反过来推翻硬拦截表。
    // 硬拦截在 guard.ts 里，跑在钩子之前，钩子够不着。
    if (r.verdict === "allow" && r.reason && strongest.verdict === "allow") strongest = r;
  }
  return { ...strongest, warning: warnings.join("\n") || undefined };
}
