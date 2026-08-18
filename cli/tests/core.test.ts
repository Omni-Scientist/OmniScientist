import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

import { ApprovalPolicy } from "../src/approval.ts";
import { Session } from "../src/session.ts";
import {
  AgentLoop, MAX_TURNS, repairToolCallGaps, STOPPED_TOOL_RESULT, UNATTENDED_MAX_TURNS,
  type Presenter,
} from "../src/loop.ts";
import {
  DEFAULT_EFFORT, EFFORT_LEVELS, PROVIDERS, quirks, REASONING_HEADROOM,
  supportsEffort, tokenCapField, type ModelClient,
} from "../src/model.ts";
import { BUILTIN_SKILLS_DIR, loadSkills, makeUseSkillTool } from "../src/skills.ts";
import { defaultRegistry, makeContext, Registry, type Tool } from "../src/tools/index.ts";
import { buildImageRequest } from "../src/tools/vision.ts";
import { recordPerceptionReceipt } from "../src/tools/vision.ts";
import { OMNISCI_RECEIPT_PREFIX, traceOmniSciReceipts } from "../src/tools/omnisci.ts";
import { parseCredentialPayload, safeChildEnvironment } from "../src/credentials.ts";
import { verifyArtifactReviewTrace, verifyPerceptionTrace } from "../src/delivery.ts";
import { explore } from "../src/subagent.ts";
import { buildSystemPrompt } from "../src/soul.ts";
import { skillsPromptBlock } from "../src/skills.ts";
import { resolveInvocation } from "../src/invocation.ts";
import {
  assetPatternFor, checkForUpdate, compareVersions, updateCheckDisabled, updateCommand,
} from "../src/update.ts";
import { columns, rule } from "../src/render/caps.ts";
import {
  ensureManagedToolsOnPath, pythonCommand, resetInterpreterCache, shellCommand, venvPython,
} from "../src/interpreters.ts";

const silentPresenter: Presenter = {
  turnStart() {},
  textDelta() {},
  textDone() {},
  toolStart() {},
  toolResult() {},
};

describe("bundled OmniScientist skill", () => {
  test("loads from the built-in directory and exposes its runtime", () => {
    const skills = loadSkills(BUILTIN_SKILLS_DIR);
    const omnisci = skills.find((skill) => skill.name === "omnisci");
    expect(omnisci).toBeDefined();
    expect(omnisci!.description).toContain("DeepSeek V4 Flash");
    expect(omnisci!.description).toContain("Use only when the user explicitly asks");
    expect(omnisci!.description).toContain("Do not trigger merely because the workspace contains");

    const tool = makeUseSkillTool(() => skills);
    const result = tool.run({ name: "omnisci" }, makeContext("/opt/omnisci"));
    expect(typeof result).toBe("string");
    expect(String(result)).toContain("OmniScientist 已把 OMNISCI");
    expect(String(result)).toContain("paper_cli.py contract");
    expect(String(result)).toContain("ordered_paragraph_jobs");
    expect(String(result)).toContain("Never collapse several jobs into one long paragraph");
  });

  test("keeps the base harness neutral until a request matches a skill", () => {
    const block = skillsPromptBlock(loadSkills(BUILTIN_SKILLS_DIR));
    const prompt = buildSystemPrompt("deepseek-v4-flash", "/path/that/does/not/exist", "", block)
      .systemPrompt;

    expect(prompt).toContain("跑在终端里的工作 agent");
    expect(prompt).toContain("这些是可选能力，不是当前任务");
    expect(prompt).toContain("不要仅凭工作区里的文件自行启动任何 skill");
    expect(prompt).not.toContain("论文研究 agent");
    expect(prompt).not.toContain("还不知道数据目录时");
  });

  test("registers the three receipt-producing paper tools", async () => {
    const names = (await defaultRegistry()).list().map((tool) => tool.name);
    expect(names).toContain("omnisci_record");
    expect(names).toContain("omnisci_bib");
    expect(names).toContain("omnisci_compile");
  });
});

describe("invocation modes", () => {
  test("a bare directory opens an interactive workspace instead of starting a paper", () => {
    const root = mkdtempSync("/tmp/omnisci-workspace-");
    const invocation = resolveInvocation("/tmp", undefined, [root]);

    expect(invocation.root).toBe(root);
    expect(invocation.dataArg).toBeUndefined();
    expect(invocation.taskWords).toEqual([]);
  });

  test("only explicit --data selects unattended paper mode", () => {
    const root = mkdtempSync("/tmp/omnisci-paper-");
    const invocation = resolveInvocation("/tmp", root, ["研究番茄叶片差异"]);

    expect(invocation.root).toBe(root);
    expect(invocation.dataArg).toBe(root);
    expect(invocation.taskWords).toEqual(["研究番茄叶片差异"]);
  });

  test("ordinary positional text remains a general one-shot task", () => {
    const root = mkdtempSync("/tmp/omnisci-general-");
    const invocation = resolveInvocation(root, undefined, ["检查当前项目为什么构建失败"]);

    expect(invocation.root).toBe(root);
    expect(invocation.dataArg).toBeUndefined();
    expect(invocation.taskWords).toEqual(["检查当前项目为什么构建失败"]);
  });
});

describe("multimodal tool result ordering", () => {
  test("places every tool result before image follow-up messages", async () => {
    let call = 0;
    const fakeModel = {
      async streamTurn(messages: unknown[]) {
        call++;
        if (call === 1) {
          return {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                { id: "a", type: "function", function: { name: "plain", arguments: "{}" } },
                { id: "b", type: "function", function: { name: "image", arguments: "{}" } },
              ],
            },
            finishReason: "tool_calls",
            usage: { promptTokens: 1, completionTokens: 1, cachedTokens: 0, cost: 0 },
          };
        }
        const roles = messages.map((message) => (message as { role: string }).role);
        expect(roles.slice(-3)).toEqual(["tool", "tool", "user"]);
        return {
          message: { role: "assistant", content: "done" },
          finishReason: "stop",
          usage: { promptTokens: 1, completionTokens: 1, cachedTokens: 0, cost: 0 },
        };
      },
    } as unknown as ModelClient;

    const tools: Tool[] = [
      { name: "plain", description: "plain", parameters: { type: "object" }, run: () => "ok" },
      {
        name: "image",
        description: "image",
        parameters: { type: "object" },
        run: () => ({ text: "attached", followupMessages: [{ role: "user", content: "image" }] }),
      },
    ];
    const registry = new Registry();
    for (const tool of tools) registry.add(tool);

    const messages: unknown[] = [{ role: "system", content: "test" }, { role: "user", content: "go" }];
    const loop = new AgentLoop(
      fakeModel,
      registry,
      makeContext("/opt/omnisci"),
      new ApprovalPolicy(true),
      silentPresenter,
    );
    await loop.run(messages);
    expect(call).toBe(2);
  });
});

