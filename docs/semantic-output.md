# Retaining SKOS & Multi-Server Provenance in Rendered Output

When a manuscript or essay is rendered to HTML, EPUB, or Ghost Markdown and published to the web, ordinary Pandoc pipelines strip away the semantic intent and cross-server provenance used to construct it, leaving only visual CSS classes or inline styles.

`iasp-mcp` preserves two layers of machine-readable semantic metadata directly on the rendered HTML and Ghost DOM elements:

1. **IASP Authoring Semantics (`iasp` scheme on `terminology-mcp`)**: What rhetorical or structural role each block plays (`delivery.modifier`).
2. **External Vocabulary Concepts & Quote Provenance (`human-work`, `cc-subjects`, `quote-mcp`, `holdings-mcp`)**: Which verified quote record, bibliographic work, and subject/theme concepts a passage or block is about.

## 1. IASP SKOS annotations on semantic blocks

Both the Pandoc Lua filter (`assets/lua/iasp-semantics.lua`) and the Ghost exporter (`src/ghost.ts`) map every IASP fenced div and semantic heading to its canonical `terminology-mcp` slug, URN, and public resolution URL on `vocabulary.majerus.us`.

For example, a block written as:

```markdown
::: note.insight.major
**Taxonomy as a living replica:** ...
:::
```

renders in standalone **HTML** and **Ghost Markdown** with:

```html
<div class="note insight major"
     epub:type="note"
     vocab="http://www.w3.org/2004/02/skos/core#"
     typeof="Concept"
     resource="urn:iasp:concept:insight-major"
     data-iasp-delivery="note"
     data-iasp-modifiers="insight-major"
     data-iasp-concepts="urn:iasp:concept:note urn:iasp:concept:insight-major"
     data-iasp-terms="https://vocabulary.majerus.us/api/schemes/iasp/slugs/note https://vocabulary.majerus.us/api/schemes/iasp/slugs/insight-major">
```

| Attribute | Meaning |
|---|---|
| `vocab="http://www.w3.org/2004/02/skos/core#"` | Declares the W3C SKOS vocabulary for RDFa processors (emitted in HTML and Ghost; omitted in EPUB 3 so `epubcheck` passes cleanly). |
| `typeof="Concept"` | Marks the block as an instance of a SKOS `Concept`. |
| `resource="urn:iasp:concept:<slug>"` | The primary (most specific) IASP concept URN for the block. |
| `data-iasp-delivery` | The resolved Axis A delivery role slug (`note`, `sidebar`, `bridge`, `callout`, `epigraph`, etc.). |
| `data-iasp-modifiers` | Space-separated Axis B modifier slugs (`insight-major`, `methodology`, `contrast`, `warning`, etc.). |
| `data-iasp-concepts` | Space-separated canonical URNs (`urn:iasp:concept:<slug>`) for every IASP concept composed on the block. |
| `data-iasp-terms` | Space-separated public resolution URLs (`https://vocabulary.majerus.us/api/schemes/iasp/slugs/<slug>`). |

## 2. External vocabulary concepts (`concepts="..."`) and quote provenance (`<!-- quote <id> -->`)

When authoring across the MCP suite, passages and notes often carry subject or theme concepts from external schemes in `terminology-mcp` (such as `human-work:curiosity`, `human-work:learning`, or `human-work:confirmation-bias`) and quote IDs from `quote-mcp`.

### Authoring syntax

You can attach external concepts and provenance in two ways (and combine them):

1. **On a quote marker comment (`<!-- quote <id> ... -->`)**:
   ```markdown
   <!-- quote 831 concepts="human-work:confirmation-bias" -->
   > We like to think our beliefs are founded on a fair survey of the best available evidence... [@brotherton2015suspicious, chap. 11]
   ```
   Or write a bare marker (`<!-- quote 831 -->`) and let `iasp-mcp` fetch the quote's concepts, `citekey`, `workKey`, and `locator` automatically from `quote-mcp` at build time.
   A quote marker immediately preceding an `::: {.epigraph}` block binds its attributes directly onto the epigraph container; a quote marker preceding a standard Markdown blockquote (`> ...`) wraps the blockquote in `<div class="iasp-quote" ...>`.

