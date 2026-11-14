# MCP tools

`iasp-mcp`'s tools at `/mcp` (Streamable HTTP, stateless) and over stdio (`npm run iasp -- stdio`).

| Tool | Title | What it does |
|---|---|---|
| `list_terms` | List IASP terms and profile sets | Browse or search the `iasp` scheme synced from `terminology-mcp` by axis, modifier group, concept set (`core`, `delivery-order`, `note-variants`), status, or query; includes the profile concept sets summary and each term's Pandoc notations and rendering summary |
| `compose_intent` | Compose or inspect IASP intent | Validate and explain a single IASP term/build modifier or a composed class expression (`note.insight.major`, `sidebar.example`, `bridge.reflection.pre-pagebreak`, `layout-fullpage`) and return ready-to-paste Pandoc syntax and rendering details |
| `get_authoring_guide` | Get IASP authoring guide | Topic-scoped reference guide (`overview`, `wrappers`, `note-variants`, `sidebars`, `includes`, `tables`, `pagination`, `stages`, `ai-disclosure`, `ghost`) |
| `inspect_markdown` | Inspect IASP Markdown | Parse a Markdown file or string into an outline of fenced divs, headings, `.include` targets, quote markers, external concepts, and `{{meta:...}}` placeholders |
| `validate_markdown` | Validate IASP Markdown | Check for unbalanced `:::` fences, level-1 headings inside sidebars, nested shorthand fences with attributes, missing `.include` files, unknown/retired classes, and quoted words and citations against `quote-mcp` |
| `render_document` | Render IASP Markdown | Render a Markdown file, inline Markdown, `"demo"`, or `"interop"` to `md`, `ghost`, `html`, `pdf`, `pdf-print`, `epub`, `docx`, or `rtf`, with automatic SKOS & quote provenance binding |
| `wrap_by_directory` | Wrap Markdown files by directory | Preview or apply directory-based IASP wrapper fences (`chapters/`, `sidebars/`, `appendices/`, `articles/`) |
| `ai_disclosure` | Manage article AI disclosure sidecar | Read or update a per-article `<article>.ai.json` sidecar and preview its rendered disclosure block |
| `status` | IASP server status | Terminology sync cursor, term and concept-set counts, and local toolchain status (exposed as `iasp_status` when prefixed by the Cloudflare MCP Portal) |

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

The response includes `sets` (the `core`, `delivery-order`, and `note-variants` profile sets with their descriptions and member counts) and `terms`. For cross-scheme SKOS graph traversal or proposing new taxonomy terms, use `terminology-mcp`'s tools (`terminology_get_term`, `terminology_get_graph`, `terminology_propose_term`).

### `compose_intent`

Pass either `composition` (a single term/build modifier such as `"sidebar"` or `"layout-fullpage"`, or a multi-token expression such as `"note.insight.major"`, `"sidebar.example"`, `"{.bridge .reflection .pre-pagebreak}"`) or `delivery` + `modifiers`. Returns:
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

