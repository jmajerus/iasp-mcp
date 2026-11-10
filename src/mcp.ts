import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { DB } from "./db.js";
import { inspectMarkdown, manageAiDisclosure, validateMarkdown, wrapByDirectory } from "./markdown.js";
import {
  GUIDE_TOPICS,
  ToolError,
  composeIntent,
  getAuthoringGuide,
  getTerm,
  iaspStatus,
  listSets,
  listTerms,
} from "./queries.js";
import { RENDER_FORMATS, renderDocument } from "./render.js";

export const VERSION = "0.1.0";

const INSTRUCTIONS = `Authoring MCP server for the Informative Authoring Semantics Profile (IASP) and its Pandoc/Ghost rendering pipeline.
IASP gives authors names for what a passage of long-form nonfiction or an essay is doing along two composable axes:
- Axis A (delivery-role): placement relative to the main narrative flow (front-matter, series, part, chapter, section, interlude, bridge, sidebar, sidebar-inline, callout, note, footnote, endnotes, epigraph, epigraph-inline, appendix, back-matter).
- Axis B (modifier): rhetorical move, expository support, reader stance, or reader navigation cue (thesis, claim, counterpoint, qualification, implication, synthesis, integration, contrast, reflection, provocation, example, case-study, background, context, definition, gloss, analogy, insight, insight.major, idea, usage, methodology, diagnostic, checklist, warning, notice, caution, misuse, assumption, limitation, scope, uncertainty, disclosure, responsibility, reflexive, breadcrumb, navigation, transition, prelude, closing).
Terms compose as delivery.modifier (e.g. note.insight, sidebar.example, bridge.reflection, note.insight.major) and are optional: unmarked prose is always valid main-flow text.
The vocabulary is synced from terminology-mcp's "iasp" concept scheme, which also defines three profile concept sets: "core" (IASP Core §6–7), "delivery-order" (Core delivery roles in reading order), and "note-variants" (the 22 styled note.<variant> modifiers).
Typical flow:
1. Explore or choose intent with list_terms, get_term, list_sets, compose_intent, or get_authoring_guide.
2. Check a draft with inspect_markdown and validate_markdown (catches unbalanced ::: fences, level-1 headers inside sidebars, missing .include files, and unknown/retired classes).
3. Render end to end with render_document (formats: ghost, html, pdf, pdf-print, epub, docx, rtf; pass source: "demo" to build the bundled showcase essay) or manage per-article AI disclosures with ai_disclosure.`;

function json(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function run(body: () => unknown): CallToolResult {
  try {
    return json(body());
  } catch (error) {
    if (error instanceof ToolError) {
      return { isError: true, content: [{ type: "text", text: error.message }] };
    }
    throw error;
  }
}

async function runAsync(body: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return json(await body());
  } catch (error) {
    if (error instanceof ToolError) {
      return { isError: true, content: [{ type: "text", text: error.message }] };
    }
    throw error;
  }
}

const readOnly = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

