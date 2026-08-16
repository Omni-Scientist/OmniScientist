/**
 * 公式渲染。
 *
 * 路线 A：LaTeX -> MathJax 出 SVG -> resvg 转 PNG -> kitty graphics 内联显示。
 *   比 Python 版的 matplotlib mathtext 强：支持矩阵环境和多行 align。
 * 路线 B：LaTeX -> Unicode 近似。任何终端都能看，能复制能 grep，但会丢帽子和上下限。
 *
 * 默认混合：展示公式走 A，行内公式走 B（图片跟文字基线对不齐，反而更难读）。
 * 终端不支持图片时全部退 B，并在启动行明说降级了。
 */

import { type Capabilities, columns, wrapForTmux } from "./caps.ts";

// MathJax 和 resvg 加起来 161ms 的加载成本，但只有真渲染公式时才需要。
// 一次性任务和纯文字对话根本用不到，所以惰性加载，别拖冷启动。

/** ```svg 和 ```tikz 围栏块，模型用它们画图 */
// 语言标记后面不强制要求换行：模型经常直接写 ```tikz\\begin{tikzpicture}
export const DIAGRAM_RE = /```[ \t]*(svg|tikz)[ \t]*\r?\n?([\s\S]*?)```/g;

/**
 * 原始块哨兵。渲染结果里被这对标记包住的部分必须整块直写 stdout，
 * 不能进 Ink 的布局和样式管线（图片会被撕烂、光标移动会被吞掉）。
 */
export const RAW_SENTINEL = "\u0000\u0001PH_RAW\u0001\u0000";
export const RAW_MARK = "\u0002";

export const DISPLAY_RE = /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]/g;
export const INLINE_RE = /(?<!\$)\$([^$\n]+?)\$(?!\$)/g;

const GREEK: Record<string, string> = {
  alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ε", zeta: "ζ",
  eta: "η", theta: "θ", iota: "ι", kappa: "κ", lambda: "λ", mu: "μ", nu: "ν",
  xi: "ξ", pi: "π", rho: "ρ", sigma: "σ", tau: "τ", phi: "φ", chi: "χ",
  psi: "ψ", omega: "ω", Gamma: "Γ", Delta: "Δ", Theta: "Θ", Lambda: "Λ",
  Xi: "Ξ", Pi: "Π", Sigma: "Σ", Phi: "Φ", Psi: "Ψ", Omega: "Ω",
};
const OPS: Record<string, string> = {
  sum: "∑", prod: "∏", int: "∫", infty: "∞", partial: "∂", nabla: "∇",
  times: "×", cdot: "·", pm: "±", leq: "≤", geq: "≥", neq: "≠", equiv: "≡",
  propto: "∝", in: "∈", notin: "∉", subset: "⊂", cup: "∪", cap: "∩",
  rightarrow: "→", leftarrow: "←", Rightarrow: "⇒", to: "→", forall: "∀",
  exists: "∃", sqrt: "√", sim: "~", top: "⊤", perp: "⊥", cdots: "⋯",
  ldots: "…", dots: "…", circ: "∘", star: "⋆", oplus: "⊕", otimes: "⊗",
  subseteq: "⊆", supseteq: "⊇", ne: "≠", le: "≤", ge: "≥", mid: "|",
  langle: "⟨", rangle: "⟩", ell: "ℓ", odot: "⊙", cong: "≅", simeq: "≃",
};
const STRIP = ["left", "right", "mathcal", "mathbb", "mathbf", "mathrm",
               "text", "displaystyle", "quad", "qquad",
               "Bigg", "bigg", "Big", "big", "operatorname", "limits", "nolimits"];