Takes `path` or inline `markdown` and checks seven authoring rules before Pandoc runs:
1. **Fence balance (`unclosed-fence`, `extra-closer`)**: Every opening `:::` fence must have a matching closing `:::` on its own line.
2. **Sidebar heading levels (`sidebar-h1`)**: Warns if a level-1 heading (`# Title`) is used inside `.sidebar` or `.aside` (which breaks XeLaTeX `mdframed` badge placement; use `##` or deeper).
3. **Nested shorthand with attributes (`nested-shorthand`)**: Warns when a shorthand fence with attributes is nested inside an outer div without curly braces `{.class}`.
4. **Vocabulary check (`unknown-class`, `retired-term`, `alt-label-class`, `unstyled-note-modifier`)**: Checks every class token against the live `iasp` scheme from `terminology-mcp`.
5. **Include existence (`missing-include`)**: Verifies that every `.include` block specifies a `path` or `dir` that exists.
6. **Epigraph blockquotes (`epigraph-blockquote`)**: Warns when lines inside a `::: {.epigraph}` fence start with `> `. The epigraph is already a quotation, so the `>` nests a second blockquote in HTML, PDF, and EPUB. The Ghost and md exporters drop that one `>` level.
7. **Quotes (`quote-text-differs`, `quote-text-excerpt`, `quote-text-unchecked`, `quote-citekey-differs`, `quote-citation-missing`, `quote-locator-differs`, `quote-marker-orphan`, `unmarked-block-quote`)**: Each `<!-- quote <id> -->` marker is looked up in `quote-mcp` (`get_quote`, `cite_quote`), and the passage after it is compared with the saved quote:
   - A **block quote** after the marker must equal the saved words, once citations (`[@...]`), footnote references (`[^x]`), `>` prefixes, and line wrapping are removed and whitespace is collapsed. Typography Pandoc's `smart` extension renders identically (straight and curly quotes, `--`/`–`, `---`/`—`, `...`/`…`), Markdown escapes, and `*emphasis*` marks are not counted as differences.
   - A block quote that is an unchanged **excerpt** of the saved words is a warning (`quote-text-excerpt`), not an error: either one contiguous run of the saved text, or runs separated by `…` / `...` / `[…]` / `[...]` that appear in the saved text in that order. An ellipsis the saved text itself contains is matched literally first. Anything else is `differs`, an error.
   - A **run-in quote** (the marker before an ordinary paragraph) must contain the saved words, minus trailing `.,;:`, unchanged.
   - Fence openers between the marker and the passage (`::: {.epigraph}`) are skipped.
   - The passage's citation (on the passage, in its footnotes, or in the paragraph right after it, such as an epigraph's attribution line) must cite the quote's citekey (an error otherwise); a locator that disagrees with the stored one is a warning. These count as the same place: `p.`/`page`, `chap.`/`chapter`, spacing, a trailing `, emphasis added`; a quoted title and `chap. <that title>`; `bk. N` / `book N` and `chap. BOOK N`; and a leading italic work title is ignored (`*Iliad* bk. XXIV`).
   - A block quote with no marker is a warning. A marker that names a `quote-mcp` note is reported as `note`, not compared.
   - When `quote-mcp` is off (`QUOTE_BASE=off`) or unreachable, each marked quote is `unchecked` with the reason, and a warning says so.

   Per-marker results are in `quotes.checks`: `{ id, line, kind: "block" | "run-in" | "none", text: "matches" | "excerpt" | "differs" | "unchecked" | "note", reason?, excerpt?: "contiguous" | "elided", pieces? (for elided), saved_at_difference?, draft_at_difference?, citekey: "matches" | "differs" | "missing" | "unchecked", locator: "matches" | "differs" | "absent" | "unchecked", cited?: { key, locator? }, saved?: { citekey?, locator? } }`. The `*_at_difference` snippets hold about 30 characters either side of the first difference. `quotes.unmarked_block_quotes` lists block quotes with no marker.

## Rendering & workflow tools

### `render_document`