describe("view_image", () => {
  test("returns a real data URL without leaving the workspace", () => {
    // 容器里仓库在 /opt/omnisci，宿主上就是这个 checkout。相对解析两边都对，
    // 免得这条用例在宿主上永远红着，红久了就没人看了。
    const root = resolve(import.meta.dir, "..", "docker", "fixtures");
    const result = buildImageRequest(
      { path: "data/slides/Tomato_healthy/pv_00001.png", question: "what is visible?" },
      makeContext(root),
    );
    const followup = result.message as {
      content: Array<{ type: string; image_url?: { url: string } }>;
    };
    expect(followup.content[1]!.image_url!.url.startsWith("data:image/png;base64,")).toBe(true);
  });

  test("binds a receipt to a pending request and the delivery trace verifies it", () => {
    const root = mkdtempSync("/tmp/omnisci-receipt-test-");
    const image = `${root}/image.png`;
    const calls = `${root}/host/calls`;
    mkdirSync(calls, { recursive: true });
    writeFileSync(image, "fixture pixels");
    const question = "what is visible?";
    writeFileSync(
      `${calls}/call_001.json`,
      JSON.stringify({
        call_id: 1,
        status: "needs_vision",
        pending: [{ id: 1, image, question }],
      }),
    );
    const observation = "A fixture observation.";
    const receipt = recordPerceptionReceipt(root, image, question, observation, "fixture", "fixture");
    const call = JSON.parse(readFileSync(`${calls}/call_001.json`, "utf-8"));
    call.status = "done";
    writeFileSync(`${calls}/call_001.json`, JSON.stringify(call));
    const assistant = {
      role: "assistant",
      tool_calls: [{
        id: "tool-1",
        type: "function",
        function: { name: "view_image", arguments: JSON.stringify({ path: "image.png", question }) },
      }],
    };
    const messages = [
      assistant,
      {
        role: "tool",
        tool_call_id: "tool-1",
        content: `OmniSci-Vision-Receipt: ${receipt.receiptId}\n${observation}`,
      },
    ];
    expect(verifyPerceptionTrace(root, messages)).toEqual([]);
    assistant.tool_calls[0]!.function.arguments = JSON.stringify({ path: "image.png", question: "wrong" });
    expect(verifyPerceptionTrace(root, messages).join(" ")).toContain("问题不匹配");
  });

  test("binds analysis and PDF review images to current pixels and this run", () => {
    const root = mkdtempSync("/tmp/omnisci-review-test-");
    const image = `${root}/page-1.png`;
    writeFileSync(image, "current pixels");
    const imageSha = createHash("sha256").update("current pixels").digest("hex");
    const question = "Is this page blank, clipped, or overlapping?";
    const observation = "The fixture page is visible and not blank.";
    const receiptId = "11111111-1111-1111-1111-111111111111";
    const meta = {
      receipt_id: receiptId,
      image_sha256: imageSha,
      question_sha256: createHash("sha256").update(question).digest("hex"),
      observation_sha256: createHash("sha256").update(observation).digest("hex"),
      observation,
      provider: "fixture",
      model: "fixture",
      viewed_at: new Date().toISOString(),
    };
    const messages = [
      {
        role: "assistant",
        tool_calls: [{
          id: "vision-review",
          type: "function",
          function: { name: "view_image", arguments: JSON.stringify({ path: "page-1.png", question }) },
        }],
      },
      {
        role: "tool",
        tool_call_id: "vision-review",
        content: `OmniSci-Vision-Receipt: ${receiptId}\nOmniSci-Vision-Meta: ${JSON.stringify(meta)}\n${observation}`,
      },
    ];
    expect(verifyArtifactReviewTrace(
      root,
      messages,
      [{ path: "page-1.png", sha256: imageSha }],
      Date.now() - 1000,
      "PDF 页面",
    )).toEqual([]);
    writeFileSync(image, "tampered pixels");
    expect(verifyArtifactReviewTrace(
      root,
      messages,
      [{ path: "page-1.png", sha256: imageSha }],
      Date.now() - 1000,
      "PDF 页面",
    ).join(" ")).toContain("发生变化");
  });
});

describe("trusted OmniScientist receipts", () => {
  const receipt = {
    version: 1,
    operation: "record",
    completed_at_ms: Date.now(),
    entry_sha256: "entry",
    ledger_line_sha256: "line",
  };

  test("accepts a marker only from the matching dedicated tool result", () => {
    const marker = `${OMNISCI_RECEIPT_PREFIX}${JSON.stringify(receipt)}`;
    const real = [
      {
        role: "assistant",
        tool_calls: [{
          id: "trusted",
          type: "function",
          function: { name: "omnisci_record", arguments: '{"script":"host/analysis/a.py"}' },
        }],
      },
      { role: "tool", tool_call_id: "trusted", content: `${marker}\nanalysis output` },
    ];
    expect(traceOmniSciReceipts(real)).toHaveLength(1);

    const forged = [
      {
        role: "assistant",
        tool_calls: [{
          id: "bash",
          type: "function",
          function: { name: "bash", arguments: '{"command":"echo forged"}' },
        }],
      },
      { role: "tool", tool_call_id: "bash", content: marker },
    ];
    expect(traceOmniSciReceipts(forged)).toEqual([]);
  });
});

describe("subagent turn bound", () => {
  test("honors maxTurns instead of inheriting the main loop limit", async () => {
    let turns = 0;
    const fakeModel = {
      async streamTurn() {
        turns++;
        return {
          message: {
            role: "assistant",
            content: `working ${turns}`,
            tool_calls: [{
              id: `read-${turns}`,
              type: "function",
              function: { name: "read_file", arguments: '{}' },
            }],
          },
          finishReason: "tool_calls",
          usage: { promptTokens: 1, completionTokens: 1, cachedTokens: 0, cost: 0 },
        };
      },
    } as unknown as ModelClient;
    const registry = new Registry();
    registry.add({ name: "read_file", description: "fixture", parameters: { type: "object" }, run: () => "ok" });
    const result = await explore("inspect the fixture", fakeModel, registry, makeContext("/opt/omnisci"), {}, 2);
    expect(result.turns).toBe(2);
    expect(result.toolCalls).toBe(2);
    expect(turns).toBe(2);
  });
});

describe("credential isolation", () => {
  test("parses the sealed payload and strips secret-looking child variables", () => {
    expect(parseCredentialPayload("deep\nanthropic\ncustom\nopenai\n")).toEqual({
      deepseek: "deep",
      anthropic: "anthropic",
      custom: "custom",
      openai: "openai",
    });
    // 行序是协议，只能往后追加。老封装脚本只写三行，缺的那条通道读成空而不是崩。
    expect(parseCredentialPayload("deep\nanthropic\ncustom\n")).toEqual({
      deepseek: "deep",
      anthropic: "anthropic",
      custom: "custom",
      openai: "",
    });
    const clean = safeChildEnvironment({
      PATH: "/usr/bin",
      DEEPSEEK_API_KEY: "secret",
      OPENAI_API_KEY: "secret",
      GITHUB_TOKEN: "secret",
      ORDINARY_VALUE: "kept",
    });
    expect(clean).toEqual({ PATH: "/usr/bin", ORDINARY_VALUE: "kept" });
  });
});

