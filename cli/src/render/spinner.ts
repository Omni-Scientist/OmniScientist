/**
 * 等待指示器：照 OmniScientist logo 的八重对称做的旋转点。
 *
 * logo 是「六圆母版按 45 度旋转八次」，八条臂。这里把它压成盲文点阵的
 * 八个环位，一个彗星头带两级拖尾绕圈跑。
 *
 * 明暗交接怎么来的：两个盲文格各占环的一半（左半 / 右半），
 * 每格的灰度取它当前点亮的最亮那一点。彗星头在右半时右格亮左格暗，
 * 转过去就反过来，明暗边界跟着转，不是整体闪。
 *
 * 4 宽 x 4 高的点阵 = 正好两个盲文字符：
 *
 *      . p0 p1 .        环位按顺时针 p0..p7
 *     p7 .  . p2
 *     p6 .  . p3
 *      . p5 p4 .
 */

// (x, y)，x 是点列 0..3，y 是点行 0..3
const RING: Array<[number, number]> = [
  [1, 0], [2, 0], [3, 1], [3, 2], [2, 3], [1, 3], [0, 2], [0, 1],
];

// 盲文一个格是 2 列 x 4 行，每个点对应一个 bit
const DOT_BITS: number[][] = [
  //  行0    行1    行2    行3
  [0x01, 0x02, 0x04, 0x40], // 格内左列
  [0x08, 0x10, 0x20, 0x80], // 格内右列
];

const BRAILLE_BASE = 0x2800;

// 内圈的四个点位，顺时针。外圈转的同时内圈反着转，两圈同时亮，
// 整体更厚更显眼，也就看得出在动。
const INNER: Array<[number, number]> = [[1, 1], [2, 1], [2, 2], [1, 2]];

// 灰阶：数组末尾永远是彗星头，往前依次是拖尾。
//
// 极性必须跟着终端背景走。深色背景上头要最亮，浅色背景上头要最深，
// 否则头是那个跟背景最接近的颜色，看着就是「灰点在前、尾巴不明显」。
const RAMP_ON_DARK = [236, 240, 245, 250, 255];
const RAMP_ON_LIGHT = [250, 245, 240, 235, 232];
let GRAY = RAMP_ON_DARK;

/** 终端背景是深色还是浅色。由 cli 在查到 OSC 11 背景色之后调。 */
export function setDark(dark: boolean): void {
  GRAY = dark ? RAMP_ON_DARK : RAMP_ON_LIGHT;
}
const gray = (n: number) => `\x1b[38;5;${n}m`;
const RESET = "\x1b[0m";

/** 生成第 step 帧（0..7）。返回可以直接写进终端的字符串。 */
export function frame(step: number): string {
  // 每格记录：点亮的 bit 掩码，以及该格最亮的那一级
  const cells = [
    { bits: 0, level: -1 },
    { bits: 0, level: -1 },
  ];

  const lite = (x: number, y: number, level: number) => {
    const cell = cells[x < 2 ? 0 : 1]!;
    cell.bits |= DOT_BITS[x % 2]![y]!;
    cell.level = Math.max(cell.level, level);
  };

  // 外圈彗星：头在 step，往回依次是拖尾，亮度递减
  for (let back = 0; back < GRAY.length; back++) {
    const [x, y] = RING[(step - back + RING.length * 2) % RING.length]!;
    lite(x, y, GRAY.length - 1 - back);
  }
  // 内圈：反方向转，永远落在头的另一侧，让暗的那半格也有东西亮着
  const [ix, iy] = INNER[(INNER.length * 2 - step) % INNER.length]!;
  lite(ix, iy, 1);

  const head = Math.max(cells[0]!.level, cells[1]!.level);
  return cells
    .map((c) => {
      if (!c.bits) return " ";
      // 头所在那一格加粗，跟拖尾拉开一档，八格里哪个是头一眼能看出来
      const bold = c.level === head ? "\x1b[1m" : "";
      return `${bold}${gray(GRAY[c.level]!)}${String.fromCharCode(BRAILLE_BASE + c.bits)}${RESET}`;
    })
    .join("");
}

export const FRAME_COUNT = RING.length;

/**
 * 挂在终端上转。占一行，stop() 把这行擦掉，不留痕迹，
 * 后面的真实输出接着写就行。
 */
export class Spinner {
  private timer: ReturnType<typeof setInterval> | null = null;
  private step = 0;
  private shown = false;

  constructor(
    // 标签可以是个函数：每帧现算，这样耗时这类会变的东西能跟着跳
    private label: string | (() => string) = "",
    private intervalMs = 90,
    private stream: NodeJS.WriteStream = process.stdout,
  ) {}

  start(): void {
    if (this.timer || !this.stream.isTTY) return;
    this.stream.write("\x1b[?25l"); // 藏光标，不然光标跟着帧闪
    this.render();
    this.timer = setInterval(() => {
      this.step = (this.step + 1) % FRAME_COUNT;
      this.render();
    }, this.intervalMs);
  }

  /** 转的时候换个说明文字，比如从「思考中」变成「跑 bash」。 */
  setLabel(label: string | (() => string)): void {
    this.label = label;
    if (this.timer) this.render();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.shown) {
      this.stream.write("\r\x1b[K");
      this.shown = false;
    }
    if (this.stream.isTTY) this.stream.write("\x1b[?25h"); // 光标放回来
  }

  private render(): void {
    const text = typeof this.label === "function" ? this.label() : this.label;
    const tail = text ? ` \x1b[2m${text}\x1b[0m` : "";
    this.stream.write(`\r\x1b[K  ${frame(this.step)}${tail}`);
    this.shown = true;
  }
}
