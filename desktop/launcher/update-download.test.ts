/**
 * 更新下载器的测试。
 *
 * 这段代码干的事情是往用户盘上放一个他接下来要双击的可执行文件，所以关心的
 * 不是"能不能下下来"，而是"下坏了会不会留在盘上"。每条用例都顺带断言 .part
 * 有没有清干净。
 *
 * 起一个真的 HTTP 服务，不 mock fetch：要测的恰恰是流式读、中途 abort、
 * content-length 缺失这些真实传输行为，mock 掉就什么都没测到。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { join } from "node:path";

import { UpdateDownloader, downloadUpdate, isInside } from "./update-download.ts";

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

// Response 的 BodyInit 不收 Buffer / Uint8Array<ArrayBufferLike>，切一份真正的
// ArrayBuffer 出来给它
const body = (bytes: Buffer): ArrayBuffer =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

interface Fixture {
  url: (path: string) => string;
  stop: () => void;
}

/**
 * 一个小服务，按路径给不同的东西：
 *   /sums      SHA256SUMS 正文，由 sums 参数决定
 *   /asset     产物本体，一次性发完
 *   /slow      产物本体，分块慢发，用来测中途取消
 *   /nolength  产物本体，但不带 content-length
 */
function serve(payload: Buffer, sums: string): Fixture {
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/sums") return new Response(sums);
      if (path === "/asset") return new Response(body(payload));
      if (path === "/missing") return new Response("nope", { status: 404 });
      if (path === "/nolength") {
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(payload));
              controller.close();
            },
          }),
          // 明确不给 content-length，让前端走"不确定进度"那条分支
          { headers: { "Content-Type": "application/octet-stream" } },
        );
      }
      if (path === "/slow") {
        return new Response(
          new ReadableStream({
            async pull(controller) {
              controller.enqueue(new Uint8Array(payload.subarray(0, 1)));
              await Bun.sleep(50);
            },
          }),
        );
      }
      return new Response("?", { status: 400 });
    },
  });
  return {
    url: (path) => `http://127.0.0.1:${server.port}${path}`,
    stop: () => server.stop(true),
  };
}

// Buffer 而不是 Uint8Array：Response 的 BodyInit 不收 Uint8Array<ArrayBufferLike>
const PAYLOAD = Buffer.from("x".repeat(5000));
const NAME = "OmniScientist-9.9.9.tar.gz";

let dir: string;
let fixture: Fixture;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omnisci-update-"));
  fixture = serve(PAYLOAD, `${sha256(PAYLOAD)}  ${NAME}\n`);
});

afterEach(() => {
  fixture.stop();
  rmSync(dir, { recursive: true, force: true });
});

const asset = (path = "/asset") => ({
  name: NAME,
  url: fixture.url(path),
  sumsUrl: fixture.url("/sums"),
});

const noop = () => {};
const never = new AbortController().signal;

