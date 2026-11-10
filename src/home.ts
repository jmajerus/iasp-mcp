import type { DB } from "./db.js";
import { healthStatus } from "./health.js";
import { composeIntent, iaspStatus, listSets, listTerms } from "./queries.js";
import { NOTE_VARIANT_SPECS } from "./rendering-profile.js";
import type { TermSyncStatus } from "./terminology.js";

const esc = (s: unknown) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

export function homePage(db: DB, params = new URLSearchParams(), showAdmin = true): string {
  const status = iaspStatus(db);
  const deliveryRoles = listTerms(db, { set: "delivery-order" }).terms;
  const extraDelivery = listTerms(db, { axis: "delivery-role", includeGrouping: false }).terms.filter(
    (t) => !deliveryRoles.some((d) => d.id === t.id),
  );
  const modifiers = listTerms(db, { axis: "modifier", includeGrouping: false }).terms;
  const sets = listSets(db).sets;

  const composeQuery = params.get("compose")?.trim() || "note.insight.major";
  let composedHtml = "";
  try {
    const res = composeIntent(db, { composition: composeQuery });
    composedHtml = `
      <div class="compose-result">
        <p><strong>Resolved tokens:</strong> ${res.tokens.map((t) => `<code>.${esc(t)}</code>`).join(" + ")}
        <span class="badge ${res.valid ? "up" : "problem"}">${res.valid ? "Valid IASP composition" : "Contains unknown tokens"}</span></p>
        <p>${esc(res.intent_summary)}</p>
        ${res.warnings.length ? `<div class="warning">${res.warnings.map((w) => `<p>${esc(w)}</p>`).join("")}</div>` : ""}
        <div class="syntax-grid">
          <div><strong>Brace fence (canonical)</strong><pre><code>${esc(res.syntax.brace_fence)}</code></pre></div>
          ${res.syntax.shorthand_fence ? `<div><strong>Shorthand fence</strong><pre><code>${esc(res.syntax.shorthand_fence)}</code></pre></div>` : ""}
          <div><strong>Heading attribute</strong><pre><code>${esc(res.syntax.heading_attribute)}</code></pre></div>
        </div>
        <dl class="fields">
          <div><dt>EPUB / HTML</dt><dd><code>${esc(res.rendering.epub_html)}</code></dd></div>
          <div><dt>XeLaTeX PDF</dt><dd><code>${esc(res.rendering.pdf_latex)}</code></dd></div>
          <div><dt>Ghost Markdown</dt><dd>${esc(res.rendering.ghost_markdown)}</dd></div>
        </dl>
      </div>`;
  } catch (error) {
    composedHtml = `<p class="problem">${esc((error as Error).message)}</p>`;
  }

  const variantCards = Object.values(NOTE_VARIANT_SPECS)
    .filter((v, idx, arr) => arr.findIndex((x) => x.notation === v.notation) === idx)
    .map((v) => {
      const s = v.ghost;
      return `<div class="variant-card" style="background:${esc(s.bg)};border-left:4px solid ${esc(s.border)}">
        <div class="variant-header">
          ${
            s.glyphOnly
              ? `<span class="variant-glyph">${esc(s.glyph)}</span>`
              : `<span class="variant-badge" style="background:${esc(s.badgeBg)};color:${esc(s.badgeFg)}">${esc(s.glyph)} ${esc(s.label)}</span>`
          }
          <code>::: note.${esc(v.notation)}</code>
        </div>
        <div class="s">LaTeX: <code>${esc(v.latexEnv)}</code> · ${esc(v.headerTreatment)}</div>
      </div>`;
    })
    .join("");

  return page(
    false,
    `
    <div class="stats">
      <div class="stat"><strong>${status.counts.active_terms}</strong><span class="s">Active IASP terms</span></div>
      <div class="stat"><strong>${status.counts.delivery_roles}</strong><span class="s">Axis A delivery roles</span></div>
      <div class="stat"><strong>${status.counts.modifiers}</strong><span class="s">Axis B modifiers</span></div>
      <div class="stat"><strong>${status.counts.note_variants}</strong><span class="s">Styled note variants</span></div>
    </div>

    <section id="demo">
      <h2>End-to-End Demonstrations</h2>
      <p><strong>1. IASP Core Showcase (<code>demo/essay-on-attentive-reading.md</code>):</strong> Exercises Axis A delivery roles, Axis B compositions, <code>.include</code> fragment splicing, <code>{{meta:version}}</code> placeholders, stage guards, and AI disclosure sidecars.</p>
      <div class="demo-links">
        <a class="btn" href="/demo/html" target="_blank" rel="noopener">Open Rendered HTML Essay →</a>
        <a class="btn secondary" href="/demo/md" target="_blank" rel="noopener">View Clean Markdown (no HTML tags)</a>
        <a class="btn secondary" href="/demo/ghost" target="_blank" rel="noopener">View Ghost CMS Markdown</a>
        <a class="btn secondary" href="/demo/pdf" target="_blank" rel="noopener">Build &amp; Open Screen PDF</a>
      </div>
      <p style="margin-top:20px"><strong>2. Six-Server Authoring Interoperability Demo (<code>demo/interoperability-essay.md</code>):</strong> Co-authored across <code>terminology-mcp</code>, <code>holdings-mcp</code>, <code>corpus-mcp</code>, <code>quote-mcp</code>, <code>zotero-mcp</code>, and <code>iasp-mcp</code> with verified Calibre quotes (<code>&lt;!-- quote &lt;id&gt; --&gt;</code>), BetterBibTeX <code>--citeproc</code> citations, and compositional IASP wrappers.</p>
      <div class="demo-links">
        <a class="btn" href="/interop/html" target="_blank" rel="noopener">Open Interop HTML (with Citeproc) →</a>
        <a class="btn secondary" href="/interop/md" target="_blank" rel="noopener">View Clean Markdown</a>
        <a class="btn secondary" href="/interop/ghost" target="_blank" rel="noopener">View Ghost CMS Markdown</a>
        <a class="btn secondary" href="/interop/pdf" target="_blank" rel="noopener">Build &amp; Open Interop PDF</a>
      </div>
    </section>

    <section id="compose">
      <h2>Compose Layered Intent (<code>delivery.modifier</code>)</h2>
      <p class="s">Test any combination of Axis A delivery roles, Axis B modifiers, and build hints (e.g. <code>note.insight.major</code>, <code>sidebar.example</code>, <code>bridge.reflection.pre-pagebreak</code>).</p>
      <form method="get" action="/#compose" class="search">
        <label>Composition expression
          <input name="compose" value="${esc(composeQuery)}" placeholder="e.g. note.insight.major or sidebar.example">
        </label>
        <button type="submit">Inspect Composition</button>
      </form>
      ${composedHtml}
    </section>

    <section id="note-variants">
      <h2>Note Variants Palette (<code>note.&lt;variant&gt;</code>)</h2>
      <p class="s">Each variant in the <code>note-variants</code> profile set renders with its own box environment in XeLaTeX, CSS custom properties in EPUB/HTML, and inline-styled HTML card in Ghost.</p>
      <div class="variant-grid">${variantCards}</div>
    </section>

    <section id="axis-a">
      <h2>Axis A — Delivery Roles</h2>
      <p class="s">How a passage relates to the surrounding narrative flow. Listed in <code>delivery-order</code> reading order, followed by build extensions.</p>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Slug / Notation</th><th>Role</th><th>Scope Note</th><th>Set</th></tr></thead>
          <tbody>
            ${[...deliveryRoles, ...extraDelivery]
              .map(
                (t) => `<tr>
              <td><code>${esc(t.notations.join(", ") || t.slug)}</code></td>
              <td><strong>${esc(t.label)}</strong></td>
              <td>${esc(t.scope_note ?? "")}</td>
              <td>${t.sets.map((s) => `<span class="badge">${esc(s)}</span>`).join(" ")}</td>
            </tr>`,
              )
              .join("")}
          </tbody>
        </table>
      </div>
    </section>

    <section id="axis-b">
      <h2>Axis B — Modifiers</h2>
      <p class="s">What kind of rhetorical, expository, stance-signaling, or navigational work a passage is doing.</p>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Notation</th><th>Group</th><th>Scope Note</th><th>Sets</th></tr></thead>
          <tbody>
            ${modifiers
              .map(
                (t) => `<tr>
              <td><code>${esc(t.notations.join(", ") || t.slug)}</code></td>
              <td><span class="badge">${esc(t.group ?? "")}</span></td>
              <td>${esc(t.scope_note ?? "")}</td>
              <td>${t.sets.map((s) => `<span class="badge">${esc(s)}</span>`).join(" ")}</td>
            </tr>`,
              )
              .join("")}
          </tbody>
        </table>
      </div>
    </section>

    <section id="sets">
      <h2>Profile Concept Sets (from <code>terminology-mcp</code>)</h2>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Set</th><th>Ordered</th><th>Members</th><th>Description</th></tr></thead>
          <tbody>
            ${sets
              .map(
                (s) => `<tr>
              <td><code>${esc(s.slug)}</code><br><strong>${esc(s.label)}</strong></td>
              <td>${s.ordered ? "Yes" : "No"}</td>
              <td>${s.member_count}</td>
              <td>${esc(s.description ?? "")}</td>
            </tr>`,
              )
              .join("")}
          </tbody>
        </table>
      </div>
    </section>
  `,
    showAdmin,
  );
}

