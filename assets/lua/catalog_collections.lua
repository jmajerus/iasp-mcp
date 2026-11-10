-- catalog_collections.lua
-- Runtime catalog renderer that converts YAML-defined collections into
-- Pandoc blocks at build time. Designed to be generic: provide a slot Div in
-- Markdown (class "catalog-slot" by default, with legacy support for
-- "pattern-catalog-slot") and point the metadata at
-- a preprocess configuration file that declares collections, items, and insertions.

local DEFAULT_CONFIG = "preprocessor/preprocess.yaml"
local DEFAULT_SLOT_CLASS = "catalog-slot"
local LEGACY_SLOT_CLASS = "pattern-catalog-slot"
local DEFAULT_INDEX_ITEM_TYPE = "entry"
local LEGACY_INDEX_ITEM_TYPE = "pattern"
local utils = pandoc.utils
local DEBUG_FLAG = os.getenv("CATALOG_COLLECTIONS_DEBUG")

local function script_directory()
  local src = debug.getinfo(1, "S").source or ""
  if src:sub(1, 1) == "@" then
    src = src:sub(2)
  end
  return pandoc.path.directory(src)
end

local function normalize_path(path)
  return pandoc.path.normalize(path)
end

local FILTER_DIR = script_directory()
local TOOLING_ROOT = normalize_path(pandoc.path.join({FILTER_DIR, ".."}))
local PROJECT_ROOT = normalize_path(pandoc.path.join({TOOLING_ROOT, ".."}))

local state = {
  loaded = false,
  config_path = DEFAULT_CONFIG,
  slot_class = DEFAULT_SLOT_CLASS,
  legacy_slot_class = LEGACY_SLOT_CLASS,
  slot_blocks = {},
}

local function file_exists(path)
  local fh = io.open(path, "r")
  if fh ~= nil then
    fh:close()
    return true
  end
  return false
end

local function read_file(path)
  local fh = io.open(path, "r")
  if not fh then
    return nil
  end
  local contents = fh:read("*a")
  fh:close()
  return contents
end

local function ensure_absolute(path)
  if not path or path == "" then
    return nil
  end
  if pandoc.path.is_absolute(path) then
    return normalize_path(path)
  end
  return normalize_path(pandoc.path.join({PROJECT_ROOT, path}))
end

