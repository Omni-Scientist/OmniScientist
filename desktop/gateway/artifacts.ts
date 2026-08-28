import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, extname, relative, resolve, sep } from "node:path";

import { traceOmniSciReceipts, type OmniSciTrace } from "../../cli/src/tools/omnisci.ts";
import type { Artifact } from "../src/types.ts";

interface ManifestFile {
  path?: string;
  sha256?: string;
  size?: number;
}

interface PaperManifest {
  status?: string;
  title?: string;
  artifacts?: Record<string, ManifestFile>;
  inputs?: {
    figures?: Array<ManifestFile & { bundled_as?: string }>;
    sections?: ManifestFile;
  };
  review_pages?: ManifestFile[];
}

interface SectionsFile {
  ABSTRACT?: string;
  _figures?: Array<{ file?: string; caption?: string }>;
}

export interface ArtifactFile {
  absolutePath: string;
  filename: string;
  contentType: string;
}

export interface DiscoveredArtifacts {
  artifacts: Artifact[];
  files: Map<string, ArtifactFile>;
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function fileToken(relativePath: string): string {
  return createHash("sha256").update(relativePath).digest("hex").slice(0, 20);
}

function contentType(path: string): string {
  const types: Record<string, string> = {
    ".bib": "text/plain; charset=utf-8",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".json": "application/json; charset=utf-8",
    ".pdf": "application/pdf",
    ".png": "image/png",
    ".py": "text/x-python; charset=utf-8",
    ".tex": "text/x-tex; charset=utf-8",
    ".zip": "application/zip",
  };
  return types[extname(path).toLowerCase()] ?? "application/octet-stream";
}

function languageFor(path: string): string {
  const languages: Record<string, string> = {
    ".bib": "bibtex",
    ".json": "json",
    ".py": "python",
    ".tex": "latex",
  };
  return languages[extname(path).toLowerCase()] ?? "text";
}

function fileSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

function timeLabel(path: string): string {
  return statSync(path).mtime.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}

function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch {
    return undefined;
  }
}

/**
 * 把收据/清单里的相对路径落到实处。
 *
 * 两个根不是一回事：收据里写的是 host/paper.tex 这种相对 case 根的路径，而读写
 * 边界是工作区根。工作区里可以放好几个数据集，case 根是其中一个子目录，所以
 * 解析用 caseRoot，越界检查仍然对着 workspaceRoot。
 * 显示用的相对路径给的是相对工作区那份，用户看到的是 datasets/x/host/paper.tex。
 */
function safeWorkspaceFile(
  workspaceRoot: string,
  caseRoot: string,
  requested: string,
): { absolute: string; relative: string } | undefined {
  if (!requested.trim()) return undefined;
  const root = realpathSync(workspaceRoot);
  const base = existsSync(caseRoot) ? realpathSync(caseRoot) : root;
  const candidate = resolve(base, requested);
  if (!existsSync(candidate) || !statSync(candidate).isFile()) return undefined;
  const absolute = realpathSync(candidate);
  if (absolute !== root && !absolute.startsWith(`${root}${sep}`)) return undefined;
  // 产物只认 case 根下面的 host/，别把工作区里随便一个文件当成研究产物。
  if (!relative(base, absolute).split(sep).join("/").startsWith("host/")) return undefined;
  return { absolute, relative: relative(root, absolute).split(sep).join("/") };
}

function latestByOperation(traces: OmniSciTrace[], operation: "compile"): OmniSciTrace | undefined {
  // tex_only 也算成功：机器上没装 tectonic 时编到 .tex 就停，产物照样有。
  // 只认 "ok" 的话，没装 tectonic 的用户跑完一整轮，工作台是空的。
  return [...traces]
    .reverse()
    .find((trace) => trace.receipt.operation === operation
      && (trace.receipt.status === "ok" || trace.receipt.status === "tex_only"));
}

