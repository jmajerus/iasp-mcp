import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { holdingsBaseFromEnv } from "./bibliography.js";

/**
 * Whether two citekeys name the same work, from holdings-mcp's get_work. A work keeps its former keys
 * when Better BibTeX renames it (a corrected year, say), so a draft that cites the old key still names
 * the right book: a stale key to update, not a wrong source.
 */

/** A cited key and the key quote-mcp has for the quote. */
export type KeyPair = readonly [cited: string, saved: string];

export interface SameWorkResult {
  /** `pairKey(cited, saved)` for each pair that names one work. */
  same: Set<string>;
  /** Set when holdings-mcp could not be asked, so no pair could be matched. */
  unavailable?: string;
}

export type SameWorkResolver = (pairs: KeyPair[]) => Promise<SameWorkResult>;

export const pairKey = (cited: string, saved: string) => `${cited.toLowerCase()}\u0000${saved.toLowerCase()}`;

function workKeyOf(res: unknown): string | undefined {
  const r = res as { content?: { type: string; text?: string }[]; isError?: boolean };
  if (r.isError) return undefined;
  const text = r.content?.find((c) => c.type === "text")?.text;
  if (!text) return undefined;
  try {
    // A key two works share comes back as { works: [...] }: no single work, so no match.
    const data = JSON.parse(text) as { key?: unknown; works?: unknown };
    return typeof data.key === "string" ? data.key : undefined;
  } catch {
    return undefined;
  }
}

/** Ask holdings-mcp (get_work) which work each key names; a pair names one work when both resolve to the same work key. */
export function holdingsSameWork(env: NodeJS.ProcessEnv = process.env, timeoutMs = 5000): SameWorkResolver {
  return async (pairs) => {
    const same = new Set<string>();
    if (!pairs.length) return { same };
    const base = holdingsBaseFromEnv(env);
    if (!base) return { same, unavailable: "holdings lookup is off (HOLDINGS_BASE=off)" };

    const client = new Client({ name: "iasp-mcp-citekeys", version: "0.1.0" });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { signal: AbortSignal.timeout(timeoutMs) } }));
    } catch (error) {
      await client.close().catch(() => {});
      return { same, unavailable: `holdings-mcp at ${base} is unreachable (${error instanceof Error ? error.message : String(error)})` };
    }
    try {
      const works = new Map<string, string | undefined>();
      const workOf = async (citekey: string) => {
        const k = citekey.toLowerCase();
        if (!works.has(k)) {
          try {
            works.set(k, workKeyOf(await client.callTool({ name: "get_work", arguments: { key: citekey } })));
          } catch {
            works.set(k, undefined);
          }
        }
        return works.get(k);
      };
      for (const [cited, saved] of pairs) {
        const a = await workOf(cited);
        if (a && a === (await workOf(saved))) same.add(pairKey(cited, saved));
      }
      return { same };
    } finally {
      await client.close().catch(() => {});
    }
  };
}
