import { useEffect, useRef, useState } from "react";
import { Check, CircleAlert, KeyRound, LoaderCircle, Pencil, Trash2, X } from "lucide-react";
import {
  loadSettings,
  saveSettings,
  settingsAvailable,
  testSettings,
  useSettings,
  type ChannelInfo,
  type ProviderId,
  type Scope,
  type SettingsPatch,
  type SettingsState,
  EFFORTS,
  checkUpdate,
  type UpdateState,
} from "../lib/settings";
import { t } from "../lib/i18n";

interface SettingsDialogProps {
  open: boolean;
  onClose: () => void;
  onSaved: (state: SettingsState) => void;
}

/** 选中的是哪条线上的哪个通道。 */
interface Selection {
  scope: Scope;
  id: ProviderId;
}

/** 下拉框里表示"新加一个"的哨兵值。模型名不会长这样。 */
const ADD = "__add__";

/**
 * 正在用的排最前，配好的次之，没配的沉底。
 * 按目录顺序排的话，用户每次进来都要在一堆"未配置"里找自己那一个。
 */
function ordered(items: ChannelInfo[]): ChannelInfo[] {
  const rank = (c: ChannelInfo) => (c.active && c.configured ? 0 : c.configured ? 1 : 2);
  return [...items].sort((a, b) => rank(a) - rank(b));
}

/**
 * 左边两组通道（研究模型 / 视觉模型），右边是选中通道的 key、地址和模型。
 *
 * 分成两条线是因为它们本来就独立：DeepSeek 官方接口不收图，所以脑子用 DeepSeek
 * 的时候眼睛必须是别人。
 *
 * 右下三个按钮是三件事：
 *   测试  真发一次请求，什么都不改
 *   保存  把 key / 模型 / 地址存下来，但不切换当前在跑的是谁
 *   使用  把这条线切到这套配置上；没测过就是灰的，后端也会再拦一道
 *
 * 用原生 <dialog>：焦点陷阱、Esc 关闭、背景 inert 都是浏览器给的。
 */
