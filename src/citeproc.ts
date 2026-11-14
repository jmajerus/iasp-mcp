import { spawnSync } from "node:child_process";

/**
 * Pandoc citation resolution for the text-based exporters (`md` and `ghost`).
 *
 * Those exporters produce Markdown (with inline-styled HTML `<div>` cards for Ghost) that must not be
 * round-tripped through Pandoc, which would rewrite the divs and reflow the prose. Instead, the Pandoc
 * citations in the rendered text are located, resolved together in a single `pandoc --citeproc` call
 * (so author-date disambiguation and note-style ibid/short-form positions match a full-document
 * render), and spliced back in place. The bibliography is inserted under the document's
 * References / Bibliography / Works Cited heading; note-style citations become `[^iasp-cite-N]`
 * footnotes.
 */

const KEY_SRC = String.raw`(?:\{[^{}\s]+\}|[\p{L}\p{N}_](?:[\p{L}\p{N}_]|[:.#$%&\-+?<>~/](?=[\p{L}\p{N}_]))*)`;
const BRACKET_ITEM_RE = new RegExp(String.raw`(?:^|[\s;])-?@${KEY_SRC}`, "u");
const BRACKET_RE = /(?<![!\]\\])\[([^\[\]]*)\](?!\(|\[(?!\^))/g;
const NARRATIVE_RE = new RegExp(
  String.raw`(?<![\p{L}\p{N}_\\@])@(${KEY_SRC})(?:[ \t]?\[[^\[\]\n]*\](?!\(|\[(?!\^)))?`,
  "gu",
);
const REFERENCES_HEADING_RE = /^#{1,6}[ \t]+(?:References|Bibliography|Works Cited)[ \t]*(?:\{[^}\n]*\})?[ \t]*$/im;
const MISSING_RE = /Citeproc: citation (\S+) not found/g;
const MARKER = "IASPCITE";
const NOTE_MARKER = "IASPNOTE";

export interface CitationSpan {
  start: number;
  end: number;
  raw: string;
  kind: "bracketed" | "narrative";
  keys: string[];
  inFootnote: boolean;
}

function blank(text: string, start: number, end: number): string {
  return text.slice(0, start) + text.slice(start, end).replace(/[^\n]/g, " ") + text.slice(end);
}

/** Blank out regions where `@` is never a citation: code, HTML comments and tags, URLs. */
function maskNonCitationRegions(text: string): string {
  let masked = text;
  const maskAll = (re: RegExp, group = 0) => {
    for (const m of masked.matchAll(re)) {
      const offset = group ? m[0].indexOf(m[group]) : 0;
      masked = blank(masked, m.index! + offset, m.index! + offset + m[group].length);
    }
  };

  // Fenced code blocks (``` or ~~~), optionally inside blockquotes.
  const lines = masked.split("\n");
  let fence: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const m = /^(?:\s*>)*\s*(`{3,}|~{3,})/.exec(lines[i]);
    if (fence) {
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length) fence = null;
      lines[i] = lines[i].replace(/[^\n]/g, " ");
    } else if (m) {
      fence = m[1];
      lines[i] = lines[i].replace(/[^\n]/g, " ");
    }
  }
  masked = lines.join("\n");

  maskAll(/<!--[\s\S]*?-->/g);
  maskAll(/(`+)(?:(?!\1)[\s\S])+?\1/g);
  maskAll(/<\/?[A-Za-z][^<>]*>/g);
  maskAll(/(?<![\\!])\[[^\[\]]*\]\([^)]*\)/g); // inline links: neither text nor URL holds a citation
  maskAll(/\]\(([^)]*)\)/g, 1);
  maskAll(/\bhttps?:\/\/[^\s<>)\]]+/g);
  return masked;
}

function keysIn(raw: string): string[] {
  const re = new RegExp(String.raw`@(${KEY_SRC})`, "gu");
  return [...raw.matchAll(re)].map((m) => m[1].replace(/^\{|\}$/g, ""));
}

function paragraphStartsFootnote(text: string, pos: number): boolean {
  const before = text.slice(0, pos);
  const paraStart = Math.max(before.lastIndexOf("\n\n") + 2, 0);
  return /^(?:\s*>)*\s*\[\^[^\]\s]+\]:/.test(text.slice(paraStart, pos + 1));
}

/** Locate Pandoc citations (`[@key, p. 3]`, `[-@key]`, `@key [p. 3]`, `@key`) in rendered Markdown. */
export function findCitations(text: string): CitationSpan[] {
  let masked = maskNonCitationRegions(text);
  const spans: CitationSpan[] = [];

  for (const m of masked.matchAll(BRACKET_RE)) {
    if (!BRACKET_ITEM_RE.test(m[1])) continue;
    const start = m.index!;
    const end = start + m[0].length;
    // `[@key]: ...` at the start of a line is a link reference definition, not a citation.
    if (masked[end] === ":" && (start === 0 || masked[start - 1] === "\n")) continue;
    const raw = text.slice(start, end);
    spans.push({ start, end, raw, kind: "bracketed", keys: keysIn(raw), inFootnote: paragraphStartsFootnote(text, start) });
  }
  for (const s of spans) masked = blank(masked, s.start, s.end);

  for (const m of masked.matchAll(NARRATIVE_RE)) {
    const start = m.index!;
    const end = start + m[0].length;
    const raw = text.slice(start, end);
    spans.push({ start, end, raw, kind: "narrative", keys: keysIn(raw), inFootnote: paragraphStartsFootnote(text, start) });
  }

  return spans.sort((a, b) => a.start - b.start);
}

