/**
 * 流式 markdown 转终端 ANSI。
 *
 * 为什么要有这个：在它之前模型吐出来的 markdown 是**原样**打到终端的，
 * `**粗体**` 就显示成带两个星号的字面量，标题、列表、代码块全无区分，
 * 加上空行在 UI 层被吞掉，整屏糊成一坨。
 *
 * 为什么按行渲染而不是攒整段：输出是流式的，攒整段等于要等模型说完才显示，
 * 那就没有流式的意义了。好在 markdown 的块级语法（标题、列表、引用、分割线）
 * 全是行内可判的，唯一跨行的状态是「在不在代码围栏里」，存在实例上即可。
 *
 * 排版三件事决定可读性，比配色重要得多：
 * 1. 左边距。文字贴着终端左边缘看着就是一堵墙。
 * 2. 宽度封顶。宽终端上一行铺满一百多列，眼睛回扫找不到下一行行首。
 * 3. 块之间留白。标题、代码块、列表前后各空一行。
 */

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const ITALIC = "\x1b[3m";
const UNDER = "\x1b[4m";
const STRIKE = "\x1b[9m";

// 256 色，比 truecolor 兼容面大。终端色板不同深浅会变，但对比关系保得住。
const C_H1 = "\x1b[1;38;5;39m";    // 一级标题，亮蓝加粗
const C_H2 = "\x1b[1;38;5;75m";    // 二级标题，浅蓝加粗
const C_H3 = "\x1b[1m";            // 三级往下只加粗，避免颜色太吵
const C_CODE = "\x1b[38;5;215m";   // 行内代码，暖橙
const C_FENCE = "\x1b[38;5;252m";  // 代码块正文，浅灰
const C_GUTTER = "\x1b[38;5;238m"; // 代码块和引用的左边槽
const C_BULLET = "\x1b[38;5;39m";  // 列表符号
const C_LINK = "\x1b[38;5;81m";    // 链接文字

/**
 * 空行的载荷。
 *
 * 不能用空串也不能用空格，两个都到不了屏幕：
 * Ink 对每行做 trimEnd()，空格被抹成空串；而 ink.js 里有一句
 * `hasStaticOutput = staticOutput && staticOutput !== "\n"`，
 * 当这一批新增的 static 行只有那个空行时整批被丢掉。
 * 流式输出下每个 chunk 常常只带一行，空行经常独自成批，于是基本全被吞。
 * 零宽空格不是 JS 的 whitespace，trimEnd() 不动它，视觉上又是空的。
 */
export const BLANK = "\u200b";

/** 判空要连零宽空格一起认，否则 BLANK 会被当成有内容的行。 */
export const isBlank = (s: string): boolean => /^[\s\u200b]*$/.test(s);

/** 正文左边距。所有输出行统一缩进，跟终端左边缘拉开距离。 */
const INDENT = "  ";
/** 一行最多多宽。再宽眼睛回扫会丢行。 */
const MAX_WIDTH = 92;

/** 一个带样式的文本片段。先切片段再折行，避免折行时把 ANSI 序列劈开。 */
interface Seg {
  text: string;
  style: string;
}

/**
 * 一个字符占几列。
 * 组合符号占 0，东亚宽字符和 emoji 占 2，其余占 1。
 * 中文按 1 算的话，折行宽度会算成实际的两倍，右边直接溢出。
 */
function charWidth(cp: number): number {
  if (cp === 0x200b || cp === 0x200d) return 0;
  if ((cp >= 0x0300 && cp <= 0x036f) || (cp >= 0xfe00 && cp <= 0xfe0f)) return 0;
  // 肤色修饰符是跟前一个 emoji 合成的，本身不占列
  if (cp >= 0x1f3fb && cp <= 0x1f3ff) return 0;
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f680 && cp <= 0x1f6ff) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x1fa70 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x2fffd)
  ) return 2;
  return 1;
}

