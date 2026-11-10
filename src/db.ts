import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

export type DB = Database.Database;

export const SCHEMA_VERSION = 1;

export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const SEED_PATH = resolve(PROJECT_ROOT, "vocab/iasp-seed.json");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS terms (
  id TEXT PRIMARY KEY,
  scheme TEXT NOT NULL DEFAULT 'iasp',
  slug TEXT NOT NULL UNIQUE,
  former_slugs TEXT NOT NULL DEFAULT '[]',
  label TEXT NOT NULL,
  alt_labels TEXT NOT NULL DEFAULT '[]',
  notations TEXT NOT NULL DEFAULT '[]',
  scope_note TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  replaced_by TEXT NOT NULL DEFAULT '[]',
  broader TEXT NOT NULL DEFAULT '[]',
  path TEXT NOT NULL DEFAULT '',
  depth INTEGER NOT NULL DEFAULT 0,
  axis TEXT,
  group_slug TEXT,
  source_uri TEXT,
  links TEXT NOT NULL DEFAULT '[]',
  aliases TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS terms_axis ON terms (axis);
CREATE INDEX IF NOT EXISTS terms_group ON terms (group_slug);
CREATE INDEX IF NOT EXISTS terms_status ON terms (status);

CREATE TABLE IF NOT EXISTS term_relations (
  from_id TEXT NOT NULL REFERENCES terms(id) ON DELETE CASCADE,
  to_id TEXT NOT NULL REFERENCES terms(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('broader', 'narrower', 'related', 'opposite')),
  PRIMARY KEY (from_id, to_id, type)
);
CREATE INDEX IF NOT EXISTS term_relations_to ON term_relations (to_id, type);

CREATE TABLE IF NOT EXISTS concept_sets (
  id TEXT PRIMARY KEY,
  scheme TEXT NOT NULL DEFAULT 'iasp',
  slug TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  description TEXT,
  kind TEXT NOT NULL DEFAULT 'profile',
  ordered INTEGER NOT NULL DEFAULT 0,
  members TEXT NOT NULL DEFAULT '[]',
  recipe TEXT,
  former_slugs TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL
);
`;

export interface SeedTerm {
  id: string;
  scheme?: string;
  slug: string;
  formerSlugs?: string[];
  label: string;
  altLabels?: string[];
  notations?: { value: string; datatype?: string }[];
  scopeNote?: string | null;
  status?: "provisional" | "active" | "retired";
  replacedBy?: string[];
  broader?: string[];
  path?: string;
  depth?: number;
  sourceUri?: string | null;
  relations?: { type: string; target: string }[];
  links?: { uri: string; match: string }[];
  aliases?: string[];
}

export interface SeedSet {
  id: string;
  scheme: string;
  slug: string;
  label: string;
  description?: string | null;
  kind?: string;
  ordered?: boolean;
  members?: string[];
  recipe?: Record<string, unknown> | null;
  deleted?: boolean;
}

export const now = () => new Date().toISOString();

export function deriveAxisAndGroup(pathStr: string, slug: string): { axis: "delivery-role" | "modifier" | null; groupSlug: string | null } {
  const parts = pathStr.split("/").filter(Boolean);
  const top = parts[0] ?? slug;
  const axis = top === "delivery-role" ? "delivery-role" : top === "modifier" ? "modifier" : null;
  let groupSlug: string | null = null;
  if (axis === "modifier" && parts.length >= 2) {
    groupSlug = parts[1];
  } else if (axis === "delivery-role" && parts.length >= 2) {
    groupSlug = "delivery-role";
  }
  return { axis, groupSlug };
}

export function upsertTermsAndRelations(db: DB, terms: SeedTerm[]): void {
  const stamp = now();
  // Map ids and broader links so we can compute paths/depths if a change snapshot omits them
  const byId = new Map<string, SeedTerm>();
  for (const existing of db.prepare("SELECT id, slug, broader, path, depth FROM terms").all() as {
    id: string;
    slug: string;
    broader: string;
    path: string;
    depth: number;
  }[]) {
    byId.set(existing.id, {
      id: existing.id,
      slug: existing.slug,
      label: existing.slug,
      broader: JSON.parse(existing.broader) as string[],
      path: existing.path,
      depth: existing.depth,
    });
  }
  for (const t of terms) {
    byId.set(t.id, t);
  }

  const computePath = (t: SeedTerm, seen = new Set<string>()): { path: string; depth: number } => {
    if (t.path && typeof t.depth === "number") return { path: t.path, depth: t.depth };
    if (seen.has(t.id)) return { path: t.slug, depth: 0 };
    seen.add(t.id);
    const parentId = t.broader?.[0];
    const parent = parentId ? byId.get(parentId) : undefined;
    if (!parent) return { path: t.slug, depth: 0 };
    const p = computePath(parent, seen);
    return { path: `${p.path}/${t.slug}`, depth: p.depth + 1 };
  };

  const stmt = db.prepare(`
    INSERT INTO terms (
      id, scheme, slug, former_slugs, label, alt_labels, notations, scope_note,
      status, replaced_by, broader, path, depth, axis, group_slug, source_uri, links, aliases, updated_at
    ) VALUES (
      @id, @scheme, @slug, @former_slugs, @label, @alt_labels, @notations, @scope_note,
      @status, @replaced_by, @broader, @path, @depth, @axis, @group_slug, @source_uri, @links, @aliases, @updated_at
    )
    ON CONFLICT (id) DO UPDATE SET
      scheme = excluded.scheme,
      slug = excluded.slug,
      former_slugs = excluded.former_slugs,
      label = excluded.label,
      alt_labels = excluded.alt_labels,
      notations = excluded.notations,
      scope_note = excluded.scope_note,
      status = excluded.status,
      replaced_by = excluded.replaced_by,
      broader = excluded.broader,
      path = excluded.path,
      depth = excluded.depth,
      axis = excluded.axis,
      group_slug = excluded.group_slug,
      source_uri = COALESCE(excluded.source_uri, terms.source_uri),
      links = excluded.links,
      aliases = excluded.aliases,
      updated_at = excluded.updated_at
  `);

  for (const t of terms) {
    const { path: resolvedPath, depth } = computePath(t);
    const { axis, groupSlug } = deriveAxisAndGroup(resolvedPath, t.slug);
    stmt.run({
      id: t.id,
      scheme: t.scheme ?? "iasp",
      slug: t.slug,
      former_slugs: JSON.stringify(t.formerSlugs ?? []),
      label: t.label,
      alt_labels: JSON.stringify(t.altLabels ?? []),
      notations: JSON.stringify(t.notations ?? []),
      scope_note: t.scopeNote ?? null,
      status: t.status ?? "active",
      replaced_by: JSON.stringify(t.replacedBy ?? []),
      broader: JSON.stringify(t.broader ?? []),
      path: resolvedPath,
      depth,
      axis,
      group_slug: groupSlug,
      source_uri: t.sourceUri ?? null,
      links: JSON.stringify(t.links ?? []),
      aliases: JSON.stringify(t.aliases ?? []),
      updated_at: stamp,
    });
  }

  const clearRels = db.prepare(`
    DELETE FROM term_relations
    WHERE (from_id = @id AND type IN ('broader', 'related', 'opposite'))
       OR (to_id = @id AND type IN ('narrower', 'related', 'opposite'))
  `);
  const insertRel = db.prepare(`
    INSERT OR IGNORE INTO term_relations (from_id, to_id, type) VALUES (?, ?, ?)
  `);
  const existsTerm = db.prepare("SELECT 1 FROM terms WHERE id = ?").pluck();

  for (const t of terms) {
    clearRels.run({ id: t.id });
  }
  for (const t of terms) {
    for (const parentId of t.broader ?? []) {
      if (!existsTerm.get(parentId)) continue;
      insertRel.run(t.id, parentId, "broader");
      insertRel.run(parentId, t.id, "narrower");
    }
    for (const rel of t.relations ?? []) {
      if (rel.type !== "related" && rel.type !== "opposite") continue;
      if (!existsTerm.get(rel.target)) continue;
      insertRel.run(t.id, rel.target, rel.type);
      insertRel.run(rel.target, t.id, rel.type);
    }
  }
}

export function upsertSet(db: DB, set: SeedSet): void {
  if (set.deleted) {
    db.prepare("DELETE FROM concept_sets WHERE id = ?").run(set.id);
    return;
  }
  const existing = db.prepare("SELECT slug, former_slugs FROM concept_sets WHERE id = ?").get(set.id) as
    | { slug: string; former_slugs: string }
    | undefined;
  const former = new Set<string>(JSON.parse(existing?.former_slugs ?? "[]") as string[]);
  if (existing && existing.slug !== set.slug) former.add(existing.slug);
  former.delete(set.slug);

  db.prepare(`
    INSERT INTO concept_sets (id, scheme, slug, label, description, kind, ordered, members, recipe, former_slugs, updated_at)
    VALUES (@id, @scheme, @slug, @label, @description, @kind, @ordered, @members, @recipe, @former_slugs, @updated_at)
    ON CONFLICT (id) DO UPDATE SET
      scheme = excluded.scheme,
      slug = excluded.slug,
      label = excluded.label,
      description = excluded.description,
      kind = excluded.kind,
      ordered = excluded.ordered,
      members = excluded.members,
      recipe = excluded.recipe,
      former_slugs = excluded.former_slugs,
      updated_at = excluded.updated_at
  `).run({
    id: set.id,
    scheme: set.scheme ?? "iasp",
    slug: set.slug,
    label: set.label,
    description: set.description ?? null,
    kind: set.kind ?? "profile",
    ordered: set.ordered ? 1 : 0,
    members: JSON.stringify(set.members ?? []),
    recipe: set.recipe ? JSON.stringify(set.recipe) : null,
    former_slugs: JSON.stringify([...former]),
    updated_at: now(),
  });
}

export function seedFromBundledSnapshot(db: DB, seedFile = SEED_PATH): void {
  const count = (db.prepare("SELECT COUNT(*) FROM terms").pluck().get() as number) ?? 0;
  if (count > 0 || !existsSync(seedFile)) return;
  const raw = JSON.parse(readFileSync(seedFile, "utf8")) as {
    terms?: SeedTerm[];
    sets?: SeedSet[];
  };
  db.transaction(() => {
    if (raw.terms?.length) upsertTermsAndRelations(db, raw.terms);
    for (const s of raw.sets ?? []) upsertSet(db, s);
  }).immediate();
}

export function openDb(path = process.env.IASP_DB ?? "data/iasp.db", options: { seed?: boolean } = {}): DB {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  const version = Number(db.pragma("user_version", { simple: true }));
  if (version > SCHEMA_VERSION) {
    throw new Error(`${path} has schema ${version}; this build knows ${SCHEMA_VERSION}.`);
  }
  db.exec(SCHEMA);
  db.pragma(`user_version = ${SCHEMA_VERSION}`);
  if (options.seed !== false) {
    seedFromBundledSnapshot(db);
  }
  return db;
}

export function getMeta(db: DB, key: string): string | undefined {
  return (db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined)?.value;
}

export function setMeta(db: DB, key: string, value: string): void {
  db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(key, value);
}