2. **On any IASP fenced block (`concepts="..."`)**:
   ```markdown
   ::: {.note .contrast concepts="human-work:curiosity human-work:confirmation-bias"}
   **Open inquiry vs. reverse-engineered certainty:** ...
   :::
   ```
   Unprefixed tokens default to `human-work:<slug>`; prefixed tokens (`scheme:slug`, such as `cc-subjects:epistemology` or `human-work:curiosity`) resolve against the named scheme in `terminology-mcp`.

### Automatic cross-server resolution (`src/provenance.ts`)

During `render_document`, `buildProvenanceManifest`:
1. Scans the Markdown for all `<!-- quote <id> -->` markers and `concepts="..."` attributes.
2. Queries `quote-mcp` (`get_quote`) for each referenced quote ID to retrieve its `citekey`, `workKey` (`zotero:users/827407/J2U9WJQC`), `locator` (`p. 211`), and stored `human-work` concept tags, merging them with any inline attributes.
3. Queries `terminology-mcp` (`/api/schemes/:scheme/slugs/:slug`) for each concept to resolve its canonical URN (`sourceUri` such as `urn:quote-mcp:concept:human-work:curiosity`, or `urn:terminology-mcp:term:<id>` for newly proposed terms such as `confirmation-bias`) and its public URL on `vocabulary.majerus.us`.
4. Falls back deterministically to the inline tokens when `quote-mcp` or `terminology-mcp` is unreachable.

### Emitted attributes on quotes and concept-tagged blocks

```html
<!-- quote 831 concepts="human-work:confirmation-bias" -->
<div class="iasp-quote"
     data-quote-id="831"
     data-citekey="brotherton2015suspicious"
     data-work-key="zotero:users/827407/J2U9WJQC"
     data-concepts="human-work:confirmation-bias"
     data-concept-uris="urn:terminology-mcp:term:t_60fab99204f4479680df679ef2d94434"
     data-concept-terms="https://vocabulary.majerus.us/api/schemes/human-work/slugs/confirmation-bias"
     about="urn:terminology-mcp:term:t_60fab99204f4479680df679ef2d94434"
     vocab="http://www.w3.org/2004/02/skos/core#">
  <blockquote>...</blockquote>
</div>
```

And on a semantic block that carries both IASP intent and external `human-work` concepts:

```html
<div class="note contrast"
     epub:type="note"
     vocab="http://www.w3.org/2004/02/skos/core#"
     typeof="Concept"
     resource="urn:iasp:concept:contrast"
     data-iasp-delivery="note"
     data-iasp-modifiers="contrast"
     data-iasp-concepts="urn:iasp:concept:note urn:iasp:concept:contrast"
     data-iasp-terms="https://vocabulary.majerus.us/api/schemes/iasp/slugs/note https://vocabulary.majerus.us/api/schemes/iasp/slugs/contrast"
     about="urn:quote-mcp:concept:human-work:curiosity urn:terminology-mcp:term:t_60fab99204f4479680df679ef2d94434"
     data-concepts="human-work:curiosity human-work:confirmation-bias"
     data-concept-uris="urn:quote-mcp:concept:human-work:curiosity urn:terminology-mcp:term:t_60fab99204f4479680df679ef2d94434"
     data-concept-terms="https://vocabulary.majerus.us/api/schemes/human-work/slugs/curiosity https://vocabulary.majerus.us/api/schemes/human-work/slugs/confirmation-bias">
```

| Attribute | Meaning |
|---|---|
| `about` | RDFa subject URI(s) naming the external SKOS concepts this passage or block is about (distinct from `resource`, which names the block's IASP rhetorical role). |
| `data-concepts` | Space-separated `scheme:slug` identifiers (`human-work:curiosity human-work:confirmation-bias`). |
| `data-concept-uris` | Space-separated canonical URNs from `terminology-mcp` (`urn:quote-mcp:concept:human-work:...` or `urn:terminology-mcp:term:...`). |
| `data-concept-terms` | Space-separated public terminology URLs (`https://vocabulary.majerus.us/api/schemes/<scheme>/slugs/<slug>`). |
| `data-quote-id` | The verified quote ID in `quote-mcp`. |
| `data-citekey` | The Better BibTeX citekey for the quoted work. |
| `data-work-key` | The unified work key in `holdings-mcp` (`zotero:users/827407/...`). |
| `data-quote-locator` | The printed page or section locator from `quote-mcp` when present. |
