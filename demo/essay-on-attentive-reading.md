---
title: "Naming What Prose Is Doing"
subtitle: "An End-to-End Demonstration of the Informative Authoring Semantics Profile"
author: "IASP Reference Demonstration"
version: "0.1.0"
lang: "en"
---

::: {.article}

# Naming What Prose Is Doing

### An End-to-End Demonstration of the Informative Authoring Semantics Profile (v{{meta:version}})

::: {.epigraph}
*Complex writing benefits from having names for complexity.*

— Informative Authoring Semantics Profile, Core Specification
:::

::: note.prelude
This short essay demonstrates the **Informative Authoring Semantics Profile (IASP)** across every target supported by `iasp-mcp`: standalone HTML, XeLaTeX PDF (screen and print), EPUB 3, and Ghost Markdown. Each semantic wrapper names *what a passage is doing* in the argument rather than how a particular format encodes it.
:::

## 1. Intent Before Formatting

When authors revise a long-form manuscript or essay, their marginalia rarely speak in the language of HTML tags or LaTeX environments. Instead, an author asks: *Is this paragraph part of the spine of the chapter, or is it a parallel digression? Is this aside offering a concrete example, stating a methodological premise, or warning against an easy misreading?*

IASP separates those two questions into orthogonal axes that compose with a dot (`delivery.modifier`):

1. **Axis A — Delivery Roles** (`chapter`, `section`, `bridge`, `sidebar`, `callout`, `note`, `footnote`, `epigraph`, `appendix`) describe how a passage sits relative to the main narrative flow.
2. **Axis B — Modifiers** (`thesis`, `counterpoint`, `example`, `definition`, `insight`, `warning`, `methodology`, `scope`, `synthesis`, `breadcrumb`, `closing`, and others) describe the intellectual move, expository support, or epistemic stance the passage contributes.

::: {.definition}
**Compositional Intent (`delivery.modifier`):** A two-part (or multi-part) Pandoc class token where the leftmost term names the *delivery role* and subsequent terms *qualify intent*. Writing `note.insight` does not mean "an insight is a subtype of note"; it means "this ancillary note functions as an insight at this point in the text."[^composition-note]
:::

::: note.contrast
**Structural markup vs. authoring intent:** EPUB Structural Semantics (`epub:type="aside"`) and DPUB-ARIA (`role="doc-example"`) name document structure for assistive technologies and reading systems. IASP names the author's rhetorical and epistemic intent first, then lets the Lua filter (`iasp-semantics.lua`) project that intent onto `epub:type`, ARIA roles, LaTeX `mdframed` environments, and Ghost HTML cards.
:::

## 2. Parallel Tracks, Examples, and Included Fragments

Not every supporting illustration belongs in the main column of an argument. A `sidebar` signals that a reader can pause for context or skip ahead without losing the thread. Composing `sidebar` with `example` or `background` records *why* the digression is there.

::: {.sidebar .sidebar-block .example}
## Case Illustration: One Source, Four Renderings

Consider a passage marked `::: note.warning`. During a build:

- **EPUB / HTML** receives `<div class="note warning" epub:type="note">` styled via CSS custom properties (`--note-border-color`, `--note-background-color`).
- **XeLaTeX PDF** wraps the block in `\begin{noteboxwarning}` with `\notevariant{warning}` injecting the calm `※` badge header.
- **Ghost Markdown** emits a CommonMark Type-6 HTML `<div>` container with an inline badge so inner Markdown (links, emphasis, footnotes) continues to parse natively.
:::

Long-form works also reuse sidebars or case studies across chapters and annexes via `.include` directives:

::: {.include path="demo/fragments/lexical-precision-sidebar.md"}
:::

::: {.callout}
Unmarked prose is always assumed to be part of the main flow. Silence is a valid authorial decision; IASP exists to support thinking, not to enforce exhaustive tagging.
:::

::: {.bridge .reflection}
Having seen how delivery roles and modifiers compose on individual blocks, we can examine how note variants and stage guards behave during iterative drafting and verification.
:::

## 3. Note Variants and Epistemic Stance

While any Axis B modifier may compose with any Axis A delivery role, the build pipeline recognizes twenty-two `note-variants` (tracked as a profile set in `terminology-mcp`), each with its own visual cadence:

::: note.insight.major
**Taxonomy as a living replica:** Because `iasp-mcp` follows `terminology-mcp`'s numbered changelog for the `iasp` scheme, adding or refining a modifier in `terminology-mcp` propagates automatically to the local SQLite store, MCP lookup tools, and Markdown validator.
:::

::: note.methodology
**Static verification before Pandoc runs:** The `validate_markdown` tool checks fence balance (`:::`), catches level-1 headers (`#`) inside sidebars before they corrupt LaTeX `mdframed` badge placement, verifies `.include` paths, and flags unknown or retired IASP classes against `terminology-mcp`.
:::

::: note.warning
Avoid using level-1 headings (`# Heading`) inside `.sidebar` or `.aside` wrappers. In XeLaTeX builds, `\section` spacing interacts poorly with framed sidebar boxes; use `##` or `###` instead.
:::

::: note.checklist
- **Delivery role chosen?** Leftmost class names placement relative to the main flow (`note`, `sidebar`, `bridge`, `callout`).
- **Modifier specific?** Qualifier names the rhetorical or expository work (`insight`, `contrast`, `methodology`, `warning`).
- **Fences balanced?** Every opening `:::` has a matching closing `:::` on its own line.
:::

::: {.note .draft}
**Draft-only working note:** This block carries `.draft` and appears only when rendered with `stage: "draft"`. Use `.draft` for authorial scaffolding or open questions that should stay out of reader-facing proofs.
:::

::: {.note .synthesis .final}
**Takeaway:** When authoring vocabulary, validation, and rendering share one semantic profile, writers can focus on prose and structure while agents handle verification and multi-format output.
:::

::: note.closing
End of the `iasp-mcp` reference demonstration. Use `render_document` with `source: "demo"` to rebuild this essay in `html`, `ghost`, `pdf`, `epub`, `docx`, or `rtf`.
:::

## Works Cited

- Majerus, John. *Informative Authoring Semantics Profile (IASP) — Core Specification*. 2026.

[^composition-note]: In Pandoc's fenced-div syntax, `::: note.insight` and `::: {.note .insight}` produce the same AST classes (`["note", "insight"]`) once processed by `iasp-semantics.lua`.

:::
