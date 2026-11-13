import type { DB } from "./db.js";
import { detectToolchain } from "./render.js";
import {
  BUILD_MODIFIER_SPECS,
  DELIVERY_ROLE_SPECS,
  NOTE_VARIANT_SPECS,
  STANDALONE_MODIFIER_BLOCKS,
} from "./rendering-profile.js";
import { readCursor } from "./terminology.js";

export class ToolError extends Error {
  constructor(message: string) {
    super(message);
  }
}

export interface TermRow {
  id: string;
  scheme: string;
  slug: string;
  former_slugs: string;
  label: string;
  alt_labels: string;
  notations: string;
  scope_note: string | null;
  status: string;
  replaced_by: string;
  broader: string;
  path: string;
  depth: number;
  axis: string | null;
  group_slug: string | null;
  source_uri: string | null;
  links: string;
  aliases: string;
  updated_at: string;
}

export interface SetRow {
  id: string;
  scheme: string;
  slug: string;
  label: string;
  description: string | null;
  kind: string;
  ordered: number;
  members: string;
  recipe: string | null;
  former_slugs: string;
  updated_at: string;
}

export function parseNotations(raw: string): string[] {
  try {
    const arr = JSON.parse(raw) as { value?: string }[];
    return arr.map((n) => n.value ?? "").filter(Boolean);
  } catch {
    return [];
  }
}

function getSetMemberships(db: DB): Map<string, string[]> {
  const map = new Map<string, string[]>();
  const rows = db.prepare("SELECT slug, members FROM concept_sets").all() as { slug: string; members: string }[];
  for (const row of rows) {
    const ids = JSON.parse(row.members) as string[];
    for (const id of ids) {
      const list = map.get(id) ?? [];
      list.push(row.slug);
      map.set(id, list);
    }
  }
  return map;
}

export function formatTermSummary(row: TermRow, setMap: Map<string, string[]>) {
  const notations = parseNotations(row.notations);
  const sets = setMap.get(row.id) ?? [];
  const noteVariant = NOTE_VARIANT_SPECS[row.slug];
  const deliveryRole = DELIVERY_ROLE_SPECS[row.slug] ?? STANDALONE_MODIFIER_BLOCKS[row.slug];

  return {
    id: row.id,
    slug: row.slug,
    label: row.label,
    alt_labels: JSON.parse(row.alt_labels) as string[],
    notations,
    axis: row.axis,
    group: row.group_slug,
    depth: row.depth,
    path: row.path,
    status: row.status,
    scope_note: row.scope_note,
    sets,
    rendering: deliveryRole
      ? {
          kind: row.axis === "delivery-role" ? "delivery-role" : "standalone-block-and-modifier",
          brace: deliveryRole.braceExample,
          ...(deliveryRole.shorthandExample ? { shorthand: deliveryRole.shorthandExample } : {}),
          ...(deliveryRole.epubType ? { epub_type: deliveryRole.epubType } : {}),
          ...(deliveryRole.ariaRole ? { aria_role: deliveryRole.ariaRole } : {}),
          ...(deliveryRole.latexEnv ? { latex_env: deliveryRole.latexEnv } : {}),
        }
      : noteVariant
        ? {
            kind: "note-variant",
            shorthand: `::: note.${noteVariant.notation}\n...\n:::`,
            brace: `::: {.note .${noteVariant.notation.replace(/\./g, " .")}}\n...\n:::`,
            latex_env: noteVariant.latexEnv,
            header_treatment: noteVariant.headerTreatment,
            glyph: noteVariant.ghost.glyph,
            badge_label: noteVariant.ghost.label,
          }
        : notations.length
          ? {
              kind: "modifier",
              composes_as: `delivery.${notations[0]}`,
              example: `::: {.sidebar .${notations[0]}}\n...\n:::`,
            }
          : { kind: "grouping-concept" },
  };
}

export interface ListTermsOptions {
  axis?: "delivery-role" | "modifier" | "any";
  group?: string;
  set?: string;
  query?: string;
  status?: "active" | "provisional" | "retired" | "any";
  includeGrouping?: boolean;
}

