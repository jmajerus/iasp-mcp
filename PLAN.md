# iasp-mcp: plan

Proposed 2026-11-09.

`iasp-mcp` is the authoring MCP server for the **Informative Authoring
Semantics Profile (IASP)** and its Pandoc/Ghost rendering pipeline. It gives
authors and agents a shared vocabulary for *what a passage of nonfiction is
doing* — its **delivery role** relative to the main narrative flow (Axis A)
and the **modifier** naming its rhetorical move, expository function, reader
stance, or navigation cue (Axis B) — together with tools to look up terms,
compose layered intent (`delivery.modifier`), validate fenced Markdown and
`.include` directives, manage article AI disclosures, and render manuscripts
or essays end to end to HTML, PDF, EPUB, DOCX, RTF, and Ghost Markdown.

It extracts and modernizes the reference implementation developed inside
`struggle-against-dehumanization/iasp_tooling/` while taking the `iasp`
concept scheme on `terminology-mcp` as the single source of truth for the
vocabulary.

## Background

In *The Struggle Against Dehumanization*, IASP grew alongside a reusable
Pandoc + Lua + XeLaTeX + EPUB + Ghost build pipeline (`iasp_tooling/`):

- **IASP Core (`docs/Semantic Vocabulary.md`)** separated authoring intent into
  two composable axes — 12 delivery roles (`front-matter`, `series`, `part`,
  `chapter`, `section`, `interlude`, `bridge`, `sidebar`, `note`, `footnote`,
  `endnotes`, `appendix`) and 21 modifiers across argument/reasoning,
  exposition/support, and reader signals/stance — written as Pandoc classes
  (`::: note.insight`, `::: sidebar.example`, `### Heading {.sidebar}`).
- **Build extensions (`lua/iasp-semantics.lua`, `latex/box-*.tex`,
  `styles/styles-shared.css`, `scripts/ghost_export.py`)** added inline
  variants (`sidebar-inline`, `epigraph`, `epigraph-inline`, `callout`,
  `back-matter`) and 22 styled note variants (`note.idea`, `note.insight`,
  `note.insight.major`, `note.warning`, `note.breadcrumb`, `note.contrast`,
  `note.transition`, `note.navigation`, `note.bridge`, `note.usage`,
  `note.integration`, `note.responsibility`, `note.reflexive`,
  `note.synthesis`, `note.disclosure`, `note.misuse`, `note.diagnostic`,
  `note.closing`, `note.methodology`, `note.context`, `note.scope`,
  `note.checklist`, `note.prelude`), plus declarative `.include` blocks,
  stage guards (`.draft`, `.final`), table auto-compaction, and KDP print
  margin prediction.
- **SKOS import into `terminology-mcp` (`vocab/iasp.ttl`)** consolidated IASP
  Core and the build extensions into the `iasp` concept scheme on
  `terminology-mcp.localdomain` (63 terms and 3 `profile` concept sets:
  `core`, `delivery-order`, and `note-variants`).

## Audit of `iasp_tooling/` against the `iasp` scheme (2026-11-09)

Comparing the live `iasp` scheme on `terminology-mcp.localdomain:8000` (log
`b8e1db33-…`, version 343) with `struggle-against-dehumanization/iasp_tooling/`
surfaced four small drifts between documentation, Lua filter, LaTeX macros,
CSS, and Ghost export that `iasp-mcp` resolves cleanly:

