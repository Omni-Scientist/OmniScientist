import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { safeChildEnvironment } from "../src/credentials.ts";
import { verifyPaperDelivery } from "../src/delivery.ts";
import { makeContext, normalizeToolResult } from "../src/tools/index.ts";
import { OMNISCI_TOOLS, fileSha256 } from "../src/tools/omnisci.ts";
import { recordPerceptionReceipt, VISION_META_PREFIX } from "../src/tools/vision.ts";

const rootArg = Bun.argv[2];
if (!rootArg) throw new Error("usage: delivery-smoke.ts <case>");
const root: string = rootArg;
const ctx = makeContext(root);
const messages: unknown[] = [];
const startedAt = Date.now() - 1000;
let toolNo = 0;

async function trustedTool(name: string, args: Record<string, unknown>): Promise<void> {
  const tool = OMNISCI_TOOLS.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`missing tool ${name}`);
  const id = `trusted-${++toolNo}`;
  messages.push({
    role: "assistant",
    tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
  });
  const result = normalizeToolResult(await tool.run(args, ctx));
  messages.push({ role: "tool", tool_call_id: id, content: result.text });
}

function viewed(path: string, question: string): void {
  const absolute = join(root, path);
  const observation = `Fixture visual review of ${path}: visible, nonblank, and not clipped.`;
  const receipt = recordPerceptionReceipt(root, absolute, question, observation, "fixture", "fixture");
  const id = `vision-${++toolNo}`;
  messages.push({
    role: "assistant",
    tool_calls: [{
      id,
      type: "function",
      function: { name: "view_image", arguments: JSON.stringify({ path, question }) },
    }],
  });
  messages.push({
    role: "tool",
    tool_call_id: id,
    content:
      `OmniSci-Vision-Receipt: ${receipt.receiptId}\n` +
      `${VISION_META_PREFIX}${JSON.stringify(receipt.receipt)}\n${observation}`,
  });
}

await trustedTool("omnisci_record", { script: "host/analysis/table_analysis.py", timeout: 120 });
await trustedTool("omnisci_bib", { picks: "host/picks.json" });
await trustedTool("omnisci_compile", {
  sections: "host/sections.json",
  title: "A smoke test of the packaged OmniScientist skill",
});

const manifestPath = join(root, "host", "paper.manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as {
  inputs: { figures: Array<{ path: string; sha256: string }> };
  artifacts: Record<string, { path: string; sha256: string }>;
  review_pages: Array<{ path: string; sha256: string }>;
};
for (const figure of manifest.inputs.figures) {
  viewed(figure.path, "Is this analysis figure blank, clipped, mislabeled, or misleading?");
}
for (const page of manifest.review_pages) {
  viewed(page.path, "Is this PDF page blank, clipped, overlapping, or visibly broken?");
}

const delivery = await verifyPaperDelivery(root, messages, startedAt);
if (!delivery.ok) throw new Error(`trusted delivery failed: ${delivery.errors.join("; ")}`);

for (const key of ["tex", "pdf", "overleaf_zip"] as const) {
  const artifact = manifest.artifacts[key];
  if (!artifact) throw new Error(`manifest missing ${key}`);
  const path = join(root, artifact.path);
  const original = readFileSync(path);
  appendFileSync(path, "tampered");
  const tampered = await verifyPaperDelivery(root, messages, startedAt);
  if (tampered.ok || !tampered.errors.some((error) => error.includes("哈希"))) {
    throw new Error(`${key} tampering was not rejected: ${tampered.errors.join("; ")}`);
  }
  writeFileSync(path, original);
  if (fileSha256(path) !== artifact.sha256) throw new Error(`failed to restore ${key}`);
}

const manifestOriginal = readFileSync(manifestPath);
appendFileSync(manifestPath, "\n");
const changedManifest = await verifyPaperDelivery(root, messages, startedAt);
if (changedManifest.ok || !changedManifest.errors.some((error) => error.includes("manifest"))) {
  throw new Error(`manifest tampering was not rejected: ${changedManifest.errors.join("; ")}`);
}
writeFileSync(manifestPath, manifestOriginal);

const proofPath = join(root, "host", "references.provenance.json");
const proofOriginal = readFileSync(proofPath);
const proof = JSON.parse(proofOriginal.toString()) as Record<string, unknown>;
proof.verified_at = "2099-01-01T00:00:00Z";
writeFileSync(proofPath, JSON.stringify(proof, null, 2));
const changedProof = await verifyPaperDelivery(root, messages, startedAt);
if (changedProof.ok || !changedProof.errors.some((error) => error.includes("bibliography"))) {
  throw new Error(`provenance tampering was not rejected: ${changedProof.errors.join("; ")}`);
}
writeFileSync(proofPath, proofOriginal);

const bypassScript = join(root, "host", "analysis", "untrusted.py");
writeFileSync(bypassScript, "print('unused_metric = 77.77')\n");
const bypass = Bun.spawn([
  "python3",
  join(process.env.OMNISCI!, "gate_cli.py"),
  "record",
  "--task",
  root,
  "--script",
  bypassScript,
  "--timeout",
  "30",
], { cwd: root, stdout: "pipe", stderr: "pipe", env: safeChildEnvironment() });
const [bypassOut, bypassErr, bypassCode] = await Promise.all([
  new Response(bypass.stdout).text(),
  new Response(bypass.stderr).text(),
  bypass.exited,
]);
if (bypassCode !== 0) throw new Error(`bypass fixture failed: ${bypassOut}${bypassErr}`);
const bypassed = await verifyPaperDelivery(root, messages, startedAt);
if (bypassed.ok || !bypassed.errors.some((error) => error.includes("omnisci_record"))) {
  throw new Error(`untrusted ledger record was not rejected: ${bypassed.errors.join("; ")}`);
}

process.stdout.write("OmniScientist trusted delivery and tamper checks passed\n");