export function listTerms(db: DB, options: ListTermsOptions = {}) {
  const rows = db.prepare("SELECT * FROM terms ORDER BY path, slug").all() as TermRow[];
  const setMap = getSetMemberships(db);

  let allowedIds: Set<string> | null = null;
  let orderedIds: string[] | null = null;
  if (options.set) {
    const setRow = db.prepare("SELECT * FROM concept_sets WHERE slug = ? OR id = ?").get(options.set, options.set) as SetRow | undefined;
    if (!setRow) {
      throw new ToolError(`Unknown concept set "${options.set}". Available sets: core, delivery-order, note-variants.`);
    }
    const members = JSON.parse(setRow.members) as string[];
    allowedIds = new Set(members);
    if (setRow.ordered) orderedIds = members;
  }

  const q = options.query?.trim().toLowerCase() ?? "";
  const wantStatus = options.status ?? "active";
  const includeGrouping = options.includeGrouping ?? true;

  let filtered = rows.filter((r) => {
    if (allowedIds && !allowedIds.has(r.id)) return false;
    if (wantStatus !== "any" && r.status !== wantStatus) return false;
    if (options.axis && options.axis !== "any" && r.axis !== options.axis) return false;
    if (options.group && r.group_slug !== options.group && r.slug !== options.group) return false;
    if (!includeGrouping && parseNotations(r.notations).length === 0) return false;
    if (q) {
      const hay = [
        r.slug,
        r.label,
        r.scope_note ?? "",
        r.path,
        ...parseNotations(r.notations),
        ...(JSON.parse(r.alt_labels) as string[]),
      ]
        .join(" ")
        .toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  if (orderedIds) {
    const orderIndex = new Map(orderedIds.map((id, idx) => [id, idx]));
    filtered = [...filtered].sort((a, b) => (orderIndex.get(a.id) ?? 999) - (orderIndex.get(b.id) ?? 999));
  }

  const items = filtered.map((r) => formatTermSummary(r, setMap));
  const setSummaries = (db
    .prepare("SELECT slug, label, description, ordered, json_array_length(members) AS member_count FROM concept_sets ORDER BY slug")
    .all() as { slug: string; label: string; description: string | null; ordered: number; member_count: number }[]).map((s) => ({
    slug: s.slug,
    label: s.label,
    description: s.description,
    ordered: Boolean(s.ordered),
    member_count: s.member_count,
  }));
  return {
    total: items.length,
    sets: setSummaries,
    terms: items,
  };
}

export function findTermRow(db: DB, ref: string): TermRow | undefined {
  const clean = ref.trim().replace(/^\./, "").toLowerCase();
  if (!clean) return undefined;

  const direct = db
    .prepare("SELECT * FROM terms WHERE id = ? OR lower(slug) = ? OR lower(label) = ?")
    .get(ref.trim(), clean, clean) as TermRow | undefined;
  if (direct) return direct;

  const all = db.prepare("SELECT * FROM terms").all() as TermRow[];
  for (const row of all) {
    const notations = parseNotations(row.notations).map((n) => n.toLowerCase());
    if (notations.includes(clean)) return row;
    const alt = (JSON.parse(row.alt_labels) as string[]).map((a) => a.toLowerCase());
    if (alt.includes(clean)) return row;
    const former = (JSON.parse(row.former_slugs) as string[]).map((f) => f.toLowerCase());
    if (former.includes(clean)) return row;
    const aliases = (JSON.parse(row.aliases) as string[]).map((a) => a.toLowerCase());
    if (aliases.includes(clean) || aliases.includes(ref.trim().toLowerCase())) return row;
  }
  return undefined;
}

export function getTerm(db: DB, termRef: string) {
  const row = findTermRow(db, termRef);
  if (!row) {
    const mod = BUILD_MODIFIER_SPECS[termRef.trim().replace(/^\./, "").toLowerCase()];
    if (mod) {
      return {
        kind: "build-modifier",
        token: mod.token,
        category: mod.category,
        applies_to: mod.appliesTo,
        description: mod.description,
      };
    }
    throw new ToolError(`No IASP term or build modifier matches "${termRef}". Try list_terms to browse the vocabulary.`);
  }

  const setMap = getSetMemberships(db);
  const summary = formatTermSummary(row, setMap);
  const relRows = db
    .prepare(
      `SELECT r.type, t.id, t.slug, t.label, t.axis
       FROM term_relations r
       JOIN terms t ON t.id = r.to_id
       WHERE r.from_id = ?
       ORDER BY r.type, t.slug`,
    )
    .all(row.id) as { type: string; id: string; slug: string; label: string; axis: string | null }[];

  const connections: Record<"broader" | "narrower" | "related" | "opposite", { id: string; slug: string; label: string }[]> = {
    broader: [],
    narrower: [],
    related: [],
    opposite: [],
  };
  for (const rel of relRows) {
    const bucket = connections[rel.type as keyof typeof connections];
    if (bucket) bucket.push({ id: rel.id, slug: rel.slug, label: rel.label });
  }

  const noteVariant = NOTE_VARIANT_SPECS[row.slug];
  const deliverySpec = DELIVERY_ROLE_SPECS[row.slug] ?? STANDALONE_MODIFIER_BLOCKS[row.slug];

  return {
    ...summary,
    former_slugs: JSON.parse(row.former_slugs) as string[],
    replaced_by: JSON.parse(row.replaced_by) as string[],
    source_uri: row.source_uri,
    external_links: JSON.parse(row.links) as { uri: string; match: string }[],
    aliases: JSON.parse(row.aliases) as string[],
    connections,
    rendering_detail: {
      ...(deliverySpec ? { delivery_role: deliverySpec } : {}),
      ...(noteVariant ? { note_variant: noteVariant } : {}),
    },
  };
}

export function listSets(db: DB) {
  const rows = db.prepare("SELECT * FROM concept_sets ORDER BY slug").all() as SetRow[];
  const termsById = new Map<string, TermRow>();
  for (const t of db.prepare("SELECT * FROM terms").all() as TermRow[]) {
    termsById.set(t.id, t);
  }
  return {
    sets: rows.map((s) => {
      const memberIds = JSON.parse(s.members) as string[];
      const members = memberIds
        .map((id) => termsById.get(id))
        .filter((t): t is TermRow => Boolean(t))
        .map((t) => ({
          id: t.id,
          slug: t.slug,
          label: t.label,
          notations: parseNotations(t.notations),
          axis: t.axis,
          group: t.group_slug,
        }));
      return {
        id: s.id,
        scheme: s.scheme,
        slug: s.slug,
        label: s.label,
        description: s.description,
        kind: s.kind,
        ordered: Boolean(s.ordered),
        member_count: members.length,
        members,
      };
    }),
  };
}

export interface ComposeIntentArgs {
  composition?: string;
  delivery?: string;
  modifiers?: string[];
}

export function composeIntent(db: DB, args: ComposeIntentArgs) {
  const rawTokens: string[] = [];
  if (args.composition) {
    const cleaned = args.composition
      .trim()
      .replace(/^:::\s*/, "")
      .replace(/^\{|\}$/g, "")
      .trim();
    for (const part of cleaned.split(/\s+/)) {
      if (!part || part.includes("=") || part.startsWith("#")) continue;
      for (const piece of part.replace(/^\./, "").split(".")) {
        if (piece) rawTokens.push(piece.toLowerCase());
      }
    }
  }
  if (args.delivery) {
    for (const piece of args.delivery.replace(/^\./, "").split(".")) {
      if (piece) rawTokens.push(piece.toLowerCase());
    }
  }
  for (const m of args.modifiers ?? []) {
    for (const piece of m.replace(/^\./, "").split(".")) {
      if (piece) rawTokens.push(piece.toLowerCase());
    }
  }

  const tokens = [...new Set(rawTokens)];
  if (!tokens.length) {
    throw new ToolError("Provide `composition` (e.g. 'note.insight' or 'sidebar.example') or `delivery` and `modifiers`.");
  }

  const deliveryRoles: TermRow[] = [];
  const modifierTerms: TermRow[] = [];
  const buildModifiers: (typeof BUILD_MODIFIER_SPECS)[string][] = [];
  const unknownTokens: string[] = [];
  const warnings: string[] = [];

  // Check if insight + major are both present
  const hasInsight = tokens.includes("insight");
  const hasMajor = tokens.includes("major");

  for (const tok of tokens) {
    if (tok === "major" && hasInsight) {
      const majorRow = findTermRow(db, "insight.major");
      if (majorRow && !modifierTerms.some((m) => m.id === majorRow.id)) {
        modifierTerms.push(majorRow);
      }
      buildModifiers.push(BUILD_MODIFIER_SPECS.major);
      continue;
    }

    const buildMod = BUILD_MODIFIER_SPECS[tok];
    if (buildMod && buildMod.category !== "structural-alias") {
      buildModifiers.push(buildMod);
      continue;
    }

    const row = findTermRow(db, tok);
    if (row) {
      if (row.status === "retired") {
        const replacements = JSON.parse(row.replaced_by) as string[];
        warnings.push(
          `Term "${row.slug}" is retired in terminology-mcp${replacements.length ? `; replaced by ${replacements.join(", ")}` : ""}.`,
        );
      }
      if (tok === "orientation" && row.slug === "navigation") {
        warnings.push(
          `"orientation" is an alternative label for "navigation" in the iasp scheme; prefer \`note.navigation\` for canonical notation.`,
        );
      }
      if (row.axis === "delivery-role") {
        deliveryRoles.push(row);
      } else {
        modifierTerms.push(row);
      }
      continue;
    }

    if (buildMod) {
      buildModifiers.push(buildMod);
      continue;
    }

    unknownTokens.push(tok);
  }

  if (deliveryRoles.length > 1) {
    warnings.push(
      `Multiple delivery roles (${deliveryRoles.map((d) => d.slug).join(", ")}) were combined. IASP recommends one delivery role per block, with Axis B modifiers qualifying it.`,
    );
  }

  const primaryDelivery = deliveryRoles[0];
  const standaloneBlock = !primaryDelivery
    ? modifierTerms.find((m) => STANDALONE_MODIFIER_BLOCKS[m.slug])
    : undefined;

  // Determine how it renders
  let resolvedNoteVariant = undefined;
  if (primaryDelivery?.slug === "note") {
    if (hasInsight && hasMajor) {
      resolvedNoteVariant = NOTE_VARIANT_SPECS["insight-major"];
    } else {
      for (const tok of tokens) {
        if (NOTE_VARIANT_SPECS[tok]) {
          resolvedNoteVariant = NOTE_VARIANT_SPECS[tok];
          break;
        }
      }
    }
    if (!resolvedNoteVariant && modifierTerms.length > 0) {
      warnings.push(
        `Modifier(s) ${modifierTerms.map((m) => `\`${m.slug}\``).join(", ")} are valid IASP modifiers, but not in the 22 styled \`note-variants\` set; this block will render as a plain note box unless paired with a styled note variant or \`.badge\`.`,
      );
    }
  }

  const deliveryNotation = primaryDelivery
    ? parseNotations(primaryDelivery.notations)[0] ?? primaryDelivery.slug
    : standaloneBlock
      ? standaloneBlock.slug
      : null;

  const braceClasses = tokens.map((t) => `.${t}`).join(" ");
  const braceFence = `::: {${braceClasses}}\n...\n:::`;

  const shorthandSupported =
    (primaryDelivery && DELIVERY_ROLE_SPECS[primaryDelivery.slug]?.shorthandSupported) ||
    Boolean(standaloneBlock) ||
    tokens[0] === "include";

  const shorthandFence = shorthandSupported ? `::: ${tokens.join(".")}\n...\n:::` : null;
  const headingSyntax = `## Heading Title {${braceClasses}}`;

  // Plain-English explanation of the layered intent
  const explanationParts: string[] = [];
  if (primaryDelivery) {
    explanationParts.push(`Delivery role \`${primaryDelivery.slug}\`: ${primaryDelivery.scope_note ?? primaryDelivery.label}`);
  } else if (standaloneBlock) {
    explanationParts.push(
      `Standalone expository block \`${standaloneBlock.slug}\`: ${standaloneBlock.scope_note ?? standaloneBlock.label}`,
    );
  } else if (!buildModifiers.some((b) => b.token === "include")) {
    warnings.push("No Axis A delivery role was specified; consider starting with a delivery role such as `note`, `sidebar`, `callout`, or `bridge`.");
  }

  for (const mod of modifierTerms) {
    if (standaloneBlock && mod.id === standaloneBlock.id) continue;
    explanationParts.push(`Modifier \`${mod.slug}\` (${mod.group_slug ?? "modifier"}): ${mod.scope_note ?? mod.label}`);
  }
  for (const bm of buildModifiers) {
    explanationParts.push(`Build modifier \`.${bm.token}\` (${bm.category}): ${bm.description}`);
  }

  const deliverySpec = primaryDelivery
    ? DELIVERY_ROLE_SPECS[primaryDelivery.slug]
    : standaloneBlock
      ? STANDALONE_MODIFIER_BLOCKS[standaloneBlock.slug]
      : undefined;

  return {
    valid: unknownTokens.length === 0,
    tokens,
    delivery_role: primaryDelivery ? { id: primaryDelivery.id, slug: primaryDelivery.slug, scope_note: primaryDelivery.scope_note } : null,
    modifiers: modifierTerms.map((m) => ({
      id: m.id,
      slug: m.slug,
      group: m.group_slug,
      scope_note: m.scope_note,
    })),
    build_modifiers: buildModifiers,
    unknown_tokens: unknownTokens,
    warnings,
    intent_summary: explanationParts.join(" "),
    syntax: {
      brace_fence: braceFence,
      ...(shorthandFence ? { shorthand_fence: shorthandFence } : {}),
      heading_attribute: headingSyntax,
      ...(deliveryNotation ? { canonical_dot_notation: tokens.join(".") } : {}),
    },
    rendering: resolvedNoteVariant
      ? {
          kind: "note-variant",
          epub_html: `Div with epub:type="note", CSS class ${resolvedNoteVariant.epubCssClass}, glyph ${resolvedNoteVariant.ghost.glyph}`,
          pdf_latex: `\\begin{${resolvedNoteVariant.latexEnv}} with ${resolvedNoteVariant.latexHeaderMacro}`,
          ghost_markdown: `HTML <div> (${resolvedNoteVariant.ghost.bg} background, ${resolvedNoteVariant.ghost.border} border) with ${resolvedNoteVariant.ghost.glyphOnly ? `inline ${resolvedNoteVariant.ghost.glyph} glyph` : `"${resolvedNoteVariant.ghost.glyph} ${resolvedNoteVariant.ghost.label}" badge`}`,
        }
      : deliverySpec
        ? {
            kind: primaryDelivery ? "delivery-role" : "standalone-block",
            epub_html: deliverySpec.epubType
              ? `epub:type="${deliverySpec.epubType}"${deliverySpec.ariaRole ? `, role="${deliverySpec.ariaRole}"` : ""}`
              : "Semantic class wrapper preserved in HTML/EPUB",
            pdf_latex: deliverySpec.latexEnv ? `\\begin{${deliverySpec.latexEnv}}` : "Standard section/block flow",
            ghost_markdown: deliverySpec.ghostBehavior,
          }
        : {
            kind: "unmapped-or-custom",
            epub_html: "Classes preserved on element",
            pdf_latex: "Classes preserved; no dedicated box wrapper",
            ghost_markdown: "Wrapper unwrapped; inner Markdown passed through",
          },
  };
}

export const GUIDE_TOPICS = [
  "overview",
  "wrappers",
  "note-variants",
  "sidebars",
  "includes",
  "tables",
  "pagination",
  "stages",
  "ai-disclosure",
  "ghost",
] as const;

export type GuideTopic = (typeof GUIDE_TOPICS)[number];

export function getAuthoringGuide(db: DB, topic: GuideTopic = "overview") {
  const counts = {
    totalTerms: (db.prepare("SELECT COUNT(*) FROM terms WHERE status = 'active'").pluck().get() as number) ?? 0,
    deliveryRoles:
      (db.prepare("SELECT COUNT(*) FROM terms WHERE axis = 'delivery-role' AND depth >= 1 AND status = 'active'").pluck().get() as number) ??
      0,
    modifiers:
      (db.prepare("SELECT COUNT(*) FROM terms WHERE axis = 'modifier' AND notations != '[]' AND status = 'active'").pluck().get() as number) ??
      0,
    noteVariants: Object.keys(NOTE_VARIANT_SPECS).filter((k) => k !== "orientation" && k !== "ai").length,
  };

  const guides: Record<GuideTopic, { title: string; summary: string; markdown: string }> = {
    overview: {
      title: "IASP Core & Compositional Authoring Overview",
      summary: `IASP defines ${counts.deliveryRoles} delivery roles (Axis A) and ${counts.modifiers} modifiers (Axis B), with ${counts.noteVariants} styled note variants.`,
      markdown: `# Informative Authoring Semantics Profile (IASP)

IASP names **what a passage of nonfiction is doing** — not how it is formatted:

1. **Axis A — Delivery Roles** (\`front-matter\`, \`series\`, \`part\`, \`chapter\`, \`section\`, \`interlude\`, \`bridge\`, \`sidebar\`, \`sidebar-inline\`, \`callout\`, \`note\`, \`footnote\`, \`endnotes\`, \`epigraph\`, \`epigraph-inline\`, \`appendix\`, \`back-matter\`) describe placement relative to the main narrative flow.
2. **Axis B — Modifiers** describe rhetorical moves (\`thesis\`, \`claim\`, \`counterpoint\`, \`qualification\`, \`implication\`, \`synthesis\`, \`integration\`, \`contrast\`, \`reflection\`, \`provocation\`), exposition/support (\`example\`, \`case-study\`, \`background\`, \`context\`, \`definition\`, \`gloss\`, \`analogy\`, \`insight\`, \`insight.major\`, \`idea\`, \`usage\`, \`methodology\`, \`diagnostic\`, \`checklist\`), reader signals/stance (\`warning\`, \`notice\`, \`caution\`, \`misuse\`, \`assumption\`, \`limitation\`, \`scope\`, \`uncertainty\`, \`disclosure\`, \`responsibility\`, \`reflexive\`), and reader navigation (\`breadcrumb\`, \`navigation\`, \`transition\`, \`prelude\`, \`closing\`).

## Compositional Syntax (\`delivery.modifier\`)

- **Shorthand fence** (for top-level blocks): \`::: note.insight\` … \`:::\` or \`::: sidebar.example\` … \`:::\`
- **Brace fence** (canonical, required for nested blocks or multi-attribute blocks): \`::: {.note .insight}\` … \`:::\`
- **Heading attribute**: \`## Section Title {.sidebar .background}\`

Unmarked prose is always valid and assumed to be part of the main narrative flow.`,
    },
    wrappers: {
      title: "Fenced Wrapper Cheat Sheet",
      summary: "Shorthand vs. brace syntax for sidebars, notes, callouts, bridges, examples, definitions, and epigraphs.",
      markdown: `# Wrapper Cheat Sheet

| Purpose | Shorthand | Brace form (canonical) | Notes |
|---|---|---|---|
| Full sidebar | \`::: sidebar.sidebar-block\` | \`::: {.sidebar .sidebar-block}\` | Full-width box with \`SIDEBAR\` badge. Use \`##\`+ headings inside. |
| Inline sidebar | \`::: sidebar-inline\` | \`::: {.sidebar-inline}\` | Compact inline box with \`🗒\` glyph. Add \`.glyph-top\` to stack glyph. |
| Callout | \`::: callout\` | \`::: {.callout}\` | Light left-border annotation frame. |
| Note variant | \`::: note.<variant>\` | \`::: {.note .<variant>}\` | 22 styled note variants (see \`note-variants\` topic). |
| Bridge | \`::: bridge\` | \`::: {.bridge}\` | Lavender transitional block between major sections. |
| Example | \`::: example\` | \`::: {.example}\` | Blue-accented illustration box. |
| Definition | \`::: definition\` | \`::: {.definition}\` | Green-accented glossary/term definition box. |
| Epigraph | \`::: epigraph\` | \`::: {.epigraph}\` | Right-aligned italic quotation at head of part/chapter/section. |
| Include | \`::: include path="…"\` | \`::: {.include path="…"}\` | Always use brace form \`{.include ...}\` when nested inside another div. |`,
    },
    "note-variants": {
      title: "Styled Note Variants (note.<variant>)",
      summary: "The 22 note variants recognized by the Lua filter, LaTeX box-note.tex, CSS, and Ghost exporter.",
      markdown: `# Styled Note Variants (\`note.<variant>\`)

| Composition | Glyph / Header | Purpose |
|---|---|---|
| \`note.idea\` | Inline 💡 | Generative thought or suggestion offered in passing |
| \`note.insight\` | Ornamental ⁂ row | Moment of realization or reframing |
| \`note.insight.major\` | Badge strip ⁂ | Major insight given more visual weight |
| \`note.warning\` | Badge ※ / ⚠ | Risk, harm, or moral alert |
| \`note.misuse\` | Red badge ✕ | Flags common misreadings or "do not weaponize this" cautions |
| \`note.contrast\` | Inline ⇆ | Short compare/contrast clarification between frameworks |
| \`note.transition\` | Inline ⇥ | Handoff moment, scene shift, or narrative pivot |
| \`note.breadcrumb\` | Badge ↗ / › | Pointer back to where an idea started or forward to where it continues |
| \`note.navigation\` | Teal badge ⇢ | Reader navigation and orientation guide (alias: \`note.orientation\`) |
| \`note.bridge\` | Lavender badge ⟷ | Stitches concepts together inside a chapter or appendix |
| \`note.usage\` | Steel-blue badge ⚙ | Practical "how to apply this" guidance |
| \`note.integration\` | Teal badge ∞ | Synthesizing or integrating across frameworks |
| \`note.synthesis\` | Green badge ⊕ | Integrates multiple strands into a single takeaway |
| \`note.responsibility\` | Amber badge ⚖ | Responsibility or accountability framing |
| \`note.reflexive\` | Slate badge ⟲ | Self-scrutiny: turning the analysis on the author or reader |
| \`note.disclosure\` | Violet badge ◊ | Transparency notes: assumptions, limits, or disclosures |
| \`note.diagnostic\` | Blue badge 🔍 | Pattern-recognition checklists and diagnostic callouts |
| \`note.methodology\` | Indigo badge ⊢ | Explains how the analysis is conducted |
| \`note.context\` | Warm slate badge ◉ | Contextual framing that sets the scene or background |
| \`note.scope\` | Warm copper badge ◎ | Delimits boundaries, applicability, or evidentiary thresholds |
| \`note.checklist\` | Teal badge ☐ | Indicative checklists, verification criteria, or evidence markers |
| \`note.prelude\` | Ornament ◆ / ◈ | Opening note preparing the reader for what follows |
| \`note.closing\` | Muted badge ∎ | Closing reflection or endcap |`,
    },
    sidebars: {
      title: "Sidebars, Badges, and Glyphs",
      summary: "Controlling full-width vs. inline sidebars, badge vs. glyph markers, and heading rules.",
      markdown: `# Sidebars, Badges, and Glyphs

- **Full-width sidebar**: \`::: {.sidebar .sidebar-block}\` (shows the \`🗒 SIDEBAR\` badge by default).
- **Inline sidebar**: \`::: {.sidebar-inline}\` (shows the inline \`🗒\` glyph on the first paragraph or heading).
- **Stacking the inline glyph**: Add \`.glyph-top\` (or \`data-glyph="block"\`) on \`sidebar-inline\` so the glyph sits on its own line above bullet lists.
- **Swapping badge vs. glyph**:
  - Force a badge: add \`.sidebar-badge\` or \`data-marker="badge"\`.
  - Force a glyph: add \`.sidebar-glyph\` or \`data-marker="glyph"\`.
  - Suppress badges: add \`.nobadge\` (\`.no-badge\`, \`.badge-off\`).
  - Suppress glyphs: add \`.noglyph\` (\`.no-glyph\`).
- **Important PDF rule**: Never use level-1 headers (\`# Title\`) inside \`.sidebar\` or \`.aside\` blocks; always use \`##\` or deeper so XeLaTeX \`mdframed\` boxes render their top border and badge properly.`,
    },
    includes: {
      title: "External Markdown Includes (.include)",
      summary: "Splicing reusable fragments, directories, file lists, and code listings into manuscripts.",
      markdown: `# Include Directives (\`.include\`)

Pull external Markdown fragments at build time:

\`\`\`markdown
::: {.include path="sidebars/ethics-note.md"}
:::

::: {.include dir="subchapters/w-series" separator="none" glyph="✶"}
:::

::: {.include dir="patterns" list="names" list-style="ordered"}
:::

::: {.include path="scripts/example.py" mode="code" lang="python"}
:::
\`\`\`

- Always use brace syntax \`::: {.include ...}\` when nested inside an outer wrapper (such as \`::: {.article}\` or \`::: {.chapter}\`).
- Adding \`.nobadge\` or \`.noglyph\` to the \`.include\` div transfers that modifier to the included sidebar or note block.`,
    },
    tables: {
      title: "Table Wrappers and Appearance",
      summary: "Proportional column widths, auto-compaction, striping, borders, and full-page promotion.",
      markdown: `# Table Wrappers (\`.table\`)

Wrap wide or complex tables in \`::: {.table}\`:

\`\`\`markdown
::: {.table .table-striped .table-bordered}
| Column A | Column B |
|---|---|
| ... | ... |
:::
\`\`\`

- \`.table-compact\`: Reduces font size and cell padding (also applied automatically when estimated row width ≥ 90 chars).
- \`.table-striped\`: Alternating row background tint.
- \`.table-bordered\`: Cell borders.
- \`.layout-fullpage\`: Starts the table on a fresh page and breaks after it in PDF/DOCX/RTF.`,
    },
    pagination: {
      title: "Page Breaks and Full-Page Layout",
      summary: "Controlling page breaks before and after bridges, tables, and callouts in PDF/DOCX/RTF.",
      markdown: `# Pagination & Layout Modifiers

- \`.layout-fullpage\`: Inserts a page break before and after the block in PDF, DOCX, and RTF (ignored in EPUB/HTML).
- \`.pre-pagebreak\`: Inserts a page break before the block only.
- \`.post-pagebreak\`: Inserts a page break after the block only.
- \`::: {.page-break}\` / \`::: {.pagebreak}\`: Standalone manual page break.`,
    },
    stages: {
      title: "Draft vs. Final Stage Visibility",
      summary: "Conditional blocks using .draft and .final classes.",
      markdown: `# Stage Visibility (\`.draft\` and \`.final\`)

Tag any fenced div, heading, or inline span with \`.draft\` or \`.final\`:

\`\`\`markdown
::: {.note .draft}
Working author note: verify page numbers in edition 2 before proof.
:::

::: {.note .synthesis .final}
Reader-facing synthesis shown in final builds.
:::
\`\`\`

- In \`final\` builds (the default), \`.draft\` elements are removed and \`.final\` elements render with the stage class stripped.
- In \`draft\` builds (\`stage: "draft"\`), \`.draft\` elements render and \`.final\` elements are hidden.`,
    },
    "ai-disclosure": {
      title: "Article AI Disclosure Sidecars (.ai.json)",
      summary: "Storing qualitative AI collaboration and technical notes alongside articles.",
      markdown: `# Article AI Disclosure Sidecars (\`<Article>.ai.json\`)

Store AI disclosure metadata in a sidecar file beside any article Markdown source (\`articles/<Name>.ai.json\`):

\`\`\`json
{
  "disclosure_variant": "ai",
  "ai_disclosure": "AI Disclosure: This article was developed through iterative collaboration with Claude.",
  "technical_note": "Technical Note: Published via the Informative Authoring Semantics Profile (IASP) pipeline."
}
\`\`\`

Prefer qualitative descriptions of collaboration over numeric turn counts. When exporting to Ghost Markdown (\`render_document\` with \`format: "ghost"\`), the sidecar is injected automatically ahead of \`## Works Cited\` (or at the end of the article) inside a styled disclosure box.`,
    },
    ghost: {
      title: "Publishing Articles to Ghost CMS",
      summary: "How Ghost Markdown export resolves includes and wraps semantic blocks in CommonMark Type-6 HTML divs.",
      markdown: `# Ghost Markdown Export

\`render_document\` with \`format: "ghost"\` converts an IASP Markdown file into Ghost-ready Markdown:

- \`.include\` directives are resolved inline.
- \`.article\` outer wrappers are stripped cleanly.
- \`note.<variant>\`, \`sidebar\`, \`callout\`, \`bridge\`, \`example\`, and \`definition\` fences become inline-styled HTML \`<div>\` containers with a blank line after the badge header, so Ghost's CommonMark parser renders all inner Markdown (bold, links, citations, footnotes) natively.
- \`epigraph\` fences become standard Markdown blockquotes (\`> ...\`).
- If a companion \`<article>.ai.json\` sidecar exists, the disclosure block is injected automatically before \`## Works Cited\`.`,
    },
  };

  const selected = guides[topic];
  if (!selected) {
    throw new ToolError(`Unknown guide topic "${topic}". Valid topics: ${GUIDE_TOPICS.join(", ")}.`);
  }
  return {
    topic,
    ...selected,
    available_topics: GUIDE_TOPICS,
  };
}

export function iaspStatus(db: DB) {
  const cursor = readCursor(db);
  const totalTerms = (db.prepare("SELECT COUNT(*) FROM terms").pluck().get() as number) ?? 0;
  const activeTerms = (db.prepare("SELECT COUNT(*) FROM terms WHERE status = 'active'").pluck().get() as number) ?? 0;
  const deliveryRoles =
    (db.prepare("SELECT COUNT(*) FROM terms WHERE axis = 'delivery-role' AND depth >= 1 AND status = 'active'").pluck().get() as number) ?? 0;
  const modifiers =
    (db.prepare("SELECT COUNT(*) FROM terms WHERE axis = 'modifier' AND notations != '[]' AND status = 'active'").pluck().get() as number) ??
    0;
  const sets = db
    .prepare("SELECT slug, label, ordered, json_array_length(members) AS count FROM concept_sets ORDER BY slug")
    .all() as { slug: string; label: string; ordered: number; count: number }[];
  const toolchain = detectToolchain();

  return {
    scheme: "iasp",
    terminology_cursor: cursor,
    counts: {
      total_terms: totalTerms,
      active_terms: activeTerms,
      delivery_roles: deliveryRoles,
      modifiers,
      note_variants: Object.keys(NOTE_VARIANT_SPECS).filter((k) => k !== "orientation" && k !== "ai").length,
      sets: sets.length,
    },
    sets: sets.map((s) => ({ ...s, ordered: Boolean(s.ordered) })),
    toolchain,
  };
}
