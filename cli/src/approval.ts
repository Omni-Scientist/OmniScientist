/**
 * 审批门。
 *
 * 原则：会改变外部状态的操作（bash / write_file / edit_file）默认要人点头。
 * 「一直允许」只在本次会话内生效，不落盘，避免哪天忘了自己放行过什么。
 */

export type Decision = "once" | "session" | "deny";

export class ApprovalPolicy {
  private sessionAllowed = new Set<string>();

  constructor(readonly autoApprove = false) {}

  /**
   * 要不要问。
   *
   * key 的粒度由工具自己定：普通工具就是工具名，bash 拆到命令类。
   * 拆细这一步是必须的，之前按工具名放行意味着对某一条 bash 按一次 a，
   * 本会话所有 bash 全部放行，包括后面那条 rm -rf。
   * 一次调用可能带多个 key（`git add && git commit`），有一个没放行过就还要问。
   */
  needsPrompt(keys: string[], toolNeedsApproval: boolean): boolean {
    if (!toolNeedsApproval) return false;
    if (this.autoApprove) return false;
    return keys.some((k) => !this.sessionAllowed.has(k));
  }

  record(keys: string[], decision: Decision): void {
    if (decision === "session") for (const k of keys) this.sessionAllowed.add(k);
  }

  /** 本次会话已经放行的命令类，给 /guard 看。 */
  allowed(): string[] {
    return [...this.sessionAllowed].sort();
  }
}

/** 人否决了这次调用。不是 bug，是正常控制流。 */
export class Denied extends Error {}

/**
 * 终端里问一句。输入不合法就重问，不猜。
 * 没有交互 stdin 时不静默放行，也不甩一个原始异常栈，给一句人话。
 */
/**
 * 外部提问器。挂了常驻 Ink UI 之后必须走它，不能再直接读 stdin。
 *
 * 为什么：Ink 用 readable 事件读 stdin，我们再挂一个 once("data")，
 * 同一次按键两边都会收到。用户在 agent 忙时提前打字（这是我们自己鼓励的用法），
 * 那个按键会同时喂给输入框和审批门，等于在用户不知情的情况下批准了操作。
 */
export type Asker = (promptLine: string, toolName: string, note?: string) => Promise<Decision>;

let externalAsk: Asker | null = null;

export function setAsker(fn: Asker | null): void {
  externalAsk = fn;
}

/**
 * 现在有没有人能应答审批。
 *
 * 没人能应答时，调用方应该把这一步当成"被拒绝"回给模型，让它换个做法，
 * 而不是让 ask() 抛出去把整轮跑崩。一次好奇的 cat 不该毁掉半小时的研究。
 */
export function canAsk(): boolean {
  return Boolean(externalAsk) || Boolean(process.stdin.isTTY);
}

/** note 是 guard 或钩子给的追问理由，比如「这条会覆盖已存在的文件」。 */
export async function ask(promptLine: string, toolName: string, note?: string): Promise<Decision> {
  if (externalAsk) return externalAsk(promptLine, toolName, note);

  if (!process.stdin.isTTY) {
    // 走到这儿说明调用方没先问 canAsk()。不提 --auto-approve：真正会走到
    // 这条路的是守卫强制追问，那种任何模式都不放行，提了只会误导。
    throw new Error(
      `工具 ${toolName} 需要审批，但没人能应答。` +
      (note ? `\n本次要问的原因：${note}` : ""),
    );
  }

  process.stdout.write(`\n  \x1b[33m▸ ${toolName}\x1b[0m  ${promptLine}\n`);
  if (note) process.stdout.write(`    \x1b[2m${note}\x1b[0m\n`);
  for (;;) {
    process.stdout.write("    允许？[y 这次 / a 本次会话一直 / n 拒绝] ");
    const line = await readLine();
    const raw = line.trim().toLowerCase();
    // 空输入**不能**当同意。终端在 raw mode 下一次回车就是一个空 chunk，
    // 用户随手敲的回车会变成一次静默批准。必须显式打 y。
    if (raw === "y" || raw === "yes") return "once";
    if (raw === "a" || raw === "always") return "session";
    if (raw === "n" || raw === "no") return "deny";
    process.stdout.write("    只认 y / a / n\n");
  }
}

function readLine(): Promise<string> {
  return new Promise((resolve) => {
    const onData = (buf: Buffer) => {
      process.stdin.off("data", onData);
      process.stdin.pause();
      resolve(buf.toString("utf-8"));
    };
    process.stdin.resume();
    process.stdin.once("data", onData);
  });
}
