import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, relative, resolve } from "node:path";
import { PROJECT_ROOT } from "./db.js";
import { type AiDisclosureMetadata, extractFrontmatter, renderCleanMarkdown, renderGhostMarkdown } from "./ghost.js";
import { ToolError } from "./queries.js";

export const DEMO_ARTICLE_PATH = resolve(PROJECT_ROOT, "demo/essay-on-attentive-reading.md");
export const ASSETS_DIR = resolve(PROJECT_ROOT, "assets");
export const LUA_SEMANTICS_FILTER = resolve(ASSETS_DIR, "lua/iasp-semantics.lua");
export const LUA_TITLE_FILTER = resolve(ASSETS_DIR, "lua/title_from_first_heading.lua");
export const LUA_RUNNING_HEADERS_FILTER = resolve(ASSETS_DIR, "lua/running_headers.lua");
export const CSS_SHARED = resolve(ASSETS_DIR, "styles/styles-shared.css");
export const CSS_HTML = resolve(ASSETS_DIR, "styles/styles.css");
export const CSS_EPUB = resolve(ASSETS_DIR, "styles/styles-epub.css");
export const LATEX_DIR = resolve(ASSETS_DIR, "latex");
export const PDF_HEADER = resolve(LATEX_DIR, "pdf-header.tex");
export const BOX_BLOCKQUOTE = resolve(LATEX_DIR, "box-blockquote.tex");

export const RENDER_FORMATS = ["md", "ghost", "html", "pdf", "pdf-print", "epub", "docx", "rtf"] as const;
export type RenderFormat = (typeof RENDER_FORMATS)[number];

export interface ToolchainStatus {
  pandoc: { available: boolean; version?: string };
  xelatex: { available: boolean; version?: string };
  qpdf: { available: boolean; version?: string };
  epubcheck: { available: boolean; version?: string };
}

let cachedToolchain: ToolchainStatus | null = null;

function runEpubcheck(args: string[], timeout = 30_000) {
  const jarPath = "/usr/share/java/epubcheck.jar";
  if (existsSync(jarPath)) {
    return spawnSync("java", ["-jar", jarPath, ...args], { encoding: "utf8", timeout });
  }
  return spawnSync("epubcheck", args, { encoding: "utf8", timeout });
}

export function detectToolchain(force = false): ToolchainStatus {
  if (cachedToolchain && !force) return cachedToolchain;
  const probe = (cmd: string, args = ["--version"]): { available: boolean; version?: string } => {
    const res = spawnSync(cmd, args, { encoding: "utf8", timeout: 5000 });
    if (res.error || res.status !== 0) return { available: false };
    const firstLine = (res.stdout || res.stderr || "").split(/\r?\n/).find((l) => l.trim().length > 0)?.trim();
    return { available: true, ...(firstLine ? { version: firstLine } : {}) };
  };
  const probeEpubcheck = (): { available: boolean; version?: string } => {
    const res = runEpubcheck(["--version"], 5000);
    if (res.error) return { available: false };
    const out = (res.stdout || res.stderr || "").trim();
    if (!out || out.includes("not found")) return { available: false };
    const firstLine = out.split(/\r?\n/).find((l) => l.trim().length > 0)?.trim();
    return { available: true, ...(firstLine ? { version: firstLine } : {}) };
  };
  cachedToolchain = {
    pandoc: probe("pandoc"),
    xelatex: probe("xelatex"),
    qpdf: probe("qpdf"),
    epubcheck: probeEpubcheck(),
  };
  return cachedToolchain;
}

export interface RenderDocumentOptions {
  source?: string;
  markdown?: string;
  title?: string;
  formats?: RenderFormat[];
  outputDir?: string;
  outputBasename?: string;
  stage?: "final" | "draft";
  bibliography?: string;
  bibtexContent?: string;
  csl?: string;
  aiMetadata?: AiDisclosureMetadata;
  optimizePdf?: boolean;
  validateEpub?: boolean;
  returnContent?: boolean;
  rootDir?: string;
}

export interface RenderedArtifact {
  format: RenderFormat;
  output_path: string;
  bytes: number;
  warnings: string[];
  linearized?: boolean;
  epubcheck_passed?: boolean;
  content?: string;
}

const PANDOC_READER = "markdown+citations+fancy_lists+fenced_divs+header_attributes+link_attributes+smart";

