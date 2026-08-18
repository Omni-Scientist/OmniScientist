export type SessionStatus = "running" | "complete" | "idle";
export type ArtifactKind = "paper" | "figure" | "code" | "table";

export interface SessionSummary {
  id: string;
  title: string;
  preview: string;
  updatedAt: string;
  group: "今天" | "过去 7 天";
  status: SessionStatus;
  workspace: string;
  model: string;
}

export interface ToolStep {
  id: string;
  tool: string;
  label: string;
  detail: string;
  status: "running" | "complete" | "failed";
  duration?: string;
  /** Sanitized, bounded output intended for explicit user disclosure. */
  output?: string;
  outputTruncated?: boolean;
}

export type TraceEntryStatus = "complete" | "failed" | "revised";
export type TraceEntryImportance = "normal" | "milestone" | "issue";

export interface TraceEntry {
  id: string;
  sequence: number;
  phase: string;
  tool: string;
  label: string;
  detail: string;
  output?: string;
  status: TraceEntryStatus;
  importance?: TraceEntryImportance;
  artifactIds?: string[];
}

export interface ResearchTrace {
  id: string;
  stage: string;
  title: string;
  summary: string;
  entries: TraceEntry[];
}

export interface ToolRun {
  title: string;
  summary: string;
  steps: ToolStep[];
  trace?: ResearchTrace;
}

export type AssistantPhase = "thinking" | "writing" | "tool" | "complete";

export type MessageBlock =
  | { id: string; type: "markdown"; content: string }
  | { id: string; type: "tool"; step: ToolStep };

export interface Artifact {
  id: string;
  kind: ArtifactKind;
  title: string;
  path: string;
  detail: string;
  updatedAt: string;
  order?: number;
  imageUrl?: string;
  fileUrl?: string;
  bundleUrl?: string;
  previewUrls?: string[];
  language?: string;
  content?: string;
  caption?: string;
  altText?: string;
  tableHeaders?: string[];
  tableRows?: string[][];
  location?: string;
  sectionTitle?: string;
}

export interface Citation {
  id: number;
  label: string;
  source: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  author: string;
  time: string;
  content: string;
  blocks?: MessageBlock[];
  progress?: AssistantPhase;
  toolRun?: ToolRun;
  artifacts?: Artifact[];
  citations?: Citation[];
}

export interface ChatSession extends SessionSummary {
  messages: ChatMessage[];
}

export type TransportEvent =
  | { type: "assistant.started"; messageId: string }
  | { type: "assistant.phase"; messageId: string; phase: AssistantPhase }
  | { type: "tool.started"; messageId: string; step: ToolStep }
  | { type: "tool.finished"; messageId: string; step: ToolStep }
  | { type: "assistant.delta"; messageId: string; delta: string }
  | { type: "artifact.created"; messageId: string; artifact: Artifact }
  | { type: "artifacts.updated"; messageId: string; artifacts: Artifact[] }
  | { type: "run.failed"; messageId: string; error: string }
  | { type: "assistant.completed"; message: ChatMessage };

export interface ResearchTransport {
  listSessions(): Promise<SessionSummary[]>;
  getSession(id: string): Promise<ChatSession>;
  createSession(workspace: string): Promise<ChatSession>;
  /** dataPath 是界面上选的数据目录（相对工作区），不进用户可见的消息正文。 */
  sendMessage(sessionId: string, content: string, dataPath?: string): AsyncGenerator<TransportEvent>;
  /** 停掉正在跑的那一轮。已经产出的东西保留，再发消息就接着做。 */
  stopRun(sessionId: string): Promise<void>;
}
