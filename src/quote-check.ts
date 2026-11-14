import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { type CitationItem, citationItems, findCitations } from "./citeproc.js";
import { type DB, PROJECT_ROOT } from "./db.js";
import { extractFrontmatter } from "./ghost.js";
import { type ValidationIssue, validateMarkdown } from "./markdown.js";
import { type FetchedQuote, type QuoteLookup, fetchQuotes } from "./provenance.js";

/**
 * Checks quoted words against quote-mcp's saved text.
 *
 * A `<!-- quote <id> -->` marker on the line before a block quote says the block quote is that saved
 * quote word for word; a marker before an ordinary paragraph (a run-in quote) says the saved words
 * appear unchanged somewhere in it. Fence openers (`::: {.epigraph}`) between the marker and the
 * passage are skipped. The passage's citation is compared with the quote's citekey and locator.
 * Same rules as holdings-mcp's portal-article check-draft.mjs.
 */

export interface QuotePassage {
  id: number;
  /** A `corpus:quote` marker: a corpus-mcp id from before quotes moved to quote-mcp. */
  legacy: boolean;
  /** 1-based line of the marker. */
  line: number;
  kind: "block" | "run-in" | "none";
  /** The passage's quoted words (citations, footnote references, `>` and wrapping removed). */
  words: string;
  /** Citations on the passage, its footnotes, or (failing those) the paragraph right after it. */
  citations: CitationItem[];
}

export interface UnmarkedBlockQuote {
  line: number;
  text: string;
}

/**
 * `excerpt`: a block quote that quotes part of the saved text, unchanged (a warning).
 * `note`: the id is a note in quote-mcp (the author's own words), so there are no quoted words to compare.
 */
export type TextStatus = "matches" | "excerpt" | "differs" | "unchecked" | "note";

export interface QuoteCheck {
  id: number;
  line: number;
  kind: "block" | "run-in" | "none";
  text: TextStatus;
  /** Why the text was not checked, or how it differs. */
  reason?: string;
  /** About 30 characters either side of the first difference. */
  /** For `excerpt`: one contiguous run of the saved text, or runs joined by … / […] in the saved order. */
  excerpt?: "contiguous" | "elided";
  /** For an `elided` excerpt: how many runs. */
  pieces?: number;
  saved_at_difference?: string;
  draft_at_difference?: string;
  citekey: "matches" | "differs" | "missing" | "unchecked";
  locator: "matches" | "differs" | "absent" | "unchecked";
  cited?: CitationItem;
  saved?: { citekey?: string; locator?: string };
}

export interface QuoteCheckReport {
  checks: QuoteCheck[];
  unmarked_block_quotes: UnmarkedBlockQuote[];
  /** Set when quote-mcp could not be asked, so every text is `unchecked`. */
  unavailable?: string;
  issues: ValidationIssue[];
}

const MARKER_RE = /^\s*<!--\s*(corpus:)?quote\s+(\d+)(?:\s[\s\S]*?)?\s*-->\s*$/;
const BLOCK_RE = /^\s{0,3}>/;
const FENCE_OPEN_RE = /^\s*:{3,}\s*\S/;
const FENCE_LINE_RE = /^\s*:{3,}/;
const FOOTNOTE_DEF_RE = /^\[\^([^\]\s]+)\]:\s?(.*)$/;
const FOOTNOTE_REF_RE = /\[\^([^\]\s]+)\]/g;

/**
 * Quoted words only: no citations (bracketed `[@key, p. 3]` or narrative `@key` / `@key [p. 3]`),
 * footnote references, or line wrapping. Emails and URLs are not citations and are kept. Applied to
 * the draft and the saved text alike, so an `@` the source itself contains cancels out.
 */
