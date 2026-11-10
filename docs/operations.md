# Operations

How `iasp-mcp` is run, configured, and deployed.

## Commands

| Command | What it does |
|---|---|
| `npm run serve` | Starts the HTTP server on `IASP_HOST:IASP_PORT` (`0.0.0.0:8000` by default): MCP at `/mcp`, interactive reference and live demos at `/`, admin page at `/admin`, and `/health`. Polls `terminology-mcp` every minute when `IASP_TERMS_SYNC=on`. |
| `npm run iasp -- stdio` | Runs the MCP server over stdio for local IDE clients and tests. |
| `npm run terms` | Syncs the `iasp` concept scheme and its concept sets (`core`, `delivery-order`, `note-variants`) from `terminology-mcp` and reports subscriber progress (`-- --dry-run` previews without writing). |
| `npm run demo` | Builds both bundled demonstrations (`demo/essay-on-attentive-reading.md` and `demo/interoperability-essay.md`) into `build/renders/` across `md`, `ghost`, `html`, `pdf`, and `epub` (with `epubcheck` validation). Pass `-- --source demo` or `-- --source interop` to build one. |
| `npm run iasp -- render <path>` | Renders a Markdown file (`--formats md,html,ghost,pdf,epub`, `--stage final\|draft`). |
| `npm run iasp -- validate <path>` | Validates fenced divs, sidebar heading levels, `.include` targets, and IASP classes. |
| `npm run iasp -- compose <expr>` | Inspects a composed IASP class expression (e.g. `note.insight.major`) from the CLI. |
| `npm run iasp -- migrate` | Brings the SQLite store up to this build's schema (`--backup <file>` saves a pre-migration copy first when the schema version changes). |
| `npm run iasp -- backup` | Creates an online SQLite backup in `data/backups` (or `--dir <path>`), keeping the latest 14 (`--keep 14`). |
| `npm run status` | Queries `/health` on `iasp-mcp.localdomain:8000` and checks git origin lag for the VS Code status bar. |
| `npm run deploy` | Deploys this checkout to `iasp-mcp.localdomain` (see [Deploying](#deploying)). |
| `npm test` | Runs the Vitest suite. |

## Settings

Settings come from `.env` in your local checkout (see [.env.example](../.env.example)) and `/etc/iasp-mcp/env` on the LXC server.

| Setting | Default | What it is |
|---|---|---|
| `IASP_DB` | `data/iasp.db` | Path to the SQLite database (`/var/lib/iasp-mcp/iasp.db` on the server). |
| `IASP_RENDER_DIR` | `build/renders` | Directory where rendered artifacts are written (`/var/lib/iasp-mcp/renders` on the server). |
| `IASP_HOST`, `IASP_PORT` | `0.0.0.0`, `8000` | Address and port for the HTTP listener. |
| `TERMINOLOGY_BASE` | `http://terminology-mcp.localdomain:8000` | `terminology-mcp` endpoint used to follow the `iasp` changelog and resolve external concept URNs; `off` disables network calls and uses the bundled seed. |
| `QUOTE_BASE` | `http://quote-mcp.localdomain:8000` | `quote-mcp` endpoint used during rendering to enrich `<!-- quote <id> -->` markers with `citekey`, `workKey`, `locator`, and `human-work` concepts; `off` disables live lookup. |
| `IASP_TERMS_SYNC` | `on` | When `on`, `serve` polls `terminology-mcp` every 60 seconds and reports subscriber progress as `iasp-mcp`. |
| `ACCESS_TEAM_DOMAIN` | none | Cloudflare Access team URL (e.g. `https://linkbud.cloudflareaccess.com`) used to verify `Cf-Access-Jwt-Assertion` headers on non-LAN requests. |
| `AUTHORING_DEPLOY_PASSWORD` | none | SSH / sudo password for the `authoring` deploy user on `iasp-mcp.localdomain`. |
| `IASP_DEPLOY_HOST` | `authoring@iasp-mcp.localdomain` | Target SSH host for `npm run deploy`. |
| `IASP_STATUS_URL` | `http://iasp-mcp.localdomain:8000` | Server URL queried by `tools/iasp-status.mjs`. |

## The server

`iasp-mcp` runs on a Debian 13 (trixie) Proxmox LXC at `iasp-mcp.localdomain` on port `8000`.

- **Services**: `iasp-mcp.service` (the HTTP/MCP server) and `iasp-backup.timer` (nightly SQLite backup at `03:55`, keeping 14 days in `/var/lib/iasp-mcp/backups`).
- **Files**: The SQLite store (`iasp.db`), rendered demo/output files (`renders/`), backups (`backups/`), and deployment metadata (`deployed.json`) live in `/var/lib/iasp-mcp`. Releases live in `/opt/iasp-mcp/releases/<id>`, with `/opt/iasp-mcp/current` linked to the active release.
- **Access**:
  - Direct LAN requests to `http://iasp-mcp.localdomain:8000` have full access to `/`, `/admin`, `/demo/*`, `/interop/*`, `/health`, and `/mcp`.
  - Requests through the Cloudflare tunnel allow anonymous read-only browsing on `/`, `/favicon.svg`, `/demo/{html,md,ghost,pdf}`, and `/interop/{html,md,ghost,pdf}`.
  - `/mcp` and `/admin` through Cloudflare require a verified `Cf-Access-Jwt-Assertion` JWT.
- **CLI on the server**: Log in as `authoring` and run `iasp-mcp <command>` (e.g. `iasp-mcp status`, `iasp-mcp terms`, `iasp-mcp demo`); it runs `/opt/iasp-mcp/current/dist/cli.js` as the `iasp` user with `/etc/iasp-mcp/env`.

## Deploying

The **Deploy IASP** button in VS Code's status bar (or `npm run deploy` from the terminal) manages the LXC:

| Menu entry | Command | What it does |
|---|---|---|
| Deploy this checkout | `npm run deploy` | Builds, runs `npm test`, uploads a release tarball, installs production dependencies, migrates the store (with pre-migration backup), syncs `iasp` terms, restarts `iasp-mcp.service`, verifies `/health`, and rolls back on failure. |
| Deploy this checkout without tests | `npm run deploy -- --skip-tests` | Same as above, skipping the local test run. |
| Push the server's settings | `npm run deploy -- --env` | Copies `TERMINOLOGY_BASE`, `IASP_TERMS_SYNC`, `ACCESS_TEAM_DOMAIN`, and `IASP_PORT` from `.env` to `/etc/iasp-mcp/env` and restarts. |
| Provision LXC (one-time) | `npm run deploy -- --provision` | Installs Node 22, Pandoc, XeLaTeX (`texlive-xetex`, `texlive-latex-extra`, Pagella/DejaVu/Noto fonts), `qpdf`, `epubcheck`, creates the `iasp` system user, and sets up directories. |

## VS Code status bar

Configured in [.vscode/settings.json](../.vscode/settings.json) using the `spencerwmiles.vscode-task-buttons` and `jmajerus.status-probe` extensions:

| Item | What it shows |
|---|---|
| `$(server) Deploy IASP` | Dropdown task button for deploying, pushing `.env` settings, or provisioning. |
| `$(beaker) Test` | Runs `npm test`. |
| `$(book) main` | Queries `http://iasp-mcp.localdomain:8000/health` and GitHub (`tools/iasp-status.mjs`): shows the deployed branch, `↓N` when behind `origin`, `*` when deployed with uncommitted changes, and `!` if `terminology-mcp` sync is held or in error. Clicking opens `/admin`. |