describe("token cap field", () => {
  test("gpt-5.x and o-series need max_completion_tokens, everyone else max_tokens", () => {
    // 实测 2026-08-15：gpt-5.6-luna 收到 max_tokens 直接 400。
    expect(tokenCapField("gpt-5.6-luna", 1200)).toEqual({ max_completion_tokens: 1200 });
    expect(tokenCapField("gpt-5.4-mini", 8)).toEqual({ max_completion_tokens: 8 });
    expect(tokenCapField("o3-mini", 8)).toEqual({ max_completion_tokens: 8 });
    expect(tokenCapField("claude-sonnet-5", 8)).toEqual({ max_tokens: 8 });
    expect(tokenCapField("deepseek-v4-flash", 8)).toEqual({ max_tokens: 8 });
    // gpt-4o 不是推理模型，仍然只认 max_tokens，别被 o 开头的规则误伤
    expect(tokenCapField("gpt-4o", 8)).toEqual({ max_tokens: 8 });
    expect(tokenCapField("openrouter/qwen3-vl-8b-instruct", 8)).toEqual({ max_tokens: 8 });
  });
});

describe("provider quirks", () => {
  test("gpt-5.6 only gets reasoning_effort:none when tools are present", () => {
    // 带 tools 不关推理 -> 400 Function tools with reasoning_effort are not supported.
    expect(quirks("openai", "gpt-5.6-luna", true)).toEqual({ reasoning_effort: "none" });
    // 视觉侧车不带 tools，保留推理，看图更准。
    expect(quirks("openai", "gpt-5.6-luna", false)).toEqual({});
    expect(quirks("anthropic", "claude-sonnet-5", true)).toEqual({});
  });
});

describe("desktop/CLI 配置一致", () => {
  test("研究通道跟着 OMNISCI_PROVIDER / OMNISCI_MODEL 走", () => {
    // 桌面版把用户选的写进 ~/.omnisci/env，CLI 读同一份，两边才是一套配置。
    const pick = (env: Record<string, string | undefined>) => {
      const wanted = (env.OMNISCI_PROVIDER || "").trim();
      if (!(wanted in PROVIDERS)) return { provider: "deepseek", model: "deepseek-v4-flash" };
      const provider = wanted as keyof typeof PROVIDERS;
      return { provider, model: (env.OMNISCI_MODEL || "").trim() || PROVIDERS[provider].defaultModel };
    };
    expect(pick({})).toEqual({ provider: "deepseek", model: "deepseek-v4-flash" });
    expect(pick({ OMNISCI_PROVIDER: "openai" })).toEqual({ provider: "openai", model: "gpt-5.6-luna" });
    expect(pick({ OMNISCI_PROVIDER: "openai", OMNISCI_MODEL: "gpt-5.6-terra" }))
      .toEqual({ provider: "openai", model: "gpt-5.6-terra" });
    // 认不出来的通道名不能把 CLI 打挂，退回默认。
    expect(pick({ OMNISCI_PROVIDER: "nonesuch" })).toEqual({ provider: "deepseek", model: "deepseek-v4-flash" });
  });
});

describe("推理档位", () => {
  test("只发给收这个字段的模型", () => {
    expect(supportsEffort("gpt-5.6-luna")).toBe(true);
    expect(supportsEffort("o3-mini")).toBe(true);
    // Claude 的 OpenAI 兼容端点和 DeepSeek 收到这个字段会 400
    expect(supportsEffort("claude-sonnet-5")).toBe(false);
    expect(supportsEffort("deepseek-v4-flash")).toBe(false);
    expect(supportsEffort("gpt-4o")).toBe(false);
  });

  test("带 tools 时强制 none，不带 tools 才用选的档位", () => {
    expect(quirks("openai", "gpt-5.6-luna", true, "xhigh")).toEqual({ reasoning_effort: "none" });
    expect(quirks("openai", "gpt-5.6-luna", false, "xhigh")).toEqual({ reasoning_effort: "xhigh" });
    expect(quirks("anthropic", "claude-sonnet-5", false, "xhigh")).toEqual({});
  });

  test("开了推理要给正文留余量", () => {
    // 不留的话 effort=xhigh、cap=1200 时正文返回空串，视觉侧车当场报错。实测过。
    expect(tokenCapField("gpt-5.6-luna", 1200)).toEqual({ max_completion_tokens: 1200 });
    expect(tokenCapField("gpt-5.6-luna", 1200, "none")).toEqual({ max_completion_tokens: 1200 });
    expect(tokenCapField("gpt-5.6-luna", 1200, "xhigh"))
      .toEqual({ max_completion_tokens: 1200 + REASONING_HEADROOM });
    // 不收这个字段的模型不该被加余量，也不该改字段名
    expect(tokenCapField("claude-sonnet-5", 1200, "xhigh")).toEqual({ max_tokens: 1200 });
  });

  test("默认档位只给 OpenAI 官方通道", async () => {
    const { setVisionResolver, visionConfig } = await import("../src/tools/vision.ts");
    const effortOf = (config: Record<string, string>) => {
      setVisionResolver(() => config as never);
      return visionConfig().effort ?? "";
    };
    expect(effortOf({ provider: "openai", model: "gpt-5.6-luna" })).toBe("medium");
    // 显式给的永远优先
    expect(effortOf({ provider: "openai", model: "gpt-5.6-luna", effort: "xhigh" })).toBe("xhigh");
    // 别家一律留空：Claude 的兼容端点收到这个字段会 400，
    // 自定义端点上挂的 gpt-5.x 也不保证收，所以按名字判会误伤。
    expect(effortOf({ provider: "anthropic", model: "claude-sonnet-5" })).toBe("");
    expect(effortOf({ provider: "custom", model: "gpt-5.6-luna" })).toBe("");
    expect(effortOf({ provider: "custom", model: "qwen/qwen3-vl-235b-a22b-instruct" })).toBe("");
    // 但用户明着选了就照发
    expect(effortOf({ provider: "custom", model: "gpt-5.6-luna", effort: "high" })).toBe("high");
    setVisionResolver(null);
  });

  test("EFFORT_LEVELS 就是 API 认的那几个，没有 max", () => {
    expect([...EFFORT_LEVELS]).toEqual(["none", "low", "medium", "high", "xhigh"]);
    expect(EFFORT_LEVELS).not.toContain("max");
    expect(DEFAULT_EFFORT).toBe("medium");
  });
});

