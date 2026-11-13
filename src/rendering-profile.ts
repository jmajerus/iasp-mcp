/**
 * Rendering and presentation metadata for IASP terms, note variants, and build modifiers.
 *
 * `terminology-mcp` owns the conceptual hierarchy, labels, notations, scope notes, and SKOS mappings.
 * This module owns how the Pandoc Lua filter (`assets/lua/iasp-semantics.lua`), XeLaTeX box headers
 * (`assets/latex/box-*.tex`), EPUB/HTML CSS (`assets/styles/`), and Ghost exporter (`src/ghost.ts`)
 * realize each class token in output formats.
 */

export interface GhostStyle {
  bg: string;
  border: string;
  badgeBg: string;
  badgeFg: string;
  glyph: string;
  label: string;
  glyphOnly?: boolean;
}

export interface NoteVariantRenderSpec {
  slug: string;
  notation: string;
  latexEnv: string;
  latexHeaderMacro: string;
  epubCssClass: string;
  headerTreatment: "inline-glyph" | "asterism-row" | "badge-strip" | "ornament";
  ghost: GhostStyle;
}

export interface DeliveryRoleRenderSpec {
  slug: string;
  notations: string[];
  shorthandSupported: boolean;
  braceExample: string;
  shorthandExample?: string;
  epubType?: string;
  ariaRole?: string;
  latexEnv?: string;
  ghostBehavior: string;
  ghostStyle?: GhostStyle;
  notes?: string;
}

export interface BuildModifierSpec {
  token: string;
  category: "marker" | "pagination" | "table" | "stage" | "directive" | "structural-alias";
  appliesTo: string;
  description: string;
}

export const SIDEBAR_GHOST_STYLE: GhostStyle = {
  bg: "#f8f9fa",
  border: "#6b7280",
  badgeBg: "#374151",
  badgeFg: "#ffffff",
  glyph: "🗒",
  label: "SIDEBAR",
};

export const CALLOUT_GHOST_STYLE: GhostStyle = {
  bg: "#f0f7ff",
  border: "#3b82f6",
  badgeBg: "#3b82f6",
  badgeFg: "#ffffff",
  glyph: "◆",
  label: "CALLOUT",
};

export const BRIDGE_GHOST_STYLE: GhostStyle = {
  bg: "#f6f2ff",
  border: "#6f58b9",
  badgeBg: "#6f58b9",
  badgeFg: "#ffffff",
  glyph: "⬡",
  label: "BRIDGE",
};

export const EXAMPLE_GHOST_STYLE: GhostStyle = {
  bg: "#eff6ff",
  border: "#3b82f6",
  badgeBg: "#3b82f6",
  badgeFg: "#ffffff",
  glyph: "◆",
  label: "EXAMPLE",
};

export const DEFINITION_GHOST_STYLE: GhostStyle = {
  bg: "#f0fdf4",
  border: "#22c55e",
  badgeBg: "#16a34a",
  badgeFg: "#ffffff",
  glyph: "≡",
  label: "DEFINITION",
};