describe("downloadUpdate", () => {
  test("下完校验通过，落到最终文件名，不留 .part", async () => {
    const got = await downloadUpdate(asset(), dir, noop, never);

    expect(got.path).toBe(join(dir, NAME));
    expect(got.bytes).toBe(PAYLOAD.byteLength);
    expect(readFileSync(got.path)).toEqual(PAYLOAD);
    expect(existsSync(`${got.path}.part`)).toBe(false);
  });

  test("进度回调单调递增，最后一次等于总字节数", async () => {
    const seen: number[] = [];
    await downloadUpdate(asset(), dir, (received) => seen.push(received), never);

    expect(seen.length).toBeGreaterThan(0);
    expect(seen.at(-1)).toBe(PAYLOAD.byteLength);
    expect([...seen].sort((a, b) => a - b)).toEqual(seen);
  });

  test("服务器不给 content-length 时照样下得完，total 报 0", async () => {
    const totals: number[] = [];
    const got = await downloadUpdate(asset("/nolength"), dir, (_r, total) => totals.push(total), never);

    expect(got.bytes).toBe(PAYLOAD.byteLength);
    expect(totals.every((t) => t === 0)).toBe(true);
  });

  test("SHA256SUMS 里的 * 前缀（二进制模式）要认", async () => {
    fixture.stop();
    fixture = serve(PAYLOAD, `${sha256(PAYLOAD)} *${NAME}\n`);

    const got = await downloadUpdate(asset(), dir, noop, never);
    expect(existsSync(got.path)).toBe(true);
  });

  test("校验和对不上就删掉，最终文件名一个字节都不留", async () => {
    fixture.stop();
    fixture = serve(PAYLOAD, `${"0".repeat(64)}  ${NAME}\n`);

    await expect(downloadUpdate(asset(), dir, noop, never)).rejects.toThrow(/校验和不匹配/);
    expect(existsSync(join(dir, NAME))).toBe(false);
    expect(existsSync(join(dir, `${NAME}.part`))).toBe(false);
  });

  test("没有 sumsUrl 就直接拒绝，不做不校验的降级", async () => {
    await expect(
      downloadUpdate({ name: NAME, url: fixture.url("/asset") }, dir, noop, never),
    ).rejects.toThrow(/SHA256SUMS/);
    expect(existsSync(join(dir, NAME))).toBe(false);
  });

  test("SHA256SUMS 里没有这个产物名就拒绝", async () => {
    fixture.stop();
    fixture = serve(PAYLOAD, `${sha256(PAYLOAD)}  something-else.tar.gz\n`);

    await expect(downloadUpdate(asset(), dir, noop, never)).rejects.toThrow(/没有/);
    expect(existsSync(join(dir, NAME))).toBe(false);
  });

  test("取 SHA256SUMS 失败要如实报错", async () => {
    await expect(
      downloadUpdate(
        { name: NAME, url: fixture.url("/asset"), sumsUrl: fixture.url("/missing") },
        dir, noop, never,
      ),
    ).rejects.toThrow(/404/);
  });

  test("产物 404 要如实报错", async () => {
    await expect(downloadUpdate(asset("/missing"), dir, noop, never)).rejects.toThrow(/404/);
    expect(existsSync(join(dir, `${NAME}.part`))).toBe(false);
  });

  test("下到一半取消，半截文件不留在盘上", async () => {
    const control = new AbortController();
    // 立刻挂上处理器，不留"已经 reject 但还没人接"的窗口。留了的话 Bun 会
    // 把它算成 unhandled rejection 直接判红，而且报的位置跟真正的原因无关。
    const settled = downloadUpdate(asset("/slow"), dir, noop, control.signal)
      .then(() => "resolved" as const, (error: unknown) => error);

    // 等 .part 真出现再取消，不拿固定 sleep 猜"下到一半"。猜的那版在机器忙的
    // 时候会落在"还没开始写"上，四十轮里红过一次，而且失败信息完全指错方向。
    const partial = join(dir, `${NAME}.part`);
    for (let i = 0; i < 300 && !existsSync(partial); i++) await Bun.sleep(10);
    expect(existsSync(partial)).toBe(true);

    control.abort();
    expect(await settled).not.toBe("resolved");
    expect(existsSync(join(dir, NAME))).toBe(false);
    expect(existsSync(partial)).toBe(false);
  });

  test("上一次崩掉留下的 .part 比这次大时，尾巴不许留下", async () => {
    // Bun.file().writer() 不截断，是从偏移 0 往上覆盖写。旧文件更长的话尾巴
    // 原样留着，而 sha256 算的是网络流不是盘上那个文件，于是校验照样通过、
    // 损坏的文件被改名成最终产物、界面报"已通过校验"。
    //
    // 旧文件必须比 payload 大这条才测得到。第一版写的是 3000 字节对 5000 字节的
    // payload，残骸正好被盖满，删不删都是绿的，等于没测。
    writeFileSync(join(dir, `${NAME}.part`), Buffer.alloc(PAYLOAD.byteLength + 3000, 0x5a));

    const got = await downloadUpdate(asset(), dir, noop, never);
    expect(statSync(got.path).size).toBe(PAYLOAD.byteLength);
    expect(readFileSync(got.path)).toEqual(PAYLOAD);
  });

  test("改名失败时不留下一个完整大小的 .part", async () => {
    // 目标位置占着一个目录，renameSync 必然 EISDIR。真实世界对应的是 Windows 上
    // 用户已经双击运行了那个安装包，改名报 EPERM。
    mkdirSync(join(dir, NAME));

    await expect(downloadUpdate(asset(), dir, noop, never)).rejects.toThrow();
    expect(existsSync(join(dir, `${NAME}.part`))).toBe(false);
  });
});