| Argument | What it does |
|---|---|
| `source` | Path to a Markdown file, `"demo"` (`demo/essay-on-attentive-reading.md`), or `"interop"` (`demo/interoperability-essay.md`). |
| `markdown` | Inline Markdown string to render instead of a file on disk. |
| `formats` | Array of `"md"`, `"ghost"`, `"html"`, `"pdf"`, `"pdf-print"`, `"epub"`, `"docx"`, `"rtf"` (default `["md", "html", "ghost"]`). |
| `output_dir` | Where to write the renders. Defaults to the render directory (`IASP_RENDER_DIR`, `build/renders` locally and `/var/lib/iasp-mcp/renders` on the server). A relative path is a subdirectory of it and is refused if it climbs out with `..`; an absolute path is used as given. |
| `output_basename` | Base filename without extension (defaults to the source file's name). |
| `stage` | `"final"` (default; renders `.final`, strips `.draft`) or `"draft"` (renders `.draft`, strips `.final`). |
| `bibliography` | Path to a bibliography (`.bib`, CSL `.json`, or any format Pandoc reads) for `--citeproc`. Defaults to the frontmatter `bibliography`. Applies to every format: `md` and `ghost` resolve `[@key, loc]` citations in place and fill the `## References` (or `Bibliography` / `Works Cited`) section; a note-style `csl` turns citations into `[^iasp-cite-N]` footnotes. If citations are present but no bibliography is available, `md` and `ghost` leave them as written and return a warning. |
| `bibtex_content` | Inline BibTeX entries for `--citeproc`. Optional: see [Bibliography from the library](#bibliography-from-the-library). |
| `csl` | Optional `.csl` citation style path. |
| `ai_disclosure`, `technical_note`, `disclosure_variant` | Inline AI disclosure metadata when rendering inline Markdown over remote MCP without a local `.ai.json` sidecar. |
| `optimize_pdf` | Linearize generated PDFs with `qpdf --linearize` when available (`true` by default). |
| `validate_epub` | Validate generated EPUBs with `epubcheck` (`false` by default; `true` in `npm run demo`). |
| `return_content` | Include the rendered text in the tool response for `"md"`, `"ghost"`, and `"html"` (default `false`; fetch the artifact's `url` instead). |
| `keep_title_h1` | `ghost` only: keep the body's leading `# Title` heading. By default it is stripped, because Ghost shows the post title from its own title field. |

The response includes:

- `artifacts`: format, output path, byte size, warnings, linearization/epubcheck flags, and `url` / `public_url` (see [Renders by URL](#renders-by-url)).
- `provenance`: the resolved `quotes` and external `concepts` manifest bound into the output, plus `checks`, `unmarked_block_quotes`, `unavailable`, and `issues` from the same quote check `validate_markdown` runs.
- `bibliography`: where each cited key's entry came from, and what could not be found.

#### Bibliography from the library

Cited keys that neither `bibtex_content` nor `bibliography` (or the frontmatter `bibliography`) supplies are fetched. Entries the author passed always win: only the missing keys are asked for.

1. `holdings-mcp` (`HOLDINGS_BASE`, `GET /api/bibliography?citekeys=a,b`) returns CSL JSON for works filed in Zotero, and names Calibre books not in Zotero yet (`unfiled`).
2. For each unfiled book, `corpus-mcp` (`CORPUS_BASE`, `GET /api/csl?book=<book id or Calibre UUID>`) returns its CSL JSON. The item is cited by the key the document uses, whatever id corpus-mcp gave it.

The fetched items go to `--citeproc` as CSL JSON next to any BibTeX given, for every format. `bibliography` in the response holds:

- `sources`: `{ "<citekey>": "author" | "zotero" | "corpus" }`.
- `missing`: keys in bracketed citations that no source had.
- `ambiguous`: keys `holdings-mcp` matched to more than one work, with their candidates.
- `unfiled`: keys resolved from a Calibre book that is not filed in Zotero yet.
- `warnings`: one line for each of the above, plus `corpus-mcp`'s own warnings and any lookup that failed. A failed lookup never fails the render.

#### Renders by URL

Every file under the render directory is served at `GET /renders/<path under the render directory>`:

- On the LAN, directly.
- Through the tunnel, only with a verified Cloudflare Access token.

Paths that climb out of the directory, follow a symlink out of it, or name a hidden file (render temp files) get a 404. Rendered HTML is served with `Content-Security-Policy: sandbox`.

Each artifact written inside the render directory gets:

- `url`: the LAN address. The base is `IASP_URL`, else the host a LAN MCP request came to, else `http://iasp-mcp.localdomain:<port>`. Over stdio there is no `url` unless `IASP_URL` is set, since a local checkout renders into its own `build/renders`.
- `public_url`: the tunnel address. The base is `IASP_PUBLIC_URL`, else `https://<host>` when the MCP request itself came through the tunnel (and its Host is the public name, not a rewritten `.localdomain` one).

An absolute `output_dir` outside the render directory gets no URL.
