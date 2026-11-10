import Database from "better-sqlite3";
import {
  type DB,
  type SeedSet,
  type SeedTerm,
  getMeta,
  now,
  setMeta,
  upsertSet,
  upsertTermsAndRelations,
} from "./db.js";

/**
 * Follows terminology-mcp's `iasp` scheme ("Informative Authoring Semantic Profile"),
 * on the contract in terminology-mcp/docs/following-changes.md and quote-mcp/src/terminology.ts:
 * bootstrap from GET /api/state?scheme=iasp once, then apply numbered changes from
 * GET /api/changes?since=N&scheme=iasp in order, and report progress to
 * POST /api/subscribers/iasp-mcp/progress.
 */

export const SCHEME_ID = "iasp";
export const SUBSCRIBER_ID = "iasp-mcp";
export const SUBSCRIBER_LABEL = "IASP Authoring MCP";
export const DEFAULT_TERMINOLOGY_BASE = "http://terminology-mcp.localdomain:8000";
const CURSOR_KEY = `terminology:${SCHEME_ID}`;
const SETS_SEEDED_KEY = `${CURSOR_KEY}:sets-seeded`;
export const TERMS_INTERVAL_MS = 60_000;
const HEARTBEAT_MS = 5 * 60_000;

export type Term = SeedTerm;
export type TermSet = SeedSet;

export interface Change {
  n: number;
  kind: string;
  terms?: string[];
  after?: Term | null;
  afterTerms?: Term[];
  afterSets?: TermSet[];
  reason?: string | null;
}

export interface Blocked {
  at: number;
  code: string;
  reason: string;
}

export interface Cursor {
  log: string;
  through: number;
  blocked: Blocked | null;
}

export interface Problem {
  code: string;
  reason: string;
}

export function terminologyConfig(env: NodeJS.ProcessEnv = process.env): { baseUrl: string; timeoutMs: number } | null {
  const raw = env.TERMINOLOGY_BASE?.trim() ?? "";
  if (raw.toLowerCase() === "off") return null;
  return { baseUrl: (raw || DEFAULT_TERMINOLOGY_BASE).replace(/\/+$/, ""), timeoutMs: 10_000 };
}

export class TerminologyError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body: Record<string, unknown> | null = null,
  ) {
    super(message);
  }
}

