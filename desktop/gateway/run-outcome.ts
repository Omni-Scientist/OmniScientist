/**
 * 一轮研究到底算不算跑完了。
 *
 * 单独一个文件的原因跟 cli/src/paths.ts 一样：server.ts 的模块体有副作用
 * （没有 OMNISCI_WEB_TOKEN 就直接抛），import 它就等于要先把整个网关的环境搭起来。
 * 这段判定是纯函数，不该为了测它去搭那一套。
 */

export interface RunOutcome {
  kind: "stopped" | "truncated" | "done";
  /** 会话状态。没跑完的一律 idle，不然界面不让接着发消息。 */
  status: "idle" | "complete";
  preview: string;
  title: string;
  summarySuffix: string;
  /** 追加在正文后面的说明，正常完成时是空串。 */
  note: string;
}

/**
 * **跑到头不等于跑完。**
 *
 * AgentLoop 耗尽 maxTurns 时返回 stoppedBecause="到达轮次上限 N"，模型自己被
 * 截断时返回 finishReason（"length" 之类）。CLI 一直在看这个字段（cli.tsx 里
 * 非正常结束直接判交付失败），桌面这边以前一个字都没看，只认 aborted，
 * 其余一律 complete + "研究运行完成"。
 *
 * 后果是论文可能停在编译之前，而界面、持久化状态和 assistant.completed 事件
 * 都说成功了。用户拿到一份"成功"的半截研究，还不知道它是半截的 —— 对一个
 * 出论文的工具来说，这比直接报错糟糕得多。
 */
export function runOutcome(result: { aborted?: boolean; stoppedBecause: string }): RunOutcome {
  if (result.aborted === true) {
    return {
      kind: "stopped",
      status: "idle",
      preview: "已停止",
      title: "已停止",
      summarySuffix: "",
      note: "\n\n**已停止。** 再发一条消息就从这里接着做。",
    };
  }
  if (result.stoppedBecause !== "stop" && result.stoppedBecause !== "end_turn") {
    return {
      kind: "truncated",
      status: "idle",
      preview: "没跑完，可继续",
      title: "这一轮没跑完",
      summarySuffix: ` · ${result.stoppedBecause}`,
      note: `\n\n**这一轮没跑完（${result.stoppedBecause}）。** `
        + "结果可能是半截的，比如论文只到 .tex 还没编成 PDF。再发一条消息就从这里接着做。",
    };
  }
  return {
    kind: "done",
    status: "complete",
    preview: "本轮研究已完成",
    title: "研究运行完成",
    summarySuffix: "",
    note: "",
  };
}