export interface CitationItem {
  key: string;
  /** The suffix after the key (`p. 44` in `[@key, p. 44]`, or the bracket of `@key [p. 44]`). */
  locator?: string;
}

/** The cited items of one citation span, with the text after each key as its locator. */
export function citationItems(span: Pick<CitationSpan, "raw" | "kind">): CitationItem[] {
  const itemRe = new RegExp(String.raw`^[^@]*?-?@(${KEY_SRC})([\s\S]*)$`, "u");
  if (span.kind === "narrative") {
    const m = new RegExp(String.raw`^@(${KEY_SRC})(?:[ \t]?\[([^\[\]]*)\])?`, "u").exec(span.raw);
    if (!m) return [];
    const locator = m[2]?.trim();
    return [{ key: m[1].replace(/^\{|\}$/g, ""), ...(locator ? { locator } : {}) }];
  }
  const items: CitationItem[] = [];
  for (const part of oneLine(span.raw.slice(1, -1)).split(";")) {
    const m = itemRe.exec(part.trim());
    if (!m) continue;
    const locator = m[2].replace(/^\s*,/, "").trim();
    items.push({ key: m[1].replace(/^\{|\}$/g, ""), ...(locator ? { locator } : {}) });
  }
  return items;
}

/** Every citekey cited in a Markdown text, split by whether it appears in a bracketed citation. */
export function citedKeys(text: string): { bracketed: Set<string>; narrative: Set<string> } {
  const bracketed = new Set<string>();
  const narrative = new Set<string>();
  for (const span of findCitations(text)) {
    for (const k of span.keys) (span.kind === "bracketed" ? bracketed : narrative).add(k);
  }
  for (const k of bracketed) narrative.delete(k);
  return { bracketed, narrative };
}

export interface ResolveCitationsOptions {
  /** One or more bibliographies (BibTeX, CSL JSON, ...); all are passed to pandoc. */
  bibliographyPaths?: string[];
  /** @deprecated use bibliographyPaths */
  bibliographyPath?: string;
  cslPath?: string;
  lang?: string;
  cwd?: string;
  pandocAvailable?: boolean;
}

export interface ResolveCitationsResult {
  content: string;
  warnings: string[];
  citations: number;
  resolved: number;
}

const WRITER =
  "markdown-citations-smart-fenced_divs-native_divs-bracketed_spans-native_spans-raw_html-link_attributes-header_attributes";

function oneLine(raw: string): string {
  return raw.replace(/[ \t]*\r?\n(?:[ \t]*>)*[ \t]*/g, " ");
}

function preview(spans: CitationSpan[]): string {
  const shown = spans.slice(0, 3).map((s) => oneLine(s.raw));
  return shown.join(", ") + (spans.length > 3 ? `, … (+${spans.length - 3} more)` : "");
}

/**
 * Resolve Pandoc citations in rendered `md` / `ghost` text with `pandoc --citeproc`.
 * With no bibliography, citations are left as written and a warning is returned.
 */