export function SettingsDialog({ open, onClose, onSaved }: SettingsDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const keyInput = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<SettingsState | null>(null);
  const [selected, setSelected] = useState<Selection>({ scope: "model", id: "deepseek" });
  const [editingKey, setEditingKey] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  const [addingModel, setAddingModel] = useState(false);
  const [newModel, setNewModel] = useState("");
  const [effort, setEffort] = useState("");
  const [busy, setBusy] = useState<"test" | "save" | "use" | "key" | "model" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  /**
   * 上一次测通的那套长什么样。表单一动就对不上了，"使用"跟着变灰。
   * 后端也存了一份同样的判断，界面这份只是让按钮状态跟得上手。
   */
  const [testedFor, setTestedFor] = useState<string | null>(null);
  const [update, setUpdate] = useState<UpdateState | null>(null);
  const [checking, setChecking] = useState(false);
  /** 手动查完但没有新版本时说一声，否则点了按钮什么都不动，看起来像没反应。 */
  const [checked, setChecked] = useState(false);
  /** 开关点下去到本地后端确认之间，先信用户点的那下。null 表示没有在途的改动。 */
  const [wantCheck, setWantCheck] = useState<boolean | null>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  useEffect(() => {
    if (!open || !settingsAvailable) return;
    let cancelled = false;
    setError(null);
    setNote(null);
    loadSettings()
      .then((next) => {
        if (cancelled) return;
        setState(next);
        show(next, { scope: "model", id: next.active });
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    // 顺带看一眼版本。走每日节流，不强制，查不到就当没有。
    checkUpdate().then((u) => { if (!cancelled) setUpdate(u); }).catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [open]);

  function channelOf(next: SettingsState, target: Selection): ChannelInfo | undefined {
    return (target.scope === "vision" ? next.vision : next.providers).find((c) => c.id === target.id);
  }

  /** 切到某个通道：带上它已有的值，没 key 就直接进填 key 的状态。 */
  function show(next: SettingsState, target: Selection) {
    const channel = channelOf(next, target);
    setSelected(target);
    setEditingKey(!channel?.masked);
    setApiKey("");
    setConfirmDelete(false);
    setBaseUrl(channel?.baseUrl ?? "");
    setModel(channel?.selected ?? "");
    setAddingModel(false);
    setNewModel("");
    setEffort(channel?.effort ?? "");
    setError(null);
    setNote(null);
    setTestedFor(null);
  }

  const current = state ? channelOf(state, selected) : undefined;
  const hasKey = Boolean(current?.masked);
  const isActive = Boolean(current?.active && current.configured);
  const needsEndpoint = Boolean(current?.needsEndpoint);

  /** 表单当前这套的指纹。key 只看填没填，因为界面拿不到已存的那把的明文。 */
  const signature = [selected.scope, selected.id, model.trim(), baseUrl.trim(), apiKey.trim(), effort]
    .join("\u0001");
  // 按当前下拉里选的模型判，不用后端那份已保存的：换了模型这一行要立刻跟着出现或消失。
  const showsEffort = /^(gpt-5|o[1-9]([-.]|$))/.test(model.trim());

  /** 改了任何一项，之前那次测试就不算数了。 */
  function touched() {
    setNote(null);
    setError(null);
    setTestedFor(null);
  }

  function patch(): SettingsPatch {
    return {
      scope: selected.scope,
      provider: selected.id,
      model: model.trim(),
      ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      ...(needsEndpoint ? { baseUrl: baseUrl.trim() } : {}),
      ...(effort ? { effort } : {}),
    };
  }

  async function run(
    kind: NonNullable<typeof busy>,
    body: SettingsPatch,
    call: (p: SettingsPatch) => Promise<SettingsState>,
    after: (next: SettingsState) => void,
  ) {
    if (busy) return;
    setBusy(kind);
    setError(null);
    setNote(null);
    try {
      const next = await call(body);
      setState(next);
      after(next);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  const canRun = Boolean((apiKey.trim() || hasKey) && model.trim() && (!needsEndpoint || baseUrl.trim()));
  const canUse = canRun && testedFor === signature;

  return (
    <dialog className="settings-dialog" ref={ref} onClose={onClose} onCancel={onClose}>
      <header className="settings-head">
        <div>
          <h2>{t("模型设置")}</h2>
          <p>{t("key 存在 {0}", state?.envFile ?? "~/.omnisci/env")}</p>
        </div>
        <button className="settings-close" type="button" onClick={onClose} aria-label={t("关闭")}>
          <X size={16} />
        </button>
      </header>

      {!settingsAvailable ? (
        <p className="settings-note">{t("演示版没有本机后端可配。")}</p>
      ) : !state ? (
        <p className="settings-note">
          {error ?? (
            <>
              <LoaderCircle className="spin" size={14} /> {t("正在读取当前配置…")}
            </>
          )}
        </p>
      ) : (
        <>
          <div className="settings-split">
            <nav className="provider-rail" aria-label={t("模型")}>
              {[
                { scope: "model" as Scope, title: t("研究模型"), list: state.providers, warn: !state.ready },
                { scope: "vision" as Scope, title: t("视觉模型"), list: state.vision, warn: !state.visionReady },
              ].map((group, index) => (
                <div key={group.scope} className="rail-section">
                  <p className={`rail-group${index > 0 ? " is-second" : ""}`}>
                    {group.title}
                    {group.warn ? <span className="rail-group-warn">{t("未配置")}</span> : null}
                  </p>
                  {ordered(group.list).map((item) => {
                    const live = item.active && item.configured;
                    const here = selected.scope === group.scope && selected.id === item.id;
                    return (
                      <button
                        key={item.id}
                        type="button"
                        className={`rail-item${here ? " is-selected" : ""}${live ? " is-active" : ""}`}
                        onClick={() => show(state, { scope: group.scope, id: item.id })}
                        aria-current={here}
                      >
                        <span className={`rail-dot${live ? " is-live" : item.masked ? " is-ready" : ""}`} />
                        <span className="rail-copy">
                          <strong>{item.label}</strong>
                          <small>{live ? item.activeModel : item.masked ? t("已配置") : t("未配置")}</small>
                        </span>
                        {live ? <span className="rail-live">{t("使用中")}</span> : null}
                      </button>
                    );
                  })}
                </div>
              ))}
            </nav>

            <section className="provider-detail">
              <div className="detail-head">
                <div>
                  <h3>{current?.label}</h3>
                  <p>{current?.hint}</p>
                </div>
                {/* 绿色只留给"正在用"。配好了但没在用是描边，不然满屏绿分不出来。 */}
                <span className={"detail-state" + (isActive ? " is-live" : hasKey ? " is-ready" : "")}>
                  {isActive ? t("使用中") : hasKey ? t("已配置") : t("未配置")}
                </span>
              </div>

              {hasKey && !editingKey ? (
                <div className="key-record">
                  <KeyRound size={15} />
                  <span className="key-mask">{current?.masked}</span>
                  <code className="key-env">{current?.keyEnv}</code>
                  <div className="key-record-actions">
                    <button
                      type="button"
                      onClick={() => {
                        setEditingKey(true);
                        setConfirmDelete(false);
                        touched();
                        setTimeout(() => keyInput.current?.focus(), 0);
                      }}
                    >
                      <Pencil size={13} /> {t("换一个")}
                    </button>
                    {confirmDelete ? (
                      <button
                        type="button"
                        className="is-danger"
                        disabled={busy !== null}
                        onClick={() =>
                          void run(
                            "key",
                            { scope: selected.scope, provider: selected.id, removeKey: true },
                            saveSettings,
                            (next) => {
                              show(next, selected);
                              onSaved(next);
                            },
                          )
                        }
                      >
                        {busy === "key" ? <LoaderCircle className="spin" size={13} /> : <Trash2 size={13} />} {t("确认删除")}
                      </button>
                    ) : (
                      <button type="button" onClick={() => setConfirmDelete(true)}>
                        <Trash2 size={13} /> {t("删除")}
                      </button>
                    )}
                  </div>
                </div>
              ) : (
                <div className="field-row">
                  <label className="field-label" htmlFor="key-input">API key</label>
                  <div className="field-controls">
                    <input
                      id="key-input"
                      ref={keyInput}
                      className="field-input"
                      type="password"
                      autoComplete="off"
                      spellCheck={false}
                      value={apiKey}
                      placeholder={current?.keyPrefix ? `${current.keyPrefix}…` : "API key"}
                      onChange={(event) => {
                        setApiKey(event.target.value);
                        touched();
                      }}
                    />
                    {hasKey ? (
                      <button
                        type="button"
                        className="settings-btn"
                        onClick={() => {
                          setEditingKey(false);
                          setApiKey("");
                          touched();
                        }}
                      >
                        {t("取消")}
                      </button>
                    ) : null}
                  </div>
                </div>
              )}

              <div className="field-row">
                <span className="field-label">{t("接口地址")}</span>
                <div className="field-controls">
                  {needsEndpoint ? (
                    <input
                      className="field-input"
                      type="text"
                      spellCheck={false}
                      value={baseUrl}
                      placeholder="https://…/v1"
                      onChange={(event) => {
                        setBaseUrl(event.target.value);
                        touched();
                      }}
                    />
                  ) : (
                    <code className="field-static">{current?.baseUrl}</code>
                  )}
                </div>
              </div>

              <div className="field-row">
                <label className="field-label" htmlFor="model-select">{t("模型")}</label>
                <div className="field-controls">
                  {addingModel ? (
                    <>
                      <input
                        className="field-input"
                        type="text"
                        autoFocus
                        spellCheck={false}
                        value={newModel}
                        placeholder={t("模型 ID")}
                        onChange={(event) => setNewModel(event.target.value)}
                      />
                      <button
                        type="button"
                        className="settings-btn"
                        disabled={!newModel.trim() || busy !== null}
                        onClick={() =>
                          void run(
                            "model",
                            { scope: selected.scope, provider: selected.id, addModel: newModel.trim() },
                            saveSettings,
                            () => {
                              setModel(newModel.trim());
                              setAddingModel(false);
                              setNewModel("");
                              setTestedFor(null);
                            },
                          )
                        }
                      >
                        {busy === "model" ? <LoaderCircle className="spin" size={13} /> : null} {t("确定")}
                      </button>
                      <button
                        type="button"
                        className="settings-btn"
                        onClick={() => {
                          setAddingModel(false);
                          setNewModel("");
                        }}
                      >
                        {t("取消")}
                      </button>
                    </>
                  ) : (
                    <>
                      <select
                        id="model-select"
                        className="field-select"
                        value={model}
                        onChange={(event) => {
                          const value = event.target.value;
                          touched();
                          if (value === ADD) {
                            setAddingModel(true);
                            setNewModel("");
                            return;
                          }
                          setModel(value);
                        }}
                      >
                        {current?.models.length ? null : <option value="">{t("还没有模型")}</option>}
                        {current?.models.map((choice) => (
                          <option key={choice.name} value={choice.name}>
                            {choice.name}
                          </option>
                        ))}
                        <option value={ADD}>{t("+ 添加模型")}</option>
                      </select>

                      {current?.models.find((m) => m.name === model)?.removable ? (
                        <button
                          type="button"
                          className="icon-btn"
                          title={t("删除这个模型")}
                          disabled={busy !== null}
                          onClick={() =>
                            void run(
                              "model",
                              { scope: selected.scope, provider: selected.id, removeModel: model },
                              saveSettings,
                              (next) => {
                                setModel(channelOf(next, selected)?.selected ?? "");
                                setTestedFor(null);
                              },
                            )
                          }
                        >
                          <Trash2 size={14} />
                        </button>
                      ) : null}

                      {/* 测试和保存挨着模型放：改完当场就能试，不用跑到弹窗底部。 */}
                      <button
                        type="button"
                        className="settings-btn"
                        disabled={busy !== null || !canRun}
                        onClick={() =>
                          void run("test", { ...patch(), action: "test" }, testSettings, () => {
                            setNote(t("测试成功"));
                            setTestedFor(signature);
                          })
                        }
                      >
                        {busy === "test" ? (
                          <>
                            <LoaderCircle className="spin" size={13} /> {t("测试中")}
                          </>
                        ) : (
                          t("测试")
                        )}
                      </button>
                      <button
                        type="button"
                        className="settings-btn"
                        disabled={busy !== null || !canRun}
                        onClick={() =>
                          void run("save", patch(), saveSettings, (next) => {
                            setApiKey("");
                            setEditingKey(!channelOf(next, selected)?.masked);
                            setNote(t("已保存"));
                            onSaved(next);
                          })
                        }
                      >
                        {busy === "save" ? (
                          <>
                            <LoaderCircle className="spin" size={13} /> {t("保存中")}
                          </>
                        ) : (
                          t("保存")
                        )}
                      </button>
                    </>
                  )}
                </div>
              </div>

              {/* 只有 OpenAI 的推理模型收这个字段，别家塞过去会 400，所以按模型判。 */}
              {showsEffort ? (
                <div className="field-row">
                  <label className="field-label" htmlFor="effort-select">{t("思考")}</label>
                  <div className="field-controls">
                    <select
                      id="effort-select"
                      className="field-select"
                      value={effort}
                      onChange={(event) => {
                        setEffort(event.target.value);
                        touched();
                      }}
                    >
                      <option value="">{t("不设置")}</option>
                      {EFFORTS.map((level) => (
                        <option key={level} value={level}>
                          {level}{level === "xhigh" ? t("（最强）") : level === "none" ? t("（不推理）") : ""}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              ) : null}

              {note ? (
                <p className="detail-result is-good">
                  <span className="result-mark">
                    <Check size={14} strokeWidth={3} />
                  </span>
                  <span>
                    <strong>{note}</strong>
                  </span>
                </p>
              ) : error ? (
                <p className="detail-result is-bad">
                  <span className="result-mark">
                    <CircleAlert size={14} />
                  </span>
                  <span>
                    <strong>{t("没通过")}</strong>
                    <small>{error}</small>
                  </span>
                </p>
              ) : null}
            </section>
          </div>

          <footer className="settings-foot">
            <div className="update-row">
              {update?.update?.newer ? (
                <a className="update-link" href={update.update.url} target="_blank" rel="noreferrer">
                  {t("有新版本 {0}", update.update.latest)}
                </a>
              ) : (
                <span className="update-current">
                  {update ? t("版本 {0}", update.current) + (checked ? t("，已是最新") : "") : ""}
                </span>
              )}
              <button
                type="button"
                className="update-check"
                disabled={checking}
                onClick={() => {
                  setChecking(true);
                  setChecked(false);
                  checkUpdate(true)
                    .then((next) => {
                      setUpdate(next);
                      setChecked(!next.update?.newer);
                    })
                    .catch(() => {})
                    .finally(() => setChecking(false));
                }}
              >
                {checking ? t("检查中…") : t("检查更新")}
              </button>
              <label className="update-toggle">
                <input
                  type="checkbox"
                  // 先按点的样子画，别等本地后端回来——受控 input 在这中间会弹回去，看着像没点上。
                  checked={wantCheck ?? state.updateCheck}
                  onChange={(event) => {
                    const on = event.target.checked;
                    setWantCheck(on);
                    // 只是个开关，不走"没测过不给用"那套门禁。run 自己吞异常，
                    // 所以成功失败都会走到清除，失败时勾回真实状态。
                    void run("save", { provider: selected.id, updateCheck: on }, saveSettings, onSaved)
                      .finally(() => setWantCheck(null));
                  }}
                />
                {t("每天检查")}
              </label>
              <span className="settings-foot-note">
                {canUse ? "" : isActive ? "" : t("测试通过之后才能启用")}
              </span>
            </div>
            <div className="settings-actions">
              <button type="button" className="settings-btn" onClick={onClose}>
                {t("关闭")}
              </button>
              <button
                type="button"
                className="settings-btn is-primary"
                disabled={busy !== null || !canUse}
                title={canUse ? undefined : t("先点测试")}
                onClick={() =>
                  void run("use", patch(), useSettings, (next) => {
                    setApiKey("");
                    setEditingKey(!channelOf(next, selected)?.masked);
                    setNote(t("已启用"));
                    onSaved(next);
                  })
                }
              >
                {busy === "use" ? (
                  <>
                    <LoaderCircle className="spin" size={14} /> {t("启用中")}
                  </>
                ) : (
                  t("使用")
                )}
              </button>
            </div>
          </footer>
        </>
      )}
    </dialog>
  );
}