const SUP_MAP: Record<string, string> = {
  "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴", "5": "⁵", "6": "⁶",
  "7": "⁷", "8": "⁸", "9": "⁹", "+": "⁺", "-": "⁻", "=": "⁼", "(": "⁽",
  ")": "⁾", n: "ⁿ", i: "ⁱ", k: "ᵏ", j: "ʲ", t: "ᵗ", T: "ᵀ", N: "ᴺ",
  M: "ᴹ", K: "ᴷ", L: "ᴸ",
};
const SUB_MAP: Record<string, string> = {
  "0": "₀", "1": "₁", "2": "₂", "3": "₃", "4": "₄", "5": "₅", "6": "₆",
  "7": "₇", "8": "₈", "9": "₉", "+": "₊", "-": "₋", "=": "₌", "(": "₍",
  ")": "₎", a: "ₐ", e: "ₑ", i: "ᵢ", o: "ₒ", x: "ₓ", j: "ⱼ", k: "ₖ",
  m: "ₘ", n: "ₙ", s: "ₛ", t: "ₜ", p: "ₚ", h: "ₕ",
};
const ACCENTS: Array<[string, string]> = [
  ["hat", "̂"], ["bar", "̄"], ["tilde", "̃"], ["vec", "⃗"],
];

const translate = (s: string, map: Record<string, string>) =>
  [...s].map((ch) => map[ch] ?? ch).join("");

/** 从 `{` 开始取一整组，支持嵌套。返回内容和右花括号之后的下标。 */
function takeGroup(s: string, open: number): [content: string, next: number] | null {
  if (s[open] !== "{") return null;
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === "{") depth++;
    else if (s[i] === "}") {
      depth--;
      if (depth === 0) return [s.slice(open + 1, i), i + 1];
    }
  }
  return null; // 没配平，说明公式被截断了，交给调用方原样留着
}

/**
 * 把 \frac{a}{b} 展平成 (a)/(b)，支持嵌套。
 * 之前用一条不许嵌套的正则，碰上 \frac{QK^\top}{\sqrt{d_k}} 直接不匹配，
 * 结果输出里留下一个裸的 frac，很难看。
 */
function flattenFrac(s: string): string {
  for (let guard = 0; guard < 16; guard++) {
    const at = s.indexOf("\\frac");
    if (at < 0) return s;
    let i = at + 5;
    while (s[i] === " ") i++;
    const num = takeGroup(s, i);
    if (!num) return s;
    let j = num[1];
    while (s[j] === " ") j++;
    const den = takeGroup(s, j);
    if (!den) return s;
    s = `${s.slice(0, at)}(${flattenFrac(num[0])})/(${flattenFrac(den[0])})${s.slice(den[1])}`;
  }
  return s;
}

/** 路线 B。刻意保守：拿不准的结构原样留着，不瞎猜。 */
export function toUnicode(tex: string): string {
  let s = flattenFrac(tex.trim());

  // 收尾用「后面不跟字母」而不是 \b：\sum_{i} 里 m 和 _ 都是 word char，
  // \b 在那儿不成立，结果 \sum 永远换不掉。Python 版踩过这个坑。
  for (const [name, ch] of Object.entries({ ...GREEK, ...OPS })) {
    s = s.replace(new RegExp(`\\\\${name}(?![A-Za-z])`, "g"), ch);
  }
  // 重音要在宏替换之后处理，否则 \hat{\theta} 花括号里还是宏，匹配不到
  for (const [macro, combining] of ACCENTS) {
    s = s.replace(new RegExp(`\\\\${macro}\\s*\\{?([^\\s{}\\\\])\\}?`, "g"),
                  (_m, c: string) => c + combining);
  }
  for (const name of STRIP) s = s.replaceAll(`\\${name}`, "");

  s = s.replace(/\^\{([^{}]*)\}/g, (_m, g: string) => translate(g, SUP_MAP));
  s = s.replace(/_\{([^{}]*)\}/g, (_m, g: string) => translate(g, SUB_MAP));
  s = s.replace(/\^(\w)/g, (_m, g: string) => translate(g, SUP_MAP));
  s = s.replace(/_(\w)/g, (_m, g: string) => translate(g, SUB_MAP));

  return s.replace(/[{}\\]/g, "").replace(/\s+/g, " ").trim();
}

