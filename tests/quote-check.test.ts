import http from "node:http";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { openDb } from "../src/db.js";
import { type FetchedQuote, type QuoteLookup, fetchQuotes } from "../src/provenance.js";
import { canonicalWords, checkQuotes, locatorsAgree, scanQuotePassages, validateMarkdownWithQuotes } from "../src/quote-check.js";

const HANH =
  "EACH OF US HAS A DEEP DESIRE TO know and understand the world and to be known and understood in return. That is a deep natural thirst.";
const RUSSELL = "The problem is that we may suffer from a failure of value alignment.";

function lookupOf(...quotes: FetchedQuote[]): QuoteLookup {
  return { quotes: new Map(quotes.map((q) => [q.id, q])), errors: new Map() };
}

const hanh: FetchedQuote = { id: 829, citekey: "hanh2007fidelity", locatorText: "chap. 4", concepts: [], text: HANH, kind: "quote" };
const russell: FetchedQuote = { id: 900, citekey: "russell2019human", locatorText: "chap. Lettuce", concepts: [], text: RUSSELL, kind: "quote" };

describe("quote text checks", () => {
  it("matches a wrapped block quote with citations and footnote refs removed, folding smart typography", async () => {
    const md = [
      "---",
      "title: t",
      "---",
      "",
      '<!-- quote 829 concepts="human-work:curiosity" -->',
      "> EACH OF US HAS A DEEP DESIRE TO know and understand the world",
      "> and to be known and understood in return. That is a deep natural",
      "> thirst. [@hanh2007fidelity, chap. 4][^n]",
      "",
      "[^n]: A note.",
    ].join("\n");
    const r = await checkQuotes(md, { lookup: lookupOf(hanh) });
    expect(r.checks).toHaveLength(1);
    expect(r.checks[0]).toMatchObject({ id: 829, line: 5, kind: "block", text: "matches", citekey: "matches", locator: "matches" });
    expect(r.issues).toEqual([]);
    expect(canonicalWords("It's \"so\" -- *very* ...")).toBe(canonicalWords("It’s “so” – very …"));
  });

  it("reports the first difference of a block quote with ~30 characters either side", async () => {
    const md = ["<!-- quote 829 -->", `> ${HANH.replace("natural thirst", "natural hunger")} [@hanh2007fidelity, chap. 4]`].join("\n");
    const r = await checkQuotes(md, { lookup: lookupOf(hanh) });
    const c = r.checks[0];
    expect(c.text).toBe("differs");
    expect(c.saved_at_difference).toContain("natural thirst");
    expect(c.draft_at_difference).toContain("natural hunger");
    expect(c.saved_at_difference!.length).toBeLessThanOrEqual(60);
    expect(r.issues.find((i) => i.code === "quote-text-differs")?.severity).toBe("error");
  });

  it("finds a run-in quote's saved words (minus closing punctuation) inside its paragraph", async () => {
    const ok = `<!-- quote 900 -->\nRussell warns that "${RUSSELL.slice(0, -1)}," and the rest follows [@russell2019human, chap. Lettuce].`;
    const r1 = await checkQuotes(ok, { lookup: lookupOf(russell) });
    expect(r1.checks[0]).toMatchObject({ kind: "run-in", text: "matches", citekey: "matches", locator: "matches" });

    const bad = `<!-- quote 900 -->\nRussell warns that "the problem is that we may suffer from value misalignment" [@russell2019human].`;
    const r2 = await checkQuotes(bad, { lookup: lookupOf(russell) });
    expect(r2.checks[0].text).toBe("differs");
    expect(r2.checks[0].locator).toBe("absent");
    expect(r2.checks[0].reason).toContain("word for word");
  });

  it("skips fence openers after the marker and takes an epigraph's citation from its attribution line", async () => {
    const md = ["<!-- quote 829 -->", "::: {.epigraph}", HANH, "", "— Thich Nhat Hanh [@hanh2007fidelity, chap. 4]", ":::"].join("\n");
    const r = await checkQuotes(md, { lookup: lookupOf(hanh) });
    expect(r.checks[0]).toMatchObject({ kind: "run-in", text: "matches", citekey: "matches", cited: { key: "hanh2007fidelity", locator: "chap. 4" } });
  });

  it("flags a wrong citekey as an error and a disagreeing locator as a warning", async () => {
    const wrongKey = `<!-- quote 829 -->\n> ${HANH} [@someone2001else, p. 3]`;
    const r1 = await checkQuotes(wrongKey, { lookup: lookupOf(hanh) });
    expect(r1.checks[0].citekey).toBe("differs");
    expect(r1.issues.find((i) => i.code === "quote-citekey-differs")?.severity).toBe("error");

    const loc = `<!-- quote 900 -->\nHe wrote "${RUSSELL}" [@russell2019human, "Lettuce"].`;
    const r2 = await checkQuotes(loc, { lookup: lookupOf(russell) });
    expect(r2.checks[0]).toMatchObject({ citekey: "matches", locator: "differs" });
    expect(r2.issues.find((i) => i.code === "quote-locator-differs")?.severity).toBe("warning");

    expect(locatorsAgree("p.44", "p. 44")).toBe(true);
    expect(locatorsAgree("page 44", "p. 44")).toBe(true);
    expect(locatorsAgree("chapter 4", "chap. 4")).toBe(true);
    expect(locatorsAgree("p. 44, emphasis added", "p. 44")).toBe(true);
    expect(locatorsAgree("p. 45", "p. 44")).toBe(false);
  });

  it("warns on block quotes without a marker and on citation-less or orphan markers", async () => {
    const md = ["> An unmarked quotation.", "", "<!-- quote 829 -->", `> ${HANH}`, "", "<!-- quote 829 -->", "", "```", "> code, not a quote", "```"].join("\n");
    const { unmarked } = scanQuotePassages(md);
    expect(unmarked).toEqual([{ line: 1, text: "An unmarked quotation." }]);
    const r = await checkQuotes(md, { lookup: lookupOf(hanh) });
    const codes = r.issues.map((i) => i.code);
    expect(codes).toContain("unmarked-block-quote");
    expect(codes).toContain("quote-citation-missing");
    expect(codes).toContain("quote-marker-orphan");
  });

  it("reports a note as a note, not a mismatch", async () => {
    const r = await checkQuotes("<!-- quote 5 -->\nMy own thought.", { lookup: lookupOf({ id: 5, concepts: [], kind: "note" }) });
    expect(r.checks[0].text).toBe("note");
    expect(r.issues.every((i) => i.severity === "info")).toBe(true);
  });

  it("says unchecked, with the reason, when quote-mcp is off or unreachable", async () => {
    const md = `<!-- quote 829 -->\n> ${HANH} [@hanh2007fidelity, chap. 4]`;
    const off = await checkQuotes(md, { env: { QUOTE_BASE: "off" } });
    expect(off.checks[0]).toMatchObject({ text: "unchecked", reason: expect.stringContaining("QUOTE_BASE=off") });
    expect(off.issues.find((i) => i.code === "quote-text-unchecked")?.severity).toBe("warning");

    const down = await checkQuotes(md, { env: { QUOTE_BASE: "http://127.0.0.1:9" } });
    expect(down.checks[0].text).toBe("unchecked");
    expect(down.unavailable).toMatch(/unreachable/);

    const legacy = await checkQuotes(`<!-- corpus:quote 12 -->\n> ${HANH}`, { lookup: lookupOf() });
    expect(legacy.checks[0].reason).toMatch(/corpus-mcp id/);
  });
});