export function createServer(db: DB): McpServer {
  const server = new McpServer({ name: "iasp-mcp", version: VERSION }, { instructions: INSTRUCTIONS });

  server.registerTool(
    "list_terms",
    {
      title: "List IASP terms",
      description:
        "Browse or search the IASP vocabulary synced from terminology-mcp's 'iasp' scheme. Filter by axis ('delivery-role' or 'modifier'), modifier group ('argument-and-reasoning', 'exposition-and-support', 'reader-signals-and-stance', 'reader-navigation'), concept set ('core', 'delivery-order', 'note-variants'), or query text. Returns each term's slug, Pandoc class notations, scope note, set memberships, and rendering summary.",
      inputSchema: {
        axis: z.enum(["delivery-role", "modifier", "any"]).optional().describe("Filter to Axis A (delivery-role) or Axis B (modifier)"),
        group: z
          .string()
          .optional()
          .describe("Modifier group slug: argument-and-reasoning, exposition-and-support, reader-signals-and-stance, or reader-navigation"),
        set: z.string().optional().describe("Concept set slug: core, delivery-order, or note-variants"),
        query: z.string().optional().describe("Substring search across label, altLabels, notations, and scopeNote"),
        status: z.enum(["active", "provisional", "retired", "any"]).optional().describe("Default: active"),
        include_grouping: z.boolean().optional().describe("Include axis/group container concepts without Pandoc notations (default true)"),
      },
      annotations: readOnly,
    },
    ({ include_grouping, ...args }) => run(() => listTerms(db, { ...args, includeGrouping: include_grouping })),
  );

  server.registerTool(
    "get_term",
    {
      title: "Get an IASP term",
      description:
        "Get full details for one IASP term or build modifier by slug, Pandoc class notation, alternative label, or terminology-mcp term ID (e.g. 'sidebar', 'insight.major', 'methodology', 'layout-fullpage'). Returns definition/scope note, broader/narrower/related/opposite terms, external EPUB/ARIA mappings, and concrete syntax and rendering behavior across EPUB/HTML, XeLaTeX PDF, and Ghost Markdown.",
      inputSchema: {
        term: z.string().min(1).describe("Term slug, Pandoc class notation, or ID (e.g. 'note', 'insight', 'insight.major', 'sidebar-inline')"),
      },
      annotations: readOnly,
    },
    ({ term }) => run(() => getTerm(db, term)),
  );

  server.registerTool(
    "list_sets",
    {
      title: "List IASP concept sets",
      description:
        "List the profile concept sets in the 'iasp' scheme ('core', 'delivery-order', 'note-variants') with their descriptions and expanded member terms.",
      inputSchema: {},
      annotations: readOnly,
    },
    () => run(() => listSets(db)),
  );

  server.registerTool(
    "compose_intent",
    {
      title: "Compose IASP intent",
      description:
        "Validate and explain a composed IASP class expression (such as 'note.insight.major', 'sidebar.example', 'bridge.reflection.pre-pagebreak', or delivery + modifiers). Checks every token against the 'iasp' scheme and build modifiers, explains the layered authorial intent, warns on retired or unstyled note modifiers, and returns ready-to-paste Pandoc fenced-div and heading syntax plus how EPUB/HTML, PDF, and Ghost render it.",
      inputSchema: {
        composition: z
          .string()
          .optional()
          .describe("Dot-separated or brace class expression, e.g. 'note.insight', 'sidebar.example', or '{.bridge .reflection .pre-pagebreak}'"),
        delivery: z.string().optional().describe("Axis A delivery role, e.g. 'note', 'sidebar', 'callout', 'bridge'"),
        modifiers: z.array(z.string()).optional().describe("Axis B modifiers or build hints, e.g. ['insight', 'major'] or ['example', 'nobadge']"),
      },
      annotations: readOnly,
    },
    (args) => run(() => composeIntent(db, args)),
  );

  server.registerTool(
    "get_authoring_guide",
    {
      title: "Get IASP authoring guide",
      description:
        "Topic-scoped reference guide for IASP authoring and build conventions: 'overview', 'wrappers', 'note-variants', 'sidebars', 'includes', 'tables', 'pagination', 'stages', 'ai-disclosure', or 'ghost'.",
      inputSchema: {
        topic: z.enum(GUIDE_TOPICS).optional().describe("Guide topic (default: overview)"),
      },
      annotations: readOnly,
    },
    ({ topic }) => run(() => getAuthoringGuide(db, topic ?? "overview")),
  );

  server.registerTool(
    "inspect_markdown",
    {
      title: "Inspect IASP Markdown",
      description:
        "Parse a Markdown string or file for IASP fenced divs (:::), heading attributes, .include directives, <!-- quote <id> --> markers, and {{meta:...}} placeholders. Returns a structured outline of blocks with their resolved delivery roles, modifiers, build hints, and include targets.",
      inputSchema: {
        markdown: z.string().optional().describe("Markdown text to inspect"),
        path: z.string().optional().describe("Path to a Markdown file (relative to workspace or absolute)"),
      },
      annotations: readOnly,
    },
    (args) => run(() => inspectMarkdown(db, args)),
  );

  server.registerTool(
    "validate_markdown",
    {
      title: "Validate IASP Markdown",
      description:
        "Check a Markdown string or file for common IASP authoring issues before building: (1) unbalanced or unclosed ':::' fences, (2) level-1 headings ('#') inside '.sidebar' / '.aside' blocks (which break XeLaTeX mdframed badges), (3) unknown or retired IASP classes, (4) nested shorthand fences that require brace syntax '{.class}', and (5) missing '.include' target files.",
      inputSchema: {
        markdown: z.string().optional().describe("Markdown text to validate"),
        path: z.string().optional().describe("Path to a Markdown file (relative to workspace or absolute)"),
      },
      annotations: readOnly,
    },
    (args) => run(() => validateMarkdown(db, args)),
  );

  server.registerTool(
    "render_document",
    {
      title: "Render IASP Markdown",
      description:
        "Render an IASP Markdown file, inline Markdown string, or the built-in 'demo' showcase to one or more formats ('md' for clean pure Markdown using blockquotes + glyph/label headers with no HTML <div> tags, 'ghost' for Ghost CMS Markdown cards with inline-styled HTML <div> blocks, 'html', 'pdf', 'pdf-print', 'epub', 'docx', 'rtf') using the bundled Pandoc Lua filters, XeLaTeX box environments, CSS stylesheets, and Markdown exporters.",
      inputSchema: {
        source: z
          .string()
          .optional()
          .describe("Path to a Markdown file, 'demo' for the IASP showcase (demo/essay-on-attentive-reading.md), or 'interop' for the 6-server interoperability essay (demo/interoperability-essay.md)"),
        markdown: z.string().optional().describe("Inline Markdown source to render instead of a file"),
        title: z.string().optional().describe("Optional document title override"),
        formats: z
          .array(z.enum(RENDER_FORMATS))
          .optional()
          .describe("Output formats to build (default: ['md', 'html', 'ghost'])"),
        output_dir: z.string().optional().describe("Output directory (default: build/renders)"),
        output_basename: z.string().optional().describe("Base filename without extension"),
        stage: z.enum(["final", "draft"]).optional().describe("Build stage: 'final' (default, hides .draft) or 'draft' (shows .draft, hides .final)"),
        bibliography: z.string().optional().describe("Optional path to a .bib bibliography file for --citeproc"),
        bibtex_content: z
          .string()
          .optional()
          .describe("Inline BibTeX entries (e.g. from zotero_export_bibliography or corpus_cite_passage) for --citeproc when rendering over remote MCP"),
        csl: z.string().optional().describe("Optional path to a .csl citation style file"),
        ai_disclosure: z.string().optional().describe("Inline qualitative AI disclosure line to inject in md/ghost outputs"),
        technical_note: z.string().optional().describe("Inline technical note line to inject in md/ghost outputs"),
        disclosure_variant: z.string().optional().describe("Disclosure box style variant (default: 'ai' or 'disclosure')"),
        optimize_pdf: z.boolean().optional().describe("Linearize PDF with qpdf when available (default true)"),
        validate_epub: z.boolean().optional().describe("Run epubcheck on generated EPUB when available (default false)"),
        return_content: z.boolean().optional().describe("Include rendered text content in the response for 'md', 'ghost', and 'html' (default false)"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    ({
      output_dir,
      output_basename,
      bibtex_content,
      ai_disclosure,
      technical_note,
      disclosure_variant,
      optimize_pdf,
      validate_epub,
      return_content,
      ...rest
    }) =>
      runAsync(() =>
        renderDocument({
          ...rest,
          outputDir: output_dir,
          outputBasename: output_basename,
          bibtexContent: bibtex_content,
          ...(ai_disclosure || technical_note
            ? {
                aiMetadata: {
                  ai_disclosure,
                  technical_note,
                  disclosure_variant,
                },
              }
            : {}),
          optimizePdf: optimize_pdf,
          validateEpub: validate_epub,
          returnContent: return_content,
        }),
      ),
  );

  server.registerTool(
    "wrap_by_directory",
    {
      title: "Wrap Markdown files by directory",
      description:
        "Inspect or apply directory-based IASP wrapper fences (e.g. chapters/ -> '::: {.chapter}', sidebars/ -> '::: {.aside .sidebar-block}', appendices/ -> '::: {.appendix}', articles/ -> '::: {.article}'). Defaults to dry-run preview (apply: false).",
      inputSchema: {
        path: z.string().min(1).describe("File or directory path to inspect or wrap"),
        apply: z.boolean().optional().describe("Write changes to disk (default false)"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    (args) => run(() => wrapByDirectory(args)),
  );

  server.registerTool(
    "ai_disclosure",
    {
      title: "Manage article AI disclosure sidecar",
      description:
        "Read or update a per-article AI disclosure sidecar (<article>.ai.json) and preview the styled disclosure block injected during Ghost export. Prefer qualitative descriptions of collaboration over turn counts.",
      inputSchema: {
        article: z.string().min(1).describe("Article Markdown path or slug (e.g. 'demo/essay-on-attentive-reading.md')"),
        action: z.enum(["get", "update"]).optional().describe("'get' (default) or 'update'"),
        disclosure_variant: z.string().optional().describe("Note variant style for the disclosure box (default: 'ai' or 'disclosure')"),
        ai_disclosure: z.string().optional().describe("Qualitative AI collaboration disclosure text"),
        technical_note: z.string().optional().describe("Technical pipeline note text"),
        init_defaults: z.boolean().optional().describe("Initialize default disclosure fields if unset"),
        set_turns: z.number().int().min(0).optional().describe("Legacy exact turn count"),
        inc_turns: z.number().int().optional().describe("Legacy turn count increment"),
        set_fuzzy_min: z.number().int().min(0).optional(),
        set_fuzzy_max: z.number().int().min(0).optional(),
        clear_fuzzy: z.boolean().optional(),
        set_bucket_override: z.string().optional(),
        clear_bucket_override: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    (args) => run(() => manageAiDisclosure(args)),
  );

  server.registerTool(
    "iasp_status",
    {
      title: "IASP server status",
      description:
        "Return terminology-mcp sync cursor status for the 'iasp' scheme, term and concept-set counts, and local Pandoc/XeLaTeX/qpdf/epubcheck availability.",
      inputSchema: {},
      annotations: readOnly,
    },
    () => run(() => iaspStatus(db)),
  );

  return server;
}
