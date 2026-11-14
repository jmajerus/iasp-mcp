import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { extname } from "node:path";

/**
 * Fills in bibliography entries the author did not supply.
 *
 * Keys cited in the document but absent from `bibtex_content` / `bibliography` are asked of
 * holdings-mcp (`/api/bibliography`): works filed in Zotero come back as CSL JSON items; Calibre
 * books not yet in Zotero come back as `unfiled`, and corpus-mcp (`/api/csl?book=`) supplies their
 * CSL JSON. Entries the author passed always win: only keys missing from them are fetched.
 */

export const DEFAULT_HOLDINGS_BASE = "http://holdings-mcp.localdomain:8000";
export const DEFAULT_CORPUS_BASE = "http://corpus-mcp.localdomain:8000";

export type EntrySource = "author" | "zotero" | "corpus";

export type CslItem = { id: string; [field: string]: unknown };

export interface BibliographyReport {
  /** Where each cited key's entry came from. Keys with no entry are in `missing`. */
  sources: Record<string, EntrySource>;
  /** Cited keys (in bracketed citations) no source had. */
  missing: string[];
  /** Keys holdings-mcp matched to more than one work. */
  ambiguous: { citekey: string; candidates: string[] }[];
  /** Keys resolved from a Calibre book that is not filed in Zotero yet. */
  unfiled: { citekey: string; book_id: string | null; calibre_uuid?: string }[];
  warnings: string[];
}

export interface FetchedBibliography {
  items: CslItem[];
  report: BibliographyReport;
}

interface HoldingsReply {
  items?: CslItem[];
  unfiled?: { citekey: string; work?: string; book_id: string | null; calibre_uuid?: string | null }[];
  ambiguous?: { citekey: string; candidates: string[] }[];
  missing?: string[];
}

function baseFromEnv(value: string | undefined, fallback: string): string | null {
  const raw = value?.trim() ?? "";
  if (raw.toLowerCase() === "off") return null;
  return (raw || fallback).replace(/\/+$/, "");
}

export function holdingsBaseFromEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  return baseFromEnv(env.HOLDINGS_BASE, DEFAULT_HOLDINGS_BASE);
}

export function corpusBaseFromEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  return baseFromEnv(env.CORPUS_BASE, DEFAULT_CORPUS_BASE);
}

/** Keys of BibTeX / BibLaTeX source text. */
export function bibtexKeys(text: string): Set<string> {
  return new Set([...text.matchAll(/@\w+\s*\{\s*([^,\s]+)\s*,/g)].map((m) => m[1]));
}

/**
 * Keys a bibliography file defines, or null when they cannot be read (then nothing is fetched,
 * so a server entry can never shadow the author's).
 */
export function bibliographyFileKeys(path: string): Set<string> | null {
  try {
    const ext = extname(path).toLowerCase();
    const text = readFileSync(path, "utf8");
    if (ext === ".bib" || ext === ".bibtex" || ext === ".biblatex") return bibtexKeys(text);
    if (ext === ".json") {
      const data = JSON.parse(text) as CslItem[] | { items?: CslItem[] };
      const items = Array.isArray(data) ? data : (data.items ?? []);
      return new Set(items.map((i) => String(i.id)));
    }
    const res = spawnSync("pandoc", [path, "-s", "-t", "csljson"], { encoding: "utf8", timeout: 30_000 });
    if (res.error || res.status !== 0) return null;
    return new Set((JSON.parse(res.stdout) as CslItem[]).map((i) => String(i.id)));
  } catch {
    return null;
  }
}

async function getJson<T>(url: string, timeoutMs: number): Promise<T> {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: "application/json" } });
  if (!res.ok) {
    let detail = "";
    try {
      const body = (await res.json()) as { error?: string; books?: unknown[] };
      if (body.error) detail = `: ${body.error}${Array.isArray(body.books) ? ` (${body.books.length} books)` : ""}`;
    } catch {
      // no JSON body
    }
    throw new Error(`HTTP ${res.status}${detail}`);
  }
  return (await res.json()) as T;
}

function reason(error: unknown): string {
  return error instanceof Error ? (error.cause instanceof Error ? `${error.message}: ${error.cause.message}` : error.message) : String(error);
}

/**
 * Fetch entries for the `wanted` (cited) keys the author's bibliography lacks. `required` are the keys whose
 * absence is worth a warning (those in bracketed citations; a bare `@word` may be prose).
 */