| Finding | In `terminology-mcp` (`iasp`) | In `iasp_tooling/` | Resolution in `iasp-mcp` |
|---|---|---|---|
| `note.orientation` vs `note.navigation` | `navigation` is the term (`iasp:navigation`), with `orientation` as `altLabel` and a scope note explaining that `iasp-semantics.lua` lacked `orientation` | Listed as separate bullets in `Authoring Quick Start.md` and `ghost_export.py`; absent from `iasp-semantics.lua` and `box-note.tex` | Treat `orientation` as an alias of `navigation` in the Lua filter and validator (guided by `altLabels` from `terminology-mcp`), while flagging `note.orientation` with a gentle hint to prefer `note.navigation`. |
| `note.checklist` in PDF | Active term in `note-variants` (`iasp:checklist`, teal `☐` badge) | Present in `iasp-semantics.lua`, `styles-shared.css`, and `ghost_export.py`; `\headernotechecklist` and `noteboxchecklist` exist in `box-note.tex`, but `{checklist}{\headernotechecklist}` was omitted from `\NewDocumentCommand{\notevariant}{m}` | Add `{checklist}{\headernotechecklist}` to `box-note.tex` so PDF builds render the checklist header instead of falling back to the plain note glyph. |
| Newer note variants in `styles.css` | `methodology`, `context`, `scope`, `checklist`, and `prelude` are in `note-variants` | Styled in `styles-shared.css`, `box-note.tex`, and `ghost_export.py`, but omitted from `styles/styles.css` | Align `styles-shared.css` and `styles-epub.css` so all 22 `note-variants` members have consistent CSS variables and `::before` glyphs across HTML and EPUB. |
| `note.ai` in Ghost disclosures | Not a term in `iasp` (uses `iasp:disclosure` conceptually) | `ghost_export.py` defines an `"ai"` style (`AI DISCLOSURE`, `◇`) for `.ai.json` sidecars | Support `disclosure` (and `ai` as a built-in disclosure style alias) in both Ghost export and HTML/PDF rendering. |
| Shorthand fence bases | All 17 delivery roles carry `urn:iasp:datatype:pandoc-class` notations | `lua/iasp/shorthand.lua` only whitelisted `callout`, `note`, `example`, `definition`, `sidebar`, `aside`, `sidebar-inline`, `include` — while docs and `ghost_export.py` also use `::: bridge` and `::: epigraph` | Expand shorthand support to include `bridge`, `bridgehead`, `epigraph`, and `epigraph-inline` alongside brace syntax `::: {.bridge}`. |

## Who owns what

| Service | Owns | Does not own |
|---|---|---|
| **`terminology-mcp`** | The `iasp` concept scheme: terms, stable IDs, slugs, labels, alternative labels, `urn:iasp:datatype:pandoc-class` notations, scope notes, broader/narrower/related/opposite relations, external `closeMatch` links (`epub:type` SSV, DPUB-ARIA, WAI-ARIA), and concept sets (`core`, `delivery-order`, `note-variants`) | Rendering rules, Lua filters, LaTeX/CSS styles, manuscript files |
| **`iasp-mcp`** | Replica of the `iasp` scheme following `terminology-mcp`'s changelog; rendering and presentation metadata per term/variant; authoring guidance and composition lookup; Markdown fence/wrapper and `.include` validation; bundled Pandoc/Lua/LaTeX/CSS/Ghost rendering pipeline and end-to-end demonstration | Master taxonomy edits (done in `terminology-mcp`); bibliographic records, quotes, or book text |
| **`holdings-mcp` / `corpus-mcp` / `quote-mcp` / `zotero-mcp`** | Works and holdings (`find_work`), book text (`search_corpus`, `read_book`), verified quotes and margin notes (`add_quote`, `cite_quote`), and Zotero items | Document structure, semantic wrappers, and Pandoc/Ghost layout |
| **Manuscript repositories** | Prose sources (`.md`), `book-order.txt`, `metadata.yaml`, bibliography (`.bib`), and project overrides (`iasp-config.yaml`) | The shared IASP vocabulary and filter/rendering engine |

## Decisions

