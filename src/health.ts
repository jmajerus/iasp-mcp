import fs from "node:fs";
import path from "node:path";
import type { DB } from "./db.js";
import { VERSION } from "./mcp.js";
import { iaspStatus } from "./queries.js";
import { detectToolchain } from "./render.js";
import type { TermSyncStatus } from "./terminology.js";

export function healthStatus(db: DB, termSync?: () => TermSyncStatus, env: NodeJS.ProcessEnv = process.env) {
  let deployed: unknown = null;
  try {
    deployed = JSON.parse(
      fs.readFileSync(path.join(path.dirname(env.IASP_DB ?? "data/iasp.db"), "deployed.json"), "utf8"),
    );
  } catch {
    /* No deployment record on a fresh installation. */
  }
  const status = iaspStatus(db);
  const toolchain = detectToolchain();
  return {
    ok: true,
    version: VERSION,
    scheme: status.scheme,
    counts: status.counts,
    terminology_cursor: status.terminology_cursor,
    ...(termSync ? { terminology_sync: termSync() } : {}),
    toolchain,
    deployed,
  };
}
