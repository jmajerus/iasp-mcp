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

async function fetchQuoteFromMcp(
  quoteBaseUrl: string,
  quoteIds: number[],
  timeoutMs = 3000,
): Promise<Map<number, QuoteProvenance>> {
  const map = new Map<number, QuoteProvenance>();
  if (!quoteIds.length) return map;

  const client = new Client({ name: "iasp-mcp-provenance", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${quoteBaseUrl.replace(/\/+$/, "")}/mcp`), {
    requestInit: { signal: AbortSignal.timeout(timeoutMs) },
  });

  try {
    await client.connect(transport);
    for (const id of quoteIds) {
      try {
        const res = await client.callTool({ name: "get_quote", arguments: { id } });
        const text = (res.content as { type: string; text?: string }[] | undefined)?.[0]?.text;
        if (!text) continue;
        const data = JSON.parse(text) as {
          id?: number;
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
        map.set(id, {
          id,
          ...(data.work?.citekey ? { citekey: data.work.citekey } : {}),
          ...(workKey ? { workKey } : {}),
          ...(data.work?.title ? { workTitle: data.work.title } : {}),
          ...(data.locator ? { locator: data.locator } : {}),
          concepts,
        });
      } catch {
        // Ignore individual quote lookup errors
      }
    }
  } catch {
    // quote-mcp unreachable or offline; graceful fallback to inline attributes
  } finally {
    await client.close().catch(() => {});
  }
  return map;
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
): Promise<ProvenanceManifest> {
  const { quoteMarkers, conceptKeys } = scanMarkdownProvenanceSeeds(markdown);
  const quotes: Record<string, QuoteProvenance> = {};
  const concepts: Record<string, ExternalConceptRef> = {};

  const quoteBaseRaw = env.QUOTE_BASE?.trim() ?? "";
  const quoteBase = quoteBaseRaw.toLowerCase() === "off" ? null : (quoteBaseRaw || DEFAULT_QUOTE_BASE);

  const fetchedQuotes = quoteBase
    ? await fetchQuoteFromMcp(quoteBase, [...quoteMarkers.keys()])
    : new Map<number, QuoteProvenance>();

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
