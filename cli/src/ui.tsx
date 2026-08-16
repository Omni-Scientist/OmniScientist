/**
 * 常驻输入区。
 *
 * 关键设计：Ink **整个会话期间不卸载**。
 * 回车之后立刻就有一个空输入框在最下面，agent 在上面思考和输出，
 * 人可以在下面等着，也可以接着打下一句。
 *
 * 早先的版本是提交就卸载 Ink、跑完再挂回来。那样整轮思考期间下面没有输入框，
 * 只能干等；而且 Ink 卸载时不擦最后一帧，历史里会堆一串状态栏。
 *
 * 输出怎么走：文字进 Ink 的 <Static>，只渲染一次、永久留在上方。
 * 图片（kitty graphics 转义序列）不能进 Ink，它的布局引擎会把几 KB 的
 * 转义序列当成可见宽度算，图会被撕烂。所以图片先 clear() 掉活动区，
 * 直接写 stdout，再让 Ink 重绘。
 */

import { Box, render, Static, Text, useApp, useInput, useStdout } from "ink";
import TextInput from "ink-text-input";
import React, { useEffect, useLayoutEffect, useRef, useState } from "react";

import { type Command, completions } from "./commands.ts";
import { displayWidth, isBlank } from "./render/markdown.ts";

const MAX_SUGGESTIONS = 8;

// logo 第一组的蓝，提示符跟品牌色对上
const ACCENT = "#0C75FC";

// 一次输入事件超过这么多字符，或者带换行，就当成粘贴而不是手敲
const PASTE_CHARS = 40;

const pasteTag = (text: string) =>
  `⟦粘贴 ${text.split("\n").length} 行 · ${text.length} 字⟧`;

function fitStatus(text: string, maxWidth: number): string {
  if (displayWidth(text) <= maxWidth) return text;
  let result = "";
  for (const ch of text) {
    if (displayWidth(result + ch + "…") > maxWidth) break;
    result += ch;
  }
  return result + "…";
}

export interface SessionUI {
  /** 等下一句输入。null 表示 Ctrl-D 退出。 */
  next(): Promise<string | null>;
  /** 往上方静态区写一段文字，永久留下。 */
  print(text: string): void;
  /** 写原始转义序列（图片）。先收起活动区，避免被 Ink 布局撕烂。 */
  printRaw(seq: string): void;
  setStatus(s: string): void;
  /** 忙碌提示，null 表示不忙。 */
  /** 传函数的话会被定时重算，耗时才会跳。 */
  setBusy(label: string | (() => string) | null): void;
  stop(): void;
}

interface Api {
  push: (line: string) => void;
  setStatus: (s: string) => void;
  setBusy: (l: string | (() => string) | null) => void;
  /** 强制重绘。Ink 的 clear() 不重置 lastOutput，内容没变就一行都不写， */
  /** 于是 printRaw 擦掉输入框之后它再也不回来。 */
  bump: () => void;
  waitInput: () => Promise<string | null>;
}

interface CursorState {
  parked: boolean;
  statusRow: number | null;
}