/**
 * `$...$` 里包的到底是不是公式。
 *
 * 模型经常把整句中文误包进 $...$，比如「$q和一组键值对(k_i, v_i)$」。
 * 照着当公式转会把好好的句子搅烂。含中日韩字符就当它是模型放错了分隔符，
 * 原样留着，宁可少转一个也不要毁一句话。
 */
const CJK_RE = /[　-〿぀-ヿ一-鿿＀-￯]/;

export function looksLikeMath(tex: string): boolean {
  return !CJK_RE.test(tex);
}

// MathJax 文档建一次就够，重复建很慢。第一次真要渲染时才建。
let engine: { adaptor: any; mjDoc: any; Resvg: any } | null = null;

function getEngine() {
  if (engine) return engine;
  const { liteAdaptor } = require("mathjax-full/js/adaptors/liteAdaptor.js");
  const { RegisterHTMLHandler } = require("mathjax-full/js/handlers/html.js");
  const { TeX } = require("mathjax-full/js/input/tex.js");
  const { AllPackages } = require("mathjax-full/js/input/tex/AllPackages.js");
  const { mathjax } = require("mathjax-full/js/mathjax.js");
  const { SVG } = require("mathjax-full/js/output/svg.js");
  const { Resvg } = require("@resvg/resvg-js");

  const adaptor = liteAdaptor();
  RegisterHTMLHandler(adaptor);
  const mjDoc = mathjax.document("", {
    InputJax: new TeX({ packages: AllPackages }),
    OutputJax: new SVG({ fontCache: "local" }),
  });
  engine = { adaptor, mjDoc, Resvg };
  return engine;
}

const pngCache = new Map<string, Buffer>();

/**
 * 一行文字大概占多少物理像素，用来决定公式渲多大。
 *
 * 关键点：kitty 协议的 r= 会把图缩放到指定行数。往下缩没事，往上放必糊。
 * Retina 屏上三行的物理高度远超一百像素，之前按 56 像素渲再放大，糊得没法看。
 * 所以这里给足，让终端只做下采样。屏幕更密就把 OMNISCI_FORMULA_PX 调大。
 */
const PX_PER_ROW = Number(process.env.OMNISCI_FORMULA_PX) || 72;

// 一行正文大概 2.4ex 高。拿它把公式的自然高度换算成占几行，
// 这样 x=1 只占一行、分式占两行、带上下限的求和占三行，
// 各个公式的字号看起来才是一致的。以前一律压成 3 行，
// 短公式被撑得巨大，长公式被压扁。
const EX_PER_ROW = 2.4;
const MAX_ROWS = 8;

/**
 * 字符格的宽高比（宽/高）。0.5 是常见值但只是估算。
 * 真实值靠 CSI 16 t 问终端，问到了就用真的，见 setCellAspect。
 * 这个数直接决定 overlay 时源码能铺多宽，估错了源码就从图边上露出来。
 */
let cellAspect = 0.5;

export function setCellAspect(a: number): void {
  if (a > 0.1 && a < 1.5) cellAspect = a;
}

export function currentCellAspect(): number {
  return cellAspect;
}

/**
 * resvg 选项。`loadSystemFonts: false` 是关键：
 * MathJax 的 SVG 输出全是路径，没有一个 <text> 元素，根本不需要字体。
 * 但 resvg 默认每次 new 都去扫系统字体库，实测 733ms 一条。
 * 关掉之后 0.7ms，快一千倍。别手贱把它打开。
 */
const RESVG_OPTS = (heightPx: number) => ({
  fitTo: { mode: "height" as const, value: heightPx },
  font: { loadSystemFonts: false },
});

export interface Rendered {
  png: Buffer;
  rows: number;
  /** 图大概占多少个字符格宽。overlay 要按这个排版，不能按终端宽。 */
  cols: number;
}

