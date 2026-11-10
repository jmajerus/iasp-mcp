import { openDb } from "./db.js";
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
  const result = renderDocument({
    source: "demo",
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

const commands: Record<string, () => unknown> = {
  serve: serveCommand,
  stdio: () => serveStdio(openDb()),
  terms: termsCommand,
  demo: demoCommand,
  render: renderCommand,
  validate: validateCommand,
  compose: composeCommand,
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
