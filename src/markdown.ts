import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, relative, resolve } from "node:path";
import { type DB, PROJECT_ROOT } from "./db.js";
import {
  type AiDisclosureMetadata,
  type AstNode,
  type FenceAstNode,
  buildTurnTokens,
  extractFrontmatter,
  formatDisclosureLine,
  normalizeFenceLines,
  parseMarkdownFences,
  wrapGhostBlock,
} from "./ghost.js";
import { ToolError, findTermRow, parseNotations } from "./queries.js";
import { parseQuoteMarkerComment, splitConceptList } from "./provenance.js";
import {
  BUILD_MODIFIER_SPECS,
  DIR_WRAPPER_MAP,
  NOTE_VARIANT_COUNT,
  NOTE_VARIANT_SPECS,
  STANDALONE_MODIFIER_BLOCKS,
} from "./rendering-profile.js";

export interface InspectedBlock {
  start_line: number;
  end_line: number;
  shorthand: boolean;
  classes: string[];
  attributes: Record<string, string>;
  id?: string;
  delivery_role: string | null;
  modifiers: string[];
  build_modifiers: string[];
  external_concepts: string[];
  unknown_classes: string[];
  headings: { level: number; text: string; line: number; classes: string[] }[];
  children: InspectedBlock[];
}

export interface ValidationIssue {
  severity: "error" | "warning" | "info";
  code:
    | "unclosed-fence"
    | "extra-closer"
    | "odd-fence-count"
    | "sidebar-h1"
    | "unknown-class"
    | "retired-term"
    | "alt-label-class"
    | "nested-shorthand"
    | "missing-include"
    | "unstyled-note-modifier"
    | "epigraph-blockquote"
    | "quote-text-differs"
    | "quote-text-unchecked"
    | "quote-citekey-differs"
    | "quote-citation-missing"
    | "quote-locator-differs"
    | "quote-marker-orphan"
    | "unmarked-block-quote";
  line: number;
  message: string;
  suggestion?: string;
}

function classifyClasses(db: DB, classes: string[]) {
  let deliveryRole: string | null = null;
  const modifiers: string[] = [];
  const buildModifiers: string[] = [];
  const unknownClasses: string[] = [];
  const retiredTerms: { token: string; slug: string; replacedBy: string[] }[] = [];
  const altLabelTerms: { token: string; canonical: string }[] = [];

  const hasInsight = classes.includes("insight");
  for (const cls of classes) {
    if (cls === "major" && hasInsight) {
      buildModifiers.push(cls);
      continue;
    }
    const buildSpec = BUILD_MODIFIER_SPECS[cls];
    if (buildSpec && buildSpec.category !== "structural-alias") {
      buildModifiers.push(cls);
      continue;
    }
    const row = findTermRow(db, cls);
    if (row) {
      const notations = parseNotations(row.notations).map((n) => n.toLowerCase());
      if (!notations.includes(cls.toLowerCase()) && row.slug.toLowerCase() !== cls.toLowerCase()) {
        altLabelTerms.push({ token: cls, canonical: notations[0] ?? row.slug });
      }
      if (row.status === "retired") {
        retiredTerms.push({
          token: cls,
          slug: row.slug,
          replacedBy: JSON.parse(row.replaced_by) as string[],
        });
      }
      if (row.axis === "delivery-role") {
        deliveryRole = deliveryRole ?? row.slug;
      } else {
        modifiers.push(row.slug);
        if (!deliveryRole && STANDALONE_MODIFIER_BLOCKS[row.slug]) {
          deliveryRole = row.slug;
        }
      }
      continue;
    }
    if (BUILD_MODIFIER_SPECS[cls]) {
      buildModifiers.push(cls);
      continue;
    }
    unknownClasses.push(cls);
  }

  return { deliveryRole, modifiers, buildModifiers, unknownClasses, retiredTerms, altLabelTerms };
}

