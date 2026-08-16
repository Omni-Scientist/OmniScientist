/**
 * 检索：跨会话回忆 + 标准库查询。
 *
 * 用 bun:sqlite 自带的 FTS5，零依赖，不做 embedding。
 * 这个规模下 embedding 要跑模型、存向量、管更新，投入产出不划算，
 * 等 FTS5 明显不够用再说。
 *
 * 中文分词的坑（实测）：
 *   trigram 分词器要求查询至少 3 个字符，「缓存」这种两字词直接查不到，废。
 *   unicode61 对连写的中文当成一个大 token，也查不到。
 * 解法：入库和查询都把中文**逐字切开**，再交给 unicode61，用短语查询保证顺序。
 * 「缓存」变成 "缓 存"，作为相邻两个 token 匹配。实测中英文全部命中。
 */

import type { Database } from "bun:sqlite";

const SCHEMA = `
CREATE VIRTUAL TABLE IF NOT EXISTS search USING fts5(
    kind,        -- session | standard
    ref,         -- 会话 id 或标准名
    title,
    body,
    seg,         -- 中文逐字切开后的副本，真正被匹配的是这一列
    tokenize="unicode61"
);
CREATE TABLE IF NOT EXISTS search_state (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
`;

/** 中文逐字切开，英文数字保持整词。入库和查询必须用同一个函数。 */
export function segment(s: string): string {
  return s.replace(/[㐀-䶿一-鿿]/g, (c) => ` ${c} `).replace(/\s+/g, " ").trim();
}

export interface Hit {
  kind: string;
  ref: string;
  title: string;
  snippet: string;
}

export class SearchIndex {
  constructor(private db: Database) {
    this.db.run(SCHEMA);
  }

  private lastIndexed(): number {
    const row = this.db.query("SELECT value FROM search_state WHERE key = 'last_message_id'")
      .get() as { value: string } | null;
    return row ? Number(row.value) : 0;
  }

  private setLastIndexed(id: number): void {
    this.db.run(
      "INSERT INTO search_state (key, value) VALUES ('last_message_id', ?) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      [String(id)],
    );
  }

  /**
   * 增量把新消息灌进索引。只处理上次之后的，不重建。
   * 返回这次新增了几条。
   */
  indexNewMessages(): number {
    const from = this.lastIndexed();
    const rows = this.db
      .query("SELECT id, session_id, turn, role, payload FROM messages WHERE id > ? ORDER BY id")
      .all(from) as Array<{ id: number; session_id: string; turn: number; role: string; payload: string }>;

    let n = 0;
    let maxId = from;
    for (const r of rows) {
      maxId = Math.max(maxId, r.id);
      const msg = JSON.parse(r.payload) as Record<string, unknown>;
      const content = typeof msg.content === "string" ? msg.content : "";
      // 只索引有实质内容的用户和助手消息。工具原始输出量大噪声高，
      // 要细节有 /trace，不往索引里塞。
      if (!content.trim() || (r.role !== "user" && r.role !== "assistant")) continue;
      this.db.run(
        "INSERT INTO search (kind, ref, title, body, seg) VALUES ('session', ?, ?, ?, ?)",
        [r.session_id, `${r.session_id} 第${r.turn}轮 ${r.role}`, content, segment(content)],
      );
      n++;
    }
    this.setLastIndexed(maxId);
    return n;
  }

  /** 标准库每次全量重建，条数少，增量不值当。 */
  indexStandards(items: Array<{ name: string; description: string; body: string }>): number {
    this.db.run("DELETE FROM search WHERE kind = 'standard'");
    for (const s of items) {
      const body = `${s.description}\n${s.body}`;
      this.db.run(
        "INSERT INTO search (kind, ref, title, body, seg) VALUES ('standard', ?, ?, ?, ?)",
        [s.name, s.name, body, segment(body)],
      );
    }
    return items.length;
  }

  search(query: string, limit = 8, kind?: string): Hit[] {
    // 引号必须双写转义。用户搜「他说"好"」或者少打一个引号，
    // 拼出来就是不闭合的 FTS5 字符串，SqliteError 一路冒到顶把整个进程带走。
    const phrase = `"${segment(query).replaceAll('"', '""')}"`;
    const sql = kind
      ? "SELECT kind, ref, title, snippet(search, 3, '[', ']', '…', 20) AS snip FROM search " +
        "WHERE seg MATCH ? AND kind = ? ORDER BY rank LIMIT ?"
      : "SELECT kind, ref, title, snippet(search, 3, '[', ']', '…', 20) AS snip FROM search " +
        "WHERE seg MATCH ? ORDER BY rank LIMIT ?";
    const args = kind ? [phrase, kind, limit] : [phrase, limit];
    const rows = this.db.query(sql).all(...args) as Array<{
      kind: string; ref: string; title: string; snip: string;
    }>;
    return rows.map((r) => ({ kind: r.kind, ref: r.ref, title: r.title, snippet: r.snip }));
  }
}
