import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { SCHEMA_VERSION, openDb } from "./db.js";
import { validateMarkdown } from "./markdown.js";
import { composeIntent, iaspStatus } from "./queries.js";
import { type RenderFormat, RENDER_FORMATS, renderDocument } from "./render.js";
import { serveHttp, serveStdio } from "./server.js";
import { reportProgress, runTermSync, startTermSync, terminologyClient, terminologyConfig } from "./terminology.js";

/**
 *   iasp-mcp serve                     MCP over HTTP at /mcp, web reference & demo at /, admin at /admin, /health
 *   iasp-mcp stdio                     MCP over stdio, for local IDE clients and tests
 *   iasp-mcp terms [--dry-run]         Syncs the `iasp` scheme from terminology-mcp and reports progress
 *   iasp-mcp demo [--formats html,ghost,pdf,epub]
 *                                      Builds the end-to-end demonstration essay (demo/essay-on-attentive-reading.md)
 *   iasp-mcp render <path> [--formats html,ghost,pdf] [--stage final|draft]
 *   iasp-mcp validate <path>           Validates IASP fences, sidebars, classes, and includes
 *   iasp-mcp compose <expr>            Inspects a composed IASP expression (e.g. note.insight.major)
 *   iasp-mcp migrate [--backup <file>] Brings the store up to this build's schema, first copying it to <file> when
 *                                      that changes the schema (the deploy keeps the copy for a rollback)
 *   iasp-mcp backup [--dir data/backups] [--keep 14]
 *   iasp-mcp status                    Prints terminology cursor, term counts, and toolchain status
 */

const argv = process.argv.slice(3);
const flag = (name: string) => argv.includes(name);
const option = (name: string) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);

async function termsCommand() {
  const db = openDb();
  const cfg = terminologyConfig();
  if (!cfg) {
    console.log("TERMINOLOGY_BASE is set to off.");
    return;
  }
  const client = terminologyClient(cfg);
  const apply = !flag("--dry-run");
  const result = await runTermSync({ db, client, apply });
  for (const line of result.lines) console.log(line);
  console.log(`Outcome: ${result.outcome} (through: ${result.through ?? "none"}, head: ${result.head ?? "unknown"})`);
  if (apply && result.log && result.through !== null) {
    await reportProgress(client, result);
  }
}

async function serveCommand() {
  const file = process.env.IASP_DB ?? "data/iasp.db";
  const db = openDb(file);
  const termSync = startTermSync({ file });
  await serveHttp(db, {
    host: process.env.IASP_HOST ?? "0.0.0.0",
    port: Number(process.env.IASP_PORT ?? 8000),
    termSync,
  });
}

function parseFormats(raw: string | undefined, fallback: RenderFormat[]): RenderFormat[] {
  if (!raw) return fallback;
  return raw
    .split(",")
    .map((s) => s.trim() as RenderFormat)
    .filter((f): f is RenderFormat => (RENDER_FORMATS as readonly string[]).includes(f));
}

function demoCommand() {
  const formats = parseFormats(option("--formats"), ["md", "ghost", "html", "pdf", "epub"]);
  const stage = option("--stage") === "draft" ? "draft" : "final";
  const target = option("--source") ?? "all";
  if (target === "all") {
    const demo = renderDocument({ source: "demo", formats, stage, validateEpub: true });
    const interop = renderDocument({ source: "interop", formats, stage, validateEpub: true });
    console.log(JSON.stringify({ demo, interop }, null, 2));
    return;
  }
  const result = renderDocument({
    source: target,
    formats,
    stage,
    validateEpub: true,
  });
  console.log(JSON.stringify(result, null, 2));
}

function renderCommand() {
  const target = argv.find((a) => !a.startsWith("-")) ?? "demo";
  const formats = parseFormats(option("--formats"), ["md", "html", "ghost"]);
  const stage = option("--stage") === "draft" ? "draft" : "final";
  const result = renderDocument({ source: target, formats, stage });
  console.log(JSON.stringify(result, null, 2));
}

function validateCommand() {
  const target = argv.find((a) => !a.startsWith("-")) ?? "demo/essay-on-attentive-reading.md";
  const db = openDb();
  const result = validateMarkdown(db, { path: target });
  console.log(JSON.stringify(result, null, 2));
  if (!result.valid) process.exitCode = 1;
}

function composeCommand() {
  const expr = argv.find((a) => !a.startsWith("-")) ?? "note.insight.major";
  const db = openDb();
  console.log(JSON.stringify(composeIntent(db, { composition: expr }), null, 2));
}

async function migrateCommand() {
  const file = process.env.IASP_DB ?? "data/iasp.db";
  const backup = option("--backup");
  if (backup && existsSync(file)) {
    const old = new Database(file, { readonly: true, fileMustExist: true });
    const version = Number(old.pragma("user_version", { simple: true }));
    if (version < SCHEMA_VERSION) {
      rmSync(backup, { force: true });
      await old.backup(backup);
      console.log(`Copied the store at schema ${version} to ${backup}.`);
    }
    old.close();
  }
  const db = openDb(file);
  console.log(`The store is at schema ${db.pragma("user_version", { simple: true })}.`);
  db.close();
}

async function backupCommand() {
  const dir = option("--dir") ?? "data/backups";
  const keep = Number(option("--keep") ?? 14);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `iasp-${new Date().toISOString().slice(0, 10)}.db`);
  const db = openDb();
  await db.backup(file);
  db.close();
  const old = readdirSync(dir)
    .filter((f) => /^iasp-\d{4}-\d\d-\d\d\.db$/.test(f))
    .sort()
    .slice(0, -keep);
  for (const f of old) rmSync(join(dir, f));
  console.log(`Backed up to ${file}${old.length ? `; removed ${old.length} older` : ""}.`);
}

const commands: Record<string, () => unknown> = {
  serve: serveCommand,
  stdio: () => serveStdio(openDb()),
  terms: termsCommand,
  demo: demoCommand,
  render: renderCommand,
  validate: validateCommand,
  compose: composeCommand,
  migrate: migrateCommand,
  backup: backupCommand,
  status: () => console.log(JSON.stringify(iaspStatus(openDb()), null, 2)),
};

const command = process.argv[2];
if (!command || !commands[command]) {
  console.error(`Usage: iasp-mcp <${Object.keys(commands).join(" | ")}>`);
  process.exitCode = 2;
} else {
  Promise.resolve(commands[command]()).catch((error: Error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
