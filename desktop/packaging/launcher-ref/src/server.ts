import { timingSafeEqual } from "node:crypto";
import type { Server } from "bun";

import { WEB_ASSETS, WEB_BUILD_ID } from "./assets.gen.ts";
import { BootstrapJob } from "./bootstrap.ts";
import { doctor } from "./doctor.ts";
import { readEnvFile, updateEnvFile } from "./env-file.ts";
import { DENIED_PAGE, FALLBACK_PAGE } from "./fallback-page.ts";
import type { Logger } from "./log.ts";
import { contentType } from "./mime.ts";
import { ENV_FILE, LOG_DIR } from "./paths.ts";

export interface ServerContext {
  token: string;
  workspace: string;
  version: string;
  log: Logger;
  onQuit: () => void;
}

const COOKIE_NAME = "omnisci_token";

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

function sameToken(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function cookieToken(request: Request): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === COOKIE_NAME) return decodeURIComponent(rest.join("="));
  }
  return null;
}

/** Query, header, bearer or cookie; the cookie is what the page uses after load. */
function presentedToken(request: Request, url: URL): string | null {
  const query = url.searchParams.get("t");
  if (query) return query;
  const header = request.headers.get("x-omnisci-token");
  if (header) return header;
  const auth = request.headers.get("authorization");
  if (auth?.startsWith("Bearer ")) return auth.slice(7);
  return cookieToken(request);
}

/**
 * A browser on another machine cannot reach 127.0.0.1, but a hostile page can
 * point a DNS name at it. Requiring a loopback Host header closes that.
 */
function hostIsLoopback(request: Request): boolean {
  const host = request.headers.get("host");
  if (!host) return true;
  const name = host.replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
  return name === "127.0.0.1" || name === "localhost" || name === "::1";
}

