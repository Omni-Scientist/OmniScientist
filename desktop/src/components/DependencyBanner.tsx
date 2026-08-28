import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, LoaderCircle, TriangleAlert } from "lucide-react";

import { t } from "../lib/i18n";
import {
  depsAvailable, loadDoctor, loadInstall, missingChecks, startInstall,
  type DepCheck, type InstallState,
} from "../lib/deps";

/** 轮询间隔。全是本机请求，/api/doctor 服务端还带 30 秒缓存，这个频率不心疼。 */
const POLL_MS = 2000;

/**
 * 每一项缺席时对用户意味着什么。
 *
 * 只说"缺 tectonic"没有信息量，用户不知道那是什么、也不知道会怎样。真正要
 * 传达的是后果：研究照跑，但最后拿不到 PDF。
 */
function consequence(name: string, check: DepCheck | undefined): string {
  if (name === "tectonic") return t("缺 tectonic，研究能跑完，但只出 .tex 拿不到 PDF");
  if (name === "packages") {
    // 包名用 items 而不是 detail。detail 是后端写死的中文，填进英文句子会拼出
    // 「Missing python packages (缺 imageio、soundfile)」这种半中半英的东西。
    // items 拿不到（探测脚本自己没跑成，那时后端只有一句错误原文）才退回 detail。
    const list = check?.items?.length ? check.items.join(", ") : check?.detail ?? "";
    return t("缺 python 依赖（{0}），分析和作图这一步会失败", list);
  }
  if (name === "python") return t("找不到能用的 python 3，研究流程跑不起来");
  return t("{0} 没就绪，{1}", name, check?.detail ?? "");
}

/**
 * 依赖没齐时顶在对话区上方的一条提示，带一个「安装依赖」按钮。
 *
 * 为什么必须有这个东西：缺 tectonic 的时候一轮研究**不报错**，`paper_cli` 返回
 * `tex_only`，skill 文档把它写成一种正常结局，模型于是认为自己做完了。用户要等
 * 一小时跑完才发现少个 PDF，而且界面上没有任何地方能修。启动器早就把体检结果
 * 算出来了，只是以前没接到界面上。
 *
 * 启动后会自动补一次（见 launcher 里的 autoDecision），所以多数人根本不会看到
 * 这条提示，或者只看到它显示"正在自动补"然后自己消失。这个按钮是给自动那趟
 * 失败的人用的，也给关掉了自动安装的人用。
 */
export function DependencyBanner() {
  const [checks, setChecks] = useState<Record<string, DepCheck> | null>(null);
  const [install, setInstall] = useState<InstallState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [logOpen, setLogOpen] = useState(false);
  /** 上一拍是不是在装。用来判断"刚装完"，只在那一刻重查体检。 */
  const wasRunning = useRef(false);

  const refreshDoctor = useCallback(async () => {
    try {
      const state = await loadDoctor();
      setChecks(state.checks);
    } catch (e) {
      // 查不了体检不该在界面上炸一条红字。启动器没起来的时候整个界面本来也用不了。
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    if (!depsAvailable) return;
    void refreshDoctor();
  }, [refreshDoctor]);

  useEffect(() => {
    if (!depsAvailable) return;
    let alive = true;
    const tick = async () => {
      try {
        const state = await loadInstall();
        if (!alive) return;
        setInstall(state);
        // 装完那一刻重查一次体检，让这条提示自己消失，不用刷新页面。
        if (wasRunning.current && !state.running) void refreshDoctor();
        wasRunning.current = state.running;
      } catch {
        // 轮询失败就下一拍再说，不打断用户。
      }
    };
    void tick();
    const timer = window.setInterval(() => void tick(), POLL_MS);
    return () => { alive = false; window.clearInterval(timer); };
  }, [refreshDoctor]);

  const missing = checks ? missingChecks(checks) : [];
  const running = install?.running ?? false;
  // 装完但没装齐，说明自动那趟失败了。这时候提示要留着，而且要能看日志。
  const failed = Boolean(install?.done && !install.ok && !running);

  if (!depsAvailable) return null;
  if (!missing.length && !running) return null;

  const onInstall = async () => {
    setError(null);
    try {
      await startInstall();
      setInstall((prev) => (prev ? { ...prev, running: true, done: false } : prev));
      wasRunning.current = true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const lastLine = install?.log?.length ? install.log[install.log.length - 1]! : "";

  return (
    <section className="dep-banner" role="status" aria-live="polite">
      <div className="dep-banner-main">
        <span className="dep-banner-icon" aria-hidden="true">
          {running ? <LoaderCircle size={16} className="dep-spin" /> : <TriangleAlert size={16} />}
        </span>
        <div className="dep-banner-text">
          {running ? (
            <>
              <p className="dep-banner-title">
                {install?.auto ? t("正在后台补依赖，不影响现在用") : t("正在安装依赖")}
              </p>
              {/* pip 的输出里全是绝对路径，不夹一行的话提示条会在装的过程中忽高忽低。
                  完整内容在下面的「安装日志」里，这行只是个心跳。 */}
              {lastLine ? <p className="dep-banner-detail dep-banner-progress">{lastLine}</p> : null}
            </>
          ) : (
            <>
              <p className="dep-banner-title">{consequence(missing[0]!, checks?.[missing[0]!])}</p>
              {missing.length > 1 ? (
                <p className="dep-banner-detail">
                  {missing.slice(1).map((name) => consequence(name, checks?.[name])).join("；")}
                </p>
              ) : null}
              {failed ? <p className="dep-banner-detail">{t("上次自动安装没成，可以再试一次")}</p> : null}
              {error ? <p className="dep-banner-detail">{error}</p> : null}
            </>
          )}
        </div>
        <div className="dep-banner-actions">
          {install?.log?.length ? (
            <button
              type="button"
              className="dep-banner-link"
              onClick={() => setLogOpen((value) => !value)}
              aria-expanded={logOpen}
            >
              {logOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
              {t("安装日志")}
            </button>
          ) : null}
          <button type="button" className="dep-banner-button" onClick={() => void onInstall()} disabled={running}>
            {running ? t("安装中…") : t("安装依赖")}
          </button>
        </div>
      </div>
      {logOpen && install?.log?.length ? (
        <pre className="dep-banner-log">{install.log.join("\n")}</pre>
      ) : null}
    </section>
  );
}
