import { describe, expect, test } from "bun:test";

import { nativeBaseURL, rememberSkeleton, toNativeRequest } from "../src/anthropic.ts";

const tool = {
  type: "function",
  function: { name: "read_file", description: "读文件", parameters: { type: "object", properties: { path: { type: "string" } } } },
};

describe("toNativeRequest", () => {
  test("system 提到顶层，tool 回执并进同一条 user 消息，跟在后面的图片也并进去", () => {
    const req = toNativeRequest([
      { role: "system", content: "你是 agent" },
      { role: "user", content: "读两个文件" },
      {
        role: "assistant",
        content: "好",
        tool_calls: [
          { id: "a", type: "function", function: { name: "read_file", arguments: "{\"path\":\"x\"}" } },
          { id: "b", type: "function", function: { name: "read_file", arguments: "" } },
        ],
      },
      { role: "tool", tool_call_id: "a", content: "内容 x" },
      { role: "tool", tool_call_id: "b", content: "" },
      { role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,QUJD" } }] },
    ], [tool]);

    expect(req.system).toBe("你是 agent");
    expect(req.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(req.messages[1]!.content).toEqual([
      { type: "text", text: "好" },
      { type: "tool_use", id: "a", name: "read_file", input: { path: "x" } },
      { type: "tool_use", id: "b", name: "read_file", input: {} },
    ]);
    expect(req.messages[2]!.content).toEqual([
      { type: "tool_result", tool_use_id: "a", content: [{ type: "text", text: "内容 x" }] },
      { type: "tool_result", tool_use_id: "b" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "QUJD" } },
    ]);
  });

  test("空的和只有空白的正文不发，原生接口会 400", () => {
    const req = toNativeRequest([
      { role: "user", content: "hi" },
      { role: "assistant", content: null },
      { role: "user", content: "  " },
      { role: "user", content: "继续" },
    ], []);
    expect(req.messages).toEqual([{ role: "user", content: [{ type: "text", text: "hi" }, { type: "text", text: "继续" }] }]);
    expect(req.system).toBe("");
  });

  test("工具定义转成 input_schema，带 eager_input_streaming", () => {
    const req = toNativeRequest([{ role: "user", content: "x" }], [
      tool,
      { type: "function", function: { name: "noop", description: "无参", parameters: {} } },
    ]);
    expect(req.tools).toEqual([
      { name: "read_file", description: "读文件", input_schema: { type: "object", properties: { path: { type: "string" } } }, eager_input_streaming: true },
      { name: "noop", description: "无参", input_schema: { type: "object" }, eager_input_streaming: true },
    ]);
  });

  test("认不出来的东西当场抛，不静默丢", () => {
    expect(() => toNativeRequest([{ role: "function", content: "x" }], [])).toThrow("不认识的消息角色");
    expect(() => toNativeRequest([{ role: "user", content: [{ type: "input_audio" }] }], [])).toThrow("不认识的消息片段");
    expect(() => toNativeRequest([{ role: "user", content: "x" }], [{ type: "web_search" }])).toThrow("function 格式");
  });
});

describe("thinking 回传", () => {
  const t1 = { type: "thinking" as const, thinking: "", signature: "sig1" };
  const t2 = { type: "redacted_thinking" as const, data: "enc2" };
  const call = (id: string) => ({ id, type: "function", function: { name: "read_file", arguments: `{"path":"${id}"}` } });

  test("thinking 放回原来的位置，正文按原分块", () => {
    const msg = { role: "assistant", content: "先读 a。再读 b。", tool_calls: [call("a"), call("b")] };
    rememberSkeleton(msg, [
      { kind: "thinking", block: t1 }, { kind: "text", text: "先读 a。" }, { kind: "tool", id: "a" },
      { kind: "thinking", block: t2 }, { kind: "text", text: "再读 b。" }, { kind: "tool", id: "b" },
    ]);
    const req = toNativeRequest([{ role: "user", content: "x" }, msg], []);
    expect(req.messages[1]!.content).toEqual([
      t1, { type: "text", text: "先读 a。" }, { type: "tool_use", id: "a", name: "read_file", input: { path: "a" } },
      t2, { type: "text", text: "再读 b。" }, { type: "tool_use", id: "b", name: "read_file", input: { path: "b" } },
    ]);
  });

  test("被丢掉的工具调用跳过，正文被改过就整段放在第一个正文的位置", () => {
    const msg = { role: "assistant", content: "改过的正文", tool_calls: [call("a")] };
    rememberSkeleton(msg, [
      { kind: "thinking", block: t1 }, { kind: "text", text: "原文" }, { kind: "tool", id: "a" }, { kind: "tool", id: "cut" },
    ]);
    const req = toNativeRequest([{ role: "user", content: "x" }, msg], []);
    expect(req.messages[1]!.content).toEqual([
      t1, { type: "text", text: "改过的正文" }, { type: "tool_use", id: "a", name: "read_file", input: { path: "a" } },
    ]);
  });

  test("没记过的消息（比如从存档恢复的）不带 thinking", () => {
    const req = toNativeRequest([{ role: "user", content: "x" }, { role: "assistant", content: "hi" }], []);
    expect(req.messages[1]!.content).toEqual([{ type: "text", text: "hi" }]);
  });
});

test("nativeBaseURL 去掉给 OpenAI SDK 用的 /v1/", () => {
  expect(nativeBaseURL("https://api.anthropic.com/v1/")).toBe("https://api.anthropic.com");
  expect(nativeBaseURL("https://api.anthropic.com/v1")).toBe("https://api.anthropic.com");
  expect(nativeBaseURL("https://api.anthropic.com")).toBe("https://api.anthropic.com");
});