/** 只吃 SGR 颜色序列。正文里可能混着公式降级时塞的 `\x1b[2m⟨3⟩\x1b[0m`。 */
const SGR = /^\x1b\[[0-9;]*m/;

/**
 * 按「显示单元」遍历字符串，ANSI 转义序列整段当零宽吐出来。
 * 不这么做的话转义字节会被算进可见宽度，折行提前发生，
 * 而且可能折在转义序列中间，屏幕上冒出一个裸的 `0m`。
 */
function* cells(s: string): Generator<{ ch: string; w: number }> {
  let i = 0;
  while (i < s.length) {
    if (s[i] === "\x1b") {
      const esc = SGR.exec(s.slice(i));
      if (esc) { yield { ch: esc[0], w: 0 }; i += esc[0].length; continue; }
    }
    const cp = s.codePointAt(i)!;
    const ch = String.fromCodePoint(cp);
    yield { ch, w: charWidth(cp) };
    i += ch.length;
  }
}

export function displayWidth(s: string): number {
  let w = 0;
  for (const c of cells(s)) w += c.w;
  return w;
}

/**
 * 行内标记解析。
 *
 * 顺序有讲究：行内代码必须最先吃掉，否则 `a * b` 里的星号会被当成强调，
 * 把代码内容改花。吃掉之后那一段就不再参与后面的匹配。
 */
function parseInline(src: string): Seg[] {
  const segs: Seg[] = [];
  // 先按反引号切，奇数段是代码，偶数段才继续找别的标记
  const parts = src.split(/(`+[^`]*?`+)/g);
  for (const part of parts) {
    if (!part) continue;
    const code = /^(`+)([\s\S]*?)\1$/.exec(part);
    if (code) {
      segs.push({ text: code[2] ?? "", style: C_CODE });
      continue;
    }
    segs.push(...parseEmphasis(part));
  }
  return segs;
}

/** 代码之外的部分：链接、粗体、斜体、删除线。 */
function parseEmphasis(src: string): Seg[] {
  const out: Seg[] = [];
  // 一次正则扫完所有标记，按匹配位置切，避免嵌套替换互相破坏
  // 两条硬性约束，都是审出来的：
  // 1. **不认下划线做强调**。`get_user_id` `__init__.py` `OMNISCI_FORMULA_PX` 这类
  //    词内下划线会被吃掉，屏幕上变成 `getuserid`，是内容篡改。
  //    模型压倒性地用 `**`，下划线那点收益换不来这个风险。
  // 2. 所有量词加上界。原来 `([^)\s]+)[^)]*\)` 两个字符集重叠的量词相邻，
  //    行里有 `](` 而后面不再出现 `)` 时按尾巴长度平方爆，
  //    实测 12 万字符卡 42 秒，Ink 单线程等于整个界面冻死。
  const re = /\[([^\]\n]{1,200})\]\(([^)\s]{1,500})[^)\n]{0,200}\)|\*\*([^\n]{1,400}?)\*\*|(?<![*\w])\*(?!\s)([^\n]{1,400}?)(?<!\s)\*(?!\*)|~~([^\n]{1,400}?)~~/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    if (m.index > last) out.push({ text: src.slice(last, m.index), style: "" });
    if (m[1] !== undefined) {
      // 链接：文字加下划线，地址跟在后面调暗。终端里点不了，但要能看见去哪
      out.push({ text: m[1], style: C_LINK + UNDER });
      out.push({ text: ` (${m[2]})`, style: DIM });
    } else if (m[3] !== undefined) {
      out.push({ text: m[3], style: BOLD });
    } else if (m[4] !== undefined) {
      out.push({ text: m[4], style: ITALIC });
    } else if (m[5] !== undefined) {
      out.push({ text: m[5], style: STRIKE });
    }
    last = re.lastIndex;
  }
  if (last < src.length) out.push({ text: src.slice(last), style: "" });
  return out;
}

/**
 * 按显示宽度折行。
 *
 * 中英混排要两套断点规则：拉丁文断在空格，中文任意字之间都能断。
 * 所以先找最近的空格，找不到（一整段中文）就当场断。
 */
function wrapSegs(segs: Seg[], width: number): Seg[][] {
  const lines: Seg[][] = [];
  let cur: Seg[] = [];
  let w = 0;

  const flush = () => {
    lines.push(cur);
    cur = [];
    w = 0;
  };

  for (const seg of segs) {
    let buf = "";
    for (const { ch, w: cw } of cells(seg.text)) {
      if (w + cw > width && (buf || cur.length)) {
        // 优先在空格处断，避免把英文单词劈成两半
        const sp = buf.lastIndexOf(" ");
        if (sp > 0 && displayWidth(buf.slice(sp + 1)) < width * 0.3) {
          const carry = buf.slice(sp + 1);
          cur.push({ text: buf.slice(0, sp), style: seg.style });
          flush();
          buf = carry;
          w = displayWidth(carry);
        } else {
          if (buf) cur.push({ text: buf, style: seg.style });
          flush();
          buf = "";
        }
      }
      buf += ch;
      w += cw;
    }
    if (buf) cur.push({ text: buf, style: seg.style });
  }
  if (cur.length) lines.push(cur);
  return lines.length ? lines : [[]];
}

