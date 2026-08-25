/**
 * 下载新版本产物，边下边核对 SHA256SUMS。
 *
 * 单独一个文件是为了能测。之前这段代码住在 main.ts 里，而那个文件一 import
 * 就会起服务、抢端口、写锁文件，于是"下载并校验"这件事从来没有被真正测过，
 * 只能靠肉眼看。而这段代码干的事情是往用户盘上放一个他接下来要双击的可执行
 * 文件，正是最不该只靠肉眼的那种。
 */
import { createHash } from "node:crypto";
import { mkdirSync, renameSync, rmSync } from "node:fs";
import path, { join } from "node:path";

import type { DownloadState } from "../src/types.ts";

/**
 * target 是不是真的落在 dir 里面。
 *
 * 给 reveal 那个接口用：它会把路径交给系统的文件管理器打开，所以必须挡住
 * 下载目录以外的一切，不能变成一个任意路径的打开器。
 *
 * 两边都过 resolve，`..` 才会被展平；用 p.sep 不用写死的 "/"，否则 Windows 上
 * join() 给的是反斜杠，前缀永远对不上，这个功能等于整个不存在（真发生过）。
 * 末尾补一个分隔符是为了挡住同前缀的兄弟目录，比如 updates-evil。
 *
 * p 可以传 path.win32，这样在 macOS 上也能测 Windows 的语义。
 */
export function isInside(dir: string, target: string, p: typeof path = path): boolean {
  if (!target) return false;
  return p.resolve(target).startsWith(p.resolve(dir) + p.sep);
}

export interface UpdateAsset {
  name: string;
  url: string;
  /** release 的 SHA256SUMS 地址。没有就不下，见 downloadUpdate。 */
  sumsUrl?: string;
}

export type { DownloadState } from "../src/types.ts";

/**
 * 能被界面翻译的错误。
 *
 * key 用中文原文并带 {0} 占位符，跟 locales/ 那套词条完全同源；args 是要填进去的值。
 * 直接抛拼好的字符串的话，界面只能原样显示，于是英文用户会在错误提示里看到中文。
 * 这条路以前就是这样的：下载失败时整句中文糊在英文界面上。
 */
export class DownloadError extends Error {
  constructor(readonly key: string, readonly args: Array<string | number> = []) {
    super(key.replace(/\{(\d+)\}/g, (whole, i: string) => String(args[Number(i)] ?? whole)));
    this.name = "DownloadError";
  }
}

/**
 * 下载并校验，返回落盘路径和字节数。
 *
 * 每个 release 都带一份 SHA256SUMS（一行一个产物），装机脚本核的也是这份。
 * 这里同样核：边下边算 sha256，下完跟表里那行比，对不上就把文件删掉再抛错。
 *
 * 没有 sumsUrl（老 release 没挂这个文件）时如实拒绝，不做"那就不校验了"的降级。
 *
 * 边下边写 .part 而不是先 arrayBuffer() 再落盘，有两个原因：Windows 包 120 MB
 * 起，整个读进内存就是 120 MB 的常驻；以及只有校验过的文件才配拿到最终文件名，
 * 中途断了留在盘上的是个 .part，不会被人当成一个能双击的安装包。
 */
export async function downloadUpdate(
  asset: UpdateAsset,
  dir: string,
  onProgress: (received: number, total: number) => void,
  signal: AbortSignal,
): Promise<{ path: string; bytes: number }> {
  if (!asset.sumsUrl) throw new DownloadError("这个版本没有 SHA256SUMS，无法校验，已中止下载");

  const sumsRes = await fetch(asset.sumsUrl, { signal });
  if (!sumsRes.ok) throw new DownloadError("取 SHA256SUMS 失败：{0}", [sumsRes.status]);
  const sums = await sumsRes.text();
  // 每行是 "<hash>  <name>"，第二列可能带 * 前缀（sha256sum 的二进制模式）
  const want = sums.split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/))
    .find((parts) => parts.length >= 2 && parts[1]!.replace(/^\*/, "") === asset.name)?.[0];
  if (!want) throw new DownloadError("SHA256SUMS 里没有 {0}", [asset.name]);

  mkdirSync(dir, { recursive: true });
  const target = join(dir, asset.name);
  const partial = `${target}.part`;

  const res = await fetch(asset.url, { signal });
  if (!res.ok) throw new DownloadError("下载失败：{0}", [res.status]);
  if (!res.body) throw new DownloadError("下载没有返回内容");
  const total = Number(res.headers.get("content-length") ?? 0);

  const hash = createHash("sha256");
  // 先删。Bun.file().writer() 不截断，它从偏移 0 往上覆盖，旧文件比这次长的话
  // 尾巴会原样留着。而 sha256 算的是网络流不是盘上那个文件，于是校验照样通过，
  // 一个尾部挂着上一版残骸的文件被改名成最终产物，界面还报"已通过校验"。
  // 产物名不带版本号（OmniSci-Desktop-macOS.zip），每次发版共用同一个
  // .part 路径，断电或者强杀之后再下一个小一点的版本就会撞上。
  rmSync(partial, { force: true });
  const sink = Bun.file(partial).writer();
  let received = 0;
  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      sink.write(chunk);
      hash.update(chunk);
      received += chunk.byteLength;
      onProgress(received, total);
    }
    await sink.end();
  } catch (error) {
    // end() 自己也可能抛（盘满、被删）。这里已经在处理另一个错误了，
    // 原来那个才是根因，所以关闭失败只丢弃，不让它顶掉根因。
    try {
      await sink.end();
    } catch {
      // 无所谓，下一行就把这个半截文件删了
    }
    rmSync(partial, { force: true });
    throw error;
  }

  const got = hash.digest("hex");
  if (got !== want) {
    rmSync(partial, { force: true });
    throw new DownloadError("校验和不匹配，下载的文件已删除（期望 {0}…，实得 {1}…）",
      [want.slice(0, 12), got.slice(0, 12)]);
  }
  try {
    renameSync(partial, target);
  } catch (error) {
    // 改名也会失败：Windows 上目标位置那个安装包已经被用户双击运行了，
    // 就是 EPERM。别把一个完整大小的 .part 留在盘上，它会变成下一次下载的
    // 陈旧残骸（见上面 rmSync 那段）。
    rmSync(partial, { force: true });
    throw error;
  }
  return { path: target, bytes: received };
}

