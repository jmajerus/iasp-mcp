#!/usr/bin/env node
// Deploys iasp-mcp to its LXC (iasp-mcp.localdomain), on quote-mcp's pattern: SSH as the shared
// `authoring` login, one `sudo -S` call per step with the password piped on stdin, a release
// directory per deploy, a health check, and rollback to the previous release on failure.
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const defaultUser = process.env.IASP_AUTHORING_USER ?? "authoring";
const defaultHost = process.env.IASP_HOST && process.env.IASP_HOST !== "0.0.0.0" ? process.env.IASP_HOST : "iasp-mcp.localdomain";
const HOST = process.env.IASP_DEPLOY_HOST ?? `${defaultUser}@${defaultHost}`;
const ASKPASS = path.join(root, "tools", "askpass.mjs");
const ENV_NAMES = [
  "TERMINOLOGY_BASE",
  "QUOTE_BASE",
  "HOLDINGS_BASE",
  "CORPUS_BASE",
  "IASP_URL",
  "IASP_PUBLIC_URL",
  "IASP_TERMS_SYNC",
  "ACCESS_TEAM_DOMAIN",
  "IASP_PORT",
];

const USAGE = `Usage: npm run deploy -- [--provision | --env] [--skip-tests]

  (no flag)        build, test, install this checkout as a new release, restart, health-check, roll
                   back on failure, and record the branch and commit in /var/lib/iasp-mcp/deployed.json
                   (the server's /health reports it); the first deploy also syncs terms from terminology-mcp
  --provision      one-time setup of the LXC (Node 22, Pandoc, XeLaTeX, qpdf, epubcheck, iasp user, directories)
  --env            copy the server's settings from .env into its /etc/iasp-mcp/env (mode 0640) and
                   restart: ${ENV_NAMES.join(", ")}.
                   Only those set in .env are replaced; the server's others are left as they are
  --skip-tests     deploy without running the test suite first

Needs AUTHORING_DEPLOY_PASSWORD (or IASP_AUTHORING_PASSWORD) in .env.`;

const password = process.env.AUTHORING_DEPLOY_PASSWORD || process.env.IASP_AUTHORING_PASSWORD;
const sshOptions = ["-o", "StrictHostKeyChecking=accept-new", "-o", "ConnectTimeout=10"];

