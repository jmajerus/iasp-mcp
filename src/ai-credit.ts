/**
 * AI disclosure: what to print about generative-AI involvement, and where.
 *
 * The data lives in the document's YAML front matter (iasp-build's AI Disclosure proposal):
 *
 *   provenance:            # who contributed (provenance-mcp's `provenance` object)
 *     contributors: ["John Majerus", { name: "Claude", model: "anthropic/claude-opus-5-5" }]
 *   ai-disclosure:         # what to print and where
 *     placement: inline    # copyright | titlepage | inline | none (default)
 *     statement: "…"       # optional; printed verbatim, wins over the generated credit line
 *     technical-note: "…"  # optional; a pipeline credit printed after the line, in the same block
 *
 * What gets printed, in order of precedence:
 *   1. `ai-disclosure.statement`;
 *   2. the legacy `<article>.ai.json` `ai_disclosure` text (read-only, deprecated);
 *   3. the credit line provenance-mcp generates from `provenance` (POST /api/credit);
 *   4. nothing.
 *
 * The credit-line rules live only in provenance-mcp; this module never builds a line itself. When the service is
 * off or unreachable there is no generated line (never an invented one).
 */
import { LineCounter, parseDocument, isMap, type Document } from "yaml";
import { buildTurnTokens, formatDisclosureLine, type AiDisclosureMetadata } from "./ghost.js";
import type { ValidationIssue } from "./markdown.js";

export const DEFAULT_PROVENANCE_BASE = "http://provenance-mcp.localdomain:8000";

export const AI_PLACEMENTS = ["copyright", "titlepage", "inline", "none"] as const;
export type AiPlacement = (typeof AI_PLACEMENTS)[number];

/** Where a placement puts the block in a single-article render (which has no title or copyright page). */
export type DisclosurePosition = "top" | "end";

export function placementPosition(placement: AiPlacement): DisclosurePosition | null {
  if (placement === "none") return null;
  return placement === "titlepage" ? "top" : "end";
}

// ---------------------------------------------------------------------------------------------------------------
// Front matter
// ---------------------------------------------------------------------------------------------------------------

export interface FrontMatter {
  /** The parsed front matter (an empty object when there is none). */
  data: Record<string, unknown>;
  /** Set when the block exists but is not valid YAML, or not a mapping. */
  error?: string;
  /** 1-based source line of each top-level key. */
  keyLines: Record<string, number>;
}

/** The `---` … `---`/`...` block at the very top of a Markdown document, as raw YAML text. */
export function frontMatterBlock(markdown: string): { yaml: string; endLine: number } | null {
  const lines = markdown.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return null;
  for (let i = 1; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t === "---" || t === "...") return { yaml: lines.slice(1, i).join("\n"), endLine: i + 1 };
  }
  return null;
}

/** Parse the front matter with a YAML parser (the same YAML Pandoc reads, but with the values left as written). */
export function readFrontMatter(markdown: string): FrontMatter {
  const block = frontMatterBlock(markdown);
  if (!block) return { data: {}, keyLines: {} };
  const lineCounter = new LineCounter();
  const doc = parseDocument(block.yaml, { lineCounter, prettyErrors: false });
  if (doc.errors.length) {
    const first = doc.errors[0];
    const line = first.linePos?.[0]?.line;
    return {
      data: {},
      keyLines: {},
      error: `The front matter is not valid YAML${line ? ` (line ${line + 1})` : ""}: ${first.message.split("\n")[0]}`,
    };
  }
  const contents = doc.contents;
  if (contents === null) return { data: {}, keyLines: {} };
  if (!isMap(contents)) return { data: {}, keyLines: {}, error: "The front matter is not a YAML mapping." };
  const keyLines: Record<string, number> = {};
  for (const pair of contents.items) {
    const key = (pair.key as { value?: unknown; range?: [number, number, number] } | null) ?? null;
    if (key && typeof key.value === "string" && key.range) {
      keyLines[key.value] = lineCounter.linePos(key.range[0]).line + 1; // +1 for the opening `---`
    }
  }
  return { data: (doc.toJS() ?? {}) as Record<string, unknown>, keyLines };
}

/** The front matter as a YAML Document, for edits that keep the author's comments and layout. */
export function frontMatterDocument(markdown: string): Document | null {
  const block = frontMatterBlock(markdown);
  return block ? parseDocument(block.yaml) : null;
}

