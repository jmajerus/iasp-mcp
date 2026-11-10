# MCP tools

`iasp-mcp`'s tools at `/mcp` (Streamable HTTP, stateless) and over stdio (`npm run iasp -- stdio`).

| Tool | Title | What it does |
|---|---|---|
| `list_terms` | List IASP terms | Browse or search the `iasp` scheme synced from `terminology-mcp` by axis, modifier group, concept set, status, or query |
| `get_term` | Get an IASP term | Full concept record, relations, external `epub:type` / DPUB-ARIA links, and concrete syntax and rendering behavior across formats |
| `list_sets` | List IASP concept sets | The three `iasp` profile concept sets (`core`, `delivery-order`, `note-variants`) and their expanded members |
| `compose_intent` | Compose IASP intent | Validate and explain a composed class expression (`note.insight.major`, `sidebar.example`, `bridge.reflection.pre-pagebreak`) and return ready-to-paste Pandoc syntax |
| `get_authoring_guide` | Get IASP authoring guide | Topic-scoped reference guide (`overview`, `wrappers`, `note-variants`, `sidebars`, `includes`, `tables`, `pagination`, `stages`, `ai-disclosure`, `ghost`) |
| `inspect_markdown` | Inspect IASP Markdown | Parse a Markdown file or string into an outline of fenced divs, headings, `.include` targets, quote markers, external concepts, and `{{meta:...}}` placeholders |
| `validate_markdown` | Validate IASP Markdown | Check for unbalanced `:::` fences, level-1 headings inside sidebars, nested shorthand fences with attributes, missing `.include` files, and unknown/retired classes |
| `render_document` | Render IASP Markdown | Render a Markdown file, inline Markdown, `"demo"`, or `"interop"` to `md`, `ghost`, `html`, `pdf`, `pdf-print`, `epub`, `docx`, or `rtf`, with automatic SKOS & quote provenance binding |
| `wrap_by_directory` | Wrap Markdown files by directory | Preview or apply directory-based IASP wrapper fences (`chapters/`, `sidebars/`, `appendices/`, `articles/`) |
| `ai_disclosure` | Manage article AI disclosure sidecar | Read or update a per-article `<article>.ai.json` sidecar and preview its rendered disclosure block |
| `iasp_status` | IASP server status | Terminology sync cursor, term and concept-set counts, and local toolchain status |

## The typical flow

1. **Choose or check intent**: `list_terms`, `get_term`, or `compose_intent` (e.g. `composition: "note.insight.major"` or `composition: "sidebar.example"`).
2. **Inspect and validate the draft**: `inspect_markdown` and `validate_markdown` on the Markdown file or string before running Pandoc.
3. **Render**: `render_document` to produce `md` (clean Markdown with blockquotes and glyph/label headers), `ghost` (Ghost CMS Markdown with inline-styled HTML `<div>` cards), `html` (standalone HTML with embedded CSS and SKOS RDFa), `pdf` / `pdf-print` (XeLaTeX), `epub` (validated with `epubcheck`), `docx`, or `rtf`.

## Vocabulary & composition tools

### `list_terms`

Every argument is optional, and they combine.

| Argument | What it does |
|---|---|
| `axis` | `"delivery-role"` (Axis A), `"modifier"` (Axis B), or `"any"`. |
| `group` | Modifier group slug: `"argument-and-reasoning"`, `"exposition-and-support"`, `"reader-signals-and-stance"`, or `"reader-navigation"`. |
| `set` | Profile concept set slug: `"core"`, `"delivery-order"`, or `"note-variants"`. When `"delivery-order"` is selected, terms are returned in reading order. |
| `query` | Case-insensitive substring search across label, alternative labels, Pandoc class notations, and scope note. |
| `status` | `"active"` (default), `"provisional"`, `"retired"`, or `"any"`. |
| `include_grouping` | Include axis/group container concepts that have no Pandoc class notation of their own (`true` by default). |

### `get_term`

Resolves a single IASP term by slug (`"insight-major"`), Pandoc notation (`"insight.major"`), alternative label (`"orientation"` → `navigation`), or `terminology-mcp` ID (`"t_..."`), or resolves a build modifier (such as `"layout-fullpage"`, `"table-compact"`, `"draft"`). Returns its scope note, broader/narrower/related/opposite connections, external `closeMatch` URIs (`epub:type` SSV, DPUB-ARIA, WAI-ARIA), set memberships, and rendering details across HTML/EPUB, XeLaTeX, and Ghost.

