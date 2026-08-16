import type { Artifact, ChatMessage, ChatSession, ResearchTrace, SessionSummary } from "../types";

export const seismicArtifacts: Artifact[] = [
  {
    id: "seismic-waveform-audit",
    kind: "figure",
    order: 1,
    title: "representative_waveforms.png",
    path: "stead_seismic/stages/latex_03_paper/figures/fdata.png",
    detail: "736 x 782 · 真实 STEAD 三分量波形",
    updatedAt: "Stage 1 观察 · Stage 3 成图",
    imageUrl: "/assets/seismic/representative-waveforms.png",
    caption: "Figure 1 · Representative three-component STEAD seismograms",
    altText: "STEAD 数据集中 earthquake 与 noise 标签的四组三分量代表性地震波形",
  },
  {
    id: "seismic-detector-code",
    kind: "code",
    order: 2,
    title: "coherence_detector.py",
    path: "Stage 2 / run_python #31 (curated excerpt)",
    detail: "Python · 实际执行代码节选",
    updatedAt: "Stage 2",
    language: "Python",
    content: `import numpy as np

FS = 100
STA_N = int(0.5 * FS)
LTA_N = int(10 * FS)
WIN = int(1.0 * FS)
COINC_TAU = 0.2 * FS

def sta_lta_fast(x, sta=STA_N, lta=LTA_N, floor_frac=1e-3):
    x2 = x.astype(np.float64) ** 2
    floor = floor_frac * (np.mean(x2) + 1e-12)
    cs = np.concatenate([[0.0], np.cumsum(x2)])
    idx = np.arange(lta, len(x) - sta)
    sta_vals = (cs[idx + sta] - cs[idx]) / sta
    lta_vals = np.maximum((cs[idx] - cs[idx - lta]) / lta, floor)
    ratio = np.full(len(x), np.nan)
    ratio[idx] = sta_vals / lta_vals
    return ratio

def per_trace_features(trace3, sta=STA_N, lta=LTA_N, win=WIN, tau=COINC_TAU):
    stds = np.std(trace3.astype(np.float64), axis=1)
    dead = stds < 1e-6
    onsets, peaks = [], []
    for channel_index in range(3):
        if dead[channel_index]:
            onsets.append(np.nan)
            peaks.append(np.nan)
            continue
        ratio = sta_lta_fast(trace3[channel_index], sta, lta)
        onsets.append(np.nanargmax(ratio))
        peaks.append(np.nanmax(ratio))

    onsets = np.asarray(onsets, dtype=float)
    peaks = np.asarray(peaks, dtype=float)
    valid = ~np.isnan(onsets)
    if valid.sum() < 3:
        return {
            "score": 0.0,
            "spread": np.nan,
            "rectilinearity": 0.0,
            "planarity": 0.0,
            "n_dead": int(dead.sum()),
        }

    median_onset = int(np.median(onsets))
    spread = np.max(onsets) - np.min(onsets)
    soft_coincidence = np.exp(-spread / tau)

    lo = max(0, median_onset - win)
    hi = min(trace3.shape[1], median_onset + win)
    covariance = np.cov(trace3[:, lo:hi].astype(np.float64))
    eigenvalues = np.sort(np.linalg.eigvalsh(covariance))[::-1]
    eigenvalues = np.clip(eigenvalues, 1e-12, None)

    rectilinearity = 1 - eigenvalues[1] / eigenvalues[0]
    planarity = 1 - (2 * eigenvalues[2]) / (eigenvalues[0] + eigenvalues[1])
    log_amplitude = np.log1p(np.max(peaks))
    score = log_amplitude * rectilinearity * planarity * soft_coincidence

    return {
        "score": score,
        "spread": spread,
        "rectilinearity": rectilinearity,
        "planarity": planarity,
        "n_dead": int(dead.sum()),
    }
`,
  },
  {
    id: "seismic-channel-table",
    kind: "table",
    order: 3,
    title: "channel_prevalence.csv",
    path: "stead_seismic/stages/02_experiment.json · breakdown:channel",
    detail: "5 行 x 4 列 · chi-square p = 5.7e-14",
    updatedAt: "Stage 2",
    tableHeaders: ["Channel", "Noise traces", "Flagged prevalence", "Formal test"],
    tableRows: [
      ["BH", "134", "32.8%", "included"],
      ["EH", "84", "23.8%", "included"],
      ["HH", "320", "29.1%", "included"],
      ["HN", "205", "2.4%", "included"],
      ["SH", "7", "14.3%", "excluded (n < 20)"],
    ],
  },
  {
    id: "seismic-score-distributions",
    kind: "figure",
    order: 4,
    title: "fig_main_score_distributions.png",
    path: "stead_seismic/fig_main_score_distributions.png",
    detail: "1560 x 650 · IAAFT null · FAR 1%",
    updatedAt: "Stage 2",
    imageUrl: "/assets/seismic/score-distributions.png",
    caption: "Figure 2 · Anomaly score distributions and ECDFs",
    altText: "noise、IAAFT surrogate null 与 earthquake 的异常分数直方图和经验累积分布",
  },
  {
    id: "seismic-ablation",
    kind: "figure",
    order: 5,
    title: "fig_ablation.png",
    path: "stead_seismic/fig_ablation.png",
    detail: "1040 x 650 · 6 个 detector variants",
    updatedAt: "Stage 2",
    imageUrl: "/assets/seismic/ablation.png",
    caption: "Figure 3 · Score-component ablation at 1% FAR",
    altText: "完整探测器与移除 polarization、coincidence 等分量后的噪声检出率和地震检出率对比",
  },
  {
    id: "seismic-channel-breakdown",
    kind: "figure",
    order: 6,
    title: "fig_breakdown_channel.png",
    path: "stead_seismic/fig_breakdown_channel.png",
    detail: "910 x 650 · BH/EH/HH/HN/SH",
    updatedAt: "Stage 2",
    imageUrl: "/assets/seismic/channel-prevalence.png",
    caption: "Figure 4 · Flagged prevalence by channel type",
    altText: "BH、EH、HH、HN 和 SH 通道的相干瞬态检出率柱状图",
  },
  {
    id: "seismic-paper",
    kind: "paper",
    order: 7,
    title: "03_paper.pdf",
    path: "stead_seismic/stages/03_paper.pdf",
    detail: "10 页 · 7 图 · 14 篇参考文献",
    updatedAt: "Stage 3",
    imageUrl: "/assets/seismic/stead-noise-audit.pdf",
    location: "p. 4 · Results",
    sectionTitle: "4 Results",
    content: `Applying the label-agnostic, null-calibrated anomaly score to the 750 noise-labeled STEAD traces, and setting the detection threshold at 1.63e-07 to hold the false-alarm rate at 1% against an IAAFT-matched surrogate null, the detector flags 163 of these 750 traces, a prevalence of 21.7% (95% confidence interval 18.8% to 24.9%). The empirical false-alarm rate realized on the surrogate null itself is 1.07%.

An ablation removing the cross-channel coincidence term from the anomaly score collapses prevalence in the same 750 noise-labeled traces from 21.73% to 2.00%, matching the amplitude-only baseline. Removing polarization instead leaves prevalence at 21.47%, identifying coincident onset timing across the three channels as the dominant driver of the flagged population.`,
  },
];

