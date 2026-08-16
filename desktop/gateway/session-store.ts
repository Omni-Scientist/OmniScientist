import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import type { ChatMessage, SessionStatus, SessionSummary } from "../src/types.ts";

const WEB_SCHEMA = `
CREATE TABLE IF NOT EXISTS web_session_state (
    session_id   TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
    title        TEXT NOT NULL,
    preview      TEXT NOT NULL,
    updated_at   TEXT NOT NULL,
    status       TEXT NOT NULL,
    chat_payload TEXT NOT NULL,
    data_path    TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_web_session_state_updated
    ON web_session_state(updated_at DESC);
`;

interface StateRow {
  session_id: string;
  title: string;
  preview: string;
  updated_at: string;
  status: string;
  chat_payload: string;
  data_path: string;
  cwd: string;
  model: string;
}

interface RawMessageRow {
  id: number;
  session_id: string;
  turn: number;
  role: string;
  payload: string;
  created_at: string;
}

interface RawSessionRow {
  id: string;
  cwd: string;
  model: string;
  started_at: string;
  updated_at: string;
}

interface RawToolResultRow {
  turn: number;
  tool: string;
  source: string;
  output: string;
}

export interface StoredWebSession {
  internalId: string;
  title: string;
  preview: string;
  updatedAt: string;
  status: SessionStatus;
  workspace: string;
  model: string;
  messages: ChatMessage[];
  dataPath: string;
}

export interface WebSessionSnapshot {
  title: string;
  preview: string;
  updatedAt: string;
  status: SessionStatus;
  messages: ChatMessage[];
  /** 这一轮挑的数据目录，相对工作区。产物路径要相对它解析。 */
  dataPath: string;
}

function columnExists(db: Database, table: string, column: string): boolean {
  const rows = db.query(`PRAGMA table_info(${table})`).all() as Array<{ name?: string }>;
  return rows.some((row) => row.name === column);
}

function tableExists(db: Database, name: string): boolean {
  return Boolean(db
    .query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name));
}

function parseStatus(value: string): SessionStatus {
  return value === "running" || value === "complete" ? value : "idle";
}

function messageTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}

function payloadText(payload: Record<string, unknown>): string {
  if (typeof payload.content === "string") return payload.content;
  if (!Array.isArray(payload.content)) return "";
  return payload.content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const item = part as Record<string, unknown>;
      return item.type === "text" && typeof item.text === "string" ? item.text : "";
    })
    .join("");
}

function visibleUserText(value: string): string {
  return value.replace(/\n\n<适用规矩>[\s\S]*$/u, "").trim();
}

function compact(value: string, limit: number): string {
  return value.replace(/\s+/g, " ").trim().slice(0, limit);
}

function parseMessages(payload: string): ChatMessage[] | undefined {
  try {
    const value = JSON.parse(payload) as unknown;
    if (!Array.isArray(value)) return undefined;
    const messages = value.filter((item): item is ChatMessage => {
      if (!item || typeof item !== "object") return false;
      const message = item as Partial<ChatMessage>;
      return typeof message.id === "string"
        && (message.role === "user" || message.role === "assistant")
        && typeof message.content === "string";
    });
    return messages;
  } catch {
    return undefined;
  }
}

export class WebSessionStore {
  private readonly db: Database;