const cache = new Map<string, Rendered>();

/**
 * 路线 A 的渲染。渲染不出来就抛，让人知道是哪条公式吃不下，
 * 不画一个错的糊弄过去。
 */
/** 拿 MathJax 出一段 SVG，同时把它的自然宽高（ex 单位）取出来。 */
function texSvg(tex: string): { svg: string; wEx: number; hEx: number } {
  const { adaptor, mjDoc } = getEngine();
  const svg = adaptor.innerHTML(mjDoc.convert(tex, { display: true })) as string;
  if (svg.includes("merror") || !svg.includes("<svg")) {
    throw new Error(`MathJax 解析不了这条公式: ${tex.slice(0, 80)}`);
  }
  return {
    svg,
    wEx: Number(/width="([\d.]+)ex"/.exec(svg)?.[1] ?? 0),
    hEx: Number(/height="([\d.]+)ex"/.exec(svg)?.[1] ?? EX_PER_ROW),
  };
}

/** 剥掉 MathJax SVG 的外层标签，只要里面的内容，好嵌进别的 svg。 */
function svgInner(svg: string): string {
  const open = svg.indexOf(">", svg.indexOf("<svg"));
  const close = svg.lastIndexOf("</svg>");
  return svg.slice(open + 1, close);
}

function viewBoxOf(svg: string): string {
  return /viewBox="([^"]+)"/.exec(svg)?.[1] ?? "0 0 100 100";
}

export function renderTex(tex: string, maxCols = 80, color = "#7aa2f7", label?: number): Rendered {
  const key = `${tex}|${maxCols}|${color}|${label ?? ""}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const { Resvg } = getEngine();
  const main = texSvg(tex);
  let wEx = main.wEx;
  let hEx = main.hEx;
  let body = `<svg x="0" y="0" width="${main.wEx}" height="${main.hEx}" viewBox="${viewBoxOf(main.svg)}">${svgInner(main.svg)}</svg>`;

  // 编号画进图里，不用终端文字。
  // 理由：终端文字会跟着框选一起被复制，把 LaTeX 源码弄脏。
  // 画进 PNG 就跟文字彻底分离，复制到的只有源码。
  if (label !== undefined) {
    const tag = texSvg(`\\scriptstyle\\langle ${label}\\rangle`);
    const scale = 0.7;
    const gap = main.hEx * 0.25;
    const tw = tag.wEx * scale;
    const th = tag.hEx * scale;
    body += `<svg x="${main.wEx + gap}" y="${(main.hEx - th) / 2}" width="${tw}" height="${th}" ` +
            `viewBox="${viewBoxOf(tag.svg)}" opacity="0.4">${svgInner(tag.svg)}</svg>`;
    wEx = main.wEx + gap + tw;
    hEx = Math.max(main.hEx, th);
  }

  // xmlns:xlink 必须带上：MathJax 内部用 xlink:href 复用字形，
  // 外层不声明这个命名空间 resvg 直接解析失败。
  let svg =
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ` +
    `viewBox="0 0 ${wEx} ${hEx}">${body}</svg>`;
  // MathJax 用 currentColor 填色，resvg 不认，换成实色
  svg = svg.replaceAll("currentColor", color);

  const aspect = hEx > 0 ? wEx / hEx : 1;
  const byHeight = Math.ceil(hEx / EX_PER_ROW);
  // 横向放不下就压行数，宁可小一点也不要被右边界切掉
  const byWidth = Math.floor(Math.max(1, maxCols - 4) / Math.max(0.1, aspect / cellAspect));
  const rows = Math.max(1, Math.min(MAX_ROWS, byHeight, byWidth || 1));

  const png = new Resvg(svg, RESVG_OPTS(rows * PX_PER_ROW)).render().asPng();
  // 往下取整再减一格：宁可源码窄一点全被盖住，也不要多铺一格露在外面
  const cols = Math.max(1, Math.floor((rows * aspect) / cellAspect) - 1);
  const result = { png, rows, cols };
  cache.set(key, result);
  return result;
}

