import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { extractFrontmatter, parseFenceHeader } from "./ghost.js";
import { DEFAULT_TERMINOLOGY_BASE, terminologyConfig } from "./terminology.js";

export const DEFAULT_QUOTE_BASE = "http://quote-mcp.localdomain:8000";

export interface ExternalConceptRef {
  raw: string;
  scheme: string;
  slug: string;
  label?: string;
  id?: string;
  uri: string;
  publicUrl: string;
  status?: string;
}

export interface QuoteProvenance {
  id: number;
  citekey?: string;
  workKey?: string;
  workTitle?: string;
  locator?: string;
  concepts: string[];
}

export interface ProvenanceManifest {
  quotes: Record<string, QuoteProvenance>;
  concepts: Record<string, ExternalConceptRef>;
}

const KNOWN_SCHEME_URNS: Record<string, string> = {
  "human-work": "urn:quote-mcp:concept:human-work:",
  iasp: "urn:iasp:concept:",
  "cc-subjects": "urn:concept-clusters:subject:",
};

export function parseConceptToken(token: string, defaultScheme = "human-work"): { scheme: string; slug: string; raw: string } | null {
  const cleaned = token.trim().replace(/^[,;]+|[,;]+$/g, "");
  if (!cleaned) return null;
  const colonIdx = cleaned.indexOf(":");
  if (colonIdx > 0) {
    const scheme = cleaned.slice(0, colonIdx).trim().toLowerCase();
    const slug = cleaned
      .slice(colonIdx + 1)
      .trim()
      .toLowerCase()
      .replace(/\s+/g, "-");
    if (!scheme || !slug) return null;
    return { scheme, slug, raw: `${scheme}:${slug}` };
  }
  const slug = cleaned.toLowerCase().replace(/\s+/g, "-");
  return { scheme: defaultScheme, slug, raw: `${defaultScheme}:${slug}` };
}

export function splitConceptList(raw: string | undefined, defaultScheme = "human-work"): { scheme: string; slug: string; raw: string }[] {
  if (!raw) return [];
  const results: { scheme: string; slug: string; raw: string }[] = [];
  const seen = new Set<string>();
  for (const part of raw.split(/[\s,;]+/)) {
    const parsed = parseConceptToken(part, defaultScheme);
    if (parsed && !seen.has(parsed.raw)) {
      seen.add(parsed.raw);
      results.push(parsed);
    }
  }
  return results;
}

export function defaultConceptRef(scheme: string, slug: string): ExternalConceptRef {
  const urnPrefix = KNOWN_SCHEME_URNS[scheme] ?? `urn:terminology-mcp:concept:${scheme}:`;
  return {
    raw: `${scheme}:${slug}`,
    scheme,
    slug,
    uri: `${urnPrefix}${slug}`,
    publicUrl: `https://vocabulary.majerus.us/api/schemes/${encodeURIComponent(scheme)}/slugs/${encodeURIComponent(slug)}`,
  };
}

export interface ParsedQuoteMarker {
  id: number;
  concepts: string[];
  citekey?: string;
  workKey?: string;
  locator?: string;
}

const QUOTE_MARKER_RE = /^<!--\s*(?:corpus:)?quote\s+(\d+)(?:\s+([\s\S]*?))?\s*-->$/;

export function parseQuoteMarkerComment(line: string): ParsedQuoteMarker | null {
  const m = QUOTE_MARKER_RE.exec(line.trim());
  if (!m) return null;
  const id = Number(m[1]);
  if (!Number.isSafeInteger(id) || id <= 0) return null;

  const rest = m[2]?.trim() ?? "";
  const concepts: string[] = [];
  let citekey: string | undefined;
  let workKey: string | undefined;
  let locator: string | undefined;

  if (rest) {
    const attrRe = /([\w-]+)=(?:"([^"]*)"|'([^']*)'|(\S+))/g;
    for (const am of rest.matchAll(attrRe)) {
      const key = am[1].toLowerCase();
      const val = am[2] ?? am[3] ?? am[4] ?? "";
      if (key === "concepts" || key === "concept" || key === "data-concepts") {
        for (const c of splitConceptList(val)) {
          if (!concepts.includes(c.raw)) concepts.push(c.raw);
        }
      } else if (key === "citekey" || key === "data-citekey") {
        citekey = val;
      } else if (key === "work" || key === "work-key" || key === "data-work-key") {
        workKey = val;
      } else if (key === "locator" || key === "data-locator") {
        locator = val;
      }
    }
  }

  return {
    id,
    concepts,
    ...(citekey ? { citekey } : {}),
    ...(workKey ? { workKey } : {}),
    ...(locator ? { locator } : {}),
  };
}

