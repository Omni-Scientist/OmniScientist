import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/**
 * 界面选出来的数据目录可能是三种形态：脱敏展示（$WORKSPACE/xxx）、绝对路径、
 * 工作区相对路径。存进 runtime 前统一成工作区相对路径并正则化（吃掉 .. 和
 * 多余分隔符），模型看到的和工具解析的就永远是同一种，也永远不会把
 * $WORKSPACE 这种展示专用词带进工具调用。工作区根自身表示成 "."（空串是
 * 「没选」，不能混用）；表达不成工作区内相对路径的（越界、外部绝对路径）
 * 一律返回 ""，当没选处理。
 */
export function normalizeDataPath(workspaceRoot: string, value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  const v = trimmed.replace(/^\$WORKSPACE(?=$|[\\/])[\\/]*/, "");
  const abs = resolve(workspaceRoot, v);
  const rel = relative(workspaceRoot, abs);
  if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`) || rel.startsWith("../")) return "";
  return rel === "" ? "." : rel;
}

/**
 * 用户常选中 case 的 data/ 子目录。选中的目录没有 series.json 而上层有、且
 * 那份 series.json 的 members 确实列了这个子目录下的文件（上层真的认领它）
 * 时，把 dataPath 吸附到上层 case 根，工具链的 caseRoot 才会跟着对齐。
 * 不认领就不吸附：嵌在别人 case 里的无关裸目录必须还按裸数据走，绝不能把
 * 分析记进不相干的 ledger。
 */
export function snapToCase(workspaceRoot: string, dataPath: string): string {
  if (!dataPath || dataPath === ".") return dataPath;
  const chosen = resolve(workspaceRoot, dataPath);
  if (existsSync(join(chosen, "series.json"))) return dataPath;
  let probe = chosen;
  for (let i = 0; i < 3; i++) {
    const parent = dirname(probe);
    if (parent === probe) break;
    if (parent !== workspaceRoot && !parent.startsWith(workspaceRoot + sep)) break;
    probe = parent;
    const seriesPath = join(probe, "series.json");
    if (existsSync(seriesPath)) {
      if (claimsDir(seriesPath, probe, chosen)) return relative(workspaceRoot, probe) || ".";
      break;
    }
  }
  return dataPath;
}

function claimsDir(seriesPath: string, caseDir: string, sub: string): boolean {
  try {
    const doc = JSON.parse(readFileSync(seriesPath, "utf-8")) as { members?: unknown };
    const members = Array.isArray(doc?.members) ? doc.members : [];
    for (const m of members.slice(0, 200)) {
      const file = typeof (m as { file?: unknown })?.file === "string" ? (m as { file: string }).file : "";
      if (!file) continue;
      const abs = resolve(caseDir, file);
      // 成员文件在选中目录下面，或选中目录在某个成员所在目录的子树里，都算认领
      if (abs === sub || abs.startsWith(sub + sep)) return true;
      const dir = dirname(abs);
      if (sub === dir || sub.startsWith(dir + sep)) return true;
    }
  } catch {
    // series.json 坏了就当不认领，让上层按裸数据分支处理
  }
  return false;
}

/**
 * 每轮附带的 case 指路。dataPath 进来前已经过 normalizeDataPath + snapToCase，
 * 所以只剩两级：目录里就有 series.json；全是裸数据（先按 skill 的 case_cli
 * 流程建档，实在判断不出数据是什么才允许问用户一句，问完等回答）。
 */
export function caseHint(workspaceRoot: string, dataPath: string): string {
  const chosen = resolve(workspaceRoot, dataPath);
  if (existsSync(join(chosen, "series.json"))) {
    return `This is the case root for this run: series.json is inside it, omnisci_record / omnisci_compile ` +
      `use it as --task, and outputs land under ${dataPath}/host.`;
  }
  return `This directory has no series.json yet: the user gave bare data. First run case_cli.py inspect ` +
    `(see the skill) to learn what is inside, then init to write series.json (the case root is this ` +
    `directory), then research as usual. If inspect cannot tell what the data is either, ask the user in ` +
    `one short question what the data is about, end your turn, and init once they answer. If the file ` +
    `format itself is unsupported, tell the user honestly which formats are supported and ask them to ` +
    `convert; never fake it.`;
}
