/**
 * 界面多语言。当前十门，见 LANGS。
 *
 * 词条**以中文原文为键**，不另造 key。这套代码的注释、提交、讨论全是中文，
 * 再发明一层 `settings.dialog.title` 只会让人对着 key 猜界面上是哪一句。
 * 中文那份天然就是源文，查不到就退英文，英文也没有才退回中文原文，
 * 所以缺翻译时界面还是能用的，不会变成一片空白或者裸 key。
 *
 * 占位符用 `{0}` `{1}`，按 t() 的参数顺序填。中英两边的编号必须对上，
 * 因为英文语序常常跟中文不一样。
 *
 * 组件里用 useT()（它订阅 context，切语言会重渲染）；
 * 非组件的模块直接 import t，读的是模块级的当前语言。
 */
import {
  createContext, useCallback, useContext, useEffect, useState, type ReactNode,
} from "react";

export type Lang = "zh" | "en" | "fr" | "es" | "zh-Hant" | "ja" | "ko" | "pt" | "de" | "ru";

/**
 * 界面上出现的语言。native 是这门语言自己的写法，不用英文名，
 * 因为看得懂那个名字的人正是要选它的人。
 *
 * 加一门语言只要：这里加一行 + locales/ 下加一张表。组件一行都不用改，
 * 切换按钮也只有一个（语言是全局状态，见 LangProvider）。
 */
export const LANGS: ReadonlyArray<{ code: Lang; native: string; html: string }> = [
  { code: "en", native: "English", html: "en" },
  { code: "zh", native: "简体中文", html: "zh-CN" },
  { code: "fr", native: "Français", html: "fr" },
  { code: "es", native: "Español", html: "es" },
  { code: "zh-Hant", native: "繁體中文", html: "zh-Hant" },
  { code: "ja", native: "日本語", html: "ja" },
  { code: "ko", native: "한국어", html: "ko" },
  { code: "pt", native: "Português", html: "pt" },
  { code: "de", native: "Deutsch", html: "de" },
  { code: "ru", native: "Русский", html: "ru" },
];

const STORAGE_KEY = "omnisci.lang";

import { en } from "./locales/en";
import { fr } from "./locales/fr";
import { es } from "./locales/es";
import { zhHant } from "./locales/zh-Hant";
import { ja } from "./locales/ja";
import { ko } from "./locales/ko";
import { pt } from "./locales/pt";
import { de } from "./locales/de";
import { ru } from "./locales/ru";

/**
 * 各语言词条表。中文是源文（键本身就是中文），所以这里没有 zh。
 *
 * 加一门语言：locales/ 下加一张表 + 这里加一行 + LANGS 加一行。组件不用改。
 */
const LOCALES: Partial<Record<Lang, Record<string, string>>> = {
  en, fr, es, "zh-Hant": zhHant, ja, ko, pt, de, ru,
};

const EN = en;




/**
 * 界面语言。
 *
 * 优先级：用户存过的选择 > 浏览器语言 > 英文。
 *
 * 以前这里一律返回英文（面向英文受众发布），中文浏览器也给英文。现在支持十门
 * 语言了，再无视浏览器语言就说不过去：日语用户打开看到英文，还得自己去找开关。
 * 用户一旦手动选过，那份选择永远优先，不会被浏览器语言盖掉。
 */
function detect(): Lang {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && LANGS.some((entry) => entry.code === saved)) return saved as Lang;
  } catch {
    // 隐私模式下 localStorage 会抛，那就当没存过
  }
  // navigator.language 形如 "ja"、"pt-BR"、"zh-Hant-TW"。
  //
  // 先拿整串比，比不上再退回第一段。只取第一段的话，繁体永远匹配不到：
  // zh-TW 和 zh-Hant-TW 的第一段都是 zh，台湾和香港用户打开看到的是简体。
  //
  // 长的先比。按 LANGS 原顺序找的话，zh 排在 zh-Hant 前面，"zh-hant-tw"
  // 会先被 zh 的前缀规则吃掉，等于这个修复没做。
  const nav = (typeof navigator === "undefined" ? "" : navigator.language || "").toLowerCase();
  const longest = [...LANGS].sort((a, b) => b.code.length - a.code.length);
  const full = longest.find((entry) => entry.code.toLowerCase() === nav
    || nav.startsWith(entry.code.toLowerCase() + "-"));
  if (full) return full.code;
  const primary = nav.split("-")[0] ?? "";
  const hit = LANGS.find((entry) => entry.code === primary);
  return hit ? hit.code : "en";
}

let current: Lang = detect();

/** 翻译 + 填占位符。查不到就用中文原文。 */
const PREFIX: Array<[RegExp, (m: RegExpMatchArray) => string]> = [
  [/^读取 (.+)$/u, (m) => `Reading ${m[1]}`],
  [/^浏览 (.+)$/u, (m) => `Browsing ${m[1]}`],
  [/^更新 (.+)$/u, (m) => `Updating ${m[1]}`],
  [/^正在执行(.+)$/u, (m) => `Running ${EN[m[1]] ?? m[1]}`],
  [/^([\d,]+) 字符$/u, (m) => `${m[1]} chars`],
];

/** 表里查不到时，按前缀规则兜一层，专治后端拼好的动态串。 */
function byPrefix(zh: string): string | null {
  for (const [re, fn] of PREFIX) {
    const m = zh.match(re);
    if (m) return fn(m);
  }
  return null;
}

export function t(zh: string, ...args: unknown[]): string {
  // 回退链：目标语言 -> 英文 -> 中文原文。
  // 缺一条法语译文时给英文，比给中文有用；两边都缺才退回原文，界面永远不会空。
  const raw = current === "zh"
    ? zh
    : LOCALES[current]?.[zh] ?? EN[zh] ?? byPrefix(zh) ?? zh;
  if (!args.length) return raw;
  return raw.replace(/\{(\d+)\}/g, (whole: string, index: string) => {
    const value = args[Number(index)];
    return value === undefined || value === null ? whole : String(value);
  });
}

export function currentLang(): Lang {
  return current;
}

const LangContext = createContext<{ lang: Lang; setLang: (next: Lang) => void }>({
  lang: current,
  setLang: () => {},
});

export function LangProvider({ children }: { children: ReactNode }) {
  const [lang, setState] = useState<Lang>(current);

  const setLang = useCallback((next: Lang) => {
    current = next;                       // 先改模块级的，t() 立刻就按新语言算
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // 存不下最多是下次重开回到默认，不值得打扰用户
    }
    setState(next);
  }, []);

  // lang 属性要跟着走：CJK 和拉丁文的断行、字体回退规则不一样。
  useEffect(() => {
    const meta = LANGS.find((entry) => entry.code === lang);
    document.documentElement.lang = meta?.html ?? "en";
  }, [lang]);

  return <LangContext.Provider value={{ lang, setLang }}>{children}</LangContext.Provider>;
}

/** 组件里取 t。用 context 是为了切语言时这个组件会重渲染。 */
export function useT(): typeof t {
  useContext(LangContext);
  return t;
}

export function useLang(): [Lang, (next: Lang) => void] {
  const ctx = useContext(LangContext);
  return [ctx.lang, ctx.setLang];
}