export const NOTE_VARIANT_SPECS: Record<string, NoteVariantRenderSpec> = {
  idea: {
    slug: "idea",
    notation: "idea",
    latexEnv: "notebox",
    latexHeaderMacro: "\\notevariantideainline{}",
    epubCssClass: ".note.idea",
    headerTreatment: "inline-glyph",
    ghost: { bg: "#fffdf0", border: "#e0c84a", badgeBg: "#e5c22a", badgeFg: "#4a3800", glyph: "💡", label: "IDEA", glyphOnly: true },
  },
  insight: {
    slug: "insight",
    notation: "insight",
    latexEnv: "notebox",
    latexHeaderMacro: "\\notevariantinsight",
    epubCssClass: ".note.insight",
    headerTreatment: "asterism-row",
    ghost: { bg: "#f0f4fa", border: "#5b7fa6", badgeBg: "#5b7fa6", badgeFg: "#ffffff", glyph: "⁂", label: "INSIGHT" },
  },
  "insight-major": {
    slug: "insight-major",
    notation: "insight.major",
    latexEnv: "notebox",
    latexHeaderMacro: "\\notevariantinsightmajor",
    epubCssClass: ".note.insight.major",
    headerTreatment: "badge-strip",
    ghost: { bg: "#dce8f5", border: "#2a5fa5", badgeBg: "#2a5fa5", badgeFg: "#ffffff", glyph: "⁂", label: "INSIGHT" },
  },
  warning: {
    slug: "warning",
    notation: "warning",
    latexEnv: "noteboxwarning",
    latexHeaderMacro: "\\notevariant{warning}",
    epubCssClass: ".note.warning",
    headerTreatment: "badge-strip",
    ghost: { bg: "#fff8eb", border: "#d97706", badgeBg: "#d97706", badgeFg: "#ffffff", glyph: "⚠", label: "WARNING" },
  },
  breadcrumb: {
    slug: "breadcrumb",
    notation: "breadcrumb",
    latexEnv: "noteboxbreadcrumb",
    latexHeaderMacro: "\\notevariant{breadcrumb}",
    epubCssClass: ".note.breadcrumb",
    headerTreatment: "badge-strip",
    ghost: { bg: "#f5f5f5", border: "#9ca3af", badgeBg: "#9ca3af", badgeFg: "#ffffff", glyph: "›", label: "BREADCRUMB" },
  },
  transition: {
    slug: "transition",
    notation: "transition",
    latexEnv: "noteboxtransition",
    latexHeaderMacro: "\\notevariant{transition}",
    epubCssClass: ".note.transition",
    headerTreatment: "inline-glyph",
    ghost: { bg: "#f4f0ff", border: "#9b7fd4", badgeBg: "#9b7fd4", badgeFg: "#ffffff", glyph: "⇥", label: "TRANSITION", glyphOnly: true },
  },
  usage: {
    slug: "usage",
    notation: "usage",
    latexEnv: "noteboxusage",
    latexHeaderMacro: "\\notevariant{usage}",
    epubCssClass: ".note.usage",
    headerTreatment: "badge-strip",
    ghost: { bg: "#e8f0fe", border: "#1a73e8", badgeBg: "#1a73e8", badgeFg: "#ffffff", glyph: "⚙", label: "USAGE" },
  },
  integration: {
    slug: "integration",
    notation: "integration",
    latexEnv: "noteboxintegration",
    latexHeaderMacro: "\\notevariant{integration}",
    epubCssClass: ".note.integration",
    headerTreatment: "badge-strip",
    ghost: { bg: "#e0f7f4", border: "#00897b", badgeBg: "#00897b", badgeFg: "#ffffff", glyph: "∞", label: "INTEGRATION" },
  },
  responsibility: {
    slug: "responsibility",
    notation: "responsibility",
    latexEnv: "noteboxresponsibility",
    latexHeaderMacro: "\\notevariant{responsibility}",
    epubCssClass: ".note.responsibility",
    headerTreatment: "badge-strip",
    ghost: { bg: "#fff8e1", border: "#f9a825", badgeBg: "#f9a825", badgeFg: "#4a3200", glyph: "⚖", label: "RESPONSIBILITY" },
  },
  reflexive: {
    slug: "reflexive",
    notation: "reflexive",
    latexEnv: "noteboxreflexive",
    latexHeaderMacro: "\\notevariant{reflexive}",
    epubCssClass: ".note.reflexive",
    headerTreatment: "badge-strip",
    ghost: { bg: "#f0f4f8", border: "#546e7a", badgeBg: "#546e7a", badgeFg: "#ffffff", glyph: "⟲", label: "REFLEXIVE" },
  },
  synthesis: {
    slug: "synthesis",
    notation: "synthesis",
    latexEnv: "noteboxsynthesis",
    latexHeaderMacro: "\\notevariant{synthesis}",
    epubCssClass: ".note.synthesis",
    headerTreatment: "badge-strip",
    ghost: { bg: "#e8f5e9", border: "#388e3c", badgeBg: "#388e3c", badgeFg: "#ffffff", glyph: "⊕", label: "SYNTHESIS" },
  },
  disclosure: {
    slug: "disclosure",
    notation: "disclosure",
    latexEnv: "noteboxdisclosure",
    latexHeaderMacro: "\\notevariant{disclosure}",
    epubCssClass: ".note.disclosure",
    headerTreatment: "badge-strip",
    ghost: { bg: "#f3e5f5", border: "#7b1fa2", badgeBg: "#7b1fa2", badgeFg: "#ffffff", glyph: "◊", label: "DISCLOSURE" },
  },
  ai: {
    slug: "ai",
    notation: "ai",
    latexEnv: "noteboxdisclosure",
    latexHeaderMacro: "\\notevariant{ai}",
    epubCssClass: ".note.ai",
    headerTreatment: "badge-strip",
    ghost: { bg: "#eef6ff", border: "#2563eb", badgeBg: "#1d4ed8", badgeFg: "#ffffff", glyph: "◇", label: "AI DISCLOSURE" },
  },
  navigation: {
    slug: "navigation",
    notation: "navigation",
    latexEnv: "noteboxnavigation",
    latexHeaderMacro: "\\notevariant{navigation}",
    epubCssClass: ".note.navigation",
    headerTreatment: "badge-strip",
    ghost: { bg: "#e0f2f1", border: "#00796b", badgeBg: "#00796b", badgeFg: "#ffffff", glyph: "⇢", label: "NAVIGATION" },
  },
  orientation: {
    slug: "navigation",
    notation: "orientation",
    latexEnv: "noteboxnavigation",
    latexHeaderMacro: "\\notevariant{orientation}",
    epubCssClass: ".note.orientation",
    headerTreatment: "badge-strip",
    ghost: { bg: "#e0f2f1", border: "#00796b", badgeBg: "#00796b", badgeFg: "#ffffff", glyph: "⇢", label: "ORIENTATION" },
  },
  bridge: {
    slug: "bridge",
    notation: "bridge",
    latexEnv: "noteboxbridge",
    latexHeaderMacro: "\\notevariant{bridge}",
    epubCssClass: ".note.bridge",
    headerTreatment: "badge-strip",
    ghost: { bg: "#ede7f6", border: "#673ab7", badgeBg: "#673ab7", badgeFg: "#ffffff", glyph: "—", label: "BRIDGE" },
  },
  contrast: {
    slug: "contrast",
    notation: "contrast",
    latexEnv: "noteboxcontrast",
    latexHeaderMacro: "\\notevariant{contrast}",
    epubCssClass: ".note.contrast",
    headerTreatment: "inline-glyph",
    ghost: { bg: "#fff3e0", border: "#f57c00", badgeBg: "#f57c00", badgeFg: "#ffffff", glyph: "⇆", label: "CONTRAST", glyphOnly: true },
  },
  misuse: {
    slug: "misuse",
    notation: "misuse",
    latexEnv: "noteboxmisuse",
    latexHeaderMacro: "\\notevariant{misuse}",
    epubCssClass: ".note.misuse",
    headerTreatment: "badge-strip",
    ghost: { bg: "#ffebee", border: "#c62828", badgeBg: "#c62828", badgeFg: "#ffffff", glyph: "✕", label: "MISUSE" },
  },
  diagnostic: {
    slug: "diagnostic",
    notation: "diagnostic",
    latexEnv: "noteboxdiagnostic",
    latexHeaderMacro: "\\notevariant{diagnostic}",
    epubCssClass: ".note.diagnostic",
    headerTreatment: "badge-strip",
    ghost: { bg: "#e3f2fd", border: "#1565c0", badgeBg: "#1565c0", badgeFg: "#ffffff", glyph: "🔍", label: "DIAGNOSTIC" },
  },
  closing: {
    slug: "closing",
    notation: "closing",
    latexEnv: "noteboxclosing",
    latexHeaderMacro: "\\notevariant{closing}",
    epubCssClass: ".note.closing",
    headerTreatment: "badge-strip",
    ghost: { bg: "#f5f5f5", border: "#9e9e9e", badgeBg: "#757575", badgeFg: "#ffffff", glyph: "∎", label: "CLOSING NOTE" },
  },
  methodology: {
    slug: "methodology",
    notation: "methodology",
    latexEnv: "noteboxmethodology",
    latexHeaderMacro: "\\notevariant{methodology}",
    epubCssClass: ".note.methodology",
    headerTreatment: "badge-strip",
    ghost: { bg: "#e8eaf6", border: "#3949ab", badgeBg: "#3949ab", badgeFg: "#ffffff", glyph: "⊢", label: "METHODOLOGY" },
  },
  context: {
    slug: "context",
    notation: "context",
    latexEnv: "noteboxcontext",
    latexHeaderMacro: "\\notevariant{context}",
    epubCssClass: ".note.context",
    headerTreatment: "badge-strip",
    ghost: { bg: "#f5f0eb", border: "#78716c", badgeBg: "#78716c", badgeFg: "#ffffff", glyph: "◉", label: "CONTEXT" },
  },
  scope: {
    slug: "scope",
    notation: "scope",
    latexEnv: "noteboxscope",
    latexHeaderMacro: "\\notevariant{scope}",
    epubCssClass: ".note.scope",
    headerTreatment: "badge-strip",
    ghost: { bg: "#fdf0e7", border: "#b45309", badgeBg: "#b45309", badgeFg: "#ffffff", glyph: "◎", label: "SCOPE" },
  },
  checklist: {
    slug: "checklist",
    notation: "checklist",
    latexEnv: "noteboxchecklist",
    latexHeaderMacro: "\\notevariant{checklist}",
    epubCssClass: ".note.checklist",
    headerTreatment: "badge-strip",
    ghost: { bg: "#e0f7f4", border: "#00838f", badgeBg: "#00838f", badgeFg: "#ffffff", glyph: "☐", label: "CHECKLIST" },
  },
  prelude: {
    slug: "prelude",
    notation: "prelude",
    latexEnv: "noteboxprelude",
    latexHeaderMacro: "\\notevariant{prelude}",
    epubCssClass: ".note.prelude",
    headerTreatment: "ornament",
    ghost: { bg: "#f9f9f9", border: "#aaaaaa", badgeBg: "#aaaaaa", badgeFg: "#ffffff", glyph: "◈", label: "PRELUDE" },
  },
};