function paint(segs: Seg[]): string {
  return segs.map((s) => (s.style ? s.style + s.text + RESET : s.text)).join("");
}

/** 块的种类，只用来决定块之间要不要空一行。 */
type Kind = "none" | "text" | "head" | "list" | "fence" | "quote" | "rule" | "table";

export class MarkdownStream {
  private inFence = false;
  private fenceLang = "";
  // 开栏用的是哪种符号、几个。不记的话代码块里的 ``` 会把外层关掉，
  // 而正文里一句 ~~~deleted~~~ 会开出一个语言名叫 deleted~~~ 的围栏，
  // 把后面所有输出吞成代码。
  private fenceChar = "";
  private fenceLen = 0;
  private prev: Kind = "none";
  /** 上一行是不是空行。用来避免连着吐两个空行。 */
  private blank = true;

  constructor(private cols: number) {}

  setWidth(cols: number): void {
    this.cols = cols;
  }

  private get wrapWidth(): number {
    // 下限不能高于终端实际能显示的宽度，否则窄终端上算出来的行比屏幕还宽，
    // 终端自己硬折，续行没有缩进，版式塌掉。
    return Math.max(8, Math.min(this.cols - INDENT.length - 2, MAX_WIDTH));
  }

  /** 块之间补一个空行。已经是空行就不补，避免堆出一片空白。 */
  private gap(out: string[]): void {
    if (!this.blank && this.prev !== "none") {
      // 必须是空格不能是空串：Ink 的 measureText("") 高度算 0，
      // 渲染成空的 static 行会被整个丢掉，空行等于白加。
      out.push(BLANK);
      this.blank = true;
    }
  }

  private emit(out: string[], line: string): void {
    out.push(line);
    this.blank = isBlank(line);
  }

  /**
   * 吃一行原始文本，吐零到多行渲染好的显示行。
   * 传进来的是不带换行符的单行。
   */
  push(raw: string): string[] {
    const out: string[] = [];
    const line = raw.replace(/\s+$/, "");

    // 代码围栏优先，围栏里的一切都不当 markdown 解析。
    // 信息串里不许再出现围栏符号，否则 ~~~deleted~~~ 会被当成开栏。
    const fence = /^ {0,3}(`{3,}|~{3,})[ \t]*([^`~]*)$/.exec(line);
    if (this.inFence) {
      const mark = fence?.[1];
      if (mark && mark[0] === this.fenceChar && mark.length >= this.fenceLen) {
        this.inFence = false;
        this.emit(out, `${INDENT}${C_GUTTER}╰${"─".repeat(Math.min(this.wrapWidth, 40))}${RESET}`);
        this.prev = "fence";
        return out;
      }
      // 代码不折行也不改内容，宁可让终端自己截断，也不能把代码改花
      this.emit(out, `${INDENT}${C_GUTTER}│${RESET} ${C_FENCE}${line}${RESET}`);
      return out;
    }
    if (fence) {
      this.gap(out);
      this.inFence = true;
      this.fenceChar = fence[1]![0]!;
      this.fenceLen = fence[1]!.length;
      this.fenceLang = (fence[2] ?? "").trim();
      const tag = this.fenceLang ? ` ${this.fenceLang} ` : "";
      const bar = "─".repeat(Math.max(0, Math.min(this.wrapWidth, 40) - displayWidth(tag)));
      this.emit(out, `${INDENT}${C_GUTTER}╭${tag}${bar}${RESET}`);
      this.prev = "fence";
      return out;
    }

    // 空行：如实保留，但连续空行压成一个
    if (!line.trim()) {
      if (!this.blank) this.emit(out, BLANK);
      this.prev = this.prev === "none" ? "none" : this.prev;
      return out;
    }