describe("UpdateDownloader", () => {
  const wait = async (check: () => boolean) => {
    for (let i = 0; i < 200 && !check(); i++) await Bun.sleep(10);
    expect(check()).toBe(true);
  };

  test("跑完停在 done，带着路径和字节数", async () => {
    const d = new UpdateDownloader(() => dir);
    d.start(asset(), "9.9.9");
    expect(d.state.state).toBe("downloading");

    await wait(() => d.state.state === "done");
    expect(d.state).toMatchObject({ state: "done", version: "9.9.9", total: PAYLOAD.byteLength });
  });

  test("正在下的时候再点一次不会下第二遍", async () => {
    const d = new UpdateDownloader(() => dir);
    d.start(asset("/slow"), "9.9.9");
    const first = d.state;
    d.start(asset("/slow"), "9.9.9");

    expect(d.state).toBe(first);
    d.cancel();
  });

  test("取消后立刻回到 idle，不用等 fetch 那边落地", () => {
    const d = new UpdateDownloader(() => dir);
    d.start(asset("/slow"), "9.9.9");
    d.cancel();

    expect(d.state.state).toBe("idle");
  });

  /**
   * 时序用注入的假下载函数来摆，不靠真网络。
   *
   * 要测的那个坑是"被取消那次的 promise 比新那次晚落地"，拿真服务器去凑这个
   * 顺序纯属碰运气：abort 的 reject 通常一两毫秒就到，根本排不到新那次后面，
   * 于是把保护代码删掉测试照样绿。
   */
  function deferredDownloads() {
    const calls: Array<{
      resolve: (value: { path: string; bytes: number }) => void;
      reject: (error: Error) => void;
      progress: (received: number, total: number) => void;
    }> = [];
    const fake: typeof downloadUpdate = (_asset, _dir, onProgress) =>
      new Promise((resolve, reject) => {
        calls.push({ resolve, reject, progress: onProgress });
      });
    return { calls, fake };
  }

  test("取消那次晚落地时，不许改到新那次的状态上", async () => {
    const { calls, fake } = deferredDownloads();
    const d = new UpdateDownloader(() => dir, noop, fake);

    d.start(asset(), "9.9.9");          // 第一次
    d.cancel();
    d.start(asset(), "9.9.9");          // 第二次，立刻接上
    expect(d.state.state).toBe("downloading");

    // 第二次先跑完
    calls[1]!.resolve({ path: join(dir, NAME), bytes: 5000 });
    await wait(() => d.state.state === "done");

    // 第一次的 reject 现在才落地。没有身份牌的话，用户会看到一个"下载已取消"
    // 或者"下载失败"，而文件其实好好地下完躺在盘上。
    calls[0]!.reject(new Error("aborted"));
    await Bun.sleep(20);
    expect(d.state.state).toBe("done");
  });

  test("取消那次的进度回调不许再动状态", async () => {
    const { calls, fake } = deferredDownloads();
    const d = new UpdateDownloader(() => dir, noop, fake);

    d.start(asset(), "9.9.9");
    d.cancel();
    expect(d.state.state).toBe("idle");

    // 取消之后网络那边还可能再吐一两块数据出来
    calls[0]!.progress(4096, 5000);
    expect(d.state.state).toBe("idle");
  });

  test("取消那次晚落地时，不许把 idle 改成 error", async () => {
    const { calls, fake } = deferredDownloads();
    const d = new UpdateDownloader(() => dir, noop, fake);

    d.start(asset(), "9.9.9");
    d.cancel();
    calls[0]!.reject(new Error("aborted"));
    await Bun.sleep(20);

    // 是用户自己取消的，不该在界面上留一条红字说下载失败
    expect(d.state.state).toBe("idle");
  });

  test("失败停在 error，原因说得出来", async () => {
    const d = new UpdateDownloader(() => dir);
    d.start({ name: NAME, url: fixture.url("/asset") }, "9.9.9");

    await wait(() => d.state.state === "error");
    expect(d.state).toMatchObject({ state: "error" });
    expect((d.state as { message: string }).message).toMatch(/SHA256SUMS/);
  });

  test("下完之后再点取消，不许把结果连同路径一起抹掉", async () => {
    const d = new UpdateDownloader(() => dir);
    d.start(asset(), "9.9.9");
    await wait(() => d.state.state === "done");
    const done = d.state;

    // 界面每秒才轮询一次，取消按钮完全可能还停在上一帧
    d.cancel();
    expect(d.state).toEqual(done);
  });

  test("forget 只丢弃已经结束的那次，不碰正在下的", async () => {
    const { calls, fake } = deferredDownloads();
    const d = new UpdateDownloader(() => dir, noop, fake);

    d.start(asset(), "9.9.9");
    d.forget();
    expect(d.state.state).toBe("downloading");

    calls[0]!.resolve({ path: join(dir, NAME), bytes: 5000 });
    await wait(() => d.state.state === "done");
    d.forget();
    expect(d.state.state).toBe("idle");
  });

  test("下载目录是每次现取的，不是构造时定死的", async () => {
    let where = dir;
    const d = new UpdateDownloader(() => where);
    const moved = mkdtempSync(join(tmpdir(), "omnisci-moved-"));
    where = moved;

    d.start(asset(), "9.9.9");
    await wait(() => d.state.state === "done");
    expect((d.state as { path: string }).path).toBe(join(moved, NAME));
    rmSync(moved, { recursive: true, force: true });
  });
});

