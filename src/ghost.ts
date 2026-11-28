import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseDocument as parseYamlDocument } from "yaml";
import { PROJECT_ROOT } from "./db.js";
import {
  defaultConceptRef,
  type ExternalConceptRef,
  type ParsedQuoteMarker,
  type ProvenanceManifest,
  type QuoteProvenance,
  parseConceptToken,
  parseQuoteMarkerComment,
  splitConceptList,
} from "./provenance.js";
import {
  BRIDGE_GHOST_STYLE,
  CALLOUT_GHOST_STYLE,
  DEFINITION_GHOST_STYLE,
  EXAMPLE_GHOST_STYLE,
  type GhostStyle,
  NOTE_VARIANT_SPECS,
  SIDEBAR_GHOST_STYLE,
} from "./rendering-profile.js";

/**
 * TypeScript port of `iasp_tooling/scripts/ghost_export.py` and `update_ai_turns.py`.
 *
 * Resolves `::: {.include ...}` directives, filters `.draft` / `.final` blocks by stage,
 * replaces `{{meta:...}}` placeholders, and converts IASP semantic fenced blocks into
 * CommonMark Type-6 HTML `<div>` wrappers so Ghost renders inner Markdown natively.
 */

const WORKS_CITED_HEADING_RE = /^\s*##+\s+(Works Cited|References|Bibliography)\b/i;
const FENCE_CLOSER_RE = /^:::\s*$/;
const SINGLE_LINE_FENCE_RE = /^(:::\s*\{[^}]+\})\s+(.*?)\s*:::$/;
const INLINE_CONTENT_FENCE_RE = /^(:::\s*\{[^}]+\})\s+(.+?)\s*$/;
/** Tags that open a CommonMark HTML block (types 1 and 6); any other leading tag, such as `<em>`, is inline. */
const HTML_BLOCK_TAGS =
  "address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|pre|script|search|section|style|summary|table|tbody|td|textarea|tfoot|th|thead|title|tr|track|ul";
const HTML_BLOCK_START = `<(?:!--|\\?|![A-Za-z]|!\\[CDATA\\[|\\/?(?:${HTML_BLOCK_TAGS})(?:\\s|\\/?>|$))`;
/**
 * A line that ends a paragraph in CommonMark (Ghost's dialect): heading, block quote, list item (an
 * ordered one only from 1), code or div fence, thematic break, or HTML block.
 */
const PARAGRAPH_INTERRUPT_RE = new RegExp(
  `^\\s{0,3}(?:#{1,6}(?:\\s|$)|>|[-*+]\\s+\\S|1[.)]\\s+\\S|\`{3}|~{3}|:{3}|(?:[-*_][ \\t]*){3,}$|${HTML_BLOCK_START})`,
  "i",
);
/**
 * Under paragraph text, a line of only `=` or only `-` makes that text a Setext heading (so `---` there is
 * an underline, not a thematic break).
 */
const SETEXT_UNDERLINE_RE = /^\s{0,3}(?:=+|-+)\s*$/;
/** The first line of an ordinary paragraph: none of the above, nor a table row, footnote, or other list item. */
const RUN_IN_PARAGRAPH_RE = /^\s{0,3}(?![-*+]\s|\d+[.)]\s|\||\[\^[^\]]+\]:)\S/;
const startsRunIn = (line: string) => RUN_IN_PARAGRAPH_RE.test(line) && !PARAGRAPH_INTERRUPT_RE.test(line);

export interface TextLineNode {
  kind: "text";
  text: string;
  line: number;
}

export interface FenceAstNode {
  kind: "fence";
  classes: string[];
  attrs: Record<string, string>;
  id?: string;
  shorthand: boolean;
  startLine: number;
  endLine: number;
  unclosed?: boolean;
  children: AstNode[];
}

export type AstNode = TextLineNode | FenceAstNode;

