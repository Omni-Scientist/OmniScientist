import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Session } from "../../cli/src/session.ts";
import type { ChatMessage } from "../src/types.ts";
import { WebSessionStore } from "./session-store.ts";

const temporaryDirectories: string[] = [];

function temporaryDatabase(): { directory: string; path: string } {
  const directory = mkdtempSync(join(tmpdir(), "omnisci-desktop-session-test-"));
  temporaryDirectories.push(directory);
  return { directory, path: join(directory, "sessions.db") };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("WebSessionStore", () => {
  test("backfills visible conversation text without exposing raw tool rows", () => {
    const { directory, path } = temporaryDatabase();
    const session = Session.open(path, directory, "test-model");
    session.turn = 1;
    session.record("user", {
      role: "user",
      content: "检查统计假设\n\n<适用规矩>hidden system rule</适用规矩>",
    });
    session.record("assistant", {
      role: "assistant",
      content: "我先检查数据。",
      tool_calls: [{ id: "call-1", function: { name: "run_python", arguments: "{}" } }],
    });
    session.record("tool", {
      role: "tool",
      tool_call_id: "call-1",
      content: `SECRET RAW RESULT ${directory}/private.npy`,
    });
    session.record("assistant", { role: "assistant", content: "结论通过稳健性检验。" });
    const internalId = session.id;
    session.close();

    const store = new WebSessionStore(
      path,
      directory,
      "workspace",
      "test-model",
      (value) => value.replaceAll(directory, "$WORKSPACE"),
    );
    const restored = store.load(internalId);

    expect(restored?.title).toBe("检查统计假设");
    expect(restored?.messages.map((message) => message.content)).toEqual([
      "检查统计假设",
      "我先检查数据。\n\n结论通过稳健性检验。",
    ]);
    expect(JSON.stringify(restored?.messages)).not.toContain("SECRET RAW RESULT");
    expect(JSON.stringify(restored?.messages)).not.toContain("hidden system rule");
    expect(store.toolResults(internalId)).toEqual([{
      turn: 1,
      tool: "run_python",
      source: "{}",
      output: `SECRET RAW RESULT ${directory}/private.npy`,
    }]);
    store.close();
  });

  test("restores a saved web snapshot after reopening the database", () => {
    const { directory, path } = temporaryDatabase();
    const session = Session.open(path, directory, "test-model");
    const internalId = session.id;
    session.close();
    const messages: ChatMessage[] = [{
      id: "user-1",
      role: "user",
      author: "你",
      time: "12:00",
      content: "继续写结果部分",
    }];

    const first = new WebSessionStore(path, directory, "workspace", "test-model", (value) => value);
    first.save(internalId, {
      title: "结果部分",
      preview: "继续写结果部分",
      updatedAt: "2026-08-12T01:00:00.000Z",
      status: "complete",
      dataPath: "datasets/histopath",
      messages,
    });
    first.close();

    const reopened = new WebSessionStore(path, directory, "workspace", "test-model", (value) => value);
    expect(reopened.load(internalId)).toMatchObject({
      internalId,
      title: "结果部分",
      preview: "继续写结果部分",
      status: "complete",
      messages,
    });
    reopened.close();
  });

  test("数据目录跟着会话存，重开还在", () => {
    // 不存它的话：重开之后 caseRoot 退成工作区根，收据里的 host/paper.pdf
    // 会被拿去 <工作区>/host/ 下找，找不到，产物面板一片空白——而论文就在盘上。
    const { directory, path } = temporaryDatabase();
    const session = Session.open(path, directory, "test-model");
    const internalId = session.id;
    session.close();

    const first = new WebSessionStore(path, directory, "workspace", "test-model", (v) => v);
    first.save(internalId, {
      title: "跑一篇论文",
      preview: "完成",
      updatedAt: "2026-08-16T11:00:00.000Z",
      status: "complete",
      dataPath: "datasets/histopath",
      messages: [{ id: "u1", role: "user", author: "你", time: "19:00", content: "跑一篇论文" }],
    });
    first.close();

    const reopened = new WebSessionStore(path, directory, "workspace", "test-model", (v) => v);
    expect(reopened.load(internalId)?.dataPath).toBe("datasets/histopath");
    expect(reopened.list()[0]?.dataPath).toBe("datasets/histopath");
    reopened.close();
  });

  test("老会话没存过数据目录，从对话里捞得回来", () => {
    // data_path 是后加的列。加之前跑完的会话那一格是空的，但提交给模型的消息里
    // 带过 <数据目录>…</数据目录>，那是当时真正用的值，取回来是确定的不是猜的。
    const { directory, path } = temporaryDatabase();
    const session = Session.open(path, directory, "test-model");
    const internalId = session.id;
    session.record("user", {
      role: "user",
      content: "跑一篇论文\n\n<数据目录>datasets/histopath</数据目录>\n产物写在 datasets/histopath/host 下。",
    });
    session.close();

    const store = new WebSessionStore(path, directory, "workspace", "test-model", (v) => v);
    expect(store.load(internalId)?.dataPath).toBe("datasets/histopath");
    store.close();
  });
});