/** 老签名留着给测试用：按指定像素高度出图。 */
export function texToPng(tex: string, heightPx = PX_PER_ROW * 3, color = "#7aa2f7"): Buffer {
  const { adaptor, mjDoc, Resvg } = getEngine();
  const node = mjDoc.convert(tex, { display: true });
  let svg = adaptor.innerHTML(node) as string;
  if (svg.includes("merror") || !svg.includes("<svg")) {
    throw new Error(`MathJax 解析不了这条公式: ${tex.slice(0, 80)}`);
  }
  svg = svg.replaceAll("currentColor", color);
  svg = svg.replace(/(<svg[^>]*?)\swidth="[^"]*"/, "$1")
           .replace(/(<svg[^>]*?)\sheight="[^"]*"/, "$1");
  return new Resvg(svg, RESVG_OPTS(heightPx)).render().asPng();
}

/** kitty graphics 直传：a=T 传输并显示，f=100 表示载荷是 PNG，r= 缩放到几行高。 */
export function kittyEscape(png: Buffer, rows: number, keepCursor = false): string {
  const b64 = png.toString("base64");
  const chunks: string[] = [];
  for (let i = 0; i < b64.length; i += 4096) chunks.push(b64.slice(i, i + 4096));
  return chunks
    .map((chunk, i) => {
      const more = i === chunks.length - 1 ? 0 : 1;
      // C=1 表示画完不要移动光标。overlay 的行号计算全按这个前提写的，
      // 不发 C=1 的话终端会把光标移到图后面，后面的下移就多走了 rows-1 行。
      const ctrl = i === 0
        ? `a=T,f=100,r=${rows},m=${more}${keepCursor ? ",C=1" : ""}`
        : `m=${more}`;
      return `\x1b_G${ctrl};${chunk}\x1b\\`;
    })
    .join("");
}

/**
 * 把缓冲区切成「现在就能吐出去的」和「必须扣住的」两半。
 *
 * 存在的理由：公式要拿到完整的 $$...$$ 才能渲染成图，但正文不该跟着一起等。
 * 之前整段攒完再吐，看起来就是卡住半天然后一口气喷出来。现在只有落在
 * 未闭合公式里的那一小段被扣住，正文照常流。
 */
export function splitFlushable(buf: string): [flush: string, held: string] {
  let i = 0;
  let safe = 0; // 最后一个确定不在公式或代码块内部的位置

  while (i < buf.length) {
    if (buf.startsWith("$$", i)) {
      const end = buf.indexOf("$$", i + 2);
      if (end < 0) return [buf.slice(0, safe), buf.slice(safe)];
      i = end + 2;
      safe = i;
      continue;
    }
    if (buf.startsWith("\\[", i)) {
      const end = buf.indexOf("\\]", i + 2);
      if (end < 0) return [buf.slice(0, safe), buf.slice(safe)];
      i = end + 2;
      safe = i;
      continue;
    }
    if (buf[i] === "$") {
      // 行内公式必须在**同一行**内闭合。不加这条限制的话，正文里一个
      // 孤立的 $（$5、$PATH、$HOME）会跟后面 $$ 里的第一个 $ 配上，
      // 把展示公式劈成两半，这条消息之后的公式全都渲染不出来。
      const nl = buf.indexOf("\n", i + 1);
      const end = buf.indexOf("$", i + 1);
      if (end < 0) {
        // 本行内还没闭合：整行都还没收完就扣住，收完了就当它是普通美元号
        if (nl < 0) return [buf.slice(0, safe), buf.slice(safe)];
        i++;
        safe = i;
        continue;
      }
      if (nl >= 0 && end > nl) { i++; safe = i; continue; }
      i = end + 1;
      safe = i;
      continue;
    }
    i++;
    safe = i;
  }

  // 结尾是孤零零的反斜杠时先扣住，下一块可能把它拼成 \[。
  //
  // 这里**只**管反斜杠，不能顺手把 $ 也扣掉：没配对的 $ 上面的分支已经处理了，
  // 而一条正好收尾在缓冲区末尾的完整公式（...$$ 结尾）会被误拆掉最后一个 $，
  // 变成不配对，整条公式就漏成原文吐出去了。踩过一次。
  const flush = buf.slice(0, safe);
  if (flush.endsWith("\\")) {
    return [flush.slice(0, -1), "\\" + buf.slice(safe)];
  }
  return [flush, buf.slice(safe)];
}