const stage2Trace: ResearchTrace = {
  id: "stead-seismic-stage-2",
  stage: "Stage 2",
  title: "完整实验轨迹",
  summary: "40 calls · 36 run_python · 1 recovered error · Gate passed",
  entries: [
    {
      id: "s2-trace-00",
      sequence: 0,
      phase: "准备与方法迭代",
      tool: "inspect_data",
      label: "读取数据结构与字段",
      detail: "检查样本数、标签、通道、台网与数组形状。",
      output: "1500 traces · fields: label, channel, network, station · shape: 3 x 6000",
      status: "complete",
      importance: "milestone",
    },
    {
      id: "s2-trace-01",
      sequence: 1,
      phase: "准备与方法迭代",
      tool: "run_python",
      label: "核对样本与通道分布",
      detail: "统计全量标签、channel code 和主要 network。",
      output: "earthquake=750 · noise=750 · HH=704 · BH=311 · EH=272 · HN=205 · SH=8",
      status: "complete",
    },
    {
      id: "s2-trace-02",
      sequence: 2,
      phase: "准备与方法迭代",
      tool: "run_python",
      label: "检查波形数值范围",
      detail: "验证单条记录的数据类型、形状与幅值尺度。",
      output: "shape=(3, 6000) · dtype=float32 · max_abs=2082.422 · mean_abs=48.19763",
      status: "complete",
    },
    {
      id: "s2-trace-03",
      sequence: 3,
      phase: "准备与方法迭代",
      tool: "run_python",
      label: "实现 STA/LTA 原型",
      detail: "用 0.5 s STA / 10 s LTA 测试单通道 characteristic function。",
      output: "peak_ratio=2.2767 · peak_sample=5529 · prototype completed",
      status: "complete",
    },
    {
      id: "s2-trace-04",
      sequence: 4,
      phase: "准备与方法迭代",
      tool: "run_python",
      label: "提取首版三分量特征",
      detail: "计算 onset、peak、rectilinearity、planarity 与 coincidence。",
      output: "750 noise + 750 earthquake traces processed · feature cache saved",
      status: "complete",
    },
    {
      id: "s2-trace-05",
      sequence: 5,
      phase: "准备与方法迭代",
      tool: "run_python",
      label: "建立 phase-randomized null",
      detail: "首次用独立相位随机化破坏跨分量 coherence。",
      output: "intermediate prevalence=23.73% · null FAR=1.07% · threshold=1.20e-09",
      status: "complete",
      importance: "milestone",
    },
    {
      id: "s2-trace-06",
      sequence: 6,
      phase: "准备与方法迭代",
      tool: "run_python",
      label: "盘点 noise 子集分组",
      detail: "统计 noise traces 的 channel、network 与重复台站。",
      output: "HH=320 · HN=205 · BH=134 · EH=84 · SH=7",
      status: "complete",
    },
    {
      id: "s2-trace-07",
      sequence: 7,
      phase: "准备与方法迭代",
      tool: "run_python",
      label: "检查台站重叠",
      detail: "比较 noise 与 earthquake 子集的 network+station group。",
      output: "noise stations=417 · earthquake stations=325 · overlap=48",
      status: "complete",
    },
    {
      id: "s2-trace-08",
      sequence: 8,
      phase: "准备与方法迭代",
      tool: "run_python",
      label: "诊断特征分布",
      detail: "检查 amplitude、R、P 与 soft-coincidence 的范围和极值。",
      output: "median R=0.5031 · median P=0.6728 · coincidence term highly sparse",
      status: "complete",
    },
    {
      id: "s2-trace-09",
      sequence: 9,
      phase: "准备与方法迭代",
      tool: "run_python",
      label: "定位异常 amplitude 极值",
      detail: "检查首版 score 中的数值爆点，确认近零通道导致除法不稳定。",
      output: "extreme STA/LTA=3.33e15 · near-flat channel detected",
      status: "revised",
      importance: "issue",
    },
    {
      id: "s2-trace-10",
      sequence: 10,
      phase: "准备与方法迭代",
      tool: "run_python",
      label: "量化零值与 dead-channel 风险",
      detail: "统计各组波形中长段零值或近零方差通道。",
      output: "noise traces with >10% zero samples on any channel: 15",
      status: "complete",
    },
    {
      id: "s2-trace-11",
      sequence: 11,
      phase: "准备与方法迭代",
      tool: "run_python",
      label: "加入 LTA variance floor",
      detail: "稳定 near-flat segment 的 STA/LTA 分母后重新提取特征。",
      output: "intermediate prevalence=23.47% · null FAR=1.07% · score range stabilized",
      status: "complete",
    },
    {
      id: "s2-trace-12",
      sequence: 12,
      phase: "准备与方法迭代",
      tool: "run_python",
      label: "检查 flagged traces 的台站集中度",
      detail: "查找中间版本中贡献较多的 network-station-channel groups。",
      output: "intermediate flagged count=176/750 · no single station dominates",
      status: "complete",
    },
    {
      id: "s2-trace-13",
      sequence: 13,
      phase: "准备与方法迭代",
      tool: "run_python",
      label: "复查剩余极端样本",
      detail: "核对高 ratio 波形的分量标准差和最大幅值。",
      output: "near-dead channels confirmed as the remaining instability source",
      status: "complete",
    },
    {
      id: "s2-trace-14",
      sequence: 14,
      phase: "准备与方法迭代",
      tool: "run_python",
      label: "加入 dead-channel exclusion",
      detail: "标准差低于 1e-6 的通道不参与三分量 vote。",
      output: "17/750 noise traces contain a dead channel · prevalence=21.73% · FAR=1.07%",
      status: "complete",
      importance: "milestone",
    },
    {
      id: "s2-trace-15",
      sequence: 15,
      phase: "准备与方法迭代",
      tool: "run_python",
      label: "生成三类 surrogate null",
      detail: "运行 IAAFT、phase-randomized 与 variance-matched white noise。",
      output: "all 1500 real traces and 3 surrogate families processed · feature set saved",
      status: "complete",
      importance: "milestone",
    },
    {
      id: "s2-trace-16",
      sequence: 16,
      phase: "分析与稳健性",
      tool: "run_python",
      label: "比较四组 score 分布",
      detail: "核对 noise、earthquake 和三类 null 的范围与中位数。",
      output: "median earthquake score=0.0228 · real-noise upper tail exceeds all nulls",
      status: "complete",
    },
    {
      id: "s2-trace-17",
      sequence: 17,
      phase: "分析与稳健性",
      tool: "run_python",
      label: "运行首版 IAAFT primary test",
      detail: "用 IAAFT score 的 99th percentile 设定 label-agnostic threshold。",
      output: "intermediate IAAFT prevalence=20.8% · 156/750 · 95% CI 17.95–23.88%",
      status: "complete",
      importance: "milestone",
    },
    {
      id: "s2-trace-18",
      sequence: 18,
      phase: "分析与稳健性",
      tool: "run_python",
      label: "绘制 score distribution",
      detail: "生成 histogram 与 ECDF，比较 noise、IAAFT null 和 earthquake。",
      output: "fig_main_score_distributions.png written · intermediate prevalence=20.8%",
      status: "complete",
    },
    {
      id: "s2-trace-19",
      sequence: 19,
      phase: "分析与稳健性",
      tool: "run_python",
      label: "运行 baseline 与 component ablation",
      detail: "比较 full score、amp-only 及移除 R/P/coincidence 的变体。",
      output: "amp-only=2.27% · no-coincidence=1.20% · full=20.80% (intermediate)",
      status: "complete",
      importance: "milestone",
    },
    {
      id: "s2-trace-20",
      sequence: 20,
      phase: "分析与稳健性",
      tool: "run_python",
      label: "分析 onset spread",
      detail: "比较 noise、IAAFT surrogate 与 earthquake 的跨分量峰值时间差。",
      output: "median spread: noise=1830 · IAAFT=2443 · earthquake=69.5 samples",
      status: "complete",
    },
    {
      id: "s2-trace-21",
      sequence: 21,
      phase: "分析与稳健性",
      tool: "run_python",
      label: "运行机制检验",
      detail: "首次比较 flagged/unflagged 的 spread、R、P 和 log-amplitude。",
      output: "spread p-value returned NaN because 17 dead-channel rows were not masked",
      status: "revised",
      importance: "issue",
    },
    {
      id: "s2-trace-22",
      sequence: 22,
      phase: "分析与稳健性",
      tool: "run_python",
      label: "修复 mechanism NaN mask",
      detail: "排除缺失 spread 的 dead-channel rows 后重算 Mann-Whitney U。",
      output: "median spread 20.5 vs 2290 samples · p=5.46e-82",
      status: "complete",
      importance: "milestone",
    },
    {
      id: "s2-trace-23",
      sequence: 23,
      phase: "分析与稳健性",
      tool: "run_python",
      label: "按 channel 分解 prevalence",
      detail: "对 BH/EH/HH/HN 做 chi-square；SH 因 n<20 仅描述。",
      output: "intermediate p=1.21e-14 · HN lowest, reversing the preregistered direction",
      status: "complete",
      importance: "milestone",
    },
    {
      id: "s2-trace-24",
      sequence: 24,
      phase: "分析与稳健性",
      tool: "run_python",
      label: "按 network 分解 prevalence",
      detail: "比较 n>=15 的 13 个 networks。",
      output: "prevalence range 0–64.7% · chi-square p=1.26e-14 (intermediate)",
      status: "complete",
      importance: "milestone",
    },
    {
      id: "s2-trace-25",
      sequence: 25,
      phase: "分析与稳健性",
      tool: "run_python",
      label: "检查 channel-network confounding",
      detail: "核对低 prevalence network 的 channel 构成。",
      output: "NC is dominated by HN (142/156); EC subset is entirely HH",
      status: "complete",
    },
    {
      id: "s2-trace-26",
      sequence: 26,
      phase: "分析与稳健性",
      tool: "run_python",
      label: "扫描 FAR 与 null 类型",
      detail: "在 0.1–5% FAR 下比较 IAAFT、phase 与 white-noise null。",
      output: "prevalence changes smoothly across FAR; no threshold cliff detected",
      status: "complete",
      importance: "milestone",
    },
    {
      id: "s2-trace-27",
      sequence: 27,
      phase: "分析与稳健性",
      tool: "run_python",
      label: "扫描 STA/LTA windows",
      detail: "比较 0.2/5 s、0.5/10 s、1/20 s 与 0.5/20 s。",
      output: "prevalence=19.07%, 21.73%, 22.80%, 22.93% · FAR=1.07% throughout",
      status: "complete",
      importance: "milestone",
    },
    {
      id: "s2-trace-28",
      sequence: 28,
      phase: "分析与稳健性",
      tool: "run_python",
      label: "运行 station-cluster bootstrap",
      detail: "按 network+station 重采样，避免重复台站造成伪精度。",
      output: "417 unique stations · 178 repeated · intermediate cluster CI 17.00–24.97%",
      status: "complete",
      importance: "milestone",
    },
    {
      id: "s2-trace-29",
      sequence: 29,
      phase: "错误恢复与最终复算",
      tool: "run_python",
      label: "计算 post-hoc calibration 与多重校正",
      detail: "post-hoc 部分完成，但环境缺少 statsmodels，校正步骤中断。",
      output: "EXIT=1 · ModuleNotFoundError: statsmodels · post-hoc percentile=77.13 retained",
      status: "failed",
      importance: "issue",
    },
    {
      id: "s2-trace-30",
      sequence: 30,
      phase: "错误恢复与最终复算",
      tool: "run_python",
      label: "用 NumPy 重算 FDR 与 Bonferroni",
      detail: "移除非必要依赖，手工实现 Benjamini-Hochberg adjustment。",
      output: "7/7 formal tests survive FDR 0.05 and Bonferroni alpha=0.00714",
      status: "complete",
      importance: "milestone",
    },
    {
      id: "s2-trace-31",
      sequence: 31,
      phase: "错误恢复与最终复算",
      tool: "run_python",
      label: "执行 self-contained primary rerun",
      detail: "从原始数组重新计算 IAAFT features、threshold、prevalence 与 CI。",
      output: "threshold=1.630975e-07 · 163/750 · prevalence=21.73% · 95% CI 18.83–24.86%",
      status: "complete",
      importance: "milestone",
      artifactIds: ["seismic-detector-code"],
    },
    {
      id: "s2-trace-32",
      sequence: 32,
      phase: "错误恢复与最终复算",
      tool: "run_python",
      label: "复算 primary、baseline、ablation 与 mechanism",
      detail: "用同一次 feature extraction 生成最终决定性数字和图。",
      output: "full=21.73% · amp-only=2.00% · no-coincidence=2.00% · eq detect=65.33%",
      status: "complete",
      importance: "milestone",
      artifactIds: ["seismic-score-distributions", "seismic-ablation"],
    },
    {
      id: "s2-trace-33",
      sequence: 33,
      phase: "错误恢复与最终复算",
      tool: "run_python",
      label: "复算 channel 与 network breakdown",
      detail: "用最终 threshold 重新生成分组统计与图表。",
      output: "BH=32.84% · EH=23.81% · HH=29.06% · HN=2.44% · p=5.70e-14",
      status: "complete",
      importance: "milestone",
      artifactIds: ["seismic-channel-table", "seismic-channel-breakdown"],
    },
    {
      id: "s2-trace-34",
      sequence: 34,
      phase: "错误恢复与最终复算",
      tool: "run_python",
      label: "复算 FAR sensitivity",
      detail: "在最终 feature set 上重复三类 null 的阈值扫描。",
      output: "at FAR=1%: IAAFT=21.73% · phase=22.27% · white=21.73%",
      status: "complete",
      importance: "milestone",
    },
    {
      id: "s2-trace-35",
      sequence: 35,
      phase: "错误恢复与最终复算",
      tool: "run_python",
      label: "复算 window sensitivity",
      detail: "确认四种 STA/LTA window 下结论不变。",
      output: "observed prevalence remains within 19.07–22.93%",
      status: "complete",
      importance: "milestone",
    },
    {
      id: "s2-trace-36",
      sequence: 36,
      phase: "错误恢复与最终复算",
      tool: "run_python",
      label: "复算 station-cluster interval",
      detail: "用最终 flagged mask 做 3000 次 station-level bootstrap。",
      output: "cluster mean=21.67% · 95% CI 17.93–25.83% · 417 unique stations",
      status: "complete",
      importance: "milestone",
    },
    {
      id: "s2-trace-37",
      sequence: 37,
      phase: "结果 Gate",
      tool: "finalize_results",
      label: "提交结构化结果",
      detail: "第一次提交缺少显式 verdict。",
      output: "Gate rejected: verdict empty",
      status: "revised",
      importance: "issue",
    },
    {
      id: "s2-trace-38",
      sequence: 38,
      phase: "结果 Gate",
      tool: "finalize_results",
      label: "修正 verdict 后再次提交",
      detail: "Gate 将科学计数法中的机制 p-value 误读为非显著，需要改写字段。",
      output: "Gate rejected: mechanism p-value parsing required correction",
      status: "revised",
      importance: "issue",
    },
    {
      id: "s2-trace-39",
      sequence: 39,
      phase: "结果 Gate",
      tool: "finalize_results",
      label: "通过最终结果 Gate",
      detail: "明确 Lead: SUPPORTED、Overall: MIXED，并保留被否定的方向预测。",
      output: "Gate passed · structured result accepted",
      status: "complete",
      importance: "milestone",
    },
  ],
};