export function quoteWords(text: string): string {
  let out = text.replace(/\[\^[^\]]+\]/g, "").replace(/\[[^\[\]]*@[^\[\]]*\]/g, "");
  const narrative = findCitations(out).filter((s) => s.kind === "narrative");
  for (const s of narrative.reverse()) out = out.slice(0, s.start) + out.slice(s.end);
  return out.replace(/\s+/g, " ").trim();
}

/**
 * Typography Pandoc's `smart` extension makes identical on output, and Markdown escapes and
 * emphasis marks the reader never sees, folded so they do not count as differences.
 */
export function canonicalWords(text: string): string {
  return text
    .replace(/\\([\\`*_{}\[\]()#+\-.!>"'|~])/g, "$1")
    .replace(/(\*{1,3}|_{1,3})(?=\S)([^*_\n]*?\S)\1/g, "$2")
    .replace(/---/g, "—")
    .replace(/--/g, "–")
    .replace(/\.\.\./g, "…")
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/ /g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function snippet(text: string, at: number): string {
  return text.slice(Math.max(0, at - 30), at + 30);
}

function codeMask(lines: string[]): boolean[] {
  const mask = new Array<boolean>(lines.length).fill(false);
  let fence: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const m = /^(?:\s*>)*\s*(`{3,}|~{3,})/.exec(lines[i]);
    if (fence) {
      mask[i] = true;
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length) fence = null;
    } else if (m) {
      mask[i] = true;
      fence = m[1];
    }
  }
  return mask;
}

function footnoteDefinitions(lines: string[], code: boolean[]): Map<string, string> {
  const defs = new Map<string, string>();
  for (let i = 0; i < lines.length; i++) {
    if (code[i]) continue;
    const m = FOOTNOTE_DEF_RE.exec(lines[i]);
    if (!m) continue;
    const body = [m[2]];
    let j = i + 1;
    while (j < lines.length && (/^(?: {4}|\t)/.test(lines[j]) || (lines[j].trim() === "" && /^(?: {4}|\t)/.test(lines[j + 1] ?? "")))) {
      body.push(lines[j].trim());
      j++;
    }
    defs.set(m[1], body.join(" "));
  }
  return defs;
}

function citationsIn(text: string): CitationItem[] {
  return findCitations(text).flatMap((s) => citationItems(s));
}

function passageCitations(raw: string, defs: Map<string, string>): CitationItem[] {
  const direct = citationsIn(raw);
  if (direct.length) return direct;
  const viaNotes: CitationItem[] = [];
  for (const m of raw.matchAll(FOOTNOTE_REF_RE)) {
    const def = defs.get(m[1]);
    if (def) viaNotes.push(...citationsIn(def));
  }
  return viaNotes;
}