/** Count of styled `note-variants` (excludes the `orientation` alias and the `ai` disclosure style). */
export const NOTE_VARIANT_COUNT = Object.keys(NOTE_VARIANT_SPECS).filter((k) => k !== "orientation" && k !== "ai").length;

export const DELIVERY_ROLE_SPECS: Record<string, DeliveryRoleRenderSpec> = {
  "front-matter": {
    slug: "front-matter",
    notations: ["front-matter", "frontmatter"],
    shorthandSupported: false,
    braceExample: "::: {.frontmatter}\n...\n:::",
    epubType: "frontmatter",
    ghostBehavior: "Suppressed in standalone article builds; passed through otherwise.",
  },
  series: {
    slug: "series",
    notations: ["series"],
    shorthandSupported: false,
    braceExample: "::: {.series}\n# Series A — Foundations\n:::",
    ghostBehavior: "Wrapper stripped; inner Markdown passed through.",
  },
  part: {
    slug: "part",
    notations: ["part"],
    shorthandSupported: false,
    braceExample: "::: {.part}\n# Part I\n:::",
    epubType: "part",
    ariaRole: "doc-part",
    latexEnv: "parttitlepage",
    ghostBehavior: "Wrapper stripped; inner Markdown passed through.",
  },
  chapter: {
    slug: "chapter",
    notations: ["chapter"],
    shorthandSupported: false,
    braceExample: "::: {.chapter}\n# Chapter Title\n:::",
    epubType: "chapter",
    ariaRole: "doc-chapter",
    ghostBehavior: "Wrapper stripped; inner Markdown passed through.",
  },
  section: {
    slug: "section",
    notations: ["section"],
    shorthandSupported: false,
    braceExample: "::: {.section}\n## Section Title\n:::",
    epubType: "section",
    ghostBehavior: "Wrapper stripped; inner Markdown passed through.",
  },
  interlude: {
    slug: "interlude",
    notations: ["interlude"],
    shorthandSupported: false,
    braceExample: "::: {.interlude}\n...\n:::",
    ghostBehavior: "Wrapper stripped; inner Markdown passed through.",
  },
  bridge: {
    slug: "bridge",
    notations: ["bridge", "bridgehead"],
    shorthandSupported: true,
    braceExample: "::: {.bridge}\n...\n:::",
    shorthandExample: "::: bridge\n...\n:::",
    epubType: "bridge",
    ariaRole: "complementary",
    latexEnv: "bridgeheadblock",
    ghostBehavior: "Rendered as a lavender-accented HTML <div> with BRIDGE badge.",
    ghostStyle: BRIDGE_GHOST_STYLE,
  },
  sidebar: {
    slug: "sidebar",
    notations: ["sidebar", "aside"],
    shorthandSupported: true,
    braceExample: "::: {.sidebar .sidebar-block}\n## Sidebar Title\n...\n:::",
    shorthandExample: "::: sidebar.sidebar-block\n## Sidebar Title\n...\n:::",
    epubType: "aside",
    ariaRole: "complementary",
    latexEnv: "sidebar",
    ghostBehavior: "Rendered as a steel-grey HTML <div> with SIDEBAR badge (suppressed by .nobadge).",
    ghostStyle: SIDEBAR_GHOST_STYLE,
    notes: "Use level 2+ headings (##) inside sidebars; level 1 (#) breaks PDF mdframed badge placement.",
  },
  "sidebar-inline": {
    slug: "sidebar-inline",
    notations: ["sidebar-inline"],
    shorthandSupported: true,
    braceExample: "::: {.sidebar-inline}\n...\n:::",
    shorthandExample: "::: sidebar-inline\n...\n:::",
    epubType: "sidebar-inline",
    ariaRole: "complementary",
    latexEnv: "sidebartight",
    ghostBehavior: "Rendered as a steel-grey sidebar HTML <div>.",
    ghostStyle: SIDEBAR_GHOST_STYLE,
  },
  callout: {
    slug: "callout",
    notations: ["callout"],
    shorthandSupported: true,
    braceExample: "::: {.callout}\n...\n:::",
    shorthandExample: "::: callout\n...\n:::",
    epubType: "callout",
    latexEnv: "calloutbox",
    ghostBehavior: "Rendered as a blue-accented HTML <div> with CALLOUT badge.",
    ghostStyle: CALLOUT_GHOST_STYLE,
  },
  note: {
    slug: "note",
    notations: ["note"],
    shorthandSupported: true,
    braceExample: "::: {.note .insight}\n...\n:::",
    shorthandExample: "::: note.insight\n...\n:::",
    epubType: "note",
    latexEnv: `noteboxplain (or notebox<variant> for the ${NOTE_VARIANT_COUNT} note-variants)`,
    ghostBehavior: "Rendered as a color-coded HTML <div> matching the composed note.<variant>.",
  },
  footnote: {
    slug: "footnote",
    notations: ["footnote"],
    shorthandSupported: false,
    braceExample: "::: {.footnote .counterpoint}\n...\n:::",
    epubType: "footnote",
    ariaRole: "doc-footnote",
    ghostBehavior: "Standard Markdown [^fn] footnotes pass through natively.",
  },
  endnotes: {
    slug: "endnotes",
    notations: ["endnotes", "footnotes"],
    shorthandSupported: false,
    braceExample: "::: {.endnotes}\n...\n:::",
    epubType: "footnotes",
    ariaRole: "doc-endnotes",
    ghostBehavior: "Wrapper stripped; inner Markdown passed through.",
  },
  epigraph: {
    slug: "epigraph",
    notations: ["epigraph"],
    shorthandSupported: true,
    braceExample: "::: {.epigraph}\n*Quote text*\n\n— Attribution\n:::",
    shorthandExample: "::: epigraph\n*Quote text*\n:::",
    epubType: "epigraph",
    ariaRole: "doc-epigraph",
    latexEnv: "epigraph",
    ghostBehavior: "Converted to a standard Markdown blockquote (> ...).",
  },
  "epigraph-inline": {
    slug: "epigraph-inline",
    notations: ["epigraph-inline"],
    shorthandSupported: true,
    braceExample: "::: {.epigraph-inline}\n*Quote text*\n:::",
    shorthandExample: "::: epigraph-inline\n*Quote text*\n:::",
    epubType: "epigraph-inline",
    latexEnv: "epigraphtight",
    ghostBehavior: "Converted to a standard Markdown blockquote (> ...).",
  },
  appendix: {
    slug: "appendix",
    notations: ["appendix"],
    shorthandSupported: false,
    braceExample: "::: {.appendix}\n# Appendix A\n:::",
    epubType: "appendix",
    ariaRole: "doc-appendix",
    latexEnv: "\\appendix + \\iaspSetPartHeader{Appendices}",
    ghostBehavior: "Wrapper stripped; inner Markdown passed through.",
  },
  "back-matter": {
    slug: "back-matter",
    notations: ["backmatter", "back-matter"],
    shorthandSupported: false,
    braceExample: "::: {.backmatter}\n...\n:::",
    epubType: "backmatter",
    ghostBehavior: "Suppressed in standalone article builds; passed through otherwise.",
  },
};