export function parseFenceHeader(line: string): {
  classes: string[];
  attrs: Record<string, string>;
  id?: string;
  shorthand: boolean;
} | null {
  const stripped = line.trim();
  if (!stripped.startsWith(":::")) return null;
  const rest = stripped.slice(3).trim();
  if (!rest) return null; // closer

  const classes: string[] = [];
  const attrs: Record<string, string> = {};
  let id: string | undefined;
  let shorthand = false;

  if (rest.startsWith("{")) {
    const inner = rest.replace(/^\{/, "").replace(/\}$/, "");
    const tokenRe = /\.([^\s}{'"=]+)|#([^\s}{'"=]+)|([\w-]+)=(?:"([^"]*)"|'([^']*)'|(\S+))/g;
    for (const m of inner.matchAll(tokenRe)) {
      if (m[1]) {
        for (const chunk of m[1].toLowerCase().split(".")) {
          if (chunk) classes.push(chunk);
        }
      } else if (m[2]) {
        id = m[2];
      } else if (m[3]) {
        attrs[m[3]] = m[4] ?? m[5] ?? m[6] ?? "";
      }
    }
  } else {
    shorthand = true;
    const attrRe = /([\w-]+)=(?:"([^"]*)"|'([^']*)'|(\S+))/g;
    let firstSpace = rest.search(/\s/);
    const head = firstSpace === -1 ? rest : rest.slice(0, firstSpace);
    const tail = firstSpace === -1 ? "" : rest.slice(firstSpace + 1);
    for (const chunk of head.split(".")) {
      if (chunk) classes.push(chunk.toLowerCase());
    }
    for (const m of tail.matchAll(attrRe)) {
      const key = m[1];
      const val = m[2] ?? m[3] ?? m[4] ?? "";
      if (key === "id") id = val;
      else attrs[key] = val;
    }
    for (const tok of tail.split(/\s+/)) {
      if (tok.startsWith(".")) {
        for (const chunk of tok.slice(1).split(".")) {
          if (chunk) classes.push(chunk.toLowerCase());
        }
      } else if (tok.startsWith("#") && tok.length > 1) {
        id = tok.slice(1);
      }
    }
  }

  return {
    classes: classes.length ? [...new Set(classes)] : ["unknown"],
    attrs,
    ...(id ? { id } : {}),
    shorthand,
  };
}

export function normalizeFenceLines(lines: string[]): string[] {
  const result: string[] = [];
  for (const line of lines) {
    const stripped = line.trim();
    const mSingle = SINGLE_LINE_FENCE_RE.exec(stripped);
    if (mSingle && mSingle[2].trim()) {
      result.push(mSingle[1], mSingle[2].trim(), ":::");
      continue;
    }
    const mInline = INLINE_CONTENT_FENCE_RE.exec(stripped);
    if (mInline && mInline[2].trim()) {
      result.push(mInline[1], mInline[2].trim());
      continue;
    }
    result.push(line);
  }
  return result;
}

/**
 * The front matter's top-level scalar values as strings (lists and mappings are left out; read those with
 * ai-credit.ts readFrontMatter). Parsed as YAML; a block that isn't valid YAML falls back to `key: value` lines.
 */
export function extractFrontmatter(text: string): { frontmatter: Record<string, string>; bodyStartLine: number; bodyLines: string[] } {
  const lines = text.split(/\r?\n/);
  const frontmatter: Record<string, string> = {};
  if (lines[0]?.trim() === "---") {
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].trim() === "---" || lines[i].trim() === "...") {
        const yamlLines = lines.slice(1, i);
        const doc = parseYamlDocument(yamlLines.join("\n"));
        const data = doc.errors.length ? undefined : doc.toJS();
        if (data && typeof data === "object" && !Array.isArray(data)) {
          for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
            if (typeof value === "string") frontmatter[key] = value.trim();
            else if (typeof value === "number" || typeof value === "boolean") frontmatter[key] = String(value);
            else if (value instanceof Date) frontmatter[key] = value.toISOString().slice(0, 10);
          }
        } else {
          for (const line of yamlLines) {
            const m = /^([\w-]+)\s*:\s*(.*)$/.exec(line);
            if (m) frontmatter[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
          }
        }
        return { frontmatter, bodyStartLine: i + 2, bodyLines: lines.slice(i + 1) };
      }
    }
  }
  return { frontmatter, bodyStartLine: 1, bodyLines: lines };
}