/** Collect the marked passages and the unmarked block quotes of a Markdown document. */
export function scanQuotePassages(markdown: string): { passages: QuotePassage[]; unmarked: UnmarkedBlockQuote[] } {
  const { bodyStartLine, bodyLines: lines } = extractFrontmatter(markdown);
  const lineNo = (i: number) => bodyStartLine + i;
  const code = codeMask(lines);
  const defs = footnoteDefinitions(lines, code);
  const passages: QuotePassage[] = [];
  const claimed = new Set<number>();

  // The paragraph starting at `from` (stopping at a blank line, fence, or marker); [start, end).
  const paragraphAt = (from: number): [number, number] => {
    let end = from;
    while (
      end < lines.length &&
      lines[end].trim() !== "" &&
      !code[end] &&
      !FENCE_LINE_RE.test(lines[end]) &&
      !MARKER_RE.test(lines[end]) &&
      (end === from || !BLOCK_RE.test(lines[end]))
    ) {
      end++;
    }
    return [from, end];
  };

  for (let i = 0; i < lines.length; i++) {
    if (code[i]) continue;
    const m = MARKER_RE.exec(lines[i]);
    if (!m) continue;
    const id = Number(m[2]);
    if (!Number.isSafeInteger(id) || id <= 0) continue;

    let j = i + 1;
    while (j < lines.length && FENCE_OPEN_RE.test(lines[j]) && !code[j]) j++;

    let kind: QuotePassage["kind"] = "none";
    let raw = "";
    let after = j;
    if (j < lines.length && !code[j] && BLOCK_RE.test(lines[j])) {
      let end = j;
      while (end + 1 < lines.length && BLOCK_RE.test(lines[end + 1])) end++;
      claimed.add(j);
      kind = "block";
      raw = lines
        .slice(j, end + 1)
        .map((l) => l.replace(/^\s{0,3}>\s?/, "").replace(/^(?:\s*>\s?)+/, ""))
        .join("\n");
      after = end + 1;
    } else if (j < lines.length && !code[j] && lines[j].trim() !== "" && !FENCE_LINE_RE.test(lines[j])) {
      const [start, end] = paragraphAt(j);
      kind = "run-in";
      raw = lines.slice(start, end).join("\n");
      after = end;
    }

    let citations = kind === "none" ? [] : passageCitations(raw, defs);
    if (kind !== "none" && !citations.length) {
      // An epigraph's attribution line, or a citation set as its own paragraph after a block quote.
      let k = after;
      while (k < lines.length && lines[k].trim() === "") k++;
      if (k < lines.length && !code[k] && !MARKER_RE.test(lines[k]) && !FENCE_LINE_RE.test(lines[k]) && !/^#{1,6}\s/.test(lines[k])) {
        const [start, end] = paragraphAt(k);
        citations = passageCitations(lines.slice(start, end).join("\n"), defs);
      }
    }

    passages.push({ id, legacy: Boolean(m[1]), line: lineNo(i), kind, words: quoteWords(raw), citations });
  }

  const unmarked: UnmarkedBlockQuote[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (code[i] || !BLOCK_RE.test(lines[i]) || (i > 0 && BLOCK_RE.test(lines[i - 1]))) continue;
    if (FOOTNOTE_DEF_RE.test(lines[i])) continue;
    let end = i;
    while (end + 1 < lines.length && BLOCK_RE.test(lines[end + 1])) end++;
    if (!claimed.has(i)) {
      const text = quoteWords(
        lines
          .slice(i, end + 1)
          .map((l) => l.replace(/^(?:\s*>\s?)+/, ""))
          .join("\n"),
      );
      if (text) unmarked.push({ line: lineNo(i), text: text.slice(0, 80) });
    }
    i = end;
  }

  return { passages, unmarked };
}

