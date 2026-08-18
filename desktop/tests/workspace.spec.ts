import { expect, test } from "@playwright/test";

// 这套用例的定位符全是中文标签，而界面默认渲染英文（i18n.tsx 的 detect() 一律返回
// "en"，是有意的）。默认一改，7 个用例全红，而它们红的原因跟被测的行为毫无关系 ——
// 实际发生过：整套 e2e 死了 0 passed 都没人发现，因为 CI 根本不跑它。
//
// 所以这里把语言钉死。语言默认值本身由下面单独一个用例盯着，不靠这些用例顺带验证。
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("omnisci.lang", "zh");
  });
});

test("the interface ships in English unless the user picks otherwise", async ({ page }) => {
  // 上面的 beforeEach 把语言钉成了中文，这一个用例要测真实默认值，得先擦掉。
  await page.addInitScript(() => {
    localStorage.removeItem("omnisci.lang");
  });
  await page.goto("/");
  // 挑跟视口无关的东西断言：侧边栏在窄视口下会收成抽屉，拿它当锚点测的是布局不是语言。
  // 语言开关最直接：界面是英文时，它提供的是"切换到中文"。
  await expect(page.getByRole("button", { name: "切换到中文" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open sidebar" })).toBeVisible();
});

test("desktop keeps chat and research outputs side by side", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "STEAD 噪声标签审计" })).toBeVisible();
  await expect(page.getByText("Lead: SUPPORTED", { exact: true })).toBeVisible();
  await expect(page.getByText("Overall: MIXED", { exact: true })).toBeVisible();
  await expect(page.getByText(/163\/750/).first()).toBeVisible();
  await expect(page.getByLabel("对话列表")).toBeVisible();
  await expect(page.getByLabel("研究工作台")).toBeVisible();
  await expect(page.getByRole("tab", { name: /全部/ })).toHaveAttribute("aria-selected", "true");

  const workbench = page.getByLabel("研究工作台");
  const divider = page.getByRole("separator", { name: "调整工作台宽度" });
  const beforeWidth = (await workbench.boundingBox())!.width;
  const dividerBox = (await divider.boundingBox())!;
  await page.mouse.move(dividerBox.x + dividerBox.width / 2, dividerBox.y + dividerBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(dividerBox.x - 260, dividerBox.y + dividerBox.height / 2, { steps: 12 });
  await page.mouse.up();
  await expect.poll(async () => (await workbench.boundingBox())!.width).toBeGreaterThan(beforeWidth + 170);
  await expect.poll(async () => (await workbench.boundingBox())!.width).toBeLessThanOrEqual(721);

  await divider.focus();
  await page.keyboard.press("Home");
  await expect.poll(async () => (await workbench.boundingBox())!.width).toBeLessThanOrEqual(421);

  await page.getByRole("tab", { name: /代码/ }).click();
  const codeCell = page.locator(".nb-cell--code");
  const codeOutput = codeCell.locator(".nb-code-output");
  const codeStep = codeCell.locator(".nb-step-number");
  const copyCode = codeOutput.getByRole("button", { name: /复制代码 coherence_detector\.py/ });
  await expect(copyCode).toBeVisible();
  await expect(codeOutput.locator(".token.keyword").first()).toBeVisible();
  await expect.poll(async () => {
    const outputBox = await codeOutput.boundingBox();
    const stepBox = await codeStep.boundingBox();
    return Math.abs(outputBox!.x - stepBox!.x);
  }).toBeLessThanOrEqual(2);
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await copyCode.click();
  await expect(codeOutput.getByRole("button", { name: /coherence_detector\.py 已复制/ })).toBeVisible();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain("def per_trace_features");
  await expect.poll(() => codeOutput.evaluate((node) => node.scrollWidth > node.clientWidth)).toBe(true);
  await codeOutput.evaluate((node) => { node.scrollLeft = 80; });
  await expect.poll(() => codeOutput.evaluate((node) => node.scrollLeft)).toBeGreaterThan(0);

  await divider.focus();
  await page.keyboard.press("End");
  await expect.poll(async () => (await workbench.boundingBox())!.width).toBeGreaterThan(710);
  await page.getByRole("tab", { name: /全部/ }).click();

  await workbench
    .locator(".nb-cell--figure")
    .filter({ hasText: "fig_main_score_distributions.png" })
    .locator(".nb-cell-title")
    .click();
  const figure = page.getByAltText("noise、IAAFT surrogate null 与 earthquake 的异常分数直方图和经验累积分布");
  await expect(figure).toBeVisible();
  await expect.poll(() => figure.evaluate((node) => (node as HTMLImageElement).naturalWidth)).toBeGreaterThan(1500);

  await page.getByRole("tab", { name: /数据/ }).click();
  await expect(page.getByRole("cell", { name: "32.8%" })).toBeVisible();
  const pdfResponse = await page.request.get("/assets/seismic/stead-noise-audit.pdf");
  expect(pdfResponse.ok()).toBe(true);
  expect((await pdfResponse.body()).byteLength).toBe(500105);

  await page.screenshot({ path: "test-results/desktop-workspace.png" });
});