export function resolveCitations(text: string, options: ResolveCitationsOptions): ResolveCitationsResult {
  const spans = findCitations(text);
  if (!spans.length) return { content: text, warnings: [], citations: 0, resolved: 0 };

  const bracketed = spans.filter((s) => s.kind === "bracketed");
  const bibliographies = [...(options.bibliographyPaths ?? []), ...(options.bibliographyPath ? [options.bibliographyPath] : [])];
  if (!bibliographies.length) {
    if (!bracketed.length) return { content: text, warnings: [], citations: 0, resolved: 0 };
    return {
      content: text,
      warnings: [
        `${bracketed.length} citation(s) left unresolved (${preview(bracketed)}): no bibliography was supplied. Pass 'bibliography' or 'bibtex_content', or set 'bibliography' in the frontmatter, to run --citeproc.`,
      ],
      citations: bracketed.length,
      resolved: 0,
    };
  }
  if (options.pandocAvailable === false) {
    return {
      content: text,
      warnings: [`${spans.length} citation(s) left unresolved: 'pandoc' was not found on PATH, so --citeproc could not run.`],
      citations: spans.length,
      resolved: 0,
    };
  }

  const input = spans
    .map((s, i) => (s.inFootnote ? `${MARKER}${i}: x^[${NOTE_MARKER} ${oneLine(s.raw)}]` : `${MARKER}${i}: ${oneLine(s.raw)}`))
    .join("\n\n");
  const args = [
    "-f",
    "markdown+citations",
    "-t",
    WRITER,
    "--wrap=none",
    "--citeproc",
    ...bibliographies.map((b) => `--bibliography=${b}`),
    ...(options.cslPath ? [`--csl=${options.cslPath}`] : []),
    ...(options.lang ? ["-M", `lang=${options.lang}`] : []),
  ];
  const res = spawnSync("pandoc", args, {
    input: `${input}\n\n::: {#refs}\n:::\n`,
    cwd: options.cwd,
    encoding: "utf8",
    timeout: 60_000,
  });
  if (res.error || res.status !== 0) {
    const detail = (res.stderr || res.error?.message || "unknown failure").trim();
    return {
      content: text,
      warnings: [`Citation processing failed; ${spans.length} citation(s) left unresolved. pandoc --citeproc: ${detail}`],
      citations: spans.length,
      resolved: 0,
    };
  }

  const stderr = res.stderr ?? "";
  const missing = new Set([...stderr.matchAll(MISSING_RE)].map((m) => m[1]));
  const warnings = stderr
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/Citeproc: citation \S+ not found/.test(l));

  // Split pandoc's output: marker paragraphs, then bibliography entries, then footnote definitions.
  const blocks = res.stdout.replace(/\r\n/g, "\n").trim().split(/\n{2,}/);
  const rendered = new Map<number, { text: string; spaceKept: boolean }>();
  const footnotes = new Map<string, string>();
  const bibliography: string[] = [];
  let lastFootnote: string | null = null;
  for (const block of blocks) {
    const marker = new RegExp(`^${MARKER}(\\d+):( ?)([\\s\\S]*)$`).exec(block);
    if (marker) {
      rendered.set(Number(marker[1]), { text: marker[3], spaceKept: marker[2] === " " });
      lastFootnote = null;
      continue;
    }
    const def = /^\[\^([^\]]+)\]: ([\s\S]*)$/.exec(block);
    if (def) {
      footnotes.set(def[1], def[2]);
      lastFootnote = def[1];
      continue;
    }
    if (lastFootnote && block.startsWith("    ")) {
      footnotes.set(lastFootnote, `${footnotes.get(lastFootnote)}\n\n${block}`);
      continue;
    }
    bibliography.push(block);
  }

  let noteCounter = 0;
  const usedNotes: string[] = [];
  const unresolvedNarrative: CitationSpan[] = [];
  let out = "";
  let cursor = 0;
  let resolved = 0;
  for (const [i, span] of spans.entries()) {
    const r = rendered.get(i);
    if (!r || (span.kind === "narrative" && span.keys.some((k) => missing.has(k)))) {
      if (span.kind === "narrative" && r) unresolvedNarrative.push(span);
      continue;
    }
    let replacement: string;
    if (span.inFootnote) {
      // Inline the citation text from the wrapper note (a note cannot nest inside a footnote).
      const ref = /^x\[\^([^\]]+)\]$/.exec(r.text.trim());
      replacement = ref ? (footnotes.get(ref[1]) ?? "").replace(new RegExp(`^${NOTE_MARKER}\\s*`), "") : r.text;
    } else {
      replacement = r.text.replace(/\[\^([^\]]+)\]/g, (_full, label: string) => {
        const id = `iasp-cite-${++noteCounter}`;
        usedNotes.push(`[^${id}]: ${footnotes.get(label) ?? ""}`);
        return `[^${id}]`;
      });
    }
    let start = span.start;
    if (!r.spaceKept) {
      // Note styles drop the space before a citation that becomes a footnote mark.
      while (start > cursor && /[ \t]/.test(text[start - 1])) start--;
    }
    out += text.slice(cursor, start) + replacement;
    cursor = span.end;
    resolved++;
  }
  out += text.slice(cursor);

  const missingBracketed = [...missing].filter((k) => bracketed.some((s) => s.keys.includes(k)));
  if (missingBracketed.length) {
    warnings.unshift(`Citation key(s) not found in the bibliography: ${missingBracketed.join(", ")}.`);
  }
  if (unresolvedNarrative.length) {
    warnings.push(
      `Left ${unresolvedNarrative.length} '@word' token(s) as written because no bibliography entry matched (${preview(unresolvedNarrative)}).`,
    );
  }

  if (bibliography.length) {
    const bibText = bibliography.join("\n\n");
    const heading = REFERENCES_HEADING_RE.exec(out);
    if (heading) {
      const at = heading.index + heading[0].length;
      out = `${out.slice(0, at)}\n\n${bibText}\n${out.slice(at).replace(/^\n*/, "\n")}`;
    } else {
      out = `${out.replace(/\s*$/, "")}\n\n## References\n\n${bibText}\n`;
    }
  }
  if (usedNotes.length) {
    out = `${out.replace(/\s*$/, "")}\n\n${usedNotes.join("\n\n")}\n`;
  }

  return { content: out, warnings, citations: spans.length, resolved };
}