export function scanMarkdownProvenanceSeeds(markdown: string): {
  quoteMarkers: Map<number, ParsedQuoteMarker>;
  conceptKeys: Set<string>;
} {
  const { bodyLines } = extractFrontmatter(markdown);
  const quoteMarkers = new Map<number, ParsedQuoteMarker>();
  const conceptKeys = new Set<string>();

  for (const line of bodyLines) {
    const qm = parseQuoteMarkerComment(line);
    if (qm) {
      const existing = quoteMarkers.get(qm.id);
      const mergedConcepts = [...new Set([...(existing?.concepts ?? []), ...qm.concepts])];
      quoteMarkers.set(qm.id, {
        id: qm.id,
        concepts: mergedConcepts,
        citekey: qm.citekey ?? existing?.citekey,
        workKey: qm.workKey ?? existing?.workKey,
        locator: qm.locator ?? existing?.locator,
      });
      for (const c of mergedConcepts) conceptKeys.add(c);
      continue;
    }

    const fence = parseFenceHeader(line);
    if (fence) {
      const rawConcepts = fence.attrs.concepts ?? fence.attrs.concept ?? fence.attrs["data-concepts"];
      for (const c of splitConceptList(rawConcepts)) {
        conceptKeys.add(c.raw);
      }
    }
  }

  return { quoteMarkers, conceptKeys };
}

/** A quote as quote-mcp has it: provenance plus the saved words and the citation cite_quote builds. */
export interface FetchedQuote extends QuoteProvenance {
  /** "quote" or "note" (a note has no quoted words). */
  kind?: string;
  /** The saved words (get_quote's `text`, which is exactly cite_quote's `quote`). */
  text?: string;
  /** cite_quote's Pandoc locator, e.g. "p. 44" or "chap. 4" (falls back to get_quote's locator). */
  locatorText?: string;
}

export interface QuoteLookup {
  quotes: Map<number, FetchedQuote>;
  /** Set when quote-mcp could not be asked at all (disabled or unreachable). */
  unavailable?: string;
  /** Per-quote failures (e.g. an unknown id). */
  errors: Map<number, string>;
}

export function quoteBaseFromEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.QUOTE_BASE?.trim() ?? "";
  return raw.toLowerCase() === "off" ? null : raw || DEFAULT_QUOTE_BASE;
}

function toolText(res: unknown): { text?: string; isError: boolean } {
  const r = res as { content?: { type: string; text?: string }[]; isError?: boolean };
  return { text: r.content?.find((c) => c.type === "text")?.text, isError: Boolean(r.isError) };
}