describe("quote-mcp client and validate_markdown", () => {
  let server: http.Server;
  let base: string;

  beforeAll(async () => {
    server = http.createServer(async (req, res) => {
      const mcp = new McpServer({ name: "quote-stub", version: "0.0.0" });
      const work = { id: 1, title: "Fidelity", citekey: null, zotero_library: null, zotero_key: null };
      const reply = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v) }] });
      mcp.registerTool("get_quote", { inputSchema: { id: z.number() } }, ({ id }) =>
        id === 829
          ? reply({ id, kind: "quote", text: HANH, locator: "chap. 4", tags: [{ tag: "curiosity", concept: "curiosity" }], work })
          : { isError: true, content: [{ type: "text" as const, text: `No quote ${id}` }] },
      );
      // cite_quote resolves the citekey for a work not in Zotero yet (get_quote's work.citekey is null).
      mcp.registerTool("cite_quote", { inputSchema: { id: z.number() } }, ({ id }) =>
        reply({ kind: "quote", quote: HANH, citekey: "hanh2007fidelity", locator_text: "chap. 4" }),
      );
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => void transport.close());
      await mcp.connect(transport);
      await transport.handleRequest(req, res);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it("fetches text, citekey, and locator, and records unknown ids", async () => {
    const lookup = await fetchQuotes([829, 404], { QUOTE_BASE: base });
    expect(lookup.unavailable).toBeUndefined();
    expect(lookup.quotes.get(829)).toMatchObject({ text: HANH, citekey: "hanh2007fidelity", locatorText: "chap. 4", concepts: ["human-work:curiosity"] });
    expect(lookup.errors.get(404)).toContain("No quote 404");
  });

  it("adds quote checks to validate_markdown", async () => {
    const db = openDb(":memory:");
    try {
      const md = [`<!-- quote 829 -->`, `> ${HANH.replace("thirst", "hunger")} [@hanh2007fidelity, chap. 4]`, "", "<!-- quote 404 -->", "> Gone."].join("\n");
      const res = await validateMarkdownWithQuotes(db, { markdown: md }, { QUOTE_BASE: base });
      expect(res.valid).toBe(false);
      expect(res.quotes.checks.map((c) => c.text)).toEqual(["differs", "unchecked"]);
      expect(res.issues.map((i) => i.code)).toEqual(expect.arrayContaining(["quote-text-differs", "quote-text-unchecked"]));
    } finally {
      db.close();
    }
  });
});