const mainMessages: ChatMessage[] = [
  {
    id: "seismic-user-request",
    role: "user",
    author: "你",
    time: "原始请求",
    content: `### 原始请求（中译）
每个文件是一条 60 秒、100 Hz 采样的三分量（E、N、Z）宽频带地震记录，保存为 3 x 6000 数组，来自 STEAD 目录。约 1500 条记录由本地地震与环境/背景噪声均衡组成，并带有 label、台网、台站和通道元数据。

请找出一个具体、新颖、可检验的问题，自行决定方法，在真实波形上运行代码，并产出一篇可发表的论文。`,
  },
  {
    id: "seismic-stage-1",
    role: "assistant",
    author: "OmniScientist",
    time: "Stage 1",
    content: `### 选题：审计 STEAD 的 noise 标签
我保留了目录给出的标签，没有因为视觉判断而重标数据。视觉审查中，idx 1 的给定标签是 noise，但三个分量在约 2500–4000 samples 出现了明显的能量建立与衰减；这个不一致直接形成了研究问题。

### 可检验假设
- 用 STA/LTA、三分量 polarization 与跨通道到时一致性构造 label-agnostic score。
- 仅用 IAAFT/phase-randomized surrogate null 设定阈值，不能用 earthquake/noise 标签调阈值。
- 预注册预期：约 5–15% 的 noise trace 会出现相干瞬态，且 HN/EH/SH 高于 BH/HH。

聚焦检索没有发现直接审计 STEAD noise partition 且按通道/台网分解的同类工作，因此这个方向在本轮检索范围内仍显得研究不足。`,
    toolRun: {
      title: "Stage 1 · 感知与选题完成",
      summary: "24 次工具调用 · Gate passed",
      steps: [
        {
          id: "s1-materials",
          tool: "list_materials",
          label: "盘点 STEAD 样本与元数据",
          detail: "1500 traces · 750 earthquake / 750 noise · 3 x 6000 · 100 Hz",
          status: "complete",
        },
        {
          id: "s1-visual",
          tool: "look_at_signal x9",
          label: "审阅代表性三分量波形",
          detail: "idx 1: label=noise；约 2500–4000 samples 出现瞬态包络",
          status: "complete",
        },
        {
          id: "s1-native",
          tool: "analyze_signal x2",
          label: "核对原生信号特征",
          detail: "保留原标签；视觉判断仅用于生成假设",
          status: "complete",
        },
        {
          id: "s1-literature",
          tool: "search_literature x10",
          label: "检索标签污染、STA/LTA 与 polarization 文献",
          detail: "确认经典方法边界，并将 novelty 表述限定为 under-explored",
          status: "complete",
        },
        {
          id: "s1-finalize",
          tool: "finalize_idea x2",
          label: "补齐视觉审计后通过选题 Gate",
          detail: "第一次要求补充 label mismatch；第二次 Gate passed",
          status: "complete",
        },
      ],
    },
    artifacts: [seismicArtifacts[0]!],
    citations: [
      { id: 1, label: "选题报告", source: "stages/01_ideation.md" },
      { id: 2, label: "真实工具轨迹", source: "Stage 1 trace（本地留存，未公开）" },
    ],
  },
  {
    id: "seismic-stage-2",
    role: "assistant",
    author: "OmniScientist",
    time: "Stage 2",
    content: `### 主结果：SUPPORTED
- 主结果得到支持：在 1% IAAFT-null FAR 下，163/750 条 noise trace 被标记，占 21.73%（95% CI 18.8–24.9%）；null 上的实测 FAR 为 1.07%。
- 关键机制得到支持：去掉 cross-channel coincidence 后，prevalence 从 21.73% 降到 2.00%，与 amplitude-only baseline 相同。

### 完整预注册假设：MIXED
- 预注册方向被否定：HN 只有 2.4%，而 BH/HH 为 32.8%/29.1%；通道差异显著（p=5.7e-14），但方向与假设相反，台网/站点身份解释了更多差异。
- 结果对 FAR、null 类型和 STA/LTA 窗口稳定；按 417 个台站做 cluster bootstrap 后，95% CI 为 17.9–25.8%。

这些检出只能说明波形在该 detector 的特征空间内具有 body-wave-like 结构，不能据此断言它们都是漏标地震。`,
    toolRun: {
      title: "Stage 2 · 完整实验完成",
      summary: "40 次工具调用 · Lead: SUPPORTED · Overall: MIXED",
      steps: [
        {
          id: "s2-inspect",
          tool: "inspect_data",
          label: "确认数据形状与分组字段",
          detail: "1500 traces · 5 个 channel codes · 50+ networks",
          status: "complete",
          output: [
            "samples: 1500 traces",
            "shape: (3, 6000)",
            "labels: earthquake=750, noise=750",
            "channel codes: BH, EH, HH, HN, SH",
            "unique stations: 417",
          ].join("\n"),
        },
        {
          id: "s2-python",
          tool: "run_python x36",
          label: "运行主实验、基线、消融与稳健性分析",
          detail: "IAAFT null、3 种 null、6 个 ablations、4 组 STA/LTA windows",
          status: "complete",
        },
        {
          id: "s2-statistics",
          tool: "run_python",
          label: "复核统计检验与 station-cluster bootstrap",
          detail: "7 项正式检验均通过 FDR 与 Bonferroni；417 个 unique stations",
          status: "complete",
          output: "formal tests: 7/7 passed FDR and Bonferroni\nstation clusters: 417\nbootstrap CI: 17.93%-25.83%",
        },
        {
          id: "s2-finalize",
          tool: "finalize_results x3",
          label: "修正 verdict 与统计字段后通过结果 Gate",
          detail: "两次结构校验反馈；第三次 Gate passed",
          status: "complete",
        },
      ],
      trace: stage2Trace,
    },
    artifacts: seismicArtifacts.slice(1, 6),
    citations: [
      { id: 1, label: "结构化结果", source: "stages/02_experiment.json" },
      { id: 2, label: "实验报告", source: "stages/02_experiment.md" },
      { id: 3, label: "真实工具轨迹", source: "Stage 2 trace（本地留存，未公开）" },
    ],
  },
  {
    id: "seismic-stage-3",
    role: "assistant",
    author: "OmniScientist",
    time: "Stage 3",
    content: `### 论文已生成
最终英文论文已经编译完成：10 页、7 张图、14 篇参考文献。标题为 “Coherent Polarized Signals in a Substantial Fraction of Sampled Noise-Labeled STEAD Traces”。

论文保留了结论边界：它报告的是 label-agnostic detector 下的相干瞬态 prevalence，不把单台站波形直接解释为已确认的漏标地震。完整 PDF 已放到右侧工作台。`,
    artifacts: [seismicArtifacts[6]!],
    citations: [
      { id: 1, label: "论文元数据", source: "stages/03_paper.json" },
      { id: 2, label: "最终 PDF", source: "stages/03_paper.pdf" },
    ],
  },
];