describe("isInside", () => {
  // 这个判断挡的是 reveal 接口，它会把路径交给系统文件管理器打开。
  // 传 path.win32 是为了在 macOS 上也能覆盖 Windows 语义：那条路以前因为
  // 分隔符写死成 "/" 而整个失效过，本机跑测试是看不出来的。
  const posix = path.posix;
  const win32 = path.win32;

  test("目录里的文件放行", () => {
    expect(isInside("/data/updates", "/data/updates/a.tar.gz", posix)).toBe(true);
    expect(isInside("C:\\data\\updates", "C:\\data\\updates\\a.zip", win32)).toBe(true);
  });

  test("目录外的一律拒绝", () => {
    expect(isInside("/data/updates", "/etc/passwd", posix)).toBe(false);
    expect(isInside("C:\\data\\updates", "C:\\Windows\\System32\\cmd.exe", win32)).toBe(false);
  });

  test(".. 穿越挡得住", () => {
    expect(isInside("/data/updates", "/data/updates/../../etc/passwd", posix)).toBe(false);
    expect(isInside("C:\\data\\updates", "C:\\data\\updates\\..\\..\\Windows\\x", win32)).toBe(false);
  });

  test("同前缀的兄弟目录不算在里面", () => {
    expect(isInside("/data/updates", "/data/updates-evil/x", posix)).toBe(false);
    expect(isInside("C:\\data\\updates", "C:\\data\\updates-evil\\x", win32)).toBe(false);
  });

  test("目录自己不算在里面", () => {
    expect(isInside("/data/updates", "/data/updates", posix)).toBe(false);
  });

  test("空路径拒绝", () => {
    expect(isInside("/data/updates", "", posix)).toBe(false);
  });

  test("Windows 上正斜杠也认", () => {
    // 前端把服务端给的路径原样回传，但手敲过来的可能是正斜杠
    expect(isInside("C:\\data\\updates", "C:/data/updates/a.zip", win32)).toBe(true);
  });
});

describe("detect 的语言匹配", () => {
  // detect() 在浏览器里跑，这里只测它依赖的那条匹配规则：整串优先、再退第一段。
  // 直接测 i18n.tsx 要拉 React 和 localStorage，代价远大于收益。
  const LANGS = ["en", "zh", "fr", "es", "zh-Hant", "ja", "ko", "pt", "de", "ru"];
  const pick = (nav: string) => {
    const low = nav.toLowerCase();
    // 长的先比，否则 zh 会抢在 zh-Hant 前面把 zh-hant-tw 吃掉
    const longest = [...LANGS].sort((a, b) => b.length - a.length);
    const full = longest.find((c) => c.toLowerCase() === low || low.startsWith(`${c.toLowerCase()}-`));
    if (full) return full;
    return LANGS.find((c) => c === (low.split("-")[0] ?? "")) ?? "en";
  };

  test("繁体浏览器要给繁体，不是简体", () => {
    expect(pick("zh-Hant-TW")).toBe("zh-Hant");
    expect(pick("zh-hant")).toBe("zh-Hant");
  });

  test("简体和其他 zh 变体仍然给简体", () => {
    expect(pick("zh-CN")).toBe("zh");
    expect(pick("zh-Hans-CN")).toBe("zh");
    expect(pick("zh")).toBe("zh");
  });

  test("常规语言按第一段匹配", () => {
    expect(pick("pt-BR")).toBe("pt");
    expect(pick("ja")).toBe("ja");
    expect(pick("de-AT")).toBe("de");
  });

  test("不认识的退英文", () => {
    expect(pick("sv-SE")).toBe("en");
    expect(pick("")).toBe("en");
  });
});