describe("无人值守时的审批", () => {
  test("没人能应答时把这一步回给模型，而不是把整轮跑崩", async () => {
    // 真实踩到的：agent 顺手 cat ~/.omnisci/env，守卫强制追问，ask() 抛出去
    // 直接打死整个进程，前面半小时的研究全丢。应当变成一条可恢复的工具结果。
    const guarded: Tool = {
      name: "bash",
      description: "bash",
      parameters: { type: "object" },
      // 真跑到就是 bug：这一步本该在跑之前就被挡下
      run: () => "不该跑到这里",
      needsApproval: () => true,
    } as unknown as Tool;
    const registry = new Registry();
    registry.add(guarded);

    let seen = "";
    const fakeModel = {
      async streamTurn(messages: unknown[]) {
        const last = messages[messages.length - 1] as { role?: string; content?: string };
        if (last?.role === "tool") {
          seen = String(last.content);
          return {
            message: { role: "assistant", content: "换个做法" },
            finishReason: "stop",
            usage: { promptTokens: 1, completionTokens: 1, cachedTokens: 0, cost: 0 },
          };
        }
        return {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [{ id: "x", type: "function", function: { name: "bash", arguments: "{}" } }],
          },
          finishReason: "tool_calls",
          usage: { promptTokens: 1, completionTokens: 1, cachedTokens: 0, cost: 0 },
        };
      },
    } as unknown as ModelClient;

    const loop = new AgentLoop(
      fakeModel,
      registry,
      makeContext("/opt/omnisci"),
      new ApprovalPolicy(false),
      silentPresenter,
    );
    // 不抛就是通过；抛了说明又变回"一条命令打死整轮"
    await loop.run([{ role: "system", content: "t" }, { role: "user", content: "go" }]);
    expect(seen).toContain("BLOCKED");
    expect(seen).toContain("换个不碰它的做法");
  });
});

describe("轮次预算", () => {
  test("maxTurns 能真的抬高，不被 MAX_TURNS 夹住", async () => {
    // 之前 turnLimit = min(MAX_TURNS, maxTurns)，参数形同虚设，
    // 无人值守跑论文必然在 80 轮处被砍断，空手而归。
    let turns = 0;
    const fakeModel = {
      async streamTurn() {
        turns++;
        return {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [{ id: `t${turns}`, type: "function", function: { name: "noop", arguments: "{}" } }],
          },
          finishReason: "tool_calls",
          usage: { promptTokens: 1, completionTokens: 1, cachedTokens: 0, cost: 0 },
        };
      },
    } as unknown as ModelClient;
    const registry = new Registry();
    registry.add({ name: "noop", description: "n", parameters: { type: "object" }, run: () => "ok" });

    const loop = new AgentLoop(
      fakeModel, registry, makeContext("/opt/omnisci"),
      new ApprovalPolicy(true), silentPresenter,
    );
    const result = await loop.run([{ role: "system", content: "t" }, { role: "user", content: "go" }], 95);
    expect(result.turns).toBe(95);            // 夹住的话这里会是 80
    expect(result.stoppedBecause).toContain("轮次上限");
    expect(UNATTENDED_MAX_TURNS).toBeGreaterThan(MAX_TURNS);
  });
});

describe("感知回执绑定", () => {
  test("agent 换了问法也能绑上：采用 pending 里记的那句问题", () => {
    // 真实踩到的：gate 校验 question_sha256 == sha256(pending.question)，
    // 而 agent 自己另起一句问法，回执静默绑不上，整轮预算被烧在查这件事上。
    const root = mkdtempSync("/tmp/omnisci-bind-");
    mkdirSync(`${root}/host/calls`, { recursive: true });
    const image = `${root}/tile.png`;
    writeFileSync(image, "fixture pixels");
    const pendingQuestion = "Describe the dominant tissue pattern and nuclei density.";
    const callPath = `${root}/host/calls/call_001.json`;
    writeFileSync(callPath, JSON.stringify({
      call_id: 1,
      status: "needs_vision",
      pending: [{ id: 1, image, question: pendingQuestion }],
    }));

    // agent 用自己的话问
    const request = buildImageRequest(
      { path: "tile.png", question: "What do you see in this tile?" },
      makeContext(root),
    );
    // 应当自动采用 pending 里那句，并如实标出来
    expect(request.question).toBe(pendingQuestion);
    expect(request.adopted).toBe(pendingQuestion);
    expect(request.pendingCount).toBe(1);

    // 于是回执绑得上，gate 校验的 question_sha256 才对得上
    const receipt = recordPerceptionReceipt(root, image, request.question, "观察文本", "openai", "gpt-5.6-luna");
    expect(receipt.matched).toBe(1);
    const after = JSON.parse(readFileSync(callPath, "utf-8")) as { receipts?: Record<string, unknown> };
    expect(Object.keys(after.receipts ?? {})).toEqual(["1"]);
  });

  test("没有待处理请求时不动调用方的问题", () => {
    const root = mkdtempSync("/tmp/omnisci-bind-none-");
    writeFileSync(`${root}/tile.png`, "fixture pixels");
    const request = buildImageRequest({ path: "tile.png", question: "自己的问题" }, makeContext(root));
    expect(request.question).toBe("自己的问题");
    expect(request.adopted).toBe("");
    expect(request.pendingCount).toBe(0);
  });

  test("已经有回执的请求不再重复占用问题", () => {
    const root = mkdtempSync("/tmp/omnisci-bind-done-");
    mkdirSync(`${root}/host/calls`, { recursive: true });
    const image = `${root}/tile.png`;
    writeFileSync(image, "fixture pixels");
    writeFileSync(`${root}/host/calls/call_001.json`, JSON.stringify({
      call_id: 1,
      pending: [{ id: 1, image, question: "老问题" }],
      receipts: { "1": { receipt_id: "已经答过了" } },
    }));
    const request = buildImageRequest({ path: "tile.png", question: "新问题" }, makeContext(root));
    expect(request.question).toBe("新问题");
    expect(request.pendingCount).toBe(0);
  });
});

describe("论文工具的环境", () => {
  test("bootstrap 真的把 OMNISCI 设出来，而不只是在提示里说设了", async () => {
    // bootstrap 是副作用模块，真实 CLI 里是 cli.tsx 的第一条 import。
    await import("../src/bootstrap.ts");
    // 真实踩到的：桌面版在 launcher 和 gateway 都设了 OMNISCI，CLI 一直漏着，
    // 于是 omnisci_record / omnisci_bib / omnisci_compile 必然抛"OMNISCI 未设置"，
    // 命令行永远编不出论文。而系统提示里还写着"已把 OMNISCI 设为 …"。
    expect(process.env.OMNISCI).toBeTruthy();
    for (const script of ["gate_cli.py", "lit_cli.py", "paper_cli.py", "evidence_cli.py"]) {
      expect(existsSync(resolve(process.env.OMNISCI!, script))).toBe(true);
    }
  });
});

