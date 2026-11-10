# Authoring with IASP

The **Informative Authoring Semantics Profile (IASP)** gives authors names for *what a passage of nonfiction is doing* — its placement relative to the main narrative flow and the rhetorical, expository, or stance-signaling work it performs.

Nothing in IASP is required. Unmarked text is always valid and assumed to be part of the main narrative flow.

## Two composable axes (`delivery.modifier`)

IASP separates intent into two axes that compose with a dot (`delivery.modifier`) or space-separated Pandoc classes (`{.delivery .modifier}`):

- **Axis A — Delivery Roles** (leftmost term): how a passage relates to the surrounding narrative flow.
- **Axis B — Modifiers** (subsequent terms): what kind of intellectual, expository, navigational, or stance-signaling work the passage does.

Writing `::: note.insight` or `::: {.note .insight}` does not mean "insight is a subtype of note"; it means *"this ancillary note functions as an insight here."*

### Axis A — Delivery Roles

Listed in `delivery-order` reading order, followed by build extensions:

| Notation | Role | Rendering summary |
|---|---|---|
| `front-matter`, `frontmatter` | Framing material (preface, introduction, TOC) | `epub:type="frontmatter"`; suppressed in standalone article builds |
| `series` | Optional super-division above parts | Structural wrapper |
| `part` | Major thematic division | `epub:type="part"`, `role="doc-part"`, LaTeX `parttitlepage` |
| `chapter` | Primary unit of argument | `epub:type="chapter"`, `role="doc-chapter"` |
| `section` | Subdivision within a chapter | `epub:type="section"` |
| `interlude` | Intentional pause or tonal shift | Structural wrapper |
| `bridge`, `bridgehead` | Transitional connective text | `epub:type="bridge"`, `role="complementary"`, LaTeX `bridgeheadblock`, lavender box |
| `sidebar`, `aside` | Optional digression or parallel track | `epub:type="aside"`, `role="complementary"`, LaTeX `sidebar` (add `.sidebar-block` for full-width badge box) |
| `sidebar-inline` | Compact sidebar sitting inside prose | `epub:type="sidebar-inline"`, LaTeX `sidebartight`, inline `🗒` glyph |
| `callout` | Short aside with light left border | `epub:type="callout"`, LaTeX `calloutbox` |
| `note` | Ancillary content tied to a point | `epub:type="note"`, LaTeX `noteboxplain` or one of 23 `note.<variant>` styles |
| `footnote` | Localized ancillary content | `epub:type="footnote"`, `role="doc-footnote"` |
| `endnotes`, `footnotes` | Deferred ancillary content | `epub:type="footnotes"`, `role="doc-endnotes"` |
| `epigraph` | Quotation at the head of a part/chapter/section | `epub:type="epigraph"`, `role="doc-epigraph"`, LaTeX `epigraph`, Markdown blockquote |
| `epigraph-inline` | Tighter epigraph within running text | `epub:type="epigraph-inline"`, LaTeX `epigraphtight` |
| `appendix` | Material outside the main narrative flow | `epub:type="appendix"`, `role="doc-appendix"`, switches LaTeX to `\appendix` |
| `backmatter` | Material closing the work (bibliography, index, colophon) | `epub:type="backmatter"`; suppressed in standalone article builds |

Two Axis B modifiers can also stand alone as block wrappers without a preceding delivery role:
- `::: {.example}` (`::: example`) — Blue-accented illustration box (`examplebox`, `role="doc-example"`).
- `::: {.definition}` (`::: definition`) — Green-accented term definition box (`definitionbox`).

### Axis B — Modifiers

| Group | Modifiers |
|---|---|
| **Argument and reasoning** | `thesis`, `claim`, `counterpoint`, `qualification`, `implication`, `synthesis`, `integration`, `contrast`, `reflection`, `provocation` |
| **Exposition and support** | `example`, `case-study`, `background`, `context`, `definition`, `gloss`, `analogy`, `insight`, `insight.major`, `idea`, `usage`, `methodology`, `diagnostic`, `checklist` |
| **Reader signals and stance** | `warning`, `notice`, `caution`, `misuse`, `assumption`, `limitation`, `scope`, `uncertainty`, `disclosure`, `responsibility`, `reflexive` |
| **Reader navigation** | `breadcrumb`, `navigation` (alt: `orientation`), `transition`, `prelude`, `closing` |

## Styled Note Variants (`note.<variant>`)

The `note-variants` profile set in `terminology-mcp` defines the modifiers that have dedicated box environments in XeLaTeX (`assets/latex/box-note.tex`), CSS custom properties in HTML/EPUB (`assets/styles/`), and badge/glyph headers in Ghost and clean Markdown:

