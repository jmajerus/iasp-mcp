import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findCitations, resolveCitations } from "../src/citeproc.js";
import { stripLeadingTitleH1, wrapGhostEpigraph } from "../src/ghost.js";
import { detectToolchain, renderDocument } from "../src/render.js";

const hasPandoc = detectToolchain().pandoc.available;

const BIB = `@book{foucault1977discipline,
  author = {Foucault, Michel},
  title = {Discipline and Punish},
  publisher = {Pantheon},
  year = {1977}
}
`;

describe("citation detection", () => {
  it("finds bracketed, suppressed-author, and narrative citations but skips code, comments, tags, emails, and URLs", () => {
    const text = [
      "As argued [see @a, p. 3; @b] and [-@c, 5], @d [p. 9] notes.",
      "Mail me@example.com or see https://medium.com/@someone and `[@code]`.",
      "<!-- quote 845 [@commented] -->",
      '<div data-x="@attr">',
      "```",
      "[@fenced]",
      "```",
      "[link @text](https://x.test) and [@e, chap. 2][^note].",
    ].join("\n");
    const raws = findCitations(text).map((c) => c.raw);
    expect(raws).toEqual(["[see @a, p. 3; @b]", "[-@c, 5]", "@d [p. 9]", "[@e, chap. 2]"]);
  });

  it("warns instead of passing citations through silently when no bibliography is available", () => {
    const res = resolveCitations("Text [@foucault1977discipline, p. 187].\n", {});
    expect(res.content).toContain("[@foucault1977discipline, p. 187]");
    expect(res.warnings[0]).toMatch(/1 citation\(s\) left unresolved .*no bibliography/);
  });

  it("leaves text without citations untouched", () => {
    const res = resolveCitations("Plain text, no keys.\n", {});
    expect(res).toMatchObject({ content: "Plain text, no keys.\n", warnings: [], citations: 0 });
  });
});

describe.skipIf(!hasPandoc)("citeproc for md and ghost exports", () => {
  it("resolves citations and fills the References section in md and ghost from bibtex_content", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "iasp-cite-"));
    try {
      const markdown = [
        "---",
        'title: "Glass"',
        "---",
        "",
        "# Glass",
        "",
        "> It is the fact of being constantly seen. [@foucault1977discipline, p. 187]",
        "",
        "::: {.note .insight}",
        "As @foucault1977discipline [p. 200] puts it.",
        ":::",
        "",
        "## References",
        "",
      ].join("\n");
      const build = await renderDocument({
        markdown,
        formats: ["md", "ghost"],
        outputDir: tmp,
        bibtexContent: BIB,
        returnContent: true,
      });
      for (const artifact of build.artifacts) {
        expect(artifact.content).not.toContain("@foucault1977discipline");
        expect(artifact.content).toContain("(Foucault 1977, 187)");
        expect(artifact.content).toContain("Foucault (1977, 200)");
        expect(artifact.content).toMatch(/## References\n\nFoucault, Michel\. 1977\. \*Discipline and Punish\*\. Pantheon\./);
        expect(artifact.warnings).toEqual([]);
      }
      const ghost = build.artifacts.find((a) => a.format === "ghost")!.content!;
      const md = build.artifacts.find((a) => a.format === "md")!.content!;
      expect(ghost).not.toMatch(/^# Glass/m);
      expect(md).toMatch(/^# Glass/m);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("keeps the ghost title H1 when asked and reports missing keys", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "iasp-cite-"));
    try {
      const bibPath = join(tmp, "refs.bib");
      writeFileSync(bibPath, BIB, "utf8");
      const build = await renderDocument({
        markdown: "# Title\n\nSee [@nokey].\n",
        formats: ["ghost"],
        outputDir: tmp,
        bibliography: bibPath,
        keepTitleH1: true,
        returnContent: true,
      });
      const ghost = build.artifacts[0];
      expect(ghost.content).toMatch(/^# Title/m);
      expect(ghost.warnings.join("\n")).toContain("not found in the bibliography: nokey");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("ghost export cleanups", () => {
  it("strips only a leading level-1 heading", () => {
    expect(stripLeadingTitleH1("\n<!-- c -->\n# Title\n\n### Sub\n")).toBe("\n<!-- c -->\n### Sub\n");
    expect(stripLeadingTitleH1("Intro\n\n# Later\n")).toBe("Intro\n\n# Later\n");
    expect(stripLeadingTitleH1("## Section\n")).toBe("## Section\n");
  });

  it("does not nest a blockquote when epigraph lines are written with '> '", () => {
    const out = wrapGhostEpigraph("> The more strictly we are watched.\n>\n> — Bentham");
    expect(out).toContain("> The more strictly we are watched.\n>\n> — Bentham");
    expect(out).not.toContain("> >");
  });
});
