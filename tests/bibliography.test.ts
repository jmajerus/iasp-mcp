import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fetchBibliography } from "../src/bibliography.js";
import { detectToolchain, renderDocument } from "../src/render.js";

const hasPandoc = detectToolchain().pandoc.available;

const AUTHOR_BIB = `@book{foucault1977discipline,
  author = {Foucault, Michel},
  title = {Discipline and Punish (author's entry)},
  publisher = {Pantheon},
  year = {1977}
}
`;

/** Stubs of holdings-mcp's /api/bibliography and corpus-mcp's /api/csl, per the coordinator's contract. */
function stubServer(requests: string[]) {
  return http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://stub");
    requests.push(`${url.pathname}${url.search}`);
    const send = (status: number, body: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    if (url.pathname === "/api/bibliography") {
      const keys = (url.searchParams.get("citekeys") ?? "").split(",");
      return send(200, {
        items: keys.includes("roberts1993victory")
          ? [{ id: "roberts1993victory", type: "book", title: "Victory at Sea", author: [{ family: "Roberts", given: "Ann" }], issued: { "date-parts": [[1993]] } }]
          : [],
        unfiled: [
          ...(keys.includes("nye2011future") ? [{ citekey: "nye2011future", work: "calibre:u1", book_id: "main:42", calibre_uuid: "u1" }] : []),
          ...(keys.includes("doe2020uuid") ? [{ citekey: "doe2020uuid", work: "calibre:u2", book_id: null, calibre_uuid: "u2" }] : []),
          ...(keys.includes("twin2010copy") ? [{ citekey: "twin2010copy", work: "calibre:u3", book_id: "main:43", calibre_uuid: "u3" }] : []),
        ],
        ambiguous: keys.includes("smith2001twice") ? [{ citekey: "smith2001twice", candidates: ["zotero:users/1/A", "zotero:users/1/B"] }] : [],
        missing: keys.filter((k) => !["roberts1993victory", "nye2011future", "doe2020uuid", "smith2001twice", "twin2010copy"].includes(k)),
      });
    }
    if (url.pathname === "/api/csl") {
      const book = url.searchParams.get("book");
      if (book === "main:42") {
        return send(200, { warnings: ["proposed citekey"], item: { id: "calibre:u1", type: "book", title: "The Future of Power", author: [{ family: "Nye", given: "Joseph" }], issued: { "date-parts": [[2011]] } } });
      }
      if (book === "u2") return send(200, { item: { id: "doe2020uuid", type: "book", title: "By Uuid", author: [{ family: "Doe", given: "Jane" }] } });
      if (book === "main:43") return send(409, { error: "ambiguous", books: [1, 2] });
      return send(404, { error: "no-book" });
    }
    send(404, {});
  });
}

describe("server-built bibliography", () => {
  const requests: string[] = [];
  let server: http.Server;
  let env: NodeJS.ProcessEnv;

  beforeAll(async () => {
    server = stubServer(requests);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    env = { HOLDINGS_BASE: base, CORPUS_BASE: base };
  });

  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it("fetches only keys the author lacks and reports each key's source", async () => {
    requests.length = 0;
    const cited = ["foucault1977discipline", "roberts1993victory", "nye2011future", "doe2020uuid", "smith2001twice", "ghost2000none", "twin2010copy", "handle"];
    const { items, report } = await fetchBibliography(cited, {
      authorKeys: ["foucault1977discipline", "uncited2000"],
      required: new Set(cited.filter((k) => k !== "handle")),
      env,
    });
    expect(requests[0]).not.toContain("foucault1977discipline");
    expect(report.sources).toEqual({
      foucault1977discipline: "author",
      roberts1993victory: "zotero",
      nye2011future: "corpus",
      doe2020uuid: "corpus",
    });
    expect(items.map((i) => i.id).sort()).toEqual(["doe2020uuid", "nye2011future", "roberts1993victory"]);
    expect(requests).toContain("/api/csl?book=u2");
    expect(report.missing).toEqual(["ghost2000none", "smith2001twice", "twin2010copy"]); // a bare @handle is not required
    expect(report.ambiguous).toEqual([{ citekey: "smith2001twice", candidates: ["zotero:users/1/A", "zotero:users/1/B"] }]);
    expect(report.unfiled.map((u) => u.citekey).sort()).toEqual(["doe2020uuid", "nye2011future"]);
    const w = report.warnings.join("\n");
    expect(w).toContain("@nye2011future: not filed in Zotero yet");
    expect(w).toContain("@smith2001twice matches more than one work");
    expect(w).toContain("No bibliography entry for @ghost2000none");
    expect(w).toContain("@nye2011future (corpus-mcp): proposed citekey");
    expect(w).toContain("HTTP 409: ambiguous (2 books)");
  });

  it("warns, rather than failing, when holdings-mcp is off or unreachable", async () => {
    const off = await fetchBibliography(["a2000b"], { authorKeys: [], required: new Set(["a2000b"]), env: { HOLDINGS_BASE: "off" } });
    expect(off.report.warnings.join(" ")).toContain("HOLDINGS_BASE=off");
    const down = await fetchBibliography(["a2000b"], { authorKeys: [], required: new Set(["a2000b"]), env: { HOLDINGS_BASE: "http://127.0.0.1:9" } });
    expect(down.report.warnings.join(" ")).toMatch(/Could not fetch 1 bibliography entry/);
    expect(down.report.missing).toEqual(["a2000b"]);
  });

  it.skipIf(!hasPandoc)("renders citations from author, Zotero, and Calibre entries together, the author's winning", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "iasp-bib-"));
    try {
      const res = await renderDocument({
        markdown: "# T\n\nOne [@foucault1977discipline, 3]. Two [@roberts1993victory]. Three [@nye2011future, p. 9].\n\n## References\n",
        bibtexContent: AUTHOR_BIB,
        formats: ["md"],
        outputDir: outDir,
        returnContent: true,
        env,
      });
      expect(res.bibliography?.sources).toEqual({ foucault1977discipline: "author", roberts1993victory: "zotero", nye2011future: "corpus" });
      const md = res.artifacts[0].content!;
      expect(md).toMatch(/Discipline and Punish \(Author.s Entry\)/);
      expect(md).toContain("Victory at Sea");
      expect(md).toContain("The Future of Power");
      expect(md).not.toContain("[@");
      expect(res.artifacts[0].warnings.join(" ")).not.toMatch(/not found/);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });
});
