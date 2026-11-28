import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { inspectMarkdown, manageAiDisclosure, validateMarkdown, wrapByDirectory } from "../src/markdown.js";

describe("markdown inspection, validation, directory wrapping, and AI disclosures", () => {
  it("inspects and validates the bundled demo essay cleanly", () => {
    const db = openDb(":memory:");
    const inspected = inspectMarkdown(db, { path: "demo/essay-on-attentive-reading.md" });
    expect(inspected.frontmatter.title).toBe("Naming What Prose Is Doing");
    expect(inspected.blocks.length).toBe(1);
    expect(inspected.blocks[0].classes).toEqual(["article"]);
    expect(inspected.includes).toEqual([
      {
        line: 62,
        target: "demo/fragments/lexical-precision-sidebar.md",
        mode: "file",
        exists: true,
      },
    ]);
    expect(inspected.meta_placeholders).toContain("version");

    const validation = validateMarkdown(db, { path: "demo/essay-on-attentive-reading.md" });
    expect(validation.valid).toBe(true);
    expect(validation.error_count).toBe(0);
    expect(validation.warning_count).toBe(0);
  });

  it("flags unclosed fences, sidebar H1s, missing includes, and unknown classes", () => {
    const db = openDb(":memory:");
    const sample = [
      "::: {.sidebar .sidebar-block}",
      "# Bad Level-1 Sidebar Heading",
      "Some text.",
      ":::",
      "",
      "::: {.include path=\"demo/fragments/does-not-exist.md\"}",
      ":::",
      "",
      "::: {.note .nonexistent-modifier}",
      "Unclosed note block",
    ].join("\n");

    const res = validateMarkdown(db, { markdown: sample });
    expect(res.valid).toBe(false);
    const codes = res.issues.map((i) => i.code);
    expect(codes).toContain("sidebar-h1");
    expect(codes).toContain("missing-include");
    expect(codes).toContain("unknown-class");
    expect(codes).toContain("unclosed-fence");
  });

  it("warns when an epigraph fence contains '>' blockquote lines", () => {
    const db = openDb(":memory:");
    const res = validateMarkdown(db, {
      markdown: ["::: {.epigraph}", "> The more strictly we are watched.", ">", "> — Bentham", ":::"].join("\n"),
    });
    const issue = res.issues.find((i) => i.code === "epigraph-blockquote");
    expect(issue).toMatchObject({ severity: "warning", line: 2 });
  });

  it("wraps files by directory and manages front-matter AI disclosures", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "iasp-mcp-test-"));
    try {
      const chaptersDir = join(tmp, "chapters");
      const articlesDir = join(tmp, "articles");
      writeFileSync(join(tmp, "dummy.txt"), "ignore");
      mkdirSync(chaptersDir, { recursive: true });
      mkdirSync(articlesDir, { recursive: true });

      const chFile = join(chaptersDir, "ch1.md");
      writeFileSync(chFile, "# Chapter 1\n\nBody text.\n", "utf8");

      const dryRun = wrapByDirectory({ path: "chapters", apply: false, rootDir: tmp });
      expect(dryRun.updated).toBe(1);
      expect(dryRun.files[0].status).toBe("would-update");

      const applied = wrapByDirectory({ path: "chapters", apply: true, rootDir: tmp });
      expect(applied.updated).toBe(1);
      expect(applied.files[0].status).toBe("updated");

      const secondPass = wrapByDirectory({ path: "chapters", apply: false, rootDir: tmp });
      expect(secondPass.updated).toBe(0);

      const artFile = join(articlesDir, "test-essay.md");
      writeFileSync(artFile, "# Test Essay\n", "utf8");

      const updated = await manageAiDisclosure({
        article: "articles/test-essay.md",
        action: "update",
        init_defaults: true,
        statement: "Drafted with an AI assistant; edited by the author.",
        rootDir: tmp,
        env: { PROVENANCE_BASE: "off" },
      });
      expect(updated.placement).toBe("inline");
      expect(updated.source).toBe("statement");
      expect(updated.printed[0]).toBe("Drafted with an AI assistant; edited by the author.");
      expect(updated.rendered_preview).toContain("AI DISCLOSURE");
      const written = readFileSync(artFile, "utf8");
      expect(written).toMatch(/^---\nai-disclosure:\n {2}statement: Drafted with an AI assistant; edited by the author.\n/);
      expect(written).toContain("# Test Essay");
      expect(existsSync(join(articlesDir, "test-essay.ai.json"))).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
