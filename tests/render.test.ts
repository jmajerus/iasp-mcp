import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { detectToolchain, renderDocument } from "../src/render.js";

describe("end-to-end rendering pipeline (Ghost, HTML, PDF, EPUB)", () => {
  it("renders the demo essay to clean Markdown (md), Ghost Markdown, and standalone HTML, respecting final vs draft stage", () => {
    const tmp = mkdtempSync(join(tmpdir(), "iasp-render-"));
    try {
      const finalBuild = renderDocument({
        source: "demo",
        formats: ["md", "ghost", "html"],
        outputDir: tmp,
        stage: "final",
        returnContent: true,
      });

      const mdArtifact = finalBuild.artifacts.find((a) => a.format === "md")!;
      const ghostArtifact = finalBuild.artifacts.find((a) => a.format === "ghost")!;
      const htmlArtifact = finalBuild.artifacts.find((a) => a.format === "html")!;

      expect(mdArtifact.content).toContain("> **◈ PRELUDE**");
      expect(mdArtifact.content).toContain("> **≡ DEFINITION**");
      expect(mdArtifact.content).toContain("> ⇆ **Structural markup vs. authoring intent:**");
      expect(mdArtifact.content).toContain("> **◇ AI DISCLOSURE**");
      expect(mdArtifact.content).toContain("Included Fragment (`lexical-precision-sidebar.md`)");
      expect(mdArtifact.content).not.toContain("<div style=");
      expect(mdArtifact.content).not.toContain("</div>");
      expect(mdArtifact.content).not.toContain("Draft-only working note:");

      expect(ghostArtifact.content).toContain("AI DISCLOSURE");
      expect(ghostArtifact.content).toContain("<div style=");
      expect(ghostArtifact.content).toContain("Included Fragment (`lexical-precision-sidebar.md`)");
      expect(ghostArtifact.content).toContain("Takeaway:");
      expect(ghostArtifact.content).not.toContain("Draft-only working note:");

      expect(htmlArtifact.content).toContain("epub:type=\"note\"");
      expect(htmlArtifact.content).toContain("Included Fragment");
      expect(htmlArtifact.content).not.toContain("Draft-only working note:");

      const interopBuild = renderDocument({
        source: "interop",
        formats: ["md", "html"],
        outputDir: tmp,
        stage: "final",
        returnContent: true,
      });
      const interopMd = interopBuild.artifacts.find((a) => a.format === "md")!;
      const interopHtml = interopBuild.artifacts.find((a) => a.format === "html")!;
      expect(interopMd.content).toContain("> **◇ AI DISCLOSURE**");
      expect(interopHtml.content).toContain("class=\"csl-entry\"");
      expect(interopHtml.content).toContain("id=\"ref-montalion2024learning\"");
      expect(interopHtml.content).toContain("id=\"ref-brotherton2015suspicious\"");

      const draftBuild = renderDocument({
        source: "demo",
        formats: ["md", "ghost", "html"],
        outputDir: tmp,
        stage: "draft",
        returnContent: true,
      });
      const draftMd = draftBuild.artifacts.find((a) => a.format === "md")!;
      const draftGhost = draftBuild.artifacts.find((a) => a.format === "ghost")!;
      const draftHtml = draftBuild.artifacts.find((a) => a.format === "html")!;
      expect(draftMd.content).toContain("Draft-only working note:");
      expect(draftMd.content).not.toContain("Takeaway:");
      expect(draftGhost.content).toContain("Draft-only working note:");
      expect(draftGhost.content).not.toContain("Takeaway:");
      expect(draftHtml.content).toContain("Draft-only working note:");
      expect(draftHtml.content).not.toContain("Takeaway:");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("renders the demo essay to EPUB and XeLaTeX PDF when pandoc and xelatex are installed", () => {
    const tc = detectToolchain();
    if (!tc.pandoc.available || !tc.xelatex.available) return;

    const tmp = mkdtempSync(join(tmpdir(), "iasp-pdf-epub-"));
    try {
      const res = renderDocument({
        source: "demo",
        formats: ["pdf", "epub"],
        outputDir: tmp,
        validateEpub: tc.epubcheck.available,
      });

      const pdf = res.artifacts.find((a) => a.format === "pdf")!;
      const epub = res.artifacts.find((a) => a.format === "epub")!;

      expect(pdf.bytes).toBeGreaterThan(5000);
      expect(existsSync(join(tmp, "essay-on-attentive-reading.pdf"))).toBe(true);
      const pdfHeader = readFileSync(join(tmp, "essay-on-attentive-reading.pdf")).subarray(0, 5).toString("ascii");
      expect(pdfHeader).toBe("%PDF-");

      expect(epub.bytes).toBeGreaterThan(1000);
      if (tc.epubcheck.available) {
        expect(epub.epubcheck_passed).toBe(true);
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 60_000);
});