export const STANDALONE_MODIFIER_BLOCKS: Record<string, DeliveryRoleRenderSpec> = {
  example: {
    slug: "example",
    notations: ["example"],
    shorthandSupported: true,
    braceExample: "::: {.example}\n...\n:::",
    shorthandExample: "::: example\n...\n:::",
    epubType: "example",
    ariaRole: "doc-example",
    latexEnv: "examplebox",
    ghostBehavior: "Rendered as a blue-framed HTML <div> with EXAMPLE badge.",
    ghostStyle: EXAMPLE_GHOST_STYLE,
  },
  definition: {
    slug: "definition",
    notations: ["definition"],
    shorthandSupported: true,
    braceExample: "::: {.definition}\n...\n:::",
    shorthandExample: "::: definition\n...\n:::",
    epubType: "definition",
    latexEnv: "definitionbox",
    ghostBehavior: "Rendered as a green-framed HTML <div> with DEFINITION badge.",
    ghostStyle: DEFINITION_GHOST_STYLE,
  },
};

export const BUILD_MODIFIER_SPECS: Record<string, BuildModifierSpec> = {
  include: {
    token: "include",
    category: "directive",
    appliesTo: "div",
    description: "Pulls in an external Markdown file or directory (attributes: path, dir, mode, separator, glyph, banner, list).",
  },
  "sidebar-block": {
    token: "sidebar-block",
    category: "marker",
    appliesTo: "sidebar / aside",
    description: "Full-width sidebar layout with a SIDEBAR badge header by default.",
  },
  "sidebar-badge": {
    token: "sidebar-badge",
    category: "marker",
    appliesTo: "sidebar / sidebar-inline",
    description: "Forces the SIDEBAR badge header row even on inline sidebars.",
  },
  "sidebar-glyph": {
    token: "sidebar-glyph",
    category: "marker",
    appliesTo: "sidebar / sidebar-block",
    description: "Uses the inline notepad glyph (🗒) instead of the SIDEBAR badge row.",
  },
  "glyph-top": {
    token: "glyph-top",
    category: "marker",
    appliesTo: "sidebar-inline",
    description: "Places the inline sidebar glyph on its own line above the first paragraph or list.",
  },
  badge: {
    token: "badge",
    category: "marker",
    appliesTo: "note / callout / example / definition / bridge",
    description: "Forces a badge label row at the top of the framed block.",
  },
  nobadge: {
    token: "nobadge",
    category: "marker",
    appliesTo: "any framed block or include",
    description: "Suppresses the badge header row (aliases: no-badge, badge-off, nobadges).",
  },
  "no-badge": {
    token: "no-badge",
    category: "marker",
    appliesTo: "any framed block or include",
    description: "Alias for .nobadge.",
  },
  "badge-off": {
    token: "badge-off",
    category: "marker",
    appliesTo: "any framed block",
    description: "Alias for .nobadge.",
  },
  noglyph: {
    token: "noglyph",
    category: "marker",
    appliesTo: "sidebar / note",
    description: "Suppresses the glyph marker (aliases: no-glyph, glyph-off).",
  },
  "no-glyph": {
    token: "no-glyph",
    category: "marker",
    appliesTo: "sidebar / note",
    description: "Alias for .noglyph.",
  },
  major: {
    token: "major",
    category: "marker",
    appliesTo: "note.insight",
    description: "Composes with note.insight (note.insight.major) to promote the asterism row to a full badge strip.",
  },
  "layout-fullpage": {
    token: "layout-fullpage",
    category: "pagination",
    appliesTo: "any top-level div (table, bridge, callout)",
    description: "Inserts a page break before and after the block in PDF/DOCX/RTF builds.",
  },
  "pre-pagebreak": {
    token: "pre-pagebreak",
    category: "pagination",
    appliesTo: "any div (especially bridge)",
    description: "Inserts a page break before the block in PDF/DOCX/RTF builds.",
  },
  "post-pagebreak": {
    token: "post-pagebreak",
    category: "pagination",
    appliesTo: "any div (especially bridge)",
    description: "Inserts a page break after the block in PDF/DOCX/RTF builds.",
  },
  "page-break": {
    token: "page-break",
    category: "pagination",
    appliesTo: "empty div",
    description: "Emits a standalone page break in PDF/DOCX/RTF.",
  },
  pagebreak: {
    token: "pagebreak",
    category: "pagination",
    appliesTo: "empty div",
    description: "Alias for .page-break.",
  },
  table: {
    token: "table",
    category: "table",
    appliesTo: "div wrapping a Markdown table",
    description: "Enables IASP table width estimation, auto-compact, and auto-fullpage promotion.",
  },
  "table-compact": {
    token: "table-compact",
    category: "table",
    appliesTo: "div.table",
    description: "Uses smaller font size and tighter cell padding for wide tables.",
  },
  "table-striped": {
    token: "table-striped",
    category: "table",
    appliesTo: "div.table",
    description: "Alternating row background tint.",
  },
  "table-bordered": {
    token: "table-bordered",
    category: "table",
    appliesTo: "div.table",
    description: "Draws cell borders around the table.",
  },
  draft: {
    token: "draft",
    category: "stage",
    appliesTo: "any div, header, or span",
    description: "Renders only when build-stage is 'draft'; hidden in 'final' builds.",
  },
  final: {
    token: "final",
    category: "stage",
    appliesTo: "any div, header, or span",
    description: "Renders only in 'final' builds; hidden when build-stage is 'draft'.",
  },
  article: {
    token: "article",
    category: "structural-alias",
    appliesTo: "top-level wrapper for standalone articles",
    description: "Marks a standalone essay/article file (inserted by wrap_by_directory for articles/).",
  },
  subchapter: {
    token: "subchapter",
    category: "structural-alias",
    appliesTo: "div or header",
    description: "Subchapter division (maps to epub:type subchapter).",
  },
  subsection: {
    token: "subsection",
    category: "structural-alias",
    appliesTo: "div or header",
    description: "Subsection division (maps to epub:type subsection).",
  },
  toc: {
    token: "toc",
    category: "structural-alias",
    appliesTo: "div",
    description: "Table of contents wrapper (maps to epub:type toc, ARIA doc-toc, LaTeX tocblock).",
  },
  dedication: {
    token: "dedication",
    category: "structural-alias",
    appliesTo: "div",
    description: "Dedication wrapper (maps to epub:type dedication, ARIA doc-dedication).",
  },
  preface: {
    token: "preface",
    category: "structural-alias",
    appliesTo: "div",
    description: "Preface wrapper (maps to epub:type preface, ARIA doc-preface).",
  },
  introduction: {
    token: "introduction",
    category: "structural-alias",
    appliesTo: "div",
    description: "Introduction wrapper (maps to epub:type introduction, ARIA doc-introduction).",
  },
  conclusion: {
    token: "conclusion",
    category: "structural-alias",
    appliesTo: "div",
    description: "Conclusion wrapper (maps to epub:type conclusion, ARIA doc-conclusion).",
  },
  epilogue: {
    token: "epilogue",
    category: "structural-alias",
    appliesTo: "div",
    description: "Epilogue wrapper (maps to epub:type epilogue, ARIA doc-epilogue).",
  },
  prologue: {
    token: "prologue",
    category: "structural-alias",
    appliesTo: "div",
    description: "Prologue wrapper (maps to epub:type prologue).",
  },
  foreword: {
    token: "foreword",
    category: "structural-alias",
    appliesTo: "div",
    description: "Foreword wrapper (maps to epub:type foreword).",
  },
  afterword: {
    token: "afterword",
    category: "structural-alias",
    appliesTo: "div",
    description: "Afterword wrapper (maps to epub:type afterword).",
  },
  acknowledgments: {
    token: "acknowledgments",
    category: "structural-alias",
    appliesTo: "div",
    description: "Acknowledgments wrapper (maps to epub:type acknowledgments, ARIA doc-acknowledgments).",
  },
  acknowledgment: {
    token: "acknowledgment",
    category: "structural-alias",
    appliesTo: "div",
    description: "Alias for .acknowledgments.",
  },
  summary: {
    token: "summary",
    category: "structural-alias",
    appliesTo: "div",
    description: "Summary wrapper (maps to epub:type summary, ARIA doc-abstract).",
  },
  abstract: {
    token: "abstract",
    category: "structural-alias",
    appliesTo: "div",
    description: "Abstract wrapper (maps to epub:type abstract, ARIA doc-abstract).",
  },
  colophon: {
    token: "colophon",
    category: "structural-alias",
    appliesTo: "div",
    description: "Colophon wrapper (maps to epub:type colophon).",
  },
  glossary: {
    token: "glossary",
    category: "structural-alias",
    appliesTo: "div",
    description: "Glossary wrapper (maps to epub:type glossary, ARIA doc-glossary).",
  },
  index: {
    token: "index",
    category: "structural-alias",
    appliesTo: "div",
    description: "Index wrapper (maps to epub:type index).",
  },
  bibliography: {
    token: "bibliography",
    category: "structural-alias",
    appliesTo: "div",
    description: "Bibliography wrapper (maps to epub:type bibliography).",
  },
  references: {
    token: "references",
    category: "structural-alias",
    appliesTo: "div",
    description: "References wrapper (maps to epub:type references).",
  },
  figure: {
    token: "figure",
    category: "structural-alias",
    appliesTo: "div",
    description: "Figure wrapper (maps to epub:type figure).",
  },
  erratum: {
    token: "erratum",
    category: "structural-alias",
    appliesTo: "div",
    description: "Erratum wrapper (maps to epub:type erratum).",
  },
  contribution: {
    token: "contribution",
    category: "structural-alias",
    appliesTo: "div",
    description: "Contribution wrapper (maps to epub:type contribution).",
  },
};