export function adminPage(db: DB, termSync?: () => TermSyncStatus, env: NodeJS.ProcessEnv = process.env): string {
  const health = healthStatus(db, termSync, env);
  const sync = health.terminology_sync;
  const cursor = health.terminology_cursor;
  const tc = health.toolchain;

  return page(
    true,
    `
    <section id="terminology">
      <h2>Terminology Subscriber (<code>scheme = "iasp"</code>)</h2>
      <p class="s">Follows <code>http://terminology-mcp.localdomain:8000</code> and reports subscriber progress as <code>iasp-mcp</code>.</p>
      <dl class="fields">
        <div><dt>Subscriber phase</dt><dd><span class="badge ${sync?.phase === "ok" ? "up" : sync?.phase === "error" || sync?.phase === "held" ? "problem" : ""}">${esc(sync?.phase ?? "idle")}</span></dd></div>
        <div><dt>Changelog ID</dt><dd><code>${esc(cursor?.log ?? "not yet synced (using bundled seed)")}</code></dd></div>
        <div><dt>Applied through</dt><dd>${cursor?.through ?? "—"}${sync?.head ? ` (head: ${sync.head})` : ""}</dd></div>
        ${sync?.error ? `<div><dt>Last sync message</dt><dd class="problem">${esc(sync.error)}</dd></div>` : ""}
      </dl>
    </section>

    <section id="toolchain">
      <h2>Local Rendering Toolchain</h2>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Tool</th><th>Status</th><th>Version</th></tr></thead>
          <tbody>
            ${Object.entries(tc)
              .map(
                ([name, info]) => `<tr>
              <td><code>${esc(name)}</code></td>
              <td><span class="badge ${info.available ? "up" : "warning"}">${info.available ? "Available" : "Missing"}</span></td>
              <td class="s">${esc(info.version ?? "—")}</td>
            </tr>`,
              )
              .join("")}
          </tbody>
        </table>
      </div>
    </section>
  `,
    true,
  );
}

