-- iasp-semantics.lua
-- Map EPUB 3 structural semantics (epub:type)
-- to sensible LaTeX/PDF behavior while keeping authoring ergonomics light.
--
-- The filter runs in two passes:
--   1. Preprocess Markdown-derived blocks so shorthand fenced divs such as
--      "::: callout" or "::: note" are converted into proper Div elements with
--      semantic classes.
--   2. Apply epub:type aliases plus PDF-specific wrapping (sidebars, callouts,
--      etc.) via the standard element handlers.

local utils = pandoc.utils
local path = pandoc.path
local system = pandoc.system

local script_dir = (PANDOC_SCRIPT_FILE and path.directory(PANDOC_SCRIPT_FILE)) or "."
package.path = package.path .. ";" .. script_dir .. "/?.lua;" .. script_dir .. "/?/init.lua"

local meta = require("iasp.metadata")
local shorthand = require("iasp.shorthand")
local include = require("iasp.include")
local table_appearance = require("iasp.table_appearance")
local latex_helpers = require("iasp.latex")

local meta_value = meta.meta_value
local truthy_string = meta.truthy_string
local named_block_badges_enabled = meta.named_block_badges_enabled
local named_note_badges_enabled = meta.named_note_badges_enabled
local table_fullpage_min_rows = meta.table_fullpage_min_rows
local table_compact_min_cols = meta.table_compact_min_cols
local article_build_enabled = meta.article_build_enabled
local resolve_toggle = meta.resolve_toggle
local frontmatter_enabled = meta.frontmatter_enabled
local backmatter_enabled = meta.backmatter_enabled

local build_stage_cache = nil
local identifier_registry = {}
local note_variant
local note_variant_badge_label
local table_helpers
local function preprocess_shorthand(doc)
  build_stage_cache = nil
  identifier_registry = {}
  provenance_manifest_cache = nil
  return shorthand.preprocess_shorthand(doc, meta.capture_document_meta)
end

local function add_unique(tbl, value)
  for _, existing in ipairs(tbl) do
    if existing == value then
      return
    end
  end
  table.insert(tbl, value)
end

local function enforce_section_visibility(el)
  if not el or not el.classes then
    return true, false
  end

  for _, cls in ipairs(el.classes) do
    local lowered = cls:lower()
    if lowered == "frontmatter" and not frontmatter_enabled() then
      return false, false
    end
    if lowered == "backmatter" and not backmatter_enabled() then
      return false, false
    end
  end

  return true, false
end

local function normalize_stage_value(value)
  if not value then
    return nil
  end
  local lowered = tostring(value):lower()
  if lowered == "draft" or lowered == "final" then
    return lowered
  end
  return nil
end

local function current_build_stage()
  if build_stage_cache then
    return build_stage_cache
  end

  local from_meta = normalize_stage_value(meta_value("build-stage"))
  if from_meta then
    build_stage_cache = from_meta
    return build_stage_cache
  end

  if truthy_string(meta_value("draft-build")) then
    build_stage_cache = "draft"
    return build_stage_cache
  end

  if truthy_string(meta_value("final-build")) then
    build_stage_cache = "final"
    return build_stage_cache
  end

  build_stage_cache = "final"
  return build_stage_cache
end

local function stage_class_from_element(el)
  if not el or not el.classes then
    return nil
  end
  for _, cls in ipairs(el.classes) do
    local lowered = cls:lower()
    if lowered == "draft" or lowered == "final" then
      return lowered
    end
  end
  return nil
end

local function enforce_stage_visibility(el)
  if not el then
    return true, false
  end

  local stage_class = stage_class_from_element(el)
  if not stage_class then
    return true, false
  end

  local stage = current_build_stage()
  local should_render = (stage_class == "draft" and stage == "draft")
    or (stage_class == "final" and stage ~= "draft")

  if not should_render then
    return false, false
  end

  local retained = {}
  for _, cls in ipairs(el.classes) do
    local lowered = cls:lower()
    if lowered ~= "draft" and lowered ~= "final" then
      table.insert(retained, cls)
    end
  end

  local mutated = #retained ~= #el.classes
  el.classes = retained
  return true, mutated
end

local function slugify_identifier_source(raw)
  if not raw or raw == "" then
    return nil
  end

  if utils and utils.slugify then
    local via_util = utils.slugify(raw)
    if via_util and via_util ~= "" then
      return via_util
    end
  end

  local lowered = raw:lower()
  lowered = lowered:gsub("[^%w]+", "-")
  lowered = lowered:gsub("-+", "-")
  lowered = lowered:gsub("^-+", "")
  lowered = lowered:gsub("-+$", "")

  if lowered == "" then
    return nil
  end

  return lowered
end

local function namespace_header_identifiers(blocks, prefix, min_level)
  if not blocks or not prefix or prefix == "" then
    return blocks
  end

  local threshold = min_level or 2
  local replacements = {}

  local function header_handler(h)
    local level = h.level or 0
    if level >= threshold and h.identifier and h.identifier ~= "" then
      local old_id = h.identifier
      local new_id = prefix .. "-" .. old_id
      replacements[old_id] = new_id
      h.identifier = new_id
      return h
    end
    return nil
  end

  local function link_handler(el)
    local target = el.target
    if target and target:sub(1, 1) == "#" then
      local bare = target:sub(2)
      local mapped = replacements[bare]
      if mapped then
        el.target = "#" .. mapped
        return el
      end
    end
    return nil
  end

  local container = pandoc.Div(blocks)
  container = pandoc.walk_block(container, {
    Header = header_handler,
    Link = link_handler,
  })
  return container.content
end

local function has_class(el, class_name)
  if not el or not el.classes then return false end
  for _, cls in ipairs(el.classes) do
    if cls == class_name then
      return true
    end
  end
  return false
end

-- Helper: does this element's attributes include a given epub:type?
local function has_epub_type(attr, target)
  local val = attr and attr["epub:type"]
  if not val then return false end
  for token in val:gmatch("%S+") do
    if token == target then
      return true
    end
  end
  return false
end

local function wrap_in_env(div, env_name)
  local blocks = {}
  table.insert(blocks, pandoc.RawBlock("latex", "\\begin{" .. env_name .. "}\n"))
  for _, b in ipairs(div.content) do
    table.insert(blocks, b)
  end
  table.insert(blocks, pandoc.RawBlock("latex", "\\end{" .. env_name .. "}\n"))
  return blocks
end


local function span_with_classes(inlines, classes)
  local class_list
  if type(classes) == "string" then
    class_list = { classes }
  else
    class_list = classes or {}
  end
  return pandoc.Span(inlines, pandoc.Attr("", class_list, {}))
end


local function is_trivial_raw_latex(block)
  if not block or block.t ~= "RawBlock" or block.format ~= "latex" then
    return false
  end

  local text = block.text or ""
  if text == "" then
    return true
  end

  if text:match("\\hypertarget") or text:match("\\label") or text:match("\\phantomsection") then
    return true
  end

  if text:match("^%s*$") then
    return true
  end

  return false
end

