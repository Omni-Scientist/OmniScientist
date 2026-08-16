/**
 * Skill 支持。
 *
 * 跟 standards 的区别很重要，别混：
 *   standards  是「规矩」，命中处境就**注入**，agent 不用知道它存在，照做就行。
 *   skill      是「本事」，agent 知道有这么个东西，**需要时自己调**。
 *
 * 所以加载方式也不同。skill 走渐进式披露：系统提示里只放名字和一句话描述
 * （几十个 token），agent 判断用得上才调 use_skill 把正文取回来。
 * 全都塞进去会把上下文撑爆，而且大部分 skill 这次根本用不到。
 *
 * 目录布局，跟 Claude Code 的约定一致，已有的 skill 能直接拿来用：
 *   <omnisci>/skills/<名字>/SKILL.md       内置
 *   ~/.omnisci/skills/<名字>/SKILL.md     用户扩展
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";

import { OMNI_HOME } from "./soul.ts";
import type { Tool, ToolContext } from "./tools/index.ts";

export const SKILLS_DIR = join(OMNI_HOME, "skills");

/**
 * CLI 自带的 skill 在 cli/skills/ 下，**不是**仓库根那份。
 *
 * 两份是有意分叉的，不要"顺手统一"：这一份的感知闭环靠 view_image 写出的回执
 * （sha256 绑定图像、问题、观察三者），闸门会验这个绑定；仓库根 skill/ 那份是
 * 给 Claude Code 用的，宿主直接用自己的眼睛看，压根没有回执可验。互换就是坏的。
 */
export const BUILTIN_SKILLS_DIR = resolve(
  process.env.OMNISCI_SKILLS_DIR ?? join(import.meta.dir, "..", "skills"),
);
export const SKILL_DIRS = [...new Set([BUILTIN_SKILLS_DIR, SKILLS_DIR])];

const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/;

export interface Skill {
  name: string;
  description: string;
  body: string;
  dir: string;
  /** 除 SKILL.md 之外还带了哪些文件，供 agent 自己去读 */
  resources: string[];
}

/**
 * 扫一个目录下的 skill。
 * 格式坏了就抛，不跳过：一个静默失效的 skill 比没有更糟，
 * agent 会以为自己有这个本事，实际调不出来。
 */
export function loadSkills(dirs: string | string[] = SKILL_DIRS): Skill[] {
  const out: Skill[] = [];
  const seen = new Map<string, string>();

  for (const dir of typeof dirs === "string" ? [dirs] : dirs) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir).sort()) {
      const sub = join(dir, name);
      if (!statSync(sub).isDirectory()) continue;
      const md = join(sub, "SKILL.md");
      if (!existsSync(md)) continue;

      const raw = readFileSync(md, "utf-8");
      const m = FRONTMATTER_RE.exec(raw);
      if (!m) throw new Error(`skill 缺少 YAML frontmatter: ${md}`);
      const meta = (parseYaml(m[1]!) ?? {}) as Record<string, unknown>;
      const body = (m[2] ?? "").trim();
      if (!body) throw new Error(`skill 正文是空的: ${md}`);
      if (!meta.description) {
        throw new Error(`skill 缺少 description，agent 没法判断什么时候用它: ${md}`);
      }

      const skillName = String(meta.name ?? name);
      const previous = seen.get(skillName);
      if (previous) {
        throw new Error(`skill 重名 ${skillName}: ${previous} 和 ${md}`);
      }
      seen.set(skillName, md);

      const resources = readdirSync(sub)
        .filter((f) => f !== "SKILL.md")
        .map((f) => f);

      out.push({
        name: skillName,
        description: String(meta.description),
        body,
        dir: sub,
        resources,
      });
    }
  }
  return out;
}

/** 进系统提示的那一小段：只有名字和描述，不含正文。 */
export function skillsPromptBlock(skills: Skill[]): string {
  if (!skills.length) return "";
  const lines = skills.map((s) => `- ${s.name}: ${s.description}`);
  return [
    "# 可用的 skill",
    "这些是可选能力，不是当前任务。不要仅凭工作区里的文件自行启动任何 skill。",
    "只有用户当前请求匹配某项 description 时，才调 use_skill 取回完整说明并照着做。",
    "用不上就别调。",
    "",
    ...lines,
  ].join("\n");
}

export function makeUseSkillTool(skills: () => Skill[]): Tool {
  return {
    name: "use_skill",
    description:
      "取回某个 skill 的完整说明。系统提示里列了有哪些 skill，判断用得上再调这个把正文拿回来。",
    parameters: {
      type: "object",
      properties: { name: { type: "string", description: "skill 名字" } },
      required: ["name"],
    },
    summarize: (a) => String(a.name ?? ""),
    run: (args, _ctx: ToolContext) => {
      const want = String(args.name);
      const all = skills();
      const s = all.find((x) => x.name === want);
      if (!s) {
        throw new Error(
          `没有叫 ${want} 的 skill。现有的是: ${all.map((x) => x.name).join(", ") || "（一个都没有）"}`,
        );
      }
      const res = s.resources.length
        ? `\n\n这个 skill 还带了这些文件，要用就自己读：\n${s.resources.map((r) => join(s.dir, r)).join("\n")}`
        : "";
      const runtime = s.name === "omnisci"
        ? `\n\nOmniScientist 已把 OMNISCI 设为 ${join(s.dir, "bin")}。视觉请求必须用 view_image 查看后再 ingest；最终记录、引用和编译必须分别调用 omnisci_record、omnisci_bib、omnisci_compile，不能用 bash 替代。`
        : "";
      return `${s.body}${res}${runtime}`;
    },
  };
}
