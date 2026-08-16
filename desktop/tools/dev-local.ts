import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

const webRoot = resolve(import.meta.dir, "..");
const repoRoot = resolve(webRoot, "..");
// 工作区默认取 cwd。取仓库的上级目录会让一次忘了传参的启动把整个上级目录
// 暴露成可读写范围，gateway 那边同理。
const workspaceRoot = resolve(process.env.OMNISCI_WORKSPACE_ROOT ?? process.cwd());
// CLI 自带的那份 skill，不是仓库根 skill/ 那份，两者的感知闭环不一样
const skillsRoot = resolve(process.env.OMNISCI_SKILLS_DIR ?? join(repoRoot, "cli", "skills"));
const skillBin = resolve(process.env.OMNISCI ?? join(skillsRoot, "omnisci", "bin"));
const gatewayPort = process.env.OMNISCI_GATEWAY_PORT ?? "4318";
const uiPort = process.env.OMNISCI_UI_PORT ?? "4317";
const token = crypto.randomUUID();

for (const cli of ["evidence_cli.py", "gate_cli.py", "paper_cli.py"]) {
  if (!existsSync(join(skillBin, cli))) {
    throw new Error(`OmniScientist CLI 缺失: ${join(skillBin, cli)}`);
  }
}

const sharedEnv = {
  ...process.env,
  OMNISCI_SKILLS_DIR: skillsRoot,
  OMNISCI: skillBin,
  OMNISCI_WEB_TOKEN: token,
  OMNISCI_GATEWAY_PORT: gatewayPort,
  OMNISCI_WORKSPACE_ROOT: workspaceRoot,
};

const gateway = Bun.spawn(["bun", "run", "gateway/server.ts"], {
  cwd: webRoot,
  env: sharedEnv,
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});

const vite = Bun.spawn(["bun", "run", "dev", "--", "--host", "127.0.0.1", "--port", uiPort], {
  cwd: webRoot,
  env: { ...sharedEnv, VITE_OMNISCI_LIVE: "1" },
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});

let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  gateway.kill();
  vite.kill();
}

process.on("SIGINT", stop);
process.on("SIGTERM", stop);

const code = await Promise.race([gateway.exited, vite.exited]);
stop();
await Promise.allSettled([gateway.exited, vite.exited]);
process.exitCode = code;