/**
 * 一次只跑一个下载，进度记在自己身上，供 HTTP 层轮询。
 *
 * 下载放在服务端而不是页面里，是因为 120 MB 要下好几分钟，而用户在这期间关掉
 * 设置面板、刷新页面都是很正常的事，不该因此把下载弄没。
 *
 * 每次 start 都拿新建的 AbortController 当身份牌，所有回调先对牌再写状态。
 * 不对牌的话，"取消再重下"会出事：被取消那次的 promise 晚一步落地，它的回调
 * 看到的是新那次的状态，于是把正在下的那次改写成"已取消"或者"已完成"。
 */
export class UpdateDownloader {
  #state: DownloadState = { state: "idle" };
  #abort: AbortController | undefined;

  /**
   * dir 传函数不传字符串：下载目录来自 dataDir()，而它每次都重读
   * OMNISCI_DATA_DIR。在模块初始化时求值一次的话，启动流程里后设的那份覆盖
   * 就不算数了，下载会落到另一个目录，而 reveal 只认这一个，于是"在文件夹中
   * 显示"永远报路径不对。
   *
   * download 只有测试会传。这个类真正难对的是时序（取消那次的 promise 比新
   * 那次晚落地），而拿真服务去凑这个时序是碰运气，测出来的红绿都不作数。
   */
  constructor(
    private readonly dir: () => string,
    private readonly onLog: (message: string) => void = () => {},
    private readonly download: typeof downloadUpdate = downloadUpdate,
  ) {}

  get state(): DownloadState {
    return this.#state;
  }

  /** 已经在下了就什么都不做，重复点按钮不会下两遍。 */
  start(asset: UpdateAsset, version: string): void {
    if (this.#state.state === "downloading") return;
    const mine = new AbortController();
    this.#abort = mine;
    this.#state = { state: "downloading", name: asset.name, version, received: 0, total: 0 };

    void this.download(
      asset,
      this.dir(),
      (received, total) => {
        if (this.#abort !== mine || this.#state.state !== "downloading") return;
        this.#state = { ...this.#state, received, total };
      },
      mine.signal,
    ).then(
      ({ path, bytes }) => {
        if (this.#abort !== mine) return;
        this.#state = { state: "done", name: asset.name, version, path, total: bytes };
        this.onLog(`新版本已下载到 ${path}`);
      },
      (error: unknown) => {
        if (this.#abort !== mine) return;
        const message = error instanceof Error ? error.message : String(error);
        // 认识的错误连 key 一起往上带，界面才翻得动；不认识的（fetch 自己抛的
        // 超时、断网）只有 message，如实照搬。
        this.#state = error instanceof DownloadError
          ? { state: "error", message, key: error.key, args: error.args }
          : { state: "error", message };
        this.onLog(`下载新版本失败：${message}`);
      },
    );
  }

  /**
   * 取消并立刻回到 idle。
   *
   * 状态同步就地改掉，不等 fetch 的 reject 落地：等的话这中间用户再点一次下载
   * 会被"已经在下了"挡掉，看着像按钮坏了。身份牌一并清空，那次迟到的 reject
   * 对不上牌，不会再碰状态。
   */
  cancel(): void {
    // 只有正在下的时候才认。#abort 在下载成功后不会被清空，光判它非空的话，
    // 下完之后再点一次取消（界面每秒才轮询一次，那个按钮完全可能还停在
    // 取消上）会把 done 连同文件路径一起抹成 idle，那个已经校验通过的
    // 120 MB 包就在盘上但界面上再也找不回来了。
    if (this.#state.state !== "downloading") return;
    const mine = this.#abort;
    if (!mine) return;
    this.#abort = undefined;
    this.#state = { state: "idle" };
    mine.abort();
  }

  /**
   * 忘掉上一次下载的结果。
   *
   * done 会在进程里一直挂着。下过 0.1.3 之后 0.1.4 发布了，界面仍然显示
   * "0.1.3 已下载并通过校验"，"在文件夹中显示"指着旧包，而 0.1.4 的下载按钮
   * 根本出不来。启动器是长期运行的，这不是什么罕见时序。
   */
  forget(): void {
    if (this.#state.state === "downloading") return;
    this.#state = { state: "idle" };
  }
}