test("mobile exposes conversations and workbench as drawers", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");

  await expect(page.getByLabel("对话列表")).toHaveCount(0);
  await expect(page.getByLabel("研究工作台")).toHaveCount(0);

  await page.getByLabel("打开对话栏").click();
  await expect(page.getByLabel("对话列表")).toBeVisible();
  await page.screenshot({ path: "test-results/mobile-conversations.png" });

  await page.getByLabel("收起对话栏").click();
  await page.getByLabel("打开工作台").click();
  await expect(page.getByLabel("研究工作台")).toBeVisible();
  await expect(page.getByRole("tab", { name: /全部/ })).toBeVisible();
  await expect.poll(() => page.locator(".chat-pane").evaluate((node) => (node as HTMLElement).inert)).toBe(true);
  await page.keyboard.press("Tab");
  await expect.poll(() => page.evaluate(() => Boolean(document.activeElement?.closest(".workbench")))).toBe(true);
  await page.getByRole("tab", { name: /图表/ }).click();
  const mobileFigureStage = page.locator(".nb-figure-stage").first();
  await expect(mobileFigureStage).toBeVisible();
  await expect.poll(() => mobileFigureStage.evaluate((node) => node.scrollWidth > node.clientWidth)).toBe(true);
  await page.screenshot({ path: "test-results/mobile-workbench.png" });
  await page.getByLabel("研究工作台").getByLabel("收起工作台").click();
  await expect(page.getByLabel("打开工作台")).toBeFocused();

  const stageRun = page.locator(".tool-run").filter({ hasText: "Stage 2 · 完整实验完成" });
  await stageRun.locator(".tool-run-summary").click();
  await stageRun.getByRole("button", { name: /查看完整轨迹/ }).click();
  await expect(page.getByLabel("研究工作台").getByRole("heading", { name: "完整实验轨迹" })).toBeVisible();
  await expect.poll(() => page.locator(".chat-pane").evaluate((node) => (node as HTMLElement).inert)).toBe(true);
  await page.screenshot({ path: "test-results/mobile-trace.png" });
});

test("a completed stage opens its full trace in the workbench", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");

  const stageRun = page.locator(".tool-run").filter({ hasText: "Stage 2 · 完整实验完成" });
  await stageRun.locator(".tool-run-summary").click();
  const openTrace = stageRun.getByRole("button", { name: /查看完整轨迹/ });
  await expect(openTrace).toContainText("40 次调用");
  const notebookScroll = page.getByLabel("研究工作台").locator(".nb-scroll-region");
  await notebookScroll.evaluate((node) => { node.scrollTop = 700; });
  await openTrace.click();

  const workbench = page.getByLabel("研究工作台");
  await expect(workbench.getByText("运行轨迹", { exact: true })).toBeVisible();
  await expect(workbench.getByRole("heading", { name: "完整实验轨迹" })).toBeVisible();
  await expect(workbench.getByText("40 calls · 36 run_python · 1 recovered error · Gate passed", { exact: true })).toBeVisible();
  await expect(workbench.getByText(/已脱敏/)).toBeVisible();
  await page.screenshot({ path: "test-results/desktop-trace.png" });

  await workbench.getByLabel("返回研究记录").click();
  await expect.poll(() => notebookScroll.evaluate((node) => node.scrollTop)).toBeGreaterThan(650);
  await openTrace.click();

  await workbench.getByRole("tab", { name: /修正/ }).click();
  await expect(workbench.locator(".trace-entry")).toHaveCount(5);
  const failedEntry = workbench.locator(".trace-entry").filter({ hasText: "计算 post-hoc calibration 与多重校正" });
  await failedEntry.locator(".trace-entry-summary").click();
  await expect(failedEntry.getByText(/ModuleNotFoundError: statsmodels/)).toBeVisible();

  await workbench.getByRole("tab", { name: /关键节点/ }).click();
  const primaryRerun = workbench.locator(".trace-entry").filter({ hasText: "执行 self-contained primary rerun" });
  await primaryRerun.locator(".trace-entry-summary").click();
  await expect(primaryRerun.getByText(/163\/750/)).toBeVisible();
  await primaryRerun.locator(".trace-artifacts").getByRole("button", { name: /coherence_detector\.py/ }).click();

  await expect(workbench.getByText("研究记录", { exact: true })).toBeVisible();
  await expect(workbench.locator(".nb-cell--code")).toBeVisible();
  await page.screenshot({ path: "test-results/trace-to-artifact.png" });
});

