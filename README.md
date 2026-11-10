# iasp-mcp

Authoring [MCP](https://modelcontextprotocol.io/) server for the **Informative Authoring Semantics Profile (IASP)** and its Pandoc, XeLaTeX, EPUB, and Ghost rendering pipeline.

IASP gives authors and agents names for *what a passage of long-form nonfiction or an essay is doing* along two composable axes (`delivery.modifier`):

- **Axis A — Delivery Roles** (`front-matter`, `series`, `part`, `chapter`, `section`, `interlude`, `bridge`, `sidebar`, `sidebar-inline`, `callout`, `note`, `footnote`, `endnotes`, `epigraph`, `epigraph-inline`, `appendix`, `back-matter`): how a passage sits relative to the main narrative flow.
- **Axis B — Modifiers**: the rhetorical move (`thesis`, `claim`, `counterpoint`, `qualification`, `implication`, `synthesis`, `integration`, `contrast`, `reflection`, `provocation`), expository support (`example`, `case-study`, `background`, `context`, `definition`, `gloss`, `analogy`, `insight`, `insight.major`, `idea`, `usage`, `methodology`, `diagnostic`, `checklist`), reader stance (`warning`, `notice`, `caution`, `misuse`, `assumption`, `limitation`, `scope`, `uncertainty`, `disclosure`, `responsibility`, `reflexive`), or reader navigation cue (`breadcrumb`, `navigation`, `transition`, `prelude`, `closing`).

[terminology-mcp](https://github.com/jmajerus/terminology-mcp) holds the master `iasp` concept scheme (63 terms and 3 profile concept sets: `core`, `delivery-order`, and `note-variants`). `iasp-mcp` follows its numbered changelog and joins each concept with authoring guidance, static Markdown validation, multi-format rendering, and machine-readable SKOS / quote provenance retention.

## What it does

- **Follows the `iasp` taxonomy.** Syncs terms, notations, relations, and concept sets from `terminology-mcp` into a local SQLite replica (`data/iasp.db`) and reports subscriber progress.
- **Composes and validates intent.** Explains layered compositions (`note.insight.major`, `sidebar.example`, `bridge.reflection.pre-pagebreak`), generates Pandoc fenced-div and heading syntax, and checks Markdown drafts for unbalanced `:::` fences, level-1 headings inside sidebars, missing `.include` targets, and unknown or retired classes.
- **Retains SKOS & multi-server provenance in output.** Preserves inline SKOS RDFa (`vocab`, `typeof="Concept"`, `resource`, `about`), `data-iasp-*` attributes, external concept tags (`concepts="human-work:curiosity human-work:confirmation-bias"`), and `quote-mcp` / `holdings-mcp` provenance (`data-quote-id`, `data-citekey`, `data-work-key`) in rendered HTML, EPUB, and Ghost Markdown.
- **Renders end to end.** Builds clean Markdown (`md`), Ghost CMS Markdown (`ghost`), standalone HTML (`html`), screen and print PDFs via XeLaTeX and `qpdf` (`pdf`, `pdf-print`), EPUB 3 validated with `epubcheck` (`epub`), Word (`docx`), and RTF (`rtf`).

## Documentation

| Document | For |
|---|---|
| [MCP tools](docs/tools.md) | Every tool, its arguments, and what it returns |
| [Authoring with IASP](docs/authoring.md) | Axis A delivery roles, Axis B modifiers, the 23 styled `note.<variant>` options, `.include` directives, stages, and layout hints |
| [SKOS & multi-server provenance](docs/semantic-output.md) | Retaining SKOS RDFa, `data-iasp-*` attributes, external `concepts="..."` tags, and `quote-mcp` provenance in HTML, EPUB, and Ghost |
| [Six-server interoperability](docs/interoperability.md) | How `terminology-mcp`, `holdings-mcp`, `corpus-mcp`, `quote-mcp`, `zotero-mcp`, and `iasp-mcp` work together in `demo/interoperability-essay.md` |
| [Operations](docs/operations.md) | Commands, settings, `iasp-mcp.localdomain`, deploying, and the VS Code status-bar widgets |
| [PLAN.md](PLAN.md) | The plan of record: audit of `iasp_tooling/`, architecture, data model, and phases |

## Quick start

Requires Node.js 22 or later (plus `pandoc`, `xelatex`, `qpdf`, and `epubcheck` for PDF and EPUB builds).

```bash
npm install
cp .env.example .env    # optional: configure TERMINOLOGY_BASE or deploy credentials
npm run terms           # sync the `iasp` scheme from terminology-mcp.localdomain:8000
npm run demo            # render both demo essays (demo + interop) to md, ghost, html, pdf, and epub
npm run serve           # MCP at http://localhost:8000/mcp, web UI at /, admin at /admin
```

Open **http://localhost:8000/** to browse the live IASP vocabulary, Note Variants palette, interactive Composition Explorer, and rendered demonstrations (`/demo/{html,md,ghost,pdf}` and `/interop/{html,md,ghost,pdf}`).

Run the tests and typecheck with `npm test` and `npm run typecheck`. Deployment to `iasp-mcp.localdomain` and the VS Code status-bar widgets are covered in [Operations](docs/operations.md).
