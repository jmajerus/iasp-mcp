import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type CreditLookup,
  checkAiDisclosure,
  fetchCreditLine,
  readFrontMatter,
  resolveAiDisclosure,
} from "../src/ai-credit.js";
import { extractFrontmatter, renderGhostMarkdown } from "../src/ghost.js";
import { manageAiDisclosure } from "../src/markdown.js";
import { renderDocument } from "../src/render.js";

const OFF = { PROVENANCE_BASE: "off", QUOTE_BASE: "off", HOLDINGS_BASE: "off", CORPUS_BASE: "off", TERMINOLOGY_BASE: "off" };

const withProvenance = (aiDisclosure: string) => `---
title: Credit test
author: John Majerus
provenance:
  contributors:
    - "John Majerus"
    - { name: "Claude", model: "anthropic/claude-opus-5-5" }
${aiDisclosure}
---

::: {.article}

# Credit test

Body text.

## References

Ref.

:::
`;

const creditOk: CreditLookup = {
  response: {
    creditLine: "By Claude (Opus 5.5), with editorial direction by John Majerus",
    warnings: [],
    errors: [],
    matchTable: { modelsDev: { snapshot: "2026-11-27" } },
  },
};

describe("front matter", () => {
  it("reads nested YAML and records each top-level key's line", () => {
    const fm = readFrontMatter(withProvenance("ai-disclosure:\n  placement: inline"));
    expect(fm.error).toBeUndefined();
    expect((fm.data.provenance as { contributors: unknown[] }).contributors).toHaveLength(2);
    expect(fm.keyLines).toMatchObject({ title: 2, author: 3, provenance: 4, "ai-disclosure": 8 });
  });

  it("keeps extractFrontmatter's flat strings, leaving out mappings and lists", () => {
    const { frontmatter } = extractFrontmatter(withProvenance('version: 0.2\nlink-citations: true\nsubtitle: "A: B"'));
    expect(frontmatter).toMatchObject({ title: "Credit test", version: "0.2", "link-citations": "true", subtitle: "A: B" });
    expect(frontmatter.provenance).toBeUndefined();
  });

  it("falls back to key: value lines when the block is not valid YAML", () => {
    const { frontmatter } = extractFrontmatter("---\ntitle: Ok\nbad: [unclosed\n---\nBody\n");
    expect(frontmatter.title).toBe("Ok");
  });
});

describe("resolveAiDisclosure precedence", () => {
  it("prints the statement over the credit line, and never asks provenance-mcp for it", async () => {
    const r = await resolveAiDisclosure({
      markdown: withProvenance('ai-disclosure:\n  placement: inline\n  statement: "Written by hand."'),
      creditLookup: { unavailable: "must not be asked" },
    });
    expect(r).toMatchObject({ source: "statement", position: "end", paragraphs: ["Written by hand."] });
    expect(r.warnings).toEqual([]);
  });

  it("prints the legacy sidecar text over the credit line", async () => {
    const r = await resolveAiDisclosure({
      markdown: withProvenance("ai-disclosure:\n  placement: titlepage"),
      legacy: { ai_disclosure: "Legacy text." },
      legacyFromSidecar: true,
      creditLookup: creditOk,
    });
    expect(r).toMatchObject({ source: "legacy", position: "top", paragraphs: ["Legacy text."] });
    expect(r.warnings.join(" ")).toMatch(/deprecated/);
  });

  it("prints the credit line from provenance, then the technical note", async () => {
    const r = await resolveAiDisclosure({
      markdown: withProvenance('ai-disclosure:\n  placement: copyright\n  technical-note: "Built with IASP."'),
      creditLookup: creditOk,
    });
    expect(r).toMatchObject({
      source: "credit",
      position: "end",
      paragraphs: ["By Claude (Opus 5.5), with editorial direction by John Majerus", "Built with IASP."],
    });
    expect(r.credit?.matchTable).toEqual({ modelsDev: { snapshot: "2026-11-27" } });
  });

  it("prints nothing by default, and a bare-string ai-disclosure is a statement with placement none", async () => {
    for (const extra of ["", 'ai-disclosure: "Drafted with help."']) {
      const r = await resolveAiDisclosure({ markdown: withProvenance(extra), creditLookup: creditOk });
      expect(r).toMatchObject({ placement: "none", position: null, paragraphs: [] });
    }
  });

  it("keeps the legacy sidecar printing inline when front matter sets no placement", async () => {
    const r = await resolveAiDisclosure({ markdown: "# T\n", legacy: { ai_disclosure: "Old.", technical_note: "Note." } });
    expect(r).toMatchObject({ placement: "inline", source: "legacy", paragraphs: ["Old.", "Note."] });
  });

  it("warns on an unknown placement and prints nothing", async () => {
    const r = await resolveAiDisclosure({ markdown: withProvenance("ai-disclosure:\n  placement: footer"), creditLookup: creditOk });
    expect(r.position).toBeNull();
    expect(r.warnings.join(" ")).toMatch(/footer/);
  });

  it("prints no invented line when provenance-mcp is unavailable, and escapes Markdown in a credit line", async () => {
    const off = await resolveAiDisclosure({ markdown: withProvenance("ai-disclosure:\n  placement: inline"), env: OFF });
    expect(off.paragraphs).toEqual([]);
    expect(off.warnings.join(" ")).toMatch(/PROVENANCE_BASE=off/);

    const starred = await resolveAiDisclosure({
      markdown: withProvenance("ai-disclosure:\n  placement: inline"),
      creditLookup: { response: { creditLine: "By *Bot* [x]", warnings: [], errors: [] } },
    });
    expect(starred.paragraphs).toEqual(["By \\*Bot\\* \\[x\\]"]);
  });
});

