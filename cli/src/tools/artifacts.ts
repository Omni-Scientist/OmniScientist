/**
 * read_more：把被截断的工具输出按需续取。
 *
 * 存在的意义是把「一次大输出打满窗口」变成「先看开头，要细节再要」。
 * 完整内容留在 ArtifactStore 里，不进上下文。
 */

import { toolResultBudget } from "../context.ts";
import type { Tool, ToolContext } from "./index.ts";

const DEFAULT_CHUNK = 20_000;

/**
 * 同一个句柄总共最多续取多少。按窗口算，不写死。
 *
 * toolResultBudget 拦得住「一次大输出打满窗口」，拦不住「分二十次把同一份大输出
 * 全搬进来」。2026-08-26 实测：模型对着一个大文件连着 read_more 五次、每次
 * 20000 字符，把 131072 的窗口撑破，触发了强制压缩救援 —— 而那份内容本来就是
 * 因为太大才被存进 artifact 的。
 *
 * 给到单条上限的三倍：翻两三页看清楚一个文件是正当需求，把整份大文件搬回上下文
 * 不是 —— 那种事该用 grep 或者写脚本处理。
 */
function fetchCeiling(): number {
  return toolResultBudget(60_000) * 3;
}

function readMore(args: Record<string, unknown>, ctx: ToolContext): string {
  const a = ctx.artifacts.get(String(args.handle));
  const offset = Number(args.offset ?? 0) || 0;
  const chunkCap = Math.max(2_000, Math.min(toolResultBudget(60_000), DEFAULT_CHUNK));
  const limit = Math.min(Number(args.limit ?? chunkCap) || chunkCap, chunkCap);

  if (offset >= a.content.length) {
    return `已经到结尾了。${a.handle} 共 ${a.content.length} 字符，offset ${offset} 越界。`;
  }

  // 累计到顶就不再给了，并说清楚该改用什么办法 —— 只说「不行」模型只会换个 offset 再来。
  const ceiling = fetchCeiling();
  const already = ctx.artifacts.fetchedSoFar(a.handle);
  if (already >= ceiling) {
    return `${a.handle} 你已经取走 ${already} 字符了，占上下文太多，不再继续给。\n`
      + `这份内容共 ${a.content.length} 字符，整份搬进对话里放不下，也没必要。\n`
      + `改用别的办法从里面拿你要的：用 bash 跑 grep / sed / python 去筛，`
      + `或者写个脚本统计，只把结论带回来。`;
  }

  const slice = a.content.slice(offset, offset + limit);
  ctx.artifacts.noteFetched(a.handle, slice.length);
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
