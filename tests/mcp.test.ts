import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { renderFileFor, serveHttp } from "../src/server.js";

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
    expect(demoGhost).toContain("An End-to-End Demonstration");
    expect(demoGhost).not.toMatch(/^# Naming What Prose Is Doing/m); // Ghost carries the title in its own field

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

  it("exposes all 9 MCP tools over Streamable HTTP /mcp", async () => {
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
        "inspect_markdown",
        "list_terms",
        "render_document",
        "status",
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

  it("serves renders by URL on the LAN, gives artifacts a url, and refuses escapes and tunnel reads without Access", async () => {
    const previous = { dir: process.env.IASP_RENDER_DIR, pub: process.env.IASP_PUBLIC_URL };
    const renderDir = mkdtempSync(join(tmpdir(), "iasp-served-"));
    process.env.IASP_RENDER_DIR = renderDir;
    process.env.IASP_PUBLIC_URL = "https://iasp.example.test";
    const client = new Client({ name: "iasp-test-client", version: "1.0.0" });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`)));
      const res = await client.callTool({
        name: "render_document",
        arguments: { markdown: "# Served\n\nHello, renders.\n", formats: ["md"], output_dir: "jobs/one", output_basename: "served doc" },
      });
      const out = JSON.parse((res.content as { type: string; text: string }[])[0].text) as {
        artifacts: { url?: string; public_url?: string; content?: string }[];
      };
      const artifact = out.artifacts[0];
      expect(artifact.content).toBeUndefined();
      expect(artifact.url).toBe(`${baseUrl}/renders/jobs/one/served%20doc.md`);
      expect(artifact.public_url).toBe("https://iasp.example.test/renders/jobs/one/served%20doc.md");

      const got = await fetch(artifact.url!);
      expect(got.status).toBe(200);
      expect(got.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
      expect(got.headers.get("content-security-policy")).toBe("sandbox");
      expect(await got.text()).toContain("Hello, renders.");

      writeFileSync(join(renderDir, "page.pdf"), "%PDF-1.4");
      expect((await fetch(`${baseUrl}/renders/page.pdf`)).headers.get("content-type")).toBe("application/pdf");

      // Escapes, hidden temp files, directories, and symlinks out of the directory are refused.
      const outside = mkdtempSync(join(tmpdir(), "iasp-outside-"));
      writeFileSync(join(outside, "secret.txt"), "secret");
      symlinkSync(join(outside, "secret.txt"), join(renderDir, "link.txt"));
      writeFileSync(join(renderDir, ".tmp-x.md"), "temp");
      mkdirSync(join(renderDir, "dir"), { recursive: true });
      for (const path of ["/renders/%2e%2e/etc/passwd", "/renders/..%2f..%2fetc%2fpasswd", "/renders/link.txt", "/renders/.tmp-x.md", "/renders/dir", "/renders/missing.md"]) {
        expect((await fetch(`${baseUrl}${path}`)).status, path).toBe(404);
      }
      expect(renderFileFor("/renders/../../etc/passwd", renderDir)).toBeNull();
      expect(renderFileFor("/renders/page.pdf", renderDir)).toBe(join(renderDir, "page.pdf"));
      rmSync(outside, { recursive: true, force: true });

      // Through the tunnel a render needs a verified Access token.
      const proxied = await fetch(`${baseUrl}/renders/page.pdf`, { headers: { "cf-ray": "r", "cf-connecting-ip": "203.0.113.5" } });
      expect(proxied.status).toBe(401);
    } finally {
      await client.close();
      if (previous.dir === undefined) delete process.env.IASP_RENDER_DIR;
      else process.env.IASP_RENDER_DIR = previous.dir;
      if (previous.pub === undefined) delete process.env.IASP_PUBLIC_URL;
      else process.env.IASP_PUBLIC_URL = previous.pub;
      rmSync(renderDir, { recursive: true, force: true });
    }
  });
});