export interface TerminologyClient {
  baseUrl: string;
  state(): Promise<{ log: string; version: number; head?: number; terms: Term[]; sets?: TermSet[] }>;
  changes(since: number): Promise<{ log: string; version: number; changes: Change[] }>;
  reportProgress(report: Record<string, unknown>): Promise<unknown>;
  propose(proposal: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export function terminologyClient({
  baseUrl,
  timeoutMs = 10_000,
  fetchImpl = fetch,
}: {
  baseUrl: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): TerminologyClient {
  const request = async (method: string, path: string, payload?: unknown) => {
    let res: Response;
    try {
      res = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers: payload === undefined ? {} : { "content-type": "application/json" },
        body: payload === undefined ? undefined : JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new TerminologyError(0, `terminology-mcp unreachable at ${baseUrl}: ${(error as Error).message}`);
    }
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok) {
      const detail = body?.error ?? body?.reason ?? "";
      throw new TerminologyError(
        res.status,
        `terminology-mcp ${method} ${path.split("?")[0]} answered ${res.status}${detail ? `: ${detail}` : ""}`,
        body,
      );
    }
    return body as never;
  };
  const scheme = encodeURIComponent(SCHEME_ID);
  return {
    baseUrl,
    state: () => request("GET", `/api/state?scheme=${scheme}`),
    changes: (since) => request("GET", `/api/changes?since=${since}&scheme=${scheme}`),
    reportProgress: (report) => request("POST", `/api/subscribers/${SUBSCRIBER_ID}/progress`, report),
    propose: (proposal) => request("POST", "/api/proposals", proposal),
  };
}

const inScheme = (t: Term) => !t.scheme || t.scheme === SCHEME_ID;
const snapshotsOf = (c: Change) => (c.afterTerms ?? (c.after?.id ? [c.after] : [])).filter(inScheme);

class Hold extends Error {
  constructor(
    readonly code: string,
    reason: string,
  ) {
    super(reason);
  }
}

interface LocalRow {
  id: string;
  slug: string;
  label: string;
  status: string;
}

const IGNORED = new Set(["scheme-added", "scheme-changed"]);
const SET_KINDS = new Set(["set-added", "set-changed", "set-deleted"]);
const APPLIED = new Set(["imported", "added", "noted", "labelled", "updated", "moved", "slugged", "merged", "retired", "split"]);

function applySets(db: DB, change: Change): string[] {
  const sets = (change.afterSets ?? []).filter((s) => s.scheme === SCHEME_ID);
  for (const set of sets) upsertSet(db, set);
  return sets.map((s) => `${change.kind}: set ${s.slug}${s.deleted ? " (deleted)" : ""}`);
}

function replaceSets(db: DB, sets: TermSet[]): void {
  const keep = new Set(sets.map((s) => s.id));
  for (const id of db.prepare("SELECT id FROM concept_sets WHERE scheme = ?").pluck().all(SCHEME_ID) as string[]) {
    if (!keep.has(id)) db.prepare("DELETE FROM concept_sets WHERE id = ?").run(id);
  }
  for (const set of sets) upsertSet(db, set);
}

export function applyChange(db: DB, change: Change): string[] {
  if (IGNORED.has(change.kind) || SET_KINDS.has(change.kind)) return applySets(db, change);
  if (!APPLIED.has(change.kind)) {
    throw new Hold("unknown-change", `Change kind "${change.kind}" isn't one iasp-mcp knows`);
  }
  const terms = snapshotsOf(change);
  const lines: string[] = [];
  if (terms.length) {
    try {
      upsertTermsAndRelations(db, terms);
    } catch (error) {
      if ((error as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE") {
        throw new Hold("slug-clash", `A term slug in change ${change.n} clashed with an existing concept`);
      }
      throw error;
    }
    lines.push(`${change.kind}: ${terms.map((t) => `${t.slug}${t.status === "retired" ? " (retired)" : ""}`).join(", ")}`);
  }
  lines.push(...applySets(db, change));
  return lines;
}

export class CursorMovedError extends Error {
  constructor() {
    super("The terminology cursor moved during this pass; the next pass starts from it.");
  }
}

export function readCursor(db: DB): Cursor | null {
  const value = getMeta(db, CURSOR_KEY);
  return value ? (JSON.parse(value) as Cursor) : null;
}

function writeCursor(db: DB, cursor: Cursor, expected: number | null): void {
  const current = readCursor(db);
  if ((current?.through ?? null) !== expected || (current && current.log !== cursor.log)) {
    throw new CursorMovedError();
  }
  setMeta(db, CURSOR_KEY, JSON.stringify(cursor));
}

export function clearCursor(db: DB): void {
  db.prepare("DELETE FROM meta WHERE key IN (?, ?)").run(CURSOR_KEY, SETS_SEEDED_KEY);
}

const BLOCKING = new Set(["slug-mismatch", "term-mismatch", "slug-clash"]);

export function planBootstrap(db: DB, terms: Term[]) {
  const rows = db.prepare("SELECT id, slug, label, status FROM terms WHERE scheme = ?").all(SCHEME_ID) as LocalRow[];
  const bySlug = new Map(rows.map((r) => [r.slug, r]));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const matches: [LocalRow, Term][] = [];
  const added: Term[] = [];
  const problems: Problem[] = [];

  for (const t of terms) {
    const row = byId.get(t.id) ?? bySlug.get(t.slug);
    if (!row) {
      added.push(t);
      continue;
    }
    if (row.id !== t.id && byId.has(t.id)) {
      problems.push({ code: "term-mismatch", reason: `${row.slug} has id ${row.id} locally, but terminology-mcp has ${t.id}` });
    }
    if (row.slug !== t.slug) {
      problems.push({ code: "slug-mismatch", reason: `${row.slug} is ${t.slug} in terminology-mcp` });
    }
    matches.push([row, t]);
  }

  return {
    matches,
    added,
    problems,
    blocked: problems.some((p) => BLOCKING.has(p.code)),
  };
}

export interface SyncResult {
  outcome: "bootstrap" | "bootstrapped" | "bootstrap-held" | "rebuilt" | "applied" | "current" | "held";
  log: string | null;
  through: number | null;
  head?: number;
  blocked?: Blocked | null;
  reset?: boolean;
  lines: string[];
  problems?: Problem[];
}

async function bootstrap(db: DB, client: TerminologyClient, apply: boolean): Promise<SyncResult> {
  const state = await client.state();
  const terms = state.terms.filter(inScheme);
  const plan = planBootstrap(db, terms);
  const sets = (state.sets ?? []).filter((s) => s.scheme === SCHEME_ID && !s.deleted);
  const base = {
    log: state.log,
    through: state.version,
    head: state.head ?? state.version,
    problems: plan.problems,
  };
  const lines = [
    `${plan.matches.length} terms matched, ${plan.added.length} new`,
    ...plan.added.map((t) => `add ${t.slug}`),
    ...sets.map((s) => `set ${s.slug}`),
  ];
  if (plan.blocked) return { outcome: "bootstrap-held", ...base, lines };
  if (!apply) return { outcome: "bootstrap", ...base, lines };

  db.transaction(() => {
    // If local seed had different term IDs for the same slug, align them before upserting
    const updateId = db.prepare("UPDATE terms SET id = ? WHERE slug = ? AND id != ?");
    for (const [row, t] of plan.matches) {
      if (row.id !== t.id) updateId.run(t.id, row.slug, row.id);
    }
    upsertTermsAndRelations(db, terms);
    replaceSets(db, sets);
    setMeta(db, SETS_SEEDED_KEY, state.log);
    writeCursor(db, { log: state.log, through: state.version, blocked: null }, null);
  }).immediate();

  return { outcome: "bootstrapped", ...base, lines, reset: true };
}

const ROLLBACK = new Error("dry run");

export async function runTermSync({
  db,
  client,
  apply = true,
}: {
  db: DB;
  client: TerminologyClient;
  apply?: boolean;
}): Promise<SyncResult> {
  const cursor = readCursor(db);
  if (!cursor) return bootstrap(db, client, apply);

  let response: Awaited<ReturnType<TerminologyClient["changes"]>> | null;
  try {
    response = await client.changes(cursor.through);
  } catch (error) {
    if (!(error instanceof TerminologyError && error.status === 400)) throw error;
    response = null;
  }

  if (!response || response.log !== cursor.log) {
    if (apply) clearCursor(db);
    return { outcome: "rebuilt", log: response?.log ?? null, through: cursor.through, lines: [] };
  }

  const { log, version } = response;
  const pass = (): SyncResult => {
    let through = cursor.through;
    let blocked: Blocked | null = null;
    const lines: string[] = [];

    for (const change of response.changes) {
      try {
        lines.push(
          ...db
            .transaction(() => {
              const done = applyChange(db, change);
              writeCursor(db, { log, through: change.n, blocked: null }, through);
              return done;
            })
            .immediate()
            .map((l) => `${change.n} ${l}`),
        );
        through = change.n;
      } catch (error) {
        if (!(error instanceof Hold)) throw error;
        blocked = { at: change.n, code: error.code, reason: error.message };
        break;
      }
    }

    const written = through;
    if (!blocked) through = version;
    db.transaction(() => writeCursor(db, { log, through, blocked }, written)).immediate();
    return {
      outcome: blocked ? "held" : through > cursor.through ? "applied" : "current",
      log,
      through,
      head: version,
      blocked,
      lines,
    };
  };

  if (apply) return pass();

  let result: SyncResult | undefined;
  try {
    db.transaction(() => {
      result = pass();
      throw ROLLBACK;
    })();
  } catch (error) {
    if (error !== ROLLBACK) throw error;
  }
  return result!;
}

export function progressReport(result: Pick<SyncResult, "log" | "through" | "blocked" | "reset">): Record<string, unknown> {
  return {
    log: result.log,
    through: result.through,
    label: SUBSCRIBER_LABEL,
    schemes: [SCHEME_ID],
    ...(result.blocked ? { blocked: result.blocked } : {}),
    ...(result.reset ? { reset: true } : {}),
  };
}

export async function reportProgress(
  client: TerminologyClient,
  result: Pick<SyncResult, "log" | "through" | "blocked" | "reset">,
): Promise<unknown> {
  const report = progressReport(result);
  try {
    return await client.reportProgress(report);
  } catch (error) {
    if (error instanceof TerminologyError && error.status === 409 && Number.isInteger(error.body?.through)) {
      return client.reportProgress({ ...report, reset: true });
    }
    throw error;
  }
}

export interface TermSyncStatus {
  phase: "off" | "pending" | "ok" | "held" | "error";
  through: number | null;
  head: number | null;
  blocked: Blocked | null;
  error: string | null;
  at: string | null;
}

export const termSyncEnabled = (env: NodeJS.ProcessEnv = process.env) =>
  (env.IASP_TERMS_SYNC?.trim().toLowerCase() ?? "on") !== "off";

export function startTermSync({
  file,
  env = process.env,
  client,
  intervalMs = TERMS_INTERVAL_MS,
}: {
  file: string;
  env?: NodeJS.ProcessEnv;
  client?: TerminologyClient;
  intervalMs?: number;
}): () => TermSyncStatus {
  const status: TermSyncStatus = { phase: "off", through: null, head: null, blocked: null, error: null, at: null };
  const config = terminologyConfig(env);
  if (!termSyncEnabled(env) || (!client && !config)) return () => ({ ...status });
  const target = client ?? terminologyClient(config!);
  const db = new Database(file, { fileMustExist: true });
  db.pragma("busy_timeout = 30000");
  db.pragma("foreign_keys = ON");
  status.phase = "pending";
  let running = false;
  let lastReport = "";
  let lastReportAt = 0;

  const run = async () => {
    if (running) return;
    running = true;
    try {
      const result = await runTermSync({ db, client: target });
      for (const line of result.lines) {
        if (result.outcome !== "current") console.error(`IASP terms from terminology-mcp: ${line}`);
      }
      Object.assign(status, {
        phase: result.outcome === "held" ? "held" : "ok",
        through: result.through,
        head: result.head ?? null,
        blocked: result.blocked ?? null,
        error: result.outcome === "held" ? `${result.blocked!.code}: ${result.blocked!.reason}` : null,
      });
      if (result.outcome === "rebuilt") return;
      const key = JSON.stringify([result.log, result.through, result.blocked ?? null]);
      if (key !== lastReport || Date.now() - lastReportAt >= HEARTBEAT_MS) {
        await reportProgress(target, result);
        lastReport = key;
        lastReportAt = Date.now();
      }
    } catch (error) {
      const message = (error as Error).message;
      Object.assign(status, { phase: "error", error: message });
    } finally {
      status.at = now();
      running = false;
    }
  };

  const timer = setInterval(() => void run(), intervalMs);
  timer.unref();
  void run();
  return () => ({ ...status });
}
