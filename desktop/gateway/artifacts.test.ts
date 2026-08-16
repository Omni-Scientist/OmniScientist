import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { OMNISCI_RECEIPT_PREFIX } from "../../cli/src/tools/omnisci.ts";
import { discoverArtifacts } from "./artifacts.ts";

const temporaryDirectories: string[] = [];

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "omnisci-desktop-artifacts-"));
  temporaryDirectories.push(root);
  mkdirSync(join(root, "host", "analysis"), { recursive: true });
  mkdirSync(join(root, "host", "figures"), { recursive: true });
  mkdirSync(join(root, "host", "paper_review"), { recursive: true });
  const script = "print('recorded result')\n";
  const figure = Buffer.from("fixture png pixels");
  const page = Buffer.from("fixture page pixels");
  const pdf = Buffer.from("%PDF fixture");
  const tex = "\\documentclass{article}\n";
  const sections = JSON.stringify({
    ABSTRACT: "Fixture abstract.",
    _figures: [{ file: "host/figures/main.png", caption: "Fixture figure caption." }],
  });
  writeFileSync(join(root, "host", "analysis", "run.py"), script);
  writeFileSync(join(root, "host", "figures", "main.png"), figure);
  writeFileSync(join(root, "host", "paper_review", "page-1.png"), page);
  writeFileSync(join(root, "host", "paper.pdf"), pdf);
  writeFileSync(join(root, "host", "paper.tex"), tex);
  writeFileSync(join(root, "host", "sections.json"), sections);
  const manifest = {
    status: "ok",
    title: "Fixture paper",
    artifacts: {
      pdf: { path: "host/paper.pdf", sha256: sha256(pdf), size: pdf.length },
      tex: { path: "host/paper.tex", sha256: sha256(tex), size: tex.length },
    },
    inputs: {
      figures: [{ path: "host/figures/main.png", sha256: sha256(figure) }],
      sections: { path: "host/sections.json", sha256: sha256(sections) },
    },
    review_pages: [{ path: "host/paper_review/page-1.png", sha256: sha256(page), size: page.length }],
  };
  const manifestText = JSON.stringify(manifest);
  writeFileSync(join(root, "host", "paper.manifest.json"), manifestText);
  return { root, script, manifestText };
}

function receiptMessages(script: string, manifestText: string): unknown[] {
  return [
    {
      role: "assistant",
      tool_calls: [{
        id: "record-call",
        function: { name: "omnisci_record", arguments: '{"script":"host/analysis/run.py"}' },
      }],
    },
    {
      role: "tool",
      tool_call_id: "record-call",
      content: `${OMNISCI_RECEIPT_PREFIX}${JSON.stringify({
        version: 1,
        operation: "record",
        script: "host/analysis/run.py",
        script_sha256: sha256(script),
      })}`,
    },
    {
      role: "assistant",
      tool_calls: [{
        id: "compile-call",
        function: { name: "omnisci_compile", arguments: '{"sections":"host/sections.json","title":"Fixture"}' },
      }],
    },
    {
      role: "tool",
      tool_call_id: "compile-call",
      content: `${OMNISCI_RECEIPT_PREFIX}${JSON.stringify({
        version: 1,
        operation: "compile",
        name: "paper",
        status: "ok",
        manifest_sha256: sha256(manifestText),
      })}`,
    },
  ];
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("discoverArtifacts", () => {
  test("discovers paper, figures and recorded code from trusted receipts", () => {
    const { root, script, manifestText } = fixture();
    const result = discoverArtifacts(root, root, "local-fixture", receiptMessages(script, manifestText));

    expect(result.artifacts.map((artifact) => artifact.kind)).toEqual(["paper", "figure", "code", "code"]);
    expect(result.artifacts[0]).toMatchObject({
      title: "paper.pdf",
      previewUrls: [expect.stringContaining("/artifacts/")],
    });
    expect(result.artifacts[1]).toMatchObject({
      title: "main.png",
      caption: "Fixture figure caption.",
    });
    expect(result.artifacts[2]).toMatchObject({
      title: "run.py",
      content: script,
    });
    expect(result.files.size).toBeGreaterThanOrEqual(6);
  });

  test("rejects artifacts when the trusted manifest hash no longer matches", () => {
    const { root, script, manifestText } = fixture();
    const messages = receiptMessages(script, manifestText);
    writeFileSync(join(root, "host", "paper.manifest.json"), `${manifestText}\nchanged`);

    const result = discoverArtifacts(root, root, "local-fixture", messages);

    expect(result.artifacts.map((artifact) => artifact.title)).toEqual(["run.py"]);
    expect(result.artifacts.some((artifact) => artifact.kind === "paper")).toBe(false);
  });
});