function parseHeadingLine(line: string): { level: number; text: string; classes: string[] } | null {
  const m = /^(#{1,6})\s+(.+?)\s*$/.exec(line.trim());
  if (!m) return null;
  const level = m[1].length;
  let text = m[2];
  const classes: string[] = [];
  const attrMatch = /\s*\{([^}]+)\}\s*$/.exec(text);
  if (attrMatch) {
    text = text.slice(0, attrMatch.index).trim();
    for (const part of attrMatch[1].split(/\s+/)) {
      if (part.startsWith(".")) {
        for (const chunk of part.slice(1).split(".")) {
          if (chunk) classes.push(chunk.toLowerCase());
        }
      }
    }
  }
  return { level, text, classes };
}

export function inspectMarkdown(
  db: DB,
  input: { markdown?: string; path?: string; rootDir?: string },
) {
  const rootDir = input.rootDir ?? PROJECT_ROOT;
  let text: string;
  let sourcePath: string | null = null;
  if (input.markdown !== undefined) {
    text = input.markdown;
  } else if (input.path) {
    sourcePath = resolve(rootDir, input.path);
    if (!existsSync(sourcePath)) throw new ToolError(`File not found: ${input.path}`);
    text = readFileSync(sourcePath, "utf8");
  } else {
    throw new ToolError("Provide either `markdown` or `path`.");
  }

  const { frontmatter, bodyStartLine, bodyLines } = extractFrontmatter(text);
  const { nodes } = parseMarkdownFences(normalizeFenceLines(bodyLines), 0, bodyStartLine);

  const includes: { line: number; target: string; mode: string; exists: boolean }[] = [];
  const quoteMarkers: { line: number; id: string; concepts: string[]; citekey?: string; workKey?: string }[] = [];
  const metaPlaceholders = new Set<string>();
  const topHeadings: { level: number; text: string; line: number; classes: string[] }[] = [];

  for (let i = 0; i < bodyLines.length; i++) {
    const line = bodyLines[i];
    for (const m of line.matchAll(/\{\{\s*meta:([\w_.-]+)\s*\}\}/g)) {
      metaPlaceholders.add(m[1]);
    }
    const qm = parseQuoteMarkerComment(line);
    if (qm) {
      quoteMarkers.push({
        line: bodyStartLine + i,
        id: String(qm.id),
        concepts: qm.concepts,
        ...(qm.citekey ? { citekey: qm.citekey } : {}),
        ...(qm.workKey ? { workKey: qm.workKey } : {}),
      });
    }
  }

  const mapFence = (fence: FenceAstNode): InspectedBlock => {
    const classified = classifyClasses(db, fence.classes);
    if (fence.classes.includes("include")) {
      const target = fence.attrs.path ?? fence.attrs.src ?? fence.attrs.file ?? fence.attrs.dir ?? fence.attrs["data-dir"] ?? "";
      const mode = fence.attrs.mode ?? (fence.attrs.dir || fence.attrs["data-dir"] ? "dir" : "file");
      const baseDir = sourcePath ? dirname(sourcePath) : rootDir;
      const exists = Boolean(
        target && (existsSync(resolve(rootDir, target)) || existsSync(resolve(baseDir, target))),
      );
      includes.push({ line: fence.startLine, target, mode, exists });
    }

    const headings: { level: number; text: string; line: number; classes: string[] }[] = [];
    const children: InspectedBlock[] = [];

    for (const child of fence.children) {
      if (child.kind === "text") {
        const h = parseHeadingLine(child.text);
        if (h) headings.push({ ...h, line: child.line });
      } else {
        children.push(mapFence(child));
      }
    }

    const rawConcepts = fence.attrs.concepts ?? fence.attrs.concept ?? fence.attrs["data-concepts"];
    const externalConcepts = splitConceptList(rawConcepts).map((c) => c.raw);

    return {
      start_line: fence.startLine,
      end_line: fence.endLine,
      shorthand: fence.shorthand,
      classes: fence.classes,
      attributes: fence.attrs,
      ...(fence.id ? { id: fence.id } : {}),
      delivery_role: classified.deliveryRole,
      modifiers: classified.modifiers,
      build_modifiers: classified.buildModifiers,
      external_concepts: externalConcepts,
      unknown_classes: classified.unknownClasses,
      headings,
      children,
    };
  };

  const blocks: InspectedBlock[] = [];
  for (const node of nodes) {
    if (node.kind === "fence") {
      blocks.push(mapFence(node));
    } else {
      const h = parseHeadingLine(node.text);
      if (h) topHeadings.push({ ...h, line: node.line });
    }
  }

  return {
    ...(sourcePath ? { path: relative(rootDir, sourcePath) || sourcePath } : {}),
    frontmatter,
    top_headings: topHeadings,
    blocks,
    includes,
    quote_markers: quoteMarkers,
    meta_placeholders: [...metaPlaceholders],
  };
}