local function begins_with_level_one_header(blocks)
  if not blocks or #blocks == 0 then
    return false
  end

  for _, block in ipairs(blocks) do
    if block.t == "Header" then
      return (block.level or 0) == 1
    elseif is_trivial_raw_latex(block) then
      -- ignore anchor housekeeping emitted ahead of headers
    elseif block.t == "Div" and (not block.content or #block.content == 0) then
      -- skip empty wrappers
    else
      return false
    end
  end

  return false
end

local function latex_escape_argument(text)
  if not text or text == "" then
    return ""
  end

  local replacements = {
    ["\\"] = "\\textbackslash{}",
    ["{"] = "\\{",
    ["}"] = "\\}",
    ["%"] = "\\%",
    ["$"] = "\\$",
    ["#"] = "\\#",
    ["&"] = "\\&",
    ["_"] = "\\_",
    ["^"] = "\\^{}",
    ["~"] = "\\~{}"
  }

  return text:gsub(".", function(char)
    return replacements[char] or char
  end)
end

local SIDEBAR_GLYPH_UTF8 = "🗒"
local SIDEBAR_BADGE_LABEL = "SIDEBAR"
local SECTION_HEADING_GLYPH_CLASS = "section-heading-glyph"
local COLLECTION_HEADING_GLYPH_CLASS = "collection-heading-glyph"
local CATALOG_COLLECTION_HEADING_CLASS = "catalog-collection-heading"
local NAMED_BLOCK_BADGE_LABELS = {
  note = "NOTE",
  callout = "CALLOUT",
  example = "EXAMPLE",
  definition = "DEFINITION",
  aside = "SIDEBAR",
  bridge = "BRIDGE"
}
local BADGE_DISABLE_CLASS_HINTS = {
  nobadge = true,
  ["no-badge"] = true,
  badgeoff = true,
  ["badge-off"] = true,
  nobadges = true
}
local GLYPH_DISABLE_CLASS_HINTS = {
  noglyph = true,
  ["no-glyph"] = true,
  glyphoff = true,
  ["glyph-off"] = true,
  noglyphs = true
}
local LOCAL_GLYPH_CLASS_HINTS = {
  ["sidebar-glyph"] = true,
  glyph = true,
  ["glyph-top"] = true,
  glyphtop = true,
  ["glyph-line"] = true,
  glyphline = true,
  ["glyph-block"] = true,
  glyphblock = true,
  ["glyph-stack"] = true,
  glyphstack = true
}

local function replace_meta_placeholders(str)
  if not str or str.t ~= "Str" then
    return nil
  end

  local changed = false
  local text = str.text
  text = text:gsub("({{%s*meta:([%w_%.-]+)%s*}})", function(full, key)
    local value = meta_value(key)
    if value and value ~= "" then
      changed = true
      return value
    end
    return full
  end)

  if changed then
    str.text = text
    return str
  end

  return nil
end

local function ensure_unique_identifier(el)
  if not el or not el.identifier or el.identifier == "" then
    return false
  end

  local base = el.identifier
  local count = identifier_registry[base]
  if not count then
    identifier_registry[base] = 1
    return false
  end

  repeat
    count = count + 1
    local candidate = base .. "-" .. tostring(count)
    if not identifier_registry[candidate] then
      el.identifier = candidate
      identifier_registry[base] = count
      identifier_registry[candidate] = 1
      return true
    end
  until false
end

local function sidebar_glyph_inlines()
  if FORMAT:match("latex") then
    return { pandoc.RawInline("latex", "\\sidebarheadingglyph{}") }
  end
  return { pandoc.Str(SIDEBAR_GLYPH_UTF8), pandoc.Space() }
end

local function section_heading_glyph_inlines(glyph_text, variant)
  if not glyph_text or glyph_text == "" then
    return nil
  end

  if FORMAT:match("latex") then
    local macro = "\\sectionheadingglyph"
    if variant == "collection" then
      macro = "\\collectionheadingglyph"
    end
    return {
      pandoc.RawInline("latex", macro .. "{" .. latex_escape_argument(glyph_text) .. "}"),
      pandoc.Space()
    }
  end

  local classes = { SECTION_HEADING_GLYPH_CLASS }
  if variant == "collection" then
    table.insert(classes, COLLECTION_HEADING_GLYPH_CLASS)
  end
  local glyph_span = span_with_classes({ pandoc.Str(glyph_text) }, classes)
  return { glyph_span, pandoc.Space() }
end

local function sidebar_glyph_marker_inlines()
  if FORMAT:match("latex") then
    return { pandoc.RawInline("latex", "\\sidebarinlineglyph{}") }
  end

  local span = span_with_classes({ pandoc.Str(SIDEBAR_GLYPH_UTF8) }, { "sidebar-inline-glyph" })
  return { span, pandoc.Space() }
end

local function sidebar_glyph_marker_block()
  if FORMAT:match("latex") then
    return pandoc.RawBlock("latex", "\\sidebarinlineglyphline\n")
  end

  local classes = { "sidebar-inline-glyph", "sidebar-inline-glyph--block" }
  local span = span_with_classes({ pandoc.Str(SIDEBAR_GLYPH_UTF8) }, classes)
  return pandoc.Para({ span })
end

local function sidebar_badge_blocks()
  if FORMAT:match("latex") then
    return { pandoc.RawBlock("latex", "\\sidebarbadge\n") }
  end

  local glyph_span = span_with_classes({ pandoc.Str(SIDEBAR_GLYPH_UTF8) }, { "sidebar-badge__glyph" })
  local label_span = span_with_classes({ pandoc.Str(SIDEBAR_BADGE_LABEL) }, { "sidebar-badge__label" })
  local badge_span = span_with_classes({ glyph_span, pandoc.Space(), label_span }, { "sidebar-badge" })
  return { pandoc.Div({ pandoc.Plain({ badge_span }) }, pandoc.Attr("", { "sidebar-badge-row" }, {})) }
end

-- Generic box badge support -------------------------------------------------
local function compute_box_badge_label(div)
  if not div then return nil end
  if div.attributes then
    local custom = div.attributes["data-marker-label"]
    if custom and custom ~= "" then
      return custom
    end
  end

  local variant_label = note_variant_badge_label(div)

  if div.attributes and div.attributes["epub:type"] then
    for token in div.attributes["epub:type"]:gmatch("%S+") do
      local lower = token:lower()
      local mapped = NAMED_BLOCK_BADGE_LABELS[lower]
      if mapped then
        if lower == "note" and variant_label then
          return variant_label
        end
        return mapped
      end
    end
  end

  if variant_label then
    return variant_label
  end

  if div.classes and #div.classes > 0 then
    return (div.classes[1] or ""):upper()
  end

  return nil
end

local function has_badge_disable_hint(div)
  if not div or not div.classes then
    return false
  end
  for _, cls in ipairs(div.classes) do
    if BADGE_DISABLE_CLASS_HINTS[cls] then
      return true
    end
  end
  return false
end

local function has_glyph_disable_hint(div)
  if not div or not div.classes then
    return false
  end
  for _, cls in ipairs(div.classes) do
    if GLYPH_DISABLE_CLASS_HINTS[cls] then
      return true
    end
  end
  return false
end

local function div_has_named_block_semantics(div)
  if not div or not div.attributes then
    return false
  end
  local types = div.attributes["epub:type"]
  if not types or types == "" then
    return false
  end
  for token in types:gmatch("%S+") do
    local lowered = token:lower()
    if lowered == "note" then
      if named_note_badges_enabled() and (not note_variant or not note_variant(div)) then
        return true
      end
    elseif NAMED_BLOCK_BADGE_LABELS[lowered] then
      return true
    end
  end
  return false
end

local function div_has_note_semantics(div)
  if not div then
    return false
  end
  if div.attributes and has_epub_type(div.attributes, "note") then
    return true
  end
  if div.classes then
    for _, cls in ipairs(div.classes) do
      if cls:lower() == "note" then
        return true
      end
    end
  end
  return false
end

note_variant_badge_label = function(div)
  if not note_variant or not div_has_note_semantics(div) then
    return nil
  end
  local variant = note_variant(div)
  if not variant or variant == "" then
    return nil
  end
  local label = variant:gsub("%-", " ")
  return label:upper()
end

local function box_badge_blocks(label)
  if FORMAT:match("latex") then
    return { pandoc.RawBlock("latex", "\\boxbadge{" .. latex_escape_argument(label) .. "}\n") }
  end

  local label_span = span_with_classes({ pandoc.Str(label) }, { "box-badge__label" })
  local badge_span = span_with_classes({ label_span }, { "box-badge" })
  return { pandoc.Div({ pandoc.Plain({ badge_span }) }, pandoc.Attr("", { "box-badge-row" }, {})) }
end

local function div_has_heading_glyph(div)
  if not div or not div.content then
    return false
  end

  for _, block in ipairs(div.content) do
    if block.t == "Header" and block.content and #block.content > 0 then
      local first = block.content[1]
      if first then
        if first.t == "Span" and has_class(first, SECTION_HEADING_GLYPH_CLASS) then
          return true
        end
        if first.t == "RawInline" and first.format == "latex" and first.text then
          if first.text:find("\\sectionheadingglyph") or first.text:find("\\collectionheadingglyph") then
            return true
          end
        end
      end
      break
    end
  end

  return false
end

local function has_local_glyph_hint(div)
  if not div then
    return false
  end

  if div.classes then
    for _, cls in ipairs(div.classes) do
      local normalized = cls and cls:lower() or nil
      if normalized then
        if LOCAL_GLYPH_CLASS_HINTS[normalized] then
          return true
        end
        if normalized:find("glyph", 1, true) then
          return true
        end
      end
    end
  end

  if div.attributes then
    for key, value in pairs(div.attributes) do
      if key then
        local lowered = key:lower()
        if lowered:find("glyph", 1, true) then
          return true
        end
      end
      if value then
        local as_string = tostring(value)
        if as_string ~= "" and as_string:lower():find("glyph", 1, true) then
          return true
        end
      end
    end
  end

  if div_has_heading_glyph(div) then
    return true
  end

  return false
end

-- Table appearance helpers moved to iasp/table_appearance.lua.

local function wants_box_badge(div)
  if not div then
    return false
  end

  if div.attributes and div.attributes["data-marker"] then
    local v = div.attributes["data-marker"]:lower()
    if v == "badge" then
      return true
    elseif v == "glyph" then
      return false
    end
  end

  if has_class(div, "badge") then
    return true
  end

  if has_badge_disable_hint(div) or has_local_glyph_hint(div) then
    return false
  end

  if named_block_badges_enabled() and div_has_named_block_semantics(div) then
    return true
  end

  return false
end

local function insert_box_badge(div, label)
  if not div or not div.content or not label then return false end
  local blocks = box_badge_blocks(label)
  for idx = #blocks, 1, -1 do
    table.insert(div.content, 1, blocks[idx])
  end
  return true
end

local function header_has_sidebar_glyph(header)
  if not header or not header.content or #header.content == 0 then
    return false
  end

  local first = header.content[1]
  if not first then
    return false
  end

  if first.t == "RawInline" and first.format == "latex" and first.text:find("\\sidebarheadingglyph") then
    return true
  end

  if first.t == "Str" and first.text and first.text:find("^" .. SIDEBAR_GLYPH_UTF8) then
    return true
  end

  return false
end

local function inject_sidebar_glyph(header)
  if not header or header.t ~= "Header" then
    return false
  end

  if header_has_sidebar_glyph(header) then
    return false
  end

  header.content = header.content or {}
  local glyph_inlines = sidebar_glyph_inlines()
  for idx = #glyph_inlines, 1, -1 do
    table.insert(header.content, 1, glyph_inlines[idx])
  end
  return true
end

local function header_has_section_heading_glyph(header)
  if not header or not header.content or #header.content == 0 then
    return false
  end

  local first = header.content[1]
  if not first then
    return false
  end

  if first.t == "Span" and has_class(first, SECTION_HEADING_GLYPH_CLASS) then
    return true
  end

  if first.t == "RawInline" and first.format == "latex" and first.text:find("\\sectionheadingglyph") then
    return true
  end

  return false
end

local function inject_section_heading_glyph(header, glyph_text, glyph_variant)
  if not header or header.t ~= "Header" then
    return false
  end

  if header_has_section_heading_glyph(header) then
    return false
  end

  local glyph_inlines = section_heading_glyph_inlines(glyph_text, glyph_variant)
  if not glyph_inlines then
    return false
  end

  header.content = header.content or {}
  for idx = #glyph_inlines, 1, -1 do
    table.insert(header.content, 1, glyph_inlines[idx])
  end

  return true
end

local function apply_section_heading_glyph(blocks, glyph_text)
  if not glyph_text or glyph_text == "" or not blocks then
    return
  end

  local inserted = false

  local function walk(block_list)
    if inserted or not block_list then
      return
    end

    for _, block in ipairs(block_list) do
      if inserted then
        break
      end

      if block.t == "Div" then
        if has_class(block, "section") then
          for _, inner in ipairs(block.content or {}) do
            if inner.t == "Header" then
              if inject_section_heading_glyph(inner, glyph_text) then
                inserted = true
                break
              end
            end
          end
        end
        walk(block.content)
      elseif block.t == "Header" then
        if inject_section_heading_glyph(block, glyph_text) then
          inserted = true
          break
        end
      end
    end
  end

  walk(blocks)
end

local function decorate_sidebar_heading(blocks)
  if not blocks then
    return false
  end

  for _, block in ipairs(blocks) do
    if block.t == "Header" then
      return inject_sidebar_glyph(block)
    end
  end

  return false
end

local function insert_sidebar_badge(div)
  if not div or not div.content then
    return false
  end

  local badge_blocks = sidebar_badge_blocks()
  for idx = #badge_blocks, 1, -1 do
    table.insert(div.content, 1, badge_blocks[idx])
  end

  return true
end

local function sidebar_display_mode(div, is_sidebar_block)
  if not div then
    return is_sidebar_block and "badge" or "glyph"
  end

  local forced = nil

  if div.classes then
    if has_class(div, "sidebar-badge") then
      forced = "badge"
    elseif has_class(div, "sidebar-glyph") then
      forced = "glyph"
    end
  end

  if not forced and div.attributes then
    local attr = div.attributes["data-marker"]
    if attr and attr ~= "" then
      local normalized = attr:lower()
      if normalized == "badge" or normalized == "glyph" or normalized == "none" then
        forced = normalized
      end
    end
  end

  -- Check for glyph disable hints (noglyph, no-glyph, etc.) - takes precedence
  if not forced and has_glyph_disable_hint(div) then
    forced = "none"
  end

  -- Check for badge disable hints (nobadge, no-badge, etc.)
  if not forced and has_badge_disable_hint(div) then
    forced = "glyph"
  end

  if not forced then
    forced = is_sidebar_block and "badge" or "glyph"
  end

  return forced
end

local function wants_sidebar_glyph_block_marker(div)
  if not div then
    return false
  end

  local block_class_hints = {
    ["glyph-top"] = true,
    ["glyphtop"] = true,
    ["glyph-line"] = true,
    ["glyphline"] = true,
    ["glyph-block"] = true,
    ["glyphblock"] = true,
    ["glyph-stack"] = true,
    ["glyphstack"] = true
  }

  if div.classes then
    for _, cls in ipairs(div.classes) do
      if block_class_hints[cls] then
        return true
      end
    end
  end

  if div.attributes then
    local glyph_mode = div.attributes["data-glyph"]
    if glyph_mode then
      local normalized = glyph_mode:lower()
      local attr_hints = {
        block = true,
        stacked = true,
        stack = true,
        line = true,
        top = true
      }
      if attr_hints[normalized] then
        return true
      end
    end
  end

  return false
end

local function inject_sidebar_glyph_marker(div, mode)
  if not div or not div.content then
    return false
  end

  if mode == "block" then
    local glyph_block = sidebar_glyph_marker_block()
    if not glyph_block then
      return false
    end
    table.insert(div.content, 1, glyph_block)
    return true
  end

  for _, block in ipairs(div.content) do
    if block.t == "Para" or block.t == "Plain" then
      local marker_inlines = sidebar_glyph_marker_inlines()
      for idx = #marker_inlines, 1, -1 do
        table.insert(block.content, 1, marker_inlines[idx])
      end
      return true
    elseif block.t == "Header" then
      break
    end
  end

  return false
end

local function expand_compound_classes(el)
  if not el or not el.classes then
    return false
  end

  local normalized = {}
  local mutated = false

  for _, cls in ipairs(el.classes) do
    local value = cls:lower()
    if value:find(".", 1, true) then
      mutated = true
      for chunk in value:gmatch("[^%.]+") do
        if chunk ~= "" then
          add_unique(normalized, chunk)
        end
      end
    else
      add_unique(normalized, value)
    end
  end

  if mutated or #normalized ~= #el.classes then
    el.classes = normalized
    return true
  end

  return false
end

-- Allow Markdown shorthand classes to add the matching epub:type automatically.
local SEMANTIC_CLASS_MAP = {
  callout = "callout",
  note = "note",
  example = "example",
  definition = "definition",
  sidebar = "aside",
  aside = "aside",
  ["sidebar-inline"] = "sidebar-inline",
  epigraph = "epigraph",
  ["epigraph-inline"] = "epigraph-inline",
  part = "part",
  chapter = "chapter",
  appendix = "appendix",
  subchapter = "subchapter",
  section = "section",
  subsection = "subsection",
  frontmatter = "frontmatter",
  backmatter = "backmatter",
  toc = "toc",
  dedication = "dedication",
  preface = "preface",
  introduction = "introduction",
  conclusion = "conclusion",
  epilogue = "epilogue",
  prologue = "prologue",
  foreword = "foreword",
  afterword = "afterword",
  acknowledgments = "acknowledgments",
  acknowledgment = "acknowledgments",
  summary = "summary",
  abstract = "abstract",
  contribution = "contribution",
  colophon = "colophon",
  footnotes = "footnotes",
  glossary = "glossary",
  index = "index",
  bibliography = "bibliography",
  references = "references",
  figure = "figure",
  table = "table",
  erratum = "erratum",
  bridge = "bridge",
  bridgehead = "bridge"
}

local ARIA_ROLE_MAP = {
  aside = "complementary",
  toc = "doc-toc",
  dedication = "doc-dedication",
  epigraph = "doc-epigraph",
  preface = "doc-preface",
  introduction = "doc-introduction",
  conclusion = "doc-conclusion",
  epilogue = "doc-epilogue",
  chapter = "doc-chapter",
  part = "doc-part",
  appendix = "doc-appendix",
  footnotes = "doc-endnotes",
  glossary = "doc-glossary",
  acknowledgments = "doc-acknowledgments",
  summary = "doc-abstract",
  abstract = "doc-abstract",
  bridge = "complementary"
}

local IASP_DELIVERY_SLUG_MAP = {
  ["front-matter"] = "front-matter",
  frontmatter = "front-matter",
  series = "series",
  part = "part",
  chapter = "chapter",
  section = "section",
  interlude = "interlude",
  bridge = "bridge",
  bridgehead = "bridge",
  sidebar = "sidebar",
  aside = "sidebar",
  ["sidebar-inline"] = "sidebar-inline",
  callout = "callout",
  note = "note",
  footnote = "footnote",
  endnotes = "endnotes",
  footnotes = "endnotes",
  epigraph = "epigraph",
  ["epigraph-inline"] = "epigraph-inline",
  appendix = "appendix",
  ["back-matter"] = "back-matter",
  backmatter = "back-matter",
}

local IASP_MODIFIER_SLUG_MAP = {
  thesis = "thesis",
  claim = "claim",
  counterpoint = "counterpoint",
  qualification = "qualification",
  implication = "implication",
  synthesis = "synthesis",
  integration = "integration",
  contrast = "contrast",
  reflection = "reflection",
  provocation = "provocation",
  example = "example",
  ["case-study"] = "case-study",
  background = "background",
  context = "context",
  definition = "definition",
  gloss = "gloss",
  analogy = "analogy",
  insight = "insight",
  ["insight-major"] = "insight-major",
  idea = "idea",
  usage = "usage",
  methodology = "methodology",
  diagnostic = "diagnostic",
  checklist = "checklist",
  warning = "warning",
  notice = "notice",
  caution = "caution",
  misuse = "misuse",
  assumption = "assumption",
  limitation = "limitation",
  scope = "scope",
  uncertainty = "uncertainty",
  disclosure = "disclosure",
  ai = "disclosure",
  responsibility = "responsibility",
  reflexive = "reflexive",
  breadcrumb = "breadcrumb",
  navigation = "navigation",
  orientation = "navigation",
  transition = "transition",
  prelude = "prelude",
  closing = "closing",
}

local IASP_CONCEPT_URN_PREFIX = "urn:iasp:concept:"
local IASP_PUBLIC_TERM_PREFIX = "https://vocabulary.majerus.us/api/schemes/iasp/slugs/"
local SKOS_VOCAB_URI = "http://www.w3.org/2004/02/skos/core#"

local provenance_manifest_cache = nil

local function get_provenance_manifest()
  if provenance_manifest_cache ~= nil then
    return provenance_manifest_cache
  end
  provenance_manifest_cache = { quotes = {}, concepts = {} }
  local path_val = meta_value("provenance-manifest")
  if not path_val or path_val == "" then
    return provenance_manifest_cache
  end
  local fh = io.open(path_val, "r")
  if not fh then
    return provenance_manifest_cache
  end
  local raw = fh:read("*a")
  fh:close()
  if raw and raw ~= "" and pandoc.json and pandoc.json.decode then
    local ok, decoded = pcall(function() return pandoc.json.decode(raw) end)
    if ok and type(decoded) == "table" then
      provenance_manifest_cache = {
        quotes = decoded.quotes or {},
        concepts = decoded.concepts or {},
      }
    end
  end
  return provenance_manifest_cache
end

local function normalize_external_concept_token(token)
  if not token then return nil end
  local cleaned = token:gsub("^[,;%s]+", ""):gsub("[,;%s]+$", "")
  if cleaned == "" then return nil end
  local colon = cleaned:find(":", 1, true)
  if colon and colon > 1 then
    local scheme = cleaned:sub(1, colon - 1):lower()
    local slug = cleaned:sub(colon + 1):lower():gsub("%s+", "-")
    if scheme ~= "" and slug ~= "" then
      return scheme .. ":" .. slug, scheme, slug
    end
  end
  local slug = cleaned:lower():gsub("%s+", "-")
  return "human-work:" .. slug, "human-work", slug
end

local function resolve_external_concept_info(raw_token)
  local key, scheme, slug = normalize_external_concept_token(raw_token)
  if not key then return nil end
  local manifest = get_provenance_manifest()
  local entry = manifest.concepts and manifest.concepts[key]
  if entry and type(entry) == "table" then
    return {
      raw = entry.raw or key,
      scheme = entry.scheme or scheme,
      slug = entry.slug or slug,
      uri = entry.uri or ("urn:quote-mcp:concept:" .. scheme .. ":" .. slug),
      publicUrl = entry.publicUrl or ("https://vocabulary.majerus.us/api/schemes/" .. scheme .. "/slugs/" .. slug),
    }
  end
  local urn_prefix = "urn:terminology-mcp:concept:" .. scheme .. ":"
  if scheme == "human-work" then
    urn_prefix = "urn:quote-mcp:concept:human-work:"
  elseif scheme == "iasp" then
    urn_prefix = "urn:iasp:concept:"
  end
  return {
    raw = key,
    scheme = scheme,
    slug = slug,
    uri = urn_prefix .. slug,
    publicUrl = "https://vocabulary.majerus.us/api/schemes/" .. scheme .. "/slugs/" .. slug,
  }
end

local function apply_external_concept_attributes(attr, concept_tokens, quote_info)
  if not attr then return false end
  if FORMAT and FORMAT:match("latex") then
    return false
  end

  local raw_tokens = {}
  local seen = {}
  local function push_token(tok)
    local norm = normalize_external_concept_token(tok)
    if norm and not seen[norm] then
      seen[norm] = true
      table.insert(raw_tokens, norm)
    end
  end

  if quote_info and quote_info.concepts then
    for _, c in ipairs(quote_info.concepts) do
      push_token(c)
    end
  end
  if concept_tokens then
    for _, c in ipairs(concept_tokens) do
      push_token(c)
    end
  end

  for _, key_name in ipairs({ "concepts", "concept" }) do
    local raw_attr = attr[key_name]
    if raw_attr and raw_attr ~= "" then
      for part in raw_attr:gmatch("[^%s,;]+") do
        push_token(part)
      end
      attr[key_name] = nil
    end
  end

  if attr["data-concepts"] and attr["data-concepts"] ~= "" then
    for part in attr["data-concepts"]:gmatch("[^%s,;]+") do
      push_token(part)
    end
  end

  local mutated = false
  if quote_info then
    if quote_info.id and not attr["data-quote-id"] then
      attr["data-quote-id"] = tostring(quote_info.id)
      mutated = true
    end
    if quote_info.citekey and quote_info.citekey ~= "" and not attr["data-citekey"] then
      attr["data-citekey"] = tostring(quote_info.citekey)
      mutated = true
    end
    if quote_info.workKey and quote_info.workKey ~= "" and not attr["data-work-key"] then
      attr["data-work-key"] = tostring(quote_info.workKey)
      mutated = true
    end
    if quote_info.locator and quote_info.locator ~= "" and not attr["data-quote-locator"] then
      attr["data-quote-locator"] = tostring(quote_info.locator)
      mutated = true
    end
  end

  if #raw_tokens == 0 then
    return mutated
  end

  local resolved_raw = {}
  local resolved_uris = {}
  local resolved_terms = {}
  for _, tok in ipairs(raw_tokens) do
    local info = resolve_external_concept_info(tok)
    if info then
      table.insert(resolved_raw, info.raw)
      table.insert(resolved_uris, info.uri)
      table.insert(resolved_terms, info.publicUrl)
    end
  end

  if #resolved_raw > 0 then
    attr["data-concepts"] = table.concat(resolved_raw, " ")
    attr["data-concept-uris"] = table.concat(resolved_uris, " ")
    attr["data-concept-terms"] = table.concat(resolved_terms, " ")
    if FORMAT and FORMAT:match("html") and not FORMAT:match("epub") then
      if not attr["about"] then
        attr["about"] = table.concat(resolved_uris, " ")
      end
    end
    mutated = true
  end

  return mutated
end

local LOW_PRIORITY_ARIA = {}

local HEADER_ROLE_ALLOWLIST = {
  heading = true,
  none = true,
  presentation = true,
  tab = true
}

local function scrub_header_role(attr)
  if not attr then
    return false
  end

  local role = attr["role"]
  if not role then
    return false
  end

  if not HEADER_ROLE_ALLOWLIST[role] then
    attr["role"] = nil
    return true
  end

  return false
end

local DEPRECATED_TYPE_MAP = {
  sidebar = "aside",
  bridgehead = "bridge"
}

local function normalize_epub_type(attr)
  if not attr then
    return false
  end

  local value = attr["epub:type"]
  if not value or value == "" then
    return false
  end

  local tokens = {}
  local mutated = false

  for token in value:gmatch("%S+") do
    local lowered = token:lower()
    local mapped = DEPRECATED_TYPE_MAP[lowered]
    local replacement = mapped or token
    if mapped then
      mutated = true
    end
    add_unique(tokens, replacement)
  end

  local combined = table.concat(tokens, " ")
  if combined ~= value then
    attr["epub:type"] = combined
    mutated = true
  end

  return mutated
end

local function assign_aria_role(attr)
  if not attr then
    return
  end

  if attr["role"] then
    return
  end

  local epub_type = attr["epub:type"]
  if not epub_type then
    return
  end

  local fallback = nil
  for token in epub_type:gmatch("%S+") do
    local role = ARIA_ROLE_MAP[token]
    if role then
      if not LOW_PRIORITY_ARIA[token] then
        attr["role"] = role
        return
      end
      fallback = fallback or role
    end
  end

  if fallback then
    attr["role"] = fallback
  end
end

local function add_epub_type_token(attr, token)
  if not attr then return false end
  local current = attr["epub:type"]
  if not current or current == "" then
    attr["epub:type"] = token
    return true
  end

  for existing in current:gmatch("%S+") do
    if existing == token then
      return false
    end
  end

  attr["epub:type"] = current .. " " .. token
  return true
end

local function assign_skos_annotations(el)
  if not el or not el.classes or #el.classes == 0 then
    return false
  end
  if FORMAT and FORMAT:match("latex") then
    return false
  end

  local delivery_slug = nil
  local modifier_slugs = {}
  local has_insight = has_class(el, "insight")
  local has_major = has_class(el, "major")

  for _, cls in ipairs(el.classes) do
    local lowered = cls:lower()
    local d_slug = IASP_DELIVERY_SLUG_MAP[lowered]
    if d_slug then
      if not delivery_slug then
        delivery_slug = d_slug
      elseif d_slug == "bridge" and delivery_slug == "note" then
        add_unique(modifier_slugs, "bridge")
      end
    elseif lowered == "insight" and has_insight and has_major then
      add_unique(modifier_slugs, "insight-major")
    elseif lowered == "major" and has_insight then
      -- handled above as insight-major
    else
      local m_slug = IASP_MODIFIER_SLUG_MAP[lowered]
      if m_slug then
        add_unique(modifier_slugs, m_slug)
      end
    end
  end

  if not delivery_slug and #modifier_slugs == 0 then
    return false
  end

  local concept_slugs = {}
  if delivery_slug then
    add_unique(concept_slugs, delivery_slug)
  end
  for _, m_slug in ipairs(modifier_slugs) do
    add_unique(concept_slugs, m_slug)
  end

  local concept_urns = {}
  local public_urls = {}
  for _, slug in ipairs(concept_slugs) do
    table.insert(concept_urns, IASP_CONCEPT_URN_PREFIX .. slug)
    table.insert(public_urls, IASP_PUBLIC_TERM_PREFIX .. slug)
  end

  el.attributes = el.attributes or {}
  if delivery_slug and not el.attributes["data-iasp-delivery"] then
    el.attributes["data-iasp-delivery"] = delivery_slug
  end
  if #modifier_slugs > 0 and not el.attributes["data-iasp-modifiers"] then
    el.attributes["data-iasp-modifiers"] = table.concat(modifier_slugs, " ")
  end
  if #concept_urns > 0 and not el.attributes["data-iasp-concepts"] then
    el.attributes["data-iasp-concepts"] = table.concat(concept_urns, " ")
  end
  if #public_urls > 0 and not el.attributes["data-iasp-terms"] then
    el.attributes["data-iasp-terms"] = table.concat(public_urls, " ")
  end

  -- Emit RDFa Lite attributes for HTML outputs (avoiding XHTML/EPUB 3 schema collisions)
  if FORMAT and FORMAT:match("html") and not FORMAT:match("epub") then
    if not el.attributes["vocab"] then
      el.attributes["vocab"] = SKOS_VOCAB_URI
    end
    if not el.attributes["typeof"] then
      el.attributes["typeof"] = "Concept"
    end
    if not el.attributes["resource"] and #concept_urns > 0 then
      el.attributes["resource"] = concept_urns[#concept_urns]
    end
  end

  return true
end

local function apply_semantic_aliases(el)
  if not el then
    return false
  end

  local mutated = expand_compound_classes(el)

  if not el.classes or #el.classes == 0 then
    return mutated
  end

  el.attributes = el.attributes or {}
  local alias_changed = normalize_epub_type(el.attributes)

  for _, cls in ipairs(el.classes) do
    local mapped = SEMANTIC_CLASS_MAP[cls]
    if mapped then
      if add_epub_type_token(el.attributes, mapped) then
        alias_changed = true
      end
    end
  end

  assign_aria_role(el.attributes)
  local skos_changed = assign_skos_annotations(el)
  local ext_changed = apply_external_concept_attributes(el.attributes, nil, nil)

  return mutated or alias_changed or skos_changed or ext_changed
end

-- Shorthand fenced divs are implemented in iasp/shorthand.lua.

-- Include directives are implemented in iasp/include.lua.

-- ---------------------------------------------------------------------------
-- LaTeX/PDF aware block handlers
-- ---------------------------------------------------------------------------

local appendix_started = false
local first_chapter_seen = false

-- Note variant configuration table: single source of truth for variant → LaTeX environment mapping
-- Adding a new variant: add an entry here, then add CSS/LaTeX styling in format-specific files
local NOTE_VARIANT_CONFIG = {
  idea           = { env = "notebox" },           -- uses default notebox; glyph injected inline
  insight        = { env = "notebox" },           -- uses default notebox; asterism header
  ["insight-major"] = { env = "notebox" },        -- uses default notebox; badge header
  warning        = { env = "noteboxwarning" },
  breadcrumb     = { env = "noteboxbreadcrumb" },
  contrast       = { env = "noteboxcontrast" },
  transition     = { env = "noteboxtransition" },
  navigation     = { env = "noteboxnavigation" },
  bridge         = { env = "noteboxbridge" },
  usage          = { env = "noteboxusage" },
  integration    = { env = "noteboxintegration" },
  responsibility = { env = "noteboxresponsibility" },
  reflexive      = { env = "noteboxreflexive" },
  synthesis      = { env = "noteboxsynthesis" },
  disclosure     = { env = "noteboxdisclosure" },
  misuse         = { env = "noteboxmisuse" },
  diagnostic     = { env = "noteboxdiagnostic" },
  closing        = { env = "noteboxclosing" },
  methodology    = { env = "noteboxmethodology" },
  context        = { env = "noteboxcontext" },
  scope          = { env = "noteboxscope" },
  checklist      = { env = "noteboxchecklist" },
  prelude        = { env = "noteboxprelude" },
  orientation    = { env = "noteboxnavigation" },
  ai             = { env = "noteboxdisclosure" },
}

-- Derive NOTE_VARIANTS list from config keys for backwards compatibility
local NOTE_VARIANTS = {}
for variant, _ in pairs(NOTE_VARIANT_CONFIG) do
  -- Skip compound variants like "insight-major" (handled specially)
  if not variant:match("-") then
    table.insert(NOTE_VARIANTS, variant)
  end
end

-- Helper to get LaTeX environment for a variant
local function note_variant_env(variant)
  if not variant then
    return "noteboxplain"
  end
  local config = NOTE_VARIANT_CONFIG[variant]
  if config then
    return config.env
  end
  return "notebox"  -- fallback for unrecognized variants
end

local function chapter_page_break_block(format_hint)
  format_hint = (format_hint or ""):lower()
  if format_hint == "" then
    return nil
  end

  if format_hint:match("latex") then
    return pandoc.RawBlock("latex", "\\clearpage")
  end

  if format_hint:match("docx") or format_hint:match("openxml") then
    return pandoc.RawBlock("openxml", "<w:p><w:r><w:br w:type=\"page\"/></w:r></w:p>")
  end

  if format_hint:match("rtf") then
    return pandoc.RawBlock("rtf", "{\\pard\\page\\par}")
  end

  return nil
end

local function apply_pagebreak_wrappers(blocks, wants_pre, wants_post, format_hint)
  if not wants_pre and not wants_post then
    return blocks
  end
  if not blocks then
    return blocks
  end

  local wrapped = {}

  local function append_break()
    local breaker = chapter_page_break_block(format_hint)
    if breaker then
      table.insert(wrapped, breaker)
    end
  end

  if wants_pre then
    append_break()
  end

  for _, block in ipairs(blocks) do
    table.insert(wrapped, block)
  end

  if wants_post then
    append_break()
  end

  if #wrapped == 0 then
    return blocks
  end

  return wrapped
end

note_variant = function(div)
  if not div or not div.classes then
    return nil
  end

  -- Treat ::: note.insight.major as a distinct "insight-major" variant
  local has_insight = has_class(div, "insight")
  local has_major   = has_class(div, "major")

  if has_insight and has_major then
    return "insight-major"
  end

  -- Fallback: simple variants
  for _, candidate in ipairs(NOTE_VARIANTS) do
    if has_class(div, candidate) then
      return candidate
    end
  end

  return nil
end


local function inject_note_variant(div, variant)
  if not variant then
    return
  end

  -- note.idea: inline 💡 if possible, else neutral badge
  if variant == "idea" then
    local first = div.content[1]
    if first and first.t == "Para" and first.content then
      table.insert(first.content, 1,
        pandoc.RawInline("latex", "\\notevariantideainline{}")
      )
      return
    end
    table.insert(div.content, 1,
      pandoc.RawBlock("latex", "\\notevariant{idea}\n")
    )
    return
  end

  -- note.insight (minor): ornamental asterism row (⁂), not inline
  if variant == "insight" then
    table.insert(div.content, 1,
      pandoc.RawBlock("latex", "\\notevariantinsight\n")
    )
    return
  end

  -- note.insight.major (major): badge strip with ⁂
  if variant == "insight-major" then
    table.insert(div.content, 1,
      pandoc.RawBlock("latex", "\\notevariantinsightmajor\n")
    )
    return
  end

  -- note.warning and any other variants → generic badge
  table.insert(div.content, 1,
    pandoc.RawBlock("latex", "\\notevariant{" .. variant .. "}\n")
  )
end



local function primary_chapter_header(div)
  if not div or not div.content then
    return nil
  end

  for _, block in ipairs(div.content) do
    if block.t == "Header" then
      return block
    elseif is_trivial_raw_latex(block) then
      -- skip helper anchors without aborting the search
    elseif block.t == "Div" and (not block.content or #block.content == 0) then
      -- ignore empty placeholder wrappers
    else
      break
    end
  end

  return nil
end

local function ensure_chapter_header_semantics(div)
  local header = primary_chapter_header(div)
  if not header then
    return false
  end

  header.attributes = header.attributes or {}
  return add_epub_type_token(header.attributes, "chapter")
end

local function ensure_appendix_header_semantics(div)
  local header = primary_chapter_header(div)
  if not header then
    return false
  end

  header.attributes = header.attributes or {}
  return add_epub_type_token(header.attributes, "appendix")
end

local function primary_part_heading_text(div)
  if not div or not div.content then
    return nil
  end

  for _, block in ipairs(div.content) do
    if block.t == "Header" then
      return utils.stringify(block)
    elseif is_trivial_raw_latex(block) then
      -- skip helper anchors
    elseif block.t == "Div" and (not block.content or #block.content == 0) then
      -- ignore placeholder wrappers
    else
      break
    end
  end

  return nil
end

local function handle_div(div)
  local semantics_changed = apply_semantic_aliases(div)
  local allowed, stage_changed = enforce_stage_visibility(div)
  if not allowed then
    return {}
  end
  local section_allowed, section_changed = enforce_section_visibility(div)
  if not section_allowed then
    return {}
  end

  local mutated = semantics_changed or stage_changed or section_changed

  if ensure_unique_identifier(div) then
    mutated = true
  end

  div.attributes = div.attributes or {}

  local format_hint = (FORMAT or ""):lower()
  local manual_page_break = has_class(div, "page-break") or has_class(div, "pagebreak")
  local wants_pre_pagebreak = has_class(div, "pre-pagebreak") or has_class(div, "pagebreak-before") or has_class(div, "prepagebreak")
  local wants_post_pagebreak = has_class(div, "post-pagebreak") or has_class(div, "pagebreak-after") or has_class(div, "postpagebreak")
  local has_fullpage_layout = has_class(div, "layout-fullpage")
    or has_class(div, "layout_fullpage")
    or has_class(div, "layout-full-page")
  local has_table_semantics = has_class(div, "table")

  if has_table_semantics then
    has_fullpage_layout, mutated = table_helpers.apply_table_layout(
      div,
      format_hint,
      has_fullpage_layout,
      mutated
    )
  end

  if manual_page_break then
    local breaker = chapter_page_break_block(format_hint)
    if breaker then
      return { breaker }
    end
  end

  -- Table appearance applied by table helpers.

  if has_fullpage_layout then
    wants_pre_pagebreak = true
    wants_post_pagebreak = true
  end

  local has_sidebar_semantics = has_epub_type(div.attributes, "aside") or has_epub_type(div.attributes, "sidebar")
  local has_inline_hint = has_epub_type(div.attributes, "sidebar-inline") or has_class(div, "sidebar-inline")
  local has_block_hint = has_class(div, "sidebar-block") or div.attributes["data-sidebar"] == "block"

  local is_sidebar_inline = has_inline_hint or (has_sidebar_semantics and not has_block_hint)
  if is_sidebar_inline and not has_inline_hint then
    add_epub_type_token(div.attributes, "sidebar-inline")
  end

  local is_sidebar_block = has_sidebar_semantics and not is_sidebar_inline

  local handles_sidebar_content = is_sidebar_inline or is_sidebar_block
  local heading_decorated = false
  local glyph_marker_mode = "inline"

  if handles_sidebar_content then
    local display_mode = sidebar_display_mode(div, is_sidebar_block)
    local wants_badge = display_mode == "badge"
    local wants_glyph = display_mode == "glyph"

    if wants_glyph then
      if decorate_sidebar_heading(div.content) then
        mutated = true
        heading_decorated = true
      end
      if wants_sidebar_glyph_block_marker(div) then
        glyph_marker_mode = "block"
      end
    end

    if wants_badge then
      if insert_sidebar_badge(div) then
        mutated = true
      end
    elseif wants_glyph and not heading_decorated then
      if inject_sidebar_glyph_marker(div, glyph_marker_mode) then
        mutated = true
      end
    end
  end

  -- Generic badge support for any framed block: if the author adds the
  -- `.badge` class (or `data-marker="badge"`) to a Div we inject a small
  -- badge row whose label is derived from epub:type or classes. Sidebars
  -- are handled above so skip them here to avoid double-insertion.
  if wants_box_badge(div) and not handles_sidebar_content then
    local label = compute_box_badge_label(div)
    if label and label ~= "" then
      if insert_box_badge(div, label) then
        mutated = true
      end
    end
  end

  if has_epub_type(div.attributes, "chapter") then
    if ensure_chapter_header_semantics(div) then
      mutated = true
    end
  end

  local is_appendix_div = has_epub_type(div.attributes, "appendix")
  if is_appendix_div then
    if ensure_appendix_header_semantics(div) then
      mutated = true
    end
  end

  local is_latex = FORMAT:match("latex") ~= nil
  if not is_latex then
    if wants_pre_pagebreak or wants_post_pagebreak then
      return apply_pagebreak_wrappers({ div }, wants_pre_pagebreak, wants_post_pagebreak, format_hint)
    end
    return mutated and div or nil
  end

  if is_appendix_div then
    local out = {}
    if not appendix_started then
      appendix_started = true
      table.insert(out, pandoc.RawBlock("latex", "\\appendix"))
      table.insert(out, pandoc.RawBlock("latex", "\\iaspSetPartHeader{Appendices}"))
    end
    table.insert(out, div)
    return apply_pagebreak_wrappers(out, wants_pre_pagebreak, wants_post_pagebreak, format_hint)
  end

  if has_epub_type(div.attributes, "part") then
    wants_pre_pagebreak = true
    local blocks = wrap_in_env(div, "parttitlepage")
    local heading_text = primary_part_heading_text(div)
    if heading_text and heading_text ~= "" then
      table.insert(blocks, 1,
        pandoc.RawBlock("latex", "\\iaspSetPartHeader{" .. latex_escape_argument(heading_text) .. "}\\relax\n")
      )
    end
    return apply_pagebreak_wrappers(blocks, wants_pre_pagebreak, wants_post_pagebreak, format_hint)
  end

  if has_epub_type(div.attributes, "toc") then
    return apply_pagebreak_wrappers(wrap_in_env(div, "tocblock"), wants_pre_pagebreak, wants_post_pagebreak, format_hint)
  end

  if has_epub_type(div.attributes, "bridge") then
    local blocks = wrap_in_env(div, "bridgeheadblock")
    return apply_pagebreak_wrappers(blocks, wants_pre_pagebreak, wants_post_pagebreak, format_hint)
  end

  if has_epub_type(div.attributes, "callout") then
    return apply_pagebreak_wrappers(wrap_in_env(div, "calloutbox"), wants_pre_pagebreak, wants_post_pagebreak, format_hint)
  end

  if has_epub_type(div.attributes, "note") then
    local variant = note_variant(div)
    inject_note_variant(div, variant)
    local env = note_variant_env(variant)
    return apply_pagebreak_wrappers(wrap_in_env(div, env), wants_pre_pagebreak, wants_post_pagebreak, format_hint)
  end

  if has_epub_type(div.attributes, "example") then
    return apply_pagebreak_wrappers(wrap_in_env(div, "examplebox"), wants_pre_pagebreak, wants_post_pagebreak, format_hint)
  end

  if has_epub_type(div.attributes, "definition") then
    return apply_pagebreak_wrappers(wrap_in_env(div, "definitionbox"), wants_pre_pagebreak, wants_post_pagebreak, format_hint)
  end

  if has_epub_type(div.attributes, "epigraph") then
    return apply_pagebreak_wrappers(wrap_in_env(div, "epigraph"), wants_pre_pagebreak, wants_post_pagebreak, format_hint)
  end

  if has_epub_type(div.attributes, "epigraph-inline") then
    return apply_pagebreak_wrappers(wrap_in_env(div, "epigraphtight"), wants_pre_pagebreak, wants_post_pagebreak, format_hint)
  end

  if is_sidebar_inline then
    return apply_pagebreak_wrappers(wrap_in_env(div, "sidebartight"), wants_pre_pagebreak, wants_post_pagebreak, format_hint)
  end

  if has_sidebar_semantics then
    return apply_pagebreak_wrappers(wrap_in_env(div, "sidebar"), wants_pre_pagebreak, wants_post_pagebreak, format_hint)
  end

  if wants_pre_pagebreak or wants_post_pagebreak then
    return apply_pagebreak_wrappers({ div }, wants_pre_pagebreak, wants_post_pagebreak, format_hint)
  end

  return mutated and div or nil
end

local function handle_header(h)
  local semantics_changed = apply_semantic_aliases(h)
  local allowed, stage_changed = enforce_stage_visibility(h)
  if not allowed then
    return {}
  end
  local section_allowed, section_changed = enforce_section_visibility(h)
  if not section_allowed then
    return {}
  end
  local role_scrubbed = scrub_header_role(h.attributes)
  local format_hint = (FORMAT or ""):lower()
  local wants_latex = format_hint:match("latex") ~= nil
  local wants_office_break = format_hint:match("docx")
    or format_hint:match("openxml")
    or format_hint:match("rtf")

  local has_chapter_semantics = has_epub_type(h.attributes, "chapter")
  local is_level_one_header = (h.level or 0) == 1

  local treat_as_chapter = false
  if wants_office_break and (has_chapter_semantics or is_level_one_header) then
    treat_as_chapter = true
  end

  local glyph_attr_removed = false
  local glyph_text = nil

  if ensure_unique_identifier(h) then
    semantics_changed = true
  end
  if h.attributes then
    local attr_value = h.attributes["section-glyph"]
    if attr_value and attr_value ~= "" then
      glyph_text = attr_value
      h.attributes["section-glyph"] = nil
      glyph_attr_removed = true
    elseif h.attributes["heading-glyph"] and h.attributes["heading-glyph"] ~= "" then
      glyph_text = h.attributes["heading-glyph"]
      h.attributes["heading-glyph"] = nil
      glyph_attr_removed = true
    end
  end

  local glyph_variant = nil
  if h.attributes then
    local variant_attr = h.attributes["section-glyph-variant"]
    if variant_attr and variant_attr ~= "" then
      glyph_variant = variant_attr
      h.attributes["section-glyph-variant"] = nil
      glyph_attr_removed = true
    end
  end

  if not glyph_variant and has_class(h, CATALOG_COLLECTION_HEADING_CLASS) then
    glyph_variant = "collection"
  end

  local glyph_injected = false
  if glyph_text and glyph_text ~= "" then
    glyph_injected = inject_section_heading_glyph(h, glyph_text, glyph_variant)
  end

  if treat_as_chapter then
    local out = {}
    if first_chapter_seen then
      local breaker = chapter_page_break_block(format_hint)
      if breaker then
        table.insert(out, breaker)
      end
    else
      first_chapter_seen = true
    end
    table.insert(out, h)
    return out
  end

  if not wants_latex then
    return (semantics_changed or role_scrubbed or stage_changed or section_changed or glyph_attr_removed or glyph_injected) and h or nil
  end

  if has_epub_type(h.attributes, "appendix") then
    local out = {}
    if not appendix_started then
      appendix_started = true
      table.insert(out, pandoc.RawBlock("latex", "\\appendix"))
      table.insert(out, pandoc.RawBlock("latex", "\\iaspSetPartHeader{Appendices}"))
    end
    table.insert(out, h)
    return out
  end

  return (semantics_changed or role_scrubbed or stage_changed or section_changed or glyph_attr_removed or glyph_injected) and h or nil
end

local function handle_span(span)
  local semantics_changed = apply_semantic_aliases(span)
  local allowed, stage_changed = enforce_stage_visibility(span)
  if not allowed then
    return {}
  end

  local section_allowed, section_changed = enforce_section_visibility(span)
  if not section_allowed then
    return {}
  end

  if semantics_changed or stage_changed or section_changed then
    return span
  end

  return nil
end

table_helpers = table_appearance.create({
  has_class = has_class,
  add_unique = add_unique,
  table_fullpage_min_rows = table_fullpage_min_rows,
  table_compact_min_cols = table_compact_min_cols,
})

local include_expander = include.create({
  expand_compound_classes = expand_compound_classes,
  enforce_stage_visibility = enforce_stage_visibility,
  enforce_section_visibility = enforce_section_visibility,
  latex_escape_argument = latex_escape_argument,
  begins_with_level_one_header = begins_with_level_one_header,
  apply_section_heading_glyph = apply_section_heading_glyph,
  slugify_identifier_source = slugify_identifier_source,
  namespace_header_identifiers = namespace_header_identifiers,
  convert_shorthand_blocks = shorthand.convert_shorthand_blocks,
  has_class = has_class,
})

local latex_wrapper = latex_helpers.create({
  apply_semantic_aliases = apply_semantic_aliases,
  has_epub_type = has_epub_type,
  inject_sidebar_glyph = inject_sidebar_glyph,
})

local function parse_quote_marker_raw(block)
  if not block or block.t ~= "RawBlock" or block.format ~= "html" then
    return nil
  end
  local text = (block.text or ""):gsub("^%s+", ""):gsub("%s+$", "")
  local q_id, rest = text:match("^<!%-%-%s*quote%s+(%d+)%s*(.-)%s*%-%->$")
  if not q_id then
    q_id, rest = text:match("^<!%-%-%s*corpus:quote%s+(%d+)%s*(.-)%s*%-%->$")
  end
  if not q_id then
    return nil
  end
  local concepts = {}
  local citekey = nil
  local work_key = nil
  local locator = nil

  if rest and rest ~= "" then
    for k, v in rest:gmatch('([%w_%-]+)%s*=%s*"(.-)"') do
      local key = k:lower()
      if key == "concepts" or key == "concept" or key == "data-concepts" then
        for part in v:gmatch("[^%s,;]+") do
          table.insert(concepts, part)
        end
      elseif key == "citekey" or key == "data-citekey" then
        citekey = v
      elseif key == "work" or key == "work-key" or key == "data-work-key" then
        work_key = v
      elseif key == "locator" or key == "data-locator" then
        locator = v
      end
    end
  end

  local manifest = get_provenance_manifest()
  local m_quote = manifest.quotes and manifest.quotes[tostring(q_id)]
  if m_quote and type(m_quote) == "table" then
    if m_quote.concepts and type(m_quote.concepts) == "table" then
      for _, c in ipairs(m_quote.concepts) do
        table.insert(concepts, c)
      end
    end
    citekey = citekey or m_quote.citekey
    work_key = work_key or m_quote.workKey
    locator = locator or m_quote.locator
  end

  return {
    id = q_id,
    concepts = concepts,
    citekey = citekey,
    workKey = work_key,
    locator = locator,
  }
end

local function bind_quote_markers_in_blocks(blocks)
  if not blocks or #blocks == 0 then
    return blocks
  end
  if FORMAT and FORMAT:match("latex") then
    return blocks
  end

  local out = {}
  local pending_quote = nil

  for _, block in ipairs(blocks) do
    if block.t == "Div" and block.content then
      block.content = bind_quote_markers_in_blocks(block.content)
    end

    local marker = parse_quote_marker_raw(block)
    if marker then
      pending_quote = marker
      table.insert(out, block)
    elseif pending_quote and (block.t == "BlockQuote" or block.t == "Div" or block.t == "Para") then
      if block.t == "Div" then
        block.attributes = block.attributes or {}
        apply_external_concept_attributes(block.attributes, pending_quote.concepts, pending_quote)
        table.insert(out, block)
      else
        local wrapper_attr = pandoc.Attr("", { "iasp-quote" }, {})
        apply_external_concept_attributes(wrapper_attr.attributes, pending_quote.concepts, pending_quote)
        if FORMAT and FORMAT:match("html") and not FORMAT:match("epub") then
          wrapper_attr.attributes["vocab"] = SKOS_VOCAB_URI
        end
        table.insert(out, pandoc.Div({ block }, wrapper_attr))
      end
      pending_quote = nil
    else
      table.insert(out, block)
    end
  end

  return out
end

-- Handle bare tables (not wrapped in .table divs) for auto-compact
local function handle_table(tbl)
  local format_hint = (FORMAT or ""):lower()
  return table_helpers.handle_bare_table(tbl, format_hint)
end

-- Handle .md links in bundled builds - convert to anchor links
-- This prevents broken links in EPUB when docs are concatenated
local function handle_link(link)
  local target = link.target
  if not target then return nil end
  
  -- Skip external links and already-anchored links
  if target:match("^https?://") or target:match("^#") or target:match("^mailto:") then
    return nil
  end
  
  -- Check if this is a .md link
  if target:match("%.md$") or target:match("%.md#") then
    -- URL decode spaces
    local decoded = target:gsub("%%20", " ")
    
    -- Check if this is a subdirectory path (contains /)
    -- These often reference files included with explicit wrapper section anchors
    -- that we can't reliably auto-generate, so we strip the link
    if decoded:match("/") and not decoded:match("^%.%./") then
      -- Return just the text content without the link
      return pandoc.Span(link.content)
    end
    
    -- Extract the base filename (without path and extension)
    local base = decoded:gsub(".*/", "")   -- Remove path prefix
    base = base:gsub("%.md.*$", "")        -- Remove .md and any anchor
    
    -- Convert to a slug-style anchor
    local anchor = base:lower():gsub("%s+", "-"):gsub("[^%w%-]", "")
    
    -- Preserve any existing anchor fragment
    local fragment = target:match("#(.+)$")
    if fragment then
      link.target = "#" .. fragment
    else
      link.target = "#" .. anchor
    end
    return link
  end
  
  return nil
end

return {
  { Pandoc = preprocess_shorthand },
  { Div = include_expander.expand_include_div },
  {
    Pandoc = function(doc)
      doc.blocks = bind_quote_markers_in_blocks(doc.blocks)
      return doc
    end
  },
  {
    Div = handle_div,
    Header = handle_header,
    Span = handle_span,
    Str = replace_meta_placeholders,
    Table = handle_table,
    Link = handle_link,
    Pandoc = latex_wrapper.latex_sidebar_wrapper
  }
}
