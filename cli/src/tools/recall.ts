/**
 * recall：跨会话回忆。
 *
 * 让 agent 自己能查「以前是不是聊过这个」「这条规矩当时为什么定的」。
 * 走 FTS5，中文逐字切开匹配，细节见 search.ts。
 */

import type { SearchIndex } from "../search.ts";
import type { Tool } from "./index.ts";

export function makeRecallTool(index: () => SearchIndex): Tool {
  return {
    name: "recall",
    description:
      "在历史会话和规矩库里检索。用来回忆以前讨论过什么、某条规矩的来龙去脉。" +
      "查不到就是没聊过，不要据此编造。",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "关键词，中英文都行" },
        kind: { type: "string", description: "限定范围：session 或 standard，不填就全查" },
        limit: { type: "integer", description: "最多几条，默认 8" },
      },
      required: ["query"],
    },
    summarize: (a) => String(a.query ?? ""),
    run: (args) => {
      const hits = index().search(
        String(args.query),
        Number(args.limit ?? 8) || 8,
        args.kind ? String(args.kind) : undefined,
      );
      if (!hits.length) return `没有检索到「${args.query}」相关的历史记录。`;
      return hits
        .map((h) => `[${h.kind}] ${h.title}\n  ${h.snippet.replace(/\s+/g, " ")}`)
        .join("\n\n");
    },
  };
}