export function parseMarkdownFences(lines: string[], startIndex = 0, lineOffset = 1): {
  nodes: AstNode[];
  nextIndex: number;
  closed: boolean;
  extraClosers: number[];
} {
  const nodes: AstNode[] = [];
  const extraClosers: number[] = [];
  let i = startIndex;
  let inCodeBlock = false;

  while (i < lines.length) {
    const line = lines[i];
    const stripped = line.trim();

    if (/^(`{3,}|~{3,})/.test(stripped)) {
      inCodeBlock = !inCodeBlock;
      nodes.push({ kind: "text", text: line, line: lineOffset + i });
      i++;
      continue;
    }

    if (!inCodeBlock && FENCE_CLOSER_RE.test(stripped)) {
      if (startIndex > 0) {
        return { nodes, nextIndex: i + 1, closed: true, extraClosers };
      }
      extraClosers.push(lineOffset + i);
      nodes.push({ kind: "text", text: line, line: lineOffset + i });
      i++;
      continue;
    }

    if (!inCodeBlock) {
      const header = parseFenceHeader(line);
      if (header) {
        const openLine = lineOffset + i;
        const inner = parseMarkdownFences(lines, i + 1, lineOffset);
        extraClosers.push(...inner.extraClosers);
        nodes.push({
          kind: "fence",
          classes: header.classes,
          attrs: header.attrs,
          ...(header.id ? { id: header.id } : {}),
          shorthand: header.shorthand,
          startLine: openLine,
          endLine: lineOffset + inner.nextIndex - 1,
          ...(inner.closed ? {} : { unclosed: true }),
          children: inner.nodes,
        });
        i = inner.nextIndex;
        continue;
      }
    }

    nodes.push({ kind: "text", text: line, line: lineOffset + i });
    i++;
  }

  return { nodes, nextIndex: i, closed: false, extraClosers };
}

const CONTAINER_CSS = (s: GhostStyle) =>
  `background-color: ${s.bg}; border-left: 4px solid ${s.border}; padding: 14px 18px; margin: 18px 0; border-radius: 0 6px 6px 0; font-family: Georgia, 'Times New Roman', serif; line-height: 1.5;`;

const BADGE_CSS = (s: GhostStyle) =>
  `display: inline-block; background-color: ${s.badgeBg}; color: ${s.badgeFg}; font-size: 0.68em; font-weight: bold; text-transform: uppercase; letter-spacing: 0.1em; padding: 2px 9px; border-radius: 3px; margin-bottom: 4px; font-family: 'Helvetica Neue', Arial, sans-serif;`;

const GHOST_DELIVERY_SLUGS: Record<string, string> = {
  "front-matter": "front-matter",
  frontmatter: "front-matter",
  series: "series",
  part: "part",
  chapter: "chapter",
  section: "section",
  interlude: "interlude",
  bridge: "bridge",
  bridgehead: "bridge",
  sidebar: "sidebar",
  aside: "sidebar",
  "sidebar-inline": "sidebar-inline",
  callout: "callout",
  note: "note",
  footnote: "footnote",
  endnotes: "endnotes",
  footnotes: "endnotes",
  epigraph: "epigraph",
  "epigraph-inline": "epigraph-inline",
  appendix: "appendix",
  "back-matter": "back-matter",
  backmatter: "back-matter",
};

const GHOST_MODIFIER_SLUGS: Record<string, string> = {
  thesis: "thesis",
  claim: "claim",
  counterpoint: "counterpoint",
  qualification: "qualification",
  implication: "implication",
  synthesis: "synthesis",
  integration: "integration",
  contrast: "contrast",
  reflection: "reflection",
  provocation: "provocation",
  example: "example",
  "case-study": "case-study",
  background: "background",
  context: "context",
  definition: "definition",
  gloss: "gloss",
  analogy: "analogy",
  insight: "insight",
  "insight-major": "insight-major",
  idea: "idea",
  usage: "usage",
  methodology: "methodology",
  diagnostic: "diagnostic",
  checklist: "checklist",
  warning: "warning",
  notice: "notice",
  caution: "caution",
  misuse: "misuse",
  assumption: "assumption",
  limitation: "limitation",
  scope: "scope",
  uncertainty: "uncertainty",
  disclosure: "disclosure",
  ai: "disclosure",
  responsibility: "responsibility",
  reflexive: "reflexive",
  breadcrumb: "breadcrumb",
  navigation: "navigation",
  orientation: "navigation",
  transition: "transition",
  prelude: "prelude",
  closing: "closing",
};

export interface BlockProvenanceExtras {
  attrs?: Record<string, string>;
  quoteInfo?: QuoteProvenance | ParsedQuoteMarker;
  manifest?: ProvenanceManifest;
}

export function buildExternalConceptAttributes(extras: BlockProvenanceExtras = {}): string[] {
  const { attrs = {}, quoteInfo, manifest } = extras;
  const parts: string[] = [];

  if (quoteInfo) {
    parts.push(`data-quote-id="${quoteInfo.id}"`);
    if (quoteInfo.citekey) parts.push(`data-citekey="${quoteInfo.citekey}"`);
    if (quoteInfo.workKey) parts.push(`data-work-key="${quoteInfo.workKey}"`);
    if (quoteInfo.locator) parts.push(`data-quote-locator="${quoteInfo.locator}"`);
  }

  const rawTokens: string[] = [];
  const seen = new Set<string>();
  const addToken = (tok: string) => {
    const parsed = parseConceptToken(tok);
    if (parsed && !seen.has(parsed.raw)) {
      seen.add(parsed.raw);
      rawTokens.push(parsed.raw);
    }
  };

  for (const c of quoteInfo?.concepts ?? []) addToken(c);
  for (const key of ["concepts", "concept", "data-concepts"]) {
    if (attrs[key]) {
      for (const c of splitConceptList(attrs[key])) addToken(c.raw);
    }
  }

  if (!rawTokens.length) return parts;

  const resolved: ExternalConceptRef[] = rawTokens.map((raw) => {
    if (manifest?.concepts[raw]) return manifest.concepts[raw];
    const p = parseConceptToken(raw)!;
    return defaultConceptRef(p.scheme, p.slug);
  });

  const rawList = resolved.map((r) => r.raw).join(" ");
  const uriList = resolved.map((r) => r.uri).join(" ");
  const termList = resolved.map((r) => r.publicUrl).join(" ");
  parts.push(`about="${uriList}"`);
  parts.push(`data-concepts="${rawList}"`);
  parts.push(`data-concept-uris="${uriList}"`);
  parts.push(`data-concept-terms="${termList}"`);
  return parts;
}

export function buildSkosBlockAttributes(classes: string[] = [], extras: BlockProvenanceExtras = {}): string {
  const extParts = buildExternalConceptAttributes(extras);
  if (!classes.length) {
    return extParts.length ? [`vocab="http://www.w3.org/2004/02/skos/core#"`, ...extParts].join(" ") : "";
  }
  let deliverySlug: string | null = null;
  const modifierSlugs: string[] = [];
  const hasInsight = classes.includes("insight");
  const hasMajor = classes.includes("major");

  for (const raw of classes) {
    const cls = raw.toLowerCase();
    const dSlug = GHOST_DELIVERY_SLUGS[cls];
    if (dSlug) {
      if (!deliverySlug) {
        deliverySlug = dSlug;
      } else if (dSlug === "bridge" && deliverySlug === "note" && !modifierSlugs.includes("bridge")) {
        modifierSlugs.push("bridge");
      }
    } else if (cls === "insight" && hasInsight && hasMajor) {
      if (!modifierSlugs.includes("insight-major")) modifierSlugs.push("insight-major");
    } else if (cls === "major" && hasInsight) {
      // handled above as insight-major
    } else {
      const mSlug = GHOST_MODIFIER_SLUGS[cls];
      if (mSlug && !modifierSlugs.includes(mSlug)) {
        modifierSlugs.push(mSlug);
      }
    }
  }

  const conceptSlugs = [...(deliverySlug ? [deliverySlug] : []), ...modifierSlugs];
  const classAttr = `class="${classes.join(" ")}"`;
  if (!conceptSlugs.length) {
    return [classAttr, ...(extParts.length ? [`vocab="http://www.w3.org/2004/02/skos/core#"`, ...extParts] : [])].join(" ");
  }

  const urns = conceptSlugs.map((s) => `urn:iasp:concept:${s}`);
  const termUrls = conceptSlugs.map((s) => `https://vocabulary.majerus.us/api/schemes/iasp/slugs/${s}`);
  const primaryUrn = urns[urns.length - 1];

  const parts = [
    classAttr,
    `vocab="http://www.w3.org/2004/02/skos/core#"`,
    `typeof="Concept"`,
    `resource="${primaryUrn}"`,
  ];
  if (deliverySlug) parts.push(`data-iasp-delivery="${deliverySlug}"`);
  if (modifierSlugs.length) parts.push(`data-iasp-modifiers="${modifierSlugs.join(" ")}"`);
  parts.push(`data-iasp-concepts="${urns.join(" ")}"`);
  parts.push(`data-iasp-terms="${termUrls.join(" ")}"`);
  parts.push(...extParts);
  return parts.join(" ");
}

export function wrapGhostBlock(
  innerMd: string,
  style: GhostStyle,
  noBadge = false,
  classes: string[] = [],
  extras: BlockProvenanceExtras = {},
): string {
  const skosAttrs = buildSkosBlockAttributes(classes, extras);
  const opened = `<div ${skosAttrs ? `${skosAttrs} ` : ""}style="${CONTAINER_CSS(style)}">`;
  let header: string;
  if (noBadge) {
    header = `\n${opened}`;
  } else if (style.glyphOnly) {
    header = `\n${opened}\n<p style="margin: 0 0 4px 0; font-size: 1.1em;">${style.glyph}</p>`;
  } else {
    header = `\n${opened}\n<div style="${BADGE_CSS(style)}">${style.glyph} ${style.label}</div>`;
  }
  return `${header}\n\n${innerMd.trim()}\n\n</div>\n`;
}

export function wrapGhostEpigraph(innerMd: string, classes: string[] = ["epigraph"], extras: BlockProvenanceExtras = {}): string {
  // The epigraph is already rendered as a blockquote; drop an author-written "> " level so it doesn't nest.
  const lines = innerMd
    .trim()
    .split(/\r?\n/)
    .map((l) => l.replace(/^(\s*)>[ \t]?/, "$1"));
  const quoted = lines.map((l) => (l.trim() ? `> ${l}` : ">")).join("\n");
  const skosAttrs = buildSkosBlockAttributes(classes, extras);
  if (skosAttrs && (extras.quoteInfo || (extras.attrs && (extras.attrs.concepts || extras.attrs.concept)))) {
    return `\n<div ${skosAttrs}>\n\n${quoted}\n\n</div>\n`;
  }
  return `\n${quoted}\n`;
}

export function wrapMarkdownBlock(innerMd: string, style: GhostStyle, noBadge = false): string {
  const lines = innerMd.trim().split(/\r?\n/);
  if (noBadge) {
    const quoted = lines.map((l) => (l.trim() ? `> ${l}` : ">"));
    return `\n${quoted.join("\n")}\n`;
  }
  if (style.glyphOnly) {
    const first = lines[0] ?? "";
    const canInline = first.length > 0 && !/^(#{1,6}\s|[-*+]\s|\d+\.\s|>)/.test(first.trim());
    if (canInline) {
      const rest = lines.slice(1).map((l) => (l.trim() ? `> ${l}` : ">"));
      return `\n${[`> ${style.glyph} ${first}`, ...rest].join("\n")}\n`;
    }
    const quoted = lines.map((l) => (l.trim() ? `> ${l}` : ">"));
    return `\n> ${style.glyph}\n>\n${quoted.join("\n")}\n`;
  }
  const quoted = lines.map((l) => (l.trim() ? `> ${l}` : ">"));
  return `\n> **${style.glyph} ${style.label}**\n>\n${quoted.join("\n")}\n`;
}

export interface AiDisclosureMetadata {
  turns?: number;
  turns_fuzzy_min?: number;
  turns_fuzzy_max?: number;
  turns_bucket_override?: string;
  disclosure_variant?: string;
  ai_disclosure?: string;
  technical_note?: string;
}

export function turnBucketLabel(turnCount: number): string {
  if (turnCount <= 5) return "a few";
  if (turnCount <= 9) return "several";
  if (turnCount <= 18) return "around a dozen";
  if (turnCount <= 48) return "a few dozen";
  return "dozens of";
}

export function buildTurnTokens(metadata: AiDisclosureMetadata): Record<string, string> {
  const turns = Math.max(0, Number.isFinite(Number(metadata.turns)) ? Math.trunc(Number(metadata.turns)) : 0);
  let fuzzyMin = metadata.turns_fuzzy_min !== undefined ? Math.max(0, Math.trunc(Number(metadata.turns_fuzzy_min))) : undefined;
  let fuzzyMax = metadata.turns_fuzzy_max !== undefined ? Math.max(0, Math.trunc(Number(metadata.turns_fuzzy_max))) : undefined;
  let fuzzy = "";
  let representative = turns;

  if (fuzzyMin !== undefined && fuzzyMax !== undefined && !Number.isNaN(fuzzyMin) && !Number.isNaN(fuzzyMax)) {
    if (fuzzyMax < fuzzyMin) [fuzzyMin, fuzzyMax] = [fuzzyMax, fuzzyMin];
    if (fuzzyMin === fuzzyMax) {
      fuzzy = `~${fuzzyMin}`;
      representative = fuzzyMin;
    } else {
      fuzzy = `~${fuzzyMin}-${fuzzyMax}`;
      representative = Math.max(0, Math.floor((fuzzyMin + fuzzyMax) / 2));
    }
  }

  const turnsDisplay = fuzzy || String(turns);
  const override = metadata.turns_bucket_override?.trim() ?? "";
  const turnsBucket = override || turnBucketLabel(representative);
  const turnsBucketPhrase = /\bturns?\b/i.test(turnsBucket) ? turnsBucket : `${turnsBucket} turns`;

  return {
    turns: String(turns),
    turns_exact: String(turns),
    turns_fuzzy: fuzzy,
    turns_display: turnsDisplay,
    turns_bucket: turnsBucket,
    turns_bucket_phrase: turnsBucketPhrase,
  };
}

export function formatDisclosureLine(template: string, tokens: Record<string, string>): string {
  let line = template;
  for (const [key, value] of Object.entries(tokens)) {
    line = line.replaceAll(`{${key}}`, value);
  }
  return line;
}

export function injectAiDisclosures(
  body: string,
  metadata: AiDisclosureMetadata,
  mode: "ghost" | "md" = "ghost",
): string {
  if (!metadata || Object.keys(metadata).length === 0) return body;
  const tokens = buildTurnTokens(metadata);
  const paragraphs: string[] = [];
  if (metadata.ai_disclosure?.trim()) paragraphs.push(formatDisclosureLine(metadata.ai_disclosure.trim(), tokens));
  if (metadata.technical_note?.trim()) paragraphs.push(formatDisclosureLine(metadata.technical_note.trim(), tokens));
  return injectDisclosureBlock(body, { paragraphs, variant: metadata.disclosure_variant ?? "ai", position: "end" }, mode);
}

/** A resolved AI disclosure block (see ai-credit.ts): its paragraphs, box variant, and where it goes. */
export interface DisclosureBlock {
  paragraphs: string[];
  variant: string;
  /** "top": after the leading `# Title` (or at the top); "end": before Works Cited / References / Bibliography, or at the end. */
  position: "top" | "end" | null;
}

export function injectDisclosureBlock(body: string, block: DisclosureBlock, mode: "ghost" | "md" = "ghost"): string {
  if (!block.position || !block.paragraphs.length) return body;
  if (body.includes("AI Disclosure:") || body.includes("Technical Note:")) return body;

  const variantKey = block.variant.trim().toLowerCase() || "ai";
  const style = NOTE_VARIANT_SPECS[variantKey]?.ghost ?? NOTE_VARIANT_SPECS.ai.ghost;
  const text = block.paragraphs.join("\n\n");
  const wrapped = mode === "md" ? wrapMarkdownBlock(text, style) : wrapGhostBlock(text, style, false, ["note", variantKey]);

  const bodyLines = body.split(/\r?\n/);
  let insertAt = block.position === "top" ? 0 : bodyLines.length;
  if (block.position === "top") {
    for (let i = 0; i < bodyLines.length; i++) {
      const t = bodyLines[i].trim();
      if (!t || /^<!--.*-->$/.test(t)) continue;
      if (/^#[ \t]+\S/.test(t)) insertAt = i + 1;
      break;
    }
  } else {
    for (let i = 0; i < bodyLines.length; i++) {
      if (WORKS_CITED_HEADING_RE.test(bodyLines[i])) {
        insertAt = i;
        break;
      }
    }
  }

  const lines = ["", ...wrapped.trim().split(/\r?\n/), ""];
  return [...bodyLines.slice(0, insertAt), ...lines, ...bodyLines.slice(insertAt)].join("\n");
}

function detectNoteVariantKey(classes: string[]): string {
  if (classes.includes("insight") && classes.includes("major")) return "insight-major";
  for (const key of Object.keys(NOTE_VARIANT_SPECS)) {
    if (classes.includes(key)) return key;
  }
  return "insight";
}

export interface GhostRenderOptions {
  rootDir?: string;
  baseDir?: string;
  stage?: "final" | "draft";
  mode?: "ghost" | "md";
  metadata?: Record<string, string>;
  /** Legacy `.ai.json` metadata, printed as an end-of-article box (used only when `disclosure` is not given). */
  aiMetadata?: AiDisclosureMetadata;
  /** The resolved AI disclosure block (ai-credit.ts resolveAiDisclosure); it replaces `aiMetadata`. */
  disclosure?: DisclosureBlock;
  provenanceManifest?: ProvenanceManifest;
  /** Ghost mode only: keep the leading `# Title` H1 (default false, since Ghost's title field already shows it). */
  keepTitleH1?: boolean;
}

/** Remove a level-1 ATX heading when it is the first content line (blank lines and HTML comments may precede it). */
export function stripLeadingTitleH1(body: string): string {
  const lines = body.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t || /^<!--.*-->$/.test(t)) continue;
    if (/^#[ \t]+\S/.test(t)) {
      const drop = i + 1 < lines.length && !lines[i + 1].trim() ? 2 : 1;
      lines.splice(i, drop);
    }
    break;
  }
  return lines.join("\n");
}

export function renderGhostMarkdown(markdown: string, options: GhostRenderOptions = {}): string {
  const rootDir = options.rootDir ?? PROJECT_ROOT;
  const baseDir = options.baseDir ?? rootDir;
  const stage = options.stage ?? "final";
  const mode = options.mode ?? "ghost";
  const manifest = options.provenanceManifest;
  const wrapBlock = (
    innerMd: string,
    style: GhostStyle,
    noBadge = false,
    blockClasses: string[] = [],
    extras: BlockProvenanceExtras = {},
  ) =>
    mode === "md"
      ? wrapMarkdownBlock(innerMd, style, noBadge)
      : wrapGhostBlock(innerMd, style, noBadge, blockClasses, extras);
  const { frontmatter, bodyLines } = extractFrontmatter(markdown);
  const meta = { ...frontmatter, ...(options.metadata ?? {}) };

  const replaceMeta = (line: string) =>
    line.replace(/\{\{\s*meta:([\w_.-]+)\s*\}\}/g, (full, key: string) => meta[key] ?? full);

  const normalized = normalizeFenceLines(bodyLines.map(replaceMeta));
  const { nodes } = parseMarkdownFences(normalized);

  const includeStack = new Set<string>();

  const resolveQuoteMarker = (marker: ParsedQuoteMarker): QuoteProvenance | ParsedQuoteMarker => {
    const fromManifest = manifest?.quotes[String(marker.id)];
    if (!fromManifest) return marker;
    return {
      id: marker.id,
      citekey: marker.citekey ?? fromManifest.citekey,
      workKey: marker.workKey ?? fromManifest.workKey,
      workTitle: fromManifest.workTitle,
      locator: marker.locator ?? fromManifest.locator,
      concepts: [...new Set([...fromManifest.concepts, ...marker.concepts])],
    };
  };

  // One `iasp-quote` wrapper per marker, the first marker outermost.
  const wrapQuotes = (content: string, quotes: Array<QuoteProvenance | ParsedQuoteMarker>): string =>
    quotes.reduceRight(
      (inner, q) => `<div ${buildSkosBlockAttributes(["iasp-quote"], { quoteInfo: q, manifest })}>\n\n${inner}\n\n</div>`,
      content,
    );

  const renderNodes = (nodeList: AstNode[], currentBaseDir: string): string => {
    const parts: string[] = [];
    // Markers waiting for the block they mark. Markers on consecutive lines all mark the same block.
    // Any block consumes them, so a marker never reaches past the block right after it.
    let pendingQuotes: Array<QuoteProvenance | ParsedQuoteMarker> = [];

    // Consecutive text lines from `idx` for which `keep` holds.
    const collect = (idx: number, keep: (line: string) => boolean): string[] => {
      const lines: string[] = [];
      for (let k = idx; k < nodeList.length && nodeList[k].kind === "text" && keep((nodeList[k] as TextLineNode).text); k++) {
        lines.push((nodeList[k] as TextLineNode).text);
      }
      return lines;
    };

    for (let idx = 0; idx < nodeList.length; idx++) {
      const node = nodeList[idx];
      if (node.kind === "text") {
        const qm = parseQuoteMarkerComment(node.text);
        if (qm) {
          pendingQuotes.push(resolveQuoteMarker(qm));
          parts.push(node.text);
          continue;
        }
        if (!pendingQuotes.length || node.text.trim() === "") {
          parts.push(node.text);
          continue;
        }
        const quotes = pendingQuotes;
        pendingQuotes = [];
        let block: string[];
        if (node.text.trim().startsWith(">")) {
          block = collect(idx, (l) => l.trim().startsWith(">"));
        } else if (startsRunIn(node.text)) {
          // A run-in quote: the paragraph that quotes the marked words.
          // It ends where Ghost ends it: at a blank line, a marker, or a line that starts another block.
          const lines = [node.text, ...collect(idx + 1, (l) => l.trim() !== "" && !parseQuoteMarkerComment(l) && !PARAGRAPH_INTERRUPT_RE.test(l) && !SETEXT_UNDERLINE_RE.test(l))];
          const after = nodeList[idx + lines.length];
          if (after?.kind === "text" && SETEXT_UNDERLINE_RE.test(after.text)) {
            // `===` or `---` under the lines makes them a Setext heading, not a paragraph: the markers lapse.
            parts.push(node.text);
            continue;
          }
          block = lines;
        } else {
          // A heading, list, table, code, or raw HTML: not a quoted passage, so the markers lapse.
          parts.push(node.text);
          continue;
        }
        idx += block.length - 1;
        parts.push(mode === "ghost" ? wrapQuotes(block.join("\n"), quotes) : block.join("\n"));
      } else {
        if (!pendingQuotes.length || node.classes.includes("article") || node.classes.includes("include")) {
          pendingQuotes = [];
          parts.push(renderFence(node, currentBaseDir));
          continue;
        }
        // The marker nearest the fence binds to its container; any earlier ones wrap it.
        const quotes = pendingQuotes;
        pendingQuotes = [];
        const rendered = renderFence(node, currentBaseDir, quotes[quotes.length - 1]);
        parts.push(mode === "ghost" && quotes.length > 1 && rendered.trim() ? wrapQuotes(rendered, quotes.slice(0, -1)) : rendered);
      }
    }
    return parts.join("\n");
  };

  const renderFence = (
    fence: FenceAstNode,
    currentBaseDir: string,
    quoteInfo?: QuoteProvenance | ParsedQuoteMarker,
  ): string => {
    const { classes, attrs } = fence;

    // Stage filtering (.draft vs .final)
    if (classes.includes("draft") && stage !== "draft") return "";
    if (classes.includes("final") && stage === "draft") return "";

    if (classes.includes("include")) {
      const transferred = classes.filter((c) => ["nobadge", "no-badge", "noglyph", "no-glyph"].includes(c));
      return resolveInclude(attrs, currentBaseDir, transferred);
    }

    if (classes.includes("article")) {
      return renderNodes(fence.children, currentBaseDir);
    }

    const noBadge = classes.includes("nobadge") || classes.includes("no-badge") || classes.includes("badge-off");
    const inner = renderNodes(fence.children, currentBaseDir);
    const extras: BlockProvenanceExtras = { attrs, quoteInfo, manifest };

    if (classes.includes("note")) {
      const variant = detectNoteVariantKey(classes);
      const style = NOTE_VARIANT_SPECS[variant]?.ghost ?? NOTE_VARIANT_SPECS.insight.ghost;
      return wrapBlock(inner, style, noBadge, classes, extras);
    }

    if (classes.some((c) => ["sidebar", "sidebar-block", "aside", "sidebar-inline"].includes(c))) {
      return wrapBlock(inner, SIDEBAR_GHOST_STYLE, noBadge, classes, extras);
    }

    if (classes.includes("callout")) {
      return wrapBlock(inner, CALLOUT_GHOST_STYLE, noBadge, classes, extras);
    }

    if (classes.includes("bridge") || classes.includes("bridgehead")) {
      return wrapBlock(inner, BRIDGE_GHOST_STYLE, noBadge, classes, extras);
    }

    if (classes.includes("example")) {
      return wrapBlock(inner, EXAMPLE_GHOST_STYLE, noBadge, classes, extras);
    }

    if (classes.includes("definition")) {
      return wrapBlock(inner, DEFINITION_GHOST_STYLE, noBadge, classes, extras);
    }

    if (classes.includes("epigraph") || classes.includes("epigraph-inline")) {
      return mode === "md"
        ? wrapGhostEpigraph(inner)
        : wrapGhostEpigraph(inner, classes, extras);
    }

    return inner;
  };

  const resolveInclude = (attrs: Record<string, string>, currentBaseDir: string, extraClasses: string[]): string => {
    const pathStr = attrs.path ?? attrs.src ?? attrs.file ?? "";
    if (!pathStr) return "<!-- empty include path -->";

    const candidateRoot = resolve(rootDir, pathStr);
    const candidateRel = resolve(currentBaseDir, pathStr);
    const incPath = existsSync(candidateRoot) ? candidateRoot : existsSync(candidateRel) ? candidateRel : null;
    if (!incPath) return `<!-- include not found: ${pathStr} -->`;
    if (includeStack.has(incPath)) return `<!-- recursive include blocked: ${pathStr} -->`;

    includeStack.add(incPath);
    try {
      const incText = readFileSync(incPath, "utf8");
      const { bodyLines: incLines } = extractFrontmatter(incText);
      const { nodes: incNodes } = parseMarkdownFences(normalizeFenceLines(incLines.map(replaceMeta)));
      if (extraClasses.length) {
        for (const node of incNodes) {
          if (node.kind === "fence") {
            for (const cls of extraClasses) {
              if (!node.classes.includes(cls)) node.classes.push(cls);
            }
            break;
          }
        }
      }
      return renderNodes(incNodes, dirname(incPath));
    } finally {
      includeStack.delete(incPath);
    }
  };

  const renderedNodes = renderNodes(nodes, baseDir);
  const renderedBody = mode === "ghost" && !options.keepTitleH1 ? stripLeadingTitleH1(renderedNodes) : renderedNodes;
  const withDisclosures = options.disclosure
    ? injectDisclosureBlock(renderedBody, options.disclosure, mode)
    : options.aiMetadata
      ? injectAiDisclosures(renderedBody, options.aiMetadata, mode)
      : renderedBody;
  return mode === "md" ? `${withDisclosures.trim().replace(/\n{3,}/g, "\n\n")}\n` : withDisclosures;
}

export function renderCleanMarkdown(markdown: string, options: Omit<GhostRenderOptions, "mode"> = {}): string {
  return renderGhostMarkdown(markdown, { ...options, mode: "md" });
}

export function exportGhostFile(inputPath: string, outputPath?: string, options: Omit<GhostRenderOptions, "baseDir"> = {}): {
  inputPath: string;
  outputPath: string;
  content: string;
} {
  const absInput = resolve(options.rootDir ?? PROJECT_ROOT, inputPath);
  const text = readFileSync(absInput, "utf8");
  const sidecarPath = absInput.replace(/\.(md|markdown)$/i, ".ai.json");
  let aiMetadata = options.aiMetadata;
  if (!aiMetadata && existsSync(sidecarPath)) {
    try {
      aiMetadata = JSON.parse(readFileSync(sidecarPath, "utf8")) as AiDisclosureMetadata;
    } catch {
      aiMetadata = undefined;
    }
  }

  const content = renderGhostMarkdown(text, {
    ...options,
    baseDir: dirname(absInput),
    aiMetadata,
  });

  const stem = absInput.replace(/^.*[/\\]/, "").replace(/\.(md|markdown)$/i, "");
  const absOutput = outputPath
    ? resolve(options.rootDir ?? PROJECT_ROOT, outputPath)
    : resolve(options.rootDir ?? PROJECT_ROOT, "build/ghost", `${stem}-ghost.md`);

  mkdirSync(dirname(absOutput), { recursive: true });
  writeFileSync(absOutput, content, "utf8");
  return { inputPath: absInput, outputPath: absOutput, content };
}