describe("POST /api/credit client", () => {
  let server: Server;
  let base = "";
  const seen: unknown[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        seen.push(JSON.parse(body));
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            creditLine: "Drafted with Claude (Opus 5.5)",
            contributors: [],
            warnings: [{ index: 1, code: "unknownModel" }],
            errors: ["aiWithHuman"],
            matchTable: { overlay: { revision: 2 } },
          }),
        );
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it("sends provenance with mixedDefault and the document's authors", async () => {
    const got = await fetchCreditLine({ contributors: ["A"] }, { authors: ["A"], env: { PROVENANCE_BASE: base } });
    expect(got.response?.creditLine).toBe("Drafted with Claude (Opus 5.5)");
    expect(seen.at(-1)).toEqual({ provenance: { contributors: ["A"] }, params: { mixedDefault: "humanPrimary", authors: ["A"] } });
  });

  it("reports provenance-mcp's errors and warnings as validation warnings", async () => {
    const issues = await checkAiDisclosure(withProvenance(""), { env: { PROVENANCE_BASE: base } });
    expect(issues.map((i) => [i.severity, i.code, i.line])).toEqual([
      ["warning", "provenance-error", 4],
      ["warning", "provenance-warning", 4],
    ]);
    expect(issues[1].message).toContain("contributors[1]: unknownModel");
  });

  it("checks only the shape when provenance-mcp is unreachable", async () => {
    const issues = await checkAiDisclosure("---\nprovenance:\n  contributors: []\nai-disclosure:\n  placement: footer\n---\n", {
      env: { PROVENANCE_BASE: "http://127.0.0.1:1" },
    });
    expect(issues.map((i) => [i.severity, i.code])).toEqual([
      ["warning", "ai-disclosure-invalid"],
      ["warning", "provenance-invalid"],
      ["info", "provenance-unchecked"],
    ]);
  });
});

describe("placing the block", () => {
  const block = { paragraphs: ["By Claude (Opus 5.5)"], variant: "ai" };

  it("puts 'end' before the references heading and 'top' after the title in md", () => {
    const md = "# Title\n\nBody.\n\n## Works Cited\n\nRef.\n";
    const end = renderGhostMarkdown(md, { mode: "md", disclosure: { ...block, position: "end" } });
    expect(end.indexOf("AI DISCLOSURE")).toBeLessThan(end.indexOf("## Works Cited"));
    expect(end.indexOf("AI DISCLOSURE")).toBeGreaterThan(end.indexOf("Body."));
    const top = renderGhostMarkdown(md, { mode: "md", disclosure: { ...block, position: "top" } });
    expect(top.indexOf("AI DISCLOSURE")).toBeGreaterThan(top.indexOf("# Title"));
    expect(top.indexOf("AI DISCLOSURE")).toBeLessThan(top.indexOf("Body."));
  });

  it("places it in HTML through the Lua filter, inside the article wrapper", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "iasp-ai-credit-"));
    const prev = process.env.IASP_RENDER_DIR;
    process.env.IASP_RENDER_DIR = tmp;
    try {
      const res = await renderDocument({
        markdown: withProvenance('ai-disclosure:\n  placement: inline\n  statement: "Written with care."'),
        formats: ["html"],
        returnContent: true,
        env: OFF,
      });
      const html = res.artifacts[0].content as string;
      const at = html.indexOf('data-iasp-ai-disclosure="true"');
      expect(at).toBeGreaterThan(-1);
      expect(html.slice(at - 40, at)).toContain('class="note ai"');
      expect(html.indexOf("Written with care.")).toBeGreaterThan(html.indexOf("Body text."));
      expect(html.indexOf("Written with care.")).toBeLessThan(html.indexOf('id="references"'));
      expect(res.ai_disclosure).toMatchObject({ placement: "inline", source: "statement" });
    } finally {
      if (prev === undefined) delete process.env.IASP_RENDER_DIR;
      else process.env.IASP_RENDER_DIR = prev;
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("ai_disclosure tool", () => {
  it("migrates a legacy sidecar into front matter, keeping the article body and comments", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "iasp-ai-migrate-"));
    try {
      writeFileSync(join(tmp, "a.md"), "---\ntitle: A # keep me\n---\n\n# A\n\nBody.\n", "utf8");
      writeFileSync(join(tmp, "a.ai.json"), JSON.stringify({ ai_disclosure: "Old text.", technical_note: "Note.", turns: 9 }), "utf8");
      const res = await manageAiDisclosure({ article: "a.md", action: "migrate", rootDir: tmp, env: OFF });
      expect(res).toMatchObject({ placement: "inline", source: "statement", printed: ["Old text.", "Note."] });
      expect(res.notes?.join(" ")).toMatch(/Turn counts/);
      expect(readFileSync(join(tmp, "a.md"), "utf8")).toBe(
        "---\ntitle: A # keep me\nai-disclosure:\n  statement: Old text.\n  technical-note: Note.\n  placement: inline\n---\n\n# A\n\nBody.\n",
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
