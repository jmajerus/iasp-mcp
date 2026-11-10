# Six-Server Authoring Interoperability

`iasp-mcp` is designed to work alongside its five sibling MCP servers in the Cloudflare Authoring Portal (`https://mcp.majerus.us/mcp`). Together, they cover the entire lifecycle of scholarly and long-form nonfiction authoring:

| Server | Role in an authoring session | Key tools used |
|---|---|---|
| **[terminology-mcp](https://github.com/jmajerus/terminology-mcp)** | Master taxonomy store for `iasp` (authoring roles/modifiers), `human-work` (passage themes), and `cc-subjects` (subject classification) | `list_schemes`, `search_terms`, `get_term`, `propose_term` |
| **[holdings-mcp](https://github.com/jmajerus/holdings-mcp)** | Unified lookup across Zotero, Calibre, and the quote store (`zotero:<library>/<key>` and citekeys) | `find_work`, `get_work` |
| **[corpus-mcp](https://github.com/jmajerus/corpus-mcp)** | Full-text search, reading, passage verification, and copyright/edition metadata from Calibre books | `search_corpus`, `read_book`, `cite_passage` |
| **[quote-mcp](https://github.com/jmajerus/quote-mcp)** | Verified and transcribed quotations and margin notes tagged with `human-work` concepts | `search_quotes`, `get_quote`, `cite_quote`, `add_quote` |
| **zotero-mcp** | Bibliographic management and CSL / BetterBibTeX export from Zotero | `zotero_search_items`, `zotero_export_bibliography` |
| **[iasp-mcp](https://github.com/jmajerus/iasp-mcp)** | Compositional IASP intent (`delivery.modifier`), static Markdown validation, SKOS/quote provenance binding, and multi-format rendering | `compose_intent`, `validate_markdown`, `render_document` |

## The bundled interoperability demonstration

`demo/interoperability-essay.md` (*"The Chamber and the System: Curiosity, Confirmation, and Open Inquiry"*) was built in a single agent session across all six servers:

1. **Concept discovery (`terminology-mcp`)**:
   - Resolved `human-work:curiosity` (`t_04e811f7b7ab494a8ae8113b95a2f1ca`), `human-work:learning` (`t_9d8bdf1ed9764343aef8fd4bdb1f1221`), and `human-work:confirmation-bias` (`t_60fab99204f4479680df679ef2d94434`) alongside the `iasp` delivery roles and modifiers (`epigraph`, `note.prelude`, `note.insight`, `sidebar.methodology`, `note.contrast`, `note.warning`, `note.synthesis`).
2. **Work & holding discovery (`holdings-mcp`)**:
   - Called `find_work(has: ["text", "quotes"])` to find works with both searchable Calibre text and saved quotes:
     - Joseph Conrad, *Complete Works of Joseph Conrad* (`zotero:users/827407/D9M2F2GA`, `conrad2020complete`, Calibre `main:570`)
     - Thich Nhat Hanh, *Fidelity* (`zotero:users/827407/9I4PBQ68`, `hanh2007fidelity`, Calibre `main:581`)
     - Diana Montalion, *Learning Systems Thinking* (`zotero:users/827407/9U7ZWKJ6`, `montalion2024learning`, Calibre `main:223`)
     - Rob Brotherton, *Suspicious Minds* (`zotero:users/827407/J2U9WJQC`, `brotherton2015suspicious`, Calibre `main:53`)
3. **Verified quotes & locators (`quote-mcp` & `corpus-mcp`)**:
   - Retrieved verified quotes `832` (Conrad), `829` (Hanh), `828` (Montalion), and `831` (Brotherton) via `quote_cite_quote` and checked edition metadata via `corpus_cite_passage`.
4. **Bibliography generation (`zotero-mcp`)**:
   - Exported the four Zotero items (`9U7ZWKJ6`, `9I4PBQ68`, `J2U9WJQC`, `D9M2F2GA`) as BibTeX via `zotero_export_bibliography` into `demo/references.bib` (or passed inline via `bibtex_content` when rendering remotely).
5. **Validation, provenance binding, and rendering (`iasp-mcp`)**:
   - Validated the draft with `validate_markdown` and rendered `md`, `ghost`, `html`, `pdf`, and `epub` with `render_document(source: "interop")`.
   - During rendering, `iasp-mcp` queried `quote-mcp` and `terminology-mcp` to bind `data-quote-id`, `data-citekey`, `data-work-key`, `data-concepts`, `data-concept-uris`, `data-concept-terms`, and RDFa `about` / `resource` attributes onto every quoted passage and semantic block.

## Running or viewing the interoperability demo

From the CLI:

```bash
npm run demo                           # Builds both "demo" and "interop" into build/renders/
npm run iasp -- render interop         # Builds demo/interoperability-essay.md
```

On the web interface (`http://iasp-mcp.localdomain:8000/` or the public tunnel):
- `/interop/html` — Standalone HTML with formatted `--citeproc` citations, bibliography, IASP CSS, and embedded SKOS RDFa + `quote-mcp` provenance attributes.
- `/interop/md` — Clean pure Markdown with blockquotes and glyph/badge headers.
- `/interop/ghost` — Ghost CMS Markdown with inline-styled HTML cards and SKOS/quote provenance attributes.
- `/interop/pdf` — Screen PDF built with XeLaTeX and linearized with `qpdf`.