| Area | Decision |
|---|---|
| Vocabulary authority | `terminology-mcp` (`scheme = "iasp"`). `iasp-mcp` follows its numbered changelog (`GET /api/state?scheme=iasp`, `GET /api/changes?since=N&scheme=iasp`) and reports progress to `POST /api/subscribers/iasp-mcp/progress`, on the same contract as `quote-mcp`. |
| Offline / bootstrap fallback | A seed snapshot of `vocab/iasp.ttl` (and the initial state from `terminology-mcp`) is bundled so tests and isolated demos work even when `terminology-mcp.localdomain` is unreachable; when `terminology-mcp` is reachable, the changelog follower keeps the SQLite store current. |
| Compositional semantics | Leftmost class names the **delivery role** (Axis A); subsequent classes name **modifiers** (Axis B) or layout/stage hints. `iasp-mcp` never treats unmarked prose as invalid, and distinguishes between (a) unknown classes, (b) valid IASP modifiers that compose with `note` using the plain note box, and (c) the 23 `note-variants` that have dedicated badges/glyphs and LaTeX environments. |
| Semantic & provenance retention in output | Rendered HTML, EPUB, and Ghost Markdown retain machine-readable SKOS RDFa (`vocab`, `typeof="Concept"`, `resource="urn:iasp:concept:<slug>"`, `about`) and `data-iasp-*` attributes (`data-iasp-delivery`, `data-iasp-modifiers`, `data-iasp-concepts`, `data-iasp-terms` pointing to `https://vocabulary.majerus.us/api/schemes/iasp/slugs/<slug>`). External vocabulary concepts (`concepts="human-work:curiosity human-work:confirmation-bias"`) and `<!-- quote <id> -->` provenance (`data-quote-id`, `data-citekey`, `data-work-key`, `data-concepts`, `data-concept-uris`, `data-concept-terms`) are resolved across `quote-mcp` and `terminology-mcp` and bound onto the rendered elements (`src/provenance.ts`). |
| Rendering assets in-repo | The reusable Pandoc Lua filters (`assets/lua/`), XeLaTeX headers and box environments (`assets/latex/`), CSS stylesheets (`assets/styles/`), Ghost and clean Markdown exporters, and two end-to-end sample essays (`demo/essay-on-attentive-reading.md` and `demo/interoperability-essay.md`) live in this repository so `iasp-mcp` can demonstrate and execute full builds out of the box. |
| Stack and runtime | TypeScript on Node 22 (`@modelcontextprotocol/sdk`, `better-sqlite3`, `jose`, `zod`, `vitest`), matching `quote-mcp` and `holdings-mcp`. Stateless Streamable HTTP at `/mcp`, stdio transport for local CLI/IDE use, `/health`, `/` (interactive IASP reference, visual style guide, and live demo preview), and `/admin` (subscriber status, local toolchain checks, and sibling services). |

## Data model

SQLite (`data/iasp.sqlite`):

- **`meta`**: key/value store (`terminology:iasp` cursor `{log, through, blocked}`, `terminology:iasp:sets-seeded`, schema version).
- **`terms`**: replica of `terminology-mcp`'s `iasp` terms:
  - `id` (stable `t_…` ID from `terminology-mcp`), `slug`, `former_slugs` (JSON), `label`, `alt_labels` (JSON), `notations` (JSON array of `{value, datatype}`), `scope_note`, `status` (`active`, `provisional`, `retired`), `replaced_by` (JSON), `broader` (JSON), `path`, `depth`, `axis` (`delivery-role` or `modifier`), `group_slug` (e.g. `argument-and-reasoning`, `exposition-and-support`, `reader-signals-and-stance`, `reader-navigation`), `links` (JSON `closeMatch` URIs for EPUB SSV / DPUB-ARIA / WAI-ARIA), `aliases` (JSON), `updated_at`.
- **`term_relations`**: `from_id`, `to_id`, `type` (`broader`, `narrower`, `related`, `opposite`).
- **`concept_sets`**: replica of `terminology-mcp`'s `iasp` sets (`core`, `delivery-order`, `note-variants`):
  - `id` (`s_…`), `scheme`, `slug`, `label`, `description`, `kind`, `ordered`, `members` (JSON), `recipe` (JSON), `former_slugs` (JSON), `updated_at`.

Joined at query time with **`src/rendering-profile.ts`**, which maps each notation/slug to its concrete build behavior:
- Pandoc shorthand & brace syntax (`::: note.insight`, `::: {.sidebar .sidebar-block}`)
- `epub:type` token and WAI-ARIA / DPUB-ARIA `role`
- XeLaTeX environment (`notebox`, `noteboxwarning`, `sidebar`, `sidebartight`, `calloutbox`, `bridgeheadblock`, `examplebox`, `definitionbox`, `epigraph`, `epigraphtight`, `parttitlepage`) and header macro (`\notevariant{...}`, `\sidebarbadge`, etc.)
- Ghost / HTML palette (`bg`, `border`, `badge_bg`, `badge_fg`, `glyph`, `label`, `glyph_only`)
- Supported layout/stage/marker modifiers (`.badge`, `.nobadge`, `.noglyph`, `.sidebar-badge`, `.sidebar-glyph`, `.glyph-top`, `.layout-fullpage`, `.pre-pagebreak`, `.post-pagebreak`, `.table-compact`, `.table-striped`, `.table-bordered`, `.draft`, `.final`)

