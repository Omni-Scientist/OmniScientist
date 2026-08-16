/**
 * 工具注册表。
 *
 * 每个工具自己声明 schema、要不要审批、怎么执行。harness 只认这个接口。
 * 工具执行失败一律抛异常，由 loop 决定是把错误回喂给模型还是终止。
 * 绝不在工具内部把错误吞掉换成一句「操作完成」。
 */

import { existsSync, realpathSync } from "node:fs";
import { dirname, resolve as resolvePath, sep } from "node:path";

import { ArtifactStore } from "../artifacts.ts";

export interface ToolContext {
  root: string;
  /**
   * 这一轮研究的「case 目录」，也就是 series.json 和 host/ 所在的地方。
   *
   * 跟 root 分开是因为一个工作区里可以放好几个数据集：root 决定读写边界，
   * caseRoot 决定 gate 去哪儿找 series.json、把 ledger 和论文写到哪儿。
   * 不给就等于 root，跟以前的行为一样。
   */
  caseRoot: string;
  /** 超限输出存这儿，模型用 read_more 按需取，不让一次大输出打满窗口。 */
  artifacts: ArtifactStore;
  /** 把相对路径解析到工作区内，越界直接拒绝。 */
  resolve(rel: string): string;
}

export function makeContext(
  root: string,
  artifacts = new ArtifactStore(),
  caseRoot?: string,
): ToolContext {
  const rootAbs = resolvePath(root);
  return {
    root: rootAbs,
    caseRoot: caseRoot ? resolvePath(rootAbs, caseRoot) : rootAbs,
    artifacts,
    resolve(rel: string): string {
      const p = resolvePath(rootAbs, rel);

      // 只做字符串前缀比较挡不住符号链接：工作区里一个 docs -> ~/.ssh 的链接
      // 就能让 read_file / write_file 读写工作区外的任何东西，而审批行显示的
      // 还是工作区内的相对路径，人看到「写入 docs/x」实际落在 ~/.ssh/x。
      // git 能携带符号链接，node_modules 里更是遍地都是，不需要攻击者构造。
      //
      // 所以必须 realpath 之后再判。目标可能还不存在（write_file 新建），
      // 那就解析它最近的已存在祖先，再把剩下那截拼回去。
      let probe = p;
      while (!existsSync(probe) && probe !== dirname(probe)) probe = dirname(probe);
      const real = realpathSync(probe) + p.slice(probe.length);
      const realRoot = realpathSync(rootAbs);

      if (real !== realRoot && !real.startsWith(realRoot + sep)) {
        throw new Error(`路径越出工作区: ${rel} -> ${real}`);
      }
      return real;
    },
  };
}

/**
 * 工具返回。
 *
 * `followupMessages` 用于真正需要多模态回传的工具。工具协议要求 assistant
 * 的所有 tool result 连续出现，所以 loop 会先追加全部 tool 消息，再追加这些消息。
 */
export type ToolResult = string | {
  text: string;
  meta?: Record<string, unknown>;
  followupMessages?: unknown[];
};

export function normalizeToolResult(r: ToolResult): { text: string; followupMessages: unknown[] } {
  return typeof r === "string"
    ? { text: r, followupMessages: [] }
    : { text: r.text, followupMessages: r.followupMessages ?? [] };
}

export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /**
   * 要不要人点头。
   *
   * 静态 boolean 表达不了「放行 `git status`、拦 `rm -rf`」，所以允许按参数判定。
   * 注意这只是「问不问」，不是「拦不拦」：硬拦截在 guard.ts，不受这里和 --auto-approve 影响。
   */
  needsApproval?: boolean | ((args: Record<string, unknown>) => boolean);
  /**
   * 「本次会话一直允许」的粒度。默认按工具名，
   * 但 bash 必须按命令拆细，否则对某一条 bash 按一次 a，本会话所有 bash 全部放行。
   * 一次调用可以产出多个 key（`git add && git commit` 是两条命令），全部放行过才不再问。
   */
  approvalKeys?: (args: Record<string, unknown>) => string[];
  /** 审批时给人看的一行摘要，比原始 JSON 参数可读 */
  summarize?: (args: Record<string, unknown>) => string;
  run: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult> | ToolResult;
}

/** 静态 boolean 和按参数判定两种写法归一。 */
export function wantsApproval(t: Tool, args: Record<string, unknown>): boolean {
  return typeof t.needsApproval === "function" ? t.needsApproval(args) : Boolean(t.needsApproval);
}

/** 这次调用要放行的所有 key。工具没自己拆就退回工具名。 */
export function approvalKeys(t: Tool, args: Record<string, unknown>): string[] {
  const keys = t.approvalKeys?.(args) ?? [];
  return keys.length ? keys.map((k) => `${t.name}:${k}`) : [t.name];
}

export function toSchema(t: Tool) {
  return {
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  };
}

export class Registry {
  private tools = new Map<string, Tool>();

  add(tool: Tool): void {
    if (this.tools.has(tool.name)) throw new Error(`工具重名: ${tool.name}`);
    this.tools.set(tool.name, tool);
  }

  get(name: string): Tool {
    const t = this.tools.get(name);
    if (!t) {
      throw new Error(
        `模型调用了不存在的工具 ${name}，可用的是: ${[...this.tools.keys()].sort().join(", ")}`,
      );
    }
    return t;
  }

  schemas(): unknown[] {
    return [...this.tools.values()].map(toSchema);
  }

  list(): Tool[] {
    return [...this.tools.values()];
  }
}

export async function defaultRegistry(extra: Tool[] = []): Promise<Registry> {
  const { FS_TOOLS } = await import("./fs.ts");
  const { SHELL_TOOLS } = await import("./shell.ts");
  const { ARTIFACT_TOOLS } = await import("./artifacts.ts");
  const { VISION_TOOLS } = await import("./vision.ts");
  const { OMNISCI_TOOLS } = await import("./omnisci.ts");
  const reg = new Registry();
  for (const t of [
    ...FS_TOOLS,
    ...SHELL_TOOLS,
    ...ARTIFACT_TOOLS,
    ...VISION_TOOLS,
    ...OMNISCI_TOOLS,
    ...extra,
  ]) reg.add(t);
  return reg;
}