local function relativize(path)
  if not path then
    return nil
  end
  local prefix = PROJECT_ROOT .. pandoc.path.separator
  if path:sub(1, #prefix) == prefix then
    return path:sub(#prefix + 1)
  end
  return path
end

local function trim(text)
  if text == nil then
    return ""
  end

  local value = text
  if type(value) ~= "string" then
    if type(value) == "table" and value.t == "MetaInlines" then
      value = pandoc.utils.stringify(value)
    else
      value = tostring(value)
    end
  end

  local result = value:gsub("^%s+", "")
  result = result:gsub("%s+$", "")
  return result
end

local function escape_attr_value(value)
  if value == nil then
    return ""
  end
  return tostring(value):gsub('"', "&quot;")
end

local function shallow_copy(tbl)
  local out = {}
  if type(tbl) ~= "table" then
    return out
  end
  for key, value in pairs(tbl) do
    out[key] = value
  end
  return out
end

local function clone_table(tbl)
  if type(tbl) ~= "table" then
    return tbl
  end
  local copy = {}
  for key, value in pairs(tbl) do
    copy[key] = clone_table(value)
  end
  return copy
end

local function warn(message)
  io.stderr:write("catalog_collections.lua: " .. message .. "\n")
end

local function debug(message)
  if DEBUG_FLAG and DEBUG_FLAG ~= "" then
    io.stderr:write("catalog_collections.lua [debug]: " .. message .. "\n")
  end
end

local function emit_source_comments(options)
  local flag = options and options.emit_source_comment
  if flag == nil then
    return true
  end
  if flag == true then
    return true
  end
  if type(flag) == "string" then
    local value = trim(flag:lower())
    return value == "true" or value == "1" or value == "yes"
  end
  return false
end

local function normalize_string(value, default)
  if type(value) == "string" then
    return value
  end
  if type(value) == "number" then
    return tostring(value)
  end
  if type(value) == "boolean" then
    return value and "true" or "false"
  end
  if type(value) == "table" then
    local ok, text = pcall(utils.stringify, value)
    if ok and text and text ~= "" then
      return text
    end
    if value.text then
      return tostring(value.text)
    end
  end
  return default
end

local function deep_normalize(value)
  if type(value) ~= "table" then
    return value
  end
  if value.t or value.tag then
    local ok, text = pcall(utils.stringify, value)
    if ok and text and text ~= "" then
      return text
    end
  end
  if value[1] ~= nil then
    local list = {}
    for index = 1, #value do
      list[index] = deep_normalize(value[index])
    end
    return list
  end
  local map = {}
  for key, inner in pairs(value) do
    map[key] = deep_normalize(inner)
  end
  return map
end

local function meta_to_table(meta_value)
  if meta_value == nil then
    return nil
  end
  if type(meta_value) ~= "table" then
    return meta_value
  end
  local meta_type = meta_value.t or meta_value.tag
  if not meta_type then
    if meta_value[1] ~= nil then
      local list = {}
      for index, value in ipairs(meta_value) do
        list[index] = meta_to_table(value)
      end
      return list
    else
      local map = {}
      for key, value in pairs(meta_value) do
        map[key] = meta_to_table(value)
      end
      return map
    end
  end

  if meta_type == "MetaMap" then
    local result = {}
    for key, value in pairs(meta_value) do
      result[key] = meta_to_table(value)
    end
    return result
  elseif meta_type == "MetaList" then
    local items = {}
    for index, value in ipairs(meta_value) do
      items[index] = meta_to_table(value)
    end
    return items
  elseif meta_type == "MetaBool" or meta_type == "MetaString" or meta_type == "MetaNumber" then
    return meta_value.c
  elseif meta_type == "MetaInlines" then
    return pandoc.utils.stringify(meta_value)
  elseif meta_type == "MetaBlocks" then
    return pandoc.write(pandoc.Pandoc(meta_value), "markdown"):gsub("\n$", "")
  else
    return meta_value
  end
end

local function count_entries(tbl)
  if type(tbl) ~= "table" then
    return 0
  end
  local count = 0
  for _ in pairs(tbl) do
    count = count + 1
  end
  return count
end

local function read_yaml_table(path)
  local absolute = ensure_absolute(path)
  if not absolute then
    return {}
  end
  local contents = read_file(absolute)
  if not contents then
    warn("Unable to read catalog preprocess config at " .. absolute)
    return {}
  end
  local wrapped = "---\n" .. contents .. "\n...\n"
  local ok, doc = pcall(pandoc.read, wrapped, "markdown")
  if not ok then
    warn("Failed to parse preprocess YAML: " .. tostring(doc))
    return {}
  end
  local meta = meta_to_table(doc.meta) or {}
  return deep_normalize(meta)
end

local function load_sequence_items(path)
  local data = read_yaml_table(path)
  if type(data) ~= "table" then
    return {}
  end
  if data.items and type(data.items) == "table" then
    return data.items
  end
  if #data > 0 then
    return data
  end
  return {}
end

local function build_item_block(item, defaults)
  if defaults == nil then
    defaults = {}
  end
  local template = defaults.item_template
  if template and template ~= "" then
    local rendered = template:gsub("{([^}]+)}", function(key)
      local replacement = item[key]
      if replacement == nil then
        return ""
      end
      return tostring(replacement)
    end)
    return rendered
  end

  local wrapper_class = normalize_string(defaults.include_wrapper_class, "include")
  local class_tokens = {}
  if wrapper_class and wrapper_class ~= "" then
    table.insert(class_tokens, "." .. wrapper_class)
  end

  local attr_tokens = {}
  local glyph = normalize_string(item.glyph, item.glyph)
  if glyph and glyph ~= "" then
    table.insert(attr_tokens, 'glyph="' .. escape_attr_value(glyph) .. '"')
  end
  local source_file = normalize_string(item.source_file, item.source_file) or item.path or ""
  table.insert(attr_tokens, 'path="' .. escape_attr_value(source_file) .. '"')

  local extra = item.extra_attributes
  if type(extra) == "table" then
    for key, value in pairs(extra) do
      table.insert(attr_tokens, string.format('%s="%s"', key, escape_attr_value(value)))
    end
  end

  if DEBUG_FLAG and DEBUG_FLAG ~= "" then
    debug(string.format(
      "class_tokens type=%s attr_tokens type=%s",
      type(class_tokens),
      type(attr_tokens)
    ))
  end
  if type(class_tokens) ~= "table" then
    class_tokens = {tostring(class_tokens or "")}
  end
  local class_segment = table.concat(class_tokens, "")
  local attr_segment = ""
  if type(attr_tokens) ~= "table" then
    attr_tokens = {tostring(attr_tokens or "")}
  end
  if #attr_tokens > 0 then
    attr_segment = " " .. table.concat(attr_tokens, " ")
  end

  return string.format(":::{%s%s}\n:::", class_segment, attr_segment)
end

local function normalize_item(item, defaults)
  local normalized = clone_table(item or {})
  normalized.title = normalize_string(normalized.title, normalized.title)
  normalized.slug = normalize_string(normalized.slug, normalized.slug)
  normalized.source_file = normalize_string(normalized.source_file, normalized.source_file)
  if normalized.source_file == nil and normalized.path ~= nil then
    normalized.source_file = normalized.path
  end
  local source_file = normalized.source_file
  if source_file then
    local absolute = ensure_absolute(source_file)
    normalized.exists = absolute and file_exists(absolute) or false
    normalized.source_file = relativize(absolute)
  else
    normalized.exists = false
  end
  if not normalized.slug and normalized.title then
    local slug = normalized.title:lower():gsub("[^a-z0-9]+", "-")
    slug = slug:gsub("^-+", ""):gsub("-+$", "")
    normalized.slug = slug
  end
  normalized.rendered_block = normalized.rendered_block or build_item_block(normalized, defaults)
  local item_type = normalized.item_type or DEFAULT_INDEX_ITEM_TYPE
  if item_type == LEGACY_INDEX_ITEM_TYPE then
    item_type = DEFAULT_INDEX_ITEM_TYPE
  end
  normalized.item_type = item_type
  if normalized.skip_index == nil then
    normalized.skip_index = item_type ~= DEFAULT_INDEX_ITEM_TYPE
  else
    normalized.skip_index = not not normalized.skip_index
  end
  return normalized
end

local function normalize_include_entry(entry, defaults)
  local normalized = normalize_item(entry, defaults)
  normalized.entry_type = "include"
  normalized.item_type = normalized.item_type or "sidebar"
  normalized.items = normalized.items or {}
  return normalized
end

local function normalize_collection_entry(entry)
  local normalized = clone_table(entry or {})
  normalized.entry_type = "collection"
  normalized.key = normalize_string(normalized.key, normalized.key)
  normalized.title = normalize_string(normalized.title, normalized.title)
  normalized.description = normalize_string(normalized.description, normalized.description)
  normalized.glyph = normalize_string(normalized.glyph, normalized.glyph)
  if normalized.heading_classes ~= nil then
    if type(normalized.heading_classes) == "string" then
      normalized.heading_classes = {normalize_string(normalized.heading_classes, normalized.heading_classes)}
    elseif type(normalized.heading_classes) == "table" then
      local classes = {}
      for _, cls in ipairs(normalized.heading_classes) do
        local class_name = normalize_string(cls, cls)
        if class_name and class_name ~= "" then
          table.insert(classes, class_name)
        end
      end
      normalized.heading_classes = classes
    else
      normalized.heading_classes = nil
    end
  end
  return normalized
end

local function resolve_collections(config, include_defaults)
  local vocabulary = config.vocabulary or {}
  if DEBUG_FLAG and DEBUG_FLAG ~= "" then
    local vkeys = {}
    for key in pairs(vocabulary) do
      table.insert(vkeys, key)
    end
    table.sort(vkeys)
    debug("Vocabulary keys: " .. table.concat(vkeys, ","))
  end
  local collections_key = normalize_string(vocabulary.collections_field, "collections")
  if DEBUG_FLAG and DEBUG_FLAG ~= "" then
    local field = vocabulary.collections_field
    local field_type = type(field)
    local field_tag = nil
    if field_type == "table" then
      field_tag = field.t or field.tag or "(nil)"
    end
    local mt = nil
    local mt_name = "(nil)"
    if type(field) == "table" then
      mt = getmetatable(field)
      if mt and type(mt.__name) == "string" then
        mt_name = mt.__name
      end
    end
    debug(string.format(
      "collections_field raw type=%s tag=%s metatable=%s (%s) value=%s",
      field_type,
      tostring(field_tag),
      tostring(mt),
      mt_name,
      tostring(field)
    ))
  end
  local raw_collections = config[collections_key] or config.collections or {}
  if DEBUG_FLAG and DEBUG_FLAG ~= "" then
    local count = type(raw_collections) == "table" and #raw_collections or 0
    debug(string.format("Using collections key '%s' (type=%s) with %d entry(ies)", collections_key, type(collections_key), count))
  end
  local items_key = vocabulary.items_field or "items"
  items_key = normalize_string(items_key, "items")
  local normalized = {}

  for _, entry in ipairs(raw_collections) do
    if type(entry) ~= "table" then
      goto continue
    end

    local entry_type_source = entry.type
    if entry_type_source == nil or entry_type_source == "" then
      entry_type_source = entry.entry_type
    end
    local entry_type = normalize_string(entry_type_source, entry_type_source)
    if entry_type == nil or entry_type == "" then
      entry_type = "collection"
    end
    if DEBUG_FLAG and DEBUG_FLAG ~= "" then
      debug(string.format(
        "raw entry title=%s type=%s",
        tostring(entry.title or entry.key or "(untitled)"),
        tostring(entry_type)
      ))
    end
    if entry_type == "include" then
      table.insert(normalized, normalize_include_entry(entry, include_defaults))
      goto continue
    end

    local copy = clone_table(entry)
    copy.entry_type = "collection"
    copy.type = nil
    local items = copy[items_key]
    if items == nil and items_key ~= "items" then
      items = copy.items
    end
    items = items or {}
    local normalized_items = {}
    for _, item in ipairs(items) do
      if type(item) == "table" then
        table.insert(normalized_items, clone_table(item))
      end
    end
    copy.items = normalized_items
    copy = normalize_collection_entry(copy)
    table.insert(normalized, copy)

    ::continue::
  end

  return normalized
end

local function normalize_insertion_items(insertion, defaults)
  local items = {}
  if type(insertion.items) == "table" then
    for _, item in ipairs(insertion.items) do
      if type(item) == "table" then
        table.insert(items, normalize_item(item, defaults))
      end
    end
  end
  if insertion.items_from then
    local source_path = normalize_string(insertion.items_from, insertion.items_from)
    local external_items = load_sequence_items(source_path)
    for _, item in ipairs(external_items) do
      if type(item) == "table" then
        table.insert(items, normalize_item(item, defaults))
      end
    end
  end
  if #items == 0 then
    return nil
  end
  return items
end

local function build_item_divider(options)
  local divider = normalize_string(options.item_divider, options.item_divider)
  if not divider or divider == "" then
    return nil
  end

  local divider_class = normalize_string(options.item_divider_class, options.item_divider_class) or "catalog-divider"
  local format = FORMAT or ""

  if format:match("latex") then
    return string.format("```{=latex}\n\\noindent\\rule{\\linewidth}{0.5pt}\n```\n")
  elseif format:match("typst") then
    return "```{=typst}\nline(length: 100%, stroke: 0.5pt)\n```\n"
  elseif format:match("html") then
    if divider_class ~= "" then
      return string.format('<hr class="%s" />', escape_attr_value(divider_class))
    end
    return "<hr />"
  end

  return divider
end

local function render_collection_sections(collections, options)
  local heading_level_value = normalize_string(options.heading_level, options.heading_level)
  if DEBUG_FLAG and DEBUG_FLAG ~= "" then
    debug(string.format("Heading level source type=%s value=%s", type(options.heading_level), heading_level_value or "(nil)"))
  end
  local heading_level = trim(heading_level_value or "###")
  if heading_level == "" then
    heading_level = "###"
  end
  local glyph_field = normalize_string(options.collection_glyph_field, options.collection_glyph_field)
  local heading_class = options.collection_heading_class or "catalog-collection-heading"
  local item_spacing = tonumber(options.item_spacing or 1) or 1
  if item_spacing < 1 then
    item_spacing = 1
  end
  local include_source_comment = emit_source_comments(options)
  local item_divider = normalize_string(options.item_divider, options.item_divider)
  local divider_block = build_item_divider({
    item_divider = item_divider,
    item_divider_class = options.item_divider_class,
  })
  local lines = {}

  for _, collection in ipairs(collections) do
    if DEBUG_FLAG and DEBUG_FLAG ~= "" then
      debug(string.format(
        "collection '%s' entry_type=%s",
        tostring(collection.key or collection.title or "(untitled)"),
        tostring(collection.entry_type or "(nil)")
      ))
    end
    if collection.entry_type ~= "collection" then
      if not collection.exists then
        table.insert(lines, string.format("<!-- WARNING: Missing source '%s' for inline include -->", collection.source_file or "?"))
      end
      table.insert(lines, tostring(collection.rendered_block or ""))
      table.insert(lines, "")
    else
      local tokens = {}
      if heading_class and heading_class ~= "" then
        table.insert(tokens, "." .. heading_class)
      end
      local extra_classes = collection.heading_classes
      if type(extra_classes) == "string" then
        extra_classes = {extra_classes}
      end
      if type(extra_classes) == "table" then
        for _, cls in ipairs(extra_classes) do
          local class_name = normalize_string(cls, cls)
          if class_name and class_name ~= "" then
            table.insert(tokens, "." .. class_name)
          end
        end
      end
      if glyph_field and collection[glyph_field] then
        local glyph_value = normalize_string(collection[glyph_field], collection[glyph_field])
        if glyph_value and glyph_value ~= "" then
          table.insert(tokens, string.format('section-glyph="%s"', escape_attr_value(glyph_value)))
        end
      end
      local attr_segment = ""
      if #tokens > 0 then
        local token_strings = {}
        for _, token in ipairs(tokens) do
          table.insert(token_strings, tostring(token or ""))
        end
        attr_segment = " {" .. table.concat(token_strings, " ") .. "}"
      end
      local heading_text = normalize_string(collection.title, collection.title or "") or ""
      table.insert(lines, string.format("%s %s%s", heading_level, heading_text, attr_segment))
      local description_text = normalize_string(collection.description, collection.description)
      if description_text and trim(description_text) ~= "" then
        table.insert(lines, trim(description_text))
      end
      table.insert(lines, "")

      local items = collection.items or {}
      for idx, item in ipairs(items) do
        if DEBUG_FLAG and DEBUG_FLAG ~= "" then
          debug(string.format(
            "item title='%s' path='%s' exists=%s",
            tostring(item.title or "(untitled)"),
            tostring(item.source_file or "(nil)"),
            tostring(item.exists)
          ))
          debug(string.format("slot=%s include_source_comment=%s", slot_label, tostring(include_source_comment)))
        end
        if include_source_comment and item.source_file then
          table.insert(lines, string.format("<!-- source: %s -->", item.source_file))
        end
        if not item.exists then
          table.insert(lines, string.format("<!-- WARNING: Missing source '%s' for %s -->", item.source_file or "?", item.title or "item"))
        end
        table.insert(lines, tostring(item.rendered_block or ""))
        if divider_block then
          table.insert(lines, divider_block)
        end
        for _ = 1, item_spacing do
          table.insert(lines, "")
        end
      end
    end
  end

  local normalized_lines = {}
  for _, line in ipairs(lines) do
    local text = normalize_string(line, line)
    if text == nil then
      text = ""
    end
    table.insert(normalized_lines, tostring(text))
  end
  return table.concat(normalized_lines, "\n"):gsub("\n+$", "") .. "\n"
end

local function render_collection_index(collections, options)
  local list_style = options.list_style or "unordered"
  local label_field = options.item_label_field or "title"
  local lines = {}

  for _, collection in ipairs(collections) do
    if collection.entry_type ~= "collection" then
      goto continue
    end
    local collection_title = normalize_string(collection.title, collection.title or "") or ""
    table.insert(lines, string.format("**%s**", collection_title))
    table.insert(lines, "")
    local counter = 0
    for _, item in ipairs(collection.items or {}) do
      if not item.skip_index then
        counter = counter + 1
        local bullet = list_style == "ordered" and (tostring(counter) .. ".") or "-"
        local label = normalize_string(item[label_field], item[label_field]) or normalize_string(item.title, item.title) or "Unnamed"
        local status_note = ""
        if item.status then
          local status_label = normalize_string(item.status, item.status)
          if status_label and status_label ~= "" then
            status_note = string.format(" (TODO: %s)", status_label)
          end
        end
        table.insert(lines, string.format("%s %s%s", bullet, label, status_note))
      end
    end
    table.insert(lines, "")
    ::continue::
  end

  local normalized_lines = {}
  for _, line in ipairs(lines) do
    local text = normalize_string(line, line)
    if text == nil then
      text = ""
    end
    table.insert(normalized_lines, tostring(text))
  end

  return table.concat(normalized_lines, "\n"):gsub("\n+$", "") .. "\n"
end

local function render_include_sequence(_, options)
  local items = options.items or {}
  local item_spacing = tonumber(options.item_spacing or 1) or 1
  if item_spacing < 0 then
    item_spacing = 0
  end
  local include_source_comment = emit_source_comments(options)
  local item_divider = normalize_string(options.item_divider, options.item_divider)
  local divider_block = build_item_divider({
    item_divider = item_divider,
    item_divider_class = options.item_divider_class,
  })
  local list_style = normalize_string(options.list_style, options.list_style)
  local lines = {}

  for idx, item in ipairs(items) do
    local has_source = item.source_file ~= nil and item.source_file ~= ""
    if not item.exists and not list_style and has_source then
      table.insert(lines, string.format("<!-- WARNING: Missing source '%s' for %s -->", item.source_file or "?", item.title or "item"))
    end
    if include_source_comment and has_source then
      table.insert(lines, string.format("<!-- source: %s -->", item.source_file))
    end
    local rendered = item.rendered_block
    if list_style then
      local label = normalize_string(item.title, item.title) or ""
      if list_style == "ordered" then
        rendered = string.format("%d. %s", idx, label)
      elseif list_style == "unordered" then
        rendered = string.format("- %s", label)
      end
    end
    table.insert(lines, tostring(rendered or ""))
    if divider_block then
      table.insert(lines, divider_block)
    end
    for _ = 1, item_spacing do
      table.insert(lines, "")
    end
  end

  local normalized_lines = {}
  for _, line in ipairs(lines) do
    local text = normalize_string(line, line)
    if text == nil then
      text = ""
    end
    table.insert(normalized_lines, tostring(text))
  end

  return table.concat(normalized_lines, "\n"):gsub("\n+$", "") .. "\n"
end

local RENDERERS = {
  collection_sections = render_collection_sections,
  collection_index = render_collection_index,
  include_sequence = render_include_sequence,
}

local function render_markdown(markdown)
  if not markdown or markdown == "" then
    return {}
  end
  local doc = pandoc.read(markdown, "markdown+citations")
  return doc.blocks
end

local function build_slot_blocks(config)
  local include_defaults = config.include_defaults or {}
  local collections = resolve_collections(config, include_defaults)
  if DEBUG_FLAG and DEBUG_FLAG ~= "" then
    debug(string.format("Resolved %d collections for rendering", #collections))
  end
  if #collections == 0 then
    return {}
  end

  local normalized = {}
  for _, entry in ipairs(collections) do
    if entry.entry_type == "collection" then
      local copy = shallow_copy(entry)
      local normalized_items = {}
      for _, item in ipairs(entry.items or {}) do
        table.insert(normalized_items, normalize_item(item, include_defaults))
      end
      copy.items = normalized_items
      table.insert(normalized, copy)
    else
      table.insert(normalized, entry)
    end
  end

  local slot_blocks = {}
  if DEBUG_FLAG and DEBUG_FLAG ~= "" then
    debug(string.format("Processing %d insertion(s)", #(config.insertions or {})))
  end
  for _, insertion in ipairs(config.insertions or {}) do
    if type(insertion) ~= "table" then
      goto continue
    end
    local renderer_key = normalize_string(insertion.renderer, insertion.renderer)
    local slot = normalize_string(insertion.slot, insertion.slot)
    local renderer = RENDERERS[renderer_key]
    if not renderer or not slot or slot == "" then
      if DEBUG_FLAG and DEBUG_FLAG ~= "" then
        debug(string.format(
          "Skipping insertion (renderer=%s slot=%s)",
          tostring(renderer_key),
          tostring(slot)
        ))
      end
      goto continue
    end

    local options = clone_table(insertion.options or {})
    local normalized_items = normalize_insertion_items(insertion, include_defaults)
    if normalized_items then
      options.items = normalized_items
    end

    local markdown = renderer(normalized, options)
    slot_blocks[slot] = render_markdown(markdown)
    if DEBUG_FLAG and DEBUG_FLAG ~= "" then
      debug(string.format(
        "Slot '%s' rendered %d block(s) via '%s'",
        slot,
        #slot_blocks[slot],
        renderer_key or "?"
      ))
    end
    ::continue::
  end

  return slot_blocks
end

local function ensure_catalog_loaded()
  if state.loaded then
    return
  end
  local config = read_yaml_table(state.config_path)
  if next(config) == nil then
    warn("Catalog preprocess config is empty; placeholders will remain untouched.")
    state.loaded = true
    return
  end
  if DEBUG_FLAG and DEBUG_FLAG ~= "" then
    local keys = {}
    for key in pairs(config) do
      table.insert(keys, key)
    end
    table.sort(keys)
    debug("Config keys: " .. table.concat(keys, ","))
  end
  state.slot_blocks = build_slot_blocks(config)
  if DEBUG_FLAG and DEBUG_FLAG ~= "" then
    debug(string.format(
      "Loaded catalog preprocess config '%s' with %d slot(s)",
      state.config_path,
      count_entries(state.slot_blocks or {})
    ))
  end
  state.loaded = true
end

local function apply_slot(el)
  local classes = el.classes or {}
  local slot_class = state.slot_class or DEFAULT_SLOT_CLASS
  local legacy_slot_class = state.legacy_slot_class or LEGACY_SLOT_CLASS
  if DEBUG_FLAG and DEBUG_FLAG ~= "" then
    debug(string.format("Inspecting Div with classes: %s", table.concat(classes, ",")))
  end
  local has_class = false
  for _, class_name in ipairs(classes) do
    if class_name == slot_class or class_name == legacy_slot_class then
      has_class = true
      break
    end
  end
  if not has_class then
    return nil
  end

  local slot = el.attributes["data-slot"] or el.attributes.slot or el.identifier
  if not slot or slot == "" then
    warn("Encountered a catalog slot without a slot identifier")
    return nil
  end

  ensure_catalog_loaded()
  local blocks = state.slot_blocks[slot]
  if not blocks then
    warn("No renderer output registered for slot '" .. slot .. "'")
    return nil
  end

  return blocks
end

local function normalize_slot_marker(el)
  if el.t ~= "RawBlock" then
    return nil
  end
  if el.format ~= "html" and el.format ~= "" then
    return nil
  end
  local text = trim(el.text or "")
  if text:match("^<!%-%-%s*SLOT:%s*[%w%-_]+%s*:[^>]*%-%->$") then
    return pandoc.RawBlock("html", text)
  end
  return nil
end

local function resolve_catalog_meta(meta)
  return meta["catalog_collections"]
    or meta["catalog-collections"]
    or meta["pattern_catalog"]
    or meta["pattern-catalog"]
end

function Meta(meta)
  local block = resolve_catalog_meta(meta)
  if block then
    local opts = meta_to_table(block)
    if type(opts) == "table" then
      if type(opts.config) == "string" and opts.config ~= "" then
        state.config_path = opts.config
      end
      if type(opts.slot_class) == "string" and opts.slot_class ~= "" then
        state.slot_class = opts.slot_class
      end
      if opts.debug ~= nil then
        if opts.debug == false then
          DEBUG_FLAG = nil
        else
          DEBUG_FLAG = opts.debug == true and "1" or tostring(opts.debug)
        end
      end
    end
  end
  return nil
end

return {
  { Meta = Meta },
  { Div = apply_slot },
  { RawBlock = normalize_slot_marker },
}
