/**
 * read_more：把被截断的工具输出按需续取。
 *
 * 存在的意义是把「一次大输出打满窗口」变成「先看开头，要细节再要」。
 * 完整内容留在 ArtifactStore 里，不进上下文。
 */

import type { Tool, ToolContext } from "./index.ts";

const DEFAULT_CHUNK = 20_000;

function readMore(args: Record<string, unknown>, ctx: ToolContext): string {
  const a = ctx.artifacts.get(String(args.handle));
  const offset = Number(args.offset ?? 0) || 0;
  const limit = Number(args.limit ?? DEFAULT_CHUNK) || DEFAULT_CHUNK;

  if (offset >= a.content.length) {
    return `已经到结尾了。${a.handle} 共 ${a.content.length} 字符，offset ${offset} 越界。`;
  }
  const slice = a.content.slice(offset, offset + limit);
  const end = offset + slice.length;
  const tail =
    end < a.content.length
      ? `\n\n[还有 ${a.content.length - end} 字符，继续取用 offset=${end}]`
      : "\n\n[到此为止，已是全部]";
  return slice + tail;
}

function listArtifacts(_args: Record<string, unknown>, ctx: ToolContext): string {
  const all = ctx.artifacts.list();
  if (!all.length) return "(还没有被截断的输出)";
  return all
    .map((a) => `${a.handle}  ${a.content.length} 字符  来自 ${a.source}`)
    .join("\n");
}

export const ARTIFACT_TOOLS: Tool[] = [
  {
    name: "read_more",
    description:
      "取回被截断的工具输出。工具返回里出现 art_N 这样的句柄时用它继续读，不要重跑那个工具。",
    parameters: {
      type: "object",
      properties: {
        handle: { type: "string", description: "形如 art_1" },
        offset: { type: "integer", description: "从第几个字符开始，默认 0" },
        limit: { type: "integer", description: "最多取多少字符，默认 20000" },
      },
      required: ["handle"],
    },
    run: readMore,
  },
  {
    name: "list_artifacts",
    description: "列出本次会话里所有被截断保存的输出句柄。",
    parameters: { type: "object", properties: {} },
    run: listArtifacts,
  },
];