// ---------------------------------------------------------------------------------------------------------------
// provenance-mcp: POST /api/credit
// ---------------------------------------------------------------------------------------------------------------

export interface CreditResponse {
  creditLine: string | null;
  contributors?: unknown[];
  warnings: { index?: number; code: string }[];
  errors: string[];
  /** Which vocabulary provenance-mcp matched against; recorded with each render. */
  matchTable?: unknown;
}

export interface CreditLookup {
  response?: CreditResponse;
  /** Set when provenance-mcp could not be asked (disabled, unreachable, or a bad answer). */
  unavailable?: string;
}

export function provenanceBaseFromEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.PROVENANCE_BASE?.trim() ?? "";
  return raw.toLowerCase() === "off" ? null : raw || DEFAULT_PROVENANCE_BASE;
}

/** The document's `author` front matter as a list of names (for provenance-mcp's authorNotContributor check). */
export function authorNames(data: Record<string, unknown>): string[] {
  const raw = data.author;
  const list = Array.isArray(raw) ? raw : raw === undefined || raw === null ? [] : [raw];
  return list
    .map((a) => (typeof a === "string" ? a : a && typeof a === "object" && "name" in a ? String((a as { name: unknown }).name) : ""))
    .map((a) => a.trim())
    .filter(Boolean);
}

