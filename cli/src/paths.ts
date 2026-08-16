/**
 * 应用自己的两个目录。
 *
 * 单独一个文件是有原因的：runtime.ts 里同样有这两个，但它顺带 import 了
 * skill-assets.generated.ts（几 MB 的内嵌 skill）。凡是只想知道"数据目录在哪"的
 * 模块，一旦从 runtime.ts 拿，就把那几 MB 拖进自己所在的二进制。桌面版启动器
 * 已经有自己那份内嵌资源，再拖一份纯属白涨体积。
 *
 * 所以这里保持零依赖。runtime.ts 原样再导出，老的引用不用改。
 */
import { homedir, platform } from "node:os";
import { join } from "node:path";

/** 凭据、会话库、更新检查状态都在这儿。 */
export const OMNI_HOME = join(homedir(), ".omnisci");

/** 应用数据目录，按平台惯例。落盘的 skill、受管 venv、受管 tectonic 放这里。 */
export function dataDir(): string {
  if (platform() === "darwin") return join(homedir(), "Library", "Application Support", "OmniScientist");
  if (platform() === "win32") {
    return join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "OmniScientist");
  }
  return join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "omniscientist");
}
