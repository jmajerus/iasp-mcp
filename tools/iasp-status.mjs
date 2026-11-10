#!/usr/bin/env node
// Prints what the iasp-mcp server runs, as one JSON line for the vscode-status-probe status-bar
// extension (see .vscode/settings.json): the branch from /health's deploy record, how far it is
// behind that branch on origin, and the terminology-mcp subscriber state.
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BASE = process.env.IASP_STATUS_URL ?? "http://iasp-mcp.localdomain:8000";
const ICON = "$(book)";
const MAX_BRANCH_LABEL = 16;

function print(probe) {
  process.stdout.write(`${JSON.stringify({ open: `${BASE}/admin`, ...probe })}\n`);
}

function escapeMarkdown(value) {
  return String(value ?? "").replace(/[\\`*_{}[\]()#+\-.!|<>]/g, "\\$&");
}

function tooltip(rows, note = "") {
  const table = [
    "| | |",
    "|---|---|",
    ...rows.map(([k, v]) => `| ${escapeMarkdown(k)} | ${escapeMarkdown(v)} |`),
  ].join("\n");
  return `**IASP server**\n\n${table}${note ? `\n\n${note}` : ""}`;
}

function run(command, args) {
  try {
    return execFileSync(command, args, {
      cwd: root,
      encoding: "utf8",
      timeout: 15000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

function remoteHead(ref) {
  return run("git", ["ls-remote", "origin", ref])?.split(/\s/)[0] || null;
}

function behindBy(commit, head) {
  if (commit === head) return 0;
  const count = Number(run("gh", ["api", `repos/{owner}/{repo}/compare/${commit}...${head}`, "--jq", ".ahead_by"]));
  return Number.isInteger(count) ? count : null;
}

function label(deployed) {
  const name = String(deployed.branch).slice(String(deployed.branch).lastIndexOf("/") + 1);
  return name.length > MAX_BRANCH_LABEL ? `${name.slice(0, MAX_BRANCH_LABEL - 1)}…` : name;
}

let health;
try {
  const response = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(10000) });
  health = await response.json();
  if (!health.ok) throw new Error(`HTTP ${response.status}`);
} catch (error) {
  print({
    text: `${ICON} ?`,
    tooltip: tooltip([
      ["Server", BASE],
      ["Problem", `unreachable or unhealthy (${error.message})`],
    ]),
    level: "error",
  });
  process.exit(0);
}

const deployed = health.deployed;
const counts = health.counts ?? {};
const sync = health.terminology_sync ?? {};
const cursor = health.terminology_cursor ?? {};
const rows = [
  ["Version", health.version],
  ["IASP terms", `${counts.active_terms ?? 0} (${counts.delivery_roles ?? 0} delivery, ${counts.modifiers ?? 0} modifiers)`],
  ["Note variants", String(counts.note_variants ?? 0)],
  ["Terminology sync", `${sync.phase ?? "ok"}${cursor.through != null ? ` (through #${cursor.through})` : ""}`],
];

if (!deployed?.commit) {
  print({
    text: `${ICON} ?`,
    level: "warn",
    tooltip: tooltip(
      rows,
      "The server has no deploy record yet. Deploy it once with the Deploy IASP button.",
    ),
  });
  process.exit(0);
}

const marks = [];
let note = "";
const head = remoteHead(`refs/heads/${deployed.branch}`);
const behind = head ? behindBy(deployed.commit, head) : null;
if (behind) marks.push(`↓${behind}`);
if (deployed.dirty) marks.push("*");
if (sync.phase === "error" || sync.phase === "held") marks.push("!");
if (behind) note = "Pull and deploy with the Deploy IASP button to catch up.";
else if (behind == null) {
  note = head
    ? "GitHub doesn't have the deployed commit: push it."
    : `origin has no branch ${deployed.branch}, or can't be reached.`;
}

rows.unshift(
  ["Running", deployed.branch],
  ["Commit", `${deployed.commit.slice(0, 7)}${deployed.dirty ? ", with uncommitted changes" : ""}`],
  ["Behind origin", behind == null ? "unknown" : String(behind)],
  ["Deployed", new Date(deployed.at).toLocaleString()],
);
rows.push(["Checked", new Date().toLocaleTimeString()]);

print({
  text: [`${ICON} ${label(deployed)}`, ...marks].join(" "),
  tooltip: tooltip(rows, note),
  level: behind || note || deployed.dirty || sync.phase === "error" || sync.phase === "held" ? "warn" : "ok",
});