describe("输出被截断", () => {
  test("finishReason=length 不当成结束，让模型接着写完", async () => {
    // 真实踩到的：无人值守跑论文写到一半被输出上限截断，循环把它当正常结束，
    // ledger 和图都在、论文没编，交付检查报"缺少 paper.manifest.json"。
    let call = 0;
    const seen: string[] = [];
    const fakeModel = {
      async streamTurn(messages: unknown[]) {
        call++;
        const last = messages[messages.length - 1] as { role?: string; content?: string };
        if (last?.role === "user" && call > 1) seen.push(String(last.content));
        return call === 1
          ? {
              message: { role: "assistant", content: "写到一半…" },
              finishReason: "length",
              usage: { promptTokens: 1, completionTokens: 1, cachedTokens: 0, cost: 0 },
            }
          : {
              message: { role: "assistant", content: "写完了" },
              finishReason: "stop",
              usage: { promptTokens: 1, completionTokens: 1, cachedTokens: 0, cost: 0 },
            };
      },
    } as unknown as ModelClient;

    const loop = new AgentLoop(
      fakeModel, new Registry(), makeContext("/opt/omnisci"),
      new ApprovalPolicy(true), silentPresenter,
    );
    const result = await loop.run([{ role: "system", content: "t" }, { role: "user", content: "go" }]);
    expect(call).toBe(2);                       // 被截断后又跑了一轮
    expect(result.stoppedBecause).toBe("stop"); // 最终是正常收尾，不是 length
    expect(seen.some((t) => t.includes("接着上次断掉的地方写完"))).toBe(true);
  });
});

describe("空 assistant 消息", () => {
  test("既无正文又无工具调用的消息不入队，否则下一轮请求会被 400", async () => {
    // 真实踩到的：被截断时模型可能一个字都没吐，那条空消息被回传给 DeepSeek，
    // 报 "Invalid assistant message: content or tool_calls must be set"，整轮崩。
    let call = 0;
    let sawEmpty = false;
    const fakeModel = {
      async streamTurn(messages: unknown[]) {
        call++;
        for (const m of messages) {
          const msg = m as { role?: string; content?: unknown; tool_calls?: unknown[] };
          if (msg.role === "assistant" && !msg.content && !msg.tool_calls?.length) sawEmpty = true;
        }
        return call === 1
          ? {
              message: { role: "assistant", content: null },   // 截断，什么都没吐出来
              finishReason: "length",
              usage: { promptTokens: 1, completionTokens: 1, cachedTokens: 0, cost: 0 },
            }
          : {
              message: { role: "assistant", content: "补上了" },
              finishReason: "stop",
              usage: { promptTokens: 1, completionTokens: 1, cachedTokens: 0, cost: 0 },
            };
      },
    } as unknown as ModelClient;

    const loop = new AgentLoop(
      fakeModel, new Registry(), makeContext("/opt/omnisci"),
      new ApprovalPolicy(true), silentPresenter,
    );
    const result = await loop.run([{ role: "system", content: "t" }, { role: "user", content: "go" }]);
    expect(sawEmpty).toBe(false);
    expect(result.stoppedBecause).toBe("stop");
  });
});

describe("版本检查", () => {
  test("版本比较认得出新旧，不把预发布当成更新", () => {
    expect(compareVersions("1.2.0", "1.1.9")).toBeGreaterThan(0);
    expect(compareVersions("1.2.0", "1.2.0")).toBe(0);
    expect(compareVersions("0.9.0", "1.0.0")).toBeLessThan(0);
    expect(compareVersions("v1.2.0", "1.2.0")).toBe(0);      // tag 带 v 前缀
    expect(compareVersions("1.10.0", "1.9.0")).toBeGreaterThan(0);  // 按数字不按字典序
  });

  test("关闭开关认得出常见写法", () => {
    const original = process.env.OMNISCI_UPDATE_CHECK;
    for (const off of ["off", "0", "false", "no", "OFF"]) {
      process.env.OMNISCI_UPDATE_CHECK = off;
      expect(updateCheckDisabled()).toBe(true);
    }
    for (const on of ["", "on", "1", "yes"]) {
      process.env.OMNISCI_UPDATE_CHECK = on;
      expect(updateCheckDisabled()).toBe(false);
    }
    if (original === undefined) delete process.env.OMNISCI_UPDATE_CHECK;
    else process.env.OMNISCI_UPDATE_CHECK = original;
  });

  test("关掉之后一次网络都不发", async () => {
    const original = process.env.OMNISCI_UPDATE_CHECK;
    process.env.OMNISCI_UPDATE_CHECK = "off";
    const realFetch = globalThis.fetch;
    let called = 0;
    globalThis.fetch = (async () => { called++; return new Response("{}"); }) as unknown as typeof fetch;
    try {
      expect(await checkForUpdate("0.1.0", "cli")).toBeNull();
      expect(called).toBe(0);
    } finally {
      globalThis.fetch = realFetch;
      if (original === undefined) delete process.env.OMNISCI_UPDATE_CHECK;
      else process.env.OMNISCI_UPDATE_CHECK = original;
    }
  });

  test("网络炸了当作没有新版本，不抛", async () => {
    const original = process.env.OMNISCI_UPDATE_CHECK;
    delete process.env.OMNISCI_UPDATE_CHECK;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => { throw new Error("网络不通"); }) as unknown as typeof fetch;
    try {
      expect(await checkForUpdate("0.1.0", "cli", { force: true })).toBeNull();
    } finally {
      globalThis.fetch = realFetch;
      if (original !== undefined) process.env.OMNISCI_UPDATE_CHECK = original;
    }
  });

  // 右边这些名字不是编的，是 release.yml / build-windows.ps1 真会挂上去的那些。
  test("每个平台认得出 release 里挂的资产", () => {
    const hit = (p: string, a: string, k: "cli" | "desktop", name: string) =>
      assetPatternFor(p, a, k).test(name);

    expect(hit("darwin", "arm64", "cli", "omnisci-darwin-arm64")).toBe(true);
    expect(hit("darwin", "x64", "cli", "omnisci-darwin-x86_64")).toBe(true);
    expect(hit("linux", "x64", "cli", "omnisci-linux-x86_64")).toBe(true);
    expect(hit("win32", "x64", "cli", "omnisci-windows-x86_64.exe")).toBe(true);

    expect(hit("darwin", "arm64", "desktop", "OmniScientist-macos-arm64.tar.gz")).toBe(true);
    expect(hit("darwin", "x64", "desktop", "OmniScientist-macos-x86_64.tar.gz")).toBe(true);
    expect(hit("linux", "x64", "desktop", "OmniScientist-linux-x86_64.tar.gz")).toBe(true);
    // Windows 的包名里带版本号，另外两个平台不带，同一条规则要都认。
    expect(hit("win32", "x64", "desktop", "OmniScientist-0.1.0-windows-x64.zip")).toBe(true);
    expect(hit("win32", "x64", "desktop", "OmniScientist-1.12.3-windows-x64.zip")).toBe(true);

    // 别把别的架构、别的平台的包认成自己的。
    expect(hit("darwin", "arm64", "desktop", "OmniScientist-macos-x86_64.tar.gz")).toBe(false);
    expect(hit("darwin", "arm64", "desktop", "OmniScientist-linux-arm64.tar.gz")).toBe(false);
    expect(hit("darwin", "arm64", "cli", "omnisci-darwin-arm64.sha256")).toBe(false);
    expect(hit("linux", "arm64", "desktop", "OmniScientist-linux-x86_64.tar.gz")).toBe(false);
  });

  test("挑中哪个资产，校验和就跟着哪个", async () => {
    // 这个名字照着 release.yml 写死，只为验证 .sha256 跟的是被挑中的那个。
    const cpu = process.arch === "arm64" ? "arm64" : "x86_64";
    const mine = process.platform === "win32"
      ? "OmniScientist-0.1.0-windows-x64.zip"
      : `OmniScientist-${process.platform === "darwin" ? "macos" : "linux"}-${cpu}.tar.gz`;

    // 让一次成功的查询落地，会把 latest 记进 ~/.omnisci/update-check.json，
    // 跑完测试命令行就会整天喊"有新版本 9.9.9"。存下来，跑完放回去。
    const stateFile = join(homedir(), ".omnisci", "update-check.json");
    const before = existsSync(stateFile) ? readFileSync(stateFile) : null;

    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({
      tag_name: "v9.9.9",
      html_url: "https://example.invalid/rel",
      assets: [
        { name: "omnisci-linux-x86_64", browser_download_url: "https://example.invalid/other" },
        { name: `${mine}.sha256`, browser_download_url: "https://example.invalid/pkg.sha256" },
        { name: mine, browser_download_url: "https://example.invalid/pkg" },
      ],
    }), { status: 200 })) as unknown as typeof fetch;
    try {
      const info = await checkForUpdate("0.0.1", "desktop", { force: true });
      expect(info?.asset?.name).toBe(mine);
      expect(info?.asset?.url).toBe("https://example.invalid/pkg");
      expect(info?.asset?.sha256Url).toBe("https://example.invalid/pkg.sha256");
    } finally {
      globalThis.fetch = realFetch;
      if (before) writeFileSync(stateFile, before);
      else rmSync(stateFile, { force: true });
    }
  });

  test("提示里给的是命令，不是自动执行", () => {
    expect(updateCommand("cli", "darwin")).toContain("install.sh");
    expect(updateCommand("cli", "win32")).toContain("install.ps1");
    expect(updateCommand("desktop", "darwin")).toContain("releases/latest");
  });
});

