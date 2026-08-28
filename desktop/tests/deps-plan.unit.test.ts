/**
 * 「缺什么补什么」和「要不要自动补」的判断。
 *
 * 这些是纯函数，因为 launcher/main.ts 一 import 就把服务起起来了，测不了。
 * 跑法：cd desktop && bun run test:unit
 */
import { describe, expect, test } from "bun:test";

import {
  autoDecision, missingNames, planFor, planIsEmpty, type Check,
} from "../launcher/deps-plan.ts";

const ok = (detail = ""): Check => ({ ok: true, detail });
const bad = (detail = ""): Check => ({ ok: false, detail });

const ALL_OK = { python: ok(), packages: ok(), tectonic: ok() };
const ONLY_TECTONIC_MISSING = { python: ok(), packages: ok(), tectonic: bad("找不到 tectonic") };
const NOTHING_THERE = { python: bad("没有 python"), packages: bad("没有 python，无法检查"), tectonic: bad() };

describe("missingNames", () => {
  test("全过是空", () => {
    expect(missingNames(ALL_OK)).toEqual([]);
  });

  test("按固定顺序报，跟对象里的键序无关", () => {
    const shuffled = { tectonic: bad(), packages: bad(), python: bad() };
    expect(missingNames(shuffled)).toEqual(["python", "packages", "tectonic"]);
  });

  test("体检将来加了项，不在 CHECK_ORDER 里也不能漏报", () => {
    expect(missingNames({ ...ALL_OK, latexmk: bad() })).toEqual(["latexmk"]);
  });
});

describe("planFor", () => {
  test("只缺 tectonic 就不碰 python，别让人陪跑一趟 pip", () => {
    expect(planFor(ONLY_TECTONIC_MISSING)).toEqual({ python: false, tectonic: true });
  });

  test("包缺了要走 python 那条，哪怕解释器本身是好的", () => {
    expect(planFor({ python: ok(), packages: bad("缺 pypdfium2"), tectonic: ok() }))
      .toEqual({ python: true, tectonic: false });
  });

  test("全缺就两样都补", () => {
    expect(planFor(NOTHING_THERE)).toEqual({ python: true, tectonic: true });
  });

  test("全过就是个空计划", () => {
    expect(planIsEmpty(planFor(ALL_OK))).toBe(true);
  });
});

describe("autoDecision", () => {
  const base = { disabled: false, failedAt: null, now: 1_000_000, retryAfterMs: 6 * 3600_000 };

  test("依赖齐全就不动", () => {
    expect(autoDecision({ ...base, checks: ALL_OK }).run).toBe(false);
  });

  test("缺东西就补，理由里点名缺了什么", () => {
    const d = autoDecision({ ...base, checks: ONLY_TECTONIC_MISSING });
    expect(d.run).toBe(true);
    expect(d.reason).toContain("tectonic");
  });

  test("开关关着就不补，而且要说是被关掉了", () => {
    const d = autoDecision({ ...base, checks: ONLY_TECTONIC_MISSING, disabled: true });
    expect(d.run).toBe(false);
    expect(d.reason).toContain("OMNISCI_AUTO_INSTALL");
  });

  test("上次失败在冷却期内就不重来", () => {
    const d = autoDecision({ ...base, checks: ONLY_TECTONIC_MISSING, failedAt: base.now - 3600_000 });
    expect(d.run).toBe(false);
    // 用户要能知道怎么立刻重试，光说"跳过"等于把人晾着
    expect(d.reason).toContain("安装依赖");
  });

  test("冷却过了就再试一次", () => {
    const d = autoDecision({ ...base, checks: ONLY_TECTONIC_MISSING, failedAt: base.now - 7 * 3600_000 });
    expect(d.run).toBe(true);
  });

  test("缺的项一样都装不了时不空跑一趟", () => {
    const d = autoDecision({ ...base, checks: { ...ALL_OK, latexmk: bad() } });
    expect(d.run).toBe(false);
    expect(d.reason).toContain("没有一样是能自动装的");
  });

  test("任何一次不动手都必须给出原因，不做无声跳过", () => {
    const cases = [
      { ...base, checks: ALL_OK },
      { ...base, checks: ONLY_TECTONIC_MISSING, disabled: true },
      { ...base, checks: ONLY_TECTONIC_MISSING, failedAt: base.now },
    ];
    for (const input of cases) expect(autoDecision(input).reason.length).toBeGreaterThan(0);
  });
});