function page(admin: boolean, content: string, showAdmin = true): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>IASP · ${admin ? "Admin" : "Authoring Semantics Profile"}</title><link rel="icon" type="image/svg+xml" href="/favicon.svg">
<style>
:root{color-scheme:light dark;--bg:#f4f6f8;--panel:#fff;--text:#202b38;--line:#dce2e8;--mut:#526273;--link:#312e81;--up:#21633e;--warn:#805500;--bad:#ad2525}
*{box-sizing:border-box}body{font:15px/1.6 system-ui,sans-serif;color:var(--text);background:var(--bg);max-width:78rem;margin:auto;padding:32px 24px}a{color:var(--link);text-underline-offset:3px}h1{font-size:2.1rem;letter-spacing:-.03em;margin:0}h2{font-size:1.25rem;margin:0 0 12px}p{margin:8px 0 16px}header{margin-bottom:24px}nav{display:flex;flex-wrap:wrap;gap:18px;margin-top:10px}section{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:24px;margin:20px 0}.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}.stat{padding:18px;background:var(--panel);border:1px solid var(--line);border-radius:10px}.stat strong{display:block;font-size:1.8rem;line-height:1.3}.s{color:var(--mut);font-size:.88rem}.up{color:var(--up)}.warning{color:var(--warn)}.problem{color:var(--bad)}.badge{display:inline-block;font-size:.78rem;font-weight:600;border:1px solid var(--line);border-radius:5px;padding:2px 7px;margin:2px 0}.search{display:flex;flex-wrap:wrap;align-items:end;gap:12px}.search label{flex:1 1 260px;font-size:.88rem;font-weight:600}input,button{font:inherit;border:1px solid var(--line);border-radius:6px;padding:9px 12px}input{display:block;width:100%;margin-top:5px;color:var(--text);background:var(--panel)}button,.btn{background:var(--link);color:#fff;cursor:pointer;text-decoration:none;display:inline-block;padding:9px 14px;border-radius:6px;font-weight:600}.btn.secondary{background:var(--panel);color:var(--link);border:1px solid var(--line)}.demo-links{display:flex;flex-wrap:wrap;gap:10px;margin-top:12px}.syntax-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;margin:12px 0}pre{background:var(--bg);padding:10px 12px;border-radius:6px;overflow-x:auto;margin:6px 0}code{font-size:.85rem}.variant-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:12px}.variant-card{padding:12px 14px;border-radius:0 8px 8px 0;color:#1f2937}.variant-header{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px}.variant-badge{font-size:.7rem;font-weight:700;padding:2px 8px;border-radius:4px;letter-spacing:.06em}.variant-glyph{font-size:1.1rem}.fields>div{display:grid;grid-template-columns:minmax(150px,1fr) minmax(0,3fr);gap:14px;padding:8px 0;border-bottom:1px solid var(--line)}dt{font-weight:600}dd{margin:0}.table-wrap{overflow-x:auto}table{border-collapse:collapse;width:100%;text-align:left}th,td{vertical-align:top;padding:10px 12px 10px 0;border-bottom:1px solid var(--line)}th{font-weight:600}
@media(prefers-color-scheme:dark){:root{--bg:#151c24;--panel:#1d2732;--text:#e1e8ef;--line:#394858;--mut:#adbbc9;--link:#a5b4fc;--up:#8ed4a6;--warn:#e3c277;--bad:#ffa5a5}button,.btn{color:#151c24}}
</style></head><body>
<header>
  <h1>Informative Authoring Semantics Profile${admin ? " · Admin" : ""}</h1>
  <p class="s">Compositional authoring vocabulary (synced from <code>terminology-mcp</code>) and Pandoc / Ghost rendering pipeline.</p>
  <nav aria-label="Main navigation">
    <a href="/"${admin ? "" : ' aria-current="page"'}>Profile &amp; Demo</a>
    <a href="/#compose">Compose Intent</a>
    <a href="/#note-variants">Note Variants</a>
    <a href="/#axis-a">Axis A (Delivery)</a>
    <a href="/#axis-b">Axis B (Modifiers)</a>
    ${showAdmin ? `<a href="/admin"${admin ? ' aria-current="page"' : ""}>Admin</a>` : ""}
  </nav>
</header>
<main>${content}</main></body></html>`;
}