function App({ history, onReady, cursor }: {
  history: string[];
  onReady: (a: Api) => void;
  cursor: CursorState;
}) {
  const { exit } = useApp();
  const [lines, setLines] = useState<Array<{ id: number; text: string }>>([]);
  const [status, setStatus] = useState("");
  // 存的是「怎么算出这行字」，不是算好的字。只存字符串的话，
  // 等模型返回的那几秒里没人调用 setBusy，秒数就一直不动。
  const [busyFn, setBusyFn] = useState<(() => string) | null>(null);
  const [, setTick] = useState(0);
  const busy = busyFn ? busyFn() : null;
  const [value, setValue] = useState("");
  const [histIdx, setHistIdx] = useState(-1);
  const [sel, setSel] = useState(0);
  const [menu, setMenu] = useState<Command[]>([]);
  const [pastes, setPastes] = useState<Map<string, string>>(new Map());

  const [nonce, setNonce] = useState(0);
  const seq = useRef(0);
  const resolver = useRef<((v: string | null) => void) | null>(null);
  const queued = useRef<string[]>([]);

  useEffect(() => {
    onReady({
      push: (text) =>
        setLines((ls) => {
          // 空行必须能推进来：段落之间的留白全靠它。
          // 但连着两个空行没有意义，开头的空行也没有，压掉。
          const blank = isBlank(text);
          const lastBlank = ls.length === 0 || isBlank(ls[ls.length - 1]?.text ?? "");
          if (blank && lastBlank) return ls;
          return [...ls, { id: seq.current++, text }];
        }),
      setStatus,
      setBusy: (l) => setBusyFn(() => (l === null ? null : typeof l === "function" ? l : () => l)),
      bump: () => setNonce((n) => n + 1),
      waitInput: () =>
        new Promise<string | null>((res) => {
          // 思考期间打的那句先排队，轮到了直接交出去，不用重打
          const q = queued.current.shift();
          if (q !== undefined) res(q);
          else resolver.current = res;
        }),
    });
  }, []);

  // 忙的时候每 200ms 重算一次忙碌文案，耗时和轮数才会跳
  useEffect(() => {
    if (!busyFn) return;
    // 100ms 跟转圈的帧间隔对齐，点才转得顺，不跳帧
    const id = setInterval(() => setTick((n) => n + 1), 80);
    return () => clearInterval(id);
  }, [busyFn]);

  useEffect(() => {
    const next = completions(value).slice(0, MAX_SUGGESTIONS);
    setMenu(next);
    setSel((s) => (s < next.length ? s : 0));
  }, [value]);

  const handleChange = (next: string) => {
    const grew = next.length - value.length;
    if (grew >= PASTE_CHARS || (grew > 1 && next.includes("\n"))) {
      const added = next.slice(value.length);
      const tag = pasteTag(added);
      setPastes((m) => new Map(m).set(tag, added));
      setValue(value + tag);
      return;
    }
    setValue(next);
  };

  const accept = (cmd: Command) => {
    setValue(cmd.name + (cmd.name === "/remember" ? " " : ""));
    setMenu([]);
  };

  useInput((input, key) => {
    if (key.ctrl && input === "d" && !value) {
      resolver.current?.(null);
      resolver.current = null;
      exit();
      return;
    }
    if (menu.length) {
      if (key.upArrow) { setSel((s) => (s - 1 + menu.length) % menu.length); return; }
      if (key.downArrow) { setSel((s) => (s + 1) % menu.length); return; }
      if (key.tab) { const p = menu[sel]; if (p) accept(p); return; }
      if (key.escape) { setMenu([]); return; }
    } else if (history.length) {
      if (key.upArrow) {
        const n = histIdx < 0 ? history.length - 1 : Math.max(0, histIdx - 1);
        setHistIdx(n);
        setValue(history[n] ?? "");
        return;
      }
      if (key.downArrow && histIdx >= 0) {
        const n = histIdx + 1;
        if (n >= history.length) { setHistIdx(-1); setValue(""); }
        else { setHistIdx(n); setValue(history[n] ?? ""); }
      }
    }
  });

  const submit = (v: string) => {
    if (menu.length) {
      const pick = menu[sel];
      if (pick && pick.name !== v) { accept(pick); return; }
    }
    let full = v;
    for (const [tag, text] of pastes) full = full.replaceAll(tag, text);
    if (!full.trim()) return;

    // 敲的这句推进静态区永久留下，输入框立刻清空等下一句。
    // Ink 不卸载，所以下面一直有个能用的输入框。
    setLines((ls) => [
      ...ls,
      { id: seq.current++, text: `\x1b[1;38;2;12;117;252m❯❯\x1b[0m ${full}` },
    ]);
    setValue("");
    setHistIdx(-1);
    if (resolver.current) {
      resolver.current(full);
      resolver.current = null;
    } else {
      queued.current.push(full); // 还在忙，排队
    }
  };

  // 布局顺序从上到下：历史输出、思考指示、补全菜单、输入框、状态栏。
  // 思考指示必须在输入框**上面**（否则看着像两个输入框夹着思考），
  // 状态栏必须在输入框**下面**，钉在整个界面的最底边。
  //
  // 宽度必须显式给，否则 Ink 会把可用宽度算成两三列，输出变成一行两三个字。
  // 而且必须跟着终端走：只在首帧取一次的话，resize 之后每一帧的擦除行数
  // 都是错的，画面会越用越糊。下限兜底防止 columns 拿到 0 或者没定义。
  const { stdout } = useStdout();
  const [width, setWidth] = useState(() => Math.max(20, stdout?.columns || 80));

  const clearStatusAtBottom = () => {
    if (!stdout?.isTTY || cursor.statusRow === null) return;
    stdout.write(`\x1b[s\x1b[${cursor.statusRow};1H\x1b[2K\x1b[u`);
    cursor.statusRow = null;
  };

  // Ink 的 log-update 每一帧都会在活动区末尾追加一个换行，所以它的光标
  // 天生停在“最后一行内容”的下一行。把光标停回内容行，状态栏才是真正
  // 的最后一行，而不是倒数第二行下面留一条空白。
  //
  // cleanup 在下一帧写入前把光标放回换行后的原位；否则 Ink 的 eraseLines
  // 会从错误的行开始擦。这个 ref 在 raw 输出和 resize 时也会被外层暂时解除。
  useLayoutEffect(() => {
    if (!stdout?.isTTY || cursor.parked) return;
    // 拼音预览的锚点是光标逻辑位置，不是可见性：把光标钉在输入框文本
    // 末尾（提示符之后），preedit 就跟着输入走。光标保持 Ink 隐藏的状态，
    // 不 show，否则 ghostty 的 block 闪烁光标会跟假光标叠一起乱闪。
    const col = 1 + displayWidth("❯❯ ") + displayWidth(value);
    stdout.write(`\x1b[1A\x1b[${col}G`);
    cursor.parked = true;
    return () => {
      if (cursor.parked) {
        stdout.write("\x1b[1B\x1b[1G");
        cursor.parked = false;
      }
    };
  });

  // 状态栏不能作为 Ink 活动区的一行输出：log-update 每帧都会补换行，
  // 最后可见内容因此只能停在倒数第二行。Ink 只负责输入区，状态文字在提交后
  // 用绝对行坐标画到最底边，并保存/恢复光标位置。
  useLayoutEffect(() => {
    if (!stdout?.isTTY) return;
    clearStatusAtBottom();
    if (!status || menu.length || !stdout.rows) return;

    const row = stdout.rows;
    const maxWidth = Math.max(1, (stdout.columns || width) - 1);
    const shown = fitStatus(status, maxWidth);
    stdout.write(
      `\x1b[s\x1b[${row};1H\x1b[2K\x1b[1G\x1b[2m${shown}\x1b[22m\x1b[u`,
    );
    cursor.statusRow = row;
    return clearStatusAtBottom;
  });

  useEffect(() => {
    const onResize = () => setWidth(Math.max(20, stdout?.columns || 80));
    stdout?.on("resize", onResize);
    return () => { stdout?.off("resize", onResize); };
  }, [stdout]);

  return (
    <Box flexDirection="column" width={width}>
      <Static items={lines}>
        {(l) => (
          // Static 项只提交一次，不能把它的盒子锁在旧的终端宽度；按内容的自然宽度输出，
          // 让终端负责软换行，窗口拉宽时历史文字才会跟着回流。
          <Box key={l.id} width={Math.max(width, displayWidth(l.text))}>
            <Text wrap="wrap">{l.text}</Text>
          </Box>
        )}
      </Static>
      {/*
        思考行上下各空一行，把它跟历史输出和输入框隔开。
        光靠颜色不够：十六进制色走 truecolor，终端色彩能力检测不到就被降掉，
        所以用间距来突出，颜色用命名色（16 色终端上也有）加粗体兜底。
      */}
      {busy ? (
        <Box width={width} marginTop={1} marginBottom={1}>
          {/* 圆点那段自带 256 色渐变和 \x1b[0m，必须单独一个 Text，
              不能跟下面这段混在一起，否则它的重置会把 Ink 的上色清掉 */}
          <Text>{`  ${busy.split("\u0000")[0] ?? ""}`}</Text>
          <Text color="cyan" bold wrap="truncate-end">{busy.split("\u0000")[1] ?? ""}</Text>
        </Box>
      ) : null}
      {menu.map((c, i) => (
        <Box key={c.name} width={width}>
          <Text color={i === sel ? ACCENT : "gray"}>
            {i === sel ? "   ❯ " : "     "}
            {c.name.padEnd(12)}
          </Text>
          <Text dimColor wrap="truncate-end">{c.hint}</Text>
        </Box>
      ))}
      {/* 正文和输入框之间留一行。最后一段紧贴着提示符看着很挤。 */}
      <Box width={width}><Text>{`\u2060${nonce % 2 ? "\u2060" : ""}`}</Text></Box>
      <Box width={width}>
        <Text color={ACCENT} bold>{"❯❯ "}</Text>
        <TextInput value={value} onChange={handleChange} onSubmit={submit} />
      </Box>
    </Box>
  );
}

