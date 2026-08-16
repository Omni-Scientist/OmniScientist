import { readFileSync } from "node:fs";

import { credentialFor, safeChildEnvironment } from "../src/credentials.ts";

const sentinel = "omnisci-credential-sentinel";
if (credentialFor("deepseek") !== sentinel) throw new Error("sealed DeepSeek credential was not recovered");
if (Object.keys(process.env).some((name) => /(DEEPSEEK|ANTHROPIC|OMNISCI_API).*KEY/i.test(name))) {
  throw new Error("model credential names remain in the OmniScientist environment");
}
if (readFileSync("/proc/self/environ").includes(Buffer.from(sentinel))) {
  throw new Error("sealed credential remains visible in the OmniScientist /proc environment");
}

const probe = Bun.spawn(
  ["bash", "-lc", "env; tr '\\0' '\\n' < /proc/$PPID/environ"],
  { stdout: "pipe", stderr: "pipe", env: safeChildEnvironment() },
);
const [stdout, stderr, code] = await Promise.all([
  new Response(probe.stdout).text(),
  new Response(probe.stderr).text(),
  probe.exited,
]);
if (code !== 0) throw new Error(`credential child probe failed: ${stderr}`);
if (stdout.includes(sentinel)) throw new Error("research subprocess can recover a model credential");
process.stdout.write("Credential isolation smoke passed\n");