export async function fetchBibliography(
  wanted: string[],
  options: { authorKeys: Iterable<string>; required: Set<string>; env?: NodeJS.ProcessEnv; timeoutMs?: number },
): Promise<FetchedBibliography> {
  const env = options.env ?? process.env;
  const timeoutMs = options.timeoutMs ?? 8000;
  const sources: Record<string, EntrySource> = {};
  const author = new Set(options.authorKeys);
  const cited = [...new Set(wanted)].sort();
  for (const k of cited) if (author.has(k)) sources[k] = "author";
  const report: BibliographyReport = { sources, missing: [], ambiguous: [], unfiled: [], warnings: [] };
  const items: CslItem[] = [];
  const keys = cited.filter((k) => !author.has(k));
  const finish = () => {
    report.missing = keys.filter((k) => !(k in sources) && options.required.has(k));
    if (report.missing.length) {
      report.warnings.unshift(`No bibliography entry for ${report.missing.map((k) => `@${k}`).join(", ")}: not in the bibliography passed, Zotero, or the Calibre libraries.`);
    }
    return { items, report };
  };
  if (!keys.length) return finish();

  const holdings = holdingsBaseFromEnv(env);
  if (!holdings) {
    const required = keys.filter((k) => options.required.has(k));
    if (required.length) report.warnings.push(`Bibliography lookup is off (HOLDINGS_BASE=off); ${required.length} cited key(s) were not fetched.`);
    return finish();
  }

  let reply: HoldingsReply;
  try {
    reply = await getJson<HoldingsReply>(`${holdings}/api/bibliography?citekeys=${keys.map(encodeURIComponent).join(",")}`, timeoutMs);
  } catch (error) {
    report.warnings.push(`Could not fetch ${keys.length} bibliography entr${keys.length === 1 ? "y" : "ies"} from holdings-mcp at ${holdings} (${reason(error)}).`);
    return finish();
  }

  const wantedSet = new Set(keys);
  for (const item of reply.items ?? []) {
    const id = String(item.id);
    if (!wantedSet.has(id) || id in sources) continue;
    items.push({ ...item, id });
    sources[id] = "zotero";
  }

  for (const a of reply.ambiguous ?? []) {
    if (!wantedSet.has(a.citekey)) continue;
    report.ambiguous.push({ citekey: a.citekey, candidates: a.candidates ?? [] });
    report.warnings.push(
      `@${a.citekey} matches more than one work (${(a.candidates ?? []).join(", ")}); no entry was added. Give the edition its own citekey, or pass its entry in bibtex_content.`,
    );
  }

  const unfiled = (reply.unfiled ?? []).filter((u) => wantedSet.has(u.citekey) && !(u.citekey in sources));
  if (unfiled.length) {
    const corpus = corpusBaseFromEnv(env);
    if (!corpus) {
      report.warnings.push(`${unfiled.length} key(s) are Calibre books not filed in Zotero, but CORPUS_BASE=off: ${unfiled.map((u) => `@${u.citekey}`).join(", ")}.`);
    } else {
      const fetched = await Promise.all(
        unfiled.map(async (u) => {
          try {
            // corpus-mcp's `book` takes a book id, Calibre UUID, or citekey; book_id can be null.
            const book = u.book_id || u.calibre_uuid;
            if (!book) return { u, error: "holdings-mcp gave neither book_id nor calibre_uuid" };
            const r = await getJson<{ item?: CslItem; warnings?: string[] }>(`${corpus}/api/csl?book=${encodeURIComponent(book)}`, timeoutMs);
            return { u, item: r.item, warnings: r.warnings ?? [] };
          } catch (error) {
            return { u, error: reason(error) };
          }
        }),
      );
      for (const f of fetched) {
        if (!f.item) {
          report.warnings.push(`@${f.u.citekey} is Calibre book ${f.u.book_id ?? f.u.calibre_uuid}, but corpus-mcp gave no CSL entry for it (${f.error ?? "empty reply"}).`);
          continue;
        }
        // corpus-mcp's item.id may be another key (Calibre's, or calibre:<uuid>): cite it by the key the document uses.
        items.push({ ...f.item, id: f.u.citekey });
        for (const w of f.warnings ?? []) report.warnings.push(`@${f.u.citekey} (corpus-mcp): ${w}`);
        sources[f.u.citekey] = "corpus";
        report.unfiled.push({ citekey: f.u.citekey, book_id: f.u.book_id ?? null, ...(f.u.calibre_uuid ? { calibre_uuid: f.u.calibre_uuid } : {}) });
        report.warnings.push(`@${f.u.citekey}: not filed in Zotero yet; cited from Calibre book ${f.u.book_id ?? f.u.calibre_uuid}.`);
      }
    }
  }

  return finish();
}