export function startSession(history: string[]): SessionUI {
  let api: Api | null = null;
  let ready: () => void = () => {};
  const readyP = new Promise<void>((r) => { ready = r; });
  // Ink 的 onReady 是在首帧 effect 里回调的，比调用方第一次 setStatus 晚。
  // 早到的那几次不能丢，先存着，api 一就位立刻补上，
  // 否则状态栏要等发完第一句话才出现。
  let pendingStatus: string | null = null;
  let pendingBusy: string | (() => string) | null | undefined;
  const cursor: CursorState = { parked: false, statusRow: null };

  const clearStatusAtBottom = () => {
    if (!process.stdout.isTTY || cursor.statusRow === null) return;
    process.stdout.write(`\x1b[s\x1b[${cursor.statusRow};1H\x1b[2K\x1b[u`);
    cursor.statusRow = null;
  };

  const releaseParkedCursor = () => {
    if (!process.stdout.isTTY || !cursor.parked) return;
    process.stdout.write("\x1b[1B\x1b[1G");
    cursor.parked = false;
  };

  const pinActivityToBottom = () => {
    const rows = process.stdout.rows;
    if (!process.stdout.isTTY || !rows) return;
    releaseParkedCursor();
    process.stdout.write(`\x1b[${rows};1H`);
  };

  // Ink 的活动区从当前光标位置开始画，不会自动把这块区域放到终端底部。
  // 启动前的横幅通常只占几行；如果直接 render，输入框和状态栏就会悬在窗口中间，
  // 直到静态输出把光标推到底才“看起来”正常。先把光标推到窗口末端，之后 Static
  // 输出向上增长，活动区会继续留在底部。用绝对定位，不往滚动缓冲区灌空行，
  // 否则启动横幅会被无意义地推出当前视口。
  pinActivityToBottom();

  const instance = render(<App history={history} cursor={cursor} onReady={(a) => {
    api = a;
    if (pendingStatus !== null) a.setStatus(pendingStatus);
    if (pendingBusy !== undefined) a.setBusy(pendingBusy);
    ready();
  }} />, {
    exitOnCtrlC: true,
    patchConsole: false,
  });

  // 窗口变高时，终端不会自动把已经画好的活动区搬到新底边。
  // 把光标放到底，最后用 nonce 逼它重画。
  let resizeTimer: ReturnType<typeof setTimeout> | null = null;
  const onResize = () => {
    // Ink 自己也监听 resize，等它先算完新布局再逼一次重绘。
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      resizeTimer = null;
      clearStatusAtBottom();
      releaseParkedCursor();
      instance.clear();
      pinActivityToBottom();
      api?.bump();
    }, 100);
  };
  process.stdout.on("resize", onResize);

  let exited = false;
  let pendingResolve: ((v: string | null) => void) | null = null;
  instance.waitUntilExit().then(() => {
    exited = true;
    // Ctrl-C 走 exitOnCtrlC 时 Ink 自己卸载，但等输入的那个 Promise
    // 没人 resolve，主循环永远 await 在那儿，收尾一步都不走。
    pendingResolve?.(null);
    pendingResolve = null;
  });

  return {
    async next() {
      await readyP;
      if (exited) return null;
      const p = api!.waitInput();
      return Promise.race([p, new Promise<string | null>((r) => { pendingResolve = r; })]);
    },
    print(text) {
      // 以前这里是 `if (t) api?.push(t)`，空字符串被判掉，
      // 于是模型吐的每一个段落间隔都被静默删除，整屏糊成一坨。
      api?.push(text.replace(/\n+$/, ""));
    },
    printRaw(seq) {
      // 图片不能进 Ink 布局：先收起活动区，直接写 stdout，再逼它重绘。
      // 不 bump 的话 Ink 认为输出没变，输入框永远不回来。
      clearStatusAtBottom();
      releaseParkedCursor();
      instance.clear();
      process.stdout.write(seq + "\n");
      pinActivityToBottom();
      api?.bump();
    },
    setStatus(s) { if (api) api.setStatus(s); else pendingStatus = s; },
    setBusy(l) { if (api) api.setBusy(l); else pendingBusy = l; },
    stop() {
      if (resizeTimer) clearTimeout(resizeTimer);
      process.stdout.off("resize", onResize);
      clearStatusAtBottom();
      releaseParkedCursor();
      instance.unmount();
    },
  };
}
