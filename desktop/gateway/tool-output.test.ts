import { describe, expect, test } from "bun:test";

import type { ChatMessage } from "../src/types.ts";
import { hydrateToolOutputs, sanitizeToolOutput } from "./tool-output.ts";

const root = "/workspace/private-study";
const redact = (value: string, limit = 200_000) => value
  .replaceAll(root, "$WORKSPACE")
  .replace(/\/home\/[^\s]+/g, "$LOCAL_PATH")
  .slice(0, limit);

describe("sanitizeToolOutput", () => {
  test("redacts receipts, credentials, paths and large numeric arrays", () => {
    const array = `[${Array.from({ length: 48 }, (_, index) => index).join(", ")}]`;
    const raw = [
      "OmniSci-Receipt: {\"private\":true}",
      "OmniSci-Vision-Meta: {\"observation\":\"hidden\"}",
      `result=${root}/host/result.json`,
      "OPENAI_API_KEY=sk-secret-value-that-must-not-leak",  // scan-leaks: allow 造的假 key，用来验脱敏
      "Authorization: Bearer abc.def.ghi",
      array,
    ].join("\n");

    const result = sanitizeToolOutput(raw, "bash", "{}", redact);

    expect(result.output).toContain("$WORKSPACE/host/result.json");
    expect(result.output).toContain("OPENAI_API_KEY=[redacted]");
    expect(result.output).toContain("Bearer [redacted]");
    expect(result.output).toContain("[large numeric array omitted · 48 values]");
    expect(result.output).not.toContain("OmniSci-");
    expect(result.output).not.toContain("sk-secret");
  });

  test("never exposes a loaded Skill body", () => {
    expect(sanitizeToolOutput("private skill instructions", "use_skill", "omnisci", redact)).toEqual({});
    expect(sanitizeToolOutput(
      "private skill instructions",
      "read_file",
      '{"path":"skills/omnisci/SKILL.md"}',
      redact,
    )).toEqual({});
  });

  test("marks bounded previews as truncated", () => {
    const result = sanitizeToolOutput("abcdefghij", "bash", "{}", redact, 5);
    expect(result).toEqual({ output: "abcde", outputTruncated: true });
  });
});

describe("hydrateToolOutputs", () => {
  test("matches repeated historical tools by recorded output length", () => {
    const steps = [
      { id: "one", tool: "list_dir", label: "查看目录", detail: "5 字符", status: "complete" as const },
      { id: "two", tool: "bash", label: "运行命令", detail: "11 字符", status: "complete" as const },
    ];
    const messages: ChatMessage[] = [
      { id: "u", role: "user", author: "你", time: "12:00", content: "检查" },
      {
        id: "a",
        role: "assistant",
        author: "OmniScientist",
        time: "12:01",
        content: "完成",
        blocks: steps.map((step) => ({ id: `${step.id}-block`, type: "tool" as const, step: { ...step } })),
        toolRun: { title: "完成", summary: "2 steps", steps: steps.map((step) => ({ ...step })) },
      },
    ];
    const historical = [
      { turn: 1, tool: "list_dir", source: "{}", output: "first" },
      { turn: 1, tool: "bash", source: "{}", output: "omitted old result" },
      { turn: 1, tool: "bash", source: "{}", output: "hello world" },
    ];

    expect(hydrateToolOutputs(messages, [], redact, historical)).toBe(true);
    expect(messages[1]?.toolRun?.steps.map((step) => step.output)).toEqual(["first", "hello world"]);
    expect(messages[1]?.blocks?.filter((block) => block.type === "tool").map((block) => block.step.output))
      .toEqual(["first", "hello world"]);
  });
});
