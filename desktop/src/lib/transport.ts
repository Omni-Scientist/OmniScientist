import type { ResearchTransport } from "../types";
import { httpTransport } from "./transport.http";
import { mockTransport } from "./transport.mock";

/**
 * Browser and desktop shells consume this boundary only. Replacing the mock with
 * an HTTP/SSE or local IPC adapter does not change the CLI's AgentLoop or storage.
 */
export const transport: ResearchTransport = import.meta.env.VITE_OMNISCI_LIVE === "1"
  ? httpTransport
  : mockTransport;
