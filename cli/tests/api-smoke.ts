import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";

import { ApprovalPolicy } from "../src/approval.ts";
import { safeChildEnvironment } from "../src/credentials.ts";
import { AgentLoop, type Presenter } from "../src/loop.ts";
import { ModelClient } from "../src/model.ts";
import { makeContext, Registry } from "../src/tools/index.ts";
import { VISION_TOOLS } from "../src/tools/vision.ts";

const presenter: Presenter = {
  turnStart() {},
  textDelta() {},
  textDone() {},
  toolStart(name, summary) { process.stdout.write(`tool ${name}: ${summary}\n`); },
  toolResult(name, ok, detail) { process.stdout.write(`${name} ${ok ? "ok" : "failed"}: ${detail}\n`); },
};

const root = mkdtempSync("/tmp/omnisci-api-smoke-");
const image = `${root}/leaf.png`;
copyFileSync(
  "/opt/omnisci/docker/fixtures/data/slides/Tomato_healthy/pv_00001.png",
  image,
);
mkdirSync(`${root}/host/calls`, { recursive: true });
writeFileSync(
  `${root}/series.json`,
  JSON.stringify({ members: [{ idx: 0, file: "leaf.png", modality: "image", label: "healthy" }] }),
);
const question = "What object and dominant color are actually visible?";
writeFileSync(
  `${root}/host/calls/call_001.json`,
  JSON.stringify({
    call_id: 1,
    tool: "look_at_image",
    args: { files: ["leaf.png"], question },
    draft: "leaf.png: <<VISION:1>>",
    pending: [{ id: 1, image, question }],
    status: "needs_vision",
  }),
);
const model = new ModelClient({ provider: "deepseek", model: "deepseek-v4-flash", maxTokens: 800 });
const registry = new Registry();
for (const tool of VISION_TOOLS) registry.add(tool);

const messages: unknown[] = [
  {
    role: "system",
    content: "You are an API integration test. Call view_image exactly once, inspect the actual pixels, then answer in one short sentence.",
  },
  {
    role: "user",
    content: `Use view_image on leaf.png with this exact question: ${question} Then state the observation briefly.`,
  },
];

const loop = new AgentLoop(
  model,
  registry,
  makeContext(root),
  new ApprovalPolicy(true),
  presenter,
);
const result = await loop.run(messages);
const roles = messages.map((message) => (message as { role?: string }).role);
if (!roles.includes("tool")) throw new Error("DeepSeek did not call view_image");
const toolMessage = messages.find((message) => (message as { role?: string }).role === "tool") as {
  content?: string;
} | undefined;
if (!toolMessage?.content?.includes("视觉侧车") || !toolMessage.content.includes("OmniSci-Vision-Receipt:")) {
  throw new Error("view_image did not return a grounded sidecar observation to DeepSeek");
}
const pendingCall = JSON.parse(readFileSync(`${root}/host/calls/call_001.json`, "utf-8")) as {
  receipts?: Record<string, unknown>;
};
if (!pendingCall.receipts?.["1"]) throw new Error("view_image did not bind a receipt to the pending call");

const ingest = Bun.spawn(
  [
    "python3",
    "/opt/omnisci/skills/omnisci/bin/evidence_cli.py",
    "ingest",
    "--task",
    root,
    "--call",
    "1",
  ],
  { stdout: "pipe", stderr: "pipe", env: safeChildEnvironment() },
);
const [ingestOut, ingestErr, ingestCode] = await Promise.all([
  new Response(ingest.stdout).text(),
  new Response(ingest.stderr).text(),
  ingest.exited,
]);
if (ingestCode !== 0) throw new Error(`receipt ingest failed: ${ingestErr || ingestOut}`);
const ingestedCall = JSON.parse(readFileSync(`${root}/host/calls/call_001.json`, "utf-8")) as {
  status?: string;
  answers?: Record<string, string>;
};
if (ingestedCall.status !== "done" || !ingestedCall.answers?.["1"]) {
  throw new Error("receipt-backed perception call did not reach done");
}
const last = messages.at(-1) as { role?: string; content?: string | null };
if (last.role !== "assistant" || !last.content?.trim()) {
  throw new Error("DeepSeek did not return a final visual answer");
}
process.stdout.write(`API smoke passed with deepseek-v4-flash in ${result.turns} turns: ${last.content.trim()}\n`);