### `compose_intent`

Pass either `composition` (e.g. `"note.insight.major"`, `"sidebar.example"`, `"{.bridge .reflection .pre-pagebreak}"`) or `delivery` + `modifiers`. Returns:
- `valid`: whether every token is a recognized IASP term or build modifier.
- `delivery_role`, `modifiers`, `build_modifiers`, `unknown_tokens`, and `warnings` (such as retired terms, alternative labels like `orientation`, or modifiers composed with `note` that are outside the 23 styled `note-variants`).
- `intent_summary`: plain-English explanation of what each layer contributes.
- `syntax`: ready-to-paste `brace_fence`, `shorthand_fence`, and `heading_attribute` snippets.
- `rendering`: how EPUB/HTML, XeLaTeX PDF, and Ghost Markdown render the composition.

## Inspection & validation tools

### `inspect_markdown`

Takes `path` or inline `markdown`. Returns:
- `frontmatter`: parsed YAML front matter keys.
- `top_headings`: headings outside fenced blocks.
- `blocks`: recursive tree of fenced divs with line numbers, `delivery_role`, `modifiers`, `build_modifiers`, `external_concepts` (`concepts="..."`), `unknown_classes`, and inner headings.
- `includes`: every `.include` directive with its target path, mode, and whether the target exists on disk.
- `quote_markers`: every `<!-- quote <id> ... -->` marker with its line number and any inline `concepts`, `citekey`, or `workKey`.
- `meta_placeholders`: all `{{meta:...}}` keys referenced in the document.

### `validate_markdown`

Takes `path` or inline `markdown` and checks five authoring rules before Pandoc runs:
1. **Fence balance (`unclosed-fence`, `extra-closer`)**: Every opening `:::` fence must have a matching closing `:::` on its own line.
2. **Sidebar heading levels (`sidebar-h1`)**: Warns if a level-1 heading (`# Title`) is used inside `.sidebar` or `.aside` (which breaks XeLaTeX `mdframed` badge placement; use `##` or deeper).
3. **Nested shorthand with attributes (`nested-shorthand`)**: Warns when a shorthand fence with attributes is nested inside an outer div without curly braces `{.class}`.
4. **Vocabulary check (`unknown-class`, `retired-term`, `alt-label-class`, `unstyled-note-modifier`)**: Checks every class token against the live `iasp` scheme from `terminology-mcp`.
5. **Include existence (`missing-include`)**: Verifies that every `.include` block specifies a `path` or `dir` that exists.

## Rendering & workflow tools

### `render_document`

| Argument | What it does |
|---|---|
| `source` | Path to a Markdown file, `"demo"` (`demo/essay-on-attentive-reading.md`), or `"interop"` (`demo/interoperability-essay.md`). |
| `markdown` | Inline Markdown string to render instead of a file on disk. |
| `formats` | Array of `"md"`, `"ghost"`, `"html"`, `"pdf"`, `"pdf-print"`, `"epub"`, `"docx"`, `"rtf"` (default `["md", "html", "ghost"]`). |
| `stage` | `"final"` (default; renders `.final`, strips `.draft`) or `"draft"` (renders `.draft`, strips `.final`). |
| `bibliography` | Path to a `.bib` file for Pandoc `--citeproc`. |
| `bibtex_content` | Inline BibTeX entries (e.g. from `zotero_export_bibliography` or `corpus_cite_passage`) for `--citeproc` when calling `render_document` over the remote MCP portal. |
| `csl` | Optional `.csl` citation style path. |
| `ai_disclosure`, `technical_note`, `disclosure_variant` | Inline AI disclosure metadata when rendering inline Markdown over remote MCP without a local `.ai.json` sidecar. |
| `optimize_pdf` | Linearize generated PDFs with `qpdf --linearize` when available (`true` by default). |
| `validate_epub` | Validate generated EPUBs with `epubcheck` (`false` by default; `true` in `npm run demo`). |
| `return_content` | Include the rendered text in the tool response for `"md"`, `"ghost"`, and `"html"`. |

The response includes both `artifacts` (format, output path, byte size, warnings, linearization/epubcheck flags) and `provenance` (the resolved `quotes` and external `concepts` manifest bound into the output).