function normLocator(loc: string): string {
  let l = loc
    .trim()
    // A leading italic work title names the work, not the place: `*Iliad* bk. XXIV`.
    .replace(/^(\*{1,2}|_{1,2})(?=\S)[^*_]*?\S\1\s*,?\s+(?=\S)/, "");
  // A quoted section title is that chapter: `"Lettuce"` = `chap. Lettuce`.
  const quoted = /^["“”'‘’]([^"“”]+?)[,.]?["“”'‘’]$/.exec(l);
  if (quoted) l = `chap. ${quoted[1]}`;
  // A book of a work is how EPUB chapters name it: `bk. XXIV` = `book XXIV` = `chap. BOOK XXIV`.
  l = l.replace(/^(?:bk\.?|books?)\s+(\S+)/i, "chap. book $1");
  return l
    .toLowerCase()
    .replace(/\bpages?\b\.?/g, (w) => (w.startsWith("pages") ? "pp." : "p."))
    .replace(/\bchapters?\b\.?|\bchap\b\.?|\bch\b\.?/g, "chap.")
    .replace(/\bsections?\b\.?|\bsec\b\.?|§/g, "sec.")
    .replace(/\.\s+/g, ".")
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

export function locatorsAgree(cited: string, saved: string): boolean {
  const a = normLocator(cited);
  const b = normLocator(saved);
  return a === b || a.startsWith(`${b},`) || a.startsWith(`${b} `);
}

type TextResult = Pick<QuoteCheck, "text" | "reason" | "excerpt" | "pieces" | "saved_at_difference" | "draft_at_difference">;

/**
 * Whether a block quote's words are an excerpt of the saved words: one contiguous run, or runs
 * separated by … / […] that appear in the saved text in that order. A literal match (including any
 * ellipsis the saved text itself contains) is tried first.
 */
export function excerptOf(draft: string, want: string): { excerpt: "contiguous" | "elided"; pieces: number } | null {
  if (!draft) return null;
  if (want.includes(draft)) return { excerpt: "contiguous", pieces: 1 };
  const pieces = draft
    .split(/\s*\[\s*…\s*\]\s*|\s*…\s*/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (!pieces.length) return null;
  let from = 0;
  for (const piece of pieces) {
    const at = want.indexOf(piece, from);
    if (at < 0) return null;
    from = at + piece.length;
  }
  return pieces.length === 1 ? { excerpt: "contiguous", pieces: 1 } : { excerpt: "elided", pieces: pieces.length };
}

function compareText(passage: QuotePassage, saved: string): TextResult {
  const draft = canonicalWords(passage.words);
  let want = canonicalWords(quoteWords(saved));
  if (passage.kind === "block") {
    if (draft === want) return { text: "matches" };
    const ex = excerptOf(draft, want);
    if (ex) {
      return {
        text: "excerpt",
        reason:
          ex.excerpt === "contiguous"
            ? "the block quote is a contiguous part of the saved quote"
            : `the block quote is ${ex.pieces} parts of the saved quote joined by ellipses`,
        excerpt: ex.excerpt,
        ...(ex.excerpt === "elided" ? { pieces: ex.pieces } : {}),
      };
    }
    let at = 0;
    while (at < want.length && want[at] === draft[at]) at++;
    return {
      text: "differs",
      reason: "the block quote differs from the saved quote",
      saved_at_difference: snippet(want, at),
      draft_at_difference: snippet(draft, at),
    };
  }
  // A sentence quoted inside another gives up its closing punctuation to the host sentence.
  want = want.replace(/[.,;:]+$/, "");
  if (draft.includes(want)) return { text: "matches" };
  // The longest leading part of the saved words that appears in the paragraph locates the difference.
  let lo = 0;
  let hi = want.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (draft.includes(want.slice(0, mid))) lo = mid;
    else hi = mid - 1;
  }
  const where = lo > 0 ? draft.indexOf(want.slice(0, lo)) + lo : 0;
  return {
    text: "differs",
    reason: "the saved quote does not appear word for word in this paragraph",
    saved_at_difference: snippet(want, lo),
    draft_at_difference: snippet(draft, where),
  };
}

function checkPassage(passage: QuotePassage, lookup: QuoteLookup): QuoteCheck {
  const base = { id: passage.id, line: passage.line, kind: passage.kind };
  const remote: FetchedQuote | undefined = lookup.quotes.get(passage.id);
  const saved = remote ? { ...(remote.citekey ? { citekey: remote.citekey } : {}), ...(remote.locatorText ? { locator: remote.locatorText } : {}) } : undefined;

  const unchecked = (reason: string): QuoteCheck => ({
    ...base,
    text: "unchecked",
    reason,
    citekey: "unchecked",
    locator: "unchecked",
    ...(passage.citations[0] ? { cited: passage.citations[0] } : {}),
  });

  if (passage.kind === "none") return unchecked("the marker is not followed by a paragraph or block quote");
  if (passage.legacy) {
    return unchecked("a corpus:quote marker holds a corpus-mcp id from before quotes moved to quote-mcp; save the quote with quote-mcp's add_quote and mark it <!-- quote <id> -->");
  }
  if (lookup.unavailable) return unchecked(lookup.unavailable);
  if (!remote) return unchecked(`quote-mcp has no quote ${passage.id}${lookup.errors.has(passage.id) ? `: ${lookup.errors.get(passage.id)}` : ""}`);

  const text: TextResult =
    remote.kind === "note"
      ? { text: "note", reason: `quote ${passage.id} is a note in quote-mcp, not a quote, so it has no quoted words to compare` }
      : remote.text
        ? compareText(passage, remote.text)
        : { text: "unchecked", reason: "quote-mcp returned no quoted text for this id" };

  let citekey: QuoteCheck["citekey"];
  let locator: QuoteCheck["locator"] = "unchecked";
  let cited: CitationItem | undefined;
  if (remote.kind === "note") {
    citekey = "unchecked"; // the author's own words: no citation is owed
  } else if (!passage.citations.length) {
    citekey = "missing";
  } else if (!remote.citekey) {
    citekey = "unchecked";
    cited = passage.citations[0];
  } else {
    cited = passage.citations.find((c) => c.key === remote.citekey);
    citekey = cited ? "matches" : "differs";
    cited ??= passage.citations[0];
  }
  if (cited && citekey === "matches") {
    if (!cited.locator) locator = "absent";
    else if (!remote.locatorText) locator = "unchecked";
    else locator = locatorsAgree(cited.locator, remote.locatorText) ? "matches" : "differs";
  }

  return { ...base, ...text, citekey, locator, ...(cited ? { cited } : {}), ...(saved ? { saved } : {}) };
}

function issuesFor(checks: QuoteCheck[], unmarked: UnmarkedBlockQuote[], unavailable?: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (unavailable && checks.some((c) => c.text === "unchecked" && c.reason === unavailable)) {
    const n = checks.filter((c) => c.reason === unavailable).length;
    issues.push({
      severity: "warning",
      code: "quote-text-unchecked",
      line: checks.find((c) => c.reason === unavailable)!.line,
      message: `${n} quote marker(s) not checked against their saved text: ${unavailable}.`,
      suggestion: "Validate again when quote-mcp is reachable; until then the quoted words are unverified.",
    });
  }
  for (const c of checks) {
    if (c.kind === "none") {
      issues.push({
        severity: "warning",
        code: "quote-marker-orphan",
        line: c.line,
        message: `Quote marker ${c.id} on line ${c.line} is not followed by a paragraph or block quote.`,
        suggestion: "Put the marker on the line directly before the block quote or the paragraph that quotes it.",
      });
      continue;
    }
    if (c.text === "excerpt") {
      issues.push({
        severity: "warning",
        code: "quote-text-excerpt",
        line: c.line,
        message: `Quote ${c.id} (line ${c.line}) quotes ${c.excerpt === "elided" ? `${c.pieces} parts` : "part"} of the saved quote unchanged${c.excerpt === "elided" ? ", joined by ellipses" : ""}.`,
        suggestion: "Fine for an editorial excerpt; save the excerpt as its own quote if it should match exactly.",
      });
    } else if (c.text === "differs") {
      issues.push({
        severity: "error",
        code: "quote-text-differs",
        line: c.line,
        message: `Quote ${c.id} (line ${c.line}): ${c.reason}. Saved: "…${c.saved_at_difference}…"; draft: "…${c.draft_at_difference}…".`,
        suggestion: "Copy the words from quote-mcp's cite_quote, or fix the saved quote there if the draft is right.",
      });
    } else if (c.text === "note") {
      issues.push({
        severity: "info",
        code: "quote-text-unchecked",
        line: c.line,
        message: `Marker ${c.id} (line ${c.line}) names a note, not a quote; its words are not compared.`,
      });
    } else if (c.text === "unchecked" && c.reason !== unavailable) {
      issues.push({
        severity: "warning",
        code: "quote-text-unchecked",
        line: c.line,
        message: `Quote ${c.id} (line ${c.line}) not checked: ${c.reason}.`,
      });
    }
    if (c.citekey === "differs") {
      issues.push({
        severity: "error",
        code: "quote-citekey-differs",
        line: c.line,
        message: `Quote ${c.id} (line ${c.line}) is cited as @${c.cited?.key}, but quote-mcp has it from @${c.saved?.citekey}.`,
        suggestion: `Cite it as ${c.saved?.locator ? `[@${c.saved?.citekey}, ${c.saved.locator}]` : `[@${c.saved?.citekey}]`}.`,
      });
    } else if (c.citekey === "missing") {
      issues.push({
        severity: "warning",
        code: "quote-citation-missing",
        line: c.line,
        message: `Quote ${c.id} (line ${c.line}) has no citation on the passage, its footnotes, or the paragraph after it.`,
        suggestion: c.saved?.citekey ? `Add [@${c.saved.citekey}${c.saved.locator ? `, ${c.saved.locator}` : ""}].` : "Add the citation quote-mcp's cite_quote gives.",
      });
    }
    if (c.locator === "differs") {
      issues.push({
        severity: "warning",
        code: "quote-locator-differs",
        line: c.line,
        message: `Quote ${c.id} (line ${c.line}) is cited at '${c.cited?.locator}', but quote-mcp has '${c.saved?.locator}'.`,
        suggestion: "Fine if both name the same place (e.g. a chapter by title); otherwise use the stored locator.",
      });
    }
  }
  for (const u of unmarked) {
    issues.push({
      severity: "warning",
      code: "unmarked-block-quote",
      line: u.line,
      message: `Block quote on line ${u.line} has no <!-- quote <id> --> marker, so its words are not checked ("${u.text}").`,
      suggestion: "Save it with quote-mcp's add_quote and put <!-- quote <id> --> on the line before it.",
    });
  }
  return issues;
}

/** Check every marked passage of a document against quote-mcp; `lookup` may be passed to reuse a fetch. */
export async function checkQuotes(
  markdown: string,
  options: { env?: NodeJS.ProcessEnv; lookup?: QuoteLookup } = {},
): Promise<QuoteCheckReport & { lookup: QuoteLookup }> {
  const { passages, unmarked } = scanQuotePassages(markdown);
  const ids = [...new Set(passages.filter((p) => !p.legacy && p.kind !== "none").map((p) => p.id))];
  const lookup = options.lookup ?? (await fetchQuotes(ids, options.env));
  const checks = passages.map((p) => checkPassage(p, lookup));
  const unavailable = ids.length ? lookup.unavailable : undefined;
  return {
    checks,
    unmarked_block_quotes: unmarked,
    ...(unavailable ? { unavailable } : {}),
    issues: issuesFor(checks, unmarked, unavailable),
    lookup,
  };
}

/**
 * validate_markdown: the structural checks plus the quote checks (quoted words, citekeys, locators,
 * unmarked block quotes). When quote-mcp cannot be asked, each marked quote is reported `unchecked`.
 */
export async function validateMarkdownWithQuotes(
  db: DB,
  input: { markdown?: string; path?: string; rootDir?: string },
  env: NodeJS.ProcessEnv = process.env,
) {
  const base = validateMarkdown(db, input);
  const rootDir = input.rootDir ?? PROJECT_ROOT;
  const text = input.markdown ?? readFileSync(resolve(rootDir, input.path!), "utf8");
  const report = await checkQuotes(text, { env });
  const issues = [...base.issues, ...report.issues].sort((a, b) => a.line - b.line);
  const errorCount = issues.filter((i) => i.severity === "error").length;
  return {
    ...base,
    valid: errorCount === 0,
    error_count: errorCount,
    warning_count: issues.filter((i) => i.severity === "warning").length,
    info_count: issues.filter((i) => i.severity === "info").length,
    issues,
    quotes: {
      checks: report.checks,
      unmarked_block_quotes: report.unmarked_block_quotes,
      ...(report.unavailable ? { unavailable: report.unavailable } : {}),
    },
  };
}