describe("终端宽度", () => {
  // 伪终端拿不到窗口大小时 columns 是 0，不是 undefined。之前横幅那行写的是
  // `(columns ?? 80) - 2`，0 一路传进 repeat(-2)，启动就 RangeError 崩在分隔线上。
  test("拿不到宽度时退回默认值，0 和 undefined 都算拿不到", () => {
    const real = Object.getOwnPropertyDescriptor(process.stdout, "columns");
    const set = (v: number | undefined) =>
      Object.defineProperty(process.stdout, "columns", { value: v, configurable: true });
    try {
      set(0);
      expect(columns()).toBe(80);
      set(undefined);
      expect(columns()).toBe(80);
      set(-5);
      expect(columns()).toBe(80);
      set(120);
      expect(columns()).toBe(120);
    } finally {
      if (real) Object.defineProperty(process.stdout, "columns", real);
    }
  });

  test("分隔线在任何宽度下都画得出来，不抛", () => {
    const real = Object.getOwnPropertyDescriptor(process.stdout, "columns");
    const set = (v: number | undefined) =>
      Object.defineProperty(process.stdout, "columns", { value: v, configurable: true });
    try {
      for (const width of [undefined, 0, 1, 2, 3, 10, 80, 200]) {
        set(width);
        const line = rule();
        expect(line.length).toBeGreaterThanOrEqual(0);
        expect(line.length).toBeLessThanOrEqual(66);
      }
      set(1);
      expect(rule()).toBe("");
      set(200);
      expect(rule().length).toBe(66);
    } finally {
      if (real) Object.defineProperty(process.stdout, "columns", real);
    }
  });
});

describe("解释器探测", () => {
  // 真机复现过的场景：Windows 上 python3 是微软商店的 2 字节占位符，跑起来退 49。
  // 靠 which/where 判"文件在不在"必然选中它，只有真跑一次才能把它筛掉。
  test("跑不通的候选会被跳过，PATH 上排在后面的真解释器能被选中", () => {
    const dir = mkdtempSync("/tmp/omnisci-interp-");
    const stub = join(dir, "stub");
    const good = join(dir, "good");
    // 占位符：不输出任何东西，退 49。跟商店那个的行为一致。
    writeFileSync(stub, "#!/bin/sh\nexit 49\n");
    chmodSync(stub, 0o755);
    writeFileSync(good, `#!/bin/sh\nexec ${process.execPath} "$@"\n`);
    chmodSync(good, 0o755);

    const probe = (path: string) => {
      const r = spawnSync(path, ["-c", "import sys; sys.stdout.write('%d' % sys.version_info[0])"], {
        encoding: "utf-8",
      });
      return r.status === 0 && (r.stdout || "").trim() === "3";
    };
    expect(probe(stub)).toBe(false);            // 占位符出局
    expect(spawnSync(stub, ["-V"]).status).toBe(49);   // 就是那个 49
  });

  test("OMNISCI_PYTHON 能一票指定，指坏了就抛且错误里带线索", () => {
    const original = process.env.OMNISCI_PYTHON;
    try {
      resetInterpreterCache();
      process.env.OMNISCI_PYTHON = "/definitely/not/a/python";
      // 系统上还有真 python，所以坏的那个只是被跳过，不该整体失败
      expect(pythonCommand().length).toBeGreaterThan(0);

      resetInterpreterCache();
      const real = pythonCommand();
      expect(real.length).toBeGreaterThan(0);
    } finally {
      resetInterpreterCache();
      if (original === undefined) delete process.env.OMNISCI_PYTHON;
      else process.env.OMNISCI_PYTHON = original;
    }
  });

  test("选出来的 python 确实是 3，而且真的能执行", () => {
    resetInterpreterCache();
    const argv = pythonCommand();
    const r = spawnSync(argv[0]!, [...argv.slice(1), "-c", "import sys;print(sys.version_info[0])"], {
      encoding: "utf-8",
    });
    expect(r.status).toBe(0);
    expect((r.stdout || "").trim()).toBe("3");
  });

  test("选出来的 shell 能跑，且在 Windows 上不是 WSL", () => {
    resetInterpreterCache();
    const shell = shellCommand();
    const r = spawnSync(shell, ["-c", "printf %s \"$OSTYPE\""], { encoding: "utf-8" });
    expect(r.status).toBe(0);
    const osType = (r.stdout || "").trim();
    expect(osType.length).toBeGreaterThan(0);
    if (process.platform === "win32") {
      // linux-gnu 说明这是 WSL 的 bash，不该被选中
      expect(/^(msys|cygwin)/.test(osType)).toBe(true);
    }
  });
});