/**
 * 图片下面要不要跟一行 LaTeX 源码。
 *
 * 为什么需要：kitty graphics 画出来的图片，那些终端格子里**没有文字**，
 * 鼠标划过去选中的是空的，复制粘贴什么都拿不到。这是协议的固有性质，绕不过去。
 * 唯一能让「选中即复制成源码」成立的办法，就是让源码作为真文字出现在屏幕上。
 *
 * 所以默认在图下面补一行暗色源码。嫌吵用 /formula clean 关掉，
 * 关掉之后还能用 /tex 走剪贴板。
 */
/**
 * 默认模式。
 *
 * 走过一圈弯路：先默认 src（图下面跟一行裸源码），但那行看起来像
 * 「这条公式没渲染出来」；改成 clean 又等于把复制功能关了，
 * 选中图片什么都拿不到。
 *
 * 所以默认 overlay：源码文字垫在图占的格子里，图画在文字之上。
 * 屏幕上看到的是图，终端自己的复制拿到的是源码，什么都不用管。
 * 排版按**图的实际格子宽度**，不是终端宽度，否则文字会从图右边露出来。
 * 装不下就自动退回 src，宁可多一行也不要露出半截。
 */
export type FormulaMode = "clean" | "src" | "overlay";

export const DEFAULT_MODE: FormulaMode =
  (process.env.PH_FORMULA_MODE as FormulaMode) || "overlay";

export class FormulaRenderer {
  /**
   * clean    只有图，最干净，靠 /tex 复制
   * src      图下面跟一行暗色源码，可鼠标选中（默认）
   * overlay  源码文字**垫在图底下**，选中图片区域直接复制到源码（实验）
   */
  mode: FormulaMode = DEFAULT_MODE;

  /**
   * 背景色 "R;G;B"。overlay 模式把源码染成这个颜色让它隐身。
   * 拿不到就退到 SGR 8（隐藏属性），再拿不到就只能显示出来。
   */
  bgColor: string | null = null;

  /** 兼容旧字段 */
  get showSource() { return this.mode !== "clean"; }
  set showSource(v: boolean) { this.mode = v ? "src" : "clean"; }

  /**
   * 渲染过的展示公式源码，按出现顺序。
   * 图片没法选中复制，这是 kitty graphics 的固有性质，
   * 所以把源码留在这儿，配合 /tex 走剪贴板。
   */
  readonly formulas: string[] = [];

  constructor(private caps: Capabilities) {}

  /** 行内公式一律 Unicode：图片跟文字基线对不齐，而且行内公式通常简单。 */
  private inlineUnicode(text: string): string {
    return text.replace(INLINE_RE, (whole: string, tex: string) =>
      looksLikeMath(tex) ? toUnicode(tex) : whole,
    );
  }