export function validateMarkdown(
  db: DB,
  input: { markdown?: string; path?: string; rootDir?: string },
) {
  const rootDir = input.rootDir ?? PROJECT_ROOT;
  let text: string;
  let sourcePath: string | null = null;
  if (input.markdown !== undefined) {
    text = input.markdown;
  } else if (input.path) {
    sourcePath = resolve(rootDir, input.path);
    if (!existsSync(sourcePath)) throw new ToolError(`File not found: ${input.path}`);
    text = readFileSync(sourcePath, "utf8");
  } else {
    throw new ToolError("Provide either `markdown` or `path`.");
  }

  const { bodyStartLine, bodyLines } = extractFrontmatter(text);
  const { nodes, extraClosers } = parseMarkdownFences(bodyLines, 0, bodyStartLine);
  const issues: ValidationIssue[] = [];

  for (const line of extraClosers) {
    issues.push({
      severity: "error",
      code: "extra-closer",
      line,
      message: `Unmatched closing fence ':::' on line ${line} with no corresponding opening fence.`,
      suggestion: "Remove the extra ':::' or add the missing opening '::: {.class}' fence above it.",
    });
  }

  const baseDir = sourcePath ? dirname(sourcePath) : rootDir;

  const walk = (nodeList: AstNode[], depth: number, inSidebar: number | null) => {
    for (const node of nodeList) {
      if (node.kind === "text") {
        const h = parseHeadingLine(node.text);
        if (h) {
          if (inSidebar !== null && h.level === 1) {
            issues.push({
              severity: "warning",
              code: "sidebar-h1",
              line: node.line,
              message: `Level-1 heading ('# ${h.text}') on line ${node.line} inside sidebar block (started line ${inSidebar}).`,
              suggestion: "Use level-2 ('##') or deeper headings inside sidebars; level-1 headers break PDF mdframed badge placement.",
            });
          }
          if (h.classes.length) {
            const c = classifyClasses(db, h.classes);
            for (const unk of c.unknownClasses) {
              issues.push({
                severity: "warning",
                code: "unknown-class",
                line: node.line,
                message: `Heading on line ${node.line} uses unknown class '.${unk}'.`,
                suggestion: "Check list_terms for valid IASP delivery roles, modifiers, and build classes.",
              });
            }
          }
        }
        continue;
      }

      if (node.unclosed) {
        issues.push({
          severity: "error",
          code: "unclosed-fence",
          line: node.startLine,
          message: `Unclosed fenced div ('::: ${node.classes.join(".")}') opened on line ${node.startLine}.`,
          suggestion: "Add a matching closing ':::' on its own line.",
        });
      }

      if (depth > 0 && node.shorthand && Object.keys(node.attrs).length > 0) {
        issues.push({
          severity: "warning",
          code: "nested-shorthand",
          line: node.startLine,
          message: `Shorthand fence with attributes ('::: ${node.classes.join(".")} ...') on line ${node.startLine} is nested inside an outer fenced div.`,
          suggestion: `Use brace syntax '::: {${node.classes.map((c) => `.${c}`).join(" ")} ...}' when nesting a fence with attributes inside another div so Pandoc does not consume the outer closing fence.`,
        });
      }

      const classified = classifyClasses(db, node.classes);
      for (const unk of classified.unknownClasses) {
        issues.push({
          severity: "warning",
          code: "unknown-class",
          line: node.startLine,
          message: `Unknown class '.${unk}' on line ${node.startLine}.`,
          suggestion: "Use list_terms or compose_intent to check valid IASP classes.",
        });
      }
      for (const ret of classified.retiredTerms) {
        issues.push({
          severity: "warning",
          code: "retired-term",
          line: node.startLine,
          message: `Class '.${ret.token}' refers to retired IASP term '${ret.slug}'.`,
          suggestion: ret.replacedBy.length ? `Replace with ${ret.replacedBy.join(", ")}.` : "Choose an active term from list_terms.",
        });
      }
      for (const alt of classified.altLabelTerms) {
        issues.push({
          severity: "info",
          code: "alt-label-class",
          line: node.startLine,
          message: `Class '.${alt.token}' is an alternative label; canonical IASP notation is '.${alt.canonical}'.`,
          suggestion: `Prefer '.${alt.canonical}' for consistency with the iasp concept scheme.`,
        });
      }

      if (node.classes.includes("note") && classified.modifiers.length > 0) {
        const hasStyledVariant =
          (node.classes.includes("insight") && node.classes.includes("major")) ||
          node.classes.some((c) => Boolean(NOTE_VARIANT_SPECS[c]));
        if (!hasStyledVariant) {
          issues.push({
            severity: "info",
            code: "unstyled-note-modifier",
            line: node.startLine,
            message: `Note block on line ${node.startLine} uses modifier(s) (${classified.modifiers.join(", ")}) outside the ${NOTE_VARIANT_COUNT} styled note-variants.`,
            suggestion: "It will render as a plain note box; add .badge if you want a labeled header or choose a member of the note-variants set.",
          });
        }
      }

      if (node.classes.includes("epigraph") || node.classes.includes("epigraph-inline")) {
        const quoted = node.children.find(
          (c): c is Extract<AstNode, { kind: "text" }> => c.kind === "text" && /^\s*>/.test(c.text),
        );
        if (quoted) {
          issues.push({
            severity: "warning",
            code: "epigraph-blockquote",
            line: quoted.line,
            message: `Epigraph block on line ${node.startLine} contains '>' blockquote lines (first on line ${quoted.line}); the epigraph is already rendered as a quotation, so the '>' nests a second blockquote in HTML, PDF, and EPUB.`,
            suggestion: "Write the epigraph lines without the leading '> ' inside the ::: {.epigraph} fence.",
          });
        }
      }

      if (node.classes.includes("include")) {
        const target =
          node.attrs.path ?? node.attrs.src ?? node.attrs.file ?? node.attrs.dir ?? node.attrs["data-dir"] ?? "";
        if (!target) {
          issues.push({
            severity: "error",
            code: "missing-include",
            line: node.startLine,
            message: `Include directive on line ${node.startLine} has no 'path' or 'dir' attribute.`,
            suggestion: `Add path="relative/path.md" or dir="relative/dir".`,
          });
        } else {
          const exists = existsSync(resolve(rootDir, target)) || existsSync(resolve(baseDir, target));
          if (!exists) {
            issues.push({
              severity: "error",
              code: "missing-include",
              line: node.startLine,
              message: `Include target '${target}' on line ${node.startLine} does not exist.`,
              suggestion: `Verify the path relative to ${rootDir} or ${baseDir}.`,
            });
          }
        }
      }

      const isSidebar = node.classes.some((c) => ["sidebar", "sidebar-block", "aside", "sidebar-inline"].includes(c));
      walk(node.children, depth + 1, isSidebar ? node.startLine : inSidebar);
    }
  };

  walk(nodes, 0, null);

  const errorCount = issues.filter((i) => i.severity === "error").length;
  const warningCount = issues.filter((i) => i.severity === "warning").length;

  return {
    ...(sourcePath ? { path: relative(rootDir, sourcePath) || sourcePath } : {}),
    valid: errorCount === 0,
    error_count: errorCount,
    warning_count: warningCount,
    info_count: issues.filter((i) => i.severity === "info").length,
    issues,
  };
}

