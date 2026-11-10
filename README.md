# iasp-mcp

Authoring MCP server for the **Informative Authoring Semantics Profile (IASP)**
and its Pandoc / XeLaTeX / EPUB / Ghost rendering pipeline.

IASP gives authors and agents names for *what a passage of long-form nonfiction
or an essay is doing* along two composable axes:

- **Axis A — Delivery Roles** (`front-matter`, `series`, `part`, `chapter`,
  `section`, `interlude`, `bridge`, `sidebar`, `sidebar-inline`, `callout`,
  `note`, `footnote`, `endnotes`, `epigraph`, `epigraph-inline`, `appendix`,
  `back-matter`): how a passage sits relative to the main narrative flow.
- **Axis B — Modifiers**: the rhetorical move (`thesis`, `claim`,
  `counterpoint`, `qualification`, `implication`, `synthesis`, `integration`,
  `contrast`, `reflection`, `provocation`), expository support (`example`,
  `case-study`, `background`, `context`, `definition`, `gloss`, `analogy`,
  `insight`, `insight.major`, `idea`, `usage`, `methodology`, `diagnostic`,
  `checklist`), reader stance (`warning`, `notice`, `caution`, `misuse`,
  `assumption`, `limitation`, `scope`, `uncertainty`, `disclosure`,
  `responsibility`, `reflexive`), or reader navigation cue (`breadcrumb`,
  `navigation`, `transition`, `prelude`, `closing`).

`terminology-mcp` (`http://terminology-mcp.localdomain:8000`) holds the master
`iasp` concept scheme (63 terms and 3 profile concept sets: `core`,
`delivery-order`, and `note-variants`). `iasp-mcp` follows its numbered
changelog and joins each concept with concrete syntax, static validation, and
multi-format rendering.

See [PLAN.md](PLAN.md) for the architecture, audit of `iasp_tooling/`, data
model, and roadmap.

## Quick start

Requires Node.js 22+ (and `pandoc`, `xelatex`, `qpdf`, `epubcheck` for full
PDF/EPUB builds).

```sh
npm install
npm run terms      # Sync the `iasp` scheme from terminology-mcp.localdomain:8000
npm run demo       # Render demo/essay-on-attentive-reading.md to Ghost, HTML, PDF, and EPUB
npm run serve      # Start HTTP server + /mcp endpoint on http://127.0.0.1:8000
```

Open **http://127.0.0.1:8000/** to browse the live IASP vocabulary, Note
Variants visual palette, interactive Composition Explorer, and rendered
demonstration outputs (`/demo/html`, `/demo/ghost`, `/demo/pdf`).

## MCP tools

Connect an MCP client to **`http://127.0.0.1:8000/mcp`** (Streamable HTTP) or
run `npx tsx src/cli.ts stdio`:

| Tool | Purpose |
|---|---|
| `list_terms` | Browse/search IASP terms by axis (`delivery-role`, `modifier`), modifier group, concept set (`core`, `delivery-order`, `note-variants`), or query text |
| `get_term` | Full definition, relations, EPUB/ARIA links, and rendering details for a term or build modifier |
| `list_sets` | List the `iasp` profile concept sets and their expanded members |
| `compose_intent` | Validate and explain a composed class expression (`note.insight.major`, `sidebar.example`, `bridge.reflection.pre-pagebreak`) and return ready-to-paste Pandoc syntax |
| `get_authoring_guide` | Topic-scoped authoring reference (`overview`, `wrappers`, `note-variants`, `sidebars`, `includes`, `tables`, `pagination`, `stages`, `ai-disclosure`, `ghost`) |
| `inspect_markdown` | Parse a Markdown file or string into an outline of IASP fenced blocks, headings, `.include` targets, quote markers, and `{{meta:...}}` placeholders |
| `validate_markdown` | Check for unbalanced `:::` fences, level-1 headings inside sidebars, nested shorthand fences, missing `.include` files, and unknown/retired classes |
| `render_document` | Render a Markdown file, inline Markdown, or `"demo"` to `ghost`, `html`, `pdf`, `pdf-print`, `epub`, `docx`, or `rtf` |
| `wrap_by_directory` | Preview or apply directory-based IASP wrapper fences (`chapters/`, `sidebars/`, `appendices/`, `articles/`) |
| `ai_disclosure` | Read or update a per-article `.ai.json` AI disclosure sidecar and preview its rendered block |
| `iasp_status` | Terminology sync cursor, term/set counts, and local Pandoc/XeLaTeX/qpdf/epubcheck status |

## Verification

```sh
npm run typecheck
npm test
npm run build
```