  /** 把一段可能含公式的文本变成能直接写进终端的字符串。 */
  render(text: string): string {
    if (!this.caps.canShowImages) {
      const t = text.replace(DISPLAY_RE, (_m, a?: string, b?: string) => {
        const tex = (a ?? b ?? "").trim();
        this.formulas.push(tex);
        return `\n  ${toUnicode(tex)} \x1b[2m⟨${this.formulas.length}⟩\x1b[0m\n`;
      });
      return this.inlineUnicode(t);
    }

    const out: string[] = [];
    let pos = 0;

    for (const m of text.matchAll(DISPLAY_RE)) {
      // 公式前后的空行压掉。模型爱写「正文\n\n$$...$$\n\n正文」，
      // 加上我们自己的换行就是两三行空白，公式浮在中间很难看。
      const before = this.inlineUnicode(text.slice(pos, m.index))
        .replace(/[ \t]*\n[\s]*$/, "\n");
      out.push(before);
      if (!before.endsWith("\n")) out.push("\n");

      const tex = (m[1] ?? m[2] ?? "").trim();
      this.formulas.push(tex);
      const label = this.formulas.length;

      const blockStart = out.length;
      try {
        const { png, rows, cols } = renderTex(tex, columns(), "#7aa2f7", label);
        const esc = kittyEscape(png, rows);
        const escC = kittyEscape(png, rows, true);

        if (this.mode === "overlay") {
          // 源码垫在图占的格子里，图画在上面。文字染成背景色所以看不见，
          // **正因为看不见，超出图的范围也无所谓**，不需要容量检查。
          // 块高取「图的行数」和「源码要占的行数」里大的那个，
          // 通常就是图的行数，所以不额外占空间。
          const hide = this.bgColor ? `\x1b[38;2;${this.bgColor}m` : "\x1b[8m";
          const textRows = Math.max(1, Math.ceil(tex.length / cols));
          const blockRows = Math.max(rows, textRows);

          const lines: string[] = [];
          for (let i = 0; i < blockRows; i++) {
            lines.push(tex.slice(i * cols, (i + 1) * cols));
          }
          out.push(lines.map((l) => `  ${hide}${l}\x1b[0m`).join("\n"));

          // 回到块的左上角。写了 blockRows 行只产生 blockRows-1 个换行，
          // 光标停在最后一行上，所以往上退 blockRows-1 不是 blockRows。
          if (blockRows > 1) out.push(`\x1b[${blockRows - 1}A`);
          out.push("\r\x1b[2C");
          // 必须用带 C=1 的那份：下面的行号计算全按「画完光标不动」写的。
          // 发不带 C 的版本，终端会把光标移到图后面，后面再下移就多走 rows-1 行。
          out.push(this.caps.inTmux ? wrapForTmux(escC) : escC);

          // C=1 画完光标没动，还在左上角。走到图的右下角写序号，
          // 再走到整块的底部，免得后面的正文盖在块里。
          // 编号已经画进图里了，这里不再写终端文字，
          // 否则框选会把它一起复制走，弄脏源码。
          if (blockRows > 1) out.push(`\x1b[${blockRows - 1}B`);
          out.push("\r");
        } else {
          out.push("  ");
          out.push(this.caps.inTmux ? wrapForTmux(esc) : esc);
          if (this.mode === "src") out.push(`\n  \x1b[2m${tex}\x1b[0m`);
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        out.push(`  \x1b[2m[公式渲染失败: ${msg}]\x1b[0m\n  ${toUnicode(tex)}`);
      }
      // 整个公式块（隐形源码 + 光标移动 + 图片）包成一个原始单元
      const block = out.splice(blockStart).join("");
      out.push(`${RAW_SENTINEL}${RAW_MARK}${block}${RAW_SENTINEL}`);
      out.push("\n");
      pos = m.index + m[0].length;
    }

    // 公式后面紧跟的空行也压掉。
    //
    // 只在这次调用真的画了公式（pos 被推进过）时才压。
    // render() 是按流式 chunk 调的，无条件压的话，每个以换行开头的 chunk
    // 都会被吃掉一个换行，而 "\n\n" 单独成块在 SSE 里极其常见，
    // 结果就是段落分隔当场蒸发，整篇答复挤成一坨。
    // 之前一直在 UI 层找这个病因，病根在这儿。
    const tail = this.inlineUnicode(text.slice(pos));
    out.push(pos > 0 ? tail.replace(/^[\s]*\n/, "") : tail);
    return out.join("");
  }

}