export function renderDocument(options: RenderDocumentOptions = {}) {
  const rootDir = options.rootDir ?? PROJECT_ROOT;
  const formats: RenderFormat[] = options.formats?.length ? options.formats : ["md", "html", "ghost"];
  const stage = options.stage ?? "final";
  const defaultOutDir = process.env.IASP_RENDER_DIR ?? "build/renders";
  const outDir = resolve(rootDir, options.outputDir ?? defaultOutDir);
  mkdirSync(outDir, { recursive: true });

  let inputPath: string;
  let tempInputPath: string | null = null;
  let tempBibPath: string | null = null;
  let rawMarkdown: string;
  let aiMetadata: AiDisclosureMetadata | undefined = options.aiMetadata;

  if (options.markdown !== undefined) {
    rawMarkdown = options.markdown;
    const stem = options.outputBasename ?? "inline-document";
    tempInputPath = resolve(outDir, `.tmp-${stem}-${process.pid}.md`);
    writeFileSync(tempInputPath, rawMarkdown, "utf8");
    inputPath = tempInputPath;
  } else {
    const srcSpec = options.source?.trim() || "demo";
    inputPath =
      srcSpec === "demo"
        ? DEMO_ARTICLE_PATH
        : srcSpec === "interop" || srcSpec === "interoperability"
          ? resolve(rootDir, "demo/interoperability-essay.md")
          : resolve(rootDir, srcSpec);
    if (!existsSync(inputPath)) {
      throw new ToolError(`Source file not found: ${srcSpec}`);
    }
    rawMarkdown = readFileSync(inputPath, "utf8");
    const sidecarPath = inputPath.replace(/\.(md|markdown)$/i, ".ai.json");
    if (!aiMetadata && existsSync(sidecarPath)) {
      try {
        aiMetadata = JSON.parse(readFileSync(sidecarPath, "utf8")) as AiDisclosureMetadata;
      } catch {
        aiMetadata = undefined;
      }
    }
  }

  if (options.bibtexContent?.trim()) {
    const cleanedBib = options.bibtexContent
      .trim()
      .replace(/^#.*?\n+/m, "")
      .replace(/^```(?:bibtex)?\s*\n?/i, "")
      .replace(/\n?```\s*$/i, "");
    tempBibPath = resolve(outDir, `.tmp-refs-${process.pid}.bib`);
    writeFileSync(tempBibPath, `${cleanedBib}\n`, "utf8");
  }

  const { frontmatter } = extractFrontmatter(rawMarkdown);
  const baseStem =
    options.outputBasename ??
    basename(inputPath, extname(inputPath))
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  const docTitle = options.title ?? frontmatter.title ?? baseStem;
  const docLang = frontmatter.lang ?? "en";

  const toolchain = detectToolchain();
  const artifacts: RenderedArtifact[] = [];

  try {
    for (const format of formats) {
      if (format === "md") {
        const mdContent = renderCleanMarkdown(rawMarkdown, {
          rootDir,
          baseDir: dirname(inputPath),
          stage,
          aiMetadata,
        });
        const outPath = resolve(outDir, `${baseStem}.md`);
        writeFileSync(outPath, mdContent, "utf8");
        const displayPath = relative(rootDir, outPath);
        const cleanOutputPath = displayPath.startsWith("..") ? outPath : displayPath || outPath;
        artifacts.push({
          format: "md",
          output_path: cleanOutputPath,
          bytes: Buffer.byteLength(mdContent, "utf8"),
          warnings: [],
          ...(options.returnContent ? { content: mdContent } : {}),
        });
        continue;
      }

      if (format === "ghost") {
        const ghostContent = renderGhostMarkdown(rawMarkdown, {
          rootDir,
          baseDir: dirname(inputPath),
          stage,
          aiMetadata,
        });
        const outPath = resolve(outDir, `${baseStem}-ghost.md`);
        writeFileSync(outPath, ghostContent, "utf8");
        const displayPath = relative(rootDir, outPath);
        const cleanOutputPath = displayPath.startsWith("..") ? outPath : displayPath || outPath;
        artifacts.push({
          format: "ghost",
          output_path: cleanOutputPath,
          bytes: Buffer.byteLength(ghostContent, "utf8"),
          warnings: [],
          ...(options.returnContent ? { content: ghostContent } : {}),
        });
        continue;
      }

      if (!toolchain.pandoc.available) {
        throw new ToolError(`Pandoc is required to render '${format}', but 'pandoc' was not found on PATH.`);
      }

      const extMap: Record<Exclude<RenderFormat, "ghost" | "md">, string> = {
        html: `${baseStem}.html`,
        pdf: `${baseStem}.pdf`,
        "pdf-print": `${baseStem}-print.pdf`,
        epub: `${baseStem}.epub`,
        docx: `${baseStem}.docx`,
        rtf: `${baseStem}.rtf`,
      };
      const outPath = resolve(outDir, extMap[format]);

      const args: string[] = [
        inputPath,
        "-f",
        PANDOC_READER,
        `--lua-filter=${LUA_SEMANTICS_FILTER}`,
        `--lua-filter=${LUA_TITLE_FILTER}`,
        `--lua-filter=${LUA_RUNNING_HEADERS_FILTER}`,
        "-M",
        `build-stage=${stage}`,
        "-M",
        `lang=${docLang}`,
        "-M",
        `title=${docTitle}`,
      ];

      if (tempBibPath) {
        args.push("--citeproc", `--bibliography=${tempBibPath}`);
      } else if (options.bibliography) {
        const bibPath = resolve(rootDir, options.bibliography);
        if (!existsSync(bibPath)) throw new ToolError(`Bibliography file not found: ${options.bibliography}`);
        args.push("--citeproc", `--bibliography=${bibPath}`);
      } else if (frontmatter.bibliography) {
        const bibRel = resolve(dirname(inputPath), frontmatter.bibliography);
        const bibRoot = resolve(rootDir, frontmatter.bibliography);
        const bibDemo = resolve(rootDir, "demo", frontmatter.bibliography);
        const resolvedBib = existsSync(bibRel)
          ? bibRel
          : existsSync(bibRoot)
            ? bibRoot
            : existsSync(bibDemo)
              ? bibDemo
              : null;
        if (resolvedBib) args.push("--citeproc", `--bibliography=${resolvedBib}`);
      }
      if (options.csl) {
        const cslPath = resolve(rootDir, options.csl);
        if (!existsSync(cslPath)) throw new ToolError(`CSL file not found: ${options.csl}`);
        args.push(`--csl=${cslPath}`);
      } else if (frontmatter["link-citations"] === "true") {
        args.push("-M", "link-citations=true");
      }

      let tempLatexOverride: string | null = null;

      if (format === "html") {
        args.push("-s", "--embed-resources", `--css=${CSS_SHARED}`, `--css=${CSS_HTML}`, "-o", outPath);
      } else if (format === "epub") {
        args.push("--toc", `--css=${CSS_SHARED}`, `--css=${CSS_EPUB}`, "-o", outPath);
      } else if (format === "docx" || format === "rtf") {
        args.push("-s", "-o", outPath);
      } else if (format === "pdf" || format === "pdf-print") {
        if (!toolchain.xelatex.available) {
          throw new ToolError(`XeLaTeX is required to render '${format}', but 'xelatex' was not found on PATH.`);
        }
        const isPrint = format === "pdf-print";
        tempLatexOverride = resolve(outDir, `.tmp-latex-override-${process.pid}.tex`);
        const latexDirForward = LATEX_DIR.replace(/\\/g, "/");
        writeFileSync(
          tempLatexOverride,
          [
            `\\def\\IaspLatexDir{${latexDirForward}}`,
            `\\def\\pdfmode{${isPrint ? "print" : "screen"}}`,
            "",
          ].join("\n"),
          "utf8",
        );
        const geometry = isPrint
          ? "paperwidth=6.69in,paperheight=9.61in,inner=0.625in,outer=0.5in,top=0.75in,bottom=0.625in,twoside=true"
          : "paperwidth=6in,paperheight=9in,margin=0.85in,twoside=false";
        args.push(
          "--pdf-engine=xelatex",
          `-V`,
          `geometry:${geometry}`,
          `--include-in-header=${tempLatexOverride}`,
          `--include-in-header=${PDF_HEADER}`,
          `--include-in-header=${BOX_BLOCKQUOTE}`,
          "-o",
          outPath,
        );
      }

      try {
        const res = spawnSync("pandoc", args, {
          cwd: rootDir,
          encoding: "utf8",
          timeout: 120_000,
        });
        if (res.error || res.status !== 0) {
          const detail = (res.stderr || res.stdout || res.error?.message || "Unknown pandoc failure").trim();
          throw new ToolError(`Pandoc failed rendering '${format}': ${detail}`);
        }
        const warnings = (res.stderr || "")
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter(Boolean);

        let linearized = false;
        if ((format === "pdf" || format === "pdf-print") && (options.optimizePdf ?? true) && toolchain.qpdf.available) {
          const optTmp = `${outPath}.opt.pdf`;
          const qres = spawnSync("qpdf", ["--linearize", outPath, optTmp], { encoding: "utf8", timeout: 30_000 });
          if (qres.status === 0 && existsSync(optTmp)) {
            writeFileSync(outPath, readFileSync(optTmp));
            rmSync(optTmp, { force: true });
            linearized = true;
          } else {
            rmSync(optTmp, { force: true });
          }
        }

        let epubcheckPassed: boolean | undefined;
        if (format === "epub" && (options.validateEpub ?? false) && toolchain.epubcheck.available) {
          const eres = runEpubcheck([outPath], 30_000);
          epubcheckPassed = eres.status === 0;
          if (!epubcheckPassed && eres.stderr) {
            warnings.push(...eres.stderr.split(/\r?\n/).filter(Boolean));
          }
        }

        const st = statSync(outPath);
        const displayPath = relative(rootDir, outPath);
        const cleanOutputPath = displayPath.startsWith("..") ? outPath : displayPath || outPath;
        artifacts.push({
          format,
          output_path: cleanOutputPath,
          bytes: st.size,
          warnings,
          ...(format === "pdf" || format === "pdf-print" ? { linearized } : {}),
          ...(epubcheckPassed !== undefined ? { epubcheck_passed: epubcheckPassed } : {}),
          ...(options.returnContent && format === "html" ? { content: readFileSync(outPath, "utf8") } : {}),
        });
      } finally {
        if (tempLatexOverride) rmSync(tempLatexOverride, { force: true });
      }
    }
  } finally {
    if (tempInputPath) rmSync(tempInputPath, { force: true });
    if (tempBibPath) rmSync(tempBibPath, { force: true });
  }

  return {
    source: options.markdown !== undefined ? "(inline markdown)" : relative(rootDir, inputPath) || inputPath,
    title: docTitle,
    stage,
    artifacts,
  };
}