function semanticTagForPath(filePath: string, rootDir: string): string | null {
  const rel = relative(rootDir, filePath);
  for (const part of rel.split(/[/\\]/)) {
    if (DIR_WRAPPER_MAP[part]) return DIR_WRAPPER_MAP[part];
  }
  return null;
}

export function wrapByDirectory(options: { path: string; apply?: boolean; rootDir?: string }) {
  const rootDir = options.rootDir ?? PROJECT_ROOT;
  const target = resolve(rootDir, options.path);
  if (!existsSync(target)) throw new ToolError(`Path not found: ${options.path}`);
  const apply = options.apply ?? false;

  const files: string[] = [];
  const collect = (p: string) => {
    const st = statSync(p);
    if (st.isDirectory()) {
      for (const entry of readdirSync(p).sort()) {
        if (entry.startsWith(".") || entry === "node_modules" || entry === "build" || entry === "dist") continue;
        collect(resolve(p, entry));
      }
    } else if ([".md", ".markdown"].includes(extname(p).toLowerCase())) {
      files.push(p);
    }
  };
  collect(target);

  const results: {
    file: string;
    desired_wrapper: string;
    status: "unchanged" | "updated" | "would-update";
  }[] = [];

  for (const file of files) {
    const desired = semanticTagForPath(file, rootDir);
    if (!desired) continue;

    const raw = readFileSync(file, "utf8");
    const { frontmatter, bodyStartLine, bodyLines } = extractFrontmatter(raw);
    const allLines = raw.split(/\r?\n/);
    const prefixLines = bodyStartLine > 1 ? allLines.slice(0, bodyStartLine - 1) : [];

    const firstNonEmpty = bodyLines.findIndex((l) => l.trim().length > 0);
    const lastNonEmpty = bodyLines.findLastIndex((l) => l.trim().length > 0);

    let updatedLines: string[] | null = null;
    if (firstNonEmpty === -1) {
      updatedLines = [...prefixLines, desired, ":::", ""];
    } else {
      const firstLine = bodyLines[firstNonEmpty].trim();
      const lastLine = bodyLines[lastNonEmpty].trim();
      if (firstLine === desired && lastLine === ":::") {
        results.push({
          file: relative(rootDir, file) || file,
          desired_wrapper: desired,
          status: "unchanged",
        });
        continue;
      }
      const nextBody = [...bodyLines];
      if (!firstLine.startsWith(":::") || firstLine.includes(".include")) {
        nextBody.splice(firstNonEmpty, 0, desired, "");
        nextBody.push("", ":::");
      } else {
        nextBody[firstNonEmpty] = desired;
        if (lastLine !== ":::") nextBody.push("", ":::");
      }
      updatedLines = [...prefixLines, ...nextBody];
    }

    if (apply && updatedLines) {
      writeFileSync(file, updatedLines.join("\n").replace(/\n*$/, "\n"), "utf8");
    }
    results.push({
      file: relative(rootDir, file) || file,
      desired_wrapper: desired,
      status: apply ? "updated" : "would-update",
    });
    void frontmatter;
  }

  return {
    applied: apply,
    processed: results.length,
    updated: results.filter((r) => r.status !== "unchanged").length,
    files: results,
  };
}

