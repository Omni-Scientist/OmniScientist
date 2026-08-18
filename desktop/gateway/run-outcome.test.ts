/**
 * 「跑完了」和「跑到头了」不是一回事。
 *
 * 桌面 gateway 以前只认 aborted，轮次耗尽会被标成 complete + "研究运行完成"，
 * 而论文可能停在编译之前。CLI 那边一直是判失败的（cli.tsx 的交付检查），
 * 两边对同一个 LoopResult 给出相反结论。这组测试盯住的就是这个差异。
 */

import { describe, expect, test } from "bun:test";

import { runOutcome } from "./run-outcome.ts";

describe("一轮研究的结束判定", () => {
  test("正常结束才算完成", () => {
    for (const because of ["stop", "end_turn"]) {
      const o = runOutcome({ stoppedBecause: because });
      expect(o.kind).toBe("done");
      expect(o.status).toBe("complete");
      expect(o.note).toBe("");
      expect(o.title).toBe("研究运行完成");
    }
  });

  test("轮次耗尽不能报成完成", () => {
    const o = runOutcome({ stoppedBecause: "到达轮次上限 200" });
    expect(o.kind).toBe("truncated");
    // idle 而不是 complete：用户得能再发一条消息接着跑
    expect(o.status).toBe("idle");
    expect(o.title).not.toBe("研究运行完成");
    // 原因要写给用户看，不能只在日志里
    expect(o.note).toContain("到达轮次上限 200");
    expect(o.summarySuffix).toContain("到达轮次上限 200");
  });

  test("模型自己被截断（finishReason=length）同样不算完成", () => {
    const o = runOutcome({ stoppedBecause: "length" });
    expect(o.kind).toBe("truncated");
    expect(o.status).toBe("idle");
  });

  test("用户主动停止是停止，不是截断", () => {
    const o = runOutcome({ aborted: true, stoppedBecause: "已停止" });
    expect(o.kind).toBe("stopped");
    expect(o.status).toBe("idle");
    expect(o.note).toContain("已停止");
  });

  test("aborted 优先于 stoppedBecause", () => {
    // 中断发生在轮次耗尽的同一轮时，对用户来说它就是"我按了停止"
    expect(runOutcome({ aborted: true, stoppedBecause: "到达轮次上限 200" }).kind).toBe("stopped");
  });
});