const shortMessages: Record<string, ChatMessage[]> = {
  "session-literature": [
    {
      id: "lit-u1",
      role: "user",
      author: "你",
      time: "昨天",
      content: "整理多模态 AI scientist 的相关工作，按能力边界分类。",
    },
    {
      id: "lit-a1",
      role: "assistant",
      author: "OmniScientist",
      time: "昨天",
      content: "已将 42 篇工作分成 autonomous discovery、tool-using scientist、multimodal evidence grounding 三组，并标记了 7 篇需要人工复核元数据的条目。",
    },
  ],
  "session-figure": [
    {
      id: "fig-u1",
      role: "user",
      author: "你",
      time: "周一",
      content: "检查 Figure 1 在双栏模板里的可读性。",
    },
    {
      id: "fig-a1",
      role: "assistant",
      author: "OmniScientist",
      time: "周一",
      content: "在 100% PDF 渲染下，右下角文字小于正文两个字号。我建议缩短标签并把细节移到 caption。",
    },
  ],
};

export const demoSessionSummaries: SessionSummary[] = [
  {
    id: "session-seismic",
    title: "STEAD 噪声标签审计",
    preview: "主结果 SUPPORTED · 163/750",
    updatedAt: "刚刚",
    group: "今天",
    status: "complete",
    workspace: "stead_seismic",
    model: "claude-sonnet-5",
  },
  {
    id: "session-ablation",
    title: "消融实验设计",
    preview: "正在核对 perception gate 的对照组",
    updatedAt: "38 分钟前",
    group: "今天",
    status: "running",
    workspace: "21_ai_scientist",
    model: "deepseek-v4-flash",
  },
  {
    id: "session-rebuttal",
    title: "Reviewer 2 回复草稿",
    preview: "关于 judge variance 的补充说明",
    updatedAt: "2 小时前",
    group: "今天",
    status: "idle",
    workspace: "21_ai_scientist",
    model: "deepseek-v4-flash",
  },
  {
    id: "session-literature",
    title: "相关工作检索",
    preview: "42 篇文献已按能力边界分类",
    updatedAt: "昨天",
    group: "过去 7 天",
    status: "complete",
    workspace: "21_ai_scientist",
    model: "deepseek-v4-flash",
  },
  {
    id: "session-figure",
    title: "Figure 1 可读性检查",
    preview: "双栏排版下有一处字号过小",
    updatedAt: "周一",
    group: "过去 7 天",
    status: "complete",
    workspace: "21_ai_scientist",
    model: "deepseek-v4-flash",
  },
  {
    id: "session-data",
    title: "CT 数据质量盘点",
    preview: "发现 3 个序列的 spacing 元数据异常",
    updatedAt: "周日",
    group: "过去 7 天",
    status: "idle",
    workspace: "ct_study",
    model: "deepseek-v4-flash",
  },
];

const fallbackMessages: ChatMessage[] = [
  {
    id: "fallback-u",
    role: "user",
    author: "你",
    time: "最近",
    content: "继续检查这个研究任务。",
  },
  {
    id: "fallback-a",
    role: "assistant",
    author: "OmniScientist",
    time: "最近",
    content: "上下文已经恢复。当前没有运行中的工具；可以从上次停下的位置继续。",
  },
];

export function getDemoSession(id: string): ChatSession {
  const summary = demoSessionSummaries.find((item) => item.id === id) ?? demoSessionSummaries[0]!;
  const messages = id === "session-seismic" ? mainMessages : shortMessages[id] ?? fallbackMessages;
  return { ...summary, messages: structuredClone(messages) };
}