/** Look quotes up in quote-mcp (get_quote for tags and work, cite_quote for the words and citation). */
export async function fetchQuotes(
  quoteIds: number[],
  env: NodeJS.ProcessEnv = process.env,
  timeoutMs = 5000,
): Promise<QuoteLookup> {
  const quotes = new Map<number, FetchedQuote>();
  const errors = new Map<number, string>();
  if (!quoteIds.length) return { quotes, errors };
  const quoteBase = quoteBaseFromEnv(env);
  if (!quoteBase) return { quotes, errors, unavailable: "quote lookup is disabled (QUOTE_BASE=off)" };

  const client = new Client({ name: "iasp-mcp-provenance", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${quoteBase.replace(/\/+$/, "")}/mcp`), {
    requestInit: { signal: AbortSignal.timeout(timeoutMs) },
  });

  try {
    await client.connect(transport);
  } catch (error) {
    await client.close().catch(() => {});
    return {
      quotes,
      errors,
      unavailable: `quote-mcp at ${quoteBase} is unreachable (${error instanceof Error ? error.message : String(error)})`,
    };
  }

  try {
    for (const id of quoteIds) {
      try {
        const got = toolText(await client.callTool({ name: "get_quote", arguments: { id } }));
        if (got.isError || !got.text) {
          errors.set(id, got.text?.trim() || "get_quote returned nothing");
          continue;
        }
        const data = JSON.parse(got.text) as {
          id?: number;
          kind?: string;
          text?: string | null;
          locator?: string | null;
          tags?: { tag?: string; concept?: string | null }[];
          work?: {
            citekey?: string | null;
            title?: string | null;
            zotero_library?: string | null;
            zotero_key?: string | null;
            id?: number;
          };
        };
        let cite: { quote?: string | null; citekey?: string | null; locator_text?: string | null } = {};
        try {
          const c = toolText(await client.callTool({ name: "cite_quote", arguments: { id } }));
          if (!c.isError && c.text) cite = JSON.parse(c.text);
        } catch {
          // A note or an uncitable work: fall back to get_quote's fields.
        }
        const concepts: string[] = [];
        for (const t of data.tags ?? []) {
          if (t.concept) {
            const c = parseConceptToken(t.concept, "human-work");
            if (c && !concepts.includes(c.raw)) concepts.push(c.raw);
          }
        }
        const workKey =
          data.work?.zotero_library && data.work?.zotero_key
            ? `zotero:${data.work.zotero_library}/${data.work.zotero_key}`
            : data.work?.id
              ? `quote:${data.work.id}`
              : undefined;
        const citekey = cite.citekey || data.work?.citekey || undefined;
        const text = data.kind === "note" ? undefined : (data.text ?? cite.quote ?? undefined);
        const locatorText = cite.locator_text || data.locator || undefined;
        quotes.set(id, {
          id,
          ...(citekey ? { citekey } : {}),
          ...(workKey ? { workKey } : {}),
          ...(data.work?.title ? { workTitle: data.work.title } : {}),
          ...(data.locator ? { locator: data.locator } : {}),
          concepts,
          ...(data.kind ? { kind: data.kind } : {}),
          ...(text ? { text } : {}),
          ...(locatorText ? { locatorText } : {}),
        });
      } catch (error) {
        errors.set(id, error instanceof Error ? error.message : String(error));
      }
    }
  } finally {
    await client.close().catch(() => {});
  }
  return { quotes, errors };
}

async function resolveTermFromTerminology(
  terminologyBaseUrl: string,
  scheme: string,
  slug: string,
  timeoutMs = 2500,
): Promise<ExternalConceptRef> {
  const fallback = defaultConceptRef(scheme, slug);
  try {
    const res = await fetch(
      `${terminologyBaseUrl.replace(/\/+$/, "")}/api/schemes/${encodeURIComponent(scheme)}/slugs/${encodeURIComponent(slug)}`,
      { signal: AbortSignal.timeout(timeoutMs) },
    );
    if (!res.ok) return fallback;
    const body = (await res.json()) as {
      term?: {
        id?: string;
        slug?: string;
        label?: string;
        sourceUri?: string | null;
        status?: string;
      };
    };
    const term = body.term;
    if (!term) return fallback;
    const resolvedSlug = term.slug ?? slug;
    const uri = term.sourceUri || (term.id ? `urn:terminology-mcp:term:${term.id}` : fallback.uri);
    return {
      raw: `${scheme}:${resolvedSlug}`,
      scheme,
      slug: resolvedSlug,
      ...(term.label ? { label: term.label } : {}),
      ...(term.id ? { id: term.id } : {}),
      uri,
      publicUrl: `https://vocabulary.majerus.us/api/schemes/${encodeURIComponent(scheme)}/slugs/${encodeURIComponent(resolvedSlug)}`,
      ...(term.status ? { status: term.status } : {}),
    };
  } catch {
    return fallback;
  }
}

export async function buildProvenanceManifest(
  markdown: string,
  env: NodeJS.ProcessEnv = process.env,
  lookup?: QuoteLookup,
): Promise<ProvenanceManifest> {
  const { quoteMarkers, conceptKeys } = scanMarkdownProvenanceSeeds(markdown);
  const quotes: Record<string, QuoteProvenance> = {};
  const concepts: Record<string, ExternalConceptRef> = {};

  const fetchedQuotes = (lookup ?? (await fetchQuotes([...quoteMarkers.keys()], env))).quotes;

  for (const [id, marker] of quoteMarkers.entries()) {
    const remote = fetchedQuotes.get(id);
    const mergedConcepts = [...new Set([...(remote?.concepts ?? []), ...marker.concepts])];
    for (const c of mergedConcepts) conceptKeys.add(c);
    quotes[String(id)] = {
      id,
      citekey: marker.citekey ?? remote?.citekey,
      workKey: marker.workKey ?? remote?.workKey,
      workTitle: remote?.workTitle,
      locator: marker.locator ?? remote?.locator,
      concepts: mergedConcepts,
    };
  }

  const termCfg = terminologyConfig(env);
  const termBase = termCfg?.baseUrl ?? DEFAULT_TERMINOLOGY_BASE;

  for (const rawKey of conceptKeys) {
    const parsed = parseConceptToken(rawKey);
    if (!parsed) continue;
    const resolved = termCfg
      ? await resolveTermFromTerminology(termBase, parsed.scheme, parsed.slug)
      : defaultConceptRef(parsed.scheme, parsed.slug);
    concepts[parsed.raw] = resolved;
  }

  return { quotes, concepts };
}