export const DIR_WRAPPER_MAP: Record<string, string> = {
  parts: "::: {.part}",
  sidebars: "::: {.aside .sidebar-block}",
  bridges: "::: {.bridge}",
  bridgeheads: "::: {.bridge}",
  appendices: "::: {.appendix}",
  articles: "::: {.article}",
  chapters: "::: {.chapter}",
  subchapters: "::: {.subchapter}",
  sections: "::: {.section}",
  subsections: "::: {.subsection}",
  figures: "::: {.figure}",
  tables: "::: {.table}",
  notes: "::: {.note}",
  footnotes: "::: {.footnotes}",
  glossaries: "::: {.glossary}",
  indexes: "::: {.index}",
  bibliographies: "::: {.bibliography}",
  references: "::: {.references}",
  epilogues: "::: {.epilogue}",
  prologues: "::: {.prologue}",
  introductions: "::: {.introduction}",
  conclusions: "::: {.conclusion}",
  forewords: "::: {.foreword}",
  afterwords: "::: {.afterword}",
  prefaces: "::: {.preface}",
  dedications: "::: {.dedication}",
  acknowledgments: "::: {.acknowledgment}",
  summaries: "::: {.summary}",
  abstracts: "::: {.abstract}",
  contributions: "::: {.contribution}",
  colophons: "::: {.colophon}",
  epigraphs: "::: {.epigraph}",
  errata: "::: {.erratum}",
};
