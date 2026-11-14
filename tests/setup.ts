// Keep the suite off the LAN: tests that exercise quote-mcp, holdings-mcp, or corpus-mcp lookups
// point these at local stubs themselves.
process.env.QUOTE_BASE = "off";
process.env.HOLDINGS_BASE = "off";
process.env.CORPUS_BASE = "off";
delete process.env.IASP_URL;
delete process.env.IASP_PUBLIC_URL;