export function discoverArtifacts(
  workspaceRoot: string,
  caseRoot: string,
  sessionId: string,
  modelMessages: unknown[],
): DiscoveredArtifacts {
  const traces = traceOmniSciReceipts(modelMessages);
  const files = new Map<string, ArtifactFile>();
  const artifacts: Artifact[] = [];
  const result = (): DiscoveredArtifacts => ({
    artifacts: artifacts.sort((left, right) => (left.order ?? 100) - (right.order ?? 100)),
    files,
  });
  const artifactUrl = (token: string) => (
    `/api/v1/sessions/${encodeURIComponent(sessionId)}/artifacts/${encodeURIComponent(token)}/content`
  );
  const register = (requested: string, expectedSha?: string): { token: string; url: string; absolute: string; relative: string } | undefined => {
    const resolved = safeWorkspaceFile(workspaceRoot, caseRoot, requested);
    if (!resolved) return undefined;
    const sha = sha256File(resolved.absolute);
    if (expectedSha && sha !== expectedSha) return undefined;
    const token = fileToken(resolved.relative);
    files.set(token, {
      absolutePath: resolved.absolute,
      filename: basename(resolved.relative),
      contentType: contentType(resolved.relative),
    });
    return { token, url: `${artifactUrl(token)}?v=${sha.slice(0, 12)}`, ...resolved };
  };

  const recordedScripts = new Map<string, OmniSciTrace>();
  for (const trace of traces) {
    if (trace.receipt.operation !== "record" || typeof trace.receipt.script !== "string") continue;
    recordedScripts.set(trace.receipt.script, trace);
  }
  let order = 10;
  for (const [script, trace] of recordedScripts) {
    const registered = register(script, typeof trace.receipt.script_sha256 === "string"
      ? trace.receipt.script_sha256
      : undefined);
    if (!registered) continue;
    const source = readFileSync(registered.absolute, "utf-8");
    artifacts.push({
      id: `artifact-${registered.token}`,
      kind: "code",
      title: basename(registered.relative),
      path: registered.relative,
      detail: "可信分析脚本 · {0} 行",
      detailArgs: [source.split(/\r?\n/).length],
      updatedAt: timeLabel(registered.absolute),
      order: 40 + order++,
      language: languageFor(registered.relative),
      content: source,
      fileUrl: registered.url,
    });
  }

  const compileTrace = latestByOperation(traces, "compile");
  if (!compileTrace) return result();
  const name = typeof compileTrace.receipt.name === "string" ? compileTrace.receipt.name : "paper";
  const manifestFile = register(
    `host/${name}.manifest.json`,
    typeof compileTrace.receipt.manifest_sha256 === "string" ? compileTrace.receipt.manifest_sha256 : undefined,
  );
  if (!manifestFile) return result();
  const manifest = readJson<PaperManifest>(manifestFile.absolute);
  // tex_only 也是成功：paper_cli.py 自己就是 `exit(0 if status in ("ok","tex_only"))`。
  // 机器上没装 tectonic 时只出 .tex，那也是产物，不该在工作台里一片空白。
  if (!manifest || (manifest.status !== "ok" && manifest.status !== "tex_only")) return result();

  const sectionsFile = manifest.inputs?.sections?.path
    ? register(manifest.inputs.sections.path, manifest.inputs.sections.sha256)
    : undefined;
  const sections = sectionsFile ? readJson<SectionsFile>(sectionsFile.absolute) : undefined;
  const captions = new Map(
    (sections?._figures ?? [])
      .filter((figure): figure is { file: string; caption?: string } => typeof figure.file === "string")
      .map((figure) => [figure.file, figure.caption ?? ""]),
  );

  for (const [index, figure] of (manifest.inputs?.figures ?? []).entries()) {
    if (!figure.path) continue;
    const registered = register(figure.path, figure.sha256);
    if (!registered) continue;
    const caption = captions.get(figure.path) || `论文主图 ${index + 1}`;
    artifacts.push({
      id: `artifact-${registered.token}`,
      kind: "figure",
      title: basename(registered.relative),
      path: registered.relative,
      detail: "论文主图 {0} · {1}",
      detailArgs: [index + 1, fileSize(statSync(registered.absolute).size)],
      updatedAt: timeLabel(registered.absolute),
      order: 20 + index,
      imageUrl: registered.url,
      fileUrl: registered.url,
      caption,
      altText: caption,
    });
  }

  const tex = manifest.artifacts?.tex?.path
    ? register(manifest.artifacts.tex.path, manifest.artifacts.tex.sha256)
    : undefined;
  if (tex) {
    const source = readFileSync(tex.absolute, "utf-8");
    artifacts.push({
      id: `artifact-${tex.token}`,
      kind: "code",
      title: basename(tex.relative),
      path: tex.relative,
      detail: "论文 LaTeX · {0} 行",
      detailArgs: [source.split(/\r?\n/).length],
      updatedAt: timeLabel(tex.absolute),
      order: 60,
      language: "latex",
      content: source,
      fileUrl: tex.url,
    });
  }

  // Overleaf 压缩包也是交付物，尤其在没出 PDF 的时候：它是把论文拿去别处编译的
  // 唯一入口。不列出来，用户根本不知道它在哪。
  const zip = manifest.artifacts?.overleaf_zip?.path
    ? register(manifest.artifacts.overleaf_zip.path, manifest.artifacts.overleaf_zip.sha256)
    : undefined;
  if (zip) {
    const kb = Math.max(1, Math.round(statSync(zip.absolute).size / 1024));
    artifacts.push({
      id: `artifact-${zip.token}`,
      kind: "code",
      title: basename(zip.relative),
      path: zip.relative,
      detail: "Overleaf 上传包 · {0} KB · 含 .tex、参考文献和全部图",
      detailArgs: [kb],
      updatedAt: timeLabel(zip.absolute),
      order: 65,
      fileUrl: zip.url,
    });
  }

  const pdf = manifest.artifacts?.pdf?.path
    ? register(manifest.artifacts.pdf.path, manifest.artifacts.pdf.sha256)
    : undefined;
  if (pdf) {
    const previews = (manifest.review_pages ?? [])
      .map((page) => page.path ? register(page.path, page.sha256) : undefined)
      .filter((page): page is NonNullable<typeof page> => Boolean(page));
    const bundle = manifest.artifacts?.overleaf_zip?.path
      ? register(manifest.artifacts.overleaf_zip.path, manifest.artifacts.overleaf_zip.sha256)
      : undefined;
    artifacts.push({
      id: `artifact-${pdf.token}`,
      kind: "paper",
      title: basename(pdf.relative),
      path: pdf.relative,
      detail: "{0} 页论文 · {1}",
      detailArgs: [previews.length || "?", fileSize(statSync(pdf.absolute).size)],
      updatedAt: timeLabel(pdf.absolute),
      order: 10,
      content: sections?.ABSTRACT,
      fileUrl: pdf.url,
      bundleUrl: bundle?.url,
      previewUrls: previews.map((page) => page.url),
      sectionTitle: manifest.title ?? "最终论文",
      location: "Final PDF",
    });
  }

  return result();
}
