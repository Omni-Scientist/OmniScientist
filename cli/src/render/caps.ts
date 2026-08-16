/**
 * 终端能力探测。
 *
 * harness 里唯一跟「画面」有关的部分：知道当前终端支不支持内联图片，
 * 以及要不要为 tmux 包一层透传。
 *
 * 分层提醒（写给未来的自己）：
 *   终端模拟器（Ghostty/kitty/iTerm2）      决定能不能显示图片
 *   转义序列协议（kitty graphics/OSC1337）  决定怎么传图片
 *   渲染层（内联 REPL / 全屏 TUI）          决定布局长什么样
 *   harness（agent 循环）                   跟画面无关
 */

// 实测：cmux 内嵌 libghostty，完整实现 kitty graphics（含 PNG 解码、placement、
// 共享内存传输、图片淘汰），不支持 sixel。
const KITTY_GRAPHICS_TERMS = new Set(["ghostty", "kitty", "WezTerm"]);

export interface Capabilities {
  kittyGraphics: boolean;
  inTmux: boolean;
  isTty: boolean;
  canShowImages: boolean;
  /** 启动横幅用，必须短到不折行 */
  shortNote: string;
  /** /caps 用，把话说全 */
  note: string;
}

export function detect(): Capabilities {
  const env = process.env;
  const termProgram = env.TERM_PROGRAM ?? "";
  const kittyGraphics =
    KITTY_GRAPHICS_TERMS.has(termProgram) ||
    Boolean(env.KITTY_WINDOW_ID) ||
    Boolean(env.GHOSTTY_RESOURCES_DIR);
  const inTmux = Boolean(env.TMUX);
  const isTty = Boolean(process.stdout.isTTY);
  const canShowImages = kittyGraphics && isTty;

  let note: string;
  let shortNote: string;
  if (!isTty) {
    shortNote = "非终端输出，公式降级 Unicode";
    note = "输出不是终端，公式走 Unicode 降级";
  } else if (!kittyGraphics) {
    shortNote = `${termProgram || "未知终端"}，公式降级 Unicode`;
    note = `${termProgram || "未知终端"} 不支持 kitty graphics，公式走 Unicode 降级`;
  } else if (inTmux) {
    shortNote = "tmux 下图片可能残留";
    note =
      "tmux 下图片靠 passthrough 透传，能显示但滚屏或切 pane 会残留或丢失。" +
      "需要 tmux 里先 set -g allow-passthrough on";
  } else {
    shortNote = `${termProgram || "终端"}，公式内联渲染`;
    note = "kitty graphics 可用，公式内联渲染";
  }

  return { kittyGraphics, inTmux, isTty, canShowImages, shortNote, note };
}

/**
 * 问终端背景色是多少（OSC 11）。
 *
 * 用途：overlay 模式要把源码文字垫在公式图底下，但 MathJax 出的 PNG 是**透明**的，
 * 文字会从透明区域透出来。把文字染成跟背景一模一样的颜色就看不见了，
 * 而格子里字符还在，终端复制照样拿得到。
 *
 * 实测 Ghostty 支持 OSC 颜色上报（二进制里有 `]10;rgb:` 和 background-color 的处理）。
 * 查不到就返回 null，调用方退到 SGR 8 隐藏属性，再不行就显示出来，不装作成功。
 */
export function queryBackgroundColor(timeoutMs = 200): Promise<string | null> {
  const { stdin, stdout } = process;
  if (!stdin.isTTY || !stdout.isTTY) return Promise.resolve(null);

  return new Promise((resolve) => {
    let buf = "";
    let settled = false;
    const wasRaw = stdin.isRaw;

    const done = (v: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stdin.off("data", onData);
      // 一定要把终端恢复原状，否则后面的输入全乱
      if (!wasRaw) stdin.setRawMode(false);
      stdin.pause();
      resolve(v);
    };

    const onData = (d: Buffer) => {
      buf += d.toString("latin1");
      // 回应形如 ESC ] 11 ; rgb:RRRR/GGGG/BBBB (BEL 或 ST 收尾)
      const m = /\]11;rgb:([0-9a-f]{2,4})\/([0-9a-f]{2,4})\/([0-9a-f]{2,4})/i.exec(buf);
      if (m) {
        // 各家位宽不一（2 到 4 位十六进制），统一取高 8 位
        const to8 = (h: string) => parseInt(h.slice(0, 2), 16);
        done(`${to8(m[1]!)};${to8(m[2]!)};${to8(m[3]!)}`);
      }
    };

    const timer = setTimeout(() => done(null), timeoutMs);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
    stdout.write("\x1b]11;?\x07");
  });
}

/**
 * 问终端一个字符格是多少像素（CSI 16 t）。回应形如 ESC [ 6 ; 高 ; 宽 t。
 *
 * 用途：overlay 要知道公式图**实际占多少列**，才能把垫在底下的源码
 * 限制在图的范围内。之前按「格宽 = 格高的一半」估，行数少的公式
 * 源码就超出图的右边缘露出来了，行数多的反而藏住了，就是这个原因。
 *
 * 查不到返回 null，调用方退回保守估算。
 */
export function queryCellSize(timeoutMs = 200): Promise<{ w: number; h: number } | null> {
  const { stdin, stdout } = process;
  if (!stdin.isTTY || !stdout.isTTY) return Promise.resolve(null);

  return new Promise((resolve) => {
    let buf = "";
    let settled = false;
    const wasRaw = stdin.isRaw;

    const done = (v: { w: number; h: number } | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stdin.off("data", onData);
      if (!wasRaw) stdin.setRawMode(false);
      stdin.pause();
      resolve(v);
    };

    const onData = (d: Buffer) => {
      buf += d.toString("latin1");
      const m = /\x1b\[6;(\d+);(\d+)t/.exec(buf);
      if (m) done({ h: Number(m[1]), w: Number(m[2]) });
    };

    const timer = setTimeout(() => done(null), timeoutMs);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
    stdout.write("\x1b[16t");
  });
}

/**
 * 把一段转义序列包进 tmux 的 DCS 透传封套。
 * tmux 只是原样转发，它并不理解 kitty graphics，所以重绘时不会重画这些图。
 * 这是 tmux 的固有限制，不是这里能修的。
 */
export function wrapForTmux(escape: string): string {
  return `\x1bPtmux;${escape.replaceAll("\x1b", "\x1b\x1b")}\x1b\\`;
}

/**
 * 终端有多少列。
 *
 * `process.stdout.columns` 有三种"不知道"：管道里是 undefined，拿不到窗口大小的
 * 伪终端里是 0，窗口被拖到极窄时是 1 或 2。`?? 80` 只挡得住第一种，另外两种会
 * 一路传进 `"─".repeat(columns - 2)`，负数让 repeat 直接抛 RangeError——启动横幅
 * 画到一半，整个 CLI 就崩在一根分隔线上。
 */
export function columns(fallback = 80): number {
  const raw = process.stdout.columns;
  return typeof raw === "number" && raw > 0 ? raw : fallback;
}

/** 横幅上下那两根线。终端多窄都不该把它算成负数。 */
export function rule(max = 66, char = "─"): string {
  return char.repeat(Math.max(0, Math.min(columns() - 2, max)));
}