| Composition | Glyph / Header | Purpose |
|---|---|---|
| `note.idea` | Inline 💡 | Generative thought or suggestion offered in passing |
| `note.insight` | Ornamental ⁂ row | Moment of realization or reframing |
| `note.insight.major` | Badge strip ⁂ | Major insight given stronger visual weight |
| `note.warning` | Badge ※ / ⚠ | Risk, harm, or moral alert |
| `note.misuse` | Red badge ✕ | Flags common misreadings or warns against weaponizing a framework |
| `note.contrast` | Inline ⇆ | Short compare/contrast clarification between frameworks |
| `note.transition` | Inline ⇥ | Handoff moment, scene shift, or narrative pivot |
| `note.breadcrumb` | Badge ↗ / › | Pointer back to where an idea was introduced or forward to where it continues |
| `note.navigation` | Teal badge ⇢ | Reader navigation and orientation guide (alias: `note.orientation`) |
| `note.bridge` | Lavender badge ⟷ / — | Stitches concepts together inside a chapter or appendix |
| `note.usage` | Steel-blue badge ⚙ | Practical guidance on how to apply a framework or idea |
| `note.integration` | Teal badge ∞ | Guidance on synthesizing or integrating across frameworks |
| `note.synthesis` | Green badge ⊕ | Integrates multiple strands into a single takeaway |
| `note.responsibility` | Amber badge ⚖ | Responsibility or accountability framing |
| `note.reflexive` | Slate badge ⟲ | Self-scrutiny: turning the analysis on the author or reader |
| `note.disclosure` | Violet badge ◊ | Transparency notes: assumptions, limits, or disclosures |
| `note.ai` | Blue badge ◇ | AI collaboration and technical pipeline disclosure |
| `note.diagnostic` | Blue badge 🔍 | Pattern-recognition checklists and diagnostic callouts |
| `note.methodology` | Indigo badge ⊢ | Explains how the analysis is conducted |
| `note.context` | Warm slate badge ◉ | Contextual framing that sets the scene or background |
| `note.scope` | Warm copper badge ◎ | Delimits boundaries, applicability, or evidentiary thresholds |
| `note.checklist` | Teal badge ☐ | Indicative checklists, verification criteria, or evidence markers |
| `note.prelude` | Ornament ◆ / ◈ | Opening note that prepares the reader for what follows |
| `note.closing` | Muted badge ∎ | Closing reflection or endcap |

Any other Axis B modifier composed with `note` (for example, `::: {.note .thesis}`) is valid IASP and renders using the plain note box (`noteboxplain`); add `.badge` if you want it to display a badge header.

## Include directives (`.include`)

Pull external Markdown fragments at build time:

```markdown
::: {.include path="demo/fragments/lexical-precision-sidebar.md"}
:::

::: {.include dir="subchapters/w-series" separator="none" glyph="✶"}
:::

::: {.include dir="patterns" list="names" list-style="ordered"}
:::

::: {.include path="scripts/example.py" mode="code" lang="python"}
:::
```

- Always use brace syntax `::: {.include ...}` when nested inside an outer wrapper (such as `::: {.article}` or `::: {.chapter}`).
- Adding `.nobadge` or `.noglyph` to the `.include` div transfers that modifier to the included sidebar or note block.

## Stage visibility (`.draft` and `.final`)

Tag any fenced div, heading, or inline span with `.draft` or `.final`:

- When `stage` is `"final"` (the default), `.draft` elements are omitted and `.final` elements are rendered.
- When `stage` is `"draft"`, `.draft` elements are rendered and `.final` elements are omitted.

## Layout, badges, and tables

- **Badges vs. glyphs**: Add `.badge` (or `data-marker="badge"`) to force a badge header, `.nobadge` (`.no-badge`) to suppress a badge, `.sidebar-glyph` to use the inline `🗒` glyph on a full-width sidebar, or `.glyph-top` on `sidebar-inline` to stack the glyph on its own line.
- **Page breaks**: Add `.layout-fullpage` for page breaks before and after a block in PDF/DOCX/RTF, or `.pre-pagebreak` / `.post-pagebreak` for one-sided breaks.
- **Tables**: Wrap tables in `::: {.table}` with optional `.table-compact`, `.table-striped`, or `.table-bordered`. Tables whose estimated row width reaches 90 characters automatically receive compact styling in XeLaTeX.
- **Sidebar heading rule**: Always use level-2 (`##`) or deeper headings inside `.sidebar` / `.aside` blocks; level-1 headings (`#`) conflict with XeLaTeX `mdframed` box headers and are flagged by `validate_markdown`.