    // 分割线
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      this.gap(out);
      this.emit(out, `${INDENT}${C_GUTTER}${"─".repeat(Math.min(this.wrapWidth, 48))}${RESET}`);
      this.prev = "rule";
      return out;
    }

    // 标题
    const head = /^(#{1,6})\s+(.*)$/.exec(line);
    if (head) {
      this.gap(out);
      const level = head[1]!.length;
      const style = level === 1 ? C_H1 : level === 2 ? C_H2 : C_H3;
      // 段落里没有自己样式的片段才套标题样式，行内代码之类保留自己的颜色。
      // 别在外面再包一层 style，那样会把同一个样式码打印两遍。
      const segs = parseInline(head[2] ?? "").map((s) => ({ ...s, style: s.style || style }));
      for (const l of wrapSegs(segs, this.wrapWidth)) this.emit(out, INDENT + paint(l));
      // 标题下面空一行，跟正文拉开
      this.emit(out, BLANK);
      this.prev = "head";
      return out;
    }

    // 引用
    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (quote) {
      if (this.prev !== "quote") this.gap(out);
      for (const l of wrapSegs(parseInline(quote[1] ?? ""), this.wrapWidth - 2)) {
        this.emit(out, `${INDENT}${C_GUTTER}▏${RESET} ${DIM}${paint(l)}${RESET}`);
      }
      this.prev = "quote";
      return out;
    }

    // 列表，有序无序都认，保留原有的层级缩进
    const list = /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/.exec(line);
    if (list) {
      if (this.prev !== "list") this.gap(out);
      const pad = " ".repeat(Math.min(8, list[1]!.length));
      const marker = /^\d/.test(list[2]!) ? list[2]! : "•";
      const head2 = `${INDENT}${pad}${C_BULLET}${marker}${RESET} `;
      const hang = " ".repeat(displayWidth(`${INDENT}${pad}${marker} `));
      const wrapped = wrapSegs(parseInline(list[3] ?? ""), this.wrapWidth - displayWidth(pad) - 2);
      wrapped.forEach((l, i) => {
        this.emit(out, (i === 0 ? head2 : hang) + paint(l));
      });
      this.prev = "list";
      return out;
    }

    // 表格：不做对齐，只把竖线调暗，让内容能读
    if (/^\s*\|.*\|\s*$/.test(line)) {
      if (this.prev !== "table") this.gap(out);
      if (/^[\s|:-]+$/.test(line)) {
        this.emit(out, `${INDENT}${C_GUTTER}${line.trim()}${RESET}`);
      } else {
        // 表格也要折行。不折的话宽表原样吐出去，Ink 硬折出来的续行
        // 既没有缩进也没有分隔竖线，整块版式塌掉。
        const cols = line.trim().replace(/^\||\|$/g, "").split("|");
        const segs: Seg[] = [];
        cols.forEach((c, i) => {
          if (i) segs.push({ text: " │ ", style: C_GUTTER });
          segs.push(...parseInline(c.trim()));
        });
        for (const l of wrapSegs(segs, this.wrapWidth)) this.emit(out, INDENT + paint(l));
      }
      this.prev = "table";
      return out;
    }

    // 普通段落
    if (this.prev === "head") {
      // 标题后面已经空过一行了，不要再空
    } else if (this.prev !== "text" && this.prev !== "none") {
      // 列表、引用、表格、代码块、分割线之后接正文，都要隔开
      this.gap(out);
    }
    for (const l of wrapSegs(parseInline(line), this.wrapWidth)) {
      this.emit(out, INDENT + paint(l));
    }
    this.prev = "text";
    return out;
  }

  /** 流结束。围栏没闭合的话补上收尾，否则后面的输出会一直挂着左边槽。 */
  end(): string[] {
    const out: string[] = [];
    if (this.inFence) {
      this.inFence = false;
      this.emit(out, `${INDENT}${C_GUTTER}╰${"─".repeat(Math.min(this.wrapWidth, 40))}${RESET}`);
    }
    this.prev = "none";
    return out;
  }

  /** 换一轮，块间留白的状态要清掉，否则新一轮开头会多一个空行。 */
  reset(): void {
    this.inFence = false;
    this.fenceChar = "";
    this.fenceLen = 0;
    this.prev = "none";
    this.blank = true;
  }
}
