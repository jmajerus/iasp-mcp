import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { serveHttp } from "../src/server.js";

describe("iasp-mcp Streamable HTTP MCP server and LAN pages", () => {
  const db = openDb(":memory:");
  let server: Awaited<ReturnType<typeof serveHttp>>;
  let baseUrl: string;

  beforeAll(async () => {
    server = await serveHttp(db, { host: "127.0.0.1", port: 0 });
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  });

  it("serves /health, /, /admin, and /demo/ghost", async () => {
    const healthRes = await fetch(`${baseUrl}/health`);
    expect(healthRes.status).toBe(200);
    const health = (await healthRes.json()) as { ok: boolean; scheme: string; counts: { total_terms: number } };
    expect(health.ok).toBe(true);
    expect(health.scheme).toBe("iasp");
    expect(health.counts.total_terms).toBe(63);

    const homeRes = await fetch(`${baseUrl}/`);
    expect(homeRes.status).toBe(200);
    const homeHtml = await homeRes.text();
    expect(homeHtml).toContain("Informative Authoring Semantics Profile");
    expect(homeHtml).toContain("note.insight.major");

    const demoMdRes = await fetch(`${baseUrl}/demo/md`);
    expect(demoMdRes.status).toBe(200);
    const demoMd = await demoMdRes.text();
    expect(demoMd).toContain("> **◈ PRELUDE**");
    expect(demoMd).not.toContain("<div style=");

    const demoGhostRes = await fetch(`${baseUrl}/demo/ghost`);
    expect(demoGhostRes.status).toBe(200);
    const demoGhost = await demoGhostRes.text();
    expect(demoGhost).toContain("Naming What Prose Is Doing");

    // Verify public tunnel requests (with Cloudflare headers and no Access token) can read /demo/* and /interop/*
    const proxiedDemoRes = await fetch(`${baseUrl}/demo/html`, {
      headers: { "cf-ray": "test-ray-id", "cf-connecting-ip": "203.0.113.5" },
    });
    expect(proxiedDemoRes.status).toBe(200);

    const proxiedInteropRes = await fetch(`${baseUrl}/interop/md`, {
      headers: { "cf-ray": "test-ray-id", "cf-connecting-ip": "203.0.113.5" },
    });
    expect(proxiedInteropRes.status).toBe(200);

    // While /mcp and /admin remain protected behind Cloudflare Access (401 without token)
    const proxiedMcpRes = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "cf-ray": "test-ray-id", "cf-connecting-ip": "203.0.113.5" },
    });
    expect(proxiedMcpRes.status).toBe(401);

    const proxiedAdminRes = await fetch(`${baseUrl}/admin`, {
      headers: { "cf-ray": "test-ray-id", "cf-connecting-ip": "203.0.113.5" },
    });
    expect(proxiedAdminRes.status).toBe(401);
  });

  it("exposes all 10 MCP tools over Streamable HTTP /mcp", async () => {
    const client = new Client({ name: "iasp-test-client", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
    await client.connect(transport);

    try {
      const tools = await client.listTools();
      const names = tools.tools.map((t) => t.name).sort();
      expect(names).toEqual([
        "ai_disclosure",
        "compose_intent",
        "get_authoring_guide",
        "get_term",
        "iasp_status",
        "inspect_markdown",
        "list_sets",
        "list_terms",
        "render_document",
        "validate_markdown",
        "wrap_by_directory",
      ]);

      const composeRes = await client.callTool({
        name: "compose_intent",
        arguments: { composition: "sidebar.example" },
      });
      const composeJson = JSON.parse((composeRes.content as { type: string; text: string }[])[0].text) as {
        valid: boolean;
        delivery_role: { slug: string };
      };
      expect(composeJson.valid).toBe(true);
      expect(composeJson.delivery_role.slug).toBe("sidebar");

      const valRes = await client.callTool({
        name: "validate_markdown",
        arguments: { path: "demo/essay-on-attentive-reading.md" },
      });
      const valJson = JSON.parse((valRes.content as { type: string; text: string }[])[0].text) as { valid: boolean };
      expect(valJson.valid).toBe(true);
    } finally {
      await client.close();
    }
  });
});