export async function fetchCreditLine(
  provenance: unknown,
  options: { authors?: string[]; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<CreditLookup> {
  const base = provenanceBaseFromEnv(options.env);
  if (!base) return { unavailable: "the credit line is disabled (PROVENANCE_BASE=off)" };
  let endpoint: string;
  try {
    endpoint = new URL(`${base.replace(/\/+$/, "")}/api/credit`).toString();
  } catch {
    return { unavailable: `PROVENANCE_BASE '${base}' is not a valid URL` };
  }
  const params: Record<string, unknown> = { mixedDefault: "humanPrimary" };
  if (options.authors?.length) params.authors = options.authors;
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ provenance, params }),
      signal: AbortSignal.timeout(options.timeoutMs ?? 5000),
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).trim().slice(0, 200);
      return { unavailable: `provenance-mcp answered ${res.status}${detail ? `: ${detail}` : ""}` };
    }
    const body = (await res.json()) as Partial<CreditResponse>;
    return {
      response: {
        creditLine: typeof body.creditLine === "string" && body.creditLine.trim() ? body.creditLine : null,
        contributors: Array.isArray(body.contributors) ? body.contributors : [],
        warnings: Array.isArray(body.warnings)
          ? body.warnings.map((w) => (typeof w === "string" ? { code: w } : (w as { index?: number; code: string })))
          : [],
        errors: Array.isArray(body.errors) ? body.errors.map(String) : [],
        ...(body.matchTable !== undefined ? { matchTable: body.matchTable } : {}),
      },
    };
  } catch (error) {
    return {
      unavailable: `provenance-mcp at ${base} is unreachable (${error instanceof Error ? error.message : String(error)})`,
    };
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Resolving what to print
// ---------------------------------------------------------------------------------------------------------------

export interface ResolvedDisclosure {
  placement: AiPlacement;
  /** Where the block goes, or null when nothing is printed. */
  position: DisclosurePosition | null;
  /** Which source the main line came from. */
  source: "statement" | "legacy" | "credit" | "none";
  /** The block's paragraphs, as Markdown (the line, then the technical note). Empty when nothing is printed. */
  paragraphs: string[];
  /** The note variant that styles the box (`ai` unless a legacy sidecar chose another). */
  variant: string;
  warnings: string[];
  /** provenance-mcp's answer, when it was asked. */
  credit?: CreditResponse;
}

export interface ResolveDisclosureInput {
  markdown: string;
  /** The legacy `.ai.json` sidecar, or render_document's inline disclosure args. */
  legacy?: AiDisclosureMetadata;
  /** True when `legacy` came from a sidecar file (it then gets a deprecation warning). */
  legacyFromSidecar?: boolean;
  env?: NodeJS.ProcessEnv;
  /** For tests: skip the network and use this answer. */
  creditLookup?: CreditLookup;
}

/** Escape the characters that would make a plain credit line read as Markdown markup. */
export function escapeMarkdownInline(text: string): string {
  return text.replace(/([\\`*_[\]<>#|])/g, "\\$1");
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function creditIssueMessages(credit: CreditResponse): { errors: string[]; warnings: string[] } {
  return {
    errors: credit.errors.map((code) => `provenance: ${code}`),
    warnings: credit.warnings.map((w) => `provenance${w.index !== undefined ? `.contributors[${w.index}]` : ""}: ${w.code}`),
  };
}

export async function resolveAiDisclosure(input: ResolveDisclosureInput): Promise<ResolvedDisclosure> {
  const warnings: string[] = [];
  const fm = readFrontMatter(input.markdown);
  if (fm.error) warnings.push(`${fm.error} AI disclosure front matter was not read.`);

  const rawSettings = fm.data["ai-disclosure"];
  // A bare string is a statement with the default placement (none), as in iasp-build.
  const settings: Record<string, unknown> = isPlainObject(rawSettings)
    ? rawSettings
    : typeof rawSettings === "string"
      ? { statement: rawSettings }
      : {};
  if (rawSettings !== undefined && rawSettings !== null && !isPlainObject(rawSettings) && typeof rawSettings !== "string") {
    warnings.push("`ai-disclosure` is neither a mapping nor a statement string, so it was ignored.");
  }

  const legacy = input.legacy && Object.keys(input.legacy).length ? input.legacy : undefined;
  const legacyText = legacy?.ai_disclosure?.trim();
  const legacyNote = legacy?.technical_note?.trim();

  let placement: AiPlacement;
  const rawPlacement = settings.placement;
  if (rawPlacement !== undefined) {
    if (typeof rawPlacement === "string" && (AI_PLACEMENTS as readonly string[]).includes(rawPlacement.trim())) {
      placement = rawPlacement.trim() as AiPlacement;
    } else {
      warnings.push(`ai-disclosure.placement '${String(rawPlacement)}' is not one of ${AI_PLACEMENTS.join(", ")}, so nothing was printed.`);
      placement = "none";
    }
  } else {
    // The legacy sidecar always printed the article box; keep that until the article moves to front matter.
    placement = legacyText || legacyNote ? "inline" : "none";
  }

  const variant = (legacy?.disclosure_variant ?? "ai").trim().toLowerCase() || "ai";
  const nothing = (source: ResolvedDisclosure["source"] = "none", credit?: CreditResponse): ResolvedDisclosure => ({
    placement,
    position: null,
    source,
    paragraphs: [],
    variant,
    warnings,
    ...(credit ? { credit } : {}),
  });
  const position = placementPosition(placement);
  if (!position) return nothing();

  const statement = stringField(settings.statement);
  const technicalNote = stringField(settings["technical-note"]) ?? legacyNote;
  const tokens = legacy ? buildTurnTokens(legacy) : {};

  let line: string | undefined;
  let source: ResolvedDisclosure["source"] = "none";
  let credit: CreditResponse | undefined;

  if (statement) {
    line = statement;
    source = "statement";
  } else if (legacyText) {
    line = formatDisclosureLine(legacyText, tokens);
    source = "legacy";
  } else if (fm.data.provenance !== undefined) {
    const lookup =
      input.creditLookup ?? (await fetchCreditLine(fm.data.provenance, { authors: authorNames(fm.data), env: input.env }));
    if (lookup.unavailable) {
      warnings.push(`No credit line: ${lookup.unavailable}.`);
    } else if (lookup.response) {
      credit = lookup.response;
      const msgs = creditIssueMessages(credit);
      warnings.push(...msgs.errors, ...msgs.warnings);
      if (credit.creditLine) {
        line = escapeMarkdownInline(credit.creditLine);
        source = "credit";
      } else {
        warnings.push("provenance-mcp generated no credit line for this `provenance`.");
      }
    }
  }

  const legacyPrinted = source === "legacy" || (Boolean(technicalNote) && !stringField(settings["technical-note"]));
  if (input.legacyFromSidecar && legacyPrinted) {
    warnings.push(
      "The .ai.json sidecar is deprecated: move its text to front-matter `ai-disclosure` (statement, technical-note, placement). The ai_disclosure tool's `migrate` does this.",
    );
  }

  const paragraphs = [line, technicalNote ? formatDisclosureLine(technicalNote, tokens) : undefined].filter(
    (p): p is string => Boolean(p),
  );
  if (!paragraphs.length) return nothing(source, credit);
  return { placement, position, source, paragraphs, variant, warnings, ...(credit ? { credit } : {}) };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// ---------------------------------------------------------------------------------------------------------------
// Validation (validate_markdown)
// ---------------------------------------------------------------------------------------------------------------

/**
 * Structural checks only, for when provenance-mcp can't be asked (they follow its provenance.schema.json).
 * The normative checks (duplicates, contradictions, authors) are provenance-mcp's /api/credit `errors`.
 */
export function provenanceShapeProblems(provenance: unknown): string[] {
  if (!isPlainObject(provenance)) return ["`provenance` is not a mapping"];
  const problems: string[] = [];
  const { contributors, reviewedBy } = provenance;
  if (!Array.isArray(contributors) || contributors.length === 0) {
    problems.push("`provenance.contributors` must be a non-empty list");
  } else {
    contributors.forEach((c, i) => {
      const ok =
        (typeof c === "string" && c.trim() !== "") ||
        (isPlainObject(c) && typeof c.name === "string" && c.name.trim() !== "");
      if (!ok) problems.push(`\`provenance.contributors[${i}]\` must be a name or a mapping with a \`name\``);
    });
  }
  if (reviewedBy !== undefined && (typeof reviewedBy !== "string" || !reviewedBy.trim())) {
    problems.push("`provenance.reviewedBy` must be a non-blank string");
  }
  return problems;
}