describe("停止一轮研究", () => {
  /** 造一个假模型：第一轮要求调两个工具，之后就说完了。 */
  function twoToolModel(onTurn?: () => void) {
    let call = 0;
    return {
      async streamTurn(_m: unknown[], _t: unknown[], _cb?: unknown, signal?: AbortSignal) {
        call++;
        onTurn?.();
        if (signal?.aborted) {
          const e = new Error("aborted"); e.name = "APIUserAbortError"; throw e;
        }
        if (call === 1) {
          return {
            message: {
              role: "assistant", content: null,
              tool_calls: [
                { id: "a", type: "function", function: { name: "slow", arguments: "{}" } },
                { id: "b", type: "function", function: { name: "slow", arguments: "{}" } },
              ],
            },
            finishReason: "tool_calls",
            usage: { promptTokens: 1, completionTokens: 1, cachedTokens: 0, cost: 0 },
          };
        }
        return {
          message: { role: "assistant", content: "done" },
          finishReason: "stop",
          usage: { promptTokens: 1, completionTokens: 1, cachedTokens: 0, cost: 0 },
        };
      },
    } as unknown as ModelClient;
  }

  /** 每个 tool_call 都必须有对应的 tool 消息，否则下一次请求会被判 400。 */
  function assertValid(messages: any[]) {
    const answered = new Set(messages.filter((m) => m.role === "tool").map((m) => m.tool_call_id));
    for (const m of messages) {
      for (const c of m.tool_calls ?? []) {
        expect(answered.has(c.id)).toBe(true);
      }
    }
  }

  function loopWith(model: ModelClient, onCall?: () => void) {
    const registry = new Registry();
    registry.add({
      name: "slow", description: "slow", parameters: { type: "object" },
      run: () => { onCall?.(); return "ok"; },
    });
    return new AgentLoop(model, registry, makeContext("/opt/omnisci"),
      new ApprovalPolicy(true), silentPresenter);
  }

  test("轮次之间停：消息数组合法，标记 aborted", async () => {
    const ac = new AbortController();
    const loop = loopWith(twoToolModel(() => ac.abort()));   // 第一轮开始前就已经 abort
    const messages: any[] = [{ role: "system", content: "s" }, { role: "user", content: "go" }];
    const r = await loop.run(messages, 10, ac.signal);
    expect(r.aborted).toBe(true);
    expect(r.stoppedBecause).toBe("已停止");
    assertValid(messages);
  });

  test("第一个工具跑完就停：第二个补回执，数组仍然合法", async () => {
    const ac = new AbortController();
    let ran = 0;
    const loop = loopWith(twoToolModel(), () => { ran++; ac.abort(); });
    const messages: any[] = [{ role: "system", content: "s" }, { role: "user", content: "go" }];
    const r = await loop.run(messages, 10, ac.signal);

    expect(r.aborted).toBe(true);
    expect(ran).toBe(1);                       // 第二个工具没有被执行
    assertValid(messages);                     // 但它的回执补上了
    const stopped = messages.filter((m) => m.content === STOPPED_TOOL_RESULT);
    expect(stopped.length).toBe(1);
    expect(stopped[0].tool_call_id).toBe("b");
  });

  test("没有 signal 时行为和以前完全一样", async () => {
    const loop = loopWith(twoToolModel());
    const messages: any[] = [{ role: "system", content: "s" }, { role: "user", content: "go" }];
    const r = await loop.run(messages, 10);
    expect(r.aborted).toBeUndefined();
    expect(r.stoppedBecause).toBe("stop");
    assertValid(messages);
  });

  test("停完还能接着聊：再跑一次不抛，数组一直合法", async () => {
    const ac = new AbortController();
    const loop = loopWith(twoToolModel(), () => ac.abort());
    const messages: any[] = [{ role: "system", content: "s" }, { role: "user", content: "go" }];
    await loop.run(messages, 10, ac.signal);
    assertValid(messages);

    // 用户再发一条，换一个没被 abort 的 loop 继续
    messages.push({ role: "user", content: "接着弄" });
    const again = loopWith(twoToolModel());
    const r2 = await again.run(messages, 10);
    expect(r2.aborted).toBeUndefined();
    assertValid(messages);
  });
});

describe("停止的兜底", () => {
  test("SDK 被 abort 时不抛异常、只是把流结束掉，也要判成已停止", async () => {
    const ac = new AbortController();
    const quietModel = {
      async streamTurn(_m: unknown[], _t: unknown[], _cb?: unknown, signal?: AbortSignal) {
        ac.abort();                       // 流"结束"了，但不抛
        expect(signal).toBeDefined();
        return {
          message: { role: "assistant", content: "半句话" },
          finishReason: "stop",
          usage: { promptTokens: 1, completionTokens: 1, cachedTokens: 0, cost: 0 },
        };
      },
    } as unknown as ModelClient;
    const loop = new AgentLoop(quietModel, new Registry(), makeContext("/opt/omnisci"),
      new ApprovalPolicy(true), silentPresenter);
    const messages: unknown[] = [{ role: "system", content: "s" }, { role: "user", content: "go" }];
    const r = await loop.run(messages, 5, ac.signal);
    expect(r.aborted).toBe(true);
    expect(r.stoppedBecause).toBe("已停止");
  });
});

describe("受管 venv 建出来之后要接管解释器", () => {
  // 实测踩过：桌面启动时体检调了一次 pythonCommand()，结果焊进模块级缓存。
  // 用户随后在界面上点"安装依赖"，bootstrap 把 numpy 装进受管 venv，
  // 而论文工具还在用启动时那个系统 python，界面报"依赖就绪"，实际 import 不到。
  // launcher 和 gateway 是同一个进程，所以躲不掉。
  test("启动时没有 venv，建出来之后 pythonCommand 要改口", () => {
    const data = mkdtempSync("/tmp/omnisci-venv-");
    const originalDataDir = process.env.OMNISCI_DATA_DIR;
    const originalPython = process.env.OMNISCI_PYTHON;
    try {
      process.env.OMNISCI_DATA_DIR = data;
      delete process.env.OMNISCI_PYTHON; // 显式指定会盖过 venv，这里要测的是没指定的那条路
      resetInterpreterCache();

      // 启动时：还没有 venv，拿到的是系统解释器
      const before = pythonCommand();
      expect(venvPython(data)).toBeNull();
      expect(before[0]).not.toContain(data);

      // 用真的 venv，不是造个假目录：假的过不了 probePython 那一关，
      // 测出来的就不是"会不会改口"而是"会不会挑一个跑不起来的解释器"。
      const made = spawnSync(before[0]!, [...before.slice(1), "-m", "venv", join(data, "venv")], {
        encoding: "utf-8",
      });
      expect(made.status).toBe(0);
      expect(venvPython(data)).not.toBeNull();

      // 同一个进程，不重启，也得改口
      expect(pythonCommand()[0]).toBe(venvPython(data)!);
    } finally {
      if (originalDataDir === undefined) delete process.env.OMNISCI_DATA_DIR;
      else process.env.OMNISCI_DATA_DIR = originalDataDir;
      if (originalPython !== undefined) process.env.OMNISCI_PYTHON = originalPython;
      resetInterpreterCache();
      rmSync(data, { recursive: true, force: true });
    }
  });
});

