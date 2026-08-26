/**
 * shell 工具。
 *
 * 工作区之外的破坏由审批门挡，不在这里做花式黑名单（黑名单永远漏，
 * 而且会给人「已经安全了」的错觉）。这里只管：在工作区里跑、有超时、
 * 输出截断、退出码非零如实报告。
 */

import { commandClasses } from "../guard.ts";
import { safeChildEnvironment } from "../credentials.ts";
import { shellCommand, withPythonPath } from "../interpreters.ts";
import type { Tool, ToolContext } from "./index.ts";
import { toolResultBudget } from "../context.ts";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;

/** 洗掉能改写终端显示的字符，并在截断时明确标出来。 */
export function sanitizeForDisplay(s: string, limit = 300): string {
  // eslint-disable-next-line no-control-regex
  const clean = s.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "·");
  return clean.length > limit ? `${clean.slice(0, limit)}…（还有 ${clean.length - limit} 字符）` : clean;
}
// 同 fs.ts：这是大窗口下的上限，实际按当前模型窗口收窄。
const MAX_OUTPUT = 30_000;

async function bash(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const command = String(args.command);
  const timeout = Math.min(
    Number(args.timeout ?? 120) * 1000 || DEFAULT_TIMEOUT_MS,
    MAX_TIMEOUT_MS,
  );

  const proc = Bun.spawn([shellCommand(), "-c", command], {
    cwd: ctx.root,
    env: withPythonPath(safeChildEnvironment()),
    stdout: "pipe",
    stderr: "pipe",
  });

  // 不能只 await 读管道：管道的最后一个持有者是任意后代进程，不是 bash 自己。
  // `sleep 8 &` 之后 bash 早退了，管道还开着，读取会一直挂。
  // 跑个 daemon 就是永久阻塞，而 agent 循环是单线程 await 这个 promise，
  // 整个会话卡死。所以读取必须跟超时 race。
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
    // 先礼后兵，SIGTERM 之后不退就 SIGKILL；直接子进程一起清掉。
    // 孙进程仍可能泄漏（macOS 上没有现成的 setsid），但至少调用会返回，
    // 不会把整个会话钉死。
    try { Bun.spawnSync(["pkill", "-TERM", "-P", String(proc.pid)]); } catch { /* pkill 可能不存在 */ }
    proc.kill("SIGTERM");
    setTimeout(() => { try { proc.kill("SIGKILL"); } catch { /* 已退出 */ } }, 2000);
    return `[超时 ${timeout / 1000} 秒，已终止]\n命令：${command.slice(0, 200)}\n` +
           `如果它是常驻进程（服务、watch、daemon），别用 bash 直接跑，会挂住。`;
  }

  const [stdout, stderr, exitCode] = raced as [string, string, number];

  let body = stdout;
  if (stderr.trim()) body += `${body ? "\n" : ""}[stderr]\n${stderr}`;
  // 超限不再直接砍掉，存成 artifact 留句柄，模型要细节自己 read_more
  body = ctx.artifacts.truncate(`bash: ${command.slice(0, 60)}`, body, toolResultBudget(MAX_OUTPUT));

  if (exitCode !== 0) {
    // 非零退出如实带回给模型，不美化成成功
    return body.trim() ? `[退出码 ${exitCode}]\n${body}` : `[退出码 ${exitCode}]（无输出）`;
  }
  return body.trim() ? body : "(无输出)";
}

export const SHELL_TOOLS: Tool[] = [
  {
    name: "bash",
    description:
      "在工作区目录下执行一条 shell 命令，返回 stdout（stderr 附在后面）。超时默认 120 秒。",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string" },
        timeout: { type: "integer", description: "秒，默认 120" },
      },
      required: ["command"],
    },
    needsApproval: true,
    // 「本次会话一直允许」按命令类记，不按工具名记。
    // 按工具名记的话，对某一条 bash 按一次 a 就等于放行本会话所有 bash。
    // 一条命令里有几段就产出几个 key，`git add . && rm -rf /` 里的 rm 单独算一个，
    // 放行过 `git add` 不会把它带进来。
    approvalKeys: (a) => commandClasses(String(a.command ?? "")),
    // 审批行必须洗掉控制字符：模型可以在 command 里塞 \r 和 ESC[K，
    // 在终端上把真实命令擦掉只留一句人畜无害的，人点的头和跑的东西是两回事。
    summarize: (a) => sanitizeForDisplay(String(a.command ?? "")),
    run: bash,
  },
];
