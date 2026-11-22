import http from "node:http";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { openDb } from "../src/db.js";
import { type FetchedQuote, type QuoteLookup, fetchQuotes } from "../src/provenance.js";
import { type SameWorkResolver, holdingsSameWork, pairKey } from "../src/citekey-aliases.js";
import { canonicalWords, checkQuotes, excerptOf, locatorsAgree, quoteWords, scanQuotePassages, validateMarkdownWithQuotes } from "../src/quote-check.js";

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

  it("removes narrative citations but keeps emails before comparing", async () => {
    const md = ["<!-- quote 829 -->", `> ${HANH} @hanh2007fidelity [chap. 4]`].join("\n");
    const r = await checkQuotes(md, { lookup: lookupOf(hanh) });
    expect(r.checks[0]).toMatchObject({ text: "matches", citekey: "matches", locator: "matches" });
    expect(quoteWords("Write to me@example.org as @smith2001x said.")).toBe("Write to me@example.org as said.");
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

  it("reports an unchanged part of the saved quote as an excerpt warning, contiguous or elided", async () => {
    const tail = `<!-- quote 829 -->\n> That is a deep natural thirst. [@hanh2007fidelity, chap. 4]`;
    const r1 = await checkQuotes(tail, { lookup: lookupOf(hanh) });
    expect(r1.checks[0]).toMatchObject({ text: "excerpt", excerpt: "contiguous" });
    expect(r1.checks[0].pieces).toBeUndefined();
    expect(r1.issues.map((i) => [i.severity, i.code])).toEqual([["warning", "quote-text-excerpt"]]);

    const elided = `<!-- quote 829 -->\n> EACH OF US HAS A DEEP DESIRE TO know and understand the world … That is a deep natural [...] thirst. [@hanh2007fidelity, chap. 4]`;
    const r2 = await checkQuotes(elided, { lookup: lookupOf(hanh) });
    expect(r2.checks[0]).toMatchObject({ text: "excerpt", excerpt: "elided", pieces: 3 });

    // Out of order, or a changed word inside a piece, is still an error.
    expect(excerptOf("natural thirst … EACH OF US", canonicalWords(HANH))).toBeNull();
    const changed = `<!-- quote 829 -->\n> That is a deep natural hunger. [@hanh2007fidelity, chap. 4]`;
    expect((await checkQuotes(changed, { lookup: lookupOf(hanh) })).checks[0].text).toBe("differs");

    // An ellipsis the saved text itself contains matches literally first.
    const savedEllipsis: FetchedQuote = { ...hanh, text: "Disciplinary power...is exercised through its invisibility." };
    const lit = `<!-- quote 829 -->\n> Disciplinary power…is exercised through its invisibility. [@hanh2007fidelity, chap. 4]`;
    expect((await checkQuotes(lit, { lookup: lookupOf(savedEllipsis) })).checks[0].text).toBe("matches");
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

  it("reports a run-in that quotes an unchanged part of the saved words as an excerpt warning", async () => {
    const part = `<!-- quote 829 -->\nHanh names "a deep desire to know and understand the world," and moves on [@hanh2007fidelity, chap. 4].`;
    const lower: FetchedQuote = { ...hanh, text: HANH.replace("EACH OF US HAS A DEEP DESIRE TO", "Each of us has a deep desire to") };
    const r1 = await checkQuotes(part, { lookup: lookupOf(lower) });
    expect(r1.checks[0]).toMatchObject({ kind: "run-in", text: "excerpt", excerpt: "contiguous", citekey: "matches" });
    expect(r1.issues.map((i) => [i.severity, i.code])).toEqual([["warning", "quote-text-excerpt"]]);

    const elided = `<!-- quote 829 -->\nShe writes of "a deep desire to know … a deep natural thirst" [@hanh2007fidelity, chap. 4].`;
    expect((await checkQuotes(elided, { lookup: lookupOf(lower) })).checks[0]).toMatchObject({ text: "excerpt", excerpt: "elided", pieces: 2 });

    // A changed word, or a span too short to say which words it quotes, is still an error.
    const changed = `<!-- quote 829 -->\nHanh names "a deep wish to know and understand the world" [@hanh2007fidelity, chap. 4].`;
    expect((await checkQuotes(changed, { lookup: lookupOf(lower) })).checks[0].text).toBe("differs");
    const slight = `<!-- quote 829 -->\nHanh calls it "natural thirst" [@hanh2007fidelity, chap. 4].`;
    expect((await checkQuotes(slight, { lookup: lookupOf(lower) })).checks[0].text).toBe("differs");
  });

  it("checks markers on consecutive lines against the one paragraph after them", async () => {
    const a: FetchedQuote = { id: 891, citekey: "collet2018zero", locatorText: "p. 102", concepts: [], text: "are said to date back to around 4500 B.C.E.", kind: "quote" };
    const b: FetchedQuote = { id: 892, citekey: "collet2018zero", locatorText: "p. 113", concepts: [], text: "having become literally blind", kind: "quote" };
    const md = [
      "<!-- quote 891 -->",
      "<!-- quote 892 -->",
      'The results "are said to date back to around 4500 B.C.E." [@collet2018zero, p. 102]. Dante appears',
      'as "having become literally blind" [@collet2018zero, p. 113].',
    ].join("\n");
    const r = await checkQuotes(md, { lookup: lookupOf(a, b) });
    expect(r.checks.map((c) => [c.id, c.line, c.kind, c.text, c.citekey, c.locator])).toEqual([
      [891, 1, "run-in", "matches", "matches", "matches"],
      [892, 2, "run-in", "matches", "matches", "matches"],
    ]);
    expect(r.checks[1].cited).toEqual({ key: "collet2018zero", locator: "p. 113" });
    expect(r.issues).toEqual([]);
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

    const loc = `<!-- quote 900 -->\nHe wrote "${RUSSELL}" [@russell2019human, chap. Kale].`;
    const r2 = await checkQuotes(loc, { lookup: lookupOf(russell) });
    expect(r2.checks[0]).toMatchObject({ citekey: "matches", locator: "differs" });
    expect(r2.issues.find((i) => i.code === "quote-locator-differs")?.severity).toBe("warning");

    expect(locatorsAgree("p.44", "p. 44")).toBe(true);
    expect(locatorsAgree("page 44", "p. 44")).toBe(true);
    expect(locatorsAgree("chapter 4", "chap. 4")).toBe(true);
    expect(locatorsAgree("p. 44, emphasis added", "p. 44")).toBe(true);
    expect(locatorsAgree("p. 45", "p. 44")).toBe(false);
    // A quoted title is that chapter; bk. / book N is chap. BOOK N; a leading italic work title is ignored.
    expect(locatorsAgree('"A Spark Neglected Burns the House"', "chap. A Spark Neglected Burns the House")).toBe(true);
    expect(locatorsAgree("“Lettuce”", "chap. Lettuce")).toBe(true);
    expect(locatorsAgree("*Iliad* bk. XXIV", "chap. BOOK XXIV")).toBe(true);
    expect(locatorsAgree("book XXIV", "chap. BOOK XXIV")).toBe(true);
    expect(locatorsAgree('"On Violence," pt. III', "chap. III")).toBe(false);
    expect(locatorsAgree("chap. 7", "chap. What Prevents Us from Being Happy?")).toBe(false);
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

    const malformed = await checkQuotes(md, { env: { QUOTE_BASE: "not a url" } });
    expect(malformed.checks[0]).toMatchObject({ text: "unchecked", reason: expect.stringContaining("not a valid URL") });

    const legacy = await checkQuotes(`<!-- corpus:quote 12 -->\n> ${HANH}`, { lookup: lookupOf() });
    expect(legacy.checks[0].reason).toMatch(/corpus-mcp id/);
  });
});

describe("former citekeys", () => {
  // Better BibTeX renamed the key when the year was corrected; holdings-mcp knows both name one work.
  const collet: FetchedQuote = { id: 884, citekey: "collet2014zero", locatorText: "p. 241", concepts: [], text: "found that balance", kind: "quote" };
  const sameAs = (...pairs: [string, string][]): SameWorkResolver => async () => ({ same: new Set(pairs.map(([a, b]) => pairKey(a, b))) });
  const md = `<!-- quote 884 -->\nHe "found that balance" [@collet2018zero, p. 241].`;

  it("reports a former key of the same work as a warning that names the current key", async () => {
    const r = await checkQuotes(md, { lookup: lookupOf(collet), sameWork: sameAs(["collet2018zero", "collet2014zero"]) });
    expect(r.checks[0]).toMatchObject({ citekey: "former", locator: "matches", cited: { key: "collet2018zero", locator: "p. 241" } });
    expect(r.issues.map((i) => [i.severity, i.code])).toEqual([["warning", "quote-citekey-former"]]);
    expect(r.issues[0].suggestion).toBe("Cite it as [@collet2014zero, p. 241].");
  });

  it("keeps the error for another work's key, and says when holdings-mcp could not be asked", async () => {
    const other = await checkQuotes(md, { lookup: lookupOf(collet), sameWork: sameAs() });
    expect(other.checks[0].citekey).toBe("differs");
    expect(other.issues[0]).toMatchObject({ severity: "error", code: "quote-citekey-differs" });

    const off = await checkQuotes(md, { lookup: lookupOf(collet) }); // HOLDINGS_BASE=off in tests
    expect(off.issues[0].severity).toBe("error");
    expect(off.issues[0].message).toContain("not checked as a former key of the same work: holdings lookup is off");
  });

  it("asks holdings-mcp's get_work which work each key names", async () => {
    const works: Record<string, unknown> = {
      collet2018zero: { key: "zotero:users/1/W7SF3AIQ", citekey: "collet2014zero" },
      collet2014zero: { key: "zotero:users/1/W7SF3AIQ", citekey: "collet2014zero" },
      smith2001x: { key: "zotero:users/1/OTHER123", citekey: "smith2001x" },
      shared: { note: "two works", works: [{ key: "a" }, { key: "b" }] },
    };
    const server = http.createServer(async (req, res) => {
      const mcp = new McpServer({ name: "holdings-stub", version: "0.0.0" });
      mcp.registerTool("get_work", { inputSchema: { key: z.string() } }, ({ key }) =>
        works[key]
          ? { content: [{ type: "text" as const, text: JSON.stringify(works[key]) }] }
          : { isError: true, content: [{ type: "text" as const, text: `No work has the key "${key}".` }] },
      );
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => void transport.close());
      await mcp.connect(transport);
      await transport.handleRequest(req, res);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const resolve = holdingsSameWork({ HOLDINGS_BASE: base });
      const r = await resolve([
        ["collet2018zero", "collet2014zero"],
        ["smith2001x", "collet2014zero"],
        ["shared", "collet2014zero"],
        ["nobody", "collet2014zero"],
      ]);
      expect([...r.same]).toEqual([pairKey("collet2018zero", "collet2014zero")]);
      expect(r.unavailable).toBeUndefined();
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
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