test("a new conversation renders markdown and interleaves streamed tool events", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");

  await page.getByLabel("打开对话栏").click();
  await expect.poll(() => page.getByLabel("研究工作台").evaluate((node) => (node as HTMLElement).inert)).toBe(true);
  await page.getByRole("button", { name: "新建研究会话" }).click();
  const composer = page.getByLabel("消息输入");
  await composer.fill("检查这组数据的统计假设");
  await page.getByLabel("发送消息").click();

  await expect(page.locator(".user-bubble").getByText("检查这组数据的统计假设", { exact: true })).toBeVisible();
  await expect(page.getByText("正在分析请求", { exact: true })).toBeVisible();
  const collapse = page.getByRole("button", { name: "收起运行过程" });
  await expect(collapse).toBeVisible();
  await collapse.click();
  await expect(page.getByRole("button", { name: "展开运行过程" })).toBeVisible();
  await page.getByRole("button", { name: "展开运行过程" }).click();
  await expect(page.getByRole("heading", { name: "请求已接收", level: 3 })).toBeVisible({ timeout: 8_000 });
  await expect(page.locator(".message-body strong").getByText("运行模式", { exact: true })).toBeVisible();
  await expect(page.locator(".message-body code").getByText("AgentLoop", { exact: true })).toBeVisible();
  await expect(page.locator(".message-body ol > li")).toHaveCount(2);
  await expect(page.getByText("Loaded skill · OmniScientist（论文研究）", { exact: true })).toBeVisible();
  await expect(page.locator(".timeline-tool")).toHaveCount(2);

  const inspectTool = page.locator(".timeline-tool").filter({ hasText: "检查当前工作区" });
  await expect(inspectTool.getByRole("button", { name: "展开检查当前工作区输出" })).toBeVisible();
  await expect(inspectTool.locator(".tool-step-output")).toHaveCount(0);
  await inspectTool.getByRole("button", { name: "展开检查当前工作区输出" }).click();
  await expect(inspectTool.locator(".tool-step-output pre")).toContainText("engine/examples/");
  await expect(inspectTool.getByRole("button", { name: "收起检查当前工作区输出" })).toBeVisible();
  const skillTool = page.locator(".timeline-tool").filter({ hasText: "加载研究 Skill" });
  await skillTool.getByRole("button", { name: "展开加载研究 Skill输出" }).click();
  await expect(skillTool.locator(".tool-step-output pre"))
    .toHaveText("Skill 已加载。完整说明仅用于 Agent 执行，不在界面中展示。");
  await expect(skillTool.locator(".tool-step-output")).not.toContainText("DeepSeek is the scientist");
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await inspectTool.getByRole("button", { name: "复制检查当前工作区输出" }).click();
  await expect(inspectTool.getByRole("button", { name: "检查当前工作区输出已复制" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain("paper/main.tex");
  await expect(page.getByText("研究运行完成", { exact: true })).toBeVisible();

  const order = await page.evaluate(() => {
    const intro = [...document.querySelectorAll(".message-body p")]
      .find((node) => node.textContent?.includes("我先检查当前工作区"));
    const tool = document.querySelector(".timeline-tool");
    const answer = [...document.querySelectorAll(".message-body h3")]
      .find((node) => node.textContent === "请求已接收");
    if (!intro || !tool || !answer) return false;
    return Boolean(intro.compareDocumentPosition(tool) & Node.DOCUMENT_POSITION_FOLLOWING)
      && Boolean(tool.compareDocumentPosition(answer) & Node.DOCUMENT_POSITION_FOLLOWING);
  });
  expect(order).toBe(true);

  await page.getByRole("button", { name: "收起运行过程" }).click();
  await expect(page.locator(".timeline-tool")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "请求已接收", level: 3 })).toBeVisible();
  await page.getByRole("button", { name: "展开运行过程" }).click();
  await expect(page.locator(".timeline-tool")).toHaveCount(2);
});