  constructor(
    dbPath: string,
    private readonly workspaceRoot: string,
    private readonly workspaceName: string,
    private readonly defaultModel: string,
    private readonly redact: (value: string, limit?: number) => string,
  ) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath, { create: true });
    this.db.run(WEB_SCHEMA);
    // 老库是没有 data_path 的。缺了它，重开之后 case 目录无从得知，
    // 收据里的 host/paper.pdf 会被拿去工作区根目录下找，产物面板一片空白。
    if (!columnExists(this.db, "web_session_state", "data_path")) {
      this.db.run("ALTER TABLE web_session_state ADD COLUMN data_path TEXT NOT NULL DEFAULT ''");
    }
    // A running row at process start belongs to an interrupted gateway process.
    this.db.run("UPDATE web_session_state SET status = 'idle' WHERE status = 'running'");
  }

  hasRawSession(internalId: string): boolean {
    if (!tableExists(this.db, "sessions")) return false;
    return Boolean(this.db
      .query("SELECT 1 FROM sessions WHERE id = ? AND cwd = ?")
      .get(internalId, this.workspaceRoot));
  }

  save(internalId: string, snapshot: WebSessionSnapshot): void {
    this.db.run(
      `INSERT INTO web_session_state
         (session_id, title, preview, updated_at, status, chat_payload, data_path)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         title = excluded.title,
         preview = excluded.preview,
         updated_at = excluded.updated_at,
         status = excluded.status,
         chat_payload = excluded.chat_payload,
         data_path = excluded.data_path`,
      [
        internalId,
        snapshot.title,
        snapshot.preview,
        snapshot.updatedAt,
        snapshot.status,
        JSON.stringify(snapshot.messages),
        snapshot.dataPath,
      ],
    );
  }

  load(internalId: string): StoredWebSession | undefined {
    if (!tableExists(this.db, "sessions")) return undefined;
    let row = this.db.query(
      `SELECT w.session_id, w.title, w.preview, w.updated_at, w.status, w.chat_payload, w.data_path,
              s.cwd, s.model
         FROM web_session_state w
         JOIN sessions s ON s.id = w.session_id
        WHERE w.session_id = ? AND s.cwd = ?`,
    ).get(internalId, this.workspaceRoot) as StateRow | null;

    if (!row && this.hasRawSession(internalId)) {
      this.backfillOne(internalId);
      row = this.db.query(
        `SELECT w.session_id, w.title, w.preview, w.updated_at, w.status, w.chat_payload, w.data_path,
                s.cwd, s.model
           FROM web_session_state w
           JOIN sessions s ON s.id = w.session_id
          WHERE w.session_id = ? AND s.cwd = ?`,
      ).get(internalId, this.workspaceRoot) as StateRow | null;
    }
    return row ? this.fromRow(row) : undefined;
  }

  list(): StoredWebSession[] {
    if (!tableExists(this.db, "sessions")) return [];
    this.backfillMissing();
    const rows = this.db.query(
      `SELECT w.session_id, w.title, w.preview, w.updated_at, w.status, w.chat_payload, w.data_path,
              s.cwd, s.model
         FROM web_session_state w
         JOIN sessions s ON s.id = w.session_id
        WHERE s.cwd = ?
        ORDER BY w.updated_at DESC`,
    ).all(this.workspaceRoot) as StateRow[];
    return rows.map((row) => this.fromRow(row));
  }

  /** Raw tool rows are kept server-side and sanitized by the gateway before browser delivery. */
  toolResults(internalId: string): RawToolResultRow[] {
    if (!tableExists(this.db, "messages")) return [];
    const rows = this.db.query(
      `SELECT turn, role, payload
         FROM messages
        WHERE session_id = ? AND role IN ('assistant', 'tool')
        ORDER BY id`,
    ).all(internalId) as Array<Pick<RawMessageRow, "turn" | "role" | "payload">>;
    const calls = new Map<string, { turn: number; tool: string; source: string }>();
    const results: RawToolResultRow[] = [];

    for (const row of rows) {
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(row.payload) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (row.role === "assistant") {
        for (const rawCall of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
          if (!rawCall || typeof rawCall !== "object") continue;
          const call = rawCall as { id?: unknown; function?: { name?: unknown; arguments?: unknown } };
          if (typeof call.id !== "string" || typeof call.function?.name !== "string") continue;
          calls.set(call.id, {
            turn: row.turn,
            tool: call.function.name,
            source: typeof call.function.arguments === "string" ? call.function.arguments : "",
          });
        }
        continue;
      }
      const callId = typeof message.tool_call_id === "string" ? message.tool_call_id : "";
      const call = calls.get(callId);
      if (!call || typeof message.content !== "string") continue;
      results.push({ ...call, output: message.content });
    }
    return results;
  }

  summary(stored: StoredWebSession): SessionSummary {
    const updated = new Date(stored.updatedAt);
    const today = new Date();
    const sameDay = !Number.isNaN(updated.getTime())
      && updated.getFullYear() === today.getFullYear()
      && updated.getMonth() === today.getMonth()
      && updated.getDate() === today.getDate();
    return {
      id: `local-${stored.internalId}`,
      title: stored.title,
      preview: stored.preview,
      updatedAt: sameDay
        ? updated.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })
        : updated.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" }),
      group: sameDay ? "今天" : "过去 7 天",
      status: stored.status,
      workspace: stored.workspace,
      model: stored.model,
    };
  }

  private fromRow(row: StateRow): StoredWebSession {
    return {
      internalId: row.session_id,
      title: row.title,
      preview: row.preview,
      updatedAt: row.updated_at,
      status: parseStatus(row.status),
      workspace: this.workspaceName,
      model: row.model || this.defaultModel,
      messages: parseMessages(row.chat_payload) ?? this.reconstructMessages(row.session_id),
      dataPath: row.data_path || this.dataPathFromTranscript(row.session_id),
    };
  }

  /**
   * 从对话里把数据目录捞回来。
   *
   * data_path 是后加的列，在它之前跑的会话那一格是空的，产物路径就没有基准可解析。
   * 好在提交给模型的消息里带过 `<数据目录>x</数据目录>`，那是当时真正用的那个值，
   * 照着取回来是确定的，不是猜的。取最后一次，因为用户中途可能换过目录。
   */
  private dataPathFromTranscript(internalId: string): string {
    if (!tableExists(this.db, "messages")) return "";
    // 用 LIKE 让 SQLite 去挑，不要自己拉一批回来扫：那个标记通常只在**第一条**
    // 消息里，取最近 N 条的窗口正好会漏掉它，长会话上必然失手。
    const row = this.db.query(
      `SELECT payload FROM messages
        WHERE session_id = ? AND payload LIKE '%<数据目录>%'
        ORDER BY id DESC LIMIT 1`,
    ).get(internalId) as { payload?: string } | null;
    const hit = /<数据目录>([^<]*)<\/数据目录>/u.exec(row?.payload ?? "");
    return hit?.[1]?.trim() ?? "";
  }

  private backfillMissing(): void {
    const rows = this.db.query(
      `SELECT s.id, s.cwd, s.model, s.started_at,
              COALESCE(MAX(m.created_at), s.started_at) AS updated_at
         FROM sessions s
         LEFT JOIN messages m ON m.session_id = s.id
         LEFT JOIN web_session_state w ON w.session_id = s.id
        WHERE s.cwd = ? AND w.session_id IS NULL
        GROUP BY s.id
        ORDER BY updated_at DESC`,
    ).all(this.workspaceRoot) as RawSessionRow[];
    for (const row of rows) this.backfillOne(row.id, row);
  }

  private backfillOne(internalId: string, known?: RawSessionRow): void {
    const raw = known ?? this.db.query(
      `SELECT s.id, s.cwd, s.model, s.started_at,
              COALESCE(MAX(m.created_at), s.started_at) AS updated_at
         FROM sessions s
         LEFT JOIN messages m ON m.session_id = s.id
        WHERE s.id = ? AND s.cwd = ?
        GROUP BY s.id`,
    ).get(internalId, this.workspaceRoot) as RawSessionRow | null;
    if (!raw) return;

    const messages = this.reconstructMessages(internalId);
    const firstUser = messages.find((message) => message.role === "user")?.content ?? "";
    const lastMessage = messages.at(-1)?.content ?? "";
    this.save(internalId, {
      title: compact(this.redact(firstUser, 168), 42) || "新研究会话",
      preview: compact(this.redact(lastMessage, 320), 80) || "等待你的问题",
      // 回填的是 data_path 那列还不存在时留下的老会话，只能从对话里捞
      dataPath: this.dataPathFromTranscript(internalId),
      updatedAt: raw.updated_at,
      status: messages.length ? "complete" : "idle",
      messages,
    });
  }

  private reconstructMessages(internalId: string): ChatMessage[] {
    const rows = this.db.query(
      `SELECT id, session_id, turn, role, payload, created_at
         FROM messages
        WHERE session_id = ? AND role IN ('user', 'assistant')
        ORDER BY id`,
    ).all(internalId) as RawMessageRow[];
    const messages: ChatMessage[] = [];
    let assistantForTurn: ChatMessage | undefined;
    let assistantTurn = -1;

    for (const row of rows) {
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(row.payload) as Record<string, unknown>;
      } catch {
        continue;
      }
      const rawText = payloadText(payload);
      const text = row.role === "user" ? visibleUserText(rawText) : rawText.trim();
      if (!text) continue;
      const visible = this.redact(text, 200_000);
      if (!visible) continue;

      if (row.role === "user") {
        assistantForTurn = undefined;
        assistantTurn = -1;
        messages.push({
          id: `history-user-${row.id}`,
          role: "user",
          author: "你",
          time: messageTime(row.created_at),
          content: visible,
        });
        continue;
      }

      if (!assistantForTurn || assistantTurn !== row.turn) {
        assistantTurn = row.turn;
        assistantForTurn = {
          id: `history-assistant-${internalId}-${row.turn}`,
          role: "assistant",
          author: "OmniScientist",
          time: messageTime(row.created_at),
          content: visible,
          blocks: [{
            id: `history-assistant-${internalId}-${row.turn}-markdown`,
            type: "markdown",
            content: visible,
          }],
          progress: "complete",
        };
        messages.push(assistantForTurn);
      } else {
        assistantForTurn.content += `\n\n${visible}`;
        const block = assistantForTurn.blocks?.[0];
        if (block?.type === "markdown") block.content = assistantForTurn.content;
      }
    }
    return messages;
  }

  close(): void {
    this.db.close();
  }
}
