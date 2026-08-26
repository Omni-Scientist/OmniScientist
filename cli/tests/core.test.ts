import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

import { ApprovalPolicy } from "../src/approval.ts";
import { Session } from "../src/session.ts";
import {
  AgentLoop, MAX_TURNS, repairToolCallGaps, STOPPED_TOOL_RESULT, UNATTENDED_MAX_TURNS,
  type Presenter,
} from "../src/loop.ts";
import {
  DEFAULT_EFFORT, EFFORT_LEVELS, ModelClient, PROVIDERS, quirks, REASONING_HEADROOM,
  supportsEffort, tokenCapField,
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
  budgetOf, calibrateTokens, compact, contextLimit, keepRecentTurns, resetCalibration,
  setContextLimit, tokenCalibration, toolResultBudget, sideRequestBudget,
} from "../src/context.ts";
import {
  basePythonCommand, basePythonCommandAsync, ensureManagedToolsOnPath, FIND_SPEC_PROBE,
  missingModules, pythonCommand, pythonCommandAsync, resetInterpreterCache,
  shellCommand, venvPython,
} from "../src/interpreters.ts";
import { gatherSignals, resetSignalCache } from "../src/triggers.ts";
import { overlongInputFrom, tokenCapFromError, unparsedToolCallHint, usableArguments, MALFORMED_KEY, stripReasoning } from "../src/model.ts";
import { harvestEnvAssignments } from "../src/shell-env.ts";
import { withPythonPath } from "../src/interpreters.ts";
import { RepeatTracker } from "../src/loop.ts";
import { ArtifactStore } from "../src/artifacts.ts";
import { FS_TOOLS } from "../src/tools/fs.ts";

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

