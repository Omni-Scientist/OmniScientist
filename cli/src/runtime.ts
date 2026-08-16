/**
 * 让编译出来的单个可执行文件自己站得住。
 *
 * 开发时跑的是 `bun run src/cli.tsx`，仓库就在旁边，什么都好找；发行版是
 * `bun build --compile` 出来的一个文件，用户往 PATH 上一放就完事，旁边不会有
 * skills/ 目录，也不会有那个 bash 启动器帮忙读凭据。这两件事在这里补上：
 *
 *   installSkill()   把嵌进二进制的 skill 写到应用数据目录，用内容哈希判要不要重写
 *   loadEnvFile()    严格按 KEY=VALUE 读 ~/.omnisci/env，绝不当 shell 执行
 *
 * 开发布局下 skills/ 就在旁边，那就直接用，不多此一举落盘。
 */
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { SKILL_FILES } from "./skill-assets.generated.ts";

// 定义搬去了 paths.ts（零依赖，不拖内嵌 skill）。这里原样再导出，老引用不用动。
export { dataDir, OMNI_HOME } from "./paths.ts";
import { dataDir, OMNI_HOME } from "./paths.ts";

/**
 * 返回可用的 skills 目录。顺序：显式指定 > 旁边就有（开发布局）> 落盘嵌入的副本。
 */
export function installSkill(): string {
  if (process.env.OMNISCI_SKILLS_DIR) return resolve(process.env.OMNISCI_SKILLS_DIR);

  const adjacent = resolve(import.meta.dir, "..", "skills");
  if (existsSync(join(adjacent, "omnisci", "SKILL.md"))) return adjacent;

  const root = join(dataDir(), "skills");
  const dir = join(root, "omnisci");
  const names = Object.keys(SKILL_FILES).sort();

  const hash = createHash("sha256");
  for (const name of names) {
    hash.update(name);
    hash.update(readFileSync(SKILL_FILES[name]!));
  }
  const stamp = hash.digest("hex");
  const stampFile = join(dir, ".installed");
  if (existsSync(stampFile) && readFileSync(stampFile, "utf-8").trim() === stamp) return root;

  rmSync(dir, { recursive: true, force: true });
  for (const name of names) {
    const target = join(dir, name);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, readFileSync(SKILL_FILES[name]!));
    if (name.endsWith(".py")) chmodSync(target, 0o755);
  }
  writeFileSync(stampFile, stamp);
  return root;
}

/**
 * 严格按 KEY=VALUE 解析凭据文件。可选 export 前缀，可选成对引号。
 * 任何一行不合规就整个文件拒绝：读了一半比没读更难查。
 * 已经在环境里的值优先，命令行显式给的不该被文件覆盖。
 */
export function loadEnvFile(path = process.env.OMNISCI_ENV_FILE || join(OMNI_HOME, "env")): number {
  if (!existsSync(path)) return 0;
  const parsed: Array<[string, string]> = [];
  const lines = readFileSync(path, "utf-8").split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
    if (!m) return 0;
    let value = m[2]!.trim();
    if (value.length >= 2
      && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    parsed.push([m[1]!, value]);
  }
  for (const [k, v] of parsed) if (!process.env[k]) process.env[k] = v;
  return parsed.length;
}