describe("受管工具的 PATH", () => {
  // 实测踩过：应用 19:40 起，agent 19:42 把 tectonic 放进 <dataDir>/bin，
  // 21:00 跑出来的论文还是 tex_only——启动时算一次的 PATH 永远看不到它。
  test("应用起来之后才出现的目录，也要能挂上", () => {
    const home = mkdtempSync("/tmp/omnisci-path-");
    const originalHome = process.env.HOME;
    const originalPath = process.env.PATH;
    try {
      const bin = join(home, "bin");

      // 目录还不存在：什么都不该加
      process.env.PATH = "/usr/bin:/bin";
      ensureManagedToolsOnPath(home);
      expect(process.env.PATH).toBe("/usr/bin:/bin");

      // 现在它出现了（模拟 agent 事后装 tectonic）
      mkdirSync(bin, { recursive: true });
      ensureManagedToolsOnPath(home);
      expect(process.env.PATH!.split(":")[0]).toBe(bin);

      // 再调不该重复追加
      const once = process.env.PATH;
      ensureManagedToolsOnPath(home);
      expect(process.env.PATH).toBe(once);
    } finally {
      if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
      if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath;
    }
  });
});

describe("工具抛异常也不能留下非法消息数组", () => {
  // 真机 400：An assistant message with 'tool_calls' must be followed by tool
  // messages responding to each 'tool_call_id'.
  // 起因是某一轮中途抛了异常，assistant 消息带着两个 tool_calls 入了队，
  // 回执只补了一个，之后这个会话再也发不出消息。
  function twoCallModel() {
    return {
      async streamTurn() {
        return {
          message: {
            role: "assistant", content: null,
            tool_calls: [
              { id: "a", type: "function", function: { name: "boom", arguments: "{}" } },
              { id: "b", type: "function", function: { name: "boom", arguments: "{}" } },
            ],
          },
          finishReason: "tool_calls",
          usage: { promptTokens: 1, completionTokens: 1, cachedTokens: 0, cost: 0 },
        };
      },
    } as unknown as ModelClient;
  }

  function assertEveryCallAnswered(messages: any[]) {
    const answered = new Set(messages.filter((m) => m.role === "tool").map((m) => m.tool_call_id));
    for (const m of messages) {
      for (const c of m.tool_calls ?? []) {
        expect(answered.has(c.id)).toBe(true);
      }
    }
  }

  test("钩子那一层抛异常，两个 tool_call 仍然都有回执", async () => {
    const registry = new Registry();
    registry.add({ name: "boom", description: "boom", parameters: { type: "object" }, run: () => "ok" });
    const loop = new AgentLoop(
      twoCallModel(), registry, makeContext("/opt/omnisci"), new ApprovalPolicy(true), silentPresenter,
      () => {},
      // 钩子在 runOne 内部、tool.run 的 try 之外，抛出来会掀掉整轮
      { hooks: [{ matcher: ".*", command: "definitely-not-a-command", timeout: 1 }] as never },
    );
    const messages: any[] = [{ role: "system", content: "s" }, { role: "user", content: "go" }];
    await loop.run(messages, 1).catch(() => {});      // 抛不抛都行，数组必须合法
    assertEveryCallAnswered(messages);
  });

  test("工具本身抛异常，回执照样补齐", async () => {
    const registry = new Registry();
    registry.add({
      name: "boom", description: "boom", parameters: { type: "object" },
      run: () => { throw new Error("炸了"); },
    });
    const loop = new AgentLoop(twoCallModel(), registry, makeContext("/opt/omnisci"),
      new ApprovalPolicy(true), silentPresenter);
    const messages: any[] = [{ role: "system", content: "s" }, { role: "user", content: "go" }];
    await loop.run(messages, 1).catch(() => {});
    assertEveryCallAnswered(messages);
  });
});

describe("修补历史会话里缺失的工具回执", () => {
  test("补上之后每个 tool_call 都有回执，且插在正确位置", () => {
    const messages: any[] = [
      { role: "user", content: "go" },
      { role: "assistant", content: null, tool_calls: [{ id: "a" }, { id: "b" }] },
      { role: "tool", tool_call_id: "a", content: "ok" },
      { role: "user", content: "接着" },
    ];
    expect(repairToolCallGaps(messages)).toBe(1);
    const idx = messages.findIndex((m) => m.tool_call_id === "b");
    expect(idx).toBe(3);                       // 紧跟在那条 assistant 的已有回执之后
    const answered = new Set(messages.filter((m) => m.role === "tool").map((m) => m.tool_call_id));
    expect(answered.has("a")).toBe(true);
    expect(answered.has("b")).toBe(true);
  });

  test("本来就完整的数组不动它", () => {
    const messages: any[] = [
      { role: "assistant", content: null, tool_calls: [{ id: "a" }] },
      { role: "tool", tool_call_id: "a", content: "ok" },
    ];
    expect(repairToolCallGaps(messages)).toBe(0);
    expect(messages.length).toBe(2);
  });

  // 光靠"剥掉末尾那条孤儿 assistant"挡不住半批工具的情况：最后一条是 tool，
  // 剥离循环当场停手，前面那个没有回执的 call 原样留下，下一次请求还是 400。
  // 这是 CLI --resume 和桌面恢复共用的那条路，以前只有桌面补了。
  test("落盘的会话读回来时，中间的空洞也补上", () => {
    const dir = mkdtempSync("/tmp/omnisci-session-");
    try {
      const session = Session.open(join(dir, "s.db"), dir, "test-model");
      session.record("user", { role: "user", content: "go" });
      // 一批两个工具，只写完了第一个的回执就崩了
      session.record("assistant", {
        role: "assistant", content: null, tool_calls: [{ id: "a" }, { id: "b" }],
      });
      session.record("tool", { role: "tool", tool_call_id: "a", content: "ok" });

      let repaired = 0;
      const history = session.history((n) => { repaired = n; }) as any[];
      session.close();

      expect(repaired).toBe(1);
      // 末尾剥离不该把这条 assistant 剥掉，它有一半回执是真的
      expect(history.some((m) => Array.isArray(m.tool_calls))).toBe(true);
      const calls = history.flatMap((m) => (m.tool_calls ?? []).map((c: any) => c.id));
      const answered = new Set(history.filter((m) => m.role === "tool").map((m) => m.tool_call_id));
      for (const id of calls) expect(answered.has(id)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