## MCP tools

### 1. Vocabulary & authoring guidance (read-only)

| Tool | Title | What it does |
|---|---|---|
| `list_terms` | List IASP terms | Browse or search the `iasp` vocabulary. Filter by `axis` (`delivery-role`, `modifier`), `group` (`argument-and-reasoning`, `exposition-and-support`, `reader-signals-and-stance`, `reader-navigation`), `set` (`core`, `delivery-order`, `note-variants`), `status`, or `query` (matches label, altLabels, notations, scopeNote). Returns each term's slug, Pandoc class notations, axis, group, scope note, set memberships, and rendering summary. |
| `get_term` | Get an IASP term | Resolve one term by slug, Pandoc class notation, alias, or stable `t_…` ID. Returns its full `terminology-mcp` record (definition/scope note, broader/narrower/related/opposite terms, EPUB/ARIA links, set memberships) plus its authoring syntax (brace and shorthand forms) and exact rendering behavior across EPUB/HTML, PDF (XeLaTeX), and Ghost. |
| `list_sets` | List IASP profile sets | List the concept sets in `iasp` (`core`, `delivery-order`, `note-variants`) with their descriptions and expanded member terms (preserving reading order for `delivery-order`). |
| `compose_intent` | Compose IASP intent | Given a `delivery` role and optional `modifiers` (or a class/shorthand string like `note.insight.major`, `sidebar.example`, `{.bridge .reflection .pre-pagebreak}`), validate each token against the `iasp` scheme and layout modifiers, explain the layered intent in plain words, warn on retired terms or non-styled note variants, and return ready-to-paste Markdown wrapper snippets (fenced div and heading attribute forms) plus how each target renders it. |
| `get_authoring_guide` | Get IASP authoring guide | Concise, topic-scoped authoring reference grounded in the live vocabulary: `overview`, `wrappers`, `note-variants`, `sidebars`, `includes`, `tables`, `pagination`, `stages`, `ai-disclosure`, or `ghost`. |

### 2. Inspection & validation (read-only)

| Tool | Title | What it does |
|---|---|---|
| `inspect_markdown` | Inspect IASP Markdown | Parse a Markdown string or file for fenced divs (`:::`), semantic headings (`# ... {.class}`), `.include` directives, `<!-- quote <id> -->` markers, and `{{meta:...}}` placeholders. Returns a structured outline of blocks with their resolved IASP delivery roles, modifiers, layout hints, and include targets. |
| `validate_markdown` | Validate IASP Markdown | Run static authoring checks on a Markdown string, file, or directory: (1) fence balance (unclosed or extra `:::`), (2) level-1 headers (`#`) inside `.sidebar` / `.aside` blocks (which break PDF `mdframed` badge placement), (3) unknown or retired IASP classes (with replacement suggestions), (4) `.include` directives with missing `path`/`dir` targets or recursive cycles, and (5) shorthand fences nested inside outer divs where Pandoc requires brace syntax `{.class}`. |

### 3. Rendering, tagging & article workflow

| Tool | Title | What it does |
|---|---|---|
| `render_document` | Render IASP Markdown | Render a Markdown file, raw Markdown string, or the built-in `"demo"` showcase to one or more formats: `md` (clean pure Markdown with blockquotes + glyph/label headers and zero raw HTML `<div>` tags), `html` (standalone with IASP CSS), `ghost` (expanded Markdown for Ghost CMS cards with inline-styled HTML `<div>` wrappers and AI disclosure injection), `pdf` (XeLaTeX with `pdf-header.tex` and `box-*.tex`, `screen` or `print` mode, plus optional `qpdf` linearization), `epub` (with `iasp-semantics.lua`, shared/EPUB CSS, and optional `epubcheck`), `docx`, or `rtf`. Supports `stage` (`final` or `draft`), `bibliography`, and `csl`. |
| `wrap_by_directory` | Wrap files by directory | Inspect or apply directory-based IASP wrapper fences (`chapters/` → `::: {.chapter}`, `sidebars/` → `::: {.aside .sidebar-block}`, `appendices/` → `::: {.appendix}`, etc., from `tag_by_dir.py`), with dry-run preview by default (`apply: false`). |
| `ai_disclosure` | Manage AI disclosure sidecar | Read or update a per-article `.ai.json` sidecar (`action: "get" \| "update"`, qualitative `ai_disclosure`, `technical_note`, `disclosure_variant`, plus legacy turn fields for backward compatibility) and preview the rendered disclosure block. |

