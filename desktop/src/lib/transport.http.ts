import type {
  ChatSession,
  ResearchTransport,
  SessionSummary,
  TransportEvent,
} from "../types";
import { t } from "./i18n";

const API = "/api/v1";

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(payload.error || t("本地后端返回 {0}", response.status));
  }
  return response.json() as Promise<T>;
}

export const httpTransport: ResearchTransport = {
  /**
   * 只回真会话。演示数据属于网页版的 mock transport：装完桌面版第一次打开，
   * 用户看到的必须是自己的空工作台，不是别人的研究记录。
   */
  async listSessions() {
    try {
      return await api<SessionSummary[]>("/sessions");
    } catch {
      return [];
    }
  },

  async getSession(id: string) {
    return api<ChatSession>(`/sessions/${encodeURIComponent(id)}`);
  },

  async createSession(_workspace: string) {
    return api<ChatSession>("/sessions", {
      method: "POST",
      body: JSON.stringify({}),
    });
  },

  async *sendMessage(sessionId: string, content: string, dataPath?: string): AsyncGenerator<TransportEvent> {
    const response = await fetch(`${API}/sessions/${encodeURIComponent(sessionId)}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content, ...(dataPath ? { dataPath } : {}) }),
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({})) as { error?: string };
      throw new Error(payload.error || t("本地后端返回 {0}", response.status));
    }
    if (!response.body) throw new Error(t("本地后端没有返回事件流"));

    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffered = "";
    for (;;) {
      const { done, value } = await reader.read();
      buffered += value ?? "";
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim()) yield JSON.parse(line) as TransportEvent;
      }
      if (done) break;
    }
    if (buffered.trim()) yield JSON.parse(buffered) as TransportEvent;
  },
};
