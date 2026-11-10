import { describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { getTerm } from "../src/queries.js";
import { readCursor, runTermSync, type TerminologyClient } from "../src/terminology.js";

describe("terminology-mcp subscriber sync for iasp", () => {
  it("bootstraps from state and applies incremental term and set changes", async () => {
    const db = openDb(":memory:");
    expect(readCursor(db)).toBeNull();

    const baseTerm = db.prepare("SELECT * FROM terms WHERE slug = 'insight'").get() as {
      id: string;
      slug: string;
    };

    const client: TerminologyClient = {
      baseUrl: "http://terminology-mcp.localdomain:8000",
      async state() {
        const raw = await import("../vocab/iasp-seed.json", { with: { type: "json" } });
        return {
          log: "log-1",
          version: 343,
          head: 343,
          terms: raw.default.terms as never,
          sets: raw.default.sets as never,
        };
      },
      async changes(since: number) {
        if (since === 343) {
          return {
            log: "log-1",
            version: 344,
            changes: [
              {
                n: 344,
                kind: "added",
                after: {
                  id: "t_custom_coda",
                  scheme: "iasp",
                  slug: "coda",
                  label: "coda",
                  notations: [{ value: "coda", datatype: "urn:iasp:datatype:pandoc-class" }],
                  scopeNote: "A concluding thematic passage.",
                  status: "provisional",
                  broader: [baseTerm.id],
                },
              },
            ],
          };
        }
        return { log: "log-1", version: 344, changes: [] };
      },
      async reportProgress() {
        return { ok: true };
      },
      async propose() {
        return { ok: true };
      },
    };

    const boot = await runTermSync({ db, client });
    expect(boot.outcome).toBe("bootstrapped");
    expect(boot.through).toBe(343);
    expect(readCursor(db)).toEqual({ log: "log-1", through: 343, blocked: null });

    const step = await runTermSync({ db, client });
    expect(step.outcome).toBe("applied");
    expect(step.through).toBe(344);

    const coda = getTerm(db, "coda");
    expect(coda).toMatchObject({
      id: "t_custom_coda",
      slug: "coda",
      status: "provisional",
      axis: "modifier",
    });
  });
});
