import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { PROJECT_ROOT } from "./db.js";
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

export function extractFrontmatter(text: string): { frontmatter: Record<string, string>; bodyStartLine: number; bodyLines: string[] } {
  const lines = text.split(/\r?\n/);
  const frontmatter: Record<string, string> = {};
  if (lines[0]?.trim() === "---") {
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].trim() === "---" || lines[i].trim() === "...") {
        for (let j = 1; j < i; j++) {
          const m = /^([\w-]+)\s*:\s*(.*)$/.exec(lines[j]);
          if (m) {
            frontmatter[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
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
  `background-color: ${s.bg}; border-left: 4px solid ${s.border}; padding: 16px 20px; margin: 20px 0; border-radius: 0 6px 6px 0; font-family: Georgia, 'Times New Roman', serif; line-height: 1.5;`;

const BADGE_CSS = (s: GhostStyle) =>
  `display: inline-block; background-color: ${s.badgeBg}; color: ${s.badgeFg}; font-size: 0.68em; font-weight: bold; text-transform: uppercase; letter-spacing: 0.1em; padding: 3px 10px; border-radius: 3px; margin-bottom: 10px; font-family: 'Helvetica Neue', Arial, sans-serif;`;

export function wrapGhostBlock(innerMd: string, style: GhostStyle, noBadge = false): string {
  const opened = `<div style="${CONTAINER_CSS(style)}">`;
  let header: string;
  if (noBadge) {
    header = `\n${opened}`;
  } else if (style.glyphOnly) {
    header = `\n${opened}\n<p style="margin: 0 0 8px 0; font-size: 1.1em;">${style.glyph}</p>`;
  } else {
    header = `\n${opened}\n<div style="${BADGE_CSS(style)}">${style.glyph} ${style.label}</div>`;
  }
  return `${header}\n\n${innerMd.trim()}\n\n</div>\n`;
}

export function wrapGhostEpigraph(innerMd: string): string {
  const lines = innerMd.trim().split(/\r?\n/);
  const quoted = lines.map((l) => (l.trim() ? `> ${l}` : ">"));
  return `\n${quoted.join("\n")}\n`;
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
  if (body.includes("AI Disclosure:") || body.includes("Technical Note:")) return body;

  const tokens = buildTurnTokens(metadata);
  const lines: string[] = [];
  if (metadata.ai_disclosure?.trim()) {
    lines.push(formatDisclosureLine(metadata.ai_disclosure.trim(), tokens));
  }
  if (metadata.technical_note?.trim()) {
    lines.push(formatDisclosureLine(metadata.technical_note.trim(), tokens));
  }
  if (!lines.length) return body;

  const variantKey = (metadata.disclosure_variant ?? "ai").trim().toLowerCase();
  const style = NOTE_VARIANT_SPECS[variantKey]?.ghost ?? NOTE_VARIANT_SPECS.ai.ghost;
  const wrapped =
    mode === "md" ? wrapMarkdownBlock(lines.join("\n\n"), style) : wrapGhostBlock(lines.join("\n\n"), style);

  const bodyLines = body.split(/\r?\n/);
  let insertAt = bodyLines.length;
  for (let i = 0; i < bodyLines.length; i++) {
    if (WORKS_CITED_HEADING_RE.test(bodyLines[i])) {
      insertAt = i;
      break;
    }
  }

  const block = ["", ...wrapped.trim().split(/\r?\n/), ""];
  return [...bodyLines.slice(0, insertAt), ...block, ...bodyLines.slice(insertAt)].join("\n");
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
  aiMetadata?: AiDisclosureMetadata;
}

export function renderGhostMarkdown(markdown: string, options: GhostRenderOptions = {}): string {
  const rootDir = options.rootDir ?? PROJECT_ROOT;
  const baseDir = options.baseDir ?? rootDir;
  const stage = options.stage ?? "final";
  const mode = options.mode ?? "ghost";
  const wrapBlock = mode === "md" ? wrapMarkdownBlock : wrapGhostBlock;
  const { frontmatter, bodyLines } = extractFrontmatter(markdown);
  const meta = { ...frontmatter, ...(options.metadata ?? {}) };

  const replaceMeta = (line: string) =>
    line.replace(/\{\{\s*meta:([\w_.-]+)\s*\}\}/g, (full, key: string) => meta[key] ?? full);

  const normalized = normalizeFenceLines(bodyLines.map(replaceMeta));
  const { nodes } = parseMarkdownFences(normalized);

  const includeStack = new Set<string>();

  const renderNodes = (nodeList: AstNode[], currentBaseDir: string): string => {
    const parts: string[] = [];
    for (const node of nodeList) {
      if (node.kind === "text") {
        parts.push(node.text);
      } else {
        parts.push(renderFence(node, currentBaseDir));
      }
    }
    return parts.join("\n");
  };

  const renderFence = (fence: FenceAstNode, currentBaseDir: string): string => {
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

    if (classes.includes("note")) {
      const variant = detectNoteVariantKey(classes);
      const style = NOTE_VARIANT_SPECS[variant]?.ghost ?? NOTE_VARIANT_SPECS.insight.ghost;
      return wrapBlock(inner, style, noBadge);
    }

    if (classes.some((c) => ["sidebar", "sidebar-block", "aside", "sidebar-inline"].includes(c))) {
      return wrapBlock(inner, SIDEBAR_GHOST_STYLE, noBadge);
    }

    if (classes.includes("callout")) {
      return wrapBlock(inner, CALLOUT_GHOST_STYLE, noBadge);
    }

    if (classes.includes("bridge") || classes.includes("bridgehead")) {
      return wrapBlock(inner, BRIDGE_GHOST_STYLE, noBadge);
    }

    if (classes.includes("example")) {
      return wrapBlock(inner, EXAMPLE_GHOST_STYLE, noBadge);
    }

    if (classes.includes("definition")) {
      return wrapBlock(inner, DEFINITION_GHOST_STYLE, noBadge);
    }

    if (classes.includes("epigraph") || classes.includes("epigraph-inline")) {
      return wrapGhostEpigraph(inner);
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

  const renderedBody = renderNodes(nodes, baseDir);
  const withDisclosures = options.aiMetadata
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
