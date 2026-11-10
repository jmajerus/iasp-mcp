import { readFileSync } from "node:fs";
import http from "node:http";
import { resolve } from "node:path";
import type { JWTVerifyGetKey } from "jose";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { type DB, PROJECT_ROOT } from "./db.js";
import { FAVICON } from "./favicon.js";
import { healthStatus } from "./health.js";
import { adminPage, homePage } from "./home.js";
import { AccessError, authorizeRequest, requestAccessConfig, type RequestAccessConfig } from "./http-access.js";
import { VERSION, createServer } from "./mcp.js";
import { renderDocument } from "./render.js";
import type { TermSyncStatus } from "./terminology.js";

export interface ServeOptions {
  access?: RequestAccessConfig;
  accessKeys?: JWTVerifyGetKey;
  host: string;
  port: number;
  termSync?: () => TermSyncStatus;
}

export function serveHttp(db: DB, options: ServeOptions): Promise<http.Server> {
  const access = options.access ?? requestAccessConfig(process.env, ["iasp-mcp", "iasp-mcp.localdomain"]);
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      const { via } = await authorizeRequest(req, url.pathname, access, options.accessKeys);
      const rootMcp =
        url.pathname === "/" &&
        via === "access" &&
        (req.method === "POST" ||
          req.method === "OPTIONS" ||
          (req.method === "GET" && (req.headers.accept ?? "").includes("text/event-stream")));

      if (url.pathname === "/favicon.svg") {
        if (req.method !== "GET" && req.method !== "HEAD") {
          return void res.writeHead(405, { allow: "GET, HEAD" }).end();
        }
        return void res
          .writeHead(200, {
            "content-type": "image/svg+xml; charset=utf-8",
            "cache-control": "public, max-age=86400",
            "x-content-type-options": "nosniff",
          })
          .end(req.method === "HEAD" ? undefined : FAVICON);
      }

      if (url.pathname === "/health") {
        res
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify(healthStatus(db, options.termSync)));
        return;
      }

      if ((url.pathname === "/" && !rootMcp) || (url.pathname === "/admin" && (via === "lan" || via === "access"))) {
        if (req.method !== "GET") return void res.writeHead(405, { allow: "GET" }).end();
        const html =
          url.pathname === "/admin"
            ? adminPage(db, options.termSync)
            : homePage(db, url.searchParams, via === "lan" || via === "access");
        return void res
          .writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" })
          .end(html);
      }

      const demoMatch = /^\/(demo|interop)\/(html|md|ghost|pdf)$/.exec(url.pathname);
      if (demoMatch) {
        if (req.method !== "GET") return void res.writeHead(405, { allow: "GET" }).end();
        const source = demoMatch[1] === "interop" ? "interop" : "demo";
        const fmt = demoMatch[2] as "html" | "md" | "ghost" | "pdf";
        const rendered = await renderDocument({
          source,
          formats: [fmt],
          returnContent: fmt !== "pdf",
        });
        const artifact = rendered.artifacts[0];
        if (fmt === "html") {
          return void res
            .writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" })
            .end(artifact.content);
        }
        if (fmt === "md" || fmt === "ghost") {
          return void res
            .writeHead(200, { "content-type": "text/markdown; charset=utf-8", "cache-control": "no-store" })
            .end(artifact.content);
        }
        const pdfPath = resolve(PROJECT_ROOT, artifact.output_path);
        const pdfBytes = readFileSync(pdfPath);
        return void res
          .writeHead(200, {
            "content-type": "application/pdf",
            "content-disposition": `inline; filename="${source === "interop" ? "interoperability-essay.pdf" : "essay-on-attentive-reading.pdf"}"`,
            "cache-control": "no-store",
          })
          .end(pdfBytes);
      }

      if (url.pathname !== "/mcp" && !rootMcp) {
        res.writeHead(404).end();
        return;
      }
      if (req.method === "OPTIONS") {
        res.writeHead(204).end();
        return;
      }
      if (req.method !== "POST") {
        res
          .writeHead(405, { allow: "POST, OPTIONS", "content-type": "application/json" })
          .end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null }));
        return;
      }

      const mcp = createServer(db);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => {
        void transport.close();
        void mcp.close();
      });
      await mcp.connect(transport);
      await transport.handleRequest(req, res);
    } catch (error) {
      if (error instanceof AccessError) {
        if (!res.headersSent) {
          res
            .writeHead(error.status, { "content-type": "application/json", "cache-control": "no-store" })
            .end(JSON.stringify({ error: error.message }));
        }
        return;
      }
      console.error(error);
      if (!res.headersSent) res.writeHead(500).end();
    }
  });

  return new Promise((resolveServer) =>
    server.listen(options.port, options.host, () => {
      const a = server.address();
      console.error(
        `iasp-mcp ${VERSION} listening on ${typeof a === "object" && a ? `${a.address}:${a.port}` : options.port} (/mcp, /health, /)`,
      );
      resolveServer(server);
    }),
  );
}

export async function serveStdio(db: DB): Promise<void> {
  await createServer(db).connect(new StdioServerTransport());
}
