/**
 * 副作用模块，必须是 cli.tsx 的第一条 import。
 *
 * 顺序是硬要求，不是风格问题：credentials.ts 和 skills.ts 都在**模块体**里读
 * process.env（前者读完就把密钥从环境里删掉，后者算 skill 目录）。ESM 按声明顺序
 * 求值依赖，所以只有排在它们前面，这里设的环境变量才来得及生效。
 *
 * 开发时跑 `bun run src/cli.tsx`，两件事都是空操作：凭据由启动脚本读过了，
 * skills/ 就在旁边。发行版是单个可执行文件，这两件事没人替它做。
 */
import { join } from "node:path";

import { installSkill, loadEnvFile } from "./runtime.ts";

loadEnvFile();
if (!process.env.OMNISCI_SKILLS_DIR) {
  try {
    process.env.OMNISCI_SKILLS_DIR = installSkill();
  } catch (error) {
    process.stderr.write(`装 skill 失败：${error instanceof Error ? error.message : String(error)}\n`);
  }
}

/**
 * 论文工具（omnisci_record / omnisci_bib / omnisci_compile）靠 OMNISCI 找那几个
 * python 脚本，没有就直接抛"OMNISCI 未设置"。
 *
 * 桌面版在 launcher 和 gateway 里都设了这一条，CLI 一直漏着，于是命令行永远编不出
 * 论文——而系统提示里还写着"已把 OMNISCI 设为 …"，那句话此前是假的。
 * 现在这里补上，那句话才成立。
 */
if (!process.env.OMNISCI && process.env.OMNISCI_SKILLS_DIR) {
  process.env.OMNISCI = join(process.env.OMNISCI_SKILLS_DIR, "omnisci", "bin");
}