export interface AiDisclosureToolArgs {
  article: string;
  action?: "get" | "update";
  disclosure_variant?: string;
  ai_disclosure?: string;
  technical_note?: string;
  init_defaults?: boolean;
  set_turns?: number;
  inc_turns?: number;
  set_fuzzy_min?: number;
  set_fuzzy_max?: number;
  clear_fuzzy?: boolean;
  set_bucket_override?: string;
  clear_bucket_override?: boolean;
  rootDir?: string;
}

export function manageAiDisclosure(args: AiDisclosureToolArgs) {
  const rootDir = args.rootDir ?? PROJECT_ROOT;
  let articlePath = resolve(rootDir, args.article);
  if (!existsSync(articlePath) && !args.article.endsWith(".md")) {
    const candidate = resolve(rootDir, `${args.article}.md`);
    const demoCandidate = resolve(rootDir, "demo", `${args.article}.md`);
    if (existsSync(candidate)) articlePath = candidate;
    else if (existsSync(demoCandidate)) articlePath = demoCandidate;
  }
  if (!existsSync(articlePath)) {
    throw new ToolError(`Article not found: ${args.article}`);
  }

  const sidecarPath = articlePath.replace(/\.(md|markdown)$/i, ".ai.json");
  let payload: AiDisclosureMetadata = {};
  if (existsSync(sidecarPath)) {
    try {
      payload = JSON.parse(readFileSync(sidecarPath, "utf8")) as AiDisclosureMetadata;
    } catch {
      payload = {};
    }
  }

  if ((args.action ?? "get") === "update") {
    if (args.init_defaults) {
      payload.disclosure_variant ??= "ai";
      payload.ai_disclosure ??=
        "AI Disclosure: This article was developed through iterative collaboration with an AI assistant.";
      payload.technical_note ??=
        "Technical Note: Published via the Informative Authoring Semantics Profile (IASP) build pipeline.";
    }
    if (args.disclosure_variant !== undefined) payload.disclosure_variant = args.disclosure_variant;
    if (args.ai_disclosure !== undefined) payload.ai_disclosure = args.ai_disclosure;
    if (args.technical_note !== undefined) payload.technical_note = args.technical_note;

    let turns = typeof payload.turns === "number" ? payload.turns : 0;
    if (args.set_turns !== undefined) turns = Math.max(0, Math.trunc(args.set_turns));
    if (args.inc_turns !== undefined) turns = Math.max(0, turns + Math.trunc(args.inc_turns));
    if (args.set_turns !== undefined || args.inc_turns !== undefined || payload.turns !== undefined) {
      payload.turns = turns;
    }

    if (args.set_fuzzy_min !== undefined) payload.turns_fuzzy_min = Math.max(0, Math.trunc(args.set_fuzzy_min));
    if (args.set_fuzzy_max !== undefined) payload.turns_fuzzy_max = Math.max(0, Math.trunc(args.set_fuzzy_max));
    if (args.clear_fuzzy) {
      delete payload.turns_fuzzy_min;
      delete payload.turns_fuzzy_max;
    }
    if (
      payload.turns_fuzzy_min !== undefined &&
      payload.turns_fuzzy_max !== undefined &&
      payload.turns_fuzzy_max < payload.turns_fuzzy_min
    ) {
      [payload.turns_fuzzy_min, payload.turns_fuzzy_max] = [payload.turns_fuzzy_max, payload.turns_fuzzy_min];
    }

    if (args.set_bucket_override !== undefined) {
      const cleaned = args.set_bucket_override.trim();
      if (cleaned) payload.turns_bucket_override = cleaned;
      else delete payload.turns_bucket_override;
    }
    if (args.clear_bucket_override) delete payload.turns_bucket_override;

    writeFileSync(sidecarPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  }

  const tokens = buildTurnTokens(payload);
  const previewLines: string[] = [];
  if (payload.ai_disclosure) previewLines.push(formatDisclosureLine(payload.ai_disclosure, tokens));
  if (payload.technical_note) previewLines.push(formatDisclosureLine(payload.technical_note, tokens));
  const variant = (payload.disclosure_variant ?? "ai").toLowerCase();
  const style = NOTE_VARIANT_SPECS[variant]?.ghost ?? NOTE_VARIANT_SPECS.ai.ghost;
  const previewHtml = previewLines.length
    ? wrapGhostBlock(previewLines.join("\n\n"), style, false, ["note", variant]).trim()
    : null;

  return {
    article: relative(rootDir, articlePath) || articlePath,
    sidecar: relative(rootDir, sidecarPath) || sidecarPath,
    exists: existsSync(sidecarPath),
    metadata: payload,
    rendered_preview: previewHtml,
  };
}
