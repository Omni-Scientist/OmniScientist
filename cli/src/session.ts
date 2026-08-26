/**
 * 会话持久化：SQLite（bun:sqlite，无外部依赖）。
 *
 * 每一轮的完整输入输出都落盘，包括工具调用和结果。理由有两个：
 * 一是能续上（续会话时缓存也跟着续）；
 * 二是以后想回放、想做 harness 本身的消融，数据得在那儿。
 */

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { repairToolCallGaps } from "./loop.ts";
import { usableArguments } from "./model.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
    id          TEXT PRIMARY KEY,
    cwd         TEXT NOT NULL,
    model       TEXT NOT NULL,
    started_at  TEXT NOT NULL,
    title       TEXT
);
CREATE TABLE IF NOT EXISTS messages (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id  TEXT NOT NULL REFERENCES sessions(id),
    turn        INTEGER NOT NULL,
    role        TEXT NOT NULL,
    payload     TEXT NOT NULL,
    created_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS active_standards (
    session_id  TEXT NOT NULL REFERENCES sessions(id),
    turn        INTEGER NOT NULL,
    name        TEXT NOT NULL,
    reason      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, turn);
`;

const now = () => new Date().toISOString().replace(/\.\d+Z$/, "Z");

export class Session {
  turn = 0;

  private constructor(
    readonly id: string,
    readonly cwd: string,
    readonly model: string,
    private db: Database,
  ) {}

  static open(dbPath: string, cwd: string, model: string, sessionId?: string): Session {
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new Database(dbPath, { create: true });
    db.run(SCHEMA);

    if (sessionId) {
      const row = db.query("SELECT id FROM sessions WHERE id = ?").get(sessionId);
      if (!row) throw new Error(`没有这个会话: ${sessionId}`);
      const maxTurn = db
        .query("SELECT COALESCE(MAX(turn), 0) AS t FROM messages WHERE session_id = ?")
        .get(sessionId) as { t: number };
      const s = new Session(sessionId, cwd, model, db);
      s.turn = maxTurn.t;
      return s;
    }

    const id = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
    db.run("INSERT INTO sessions (id, cwd, model, started_at) VALUES (?, ?, ?, ?)",
           [id, cwd, model, now()]);
    return new Session(id, cwd, model, db);
  }

  record(role: string, payload: unknown): void {
    this.db.run(
      "INSERT INTO messages (session_id, turn, role, payload, created_at) VALUES (?,?,?,?,?)",
      [this.id, this.turn, role, JSON.stringify(payload), now()],
    );
  }

  recordStandards(pairs: Array<[string, string]>): void {
    for (const [name, reason] of pairs) {
      this.db.run(
        "INSERT INTO active_standards (session_id, turn, name, reason) VALUES (?,?,?,?)",
        [this.id, this.turn, name, reason],
      );
    }
  }

  /**
   * 把某一轮的工具调用原样翻出来，供 /trace 展开。
   * 界面上连续同名的工具会折叠成一行，细节不丢，都在这儿。
   * 不传轮次就取最近一轮。
   */
  /** 检索索引要跟会话共用同一个连接，别再开一个。 */
  get database(): Database {
    return this.db;
  }

  toolTrace(turn?: number): Array<{ turn: number; name: string; args: string; result: string }> {
    const t = turn ?? (this.db
      .query("SELECT COALESCE(MAX(turn), 0) AS t FROM messages WHERE session_id = ?")
      .get(this.id) as { t: number }).t;

    const rows = this.db
      .query("SELECT role, payload FROM messages WHERE session_id = ? AND turn = ? ORDER BY id")
      .all(this.id, t) as Array<{ role: string; payload: string }>;

    const calls = new Map<string, { name: string; args: string }>();
    const out: Array<{ turn: number; name: string; args: string; result: string }> = [];

    for (const r of rows) {
      const msg = JSON.parse(r.payload) as Record<string, unknown>;
      if (r.role === "assistant") {
        for (const c of (msg.tool_calls ?? []) as Array<Record<string, unknown>>) {
          const fn = c.function as { name: string; arguments: string };
          calls.set(String(c.id), { name: fn.name, args: fn.arguments });
        }
      } else if (r.role === "tool") {
        const call = calls.get(String(msg.tool_call_id));
        if (call) {
          out.push({ turn: t, name: call.name, args: call.args, result: String(msg.content ?? "") });
        }
      }
    }
    return out;
  }

  /**
   * 把落盘的消息读回来，用于续会话。
   *
   * 三道清洗，缺一个 resume 就是坏的：
   * 1. 只留真正的对话消息。压缩记账那类行也写在 messages 表里但没有 content，
   *    原样重放会被 API 直接 400，压缩过的会话就再也续不上。
   * 2. 末尾如果是带 tool_calls 却没有对应 tool 回复的 assistant（工具跑一半被
   *    中断、审批抛错都会留下），必须丢掉。孤儿 tool_calls 下一轮必然 400。
   * 3. **中间**的空洞也要补。第 2 步只剥尾巴，挡不住这种落盘状态：
   *      assistant(tool_calls=[a, b])
   *      tool(a)                       <- 最后一条是 tool，剥离循环当场停手
   *    b 没有回执，assistant 却留下了，下一次请求照样 400。一批工具只写完一半
   *    就崩溃/断电/被杀，就会留下这个形状。
   *
   * 补洞放在这儿而不是放在调用方：resume 有 CLI 和桌面网关两个入口，
   * 以前只有网关补了，CLI 那条路一直漏着。放进来就没有哪个入口能忘掉它。
   *
   * onRepair 只是给调用方一个说话的机会（打日志），补不补跟它无关。
   */
  history(onRepair?: (count: number) => void): unknown[] {
    const rows = this.db
      .query("SELECT payload FROM messages WHERE session_id = ? ORDER BY id")
      .all(this.id) as Array<{ payload: string }>;

    const msgs = rows
      .map((r) => JSON.parse(r.payload) as Record<string, unknown>)
      .filter((m) => {
        const role = m.role;
        if (role !== "system" && role !== "user" && role !== "assistant" && role !== "tool") {
          return false;
        }
        // content 是 null 只有在 assistant 带 tool_calls 时才合法
        if (m.content === undefined) return role === "assistant" && Boolean(m.tool_calls);
        return true;
      });

    // 从尾部剥掉没配上 tool 回复的 assistant(tool_calls)
    while (msgs.length) {
      const last = msgs[msgs.length - 1]!;
      if (last.role === "assistant" && Array.isArray(last.tool_calls) && last.tool_calls.length) {
        msgs.pop();
        continue;
      }
      break;
    }

    // 4. 半截的 arguments 要洗掉。0.1.6 之前，tool_call 流到一半撞上输出上限，
    //    那截残缺 JSON 会原样落盘（见 model.ts 里丢弃它的那段）。产生端修好了，
    //    可库里存下的那些还在，每次 resume 都会再发出去一次，于是同一个会话
    //    永远续不上。只有转换型网关会因此 400，官方通道透传不校验（issue #5）。
    //
    //    换成 {} 而不是删掉整个 tool_call：它和它的 tool 回执必须成对，删一个
    //    就变成"tool 回执没有对应的 tool_call"，那是另一种 400。空参数配上原本
    //    那条写着出错原因的 tool 回执，模型看得懂发生了什么，会自己重来。
    let washed = 0;
    for (const m of msgs) {
      if (m.role !== "assistant" || !Array.isArray(m.tool_calls)) continue;
      for (const call of m.tool_calls as Array<Record<string, unknown>>) {
        const fn = call.function as Record<string, unknown> | undefined;
        if (!fn || typeof fn.arguments !== "string") continue;
        if (usableArguments(fn.arguments)) continue;
        fn.arguments = "{}";
        washed++;
      }
    }

    const repaired = repairToolCallGaps(msgs);
    if ((repaired || washed) && onRepair) onRepair(repaired + washed);
    return msgs;
  }

  close(): void {
    this.db.close();
  }
}