describe("换掉配置之后已有的会话跟着走", () => {
  // 用户在设置里换掉一个欠费的 key，回旧对话接着跑，撞的还是旧 key，只有新建会话
  // 才好使——这是 2026-08-24 真机上踩的。会话里的 client 是被工具和主循环各攥一份
  // 引用的，所以只能原地改，reconfigure 就是干这个的。
  test("原地换掉通道和模型，攥着同一个引用的地方也跟着变", () => {
    const client = new ModelClient({
      provider: "deepseek", model: "deepseek-v4-flash", apiKey: "sk-old-key-1234",
    });
    // 会话里的工具就是这么存的：一个引用，不是配置的副本。
    const heldByTool = client;

    client.reconfigure({ provider: "openai", model: "gpt-5.6-terra", apiKey: "sk-new-key-5678" });

    expect(heldByTool.provider).toBe("openai");
    expect(heldByTool.model).toBe("gpt-5.6-terra");
  });

  test("底下那个 OpenAI 客户端真的换了 key 和地址", () => {
    // 光看 provider/model 换了不够：402 是 key 发出去才报的。这两个字段藏在私有的
    // OpenAI 实例里，只能伸手进去看，否则这条修复没有任何东西真正验证到。
    const inner = (c: ModelClient) => (c as unknown as { client: { apiKey: string; baseURL: string } }).client;

    const client = new ModelClient({
      provider: "deepseek", model: "deepseek-v4-flash", apiKey: "sk-old-key-1234",
    });
    expect(inner(client).apiKey).toBe("sk-old-key-1234");

    client.reconfigure({
      provider: "deepseek", model: "deepseek-v4-flash", apiKey: "sk-new-key-5678",
      baseURL: "https://example.invalid/v1",
    });
    expect(inner(client).apiKey).toBe("sk-new-key-5678");
    expect(inner(client).baseURL).toBe("https://example.invalid/v1");
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

    expect(hit("darwin", "arm64", "cli", "omnisci-CLI-macOS.tar.gz")).toBe(true);
    expect(hit("linux", "x64", "cli", "omnisci-CLI-Linux-x64.tar.gz")).toBe(true);
    expect(hit("linux", "arm64", "cli", "omnisci-CLI-Linux-ARM64.tar.gz")).toBe(true);
    expect(hit("win32", "x64", "cli", "omnisci-CLI-Windows-x64.zip")).toBe(true);

    expect(hit("darwin", "arm64", "desktop", "OmniSci-Desktop-macOS.zip")).toBe(true);
    expect(hit("linux", "x64", "desktop", "OmniSci-Desktop-Linux-x64.tar.gz")).toBe(true);
    expect(hit("linux", "arm64", "desktop", "OmniSci-Desktop-Linux-ARM64.tar.gz")).toBe(true);
    expect(hit("win32", "x64", "desktop", "OmniSci-Desktop-Windows-x64.zip")).toBe(true);

    // 别把别的架构、别的平台、别条产品线的包认成自己的。
    expect(hit("linux", "arm64", "desktop", "OmniSci-Desktop-Linux-x64.tar.gz")).toBe(false);
    expect(hit("darwin", "arm64", "desktop", "OmniSci-Desktop-Linux-ARM64.tar.gz")).toBe(false);
    expect(hit("darwin", "arm64", "cli", "OmniSci-Desktop-macOS.zip")).toBe(false);
    expect(hit("darwin", "arm64", "desktop", "omnisci-CLI-macOS.tar.gz")).toBe(false);
    expect(hit("darwin", "arm64", "cli", "omnisci-CLI-macOS.tar.gz.sha256")).toBe(false);

    // 名字里一律不带版本号。带了的一概不认，否则 2026-08-25 之前那种
    // 「只有 Windows 包带版本号」的不一致会悄悄回来。
    expect(hit("win32", "x64", "desktop", "OmniSci-Desktop-0.1.6-Windows-x64.zip")).toBe(false);
    expect(hit("darwin", "arm64", "desktop", "OmniSci-Desktop-0.1.6-macOS.zip")).toBe(false);

    // 桌面版 macOS 是 zip，CLI 是 tar.gz，别串了。
    expect(hit("darwin", "arm64", "desktop", "OmniSci-Desktop-macOS.tar.gz")).toBe(false);
    expect(hit("darwin", "arm64", "cli", "omnisci-CLI-macOS.zip")).toBe(false);
  });

  test("挑中平台对应的资产，校验和指向那一个 SHA256SUMS", async () => {
    // 这个名字照着 release.yml 写死，只为验证挑中的是本机那个包。
    const mine = process.platform === "win32"
      ? "OmniSci-Desktop-Windows-x64.zip"
      : process.platform === "darwin"
        ? "OmniSci-Desktop-macOS.zip"
        : `OmniSci-Desktop-Linux-${process.arch === "arm64" ? "ARM64" : "x64"}.tar.gz`;

    // 让一次成功的查询落地，会把 latest 记进 ~/.omnisci/update-check.json，
    // 跑完测试命令行就会整天喊"有新版本 9.9.9"。存下来，跑完放回去。
    const stateFile = join(homedir(), ".omnisci", "update-check.json");
    const before = existsSync(stateFile) ? readFileSync(stateFile) : null;

    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({
      tag_name: "v9.9.9",
      html_url: "https://example.invalid/rel",
      assets: [
        { name: "omnisci-CLI-Linux-x64.tar.gz", browser_download_url: "https://example.invalid/other" },
        { name: "SHA256SUMS", browser_download_url: "https://example.invalid/SHA256SUMS" },
        { name: mine, browser_download_url: "https://example.invalid/pkg" },
      ],
    }), { status: 200 })) as unknown as typeof fetch;
    try {
      const info = await checkForUpdate("0.0.1", "desktop", { force: true });
      expect(info?.asset?.name).toBe(mine);
      expect(info?.asset?.url).toBe("https://example.invalid/pkg");
      expect(info?.asset?.sumsUrl).toBe("https://example.invalid/SHA256SUMS");
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
  // 从 Finder 启动的 macOS 应用，PATH 只有 /usr/bin:/bin:/usr/sbin:/sbin，
  // 登录 shell 那一份一点都继承不到。实测踩过两次：tectonic 在 ~/.local/bin、
  // poppler 在 /opt/homebrew/bin，终端跑好好的，双击图标起来就"不存在"，
  // 论文编译完卡在渲染审阅页。
  test("用户自己装工具的目录也要挂上，否则 GUI 启动看不见 brew 装的东西", () => {
    const home = mkdtempSync("/tmp/omnisci-userbin-");
    const originalPath = process.env.PATH;
    try {
      const brew = join(home, "brewbin");
      const local = join(home, "localbin");
      mkdirSync(brew, { recursive: true });
      // local 故意不建：不存在的目录不该被挂上去

      process.env.PATH = "/usr/bin:/bin";
      ensureManagedToolsOnPath(home, [brew, local]);

      const parts = process.env.PATH!.split(":");
      expect(parts).toContain(brew);
      expect(parts).not.toContain(local);
      // 受管目录仍然要排在用户目录前面，自带的 tectonic 优先于系统里那份
      expect(parts.indexOf(brew)).toBeGreaterThan(-1);
    } finally {
      if (originalPath !== undefined) process.env.PATH = originalPath;
      rmSync(home, { recursive: true, force: true });
    }
  });

  // 实测踩过：应用 19:40 起，agent 19:42 把 tectonic 放进 <dataDir>/bin，
  // 21:00 跑出来的论文还是 tex_only——启动时算一次的 PATH 永远看不到它。
  test("应用起来之后才出现的目录，也要能挂上", () => {
    const home = mkdtempSync("/tmp/omnisci-path-");
    const originalHome = process.env.HOME;
    const originalPath = process.env.PATH;
    try {
      const bin = join(home, "bin");

      // 目录还不存在：什么都不该加。第二个参数把「用户自己装工具的目录」
      // 清空，否则跑测试那台机器上真实存在的 /opt/homebrew/bin 会被挂进来，
      // 断言就跟被测行为无关了。那条路径由下面单独一个用例盯着。
      process.env.PATH = "/usr/bin:/bin";
      ensureManagedToolsOnPath(home, []);
      expect(process.env.PATH).toBe("/usr/bin:/bin");

      // 现在它出现了（模拟 agent 事后装 tectonic）
      mkdirSync(bin, { recursive: true });
      ensureManagedToolsOnPath(home, []);
      expect(process.env.PATH!.split(":")[0]).toBe(bin);

      // 再调不该重复追加
      const once = process.env.PATH;
      ensureManagedToolsOnPath(home, []);
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


describe("处境信号里的 git 分支", () => {
  test("目录不存在时不抛，只是没有分支信号", () => {
    resetSignalCache();
    const gone = join(tmpdir(), "omnisci-not-a-dir-2f9c1");
    expect(existsSync(gone)).toBe(false);
    // Bun.spawnSync 在 cwd 不存在时是**抛**，不是返回非零。以前没接住，这一抛会
    // 顺着 gatherSignals → createRuntime 冒出去，界面上就是"打开会话 404"。
    // 工作区目录被人改名或删掉时会真的走到这里。
    const signals = gatherSignals(gone, "");
    expect(signals.gitBranch).toBeNull();
    expect(signals.filenames).toEqual([]);
  });

  test("同一个目录在缓存期内不再去问 git", () => {
    resetSignalCache();
    const dir = mkdtempSync(join(tmpdir(), "omnisci-branch-"));
    try {
      if (spawnSync("git", ["init", "-q", "-b", "trunk", dir]).status !== 0) return; // 没装 git 就跳过
      spawnSync("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t",
        "commit", "-q", "--allow-empty", "-m", "x"]);
      expect(gatherSignals(dir, "").gitBranch).toBe("trunk");

      // 把 .git 挪开。真去问的话这时一定问不出分支了；还能拿到 trunk 就证明走的是缓存。
      renameSync(join(dir, ".git"), join(dir, ".git-moved"));
      expect(gatherSignals(dir, "").gitBranch).toBe("trunk");

      // 缓存清掉就该重新去问，这次问不出来。
      resetSignalCache();
      expect(gatherSignals(dir, "").gitBranch).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("依赖探测：find_spec 那一档", () => {
  // 这个脚本写错的后果是静默的：体检会说包缺了，然后一路把用户指去重装一堆
  // 本来就装着的东西。所以拿真解释器跑一遍，不只测字符串。
  const python = (): string[] | null => {
    try { return pythonCommand(); } catch { return null; }
  };

  test("认得出哪个装了哪个没装", () => {
    const py = python();
    if (!py) return;
    const r = spawnSync(py[0]!, [...py.slice(1), "-c", FIND_SPEC_PROBE,
      "sys", "json", "omnisci_no_such_pkg_2f9c1"], { encoding: "utf-8" });
    expect(r.status).toBe(0);
    expect(missingModules(r.stdout || "")).toEqual(["omnisci_no_such_pkg_2f9c1"]);
  });

  test("一个都不缺时是空输出", () => {
    const py = python();
    if (!py) return;
    const r = spawnSync(py[0]!, [...py.slice(1), "-c", FIND_SPEC_PROBE, "sys", "json"],
      { encoding: "utf-8" });
    expect(r.status).toBe(0);
    expect(missingModules(r.stdout || "")).toEqual([]);
  });

  test("解析时空白和空段都不算缺", () => {
    expect(missingModules("")).toEqual([]);
    expect(missingModules("   ")).toEqual([]);
    expect(missingModules("numpy, scipy ,")).toEqual(["numpy", "scipy"]);
  });
});

describe("解释器解析：同步和异步必须是同一个答案", () => {
  // 两条路径各有一份探测代码（一个 spawnSync 一个 Bun.spawn），顺序却只有一份
  // 配方。这几条测的就是「配方共用」这件事真的成立：谁先算都一样，而且互相认账。
  // 走岔的后果很隐蔽：桌面版体检报的是 A 解释器，论文工具跑的是 B。

  test("先异步后同步，答案一致且同步直接命中缓存", async () => {
    resetInterpreterCache();
    const viaAsync = await pythonCommandAsync();
    const viaSync = pythonCommand();
    expect(viaSync).toEqual(viaAsync);
  });

  test("先同步后异步，答案一致", async () => {
    resetInterpreterCache();
    const viaSync = pythonCommand();
    const viaAsync = await pythonCommandAsync();
    expect(viaAsync).toEqual(viaSync);
  });

  test("基础解释器那一档也一致", async () => {
    resetInterpreterCache();
    const viaAsync = await basePythonCommandAsync();
    resetInterpreterCache();
    const viaSync = basePythonCommand();
    expect(viaSync).toEqual(viaAsync);
  });

  test("并发要过来一堆也只认一个结果", async () => {
    resetInterpreterCache();
    const all = await Promise.all(Array.from({ length: 5 }, () => pythonCommandAsync()));
    for (const argv of all) expect(argv).toEqual(all[0]!);
  });
});

describe("从 shell 配置里认领凭据", () => {
  const KEYS = ["OPENAI_API_KEY", "DEEPSEEK_API_KEY", "ANTHROPIC_API_KEY"];

  test("认得出 export 前缀、引号、和裸写", () => {
    const text = [
      "# 统一 API Key 管理",
      'export OPENAI_API_KEY="sk-openai-aaa"',
      "export DEEPSEEK_API_KEY='sk-ds-bbb'",
      "ANTHROPIC_API_KEY=sk-ant-ccc",
    ].join("\n");
    expect(harvestEnvAssignments(text, KEYS)).toEqual({
      OPENAI_API_KEY: "sk-openai-aaa",
      DEEPSEEK_API_KEY: "sk-ds-bbb",
      ANTHROPIC_API_KEY: "sk-ant-ccc",
    });
  });

  test("只认白名单里的名字，别的一概不碰", () => {
    // 把用户 rc 里所有 export 都吸进来会踩到 PATH、LANG、代理设置，
    // 而且是在别人的机器上踩，后果不可预期。
    const text = [
      'export PATH="/opt/evil/bin:$PATH"',
      "export LANG=en_US.UTF-8",
      "export http_proxy=http://127.0.0.1:7890",
      "export OPENAI_API_KEY=sk-only-this-one",
    ].join("\n");
    expect(harvestEnvAssignments(text, KEYS)).toEqual({ OPENAI_API_KEY: "sk-only-this-one" });
  });

  test("命令替换一律不碰，查不到的引用也丢掉", () => {
    // 退回字面的 "$FOO" 比读不到更糟：看起来像配好了，
    // 一路带到 API 请求上才报鉴权失败。
    const text = [
      "export OPENAI_API_KEY=$NEVER_DEFINED_ANYWHERE",
      "export DEEPSEEK_API_KEY=$(cat /tmp/key)",
      "export ANTHROPIC_API_KEY=`cat /tmp/key`",
    ].join("\n");
    expect(harvestEnvAssignments(text, KEYS)).toEqual({});
  });

  test("同文件里的别名要展开", () => {
    // export DEEPSEEK_API_KEY="$DEEPSEEK_KEY" 这种给同一把 key 起别名的写法
    // 很常见。展开它不需要执行任何东西，纯文本替换。实测撞到过：一开始把带 $
    // 的值全丢了，那种写法的 key 就一直认不到。
    const text = [
      "export DEEPSEEK_KEY=sk-the-real-one",
      'export DEEPSEEK_API_KEY="$DEEPSEEK_KEY"',
      'export ANTHROPIC_API_KEY="${DEEPSEEK_KEY}"',
    ].join("\n");
    expect(harvestEnvAssignments(text, KEYS)).toEqual({
      DEEPSEEK_API_KEY: "sk-the-real-one",
      ANTHROPIC_API_KEY: "sk-the-real-one",
    });
  });

  test("别名源不在白名单里也能用来展开，但它自己不会被返回", () => {
    // DEEPSEEK_KEY 不是我们认的名字，可它是别名的源，必须进解析表。
    const text = ["export DEEPSEEK_KEY=sk-source", 'export DEEPSEEK_API_KEY="$DEEPSEEK_KEY"'].join("\n");
    const got = harvestEnvAssignments(text, KEYS);
    expect(got).toEqual({ DEEPSEEK_API_KEY: "sk-source" });
    expect(got.DEEPSEEK_KEY).toBeUndefined();
  });

  test("引用必须在前面定义过，跟 shell 的顺序一致", () => {
    const text = ['export DEEPSEEK_API_KEY="$DEFINED_LATER"', "export DEFINED_LATER=sk-too-late"].join("\n");
    expect(harvestEnvAssignments(text, KEYS)).toEqual({});
  });

  test("单引号里 shell 不展开，我们也不展开", () => {
    const text = ["export DEEPSEEK_KEY=sk-real", "export DEEPSEEK_API_KEY='$DEEPSEEK_KEY'"].join("\n");
    // 字面的 $DEEPSEEK_KEY 不是个能用的 key，丢掉而不是塞进去
    expect(harvestEnvAssignments(text, KEYS)).toEqual({});
  });

  test("绝不回退到 process.env", () => {
    // 回退等于把我们刚决定不信任的那个环境又引回来。
    process.env.OMNISCI_TEST_ALIAS_SOURCE = "not-a-real-key";
    try {
      const text = 'export OPENAI_API_KEY="$OMNISCI_TEST_ALIAS_SOURCE"';
      expect(harvestEnvAssignments(text, KEYS)).toEqual({});
    } finally {
      delete process.env.OMNISCI_TEST_ALIAS_SOURCE;
    }
  });

  test("读不懂的行跳过，不像 loadEnvFile 那样整份拒绝", () => {
    // 用户的 rc 里有 if、函数、alias 是常态。为一行 alias 丢掉整份 key，
    // 用户只会看到「我明明配了」。
    const text = [
      "if [ -f ~/.fzf.bash ]; then",
      "  source ~/.fzf.bash",
      "fi",
      "alias ll='ls -la'",
      "myfunc() { echo hi; }",
      "export OPENAI_API_KEY=sk-survived",
    ].join("\n");
    expect(harvestEnvAssignments(text, KEYS)).toEqual({ OPENAI_API_KEY: "sk-survived" });
  });

  test("注释掉的旧 key 不算数，同名取第一个", () => {
    const text = [
      "# export OPENAI_API_KEY=sk-commented",
      "export OPENAI_API_KEY=sk-current",
      "export OPENAI_API_KEY=sk-later-duplicate",
    ].join("\n");
    expect(harvestEnvAssignments(text, KEYS)).toEqual({ OPENAI_API_KEY: "sk-current" });
  });

  test("没加引号时行尾注释要去掉，加了引号则原样保留", () => {
    const text = [
      "export OPENAI_API_KEY=sk-bare # 这是我的 key",
      'export DEEPSEEK_API_KEY="sk-quoted # 不是注释"',
    ].join("\n");
    expect(harvestEnvAssignments(text, KEYS)).toEqual({
      OPENAI_API_KEY: "sk-bare",
      DEEPSEEK_API_KEY: "sk-quoted # 不是注释",
    });
  });

  test("空值和空文本都给空结果", () => {
    expect(harvestEnvAssignments("", KEYS)).toEqual({});
    expect(harvestEnvAssignments("export OPENAI_API_KEY=", KEYS)).toEqual({});
    expect(harvestEnvAssignments('export OPENAI_API_KEY=""', KEYS)).toEqual({});
  });
});

describe("被输出上限截断的 tool_call（issue #5）", () => {
  // 复现过的因果链：tool_call 流到一半撞上 max_tokens -> arguments 是半截 JSON
  // -> 原样进消息历史 -> 下一轮整份历史发回上游 -> 转换型网关必须 json.loads
  // 这个字段才能转成 Anthropic 的 tool_use.input -> JSONDecodeError -> 400，
  // 报错原文就是 "Unterminated string starting at: line 1 column 32 (char 31)"。
  // DeepSeek 官方通道透传不校验，所以这个坑只在自定义网关上现形。

  test("模型自己吐的坏 JSON 也不能留在历史里（2026-08-26 真 vLLM 上撞到）", () => {
    // 第一版修复只管 finishReason=length 那种截断，漏了「模型自己写坏」这半边。
    // 真环境立刻照出来了：4B 模型吐了个 JSON 就报
    //   400 Expecting ':' delimiter: line 1 column 42 (char 41)
    // 跟 issue #5 的 Unterminated string 是同一族，都是坏 arguments 进了历史。
    expect(usableArguments('{"path" "/x.csv"}')).toBe(false);      // 少冒号
    expect(usableArguments("{'path': '/x.csv'}")).toBe(false);      // 单引号
    expect(usableArguments('{"path": /x.csv}')).toBe(false);        // 值没引号
  });

  test("半截的 arguments 判为不可用，完整的和空的判为可用", () => {
    expect(usableArguments('{"path": "/data/experiments/ru')).toBe(false);
    expect(usableArguments('{"path": "/data/ok.csv"}')).toBe(true);
    // 无参工具的 arguments 本来就是空的，loop.ts 的 runOne 也是这么判的
    expect(usableArguments("")).toBe(true);
    expect(usableArguments("   ")).toBe(true);
  });

  test("resume 时把库里存下的半截 arguments 洗成 {}，且不破坏配对", () => {
    const dir = mkdtempSync(join(tmpdir(), "omnisci-trunc-"));
    try {
      const s = Session.open(join(dir, "s.db"), dir, "m");
      s.record("user", { role: "user", content: "hi" });
      s.record("assistant", { role: "assistant", content: null, tool_calls: [
        { id: "c1", type: "function", function: { name: "read_file", arguments: '{"path": "/data/ru' } },
      ] });
      s.record("tool", { role: "tool", tool_call_id: "c1", content: "ERROR" });
      s.record("user", { role: "user", content: "go" });

      let repaired = 0;
      const msgs = s.history((n) => { repaired = n; }) as any[];
      s.close();

      expect(repaired).toBe(1);
      const call = msgs.find((m) => m.role === "assistant").tool_calls[0];
      // 洗成 {} 而不是删掉：删掉就变成「tool 回执没有对应的 tool_call」，那是另一种 400
      expect(call.function.arguments).toBe("{}");
      expect(JSON.parse(call.function.arguments)).toEqual({});
      expect(msgs.filter((m) => m.role === "tool")).toHaveLength(1);
      // 历史里不能再有任何一条 parse 不动的 arguments
      for (const m of msgs) {
        for (const c of (m.tool_calls ?? [])) expect(usableArguments(c.function.arguments)).toBe(true);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("完整的 arguments 不该被动", () => {
    const dir = mkdtempSync(join(tmpdir(), "omnisci-ok-"));
    try {
      const s = Session.open(join(dir, "s.db"), dir, "m");
      s.record("user", { role: "user", content: "hi" });
      s.record("assistant", { role: "assistant", content: null, tool_calls: [
        { id: "c1", type: "function", function: { name: "read_file", arguments: '{"path": "/ok.csv"}' } },
      ] });
      s.record("tool", { role: "tool", tool_call_id: "c1", content: "ok" });
      s.record("user", { role: "user", content: "go" });

      let repaired = 0;
      const msgs = s.history((n) => { repaired = n; }) as any[];
      s.close();
      expect(repaired).toBe(0);
      expect(msgs.find((m) => m.role === "assistant").tool_calls[0].function.arguments)
        .toBe('{"path": "/ok.csv"}');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("服务端没解析出工具调用时给个能照做的提示", () => {
  // 症状：推理服务没开 tool-call 解析或规则选错，模型明明在调工具，服务端把
  // 整段 <tool_call>… 当普通文本返回。agent 以为模型在闲聊，空转到超时，
  // 什么线索都不留。这几条锁住"从原始标记反推该配哪个规则"这件事。

  test("Qwen3.5 的 XML 标签指向 qwen3_coder", () => {
    // 这段是 Qwen3.5-9B 自己的 chat template 渲染出来的真实格式（2026-08-26 实测），
    // 不是编的。配 qwen25 的话 sglang 解析出 0 个，服务端还不报任何错。
    const raw = ["<tool_call>", "<function=read_file>", "<parameter=path>",
                 "/data/x.csv", "</parameter>", "</function>", "</tool_call>"].join("\n");
    expect(unparsedToolCallHint(raw)?.parser).toBe("qwen3_coder");
  });

  test("各家的标记各自指向自己那套规则", () => {
    expect(unparsedToolCallHint('<tool_call>{"name": "f", "arguments": {}}</tool_call>')?.parser)
      .toBe("qwen25（或 hermes）");
    expect(unparsedToolCallHint('[TOOL_CALLS] [{"name": "f"}]')?.parser).toBe("mistral");
    expect(unparsedToolCallHint('<|python_tag|>f(x=1)')?.parser).toBe("llama3");
  });

  test("模型真的在说话时不许报错", () => {
    // 误报的代价比漏报大：把一次正常回复判成配置错误，等于凭空制造故障。
    expect(unparsedToolCallHint("我先看一下数据集的结构，再决定用什么方法。")).toBeNull();
    expect(unparsedToolCallHint("你可以写成 def function(x) 或者 lambda。")).toBeNull();
    expect(unparsedToolCallHint("")).toBeNull();
  });
});

describe("服务端放不下我们要的输出预算时，按它给的数重来", () => {
  // 我们默认要 8000 输出。OpenAI / DeepSeek 不计较，vLLM 严格校验
  // max_tokens <= 上下文 - 输入，超一个 token 都 400。自建部署为省显存普遍把
  // --max-model-len 开得小，对话一长必撞。2026-08-26 在真 vLLM 上实测撞到。

  test("从 vLLM 那句括号算式里取出可用额度", () => {
    const msg = "'max_tokens' or 'max_completion_tokens' is too large: 8000. This model's "
      + "maximum context length is 32768 tokens and your request has 25201 input tokens "
      + "(8000 > 32768 - 25201)";
    // 32768 - 25201 = 7567，再让出 64 的安全余量
    expect(tokenCapFromError(msg)).toBe(7567 - 64);
  });

  test("换个说法写的也要认得", () => {
    const msg = "max_tokens is too large. This model's maximum context length is 8192 tokens "
      + "and your request has 7000 input tokens.";
    expect(tokenCapFromError(msg)).toBe(8192 - 7000 - 64);
  });

  test("余量小到没意义时返回 null，让错误原样抛出去", () => {
    // 剩这么点还不如直接报错，别让模型在 100 个 token 里挣扎
    expect(tokenCapFromError("(8000 > 32768 - 32700)")).toBeNull();
    expect(tokenCapFromError("(8000 > 32768 - 32768)")).toBeNull();
  });

  test("解析不出来就是 null，绝不猜一个数出来", () => {
    expect(tokenCapFromError("some unrelated 400")).toBeNull();
    expect(tokenCapFromError("")).toBeNull();
    expect(tokenCapFromError("max_tokens is too large")).toBeNull();
  });
});

describe("压缩的触发线要跟着真实窗口走", () => {
  // 默认 384k 是 2026-08-05 照 deepseek-v4-flash 量的。自建 vLLM 普遍把
  // --max-model-len 开到 32k 到 64k，压缩却还在等 384k×0.7=268k，于是一次都不触发，
  // 历史一路涨到撑爆。2026-08-26 在真 vLLM 上实测：输入 65513 / 上限 65536，
  // 占了 99.96%，压缩器毫无反应。

  test("问到窗口之后，触发线跟着变", () => {
    const long = Array.from({ length: 200 }, (_, i) => ({
      role: "user", content: "x".repeat(2000) + i,
    }));
    const used = budgetOf(long).used;

    // 默认 384k：这点量远不到 70%，不该压
    setContextLimit(0);                    // 非法值应被忽略，保持默认
    expect(contextLimit()).toBe(384_000);
    expect(budgetOf(long).shouldCompact).toBe(false);

    // 服务端报了 65536：同样这些消息立刻越线，该压
    setContextLimit(65_536);
    expect(contextLimit()).toBe(65_536);
    expect(used / 65_536).toBeGreaterThan(0.7);
    expect(budgetOf(long).shouldCompact).toBe(true);
  });

  test("非法值一概不认，免得把窗口设成 0 让每轮都压", () => {
    setContextLimit(65_536);
    for (const bad of [0, -1, NaN, Infinity]) {
      setContextLimit(bad);
      expect(contextLimit()).toBe(65_536);   // 还是上一个有效值
    }
  });
});

describe("无人值守跑长了要在循环里压缩", () => {
  // 这是这一族问题的总闸。以前压缩只在 cli.tsx 里、用户每次说话之前查一次：
  // 交互式一问一答天然会回到那儿，可 -d 无人值守只有一次用户输入，然后一头扎进
  // AgentLoop 跑最多 260 轮，历史在里面疯长而压缩器一次都不被调用。
  // 2026-08-26 在真 vLLM 上连撞两次：65513/65536，73043/40960。

  test("AgentLoop 的每轮开头会查预算并压缩", async () => {
    const src = readFileSync(join(import.meta.dir, "..", "src", "loop.ts"), "utf-8");
    const loopStart = src.indexOf("for (let turn = 0; turn < turnLimit");
    const firstCall = src.indexOf("this.model.streamTurn", loopStart);
    const inLoopHead = src.slice(loopStart, firstCall);
    // 预算检查必须在每轮发请求**之前**，不能在循环外
    expect(inLoopHead).toContain("budgetOf(messages)");
    expect(inLoopHead).toContain("compact(");
  });

  test("光输入就超窗口的报错要认得出来", () => {
    // 这种 400 的措辞里根本没有 max_tokens，跟「输出上限要多了」是两回事
    const msg = "This model's maximum context length is 40960 tokens. However, your request "
      + "has 73043 input tokens. Please reduce the length of the input messages.";
    expect(overlongInputFrom(msg)).toEqual({ limit: 40960, used: 73043 });
    expect(tokenCapFromError(msg)).toBeNull();   // 那个函数不该认领它
  });

  test("不相干的报错不许乱认", () => {
    expect(overlongInputFrom("some other 400")).toBeNull();
    expect(overlongInputFrom("")).toBeNull();
  });
});

describe("单条工具结果不许把窗口顶爆", () => {
  // 压缩管的是历史，管不了「单条新消息本身就占窗口一大半」。
  // 2026-08-26 实测：一条 60104 字符的 read_file 让输入从 29591 直接跳到 73438，
  // 一轮之内涨了 44000 token，压缩刚压完就被顶回去。

  test("小窗口上限自动收紧", () => {
    setContextLimit(40_960);
    const b = toolResultBudget(60_000);
    // 40960 * 0.08 * 4 = 13107，远小于 60000
    expect(b).toBeLessThan(60_000);
    expect(b).toBe(Math.floor(40_960 * 0.08 * 4));
    // 折成 token 只占窗口的 8%，连读几次也顶不爆
    expect(b / 4 / 40_960).toBeLessThan(0.1);
  });

  test("大窗口不收紧，保持原来的上限", () => {
    setContextLimit(384_000);
    // 384000 * 0.08 * 4 = 122880 > 60000，取原上限
    expect(toolResultBudget(60_000)).toBe(60_000);
    expect(toolResultBudget(30_000)).toBe(30_000);
  });

  test("窗口再小也留一个能用的下限", () => {
    // 砍到几百字符的话工具结果就没意义了，宁可占比高一点
    setContextLimit(8_192);
    expect(toolResultBudget(60_000)).toBe(8_000);
  });
});

describe("拿服务端真账校准 token 估算", () => {
  // estimateTokens 按「中文 1 字 1 token、其它 4 字符 1 token」估。对中文散文高估
  // 16%，但对 JSON 和源码**低估**（符号密集，真实接近 2 到 3 字符 1 token），
  // 而 agent 历史里全是这两样。2026-08-26 实测：估算说没到阈值，服务端已经
  // 41013 tokens，超了 40960 的窗口 53 个，整轮 400 挂掉。

  test("低估时立刻把系数补上去（宁可早压）", () => {
    resetCalibration();
    expect(tokenCalibration()).toBe(1);
    // 估 10000 实际 15000：我们低估了 50%
    calibrateTokens(10_000, 15_000);
    expect(tokenCalibration()).toBeCloseTo(1.5, 5);
    // 同样的预算，算出来的占用要跟着涨
    setContextLimit(40_960);
    const msgs = [{ role: "user", content: "x".repeat(40_000) }];
    const used = budgetOf(msgs).used;
    resetCalibration();
    expect(budgetOf(msgs).used).toBeLessThan(used);
  });

  test("高估时慢慢放松，不跟着单轮抖动", () => {
    resetCalibration();
    calibrateTokens(10_000, 20_000);          // 先顶到 2.0
    expect(tokenCalibration()).toBeCloseTo(2, 5);
    calibrateTokens(10_000, 10_000);          // 真账回落到 1.0
    // 不该一步跳回 1，而是滑动过去
    expect(tokenCalibration()).toBeGreaterThan(1.1);
    expect(tokenCalibration()).toBeLessThan(2);
  });

  test("离谱的比值不认，那多半是算错了对象", () => {
    resetCalibration();
    for (const [est, act] of [[100, 10_000], [10_000, 100], [0, 500], [500, 0], [NaN, 1], [1, Infinity]]) {
      calibrateTokens(est as number, act as number);
    }
    expect(tokenCalibration()).toBe(1);
  });
});

describe("无人值守模式下压缩必须真的能压", () => {
  // 2026-08-26 真机实测的 bug：findCutPoint 只认 role === "user" 的消息，攒够
  // keepTurns 条才肯切。交互模式下一问一答天然够数，但 `-d` 无人值守整场只有一条
  // user 消息，后面全是 assistant + tool。于是计数永远是 1，永远 <= 6，永远返回 -1。
  // 现象：占用 71% → 74% → 76% 一路涨，三次「压缩中」全是空转，最后 41043 撞穿
  // 40960 的窗口，跑了 20 轮的研究全废。

  /** 造一场无人值守的历史：一条 user，然后全是 assistant + tool 配对。 */
  function unattended(pairs: number): unknown[] {
    const msgs: unknown[] = [{ role: "system", content: "sys" }, { role: "user", content: "去写论文" }];
    for (let i = 0; i < pairs; i++) {
      msgs.push({ role: "assistant", content: null, tool_calls: [{ id: `c${i}`, type: "function", function: { name: "bash", arguments: "{}" } }] });
      msgs.push({ role: "tool", tool_call_id: `c${i}`, content: `结果 ${i} ` + "x".repeat(400) });
    }
    return msgs;
  }

  const fakeModel = {
    streamTurn: async () => ({
      message: { role: "assistant", content: "这是摘要" },
      usage: { promptTokens: 0, completionTokens: 0, cachedTokens: 0 },
      toolCalls: [],
    }),
  } as never;

  test("只有一条 user 消息时也要能找到切点", async () => {
    const msgs = unattended(30);
    const r = await compact(msgs, fakeModel);
    expect(r.summarized).toBeGreaterThan(0);   // 这一条就是当初漏掉的
    expect(r.after).toBeLessThan(r.before);
  });

  test("压完不留孤儿 tool 消息（留了下一轮直接 400）", async () => {
    const r = await compact(unattended(30), fakeModel);
    const out = r.messages as { role: string; tool_calls?: unknown[] }[];
    out.forEach((m, i) => {
      if (m.role !== "tool") return;
      const prev = out[i - 1];
      // tool 回执前面必须是发起它的 assistant，或者另一条 tool（同一组的多个回执）
      expect(prev && (prev.role === "tool" || Array.isArray(prev.tool_calls))).toBe(true);
    });
  });

  test("system 消息永远在第 0 位不动", async () => {
    const r = await compact(unattended(30), fakeModel);
    expect((r.messages[0] as { role: string }).role).toBe("system");
  });

  test("历史太短就老实说没压掉，不假装压过", async () => {
    const r = await compact(unattended(1), fakeModel);
    expect(r.summarized).toBe(0);
    expect(r.after).toBe(r.before);
  });

  test("窗口越小保留的轮次越少", () => {
    setContextLimit(384_000);
    const big = keepRecentTurns();
    setContextLimit(40_960);
    const small = keepRecentTurns();
    expect(small).toBeLessThan(big);
    expect(small).toBeGreaterThan(0);
  });
});

describe("agent 子进程的 python3 要指向体检时验过的那个", () => {
  // 治的坑：agent 跑的命令写的是 `python3 xxx.py`，走 PATH，看不见我们选中的解释器。
  // 于是体检拿受管 venv 验完报「依赖就绪」，agent 一跑却落到系统 python 上，
  // numpy 都没有。2026-08-26 真机上就是靠手工往 PATH 塞软链才绕过去的。

  test("PATH 是空的也能给出一条", () => {
    const out = withPythonPath({});
    // 环境里没 python 时不该硬造，有的话前置进去
    if (out.PATH !== undefined) expect(out.PATH.length).toBeGreaterThan(0);
  });

  test("不改传进来的那个对象", () => {
    const input = { PATH: "/usr/bin", FOO: "bar" };
    const before = JSON.stringify(input);
    withPythonPath(input);
    expect(JSON.stringify(input)).toBe(before);
  });

  test("原来的 PATH 一段都不能丢", () => {
    const out = withPythonPath({ PATH: "/usr/bin:/opt/special/bin" });
    expect(out.PATH).toContain("/usr/bin");
    expect(out.PATH).toContain("/opt/special/bin");
  });

  test("别的环境变量原样带过去", () => {
    const out = withPythonPath({ PATH: "/usr/bin", TOKEN_FREE: "keepme" });
    expect(out.TOKEN_FREE).toBe("keepme");
  });
});

describe("原地打转的工具调用要被折叠", () => {
  // 2026-08-26 真机：8B 模型对着 12 个数据文件调了 79 次 look_at_table，同一个文件
  // 看了 10 次，全程没写一行代码。轮数上限（260）拦不住，重复结果还一直吃窗口。

  test("头两次原样放行，第三次起才算打转", () => {
    const t = new RepeatTracker();
    const a = { file: "data/x.csv" };
    expect(t.note("look_at_table", a, "同样的结果")).toBe(0);
    expect(t.note("look_at_table", a, "同样的结果")).toBe(0); // 确认一遍是正常的
    expect(t.note("look_at_table", a, "同样的结果")).toBe(3);
    expect(t.note("look_at_table", a, "同样的结果")).toBe(4);
  });

  test("结果变了就不算打转，哪怕参数一模一样", () => {
    const t = new RepeatTracker();
    const a = { cmd: "git status" };
    // 盯一个会变的状态：每次输出不同，这是正常用法，不能误伤
    for (let i = 0; i < 6; i++) {
      expect(t.note("bash", a, `第 ${i} 次的输出`)).toBe(0);
    }
  });

  test("结果变回来之后重新计数，不留旧账", () => {
    const t = new RepeatTracker();
    const a = { file: "x" };
    t.note("read_file", a, "A"); t.note("read_file", a, "A");
    expect(t.note("read_file", a, "A")).toBe(3);
    expect(t.note("read_file", a, "B")).toBe(0); // 文件变了
    expect(t.note("read_file", a, "B")).toBe(0); // 重新从头数
  });

  test("参数的键顺序不影响判定", () => {
    const t = new RepeatTracker();
    t.note("look_at_table", { file: "x", question: "q" }, "同样");
    t.note("look_at_table", { question: "q", file: "x" }, "同样");
    expect(t.note("look_at_table", { file: "x", question: "q" }, "同样")).toBe(3);
  });

  test("不同工具、不同参数各算各的", () => {
    const t = new RepeatTracker();
    for (let i = 0; i < 4; i++) {
      expect(t.note("look_at_table", { file: `f${i}.csv` }, "同样")).toBe(0);
    }
    for (let i = 0; i < 4; i++) {
      expect(t.note(`tool${i}`, { file: "same.csv" }, "同样")).toBe(0);
    }
  });

  test("空结果和嵌套参数都不会把它弄崩", () => {
    const t = new RepeatTracker();
    const nested = { a: { b: [1, 2, { c: null }] }, d: undefined };
    t.note("x", nested, ""); t.note("x", nested, "");
    expect(t.note("x", nested, "")).toBe(3);
  });
});

describe("推理块不进消息历史", () => {
  // 本地推理模型（Qwen3、R1 一系）把思考写进 content。vLLM 不加 --reasoning-parser
  // 就是这样，而自建部署十有八九没加。这些内容下一轮再发回去纯属白占窗口。

  test("成对的标签连内容一起剥掉", () => {
    expect(stripReasoning("<think>盘算了很久</think>结论是 42")).toBe("结论是 42");
    expect(stripReasoning("<thinking>x</thinking>答案")).toBe("答案");
    expect(stripReasoning("<reasoning>y</reasoning>答案")).toBe("答案");
  });

  test("多个块、跨行、带属性都认", () => {
    expect(stripReasoning("<think>\na\nb\n</think>正文<think>c</think>尾巴"))
      .toBe("正文尾巴");
    expect(stripReasoning('<think type="x">a</think>正文')).toBe("正文");
  });

  test("开头未闭合就是被截断了，整段都算思考", () => {
    expect(stripReasoning("<think>想到一半就没了")).toBe("");
    expect(stripReasoning("  \n<think>同上")).toBe("");
  });

  test("中间未闭合不动它，那多半是正文在讲这个标签", () => {
    const t = "文档里可以写 <think> 这种标签";
    expect(stripReasoning(t)).toBe(t);
  });

  test("没有推理块就原样返回", () => {
    expect(stripReasoning("普通回答")).toBe("普通回答");
    expect(stripReasoning("")).toBe("");
  });

  test("空的推理块也剥干净（实测就吐过这个）", () => {
    expect(stripReasoning("<think>\n</think>\n\n正文")).toBe("正文");
  });
});

describe("参数写坏时要告诉模型坏在哪", () => {
  // 以前坏 arguments 被换成空的 {}，工具那边只会报「缺少 path」——跟真正的原因
  // 毫无关系，模型看不懂，就原样再写一遍、再坏一次。2026-08-26 实测：30B 模型写
  // python 分析脚本时 write_file 的 arguments 就坏在这上面（代码里的换行和引号没
  // 转义），而写脚本是产出论文的必经一步。

  test("这个键不能跟正常参数名撞上", () => {
    // 撞上的话，一个正常调用会被误判成「参数写坏了」而永远执行不了
    expect(MALFORMED_KEY.startsWith("__")).toBe(true);
    expect(MALFORMED_KEY).toContain("omnisci");
    expect(/^[a-z_]+$/i.test(MALFORMED_KEY.replace(/_/g, "a"))).toBe(true);
  });

  test("装着它的 arguments 本身必须是合法 JSON", () => {
    // 不合法的话下一轮整份历史发回去会被服务端 400 掉 —— 那正是 issue #5 的原病
    const payload = JSON.stringify({ [MALFORMED_KEY]: "解析器说：Unexpected token" });
    const parsed = JSON.parse(payload);
    expect(typeof parsed[MALFORMED_KEY]).toBe("string");
  });
});

describe("输出预算跟着窗口放开", () => {
  // 8000 是照 DeepSeek 的硬上限（8192）来的。换到 --max-model-len=131072 的自建
  // 部署上这个数毫无道理，而且真的挡活：写一整篇论文的 tex 是一次 write_file，
  // 参数装不下就整个被截断丢弃，模型原样重写还是超，来回耗光轮次。

  /** 复刻 raiseOutputBudgetFor 的算法，测的是这条规则本身。 */
  const budgetFor = (win: number, cur = 8000) => {
    if (!Number.isFinite(win) || win <= 0) return cur;
    const target = Math.min(32_000, Math.floor(win / 8));
    return target > cur ? target : cur;
  };

  test("大窗口放开到八分之一", () => {
    expect(budgetFor(131_072)).toBe(16_384);
  });

  test("再大也封顶在 32k（输出是从输入借的，不能借太多）", () => {
    expect(budgetFor(1_000_000)).toBe(32_000);
    expect(budgetFor(400_000)).toBe(32_000);
  });

  test("小窗口不动它，只放开不收紧", () => {
    // 40960/8 = 5120 < 8000，维持原样；真放不下时由 usableCap 那条重试路去砍
    expect(budgetFor(40_960)).toBe(8000);
    expect(budgetFor(8192)).toBe(8000);
  });

  test("问不到窗口就当没发生", () => {
    expect(budgetFor(0)).toBe(8000);
    expect(budgetFor(-1)).toBe(8000);
    expect(budgetFor(NaN)).toBe(8000);
  });
});

describe("续取要有总账，不能分批把大文件全搬回来", () => {
  // toolResultBudget 拦得住「一次大输出打满窗口」，拦不住「分二十次搬完同一份」。
  // 2026-08-26 实测：模型连着 read_more 五次、每次 20000 字符，把 131072 的窗口
  // 撑破，触发了强制压缩救援 —— 而那份内容本来就是因为太大才被存成 artifact 的。

  test("累计量一笔笔加起来", () => {
    const store = new ArtifactStore();
    const a = store.put("bash", "x".repeat(100_000));
    expect(store.fetchedSoFar(a.handle)).toBe(0);
    expect(store.noteFetched(a.handle, 20_000)).toBe(20_000);
    expect(store.noteFetched(a.handle, 20_000)).toBe(40_000);
    expect(store.fetchedSoFar(a.handle)).toBe(40_000);
  });

  test("每个句柄各算各的", () => {
    const store = new ArtifactStore();
    const a = store.put("bash", "a".repeat(1000));
    const b = store.put("bash", "b".repeat(1000));
    store.noteFetched(a.handle, 500);
    expect(store.fetchedSoFar(b.handle)).toBe(0);
  });

  test("没取过的句柄是 0，不是 undefined", () => {
    const store = new ArtifactStore();
    expect(store.fetchedSoFar("art_没有这个")).toBe(0);
  });

  test("负数不倒扣", () => {
    const store = new ArtifactStore();
    const a = store.put("bash", "x".repeat(100));
    store.noteFetched(a.handle, 50);
    expect(store.noteFetched(a.handle, -999)).toBe(50);
  });
});

describe("旁路请求也要放得进窗口", () => {
  // 压缩摘要、教训提炼这类请求不在主对话的账上，最容易被忘掉，于是照着大模型的
  // 手感写死一个数（教训提炼原来是 40000 字符），换到小窗口部署上光这一条就占掉
  // 四分之一。而压缩摘要最需要工作的时刻，恰恰是历史已经撑破窗口的时候。

  test("跟着窗口走", () => {
    setContextLimit(384_000);
    const big = sideRequestBudget();
    setContextLimit(40_960);
    const small = sideRequestBudget();
    expect(small).toBeLessThan(big);
  });

  test("小窗口下也留一个能用的下限", () => {
    setContextLimit(2_000);
    expect(sideRequestBudget()).toBeGreaterThanOrEqual(4_000);
  });

  test("大窗口下比原来那个写死的 40000 宽", () => {
    setContextLimit(131_072);
    expect(sideRequestBudget()).toBeGreaterThan(40_000);
  });
});

describe("坏 JSON 不许落盘", () => {
  // 2026-08-26 实测：30B 手写了一份 25017 字节的 picks.json，第 18 行有个字符串没
  // 闭合。它落盘之后一路传到 lit_cli.py 才炸，而模型看到的是那个 python 脚本的
  // Traceback，根本不知道是自己上一步写的文件坏了、更不知道错在第几行，
  // 对着改了四十分钟没改对。

  const write = FS_TOOLS.find((t) => t.name === "write_file")!;
  const root = mkdtempSync(join(tmpdir(), "omni-json-"));
  const ctx = { resolve: (p: string) => join(root, p) } as never;

  test("坏 JSON 直接拒绝，并且真的没落盘", () => {
    const bad = '[{"title": "没闭合的字符串]';
    expect(() => write.run({ path: "picks.json", content: bad }, ctx)).toThrow(/不是合法 JSON/);
    expect(existsSync(join(root, "picks.json"))).toBe(false);
  });

  test("大块内容额外提示改用脚本生成", () => {
    // 几千字的正文靠手写转义几乎不可能一次写对，而 json.dump 天生不会犯这个错
    const big = '{"Results": "' + "词 ".repeat(2000);
    try {
      write.run({ path: "sections.json", content: big }, ctx);
      throw new Error("本该拒绝");
    } catch (e) {
      expect(String(e)).toMatch(/json\.dump|脚本/);
    }
  });

  test("小段内容不啰嗦，不提脚本那一套", () => {
    try {
      write.run({ path: "tiny.json", content: '{"a":' }, ctx);
      throw new Error("本该拒绝");
    } catch (e) {
      expect(String(e)).not.toMatch(/json\.dump/);
    }
  });

  test("报错要带上解析器给的位置", () => {
    try {
      write.run({ path: "a.json", content: '{"a": 1,}' }, ctx);
      throw new Error("本该拒绝");
    } catch (e) {
      expect(String(e)).toMatch(/解析器说/);
    }
  });

  test("合法 JSON 照常写", () => {
    const good = JSON.stringify([{ title: "x", doi: "10.1/y" }]);
    write.run({ path: "ok.json", content: good }, ctx);
    expect(readFileSync(join(root, "ok.json"), "utf-8")).toBe(good);
  });

  test("只卡 .json，不误伤 .jsonl 和别的后缀", () => {
    // jsonl 是每行一个对象，整体不是合法 JSON，卡它就是误伤
    const lines = '{"a":1}\n{"a":2}\n';
    write.run({ path: "d.jsonl", content: lines }, ctx);
    expect(existsSync(join(root, "d.jsonl"))).toBe(true);
    write.run({ path: "note.txt", content: "{坏的" }, ctx);
    expect(existsSync(join(root, "note.txt"))).toBe(true);
  });

  test("空内容放行（那是清空的意思）", () => {
    write.run({ path: "empty.json", content: "" }, ctx);
    expect(existsSync(join(root, "empty.json"))).toBe(true);
  });
});

describe("打转到一定次数就不再执行", () => {
  // 折叠只压回显，工具照样在跑，模型不理会提示就能一直转到轮次上限。
  // 2026-08-26 实测：30B 连着七次写同一个文件、内容一字不差，折叠每次都如实报了，
  // 它一次都没换路，十七分钟只产出一个脚本。

  test("repeatsFor 报得出当前连击数", () => {
    const t = new RepeatTracker();
    const a = { path: "x.py" };
    expect(t.repeatsFor("write_file", a)).toBe(0);
    for (let i = 0; i < 5; i++) t.note("write_file", a, "一样的结果");
    expect(t.repeatsFor("write_file", a)).toBe(5);
  });

  test("结果一变，连击数就归位", () => {
    const t = new RepeatTracker();
    const a = { cmd: "ls" };
    for (let i = 0; i < 5; i++) t.note("bash", a, "同样");
    expect(t.repeatsFor("bash", a)).toBe(5);
    t.note("bash", a, "变了");
    expect(t.repeatsFor("bash", a)).toBe(1);
  });

  test("没见过的调用是 0，不会误伤第一次", () => {
    const t = new RepeatTracker();
    expect(t.repeatsFor("write_file", { path: "新的.py" })).toBe(0);
  });
});

describe("工具报错要补一句怎么办", () => {
  // 这些 CLI 报的是它自己那层的事实，事实没错，但模型会顺着字面去改那个具体的值，
  // 而不是回头改做法。2026-08-26 实测：DOI 查不到之后，30B 连着换了三个编的 DOI
  // 再试，它读成了「这个号写错了」，而不是「引用不能自己编」。

  /** 复刻 hintFor 的判据，测的是这条规则本身。 */
  const hintFor = (d: string) => {
    if (/DOI did not resolve|did not resolve through/i.test(d)) return "search";
    if (/writing contract failed|prose words; expected|substantive paragraphs; expected/i.test(d)) return "contract";
    if (/ungrounded number|not.{0,20}ledger|没有.{0,10}回执/i.test(d)) return "record";
    return "";
  };

  test("DOI 查不到 → 指向 search", () => {
    expect(hintFor("DOI did not resolve through OpenAlex or Crossref: 10.114/x")).toBe("search");
  });

  test("数字没出处 → 指向重新 record", () => {
    expect(hintFor("ungrounded number 0.947 in Results")).toBe("record");
  });

  test("点名第一个字数不够的节，并算出还差多少词", () => {
    // 只说「一次写一节」太笼统，模型不知从哪下手，照样把整篇重生成一遍（实测每节
    // 130-256 词，跟没提示一样）。要指名道姓。
    const d = "writing contract failed:\n- Introduction has 215 prose words; expected 500-1100";
    const m = /([A-Za-z][\w ]*?) has (\d+) prose words; expected (\d+)/.exec(d);
    expect(m?.[1]).toBe("Introduction");
    expect(Number(m?.[3]) - Number(m?.[2])).toBe(285);
  });

  test("写作契约没满足 → 指向 contract 子命令", () => {
    const d = "writing contract failed:\n- Introduction has 258 prose words; expected 500-1100";
    expect(hintFor(d)).toBe("contract");
  });

  test("认不出的错误什么都不加，宁可不说也不猜", () => {
    expect(hintFor("tectonic: undefined control sequence at line 42")).toBe("");
    expect(hintFor("")).toBe("");
  });
});

describe("硬闸不能反过来造出新的空转", () => {
  // 2026-08-27 实测的回归：硬闸把 read_file 也拦了，模型想看自己刚写的
  // sections.json 看不到，于是一遍遍重试、一遍遍被拒，十次里九次是被拦的。
  // 「拦住空转」变成了「造出空转」。

  test("被拒也要计数，不能让它对着同一堵墙无限撞", () => {
    const t = new RepeatTracker();
    const a = { path: "x.json" };
    for (let i = 0; i < 6; i++) t.note("write_file", a, "一样");
    expect(t.repeatsFor("write_file", a)).toBe(6);
    // 拦下之后计数继续往上走，说的话里的次数才会变，模型才知道自己在撞墙
    expect(t.noteBlocked("write_file", a)).toBe(7);
    expect(t.noteBlocked("write_file", a)).toBe(8);
  });

  test("没记录过的调用被拦，从 1 开始记", () => {
    const t = new RepeatTracker();
    expect(t.noteBlocked("bash", { cmd: "x" })).toBe(1);
  });

  test("只读工具清单里得有 read_file 这些", () => {
    // 名字写错等于硬闸对它们照样生效，回归会悄悄回来
    const readOnly = ["read_file", "read_more", "list_dir", "list_artifacts", "grep_files", "view_image"];
    for (const n of readOnly) expect(typeof n).toBe("string");
    // 写类工具不在里面，硬闸该管的还得管
    for (const n of ["write_file", "edit_file", "bash", "omnisci_compile"]) {
      expect(readOnly.includes(n)).toBe(false);
    }
  });
});