test("manual scrolling pauses auto-follow during a streamed response", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 540 });
  await page.goto("/");
  await page.getByRole("button", { name: "新建研究会话" }).click();

  const longPrompt = Array.from(
    { length: 24 },
    (_, index) => `第 ${index + 1} 行：检查流式输出时不要抢走我的滚动位置。`,
  ).join("\n");
  await page.getByLabel("消息输入").fill(longPrompt);
  await page.getByLabel("发送消息").click();
  await expect(page.getByText("我先检查当前工作区，再整理可用证据。", { exact: true })).toBeVisible();

  const scroll = page.locator(".conversation-scroll");
  await scroll.evaluate((node) => {
    node.scrollTop = 0;
    node.dispatchEvent(new Event("scroll"));
  });
  await expect(page.getByRole("heading", { name: "请求已接收", level: 3 })).toBeVisible({ timeout: 8_000 });
  await expect.poll(() => scroll.evaluate((node) => node.scrollTop)).toBeLessThanOrEqual(2);

  const jump = page.getByRole("button", { name: "回到最新消息" });
  await expect(jump).toBeVisible();
  await jump.click();
  await expect.poll(() => scroll.evaluate(
    (node) => node.scrollHeight - node.scrollTop - node.clientHeight,
  )).toBeLessThanOrEqual(2);
  await expect(jump).toHaveCount(0);
});

test("reload restores the selected conversation and its unsent draft", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 800 });
  await page.goto("/");

  await page.getByRole("button", { name: /Reviewer 2 回复草稿/ }).click();
  await expect(page.getByRole("heading", { name: "Reviewer 2 回复草稿" })).toBeVisible();
  const composer = page.getByLabel("消息输入");
  await composer.fill("这段 rebuttal 还需要补一条稳健性说明");

  await page.reload();

  await expect(page.getByRole("heading", { name: "Reviewer 2 回复草稿" })).toBeVisible();
  await expect(page.getByLabel("消息输入")).toHaveValue("这段 rebuttal 还需要补一条稳健性说明");
  await expect.poll(() => page.evaluate(() => localStorage.getItem("omnisci.web.selected-session.v1")))
    .toBe("session-rebuttal");
});

test("a remembered demo status cannot lock the composer", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 800 });
  await page.goto("/");
  await page.evaluate(() => localStorage.setItem("omnisci.web.selected-session.v1", "session-ablation"));
  await page.reload();

  await expect(page.getByRole("heading", { name: "消融实验设计" })).toBeVisible();
  const composer = page.getByLabel("消息输入");
  await composer.fill("从这个例子继续做真实分析");
  await expect(page.getByLabel("发送消息")).toBeEnabled();
  await page.getByLabel("发送消息").click();

  await expect(page.locator(".user-bubble").getByText("从这个例子继续做真实分析", { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => localStorage.getItem("omnisci.web.selected-session.v1")))
    .toMatch(/^local-/);
});

test("a real completed paper session automatically opens its notebook outputs", async ({ page }) => {
  const response = await page.request.get("/api/v1/sessions");
  if (!response.ok()) test.skip(true, "local gateway is not running");
  const sessions = await response.json() as Array<{ id: string; title: string }>;
  const paperSession = sessions.find((session) => session.id === "local-6120bd7a70e9");
  if (!paperSession) test.skip(true, "the local paper fixture is not available");

  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/");
  await page.evaluate((id) => localStorage.setItem("omnisci.web.selected-session.v1", id), paperSession.id);
  await page.reload();

  const firstAssistant = page.locator("article.assistant-message").first();
  const historicalSteps = firstAssistant.locator(".tool-step-shell");
  await expect(historicalSteps).toHaveCount(3);
  await historicalSteps.nth(0).getByRole("button", { name: "展开查看目录结构输出" }).click();
  await expect(historicalSteps.nth(0).locator("pre")).toContainText(".claude/");
  await expect(historicalSteps.nth(1).getByRole("button", { name: "展开查看目录结构输出" }))
    .toHaveAttribute("aria-expanded", "false");
  await historicalSteps.nth(1).getByRole("button", { name: "展开查看目录结构输出" }).click();
  await expect(historicalSteps.nth(1).getByText("工具输出 · 已截断", { exact: true })).toBeVisible();
  await expect.poll(() => historicalSteps.nth(1).locator("pre").evaluate(
    (node) => node.scrollHeight > node.clientHeight,
  )).toBe(true);

  const workbench = page.getByLabel("研究工作台");
  await expect(workbench).toBeVisible();
  await expect(workbench.getByText("当前会话 · 6 项输出", { exact: true })).toBeVisible();
  await expect(workbench.locator(".nb-cell--paper.is-active").getByText("paper.pdf", { exact: true })).toBeVisible();
  await expect(workbench.locator(".nb-paper-pages img")).toHaveCount(6);
  await expect.poll(() => workbench.locator(".nb-paper-pages img").first().evaluate(
    (node) => (node as HTMLImageElement).naturalWidth,
  )).toBeGreaterThan(900);
  await expect(workbench.locator(".nb-cell--figure")).toHaveCount(3);
  await expect(workbench.locator(".nb-cell--code")).toHaveCount(2);
});