export function createServer(context: ServerContext, port: number): Server {
  const bootstrapJob = new BootstrapJob(context.log);
  const started = new Date().toISOString();
  // Port 0 means "any free one", so the number to report is the bound one, which
  // only exists once Bun.serve has returned.
  let self: Server | null = null;

  const authorized = (request: Request, url: URL): boolean => {
    const presented = presentedToken(request, url);
    return presented !== null && sameToken(presented, context.token);
  };

  const serveAsset = async (pathname: string, request: Request, url: URL): Promise<Response | null> => {
    const key = pathname === "/" ? "/index.html" : pathname;
    const embedded = WEB_ASSETS[key];
    if (!embedded) {
      if (key !== "/index.html") return null;
      const headers: Record<string, string> = {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      };
      if (authorized(request, url)) {
        headers["set-cookie"] =
          `${COOKIE_NAME}=${encodeURIComponent(context.token)}; Path=/; HttpOnly; SameSite=Strict`;
      }
      return new Response(FALLBACK_PAGE, { headers });
    }
    const file = Bun.file(embedded);
    const headers: Record<string, string> = {
      "content-type": contentType(key),
      // The bundle is versioned by the binary itself, so nothing may be cached
      // across an app update.
      "cache-control": key === "/index.html" ? "no-store" : "no-cache",
      "x-content-type-options": "nosniff",
    };
    // Loading the page with a valid ?t= mints a cookie, which is what lets the
    // frontend call the API without ever putting the token in a fetch URL.
    if (key === "/index.html" && authorized(request, url)) {
      headers["set-cookie"] =
        `${COOKIE_NAME}=${encodeURIComponent(context.token)}; Path=/; HttpOnly; SameSite=Strict`;
    }
    return new Response(file, { headers });
  };

  const handleApi = async (request: Request, url: URL): Promise<Response> => {
    const path = url.pathname;

    // Health is deliberately open: the menu-bar host polls it before it has read
    // the token, and it discloses nothing sensitive.
    if (path === "/api/health") {
      return json({
        ok: true,
        port: self?.port ?? port,
        workspace: context.workspace,
        version: context.version,
        pid: process.pid,
        startedAt: started,
        web: WEB_BUILD_ID,
      });
    }

    if (!authorized(request, url)) {
      return json({ error: "unauthorized" }, 401, { "www-authenticate": "Bearer" });
    }

    if (path === "/api/doctor" && request.method === "GET") {
      return json(await doctor());
    }

    if (path === "/api/bootstrap" && request.method === "GET") {
      return json(bootstrapJob.snapshot());
    }

    if (path === "/api/bootstrap" && request.method === "POST") {
      const started = bootstrapJob.start();
      return json(bootstrapJob.snapshot(), started ? 202 : 409);
    }

    if (path === "/api/bootstrap/events" && request.method === "GET") {
      const since = Number(url.searchParams.get("since") ?? "0") || 0;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const encoder = new TextEncoder();
          const send = (event: { seq: number; kind: string; text: string }): void => {
            controller.enqueue(encoder.encode(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`));
          };
          for (const event of bootstrapJob.since(since)) send(event);
          const unsubscribe = bootstrapJob.subscribe(send);
          request.signal.addEventListener("abort", () => {
            unsubscribe();
            try {
              controller.close();
            } catch {
              // Already closed by the client.
            }
          });
        },
      });
      return new Response(stream, {
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-store",
          connection: "keep-alive",
        },
      });
    }

    if (path === "/api/credentials" && request.method === "GET") {
      const parsed = readEnvFile();
      return json({
        file: ENV_FILE,
        // Names only. Values never leave the file. the desktop service contract (7).
        keys: Object.keys(parsed.values).sort(),
        malformedLines: parsed.malformedLines,
      });
    }

    if (path === "/api/credentials" && request.method === "POST") {
      let payload: { values?: Record<string, string> };
      try {
        payload = (await request.json()) as { values?: Record<string, string> };
      } catch {
        return json({ error: "body must be JSON" }, 400);
      }
      const values = payload.values;
      if (!values || typeof values !== "object") return json({ error: "expected {values:{KEY:VALUE}}" }, 400);
      for (const [key, value] of Object.entries(values)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return json({ error: `invalid key: ${key}` }, 400);
        if (typeof value !== "string" || /[\r\n]/.test(value)) {
          return json({ error: `invalid value for ${key}` }, 400);
        }
        context.log.hide(value);
      }
      const keys = updateEnvFile(values);
      context.log.info(`credentials updated: ${Object.keys(values).join(", ")} (values not logged)`);
      return json({ file: ENV_FILE, keys: keys.sort() });
    }

    if (path === "/api/logs" && request.method === "GET") {
      return json({ directory: LOG_DIR, file: context.log.path });
    }

    if (path === "/api/quit" && request.method === "POST") {
      context.log.info("quit requested over the API");
      // Answer first: the host waits for this response before it starts its
      // five second grace timer.
      queueMicrotask(() => setTimeout(context.onQuit, 50));
      return json({ ok: true });
    }

    if (path.startsWith("/api/v1/")) {
      return json(
        {
          error:
            "This build is the contract-only reference launcher: the research engine is not attached. " +
            "Swap in the real omnisci-desktop binary to run sessions.",
          reference: true,
        },
        503,
      );
    }

    return json({ error: "not found" }, 404);
  };

  self = Bun.serve({
    hostname: "127.0.0.1", // Never 0.0.0.0. the desktop service contract (3).
    port,
    idleTimeout: 0,
    development: false,
    async fetch(request) {
      const url = new URL(request.url);
      if (!hostIsLoopback(request)) {
        return json({ error: "forbidden host" }, 403);
      }
      try {
        if (url.pathname.startsWith("/api/")) return await handleApi(request, url);
        // The page carries no data on its own, but there is no reason to hand it
        // to a caller who cannot authenticate either.
        if (!authorized(request, url)) {
          return new Response(DENIED_PAGE, {
            status: 401,
            headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
          });
        }
        const asset = await serveAsset(url.pathname, request, url);
        if (asset) return asset;
        // Single-page app: unknown non-asset paths render the shell.
        if (!url.pathname.includes(".")) {
          const index = await serveAsset("/", request, url);
          if (index) return index;
        }
        return new Response("not found", { status: 404 });
      } catch (error) {
        context.log.error(`request failed: ${url.pathname}: ${String(error)}`);
        return json({ error: "internal error" }, 500);
      }
    },
    error(error) {
      context.log.error(`server error: ${String(error)}`);
      return new Response("internal error", { status: 500 });
    },
  });
  return self;
}