/** Check the front matter's `ai-disclosure` and `provenance` (the latter through provenance-mcp when it can be asked). */
export async function checkAiDisclosure(
  markdown: string,
  options: { env?: NodeJS.ProcessEnv; legacySidecar?: boolean; creditLookup?: CreditLookup } = {},
): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];
  const fm = readFrontMatter(markdown);
  if (fm.error) {
    issues.push({ severity: "error", code: "front-matter-invalid", line: 1, message: fm.error });
    return issues;
  }
  const settings = fm.data["ai-disclosure"];
  const settingsLine = fm.keyLines["ai-disclosure"] ?? 1;
  if (settings !== undefined && settings !== null && typeof settings !== "string") {
    if (!isPlainObject(settings)) {
      issues.push({
        severity: "warning",
        code: "ai-disclosure-invalid",
        line: settingsLine,
        message: "`ai-disclosure` must be a mapping (placement, statement, technical-note) or a statement string; it is ignored.",
      });
    } else {
      const p = settings.placement;
      if (p !== undefined && !(typeof p === "string" && (AI_PLACEMENTS as readonly string[]).includes(p.trim()))) {
        issues.push({
          severity: "warning",
          code: "ai-disclosure-invalid",
          line: settingsLine,
          message: `ai-disclosure.placement '${String(p)}' is not one of ${AI_PLACEMENTS.join(", ")}; it is treated as none, so nothing is printed.`,
        });
      }
      for (const key of ["statement", "technical-note"]) {
        const v = settings[key];
        if (v !== undefined && typeof v !== "string") {
          issues.push({
            severity: "warning",
            code: "ai-disclosure-invalid",
            line: settingsLine,
            message: `ai-disclosure.${key} must be a string; it is ignored.`,
          });
        }
      }
    }
  }
  if (options.legacySidecar && (settings === undefined || settings === null)) {
    issues.push({
      severity: "warning",
      code: "ai-disclosure-legacy",
      line: 1,
      message: "This article has a deprecated .ai.json sidecar; it is still printed during the transition.",
      suggestion: "Run the ai_disclosure tool with action 'migrate' to move it into front-matter `ai-disclosure`.",
    });
  }

  if (fm.data.provenance === undefined) return issues;
  const line = fm.keyLines.provenance ?? 1;
  const shape = provenanceShapeProblems(fm.data.provenance);
  const lookup =
    options.creditLookup ?? (await fetchCreditLine(fm.data.provenance, { authors: authorNames(fm.data), env: options.env }));
  if (lookup.response) {
    const credit = lookup.response;
    for (const code of credit.errors) {
      issues.push({ severity: "warning", code: "provenance-error", line, message: `provenance: ${code} (provenance-mcp)` });
    }
    for (const w of credit.warnings) {
      issues.push({
        severity: "warning",
        code: "provenance-warning",
        line,
        message: `provenance${w.index !== undefined ? `.contributors[${w.index}]` : ""}: ${w.code} (provenance-mcp)`,
      });
    }
    return issues;
  }
  for (const problem of shape) issues.push({ severity: "warning", code: "provenance-invalid", line, message: problem });
  issues.push({
    severity: "info",
    code: "provenance-unchecked",
    line,
    message: `\`provenance\` was only checked for shape: ${lookup.unavailable ?? "provenance-mcp gave no answer"}.`,
  });
  return issues;
}
