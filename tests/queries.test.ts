import { describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { composeIntent, getAuthoringGuide, getTerm, iaspStatus, listSets, listTerms } from "../src/queries.js";

describe("iasp vocabulary and composition queries", () => {
  it("loads all 63 terms and 3 profile sets from the iasp scheme", () => {
    const db = openDb(":memory:");
    const status = iaspStatus(db);
    expect(status.counts.total_terms).toBe(63);
    expect(status.counts.active_terms).toBe(63);
    expect(status.counts.delivery_roles).toBe(17);
    expect(status.counts.modifiers).toBe(40);
    expect(status.counts.note_variants).toBe(23);
    expect(status.counts.sets).toBe(3);

    const sets = listSets(db).sets;
    expect(sets.map((s) => s.slug).sort()).toEqual(["core", "delivery-order", "note-variants"]);

    const deliveryOrder = listTerms(db, { set: "delivery-order" }).terms;
    expect(deliveryOrder.length).toBe(12);
    expect(deliveryOrder[0].slug).toBe("front-matter");
    expect(deliveryOrder[deliveryOrder.length - 1].slug).toBe("appendix");
  });

  it("resolves terms by slug, notation, and altLabel", () => {
    const db = openDb(":memory:");
    const insightMajor = getTerm(db, "insight.major");
    expect(insightMajor).toMatchObject({
      slug: "insight-major",
      axis: "modifier",
      group: "exposition-and-support",
    });

    const navByAlt = getTerm(db, "orientation");
    expect(navByAlt).toMatchObject({
      slug: "navigation",
      axis: "modifier",
      group: "reader-navigation",
    });

    const buildMod = getTerm(db, "layout-fullpage");
    expect(buildMod).toMatchObject({
      kind: "build-modifier",
      token: "layout-fullpage",
      category: "pagination",
    });
  });

  it("composes layered intent and warns on non-styled note modifiers or altLabels", () => {
    const db = openDb(":memory:");

    const major = composeIntent(db, { composition: "note.insight.major" });
    expect(major.valid).toBe(true);
    expect(major.delivery_role?.slug).toBe("note");
    expect(major.rendering.kind).toBe("note-variant");
    expect(major.syntax.brace_fence).toContain(".note .insight .major");
    expect(major.syntax.shorthand_fence).toContain("::: note.insight.major");

    const sidebarExample = composeIntent(db, { delivery: "sidebar", modifiers: ["example", "sidebar-block"] });
    expect(sidebarExample.valid).toBe(true);
    expect(sidebarExample.delivery_role?.slug).toBe("sidebar");
    expect(sidebarExample.modifiers.map((m) => m.slug)).toEqual(["example"]);
    expect(sidebarExample.build_modifiers.map((b) => b.token)).toEqual(["sidebar-block"]);

    const unstyledNote = composeIntent(db, { composition: "note.thesis" });
    expect(unstyledNote.valid).toBe(true);
    expect(unstyledNote.warnings.some((w) => w.includes("note-variants"))).toBe(true);

    const orientationNote = composeIntent(db, { composition: "note.orientation" });
    expect(orientationNote.valid).toBe(true);
    expect(orientationNote.warnings.some((w) => w.includes("navigation"))).toBe(true);
  });

  it("serves topic-scoped authoring guides", () => {
    const db = openDb(":memory:");
    const guide = getAuthoringGuide(db, "note-variants");
    expect(guide.topic).toBe("note-variants");
    expect(guide.markdown).toContain("note.insight.major");
    expect(guide.markdown).toContain("note.checklist");
  });
});