## End-to-end demonstration (`demo/`)

To make `iasp-mcp` immediately useful as a live demonstration and testbed, the
repository includes `demo/`:

- `demo/essay-on-attentive-reading.md`: A self-contained essay that exercises:
  - Axis A delivery roles (`article`, `epigraph`, `sidebar`, `sidebar-inline`,
    `callout`, `bridge`, `note`)
  - Axis B compositions (`note.prelude`, `note.insight`, `note.insight.major`,
    `note.contrast`, `note.warning`, `note.methodology`, `note.checklist`,
    `note.synthesis`, `note.closing`, `sidebar.example`, `sidebar.background`,
    `bridge.reflection`)
  - `.include` directives pulling a reusable sidebar fragment
    (`demo/fragments/lexical-precision-sidebar.md`)
  - Stage visibility blocks (`.draft` vs `.final`)
  - `{{meta:version}}` placeholder expansion and footnotes
- `demo/essay-on-attentive-reading.ai.json`: Sample qualitative AI disclosure
  sidecar rendered automatically by Ghost and article exports.
- Interactive web preview at `GET /` (`http://127.0.0.1:8000/`):
  - Browse the 63 IASP concepts synced from `terminology-mcp`, grouped by Axis A
    (in `delivery-order`) and Axis B (by modifier group), plus the 22
    `note-variants` with live rendered badge/glyph cards.
  - Render and inspect the end-to-end demo in Ghost Markdown, HTML, EPUB, and
    PDF directly from the browser or via MCP/CLI.

## Phases

1. **Phase 1 — Store, `terminology-mcp` subscriber, rendering assets, MCP server, and end-to-end demos (done 2026-11-09)**:
   - SQLite store (`src/db.ts`) and `terminology-mcp` follower (`src/terminology.ts`) for the `iasp` scheme, with offline bootstrap fallback from `vocab/iasp.ttl` / `vocab/iasp-seed.json`.
   - Bundled Pandoc/Lua/LaTeX/CSS assets (`assets/`) ported from `iasp_tooling/` with the audit fixes applied.
   - Markdown parser, inspector, validator, directory wrapper, AI disclosure helper, and TypeScript clean Markdown (`md`) + Ghost (`ghost`) exporters (`src/markdown.ts`, `src/ghost.ts`).
   - Pandoc rendering runner (`src/render.ts`) supporting `md`, `ghost`, `html`, `pdf` (`screen`/`print`), `epub`, `docx`, and `rtf`.
   - Inline SKOS RDFa (`vocab`, `typeof="Concept"`, `resource`, `about`), `data-iasp-*` attributes, external `concepts="..."` tagging, and `quote-mcp` / `terminology-mcp` provenance binding (`src/provenance.ts`).
   - Two end-to-end demonstrations in `demo/`: `essay-on-attentive-reading.md` (`source: "demo"`) and the six-server `interoperability-essay.md` (`source: "interop"`).
   - Automated tests (`tests/`) covering `terminology-mcp` sync, composition, Markdown validation, SKOS/provenance retention, clean Markdown & Ghost export, Pandoc HTML/PDF/EPUB rendering, and MCP tool calls.
2. **Phase 2 — LXC deployment & Authoring MCP portal integration (done 2026-11-09)**:
   - Deployed `iasp-mcp` to `iasp-mcp.localdomain:8000` (`deploy/`, `tools/deploy.mjs`, `tools/iasp-status.mjs`, `.vscode/settings.json`), behind Cloudflare Access, and added to the Cloudflare Authoring MCP portal (`https://mcp.majerus.us/mcp`) alongside `terminology-mcp`, `holdings-mcp`, `corpus-mcp`, `quote-mcp`, and `zotero-mcp`.
3. **Phase 3 — Multi-file book & annex profiles (planned)**:
   - Port `order_sources.py`, `container_walker.py`, `generate_toc.py`, and KDP print gutter prediction into `iasp-mcp` (or a companion `iasp-build` CLI package) for full multi-chapter book and annex builds.
