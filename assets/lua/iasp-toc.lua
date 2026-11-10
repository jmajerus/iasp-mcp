local utils = pandoc.utils
local path = pandoc.path

local script_dir = (PANDOC_SCRIPT_FILE and path.directory(PANDOC_SCRIPT_FILE)) or "."
package.path = package.path .. ";" .. script_dir .. "/?.lua;" .. script_dir .. "/?/init.lua"

local shorthand = require("iasp.shorthand")
local include = require("iasp.include")

local function add_unique(tbl, value)
  for _, existing in ipairs(tbl) do
    if existing == value then
      return
    end
  end
  table.insert(tbl, value)
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

local function latex_escape_argument(value)
  if not value or value == "" then
    return ""
  end
  local replacements = {
    ["\\"] = "\\textbackslash{}",
    ["{"] = "\\{",
    ["}"] = "\\}",
    ["$"] = "\\$",
    ["&"] = "\\&",
    ["#"] = "\\#",
    ["^"] = "\\textasciicircum{}",
    ["_"] = "\\_",
    ["~"] = "\\textasciitilde{}",
  }
  return value:gsub(".", function(char)
    return replacements[char] or char
  end)
end

local function begins_with_level_one_header(blocks)
  if not blocks or #blocks == 0 then
    return false
  end
  local first = blocks[1]
  return first and first.t == "Header" and first.level == 1
end

local function apply_section_heading_glyph(blocks, glyph)
  return blocks
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

local function preprocess_shorthand(doc)
  return shorthand.preprocess_shorthand(doc, function() end)
end

local include_expander = include.create({
  expand_compound_classes = expand_compound_classes,
  enforce_stage_visibility = function() return true end,
  enforce_section_visibility = function() return true end,
  latex_escape_argument = latex_escape_argument,
  begins_with_level_one_header = begins_with_level_one_header,
  apply_section_heading_glyph = apply_section_heading_glyph,
  slugify_identifier_source = slugify_identifier_source,
  namespace_header_identifiers = namespace_header_identifiers,
  convert_shorthand_blocks = shorthand.convert_shorthand_blocks,
  has_class = has_class,
})

return {
  { Pandoc = preprocess_shorthand },
  { Div = include_expander.expand_include_div },
}