function sshEnv() {
  return {
    ...process.env,
    AUTHORING_DEPLOY_PASSWORD: password,
    SSH_ASKPASS: ASKPASS,
    SSH_ASKPASS_REQUIRE: "force",
    DISPLAY: process.env.DISPLAY || "iasp-deploy",
  };
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/** Runs a bash script as root on the host; resolves with its stdout (also echoed). */
function runAsRoot(script) {
  const encoded = Buffer.from(script).toString("base64");
  const command = `sudo -S -p '' bash -c "$(printf %s '${encoded}' | base64 -d)"`;
  return new Promise((resolve, reject) => {
    const ssh = spawn("ssh", [...sshOptions, HOST, command], { env: sshEnv(), stdio: ["pipe", "pipe", "inherit"] });
    let out = "";
    ssh.stdout.on("data", (chunk) => {
      out += chunk;
      process.stdout.write(chunk);
    });
    ssh.stdin.end(`${password}\n`);
    ssh.on("error", reject);
    ssh.on("exit", (code) => (code === 0 ? resolve(out) : reject(new Error(`${HOST}: remote script exited with ${code}`))));
  });
}

/** Runs the CLI on the server as the iasp user, with the server's environment. */
const asIasp = (args) =>
  `runuser -u iasp -- bash -c 'set -a; . /etc/iasp-mcp/env; set +a; cd /opt/iasp-mcp/current && node dist/cli.js ${args}'`;

async function provision() {
  await runAsRoot(fs.readFileSync(path.join(root, "deploy", "provision.sh"), "utf8"));
  console.log("\nProvisioned. Next: npm run deploy -- --env, then npm run deploy");
}

async function pushEnv() {
  const names = ENV_NAMES.filter((n) => process.env[n]?.trim());
  if (!names.length) throw new Error(`None of ${ENV_NAMES.join(", ")} is set in .env.`);
  console.log(
    `Setting ${names.join(", ")} on the server; leaving ${ENV_NAMES.filter((n) => !names.includes(n)).join(", ") || "nothing else"} as it is.`,
  );
  const lines = names.map((n) => `${n}=${process.env[n].trim()}`).join("\n");
  const encoded = Buffer.from(`${lines}\n`).toString("base64");
  await runAsRoot(`
set -euo pipefail
f=/etc/iasp-mcp/env
grep -v ${names.map((n) => `-e '^${n}='`).join(" ")} "$f" > "$f.new" || true
printf %s ${shellQuote(encoded)} | base64 -d >> "$f.new"
chown root:iasp "$f.new" && chmod 0640 "$f.new" && mv "$f.new" "$f"
cut -d= -f1 "$f" | tr '\\n' ' '; echo
systemctl is-active --quiet iasp-mcp.service || exit 0
systemctl restart iasp-mcp.service
set -a; . "$f"; set +a
for i in $(seq 1 20); do
  if curl -sf -o /dev/null "http://127.0.0.1:$IASP_PORT/health"; then echo "iasp-mcp is back up."; exit 0; fi
  sleep 1
done
journalctl -u iasp-mcp.service -n 20 --no-pager || true
echo "iasp-mcp didn't answer /health within 20 seconds of the restart." >&2
exit 1`);
}

async function deploy({ skipTests }) {
  execFileSync("npm", ["run", "build"], { cwd: root, stdio: "inherit" });
  if (!skipTests) execFileSync("npm", ["test"], { cwd: root, stdio: "inherit" });

  const id = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-");
  const tarball = path.join(os.tmpdir(), `iasp-mcp-${id}.tgz`);
  execFileSync("tar", [
    "czf",
    tarball,
    "-C",
    root,
    "dist",
    "deploy",
    "vocab",
    "assets",
    "demo",
    "package.json",
    "package-lock.json",
  ]);
  execFileSync("scp", [...sshOptions, tarball, `${HOST}:/tmp/`], { env: sshEnv(), stdio: "inherit" });
  fs.rmSync(tarball);

  await runAsRoot(`
set -euo pipefail
release=/opt/iasp-mcp/releases/${id}
mkdir -p "$release"
tar xzf /tmp/iasp-mcp-${id}.tgz -C "$release"
rm -f /tmp/iasp-mcp-${id}.tgz
cd "$release"
npm ci --omit=dev --no-audit --no-fund --loglevel=error
set -a; . /etc/iasp-mcp/env; set +a
previous=$(readlink /opt/iasp-mcp/current || true)
echo "previous=$previous"
fresh_store=""
pre_migrate=/var/lib/iasp-mcp/pre-migrate.db
rm -f "$pre_migrate"
install_units() {
  install -m 0644 "$1/deploy/iasp-mcp.service" "$1/deploy/iasp-backup.service" "$1/deploy/iasp-backup.timer" /etc/systemd/system/ \\
    && install -m 0755 "$1/deploy/iasp-mcp" /usr/local/bin/iasp-mcp \\
    && systemctl daemon-reload
}
rollback() {
  status=$?
  [ "$status" -eq 0 ] && return
  journalctl -u iasp-mcp.service -n 20 --no-pager || true
  if [ -n "$fresh_store" ]; then
    systemctl stop iasp-mcp.service || true
    rm -f "$IASP_DB" "$IASP_DB-wal" "$IASP_DB-shm"
    echo "removed the unfinished first store"
  fi
  if [ -n "$previous" ]; then
    ln -sfn "$previous" /opt/iasp-mcp/current
    units=1
    install_units "$previous" || units=""
    store=1
    if [ -f "$pre_migrate" ]; then
      systemctl stop iasp-mcp.service || true
      if chown iasp:iasp "$pre_migrate" &&
        mv "$IASP_DB" "$IASP_DB.rolled-back" &&
        { [ ! -f "$IASP_DB-wal" ] || mv "$IASP_DB-wal" "$IASP_DB.rolled-back-wal"; } &&
        { [ ! -f "$IASP_DB-shm" ] || mv "$IASP_DB-shm" "$IASP_DB.rolled-back-shm"; } &&
        mv "$pre_migrate" "$IASP_DB"; then
        echo "restored the store from before the migration; the migrated one is $IASP_DB.rolled-back"
      else
        store=""
      fi
    fi
    if [ -z "$store" ]; then
      systemctl stop iasp-backup.timer || true
      echo "rollback_incomplete=$previous: the store couldn't be put back, so iasp-mcp is left stopped"
    elif [ -n "$units" ]; then
      systemctl restart iasp-mcp.service || echo "iasp-mcp didn't restart on $previous"
      echo "rolled_back=$previous"
    else
      echo "rollback_incomplete=$previous: its units couldn't all be put back"
    fi
  fi
  exit "$status"
}
trap rollback EXIT
ln -sfn "$release" /opt/iasp-mcp/current.new && mv -T /opt/iasp-mcp/current.new /opt/iasp-mcp/current
install_units "$release"
if [ ! -f "$IASP_DB" ]; then
  echo "No store yet: syncing initial iasp terms from terminology-mcp."
  fresh_store=1
  ${asIasp("terms")}
else
  ${asIasp("migrate --backup /var/lib/iasp-mcp/pre-migrate.db")}
  ${asIasp("terms")}
fi
systemctl enable --quiet iasp-mcp.service iasp-backup.timer
systemctl start iasp-backup.timer
systemctl restart iasp-mcp.service
for i in $(seq 1 20); do
  if curl -sf "http://127.0.0.1:$IASP_PORT/health"; then echo; echo "installed=${id}"; break; fi
  sleep 1
done
curl -sf -o /dev/null "http://127.0.0.1:$IASP_PORT/health"
trap - EXIT
rm -f "$pre_migrate"
ls -1dt /opt/iasp-mcp/releases/* | tail -n +4 | xargs -r rm -rf || echo "couldn't prune old releases" >&2
`);
  await writeDeployed({
    branch: git(["rev-parse", "--abbrev-ref", "HEAD"]),
    commit: git(["rev-parse", "HEAD"]),
    local: true,
    dirty: git(["status", "--porcelain"]) !== "",
  });
}

function git(args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

const DEPLOYED = "/var/lib/iasp-mcp/deployed.json";

async function writeDeployed(record) {
  const encoded = Buffer.from(JSON.stringify({ ...record, at: new Date().toISOString() })).toString("base64");
  await runAsRoot(
    `printf %s ${shellQuote(encoded)} | base64 -d > ${DEPLOYED}.new && chmod 0644 ${DEPLOYED}.new && mv ${DEPLOYED}.new ${DEPLOYED} && echo`,
  );
}

async function main(argv) {
  if (argv.includes("--help") || argv.includes("-h")) return console.log(USAGE);
  const known = new Set(["--provision", "--env", "--skip-tests"]);
  const unknown = argv.find((a) => !known.has(a));
  if (unknown) throw new Error(`Unknown argument ${unknown}.\n\n${USAGE}`);
  if (!password) throw new Error(`AUTHORING_DEPLOY_PASSWORD is not set.\n\n${USAGE}`);
  if (argv.includes("--provision")) return provision();
  if (argv.includes("--env")) return pushEnv();
  return deploy({ skipTests: argv.includes("--skip-tests") });
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
